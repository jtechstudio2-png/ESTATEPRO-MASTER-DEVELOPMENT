import { Injectable } from '@nestjs/common';
import { type RawBuilder, sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { isPostgresError } from '../common/db-errors.js';
import { todayIn } from '../common/dates.js';
import { keysetCondition, type Page, type ParsedListQuery, type RangeValue, sortValueSql, toPage } from '../common/list-query.js';
import { decimalPlaces, toMoney, toSignedMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import { actingMembership, type PermissionScope, type TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { nextReference } from '../properties/properties.service.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { isRealDate } from './agreements.service.js';
import { canOnLease, leaseAccess } from './lettings-access.js';
import type {
  AllocateBody,
  AllocationDto,
  AllocationViewDto,
  PaymentDto,
  RecordPaymentBody,
  SuggestedLineDto,
  UnwindResultDto,
} from './receipts.dto.js';
import { scaled, unscaled } from './rent-math.js';

export type PaymentSortField = 'receivedOn' | 'instrumentDate';

/** Lease statuses a receipt may name. */
const PAYABLE = ['active', 'periodic', 'notice_given', 'ended', 'closed'];
/** Parties who pay for a lease. */
const PAYING_ROLES = ['tenant', 'co_tenant', 'occupant', 'guarantor'];
const UNWIND_STATUS = { bounce: 'bounced', refund: 'refunded', void: 'voided' } as const;

/**
 * Receipts and their allocation (LET-04; wireframes RP-1, RP-2, RP-4 to RP-7;
 * readiness §5.3; P7-D7, P7-D8; P7-0 #2, #3). A receipt is recorded by a
 * person (or imported from a bank file, bank-import.service.ts); its terms are
 * fixed once cleared. A post-dated cheque waits as pending until cleared.
 * Allocation is always confirmed by a person; the oldest-first split is a
 * suggestion only. Bounce, refund and void reverse every allocation first
 * (app.unwind_payment), so the rent is owed again. The database enforces the
 * same rules (migrations 0008, 0035, 0038); this service answers first with
 * field codes and adds scope, audit and outbox events.
 */
@Injectable()
export class ReceiptsService {
  constructor(private readonly audit: AuditService) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, input: ParsedListQuery<PaymentSortField>): Promise<Page<PaymentDto> & { receivedOnWindow: { gte: string; lte: string } | null }> {
    const f = input.filters;
    let receivedOnWindow: { gte: string; lte: string } | null = null;
    const bounded = ['receivedOn', 'instrumentDate', 'leaseId', 'payerContactId'].some((key) => f[key] !== undefined) || f['unallocated'] === true;
    let receivedOn = f['receivedOn'] as RangeValue | undefined;
    if (!bounded) {
      // RP-1 opens on this month's receipts (company time zone).
      const month = todayIn(await companyTimezone(tx, ctx)).slice(0, 7);
      receivedOnWindow = { gte: `${month}-01`, lte: lastDayOfMonth(month) };
      receivedOn = receivedOnWindow;
    }
    const column = `pay.${input.sort.field}`;
    let qb = paymentQuery(tx).where(paymentScopeSql(ctx.permissions.get('rent.view')?.scope, ctx));
    for (const [filter, col] of [
      ['status', 'pay.status'],
      ['methodCode', 'pay.methodCode'],
      ['leaseId', 'pay.leaseId'],
      ['payerContactId', 'pay.payerContactId'],
      ['bankAccountId', 'pay.bankAccountId'],
      ['currency', 'pay.currencyCode'],
    ] as const) {
      const values = f[filter];
      if (Array.isArray(values)) qb = qb.where(col, 'in', values);
    }
    if (f['unallocated'] === true) qb = qb.where('pay.status', '=', 'cleared').where(sql<boolean>`pay.allocated_amount < pay.amount`);
    if (receivedOn?.gte) qb = qb.where('pay.receivedOn', '>=', receivedOn.gte);
    if (receivedOn?.lte) qb = qb.where('pay.receivedOn', '<=', receivedOn.lte);
    const instrument = f['instrumentDate'] as RangeValue | undefined;
    if (instrument?.gte) qb = qb.where('pay.instrumentDate', '>=', instrument.gte);
    if (instrument?.lte) qb = qb.where('pay.instrumentDate', '<=', instrument.lte);
    if (input.cursor) qb = qb.where(keysetCondition(column, 'pay.id', input.sort, input.cursor));
    const rows = await qb
      .select(sortValueSql(column, 'text').as('cursorValue'))
      .orderBy(sql.ref(column), input.sort.direction)
      .orderBy('pay.id', input.sort.direction)
      .limit(input.limit + 1)
      .execute();
    const minor = await minorUnits(tx, rows.map((row) => row.currencyCode));
    return { ...toPage(rows, input.limit, (row) => row.cursorValue ?? '', (row) => row.id, (row) => toPayment(row, minor)), receivedOnWindow };
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<PaymentDto> {
    const row = await this.visible(tx, ctx, id);
    return toPayment(row, await minorUnits(tx, [row.currencyCode]));
  }

  // ----------------------------------------------------------------- recording (RP-2)

  async record(tx: Tx, ctx: TenantContext, body: RecordPaymentBody): Promise<PaymentDto> {
    const errors: FieldError[] = [];
    const account = await tx.selectFrom('bankAccounts').select(['id', 'currencyCode', 'countryCode', 'isActive']).where('id', '=', body.bankAccountId).executeTakeFirst();
    if (!account || !account.isActive) errors.push({ field: 'bankAccountId', code: 'unknown', message: 'Choose an active bank account.' });
    const payer = await tx.selectFrom('contacts').select(['id', 'archivedAt']).where('id', '=', body.payerContactId).executeTakeFirst();
    if (!payer || payer.archivedAt !== null) errors.push({ field: 'payerContactId', code: 'unknown', message: 'Choose the person or organisation who paid.' });
    const today = todayIn(await companyTimezone(tx, ctx));
    if (!isRealDate(body.receivedOn)) errors.push({ field: 'receivedOn', code: 'invalid', message: 'Use a real date such as 2026-11-28.' });
    else if (body.receivedOn > today) errors.push({ field: 'receivedOn', code: 'future', message: 'Record a receipt once the money is received.' });
    if (body.instrumentDate && !isRealDate(body.instrumentDate)) errors.push({ field: 'instrumentDate', code: 'invalid', message: 'Use a real date such as 2026-12-01.' });
    if (body.methodCode === 'cheque' && !body.instrumentNumber?.trim()) errors.push({ field: 'instrumentNumber', code: 'required', message: 'Give the cheque number.' });
    if (body.methodCode !== 'cheque' && (body.instrumentNumber || body.instrumentDate || body.instrumentBank)) {
      errors.push({ field: 'instrumentNumber', code: 'not-a-cheque', message: 'Cheque details are for cheques only.' });
    }
    if (account) {
      const method = await checkPicklistCode(tx, 'payment_method', body.methodCode, account.countryCode, 'methodCode');
      if (method) errors.push(method);
      await checkAmount(tx, body.amount, account.currencyCode, 'amount', errors);
    }
    if (body.leaseId) {
      const access = await leaseAccess(tx, body.leaseId);
      if (!access || !canOnLease(ctx, 'rent.view', access)) errors.push({ field: 'leaseId', code: 'unknown', message: 'Choose a lease you can see.' });
      else {
        const lease = await tx.selectFrom('leases').select(['status', 'currencyCode']).where('id', '=', body.leaseId).executeTakeFirstOrThrow();
        if (!PAYABLE.includes(lease.status)) errors.push({ field: 'leaseId', code: 'lease-status', message: 'Receipts are recorded for signed leases.' });
        if (account && lease.currencyCode !== account.currencyCode) errors.push({ field: 'bankAccountId', code: 'currency-mismatch', message: `The lease is in ${lease.currencyCode}: choose a ${lease.currencyCode} account.` });
        const party = await tx.selectFrom('leaseParties').select('contactId').where('leaseId', '=', body.leaseId).where('contactId', '=', body.payerContactId).where('partyRole', 'in', PAYING_ROLES).executeTakeFirst();
        if (!party) errors.push({ field: 'payerContactId', code: 'not-a-party', message: 'The payer is not a tenant, occupant or guarantor of this lease.' });
      }
    }
    if (errors.length > 0) throw Problems.validation(errors);

    const postDated = body.methodCode === 'cheque' && Boolean(body.instrumentDate) && body.instrumentDate! > today;
    const status = postDated ? 'pending' : 'cleared';
    const reference = await nextReference(tx, ctx, 'payment');
    const inserted = await tx
      .insertInto('payments')
      .values({
        companyId: ctx.companyId,
        reference,
        payerContactId: body.payerContactId,
        leaseId: body.leaseId ?? null,
        bankAccountId: body.bankAccountId,
        methodCode: body.methodCode,
        currencyCode: account!.currencyCode,
        amount: body.amount.amount,
        receivedOn: body.receivedOn,
        instrumentNumber: body.instrumentNumber?.trim() || null,
        instrumentDate: body.instrumentDate ?? null,
        instrumentBank: body.instrumentBank?.trim() || null,
        valueDate: status === 'cleared' ? body.receivedOn : null,
        status,
        notes: body.notes?.trim() || null,
        recordedBy: actingMembership(ctx),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'payment.recorded',
      entityType: 'payment',
      entityId: inserted.id,
      metadata: { reference, leaseId: body.leaseId ?? null, amount: body.amount.amount, currency: account!.currencyCode, methodCode: body.methodCode, status },
    });
    await this.audit.emit(tx, ctx, {
      eventType: status === 'cleared' ? 'payment.received' : 'payment.recorded',
      aggregateType: 'payment',
      aggregateId: inserted.id,
      payload: { paymentId: inserted.id, leaseId: body.leaseId ?? null, amount: body.amount.amount, currency: account!.currencyCode, status },
    });
    return this.get(tx, ctx, inserted.id);
  }

  // ----------------------------------------------------------------- cheques and reversals (RP-6, RP-7)

  /** Pending → cleared, on the day the funds are available. */
  async clear(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, valueDate: string): Promise<PaymentDto> {
    const payment = await this.lock(tx, ctx, id, expectedVersion);
    if (payment.status !== 'pending') throw Problems.businessRule(`Only a pending receipt is cleared; this one is ${payment.status}.`);
    const today = todayIn(await companyTimezone(tx, ctx));
    if (!isRealDate(valueDate)) throw Problems.validation([{ field: 'valueDate', code: 'invalid', message: 'Use a real date such as 2026-11-28.' }]);
    if (valueDate < payment.receivedOn || valueDate > today) {
      throw Problems.validation([{ field: 'valueDate', code: 'out-of-range', message: `Use a date from ${payment.receivedOn} to today.` }]);
    }
    await tx.updateTable('payments').set({ status: 'cleared', valueDate }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'payment.cleared', entityType: 'payment', entityId: id, changes: { status: { old: 'pending', new: 'cleared' } }, metadata: { valueDate } });
    await this.audit.emit(tx, ctx, { eventType: 'payment.received', aggregateType: 'payment', aggregateId: id, payload: { paymentId: id, leaseId: payment.leaseId, valueDate } });
    return this.get(tx, ctx, id);
  }

  /** Bounce (cheques), refund (cleared) or void: every allocation is reversed first, in this transaction (#3). */
  async unwind(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, action: keyof typeof UNWIND_STATUS, reason: string, on: string): Promise<UnwindResultDto> {
    const payment = await this.lock(tx, ctx, id, expectedVersion);
    if (action === 'bounce' && payment.methodCode !== 'cheque') throw Problems.businessRule('Only a cheque bounces. Void or refund other receipts.');
    if (action === 'refund' && payment.status !== 'cleared') throw Problems.businessRule('Only a cleared receipt is refunded.');
    if (!['pending', 'cleared'].includes(payment.status)) throw Problems.businessRule(`This receipt is ${payment.status} already.`);
    const errors: FieldError[] = [];
    if (!isRealDate(on)) errors.push({ field: 'on', code: 'invalid', message: 'Use a real date such as 2026-11-28.' });
    else if (on < payment.receivedOn || on > todayIn(await companyTimezone(tx, ctx))) errors.push({ field: 'on', code: 'out-of-range', message: `Use a date from ${payment.receivedOn} to today.` });
    else if (await periodLocked(tx, on)) errors.push({ field: 'on', code: 'period-locked', message: 'This date is in a locked financial period.' });
    if (errors.length > 0) throw Problems.validation(errors);
    const status = UNWIND_STATUS[action];
    const { rows } = await sql<{ reversed: number }>`select app.unwind_payment(${id}::uuid, ${status}, ${reason.trim()}, ${on}::date) as reversed`.execute(tx);
    const reversed = Number(rows[0]!.reversed);
    await this.audit.record(tx, ctx, {
      action: `payment.${status}`,
      entityType: 'payment',
      entityId: id,
      changes: { status: { old: payment.status, new: status } },
      metadata: { reversedAllocations: reversed, on, leaseId: payment.leaseId },
    });
    await this.audit.emit(tx, ctx, { eventType: `payment.${status}`, aggregateType: 'payment', aggregateId: id, payload: { paymentId: id, leaseId: payment.leaseId, reversedAllocations: reversed, on } });
    return { payment: await this.get(tx, ctx, id), reversed };
  }

  // ----------------------------------------------------------------- allocation (RP-4)

  async allocationView(tx: Tx, ctx: TenantContext, id: string): Promise<AllocationViewDto> {
    const payment = await this.get(tx, ctx, id);
    const allocations = await allocationsOf(tx, id);
    const minor = (await minorUnits(tx, [payment.amount.currency])).get(payment.amount.currency) ?? 2;
    let suggestion: SuggestedLineDto[] = [];
    if (payment.status === 'cleared') {
      const leaseIds = payment.lease
        ? [payment.lease.id]
        : (await tx.selectFrom('leaseParties').select('leaseId').where('contactId', '=', payment.payer.id).where('partyRole', 'in', PAYING_ROLES).execute()).map((row) => row.leaseId);
      const visible: string[] = [];
      for (const leaseId of leaseIds) {
        const access = await leaseAccess(tx, leaseId);
        if (access && canOnLease(ctx, 'rent.view', access)) visible.push(leaseId);
      }
      if (visible.length > 0) {
        const open = await tx
          .selectFrom('rentCharges as c')
          .innerJoin('leases as l', 'l.id', 'c.leaseId')
          .select(['c.id', 'c.leaseId', 'l.reference', 'c.description', 'c.dueDate', sql<string>`(c.total_amount + c.adjusted_amount - c.allocated_amount)::text`.as('outstanding')])
          .where('c.leaseId', 'in', visible)
          .where('c.status', '=', 'posted')
          .where('c.currencyCode', '=', payment.amount.currency)
          .where(sql<boolean>`c.allocated_amount <> c.amount + c.tax_amount + c.adjusted_amount`)
          .orderBy('c.dueDate')
          .orderBy('c.periodStart')
          .orderBy('c.id')
          .limit(200)
          .execute();
        let left = scaled(payment.unallocated.amount);
        suggestion = open
          .filter((row) => scaled(row.outstanding) > 0n)
          .map((row) => {
            const outstanding = scaled(row.outstanding);
            const take = left > 0n ? (outstanding < left ? outstanding : left) : 0n;
            left -= take;
            return {
              rentChargeId: row.id,
              lease: { id: row.leaseId, name: row.reference },
              description: row.description,
              dueDate: row.dueDate,
              outstanding: toMoney(row.outstanding, payment.amount.currency, minor),
              suggested: toMoney(unscaled(take), payment.amount.currency, minor),
            };
          });
      }
    }
    return { payment, allocations: allocations.map((row) => toAllocation(row, minor)), suggestion };
  }

  /** All lines in one transaction, confirmed by a person (P7-D8). */
  async allocate(tx: Tx, ctx: TenantContext, id: string, body: AllocateBody): Promise<AllocationViewDto> {
    const payment = await this.lockForAllocation(tx, ctx, id);
    if (payment.status !== 'cleared') throw Problems.businessRule(`A receipt is allocated once cleared; this one is ${payment.status}.`);
    const errors: FieldError[] = [];
    if (!isRealDate(body.allocatedOn)) errors.push({ field: 'allocatedOn', code: 'invalid', message: 'Use a real date such as 2026-11-28.' });
    else if (body.allocatedOn > todayIn(await companyTimezone(tx, ctx))) errors.push({ field: 'allocatedOn', code: 'future', message: 'An allocation is dated today or earlier.' });
    else if (await periodLocked(tx, body.allocatedOn)) errors.push({ field: 'allocatedOn', code: 'period-locked', message: 'This date is in a locked financial period.' });
    const seen = new Set<string>();
    let total = 0n;
    for (const [index, line] of body.lines.entries()) {
      const field = `lines[${index}]`;
      if (seen.has(line.rentChargeId)) errors.push({ field: `${field}.rentChargeId`, code: 'duplicate', message: 'Allocate to each charge once.' });
      seen.add(line.rentChargeId);
      await checkAmount(tx, line.amount, payment.currencyCode, `${field}.amount`, errors);
      const charge = await tx
        .selectFrom('rentCharges')
        .select(['id', 'leaseId', 'status', 'currencyCode', sql<string>`(total_amount + adjusted_amount - allocated_amount)::text`.as('outstanding')])
        .where('id', '=', line.rentChargeId)
        .executeTakeFirst();
      const access = charge ? await leaseAccess(tx, charge.leaseId) : null;
      if (!charge || !access || !canOnLease(ctx, 'rent.view', access)) {
        errors.push({ field: `${field}.rentChargeId`, code: 'unknown', message: 'Choose a charge you can see.' });
        continue;
      }
      if (charge.status !== 'posted') errors.push({ field: `${field}.rentChargeId`, code: 'not-posted', message: `This charge is ${charge.status}.` });
      if (charge.currencyCode !== payment.currencyCode) errors.push({ field: `${field}.rentChargeId`, code: 'currency-mismatch', message: `The receipt is in ${payment.currencyCode}.` });
      if (/^\d/.test(line.amount.amount) && scaled(line.amount.amount) > scaled(charge.outstanding)) {
        errors.push({ field: `${field}.amount`, code: 'above-outstanding', message: 'More than the charge still owes.' });
      }
      total += scaled(line.amount.amount);
    }
    if (errors.length === 0 && total > scaled(payment.amount) - scaled(payment.allocatedAmount)) {
      errors.push({ field: 'lines', code: 'above-unallocated', message: 'More than the receipt has left to allocate.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    try {
      await tx
        .insertInto('paymentAllocations')
        .values(body.lines.map((line) => ({ companyId: ctx.companyId, paymentId: id, rentChargeId: line.rentChargeId, amount: line.amount.amount, allocatedOn: body.allocatedOn, allocatedBy: actingMembership(ctx) })))
        .execute();
    } catch (error) {
      // The checks above passed, so the database's own limits were reached by another request in the meantime (suite 18).
      if (isPostgresError(error) && error.code === '23514') throw Problems.conflict('Someone allocated this receipt or these charges at the same time. Reload and try again.');
      throw error;
    }
    await this.audit.record(tx, ctx, {
      action: 'payment.allocated',
      entityType: 'payment',
      entityId: id,
      metadata: { allocatedOn: body.allocatedOn, lines: body.lines.map((line) => ({ rentChargeId: line.rentChargeId, amount: line.amount.amount })) },
    });
    await this.audit.emit(tx, ctx, { eventType: 'payment.allocated', aggregateType: 'payment', aggregateId: id, payload: { paymentId: id, total: unscaled(total), currency: payment.currencyCode } });
    return this.allocationView(tx, ctx, id);
  }

  /** Reverses one allocation (an append-only negative row), so the charge is owed again. */
  async reverseAllocation(tx: Tx, ctx: TenantContext, id: string, allocationId: string, on: string): Promise<AllocationViewDto> {
    const payment = await this.lockForAllocation(tx, ctx, id);
    const allocation = await tx
      .selectFrom('paymentAllocations as a')
      .select(['a.id', 'a.rentChargeId', sql<string>`a.amount::text`.as('amount'), 'a.reversalOfId', 'a.allocatedOn'])
      .where('a.id', '=', allocationId)
      .where('a.paymentId', '=', id)
      .executeTakeFirst();
    if (!allocation) throw Problems.notFound();
    if (allocation.reversalOfId !== null) throw Problems.businessRule('This is a reversal; it cannot be reversed.');
    const already = await tx.selectFrom('paymentAllocations').select('id').where('reversalOfId', '=', allocationId).executeTakeFirst();
    if (already) throw Problems.businessRule('This allocation is reversed already.');
    const errors: FieldError[] = [];
    if (!isRealDate(on)) errors.push({ field: 'on', code: 'invalid', message: 'Use a real date such as 2026-11-28.' });
    else if (on < allocation.allocatedOn || on > todayIn(await companyTimezone(tx, ctx))) errors.push({ field: 'on', code: 'out-of-range', message: `Use a date from ${allocation.allocatedOn} to today.` });
    else if (await periodLocked(tx, on)) errors.push({ field: 'on', code: 'period-locked', message: 'This date is in a locked financial period.' });
    if (errors.length > 0) throw Problems.validation(errors);
    await tx
      .insertInto('paymentAllocations')
      .values({ companyId: ctx.companyId, paymentId: id, rentChargeId: allocation.rentChargeId, amount: unscaled(-scaled(allocation.amount)), reversalOfId: allocationId, allocatedOn: on, allocatedBy: actingMembership(ctx) })
      .execute();
    await this.audit.record(tx, ctx, { action: 'payment.allocation_reversed', entityType: 'payment', entityId: id, metadata: { allocationId, rentChargeId: allocation.rentChargeId, amount: allocation.amount, on } });
    await this.audit.emit(tx, ctx, { eventType: 'payment.allocation_reversed', aggregateType: 'payment', aggregateId: id, payload: { paymentId: id, allocationId, currency: payment.currencyCode } });
    return this.allocationView(tx, ctx, id);
  }

  // ----------------------------------------------------------------- helpers

  private async visible(tx: Tx, ctx: TenantContext, id: string) {
    const row = await paymentQuery(tx).where('pay.id', '=', id).where(paymentScopeSql(ctx.permissions.get('rent.view')?.scope, ctx)).executeTakeFirst();
    if (!row) throw Problems.notFound();
    return row;
  }

  private async lock(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number) {
    await this.visible(tx, ctx, id);
    const payment = await tx
      .selectFrom('payments')
      .select(['id', 'status', 'methodCode', 'receivedOn', 'leaseId', 'currencyCode', 'version'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (payment.version !== expectedVersion) throw Problems.preconditionFailed();
    return payment;
  }

  private async lockForAllocation(tx: Tx, ctx: TenantContext, id: string) {
    await this.visible(tx, ctx, id);
    return tx
      .selectFrom('payments')
      .select(['id', 'status', 'currencyCode', sql<string>`amount::text`.as('amount'), sql<string>`allocated_amount::text`.as('allocatedAmount')])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }
}

// ------------------------------------------------------------------- queries

/** rent.view scope for receipts: all, or office (the receipt's lease's property office; receipts without a lease are not in an office). */
export function paymentScopeSql(scope: PermissionScope | null | undefined, ctx: TenantContext): RawBuilder<boolean> {
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0 ? sql<boolean>`p.office_id = any(${[...ctx.officeIds]}::uuid[])` : sql<boolean>`false`;
    default:
      return sql<boolean>`false`;
  }
}

function paymentQuery(tx: Tx) {
  return tx
    .selectFrom('payments as pay')
    .innerJoin('contacts as pc', 'pc.id', 'pay.payerContactId')
    .innerJoin('bankAccounts as ba', 'ba.id', 'pay.bankAccountId')
    .leftJoin('leases as l', 'l.id', 'pay.leaseId')
    .leftJoin('units as u', 'u.id', 'l.unitId')
    .leftJoin('properties as p', 'p.id', 'u.propertyId')
    .select([
      'pay.id', 'pay.reference', 'pay.payerContactId', 'pc.displayName as payerName', 'pay.leaseId', 'l.reference as leaseReference', 'pay.bankAccountId',
      'ba.name as bankAccountName', 'pay.methodCode', 'pay.currencyCode', 'pay.amount', 'pay.allocatedAmount', 'pay.receivedOn', 'pay.valueDate',
      'pay.instrumentNumber', 'pay.instrumentDate', 'pay.instrumentBank', 'pay.status', 'pay.statusReason', 'pay.notes', 'pay.idempotencyKey', 'pay.createdAt', 'pay.version',
    ]);
}

type PaymentRow = Awaited<ReturnType<ReturnType<typeof paymentQuery>['executeTakeFirstOrThrow']>>;

function toPayment(row: PaymentRow, minor: Map<string, number>): PaymentDto {
  const units = minor.get(row.currencyCode) ?? 2;
  const unallocated = row.status === 'cleared' ? scaled(row.amount) - scaled(row.allocatedAmount) : 0n;
  return {
    id: row.id,
    reference: row.reference,
    payer: { id: row.payerContactId, name: row.payerName },
    lease: row.leaseId ? { id: row.leaseId, name: row.leaseReference ?? '' } : null,
    bankAccount: { id: row.bankAccountId, name: row.bankAccountName },
    methodCode: row.methodCode,
    amount: toMoney(row.amount, row.currencyCode, units),
    allocated: toSignedMoney(row.allocatedAmount, row.currencyCode, units),
    unallocated: toSignedMoney(unscaled(unallocated), row.currencyCode, units),
    receivedOn: row.receivedOn,
    valueDate: row.valueDate,
    instrumentNumber: row.instrumentNumber,
    instrumentDate: row.instrumentDate,
    instrumentBank: row.instrumentBank,
    status: row.status,
    statusReason: row.statusReason,
    notes: row.notes,
    imported: row.idempotencyKey?.startsWith('bankfile:') ?? false,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

async function allocationsOf(tx: Tx, paymentId: string) {
  return tx
    .selectFrom('paymentAllocations as a')
    .innerJoin('rentCharges as c', 'c.id', 'a.rentChargeId')
    .innerJoin('payments as pay', 'pay.id', 'a.paymentId')
    .select([
      'a.id', 'a.paymentId', 'pay.reference', 'a.rentChargeId', 'c.description', sql<string>`a.amount::text`.as('amount'), 'a.allocatedOn', 'a.reversalOfId', 'pay.currencyCode',
      sql<boolean>`exists (select 1 from payment_allocations r where r.reversal_of_id = a.id)`.as('reversed'),
    ])
    .where('a.paymentId', '=', paymentId)
    .orderBy('a.createdAt')
    .orderBy('a.id')
    .execute();
}

function toAllocation(row: Awaited<ReturnType<typeof allocationsOf>>[number], minor: number): AllocationDto {
  return {
    id: row.id,
    paymentId: row.paymentId,
    paymentReference: row.reference,
    rentChargeId: row.rentChargeId,
    chargeDescription: row.description,
    amount: toSignedMoney(row.amount, row.currencyCode, minor),
    allocatedOn: row.allocatedOn,
    reversalOfId: row.reversalOfId,
    reversed: row.reversed,
  };
}

/** The amount in the currency, positive, at most its minor units. */
export async function checkAmount(tx: Tx, money: { amount: string; currency: string }, currencyCode: string, field: string, errors: FieldError[]): Promise<void> {
  if (money.currency !== currencyCode) {
    errors.push({ field: `${field}.currency`, code: 'currency-mismatch', message: `Use ${currencyCode}.` });
    return;
  }
  const minor = (await minorUnits(tx, [currencyCode])).get(currencyCode) ?? 2;
  if (decimalPlaces(money.amount) > minor) errors.push({ field: `${field}.amount`, code: 'precision', message: `${currencyCode} has ${minor} decimal places.` });
  if (scaled(money.amount) <= 0n) errors.push({ field: `${field}.amount`, code: 'positive', message: 'The amount must be more than zero.' });
}

export async function companyTimezone(tx: Tx, ctx: TenantContext): Promise<string> {
  return (await tx.selectFrom('companies').select('defaultTimezone').where('id', '=', ctx.companyId).executeTakeFirstOrThrow()).defaultTimezone;
}

export async function periodLocked(tx: Tx, date: string): Promise<boolean> {
  const row = await tx.selectFrom('financialPeriods').select('id').where('status', '=', 'locked').where('periodStart', '<=', date).where('periodEnd', '>=', date).executeTakeFirst();
  return row !== undefined;
}

export async function minorUnits(tx: Tx, codes: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const rows = await tx.selectFrom('currencies').select(['code', 'minorUnits']).where('code', 'in', unique).execute();
  return new Map(rows.map((row) => [row.code, row.minorUnits]));
}

export function lastDayOfMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
}
