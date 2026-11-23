import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { todayIn } from '../common/dates.js';
import { keysetCondition, type Page, type ParsedListQuery, type RangeValue, sortValueSql, toPage } from '../common/list-query.js';
import { toMoney, toSignedMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import { actingMembership, type TenantContext } from '../common/request-context.js';
import { memberGrant } from '../crm/lead-access.js';
import type { Tx } from '../database/database.module.js';
import { checkCurrencyAmount, isRealDate } from './agreements.service.js';
import { canOnLease, leaseAccess, leaseScopeSql, leaseWithin } from './lettings-access.js';
import type {
  AdjustmentBody,
  AdjustmentDto,
  AdjustmentPreviewDto,
  AdjustmentResultDto,
  AgeingDto,
  ChargeBalanceDto,
  CreateChargeBody,
  CurrencyTotalDto,
  LedgerDto,
  LedgerEntryDto,
  RentChargeDto,
} from './rent.dto.js';
import { scaled, unscaled } from './rent-math.js';
import { chargeLeadDays, postLeaseRent } from './rent-schedule.js';

registerConstraintMessages({
  rent_charges_period_idx: 'A charge of this type already exists for this period.',
});

export type ChargeSortField = 'dueDate';

const LIVE = ['active', 'periodic', 'notice_given'];
const CHARGEABLE = [...LIVE, 'ended'];
const TENANT_ROLES = ['tenant', 'co_tenant'];

/** What a charge owes, in stored (4-place) decimal strings, computed in the database. */
interface Balance {
  total: string;
  adjusted: string;
  paid: string;
}

/**
 * Rent charges, adjustments and the lease ledger (LET-03, LET-05 in part;
 * wireframes RL-1, RC-1 to RC-4; P7-0 #1). Rent is created by the schedule
 * (rent-schedule.ts); people add other charges, waive or cancel a posted
 * charge with nothing allocated, and correct a posted charge only by an
 * adjustment (append-only, with a reason and an approver who holds
 * rent.manage, W7-D2). The database enforces the same rules (migrations 0035,
 * 0037); this service checks first to answer with field-level codes, and adds
 * scope, audit and outbox events. Amounts are per currency, never summed
 * across currencies (ADR-003).
 */
@Injectable()
export class ChargesService {
  constructor(private readonly audit: AuditService) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, input: ParsedListQuery<ChargeSortField>): Promise<Page<RentChargeDto> & { totals: CurrencyTotalDto[]; dueDateWindow: { gte: string; lte: string } | null }> {
    // RC-1 opens on the charges due this month (company time zone). Without a due-date or lease filter the list,
    // and its totals, cover that month, so a request never totals every charge the company has ever raised.
    let dueDateWindow: { gte: string; lte: string } | null = null;
    let query = input;
    if (input.filters['dueDate'] === undefined && input.filters['leaseId'] === undefined) {
      const company = await tx.selectFrom('companies').select('defaultTimezone').where('id', '=', ctx.companyId).executeTakeFirstOrThrow();
      const month = todayIn(company.defaultTimezone).slice(0, 7);
      dueDateWindow = { gte: `${month}-01`, lte: lastDayOfMonth(month) };
      query = { ...input, filters: { ...input.filters, dueDate: dueDateWindow } };
    }
    const column = 'c.dueDate';
    const scope = leaseScopeSql(ctx.permissions.get('rent.view')?.scope, ctx);
    let qb = this.filtered(tx, query).where(scope);
    if (query.cursor) qb = qb.where(keysetCondition(column, 'c.id', query.sort, query.cursor));
    const rows = await chargeColumns(qb)
      .select(sortValueSql(column, 'text').as('cursorValue'))
      .orderBy('c.dueDate', query.sort.direction)
      .orderBy('c.id', query.sort.direction)
      .limit(query.limit + 1)
      .execute();
    const minor = await minorUnits(tx, rows.map((row) => row.currencyCode));
    const page = toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => toCharge(row, minor));

    // Totals over every matching charge, set-based (one pass over the charges, one over their allocations and adjustments).
    const matching = this.filtered(tx, query).where(scope).select(['c.id', 'c.currencyCode', 'c.totalAmount', 'c.status']);
    const { rows: totalRows } = await sql<{ currencyCode: string; count: string; total: string; outstanding: string }>`
      with f as (${matching}),
        base as (select currency_code, count(*) as n, sum(total_amount) as total, coalesce(sum(total_amount) filter (where status = 'posted'), 0) as posted
                   from f group by currency_code),
        paid as (select f.currency_code, sum(a.amount) as amount from f join payment_allocations a on a.rent_charge_id = f.id
                  where f.status = 'posted' group by f.currency_code),
        adjusted as (select f.currency_code, sum(j.amount) as amount from f join rent_charge_adjustments j on j.rent_charge_id = f.id
                      where f.status = 'posted' group by f.currency_code)
      select b.currency_code as "currencyCode", b.n::text as count, b.total::text as total,
             (b.posted + coalesce(j.amount, 0) - coalesce(p.amount, 0))::text as outstanding
        from base b left join paid p on p.currency_code = b.currency_code left join adjusted j on j.currency_code = b.currency_code
       order by b.currency_code`.execute(tx);
    const totalMinor = await minorUnits(tx, totalRows.map((row) => row.currencyCode));
    const totals = totalRows.map((row) => {
      const units = totalMinor.get(row.currencyCode) ?? 2;
      return { currency: row.currencyCode, count: Number(row.count), total: toMoney(row.total, row.currencyCode, units), outstanding: toSignedMoney(row.outstanding, row.currencyCode, units) };
    });
    return { ...page, totals, dueDateWindow };
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<RentChargeDto> {
    const row = await chargeColumns(chargeQuery(tx)).where('c.id', '=', id).executeTakeFirst();
    if (!row) throw Problems.notFound();
    const access = await leaseAccess(tx, row.leaseId);
    if (!access || !canOnLease(ctx, 'rent.view', access)) throw Problems.notFound();
    return toCharge(row, await minorUnits(tx, [row.currencyCode]));
  }

  /** The lease ledger as of a date (RL-1): every entry in date order with the running balance, and the ageing. */
  async ledger(tx: Tx, ctx: TenantContext, leaseId: string, asOfInput: string | undefined): Promise<LedgerDto> {
    const lease = await this.leaseFor(tx, ctx, leaseId, 'rent.view');
    const asOf = asOfInput ?? todayIn(lease.timezone);
    if (!isRealDate(asOf)) throw Problems.validation([{ field: 'asOf', code: 'invalid', message: 'Use a real date such as 2026-11-28.' }]);
    const minor = (await minorUnits(tx, [lease.currencyCode])).get(lease.currencyCode) ?? 2;
    const money = (value: string) => toSignedMoney(value, lease.currencyCode, minor);
    const showPayer = ctx.permissions.has('contact.view');

    const { rows } = await sql<{
      date: string;
      kind: 'charge' | 'payment' | 'reversal' | 'adjustment';
      sortKey: string;
      description: string;
      amount: string;
      chargeStatus: string | null;
      rentChargeId: string | null;
      paymentId: string | null;
      paymentReference: string | null;
      payerName: string | null;
      adjustmentId: string | null;
      approvedByName: string | null;
    }>`
      select c.due_date::text as date, 'charge' as kind, '1' || coalesce(c.period_start::text, '') || to_char(c.created_at, 'YYYYMMDDHH24MISSUS') || c.id::text as "sortKey", c.description, c.total_amount::text as amount, c.status as "chargeStatus",
             c.id as "rentChargeId", null::uuid as "paymentId", null as "paymentReference", null as "payerName", null::uuid as "adjustmentId", null as "approvedByName"
        from rent_charges c
       where c.lease_id = ${leaseId}::uuid and c.status <> 'scheduled' and c.due_date <= ${asOf}::date
      union all
      select a.allocated_on::text, case when a.reversal_of_id is null then 'payment' else 'reversal' end, '2' || to_char(a.created_at, 'YYYYMMDDHH24MISSUS') || a.id::text,
             case when a.reversal_of_id is null then 'Receipt ' || p.reference else 'Reversed: receipt ' || p.reference || coalesce(' (' || p.status || ')', '') end
               || ' · ' || rc.description,
             a.amount::text, null, a.rent_charge_id, p.id, p.reference, pc.display_name, null, null
        from payment_allocations a
        join rent_charges rc on rc.id = a.rent_charge_id
        join payments p on p.id = a.payment_id
        left join contacts pc on pc.id = p.payer_contact_id
       where rc.lease_id = ${leaseId}::uuid and a.allocated_on <= ${asOf}::date
      union all
      select j.adjusted_on::text, 'adjustment', '3' || lpad(j.entry_no::text, 20, '0'), 'Adjustment: ' || rc.description || ' · ' || j.reason, j.amount::text, null,
             j.rent_charge_id, null, null, null, j.id, u.display_name
        from rent_charge_adjustments j
        join rent_charges rc on rc.id = j.rent_charge_id
        join company_memberships m on m.id = j.approved_by
        join users u on u.id = m.user_id
       where rc.lease_id = ${leaseId}::uuid and j.adjusted_on <= ${asOf}::date
       order by 1, 3`.execute(tx);

    let balance = 0n;
    const entries: LedgerEntryDto[] = rows.map((row) => {
      const counted = row.kind !== 'charge' || row.chargeStatus === 'posted';
      const value = scaled(row.amount);
      if (row.kind === 'charge' && counted) balance += value;
      if (row.kind === 'payment' || row.kind === 'reversal') balance -= value;
      if (row.kind === 'adjustment') balance += value;
      return {
        date: row.date,
        kind: row.kind,
        description: row.description,
        charge: row.kind === 'charge' ? money(row.amount) : null,
        paid: row.kind === 'payment' || row.kind === 'reversal' ? money(row.amount) : null,
        adjustment: row.kind === 'adjustment' ? money(row.amount) : null,
        balance: money(unscaled(balance)),
        counted,
        chargeStatus: row.chargeStatus,
        rentChargeId: row.rentChargeId,
        paymentId: row.paymentId,
        paymentReference: row.paymentReference,
        payerName: showPayer ? row.payerName : null,
        adjustmentId: row.adjustmentId,
        approvedByName: row.approvedByName,
      };
    });

    const { rows: aged } = await sql<{ days: number; outstanding: string }>`
      select ${asOf}::date - c.due_date as days,
             (c.total_amount
               + coalesce((select sum(j.amount) from rent_charge_adjustments j where j.rent_charge_id = c.id and j.adjusted_on <= ${asOf}::date), 0)
               - coalesce((select sum(a.amount) from payment_allocations a where a.rent_charge_id = c.id and a.allocated_on <= ${asOf}::date), 0))::text as outstanding
        from rent_charges c
       where c.lease_id = ${leaseId}::uuid and c.status = 'posted' and c.due_date <= ${asOf}::date`.execute(tx);
    const buckets = { current: 0n, d30: 0n, d60: 0n, d90: 0n, over: 0n };
    for (const row of aged) {
      const value = scaled(row.outstanding);
      if (value <= 0n) continue;
      const days = Number(row.days);
      if (days <= 0) buckets.current += value;
      else if (days <= 30) buckets.d30 += value;
      else if (days <= 60) buckets.d60 += value;
      else if (days <= 90) buckets.d90 += value;
      else buckets.over += value;
    }
    const ageing: AgeingDto = {
      outstanding: money(unscaled(buckets.current + buckets.d30 + buckets.d60 + buckets.d90 + buckets.over)),
      current: money(unscaled(buckets.current)),
      days1To30: money(unscaled(buckets.d30)),
      days31To60: money(unscaled(buckets.d60)),
      days61To90: money(unscaled(buckets.d90)),
      daysOver90: money(unscaled(buckets.over)),
    };

    const upcomingRows = await chargeColumns(chargeQuery(tx))
      .where('c.leaseId', '=', leaseId)
      .where('c.status', 'in', ['posted', 'scheduled'])
      .where('c.dueDate', '>', asOf)
      .orderBy('c.dueDate')
      .orderBy('c.id')
      .execute();
    const upcomingMinor = new Map([[lease.currencyCode, minor]]);
    return {
      lease: { id: leaseId, name: lease.reference },
      currency: lease.currencyCode,
      asOf,
      entries,
      ageing,
      upcoming: upcomingRows.map((row) => toCharge(row, upcomingMinor)),
    };
  }

  // ----------------------------------------------------------------- writing

  /** RC-2: a charge the schedule does not create, posted now or on its due date. */
  async create(tx: Tx, ctx: TenantContext, leaseId: string, body: CreateChargeBody): Promise<RentChargeDto> {
    const lease = await this.leaseFor(tx, ctx, leaseId, 'rent.manage', true);
    if (!CHARGEABLE.includes(lease.status)) throw Problems.businessRule('Charges are added to an active, periodic, notice-given or ended lease.');
    await this.assertCollects(tx, lease);
    const today = todayIn(lease.timezone);
    const errors: FieldError[] = [];
    await checkCurrencyAmount(tx, body.amount, lease.currencyCode, 'amount', errors, true);
    for (const field of ['dueDate', 'periodStart', 'periodEnd'] as const) {
      const value = body[field];
      if (value && !isRealDate(value)) errors.push({ field, code: 'invalid', message: 'Use a real date such as 2026-12-01.' });
    }
    if (body.periodStart && body.periodEnd && body.periodEnd < body.periodStart) errors.push({ field: 'periodEnd', code: 'before-start', message: 'The period ends on or after it starts.' });
    if (Boolean(body.periodStart) !== Boolean(body.periodEnd)) errors.push({ field: body.periodStart ? 'periodEnd' : 'periodStart', code: 'required', message: 'Give both ends of the period, or neither.' });
    if (body.when === 'schedule' && isRealDate(body.dueDate) && body.dueDate <= today) {
      errors.push({ field: 'dueDate', code: 'not-future', message: 'A scheduled charge is due after today. Post it now instead.' });
    }
    if (isRealDate(body.dueDate) && (await periodLocked(tx, body.dueDate))) errors.push({ field: 'dueDate', code: 'period-locked', message: 'This date is in a locked financial period.' });
    if (body.taxCodeId) {
      const code = await tx.selectFrom('taxCodes').select(['jurisdictionCode', 'isActive']).where('id', '=', body.taxCodeId).executeTakeFirst();
      if (!code || !code.isActive) errors.push({ field: 'taxCodeId', code: 'unknown', message: 'Choose an active tax code.' });
      else if (code.jurisdictionCode !== lease.jurisdictionCode) errors.push({ field: 'taxCodeId', code: 'jurisdiction', message: 'Choose a tax code of the lease\'s jurisdiction.' });
    }
    if (body.periodStart && errors.length === 0) {
      const clash = await tx
        .selectFrom('rentCharges')
        .select('id')
        .where('leaseId', '=', leaseId)
        .where('chargeType', '=', body.chargeType)
        .where('periodStart', '=', body.periodStart)
        .where('status', 'in', ['scheduled', 'posted'])
        .executeTakeFirst();
      if (clash) errors.push({ field: 'periodStart', code: 'duplicate', message: 'A charge of this type already exists for this period.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);

    const minor = (await minorUnits(tx, [lease.currencyCode])).get(lease.currencyCode) ?? 2;
    const tax = body.taxCodeId
      ? (await sql<{ tax: string }>`select app.tax_amount(${body.taxCodeId}::uuid, ${body.amount.amount}::numeric, ${body.dueDate}::date, ${minor}::integer)::text as tax`.execute(tx)).rows[0]!.tax
      : '0';
    const status = body.when === 'post' ? 'posted' : 'scheduled';
    const inserted = await tx
      .insertInto('rentCharges')
      .values({
        companyId: ctx.companyId,
        leaseId,
        chargeType: body.chargeType,
        description: body.description.trim(),
        periodStart: body.periodStart ?? null,
        periodEnd: body.periodEnd ?? null,
        dueDate: body.dueDate,
        currencyCode: lease.currencyCode,
        amount: body.amount.amount,
        taxCodeId: body.taxCodeId ?? null,
        taxAmount: tax,
        status,
        source: 'manual',
        createdBy: actingMembership(ctx),
      })
      .returning(['id', 'totalAmount'])
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'rent_charge.created',
      entityType: 'rent_charge',
      entityId: inserted.id,
      metadata: { leaseId, chargeType: body.chargeType, status, dueDate: body.dueDate, amount: body.amount.amount, taxAmount: tax, currency: lease.currencyCode },
    });
    if (status === 'posted') {
      await this.audit.emit(tx, ctx, {
        eventType: 'rent_charge.posted',
        aggregateType: 'rent_charge',
        aggregateId: inserted.id,
        payload: { rentChargeId: inserted.id, leaseId, chargeType: body.chargeType, dueDate: body.dueDate, amount: body.amount.amount, taxAmount: tax, currency: lease.currencyCode },
      });
    }
    return this.get(tx, ctx, inserted.id);
  }

  /** RC-4: a posted charge with nothing allocated is waived, with the reason. */
  async waive(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<RentChargeDto> {
    const charge = await this.lockCharge(tx, ctx, id, expectedVersion);
    if (charge.status !== 'posted') throw Problems.businessRule('Only a posted charge can be waived.');
    await this.assertUnallocated(tx, charge);
    if (await periodLocked(tx, charge.dueDate)) throw Problems.businessRule('This charge is in a locked financial period and cannot be waived.');
    await tx.updateTable('rentCharges').set({ status: 'waived', waivedReason: reason.trim() }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'rent_charge.waived', entityType: 'rent_charge', entityId: id, changes: { status: { old: 'posted', new: 'waived' } }, metadata: { leaseId: charge.leaseId } });
    await this.audit.emit(tx, ctx, { eventType: 'rent_charge.waived', aggregateType: 'rent_charge', aggregateId: id, payload: { rentChargeId: id, leaseId: charge.leaseId } });
    return this.get(tx, ctx, id);
  }

  /** RC-4: a scheduled charge, or a posted one with nothing allocated, is cancelled. */
  async cancel(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<RentChargeDto> {
    const charge = await this.lockCharge(tx, ctx, id, expectedVersion);
    if (charge.status !== 'posted' && charge.status !== 'scheduled') throw Problems.businessRule(`A ${charge.status} charge cannot be cancelled.`);
    if (charge.status === 'posted') await this.assertUnallocated(tx, charge);
    if (await periodLocked(tx, charge.dueDate)) throw Problems.businessRule('This charge is in a locked financial period and cannot be cancelled.');
    await tx.updateTable('rentCharges').set({ status: 'cancelled' }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'rent_charge.cancelled', entityType: 'rent_charge', entityId: id, changes: { status: { old: charge.status, new: 'cancelled' } }, metadata: { leaseId: charge.leaseId } });
    await this.audit.emit(tx, ctx, { eventType: 'rent_charge.cancelled', aggregateType: 'rent_charge', aggregateId: id, payload: { rentChargeId: id, leaseId: charge.leaseId } });
    return this.get(tx, ctx, id);
  }

  /** RC-3, server-side preview: what the charge would owe after the adjustment. Nothing is saved. */
  async previewAdjustment(tx: Tx, ctx: TenantContext, id: string, body: AdjustmentBody): Promise<AdjustmentPreviewDto> {
    const { charge, signed } = await this.checkAdjustment(tx, ctx, id, body, false);
    const before = await chargeBalance(tx, id);
    const after = { ...before, adjusted: unscaled(scaled(before.adjusted) + signed) };
    const minor = (await minorUnits(tx, [charge.currencyCode])).get(charge.currencyCode) ?? 2;
    return { before: balanceDto(before, 'posted', charge.currencyCode, minor), after: balanceDto(after, 'posted', charge.currencyCode, minor) };
  }

  /** RC-3: corrects a posted charge without editing it (#1): append-only, approved, in an open period. */
  async adjust(tx: Tx, ctx: TenantContext, id: string, body: AdjustmentBody): Promise<AdjustmentResultDto> {
    const { charge, signed } = await this.checkAdjustment(tx, ctx, id, body, true);
    const inserted = await tx
      .insertInto('rentChargeAdjustments')
      .values({
        companyId: ctx.companyId,
        rentChargeId: id,
        amount: unscaled(signed),
        reason: body.reason.trim(),
        adjustedOn: body.adjustedOn,
        approvedBy: body.approvedBy,
        createdBy: actingMembership(ctx),
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'rent_charge.adjusted',
      entityType: 'rent_charge',
      entityId: id,
      metadata: { adjustmentId: inserted.id, leaseId: charge.leaseId, amount: unscaled(signed), currency: charge.currencyCode, adjustedOn: body.adjustedOn, approvedBy: body.approvedBy },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'rent_charge.adjusted',
      aggregateType: 'rent_charge',
      aggregateId: id,
      payload: { rentChargeId: id, adjustmentId: inserted.id, leaseId: charge.leaseId, amount: unscaled(signed), currency: charge.currencyCode },
    });
    const adjustment = await adjustmentDto(tx, inserted.id);
    return { adjustment, charge: await this.get(tx, ctx, id) };
  }

  /**
   * Starts the rent schedule of an imported live lease from a date (fixed once
   * set; activation sets it for leases activated here), and posts what is
   * already due when the company has a lead time.
   */
  async startSchedule(tx: Tx, ctx: TenantContext, leaseId: string, expectedVersion: number, from: string): Promise<{ posted: number }> {
    const lease = await this.leaseFor(tx, ctx, leaseId, 'rent.manage', true);
    if (lease.version !== expectedVersion) throw Problems.preconditionFailed();
    if (!LIVE.includes(lease.status)) throw Problems.businessRule('Rent is scheduled for an active, periodic or notice-given lease.');
    if (lease.rentScheduleFrom) throw Problems.businessRule(`The rent schedule of this lease already starts on ${lease.rentScheduleFrom}.`);
    const errors: FieldError[] = [];
    if (!isRealDate(from)) errors.push({ field: 'from', code: 'invalid', message: 'Use a real date such as 2026-12-01.' });
    else if (from < lease.startDate) errors.push({ field: 'from', code: 'before-start', message: `The lease starts on ${lease.startDate}.` });
    else if (lease.endDate && lease.status !== 'periodic' && from > lease.endDate) errors.push({ field: 'from', code: 'after-end', message: `The lease ends on ${lease.endDate}.` });
    if (errors.length > 0) throw Problems.validation(errors);
    await this.assertCollects(tx, lease);
    await tx.updateTable('leases').set({ rentScheduleFrom: from }).where('id', '=', leaseId).execute();
    await this.audit.record(tx, ctx, { action: 'lease.rent_schedule_started', entityType: 'lease', entityId: leaseId, changes: { rentScheduleFrom: { old: null, new: from } } });
    const lead = await chargeLeadDays(tx);
    const posted = lead === null ? 0 : await postLeaseRent(tx, ctx, this.audit, leaseId, addDays(todayIn(lease.timezone), lead));
    return { posted };
  }

  // ----------------------------------------------------------------- helpers

  private filtered(tx: Tx, query: ParsedListQuery<ChargeSortField>) {
    const f = query.filters;
    let qb = chargeQuery(tx);
    qb = qb.where('c.status', 'in', Array.isArray(f['status']) ? f['status'] : ['posted']);
    for (const [filter, col] of [
      ['chargeType', 'c.chargeType'],
      ['currency', 'c.currencyCode'],
      ['leaseId', 'c.leaseId'],
      ['propertyId', 'u.propertyId'],
      ['officeId', 'p.officeId'],
    ] as const) {
      const values = f[filter];
      if (Array.isArray(values)) qb = qb.where(col, 'in', values);
    }
    const due = f['dueDate'] as RangeValue | undefined;
    if (due?.gte) qb = qb.where('c.dueDate', '>=', due.gte);
    if (due?.lte) qb = qb.where('c.dueDate', '<=', due.lte);
    return qb;
  }

  private async leaseFor(tx: Tx, ctx: TenantContext, leaseId: string, permission: 'rent.view' | 'rent.manage', lock = false) {
    const access = await leaseAccess(tx, leaseId);
    if (!access || !canOnLease(ctx, 'rent.view', access)) throw Problems.notFound();
    if (permission === 'rent.manage' && !canOnLease(ctx, 'rent.manage', access)) throw Problems.forbidden('Your role does not allow changes to the rent of this lease.');
    let qb = tx
      .selectFrom('leases as l')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .select([
        'l.id', 'l.reference', 'l.status', 'l.currencyCode', 'l.jurisdictionCode', 'l.managementAgreementId', 'l.startDate', 'l.endDate',
        'l.rentScheduleFrom', 'l.version', 'p.timezone', 'p.officeId',
      ])
      .where('l.id', '=', leaseId);
    if (lock) qb = qb.forUpdate('l');
    return { ...(await qb.executeTakeFirstOrThrow()), access };
  }

  /** Readiness §5.1: the agency raises charges only where it collects the rent. */
  private async assertCollects(tx: Tx, lease: { managementAgreementId: string | null }): Promise<void> {
    if (!lease.managementAgreementId) return;
    const agreement = await tx.selectFrom('managementAgreements').select(['reference', 'status', 'serviceLevel']).where('id', '=', lease.managementAgreementId).executeTakeFirstOrThrow();
    if (agreement.serviceLevel === 'let_only') throw Problems.businessRule(`Management agreement ${agreement.reference} is let only: the agency does not collect this lease's rent.`);
    if (agreement.status === 'draft' || agreement.status === 'suspended') throw Problems.businessRule(`Management agreement ${agreement.reference} is ${agreement.status}: no charges are raised under it.`);
  }

  private async lockCharge(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number) {
    const charge = await tx.selectFrom('rentCharges').select(['id', 'leaseId', 'status', 'dueDate', 'currencyCode', 'version']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!charge) throw Problems.notFound();
    const access = await leaseAccess(tx, charge.leaseId);
    if (!access || !canOnLease(ctx, 'rent.view', access)) throw Problems.notFound();
    if (!canOnLease(ctx, 'rent.manage', access)) throw Problems.forbidden('Your role does not allow changes to the rent of this lease.');
    if (charge.version !== expectedVersion) throw Problems.preconditionFailed();
    return charge;
  }

  private async assertUnallocated(tx: Tx, charge: { id: string }): Promise<void> {
    const balance = await chargeBalance(tx, charge.id);
    if (scaled(balance.paid) !== 0n) throw Problems.businessRule('Money is allocated to this charge. Reverse the allocations first.');
  }

  private async checkAdjustment(tx: Tx, ctx: TenantContext, id: string, body: AdjustmentBody, lock: boolean) {
    let qb = tx.selectFrom('rentCharges').select(['id', 'leaseId', 'status', 'currencyCode']).where('id', '=', id);
    if (lock) qb = qb.forUpdate();
    const charge = await qb.executeTakeFirst();
    if (!charge) throw Problems.notFound();
    const lease = await this.leaseFor(tx, ctx, charge.leaseId, 'rent.manage');
    if (charge.status !== 'posted') throw Problems.businessRule(`Only a posted charge is adjusted; this one is ${charge.status}.`);
    const errors: FieldError[] = [];
    await checkCurrencyAmount(tx, body.amount, charge.currencyCode, 'amount', errors, true);
    if (!isRealDate(body.adjustedOn)) errors.push({ field: 'adjustedOn', code: 'invalid', message: 'Use a real date such as 2026-11-28.' });
    else if (body.adjustedOn > todayIn(lease.timezone)) errors.push({ field: 'adjustedOn', code: 'future', message: 'An adjustment is dated today or earlier.' });
    else if (await periodLocked(tx, body.adjustedOn)) errors.push({ field: 'adjustedOn', code: 'period-locked', message: 'This date is in a locked financial period.' });
    const grant = await memberGrant(tx, body.approvedBy, 'rent.manage');
    const covers = grant !== null && grant.scope !== null && leaseWithin(grant.scope, { ...ctx, membershipId: grant.membershipId, officeIds: grant.officeIds }, lease.access);
    if (!covers) errors.push({ field: 'approvedBy', code: 'not-allowed', message: 'Choose a member who may manage this lease\'s rent.' });
    if (errors.length > 0) throw Problems.validation(errors);
    const signed = (body.direction === 'credit' ? -1n : 1n) * scaled(body.amount.amount);
    const balance = await chargeBalance(tx, id);
    const owed = scaled(balance.total) + scaled(balance.adjusted) + signed;
    if (owed < 0n) throw Problems.validation([{ field: 'amount', code: 'below-zero', message: 'The credit is more than the charge owes.' }]);
    if (owed < scaled(balance.paid)) throw Problems.validation([{ field: 'amount', code: 'below-paid', message: 'The charge would owe less than has been paid. Reverse an allocation first.' }]);
    return { charge, signed };
  }
}

// ------------------------------------------------------------------- queries

const paidSql = sql<string>`coalesce((select sum(a.amount) from payment_allocations a where a.company_id = c.company_id and a.rent_charge_id = c.id), 0)`;
const adjustedSql = sql<string>`coalesce((select sum(j.amount) from rent_charge_adjustments j where j.company_id = c.company_id and j.rent_charge_id = c.id), 0)`;

function chargeQuery(tx: Tx) {
  return tx
    .selectFrom('rentCharges as c')
    .innerJoin('leases as l', 'l.id', 'c.leaseId')
    .innerJoin('units as u', 'u.id', 'l.unitId')
    .innerJoin('properties as p', 'p.id', 'u.propertyId');
}

function chargeColumns<QB extends ReturnType<typeof chargeQuery>>(qb: QB) {
  return qb
    .leftJoin('leaseParties as pt', (join) => join.onRef('pt.leaseId', '=', 'l.id').on('pt.isPrimary', '=', true).on('pt.partyRole', 'in', TENANT_ROLES))
    .leftJoin('contacts as tc', 'tc.id', 'pt.contactId')
    .select([
      'c.id', 'c.leaseId', 'l.reference as leaseReference', 'pt.contactId as tenantId', 'tc.displayName as tenantName', 'c.chargeType', 'c.description',
      'c.periodStart', 'c.periodEnd', 'c.dueDate', 'c.currencyCode', 'c.amount', 'c.taxAmount', 'c.taxCodeId', 'c.totalAmount', 'c.status', 'c.waivedReason',
      'c.source', 'c.postedAt', 'c.createdAt', 'c.version',
      sql<string>`${paidSql}::text`.as('paid'),
      sql<string>`${adjustedSql}::text`.as('adjusted'),
    ]);
}

type ChargeRow = Awaited<ReturnType<ReturnType<typeof chargeColumns>['executeTakeFirstOrThrow']>>;

function toCharge(row: ChargeRow, minor: Map<string, number>): RentChargeDto {
  const units = minor.get(row.currencyCode) ?? 2;
  return {
    id: row.id,
    lease: { id: row.leaseId, name: row.leaseReference },
    tenant: row.tenantId ? { id: row.tenantId, name: row.tenantName ?? '' } : null,
    chargeType: row.chargeType,
    description: row.description,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    dueDate: row.dueDate,
    amount: toMoney(row.amount, row.currencyCode, units),
    tax: toMoney(row.taxAmount, row.currencyCode, units),
    taxCodeId: row.taxCodeId,
    balance: balanceDto({ total: row.totalAmount ?? '0', adjusted: row.adjusted, paid: row.paid }, row.status, row.currencyCode, units),
    status: row.status,
    waivedReason: row.waivedReason,
    source: row.source,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

function balanceDto(balance: Balance, status: string, currency: string, minor: number): ChargeBalanceDto {
  const outstanding = status === 'posted' ? scaled(balance.total) + scaled(balance.adjusted) - scaled(balance.paid) : 0n;
  return {
    total: toSignedMoney(balance.total, currency, minor),
    adjustments: toSignedMoney(balance.adjusted, currency, minor),
    paid: toSignedMoney(balance.paid, currency, minor),
    outstanding: toSignedMoney(unscaled(outstanding), currency, minor),
  };
}

async function chargeBalance(tx: Tx, id: string): Promise<Balance> {
  const row = await tx
    .selectFrom('rentCharges as c')
    .select([sql<string>`c.total_amount::text`.as('total'), sql<string>`${adjustedSql}::text`.as('adjusted'), sql<string>`${paidSql}::text`.as('paid')])
    .where('c.id', '=', id)
    .executeTakeFirstOrThrow();
  return row;
}

async function adjustmentDto(tx: Tx, id: string): Promise<AdjustmentDto> {
  const row = await tx
    .selectFrom('rentChargeAdjustments as j')
    .innerJoin('rentCharges as c', 'c.id', 'j.rentChargeId')
    .innerJoin('companyMemberships as m', 'm.id', 'j.approvedBy')
    .innerJoin('users as u', 'u.id', 'm.userId')
    .select(['j.id', 'j.rentChargeId', sql<string>`j.amount::text`.as('amount'), 'j.adjustedOn', 'j.reason', 'j.approvedBy', 'u.displayName', 'j.createdAt', 'c.currencyCode'])
    .where('j.id', '=', id)
    .executeTakeFirstOrThrow();
  const minor = (await minorUnits(tx, [row.currencyCode])).get(row.currencyCode) ?? 2;
  return {
    id: row.id,
    rentChargeId: row.rentChargeId,
    amount: toSignedMoney(row.amount, row.currencyCode, minor),
    adjustedOn: row.adjustedOn,
    reason: row.reason,
    approvedBy: { id: row.approvedBy, name: row.displayName },
    createdAt: row.createdAt.toISOString(),
  };
}

async function periodLocked(tx: Tx, date: string): Promise<boolean> {
  const row = await tx.selectFrom('financialPeriods').select('id').where('status', '=', 'locked').where('periodStart', '<=', date).where('periodEnd', '>=', date).executeTakeFirst();
  return row !== undefined;
}

async function minorUnits(tx: Tx, codes: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const rows = await tx.selectFrom('currencies').select(['code', 'minorUnits']).where('code', 'in', unique).execute();
  return new Map(rows.map((row) => [row.code, row.minorUnits]));
}

function lastDayOfMonth(month: string): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
