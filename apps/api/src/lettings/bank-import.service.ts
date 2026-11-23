import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { isPostgresError } from '../common/db-errors.js';
import { keysetCondition, type Page, type ParsedListQuery, sortValueSql, toPage } from '../common/list-query.js';
import { toMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import { actingMembership, type TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { documentMaxBytes } from '../documents/document-rules.js';
import { CSV_MIME } from '../documents/documents.dto.js';
import { STORAGE, type StoragePort } from '../media/storage.js';
import { BANK_FILE_FORMAT, BankFileError, lineKeys, parseBankFile, referenceTokens } from './bank-file.js';
import { canOnLease, leaseAccess } from './lettings-access.js';
import type { CheckImportBody, CommitImportBody, ImportLineDto, PaymentImportDto } from './receipts.dto.js';
import { minorUnits } from './receipts.service.js';

export type ImportLineSortField = 'txnDate';

const PAYABLE = ['active', 'periodic', 'notice_given', 'ended', 'closed'];
const PAYING_ROLES = ['tenant', 'co_tenant', 'occupant', 'guarantor'];

/**
 * Bank-file import (P7-D7; wireframe RP-3). The file is uploaded as a bank
 * statement document of the account (scanned, kept), checked line by line
 * (format, currency, duplicates by a stable key, lease reference match), then
 * committed: matched lines and lines a person matched become cleared receipts
 * of the account; other lines wait in the queue until matched. Nothing is
 * allocated by an import (P7-D8).
 */
@Injectable()
export class BankImportService {
  constructor(
    private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  async check(tx: Tx, ctx: TenantContext, body: CheckImportBody): Promise<PaymentImportDto> {
    const account = await tx.selectFrom('bankAccounts').select(['id', 'currencyCode', 'isActive']).where('id', '=', body.bankAccountId).executeTakeFirst();
    if (!account || !account.isActive) throw Problems.validation([{ field: 'bankAccountId', code: 'unknown', message: 'Choose an active bank account.' }]);
    const document = await tx
      .selectFrom('documents as d')
      .innerJoin('documentVersions as v', 'v.id', 'd.currentVersionId')
      .select(['v.storageKey', 'v.mimeType', 'v.scanStatus', 'd.documentTypeCode'])
      .where('d.id', '=', body.documentId)
      .where((eb) =>
        eb.exists(eb.selectFrom('documentLinks as k').select('k.documentId').whereRef('k.documentId', '=', 'd.id').where('k.entityType', '=', 'bank_account').where('k.entityId', '=', body.bankAccountId)),
      )
      .executeTakeFirst();
    if (!document || document.mimeType !== CSV_MIME || document.documentTypeCode !== 'bank_statement') {
      throw Problems.validation([{ field: 'documentId', code: 'not-found', message: 'Upload the bank file (CSV) as a bank statement of this account first.' }]);
    }
    if (document.scanStatus === 'pending') throw Problems.validation([{ field: 'documentId', code: 'scan-pending', message: 'The file is still being checked. Try again in a moment.' }]);
    if (document.scanStatus !== 'clean') throw Problems.validation([{ field: 'documentId', code: 'scan-failed', message: 'The file did not pass the security scan. Upload it again.' }]);
    const used = await tx.selectFrom('paymentImports').select('id').where('documentId', '=', body.documentId).where('status', '<>', 'cancelled').executeTakeFirst();
    if (used) throw Problems.conflict('This file has an import already. Open it, or cancel it to check the file again.');

    let lines;
    try {
      lines = parseBankFile(await this.storage.read(document.storageKey, documentMaxBytes(CSV_MIME)));
    } catch (error) {
      if (error instanceof BankFileError) throw Problems.validation([{ field: 'documentId', code: error.code, message: error.message }]);
      throw error;
    }
    const keys = lineKeys(account.id, lines);
    const known = new Set([
      ...(await tx.selectFrom('payments').select('idempotencyKey').where('idempotencyKey', 'in', keys).execute()).map((row) => row.idempotencyKey),
      ...(await tx.selectFrom('paymentImportLines').select('idempotencyKey').where('idempotencyKey', 'in', keys).where('status', 'in', ['imported', 'queued']).execute()).map((row) => row.idempotencyKey),
    ]);
    const tokens = [...new Set(lines.flatMap((line) => referenceTokens(line.reference, line.description)))];
    const leases = tokens.length === 0 ? [] : await tx
      .selectFrom('leases as l')
      .leftJoin('leaseParties as pt', (join) => join.onRef('pt.leaseId', '=', 'l.id').on('pt.isPrimary', '=', true).on('pt.partyRole', 'in', ['tenant', 'co_tenant']))
      .select(['l.id', 'l.reference', 'l.status', 'l.currencyCode', 'pt.contactId'])
      .where(sql<boolean>`upper(l.reference) = any(${tokens}::text[])`)
      .execute();
    const byReference = new Map(leases.map((lease) => [lease.reference.toUpperCase(), lease]));

    const inserted = await tx
      .insertInto('paymentImports')
      .values({ companyId: ctx.companyId, bankAccountId: account.id, documentId: body.documentId, format: BANK_FILE_FORMAT, lineCount: lines.length, createdBy: actingMembership(ctx) })
      .returning('id')
      .executeTakeFirstOrThrow();
    const seenInFile = new Set<string>();
    const values = lines.map((line, index) => {
      const key = keys[index]!;
      let status: string;
      let error = line.error;
      let leaseId: string | null = null;
      let payer: string | null = null;
      if (!error && line.currency !== account.currencyCode) error = { code: 'wrong-currency', message: `The account is in ${account.currencyCode}.` };
      if (error) status = 'error';
      else if (known.has(key) || seenInFile.has(key)) status = 'duplicate';
      else {
        const found = referenceTokens(line.reference, line.description).map((token) => byReference.get(token)).filter((lease) => lease !== undefined);
        const lease = found.length === 1 ? found[0]! : null;
        if (lease && lease.contactId && PAYABLE.includes(lease.status) && lease.currencyCode === account.currencyCode) {
          status = 'matched';
          leaseId = lease.id;
          payer = lease.contactId;
        } else status = 'unmatched';
      }
      seenInFile.add(key);
      return {
        companyId: ctx.companyId,
        importId: inserted.id,
        lineNo: line.lineNo,
        txnDate: line.date,
        amount: line.amount,
        currencyCode: line.currency,
        reference: line.reference,
        description: line.description,
        transactionId: line.transactionId,
        idempotencyKey: key,
        status,
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null,
        leaseId,
        payerContactId: payer,
      };
    });
    for (let i = 0; i < values.length; i += 1_000) await tx.insertInto('paymentImportLines').values(values.slice(i, i + 1_000)).execute();
    await this.audit.record(tx, ctx, { action: 'payment_import.checked', entityType: 'payment_import', entityId: inserted.id, metadata: { bankAccountId: account.id, documentId: body.documentId, lines: lines.length } });
    return this.get(tx, inserted.id);
  }

  async get(tx: Tx, id: string): Promise<PaymentImportDto> {
    const row = await tx
      .selectFrom('paymentImports as i')
      .innerJoin('bankAccounts as ba', 'ba.id', 'i.bankAccountId')
      .innerJoin('documents as d', 'd.id', 'i.documentId')
      .select(['i.id', 'i.bankAccountId', 'ba.name as accountName', 'i.documentId', 'd.title', 'i.format', 'i.status', 'i.createdAt', 'i.version', 'ba.currencyCode'])
      .where('i.id', '=', id)
      .executeTakeFirst();
    if (!row) throw Problems.notFound();
    const lines = await lineQuery(tx).where('li.importId', '=', id).orderBy('li.lineNo').execute();
    const minor = (await minorUnits(tx, [row.currencyCode])).get(row.currencyCode) ?? 2;
    const count = (status: string) => lines.filter((line) => line.status === status).length;
    return {
      id: row.id,
      bankAccount: { id: row.bankAccountId, name: row.accountName },
      document: { id: row.documentId, name: row.title },
      format: row.format,
      status: row.status,
      summary: { lines: lines.length, matched: count('matched'), unmatched: count('unmatched'), duplicate: count('duplicate'), error: count('error'), imported: count('imported'), queued: count('queued') },
      lines: lines.map((line) => toLine(line, minor)),
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  /** Matched lines and those a person matched become cleared receipts; the other unmatched lines wait in the queue. */
  async commit(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: CommitImportBody): Promise<PaymentImportDto> {
    const current = await tx.selectFrom('paymentImports').select(['id', 'status', 'version', 'bankAccountId']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.status !== 'checked') throw Problems.businessRule(`This import is ${current.status}.`);
    const lines = await tx.selectFrom('paymentImportLines').select(['id', 'lineNo', 'status', 'idempotencyKey', 'currencyCode']).where('importId', '=', id).execute();
    const byNo = new Map(lines.map((line) => [line.lineNo, line]));
    const errors: FieldError[] = [];
    for (const [index, choice] of body.choices.entries()) {
      const line = byNo.get(choice.lineNo);
      if (!line || line.status !== 'unmatched') {
        errors.push({ field: `choices[${index}].lineNo`, code: 'not-unmatched', message: 'Choose a payer for unmatched lines only.' });
        continue;
      }
      const problem = await checkPayer(tx, ctx, choice.payerContactId, choice.leaseId ?? null, line.currencyCode ?? '', `choices[${index}]`);
      if (problem) errors.push(problem);
    }
    if (errors.length > 0) throw Problems.validation(errors);
    for (const choice of body.choices) {
      await tx.updateTable('paymentImportLines').set({ payerContactId: choice.payerContactId, leaseId: choice.leaseId ?? null, resolvedBy: actingMembership(ctx) }).where('importId', '=', id).where('lineNo', '=', choice.lineNo).execute();
    }
    // Lines imported or queued by another file since this one was checked are duplicates now.
    await sql`update payment_import_lines li set status = 'duplicate'
               where li.import_id = ${id}::uuid and li.status in ('matched', 'unmatched')
                 and (exists (select 1 from payments p where p.idempotency_key = li.idempotency_key)
                      or exists (select 1 from payment_import_lines o where o.idempotency_key = li.idempotency_key and o.status in ('imported', 'queued')))`.execute(tx);
    const chosen = body.choices.map((choice) => choice.lineNo);
    const created = await this.importLines(tx, ctx, sql`li.import_id = ${id}::uuid and (li.status = 'matched' or (li.status = 'unmatched' and li.line_no = any(${chosen}::integer[])))`);
    try {
      await sql`update payment_import_lines set status = 'queued' where import_id = ${id}::uuid and status = 'unmatched'`.execute(tx);
    } catch (error) {
      if (isPostgresError(error) && error.code === '23505') throw Problems.conflict('Another import queued some of these lines at the same time. Check the file again.');
      throw error;
    }
    await tx.updateTable('paymentImports').set({ status: 'committed', committedAt: sql<Date>`now()`, committedBy: actingMembership(ctx) }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'payment_import.committed', entityType: 'payment_import', entityId: id, metadata: { receipts: created } });
    return this.get(tx, id);
  }

  async cancel(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<PaymentImportDto> {
    const current = await tx.selectFrom('paymentImports').select(['status', 'version']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.status !== 'checked') throw Problems.businessRule(`This import is ${current.status}.`);
    await tx.updateTable('paymentImports').set({ status: 'cancelled' }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'payment_import.cancelled', entityType: 'payment_import', entityId: id });
    return this.get(tx, id);
  }

  /** The queue (RP-5): imported lines waiting for a payer, oldest first. */
  async queue(tx: Tx, query: ParsedListQuery<ImportLineSortField>): Promise<Page<ImportLineDto>> {
    let qb = lineQuery(tx).where('li.status', '=', 'queued');
    if (query.cursor) qb = qb.where(keysetCondition('li.txnDate', 'li.id', query.sort, query.cursor));
    const rows = await qb
      .select(sortValueSql('li.txnDate', 'text').as('cursorValue'))
      .orderBy('li.txnDate', query.sort.direction)
      .orderBy('li.id', query.sort.direction)
      .limit(query.limit + 1)
      .execute();
    const minor = await minorUnits(tx, rows.map((row) => row.currencyCode ?? 'GHS'));
    return toPage(rows, query.limit, (row) => row.cursorValue ?? '', (row) => row.id, (row) => toLine(row, minor.get(row.currencyCode ?? '') ?? 2));
  }

  /** A queued line, matched to its payer by a person, becomes a cleared receipt. */
  async match(tx: Tx, ctx: TenantContext, lineId: string, expectedVersion: number, payerContactId: string, leaseId: string | null): Promise<ImportLineDto> {
    const line = await tx.selectFrom('paymentImportLines').select(['id', 'status', 'version', 'currencyCode']).where('id', '=', lineId).forUpdate().executeTakeFirst();
    if (!line) throw Problems.notFound();
    if (line.version !== expectedVersion) throw Problems.preconditionFailed();
    if (line.status !== 'queued') throw Problems.businessRule(`This line is ${line.status}.`);
    const problem = await checkPayer(tx, ctx, payerContactId, leaseId, line.currencyCode ?? '', '');
    if (problem) throw Problems.validation([{ ...problem, field: problem.field.replace(/^\./, '') }]);
    await tx.updateTable('paymentImportLines').set({ payerContactId, leaseId, resolvedBy: actingMembership(ctx) }).where('id', '=', lineId).execute();
    await this.importLines(tx, ctx, sql`li.id = ${lineId}::uuid`);
    const row = await lineQuery(tx).where('li.id', '=', lineId).executeTakeFirstOrThrow();
    return toLine(row, (await minorUnits(tx, [row.currencyCode ?? ''])).get(row.currencyCode ?? '') ?? 2);
  }

  /** Creates cleared receipts for the lines (set-based), links them and writes audit and outbox rows. */
  private async importLines(tx: Tx, ctx: TenantContext, where: ReturnType<typeof sql<boolean>>): Promise<number> {
    const { rows } = await sql<{ id: string; reference: string; leaseId: string | null; amount: string; currencyCode: string; idempotencyKey: string }>`
      insert into payments (company_id, reference, payer_contact_id, lease_id, bank_account_id, method_code, currency_code, amount,
                            received_on, value_date, status, idempotency_key, recorded_by)
      select li.company_id, app.next_reference(li.company_id, 'payment'), li.payer_contact_id, li.lease_id, i.bank_account_id, 'bank_transfer',
             li.currency_code, li.amount, li.txn_date, li.txn_date, 'cleared', li.idempotency_key, ${ctx.system ? null : ctx.membershipId}::uuid
        from payment_import_lines li join payment_imports i on i.id = li.import_id
       where ${where} and li.payer_contact_id is not null
       order by li.line_no
      returning id, reference, lease_id as "leaseId", amount::text as amount, currency_code as "currencyCode", idempotency_key as "idempotencyKey"`.execute(tx);
    if (rows.length > 0) {
      await sql`update payment_import_lines li set status = 'imported', payment_id = p.id
                  from payments p where p.idempotency_key = li.idempotency_key and ${where} and li.status in ('matched', 'unmatched', 'queued')`.execute(tx);
    }
    await this.audit.recordMany(
      tx,
      ctx,
      rows.map((row) => ({ action: 'payment.recorded', entityType: 'payment', entityId: row.id, metadata: { reference: row.reference, leaseId: row.leaseId, amount: row.amount, currency: row.currencyCode, methodCode: 'bank_transfer', status: 'cleared', source: 'bank_file' } })),
    );
    await this.audit.emitMany(
      tx,
      ctx,
      rows.map((row) => ({ eventType: 'payment.received', aggregateType: 'payment', aggregateId: row.id, payload: { paymentId: row.id, leaseId: row.leaseId, amount: row.amount, currency: row.currencyCode, status: 'cleared' } })),
    );
    return rows.length;
  }
}

/** The payer exists and, with a lease, pays for it (a party), the lease is visible and in the line's currency. */
async function checkPayer(tx: Tx, ctx: TenantContext, payerContactId: string, leaseId: string | null, currency: string, prefix: string): Promise<FieldError | null> {
  const payer = await tx.selectFrom('contacts').select(['id', 'archivedAt']).where('id', '=', payerContactId).executeTakeFirst();
  if (!payer || payer.archivedAt !== null) return { field: `${prefix}.payerContactId`, code: 'unknown', message: 'Choose the person or organisation who paid.' };
  if (!leaseId) return null;
  const access = await leaseAccess(tx, leaseId);
  if (!access || !canOnLease(ctx, 'rent.view', access)) return { field: `${prefix}.leaseId`, code: 'unknown', message: 'Choose a lease you can see.' };
  const lease = await tx.selectFrom('leases').select(['status', 'currencyCode']).where('id', '=', leaseId).executeTakeFirstOrThrow();
  if (!PAYABLE.includes(lease.status) || lease.currencyCode !== currency) return { field: `${prefix}.leaseId`, code: 'lease-mismatch', message: `Choose a signed lease in ${currency}.` };
  const party = await tx.selectFrom('leaseParties').select('contactId').where('leaseId', '=', leaseId).where('contactId', '=', payerContactId).where('partyRole', 'in', PAYING_ROLES).executeTakeFirst();
  return party ? null : { field: `${prefix}.payerContactId`, code: 'not-a-party', message: 'The payer is not a tenant, occupant or guarantor of this lease.' };
}

function lineQuery(tx: Tx) {
  return tx
    .selectFrom('paymentImportLines as li')
    .leftJoin('leases as l', 'l.id', 'li.leaseId')
    .leftJoin('contacts as c', 'c.id', 'li.payerContactId')
    .select([
      'li.id', 'li.lineNo', 'li.txnDate', sql<string | null>`li.amount::text`.as('amount'), 'li.currencyCode', 'li.reference', 'li.description', 'li.transactionId', 'li.status',
      'li.errorCode', 'li.errorMessage', 'li.leaseId', 'l.reference as leaseReference', 'li.payerContactId', 'c.displayName as payerName', 'li.paymentId', 'li.version',
    ]);
}

type LineRow = Awaited<ReturnType<ReturnType<typeof lineQuery>['executeTakeFirstOrThrow']>>;

function toLine(row: LineRow, minor: number): ImportLineDto {
  return {
    id: row.id,
    lineNo: row.lineNo,
    date: row.txnDate,
    amount: row.amount && row.currencyCode ? toMoney(row.amount, row.currencyCode, minor) : null,
    reference: row.reference,
    description: row.description,
    transactionId: row.transactionId,
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    lease: row.leaseId ? { id: row.leaseId, name: row.leaseReference ?? '' } : null,
    payer: row.payerContactId ? { id: row.payerContactId, name: row.payerName ?? '' } : null,
    paymentId: row.paymentId,
    version: row.version,
  };
}
