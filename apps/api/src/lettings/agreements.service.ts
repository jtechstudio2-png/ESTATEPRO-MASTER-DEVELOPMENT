import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { keysetCondition, type Page, type ParsedListQuery, sortValueSql, toPage } from '../common/list-query.js';
import { decimalPlaces, type MoneyInput, toMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { DocumentsService } from '../documents/documents.service.js';
import { nextReference } from '../properties/properties.service.js';
import type { AgreementDto, CreateAgreementBody, UpdateAgreementBody } from './lettings.dto.js';
import { agreementScopeSql, canOnAgreement } from './lettings-access.js';

registerConstraintMessages({
  management_agreements_end_date_check: 'The end date is on or after the start date.',
});

export type AgreementSortField = 'createdAt' | 'startDate';

/** Fields an active or suspended agreement may still change (the rest are its instruction, migration 0036). */
const OPERATIONAL = new Set(['expenseApprovalLimit', 'floatAmount', 'payoutFrequency', 'payoutDay', 'endDate', 'noticePeriodDays']);
const LIVE_LEASE = ['draft', 'pending_signature', 'active', 'periodic', 'notice_given', 'ended'];

/** Checks an amount is in the agreement's currency with at most its decimal places. */
export async function checkCurrencyAmount(tx: Tx, money: MoneyInput, currencyCode: string, field: string, errors: FieldError[], positive = false): Promise<void> {
  if (money.currency !== currencyCode) {
    errors.push({ field: `${field}.currency`, code: 'currency-mismatch', message: `Use ${currencyCode}.` });
    return;
  }
  const currency = await tx.selectFrom('currencies').select('minorUnits').where('code', '=', currencyCode).executeTakeFirst();
  if (!currency) {
    errors.push({ field: `${field}.currency`, code: 'unknown-currency', message: 'Unknown currency.' });
    return;
  }
  if (decimalPlaces(money.amount) > currency.minorUnits) errors.push({ field: `${field}.amount`, code: 'precision', message: `${currencyCode} has ${currency.minorUnits} decimal places.` });
  if (positive && Number(money.amount) <= 0) errors.push({ field: `${field}.amount`, code: 'positive', message: 'The amount must be more than zero.' });
}

export function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Management agreements (LET-02; wireframes MA-1, MA-2; readiness §5.1 step 1).
 * A draft is edited freely; activation needs the signed agreement scanned
 * clean and no other live agreement on the unit; afterwards only the
 * operational terms change. Suspended agreements are reactivated; an
 * agreement with live leases cannot end. Fees are recorded, not charged
 * (P7-D2). The database enforces the same rules (migration 0036).
 */
@Injectable()
export class AgreementsService {
  constructor(
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  async list(tx: Tx, ctx: TenantContext, query: ParsedListQuery<AgreementSortField>): Promise<Page<AgreementDto>> {
    const f = query.filters;
    const column = `m.${query.sort.field}`;
    let qb = this.baseQuery(tx)
      .select(sortValueSql(column, query.sort.kind).as('cursorValue'))
      .where(agreementScopeSql(ctx.permissions.get('management_agreement.view')?.scope, ctx));
    for (const [filter, col] of [
      ['status', 'm.status'],
      ['serviceLevel', 'm.serviceLevel'],
      ['propertyId', 'm.propertyId'],
      ['landlordContactId', 'm.landlordContactId'],
    ] as const) {
      const values = f[filter];
      if (Array.isArray(values)) qb = qb.where(col, 'in', values);
    }
    if (query.q !== null) {
      const q = query.q.replace(/[\\%_]/g, (c) => `\\${c}`);
      qb = qb.where((eb) => eb.or([eb('m.reference', 'ilike', `${q}%`), eb('c.displayName', 'ilike', `%${q}%`), eb('p.name', 'ilike', `%${q}%`)]));
    }
    if (query.cursor) qb = qb.where(keysetCondition(column, 'm.id', query.sort, query.cursor));
    const rows = await qb.orderBy(sql.ref(column), query.sort.direction).orderBy('m.id', query.sort.direction).limit(query.limit + 1).execute();
    const minor = await this.minorUnits(tx, rows.map((row) => row.currencyCode));
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => toDto(row, minor));
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<AgreementDto> {
    const row = await this.baseQuery(tx).where('m.id', '=', id).executeTakeFirst();
    if (!row || !canOnAgreement(ctx, 'management_agreement.view', row)) throw Problems.notFound();
    return toDto(row, await this.minorUnits(tx, [row.currencyCode]));
  }

  async create(tx: Tx, ctx: TenantContext, body: CreateAgreementBody): Promise<AgreementDto> {
    const property = await tx.selectFrom('properties').select(['id', 'officeId', 'archivedAt']).where('id', '=', body.propertyId).executeTakeFirst();
    if (!property || !canOnAgreement(ctx, 'management_agreement.view', property)) {
      throw Problems.validation([{ field: 'propertyId', code: 'not-found', message: 'This property does not exist or you cannot see it.' }]);
    }
    if (!canOnAgreement(ctx, 'management_agreement.manage', property)) throw Problems.forbidden('Your role does not allow agreements for this property.');
    if (property.archivedAt !== null) throw Problems.businessRule('This property is archived.');
    const errors: FieldError[] = [];
    await this.checkTerms(tx, { ...body, unitId: body.unitId ?? null, propertyId: property.id }, errors);
    if (errors.length > 0) throw Problems.validation(errors);

    const reference = await nextReference(tx, ctx, 'management_agreement');
    const inserted = await tx
      .insertInto('managementAgreements')
      .values({
        companyId: ctx.companyId,
        reference,
        landlordContactId: body.landlordContactId,
        propertyId: property.id,
        unitId: body.unitId ?? null,
        serviceLevel: body.serviceLevel,
        currencyCode: body.currencyCode,
        feeBasis: body.feeBasis,
        feePercent: body.feePercent !== undefined ? String(body.feePercent) : null,
        feeFixedAmount: body.feeFixed?.amount ?? null,
        expenseApprovalLimit: body.expenseApprovalLimit?.amount ?? null,
        floatAmount: body.floatAmount?.amount ?? '0',
        payoutFrequency: body.payoutFrequency ?? 'monthly',
        payoutDay: body.payoutDay ?? null,
        startDate: body.startDate,
        endDate: body.endDate ?? null,
        noticePeriodDays: body.noticePeriodDays ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'management_agreement.created',
      entityType: 'management_agreement',
      entityId: inserted.id,
      metadata: { reference, propertyId: property.id, unitId: body.unitId ?? null, landlordContactId: body.landlordContactId, serviceLevel: body.serviceLevel },
    });
    await this.audit.emit(tx, ctx, { eventType: 'management_agreement.created', aggregateType: 'management_agreement', aggregateId: inserted.id, payload: { agreementId: inserted.id, propertyId: property.id } });
    return this.get(tx, ctx, inserted.id);
  }

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateAgreementBody): Promise<AgreementDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'management_agreement.manage');
    if (current.status === 'ended') throw Problems.businessRule('This agreement has ended and does not change.');
    const given = Object.entries(body).filter(([, value]) => value !== undefined).map(([key]) => key);
    if (current.status !== 'draft') {
      const fixed = given.filter((key) => !OPERATIONAL.has(key));
      if (fixed.length > 0) {
        throw Problems.validation(fixed.map((key) => ({ field: key, code: 'fixed', message: 'An active agreement keeps its instruction and fee terms. End it and make a new agreement.' })));
      }
    }
    const next = {
      landlordContactId: body.landlordContactId ?? current.landlordContactId,
      propertyId: current.propertyId,
      unitId: body.unitId !== undefined ? body.unitId : current.unitId,
      serviceLevel: body.serviceLevel ?? current.serviceLevel,
      currencyCode: body.currencyCode ?? current.currencyCode,
      feeBasis: body.feeBasis ?? current.feeBasis,
      feePercent: body.feePercent !== undefined ? body.feePercent : current.feePercent === null ? null : Number(current.feePercent),
      feeFixed: body.feeFixed !== undefined ? body.feeFixed : current.feeFixedAmount === null ? null : { amount: current.feeFixedAmount, currency: current.currencyCode },
      expenseApprovalLimit: body.expenseApprovalLimit !== undefined ? body.expenseApprovalLimit : current.expenseApprovalLimit === null ? null : { amount: current.expenseApprovalLimit, currency: current.currencyCode },
      floatAmount: body.floatAmount ?? { amount: current.floatAmount, currency: current.currencyCode },
      payoutDay: body.payoutDay !== undefined ? body.payoutDay : current.payoutDay,
      startDate: body.startDate ?? current.startDate,
      endDate: body.endDate !== undefined ? body.endDate : current.endDate,
    };
    const errors: FieldError[] = [];
    await this.checkTerms(tx, next, errors, current.status === 'draft');
    if (errors.length > 0) throw Problems.validation(errors);

    const values = {
      landlordContactId: next.landlordContactId,
      unitId: next.unitId,
      serviceLevel: next.serviceLevel,
      currencyCode: next.currencyCode,
      feeBasis: next.feeBasis,
      feePercent: next.feePercent === null ? null : String(next.feePercent),
      feeFixedAmount: next.feeFixed?.amount ?? null,
      expenseApprovalLimit: next.expenseApprovalLimit?.amount ?? null,
      floatAmount: next.floatAmount.amount,
      payoutFrequency: body.payoutFrequency ?? current.payoutFrequency,
      payoutDay: next.payoutDay,
      startDate: next.startDate,
      endDate: next.endDate,
      noticePeriodDays: body.noticePeriodDays !== undefined ? body.noticePeriodDays : current.noticePeriodDays,
    };
    const changes = diffForAudit(comparable(pick(current, Object.keys(values))), comparable(values));
    if (!changes) return this.get(tx, ctx, id);
    const update = current.status === 'draft' ? values : Object.fromEntries(Object.entries(values).filter(([key]) => OPERATIONAL.has(key)));
    await tx.updateTable('managementAgreements').set({ ...update, version: sql`version + 1` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'management_agreement.updated', entityType: 'management_agreement', entityId: id, changes });
    return this.get(tx, ctx, id);
  }

  /** Draft or suspended → active, with the signed agreement (management_agreement.approve). */
  async activate(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, documentId: string): Promise<AgreementDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'management_agreement.approve');
    if (current.status !== 'draft' && current.status !== 'suspended') throw Problems.businessRule(`An ${current.status} agreement cannot be activated.`);
    await this.documents.assertUsable(tx, documentId, 'management_agreement', id, 'documentId');
    await this.assertNoOverlap(tx, current);
    if (current.status === 'draft') await this.assertLandlord(tx, current.landlordContactId);
    await tx.updateTable('managementAgreements').set({ status: 'active', documentId, version: sql`version + 1` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'management_agreement.activated', entityType: 'management_agreement', entityId: id, changes: { status: { old: current.status, new: 'active' } }, metadata: { documentId } });
    await this.audit.emit(tx, ctx, { eventType: 'management_agreement.activated', aggregateType: 'management_agreement', aggregateId: id, payload: { agreementId: id, propertyId: current.propertyId, unitId: current.unitId } });
    return this.get(tx, ctx, id);
  }

  async suspend(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<AgreementDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'management_agreement.manage');
    if (current.status !== 'active') throw Problems.businessRule('Only an active agreement can be suspended.');
    await tx.updateTable('managementAgreements').set({ status: 'suspended', version: sql`version + 1` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'management_agreement.suspended', entityType: 'management_agreement', entityId: id, changes: { status: { old: 'active', new: 'suspended' } } });
    await this.audit.emit(tx, ctx, { eventType: 'management_agreement.suspended', aggregateType: 'management_agreement', aggregateId: id, payload: { agreementId: id } });
    return this.get(tx, ctx, id);
  }

  async end(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, endDate: string): Promise<AgreementDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'management_agreement.manage');
    if (current.status !== 'active' && current.status !== 'suspended') {
      throw Problems.businessRule(current.status === 'draft' ? 'A draft agreement is not ended. It was never in force.' : 'This agreement has already ended.');
    }
    if (!isRealDate(endDate)) throw Problems.validation([{ field: 'endDate', code: 'invalid', message: 'Use a real date such as 2027-11-30.' }]);
    if (endDate < current.startDate) throw Problems.validation([{ field: 'endDate', code: 'before-start', message: 'The end date is on or after the start date.' }]);
    const live = await tx
      .selectFrom('leases')
      .select(['reference'])
      .where('managementAgreementId', '=', id)
      .where('status', 'in', ['pending_signature', 'active', 'periodic', 'notice_given'])
      .orderBy('reference')
      .execute();
    if (live.length > 0) throw Problems.businessRule(`End or cancel the live leases under this agreement first: ${live.map((lease) => lease.reference).join(', ')}.`);
    await tx.updateTable('managementAgreements').set({ status: 'ended', endDate, version: sql`version + 1` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'management_agreement.ended', entityType: 'management_agreement', entityId: id, changes: { status: { old: current.status, new: 'ended' }, endDate: { old: current.endDate, new: endDate } } });
    await this.audit.emit(tx, ctx, { eventType: 'management_agreement.ended', aggregateType: 'management_agreement', aggregateId: id, payload: { agreementId: id, endDate } });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- helpers

  private async lock(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, permission: string) {
    const row = await tx
      .selectFrom('managementAgreements as m')
      .innerJoin('properties as p', 'p.id', 'm.propertyId')
      .selectAll('m')
      .select('p.officeId')
      .where('m.id', '=', id)
      .forUpdate('m')
      .executeTakeFirst();
    if (!row || !canOnAgreement(ctx, 'management_agreement.view', row)) throw Problems.notFound();
    if (!canOnAgreement(ctx, permission, row)) {
      throw Problems.forbidden(permission === 'management_agreement.approve' ? 'Activating agreements is for the company owner and property managers.' : 'Your role does not allow changes to this agreement.');
    }
    if (row.version !== expectedVersion) throw Problems.preconditionFailed();
    return row;
  }

  private async checkTerms(
    tx: Tx,
    terms: {
      landlordContactId: string;
      propertyId: string;
      unitId: string | null;
      currencyCode: string;
      feeBasis: string;
      feePercent?: number | null;
      feeFixed?: MoneyInput | null;
      expenseApprovalLimit?: MoneyInput | null;
      floatAmount?: MoneyInput;
      startDate: string;
      endDate?: string | null;
    },
    errors: FieldError[],
    checkLandlord = true,
  ): Promise<void> {
    if (checkLandlord) {
      const landlord = await tx.selectFrom('contacts').select(['isAnonymised', 'mergedIntoContactId', 'archivedAt']).where('id', '=', terms.landlordContactId).executeTakeFirst();
      if (!landlord) errors.push({ field: 'landlordContactId', code: 'not-found', message: 'This contact does not exist.' });
      else if (landlord.isAnonymised || landlord.mergedIntoContactId !== null || landlord.archivedAt !== null) {
        errors.push({ field: 'landlordContactId', code: 'not-active', message: 'This contact is archived, merged or erased.' });
      }
    }
    if (terms.unitId !== null) {
      const unit = await tx.selectFrom('units').select(['propertyId', 'archivedAt']).where('id', '=', terms.unitId).executeTakeFirst();
      if (!unit || unit.propertyId !== terms.propertyId) errors.push({ field: 'unitId', code: 'not-found', message: 'This unit is not part of the property.' });
      else if (unit.archivedAt !== null) errors.push({ field: 'unitId', code: 'archived', message: 'This unit is archived.' });
    }
    const percent = terms.feeBasis.startsWith('percent');
    if (percent && (terms.feePercent === undefined || terms.feePercent === null)) errors.push({ field: 'feePercent', code: 'required', message: 'Give the fee percentage.' });
    if (!percent && !terms.feeFixed) errors.push({ field: 'feeFixed', code: 'required', message: 'Give the fixed fee.' });
    for (const [field, money] of [['feeFixed', terms.feeFixed], ['expenseApprovalLimit', terms.expenseApprovalLimit], ['floatAmount', terms.floatAmount]] as const) {
      if (money) await checkCurrencyAmount(tx, money, terms.currencyCode, field, errors);
    }
    if (!isRealDate(terms.startDate)) errors.push({ field: 'startDate', code: 'invalid', message: 'Use a real date such as 2026-12-01.' });
    if (terms.endDate) {
      if (!isRealDate(terms.endDate)) errors.push({ field: 'endDate', code: 'invalid', message: 'Use a real date such as 2027-11-30.' });
      else if (terms.endDate < terms.startDate) errors.push({ field: 'endDate', code: 'before-start', message: 'The end date is on or after the start date.' });
    }
  }

  private async assertLandlord(tx: Tx, contactId: string): Promise<void> {
    const errors: FieldError[] = [];
    const landlord = await tx.selectFrom('contacts').select(['isAnonymised', 'mergedIntoContactId', 'archivedAt']).where('id', '=', contactId).executeTakeFirst();
    if (!landlord || landlord.isAnonymised || landlord.mergedIntoContactId !== null || landlord.archivedAt !== null) {
      errors.push({ field: 'landlordContactId', code: 'not-active', message: 'The landlord is archived, merged or erased. Choose another landlord first.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
  }

  private async assertNoOverlap(tx: Tx, agreement: { id: string; propertyId: string; unitId: string | null }): Promise<void> {
    const other = await tx
      .selectFrom('managementAgreements')
      .select('reference')
      .where('propertyId', '=', agreement.propertyId)
      .where('id', '<>', agreement.id)
      .where('status', 'in', ['active', 'suspended'])
      .where((eb) => (agreement.unitId === null ? eb.val(true) : eb.or([eb('unitId', 'is', null), eb('unitId', '=', agreement.unitId)])))
      .executeTakeFirst();
    if (other) throw Problems.businessRule(`Agreement ${other.reference} already covers this unit. End it before activating another.`);
  }

  private baseQuery(tx: Tx) {
    return agreementQuery(tx);
  }

  private async minorUnits(tx: Tx, codes: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return new Map();
    const rows = await tx.selectFrom('currencies').select(['code', 'minorUnits']).where('code', 'in', unique).execute();
    return new Map(rows.map((row) => [row.code, row.minorUnits]));
  }
}

function agreementQuery(tx: Tx) {
  return tx
    .selectFrom('managementAgreements as m')
    .innerJoin('properties as p', 'p.id', 'm.propertyId')
    .innerJoin('contacts as c', 'c.id', 'm.landlordContactId')
    .leftJoin('units as u', 'u.id', 'm.unitId')
    .leftJoin('documents as d', 'd.id', 'm.documentId')
    .select([
      'm.id', 'm.reference', 'm.status', 'm.landlordContactId', 'c.displayName as landlordName', 'm.propertyId', 'p.name as propertyName', 'p.officeId',
      'm.unitId', 'u.unitLabel', 'm.serviceLevel', 'm.currencyCode', 'm.feeBasis', 'm.feePercent', 'm.feeFixedAmount', 'm.expenseApprovalLimit',
      'm.floatAmount', 'm.payoutFrequency', 'm.payoutDay', 'm.startDate', 'm.endDate', 'm.noticePeriodDays', 'm.documentId', 'd.title as documentTitle',
      'm.createdAt', 'm.updatedAt', 'm.version',
      sql<number>`(select count(*)::int from leases l where l.company_id = m.company_id and l.management_agreement_id = m.id and l.status = any(${LIVE_LEASE}::text[]))`.as('liveLeases'),
    ]);
}


type AgreementRow = Awaited<ReturnType<ReturnType<typeof agreementQuery>['executeTakeFirstOrThrow']>>;

function toDto(row: AgreementRow, minor: Map<string, number>): AgreementDto {
  const units = minor.get(row.currencyCode) ?? 2;
  const money = (value: string | null) => (value === null ? null : toMoney(value, row.currencyCode, units));
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    landlord: { id: row.landlordContactId, name: row.landlordName },
    property: { id: row.propertyId, name: row.propertyName ?? '' },
    unit: row.unitId ? { id: row.unitId, name: row.unitLabel ?? '' } : null,
    serviceLevel: row.serviceLevel,
    currencyCode: row.currencyCode,
    fee: { basis: row.feeBasis, percent: row.feePercent === null ? null : Number(row.feePercent), fixed: money(row.feeFixedAmount) },
    expenseApprovalLimit: money(row.expenseApprovalLimit),
    floatAmount: toMoney(row.floatAmount, row.currencyCode, units),
    payoutFrequency: row.payoutFrequency,
    payoutDay: row.payoutDay,
    startDate: row.startDate,
    endDate: row.endDate,
    noticePeriodDays: row.noticePeriodDays,
    document: row.documentId ? { id: row.documentId, name: row.documentTitle ?? '' } : null,
    liveLeases: row.liveLeases,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

/** Amounts and percentages as numbers, so "100.00" and the stored "100.0000" compare equal. */
function comparable(values: Record<string, unknown>): Record<string, unknown> {
  const numeric = new Set(['feePercent', 'feeFixedAmount', 'expenseApprovalLimit', 'floatAmount']);
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, numeric.has(key) && typeof value === 'string' ? Number(value) : value]));
}
