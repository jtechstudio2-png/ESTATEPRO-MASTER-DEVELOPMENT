import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { todayIn } from '../common/dates.js';
import { encodeCursor, type ParsedListQuery } from '../common/list-query.js';
import { toMoney, toSignedMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import { actingMembership, type TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { isRealDate } from './agreements.service.js';
import { canOnLease, leaseAccess, leaseScopeSql } from './lettings-access.js';
import type {
  ArrearsActionBody,
  ArrearsActionDto,
  ArrearsPageDto,
  ArrearsRowDto,
  ArrearsStepDto,
  ArrearsStepInput,
  ClosePlanBody,
  LeaseArrearsDto,
  PaymentPlanBody,
  PaymentPlanDto,
} from './receipts.dto.js';
import { checkAmount, companyTimezone, minorUnits } from './receipts.service.js';
import { scaled, unscaled } from './rent-math.js';

registerConstraintMessages({
  payment_plans_one_active_idx: 'This lease has an active payment plan already. Close it before agreeing another.',
});

/** Company setting (P7-D10, ST-2): the arrears steps, each after a number of days past the oldest unpaid due date. */
export const ARREARS_STEPS_KEY = 'lettings.arrears_steps';
export const MAX_ARREARS_STEPS = 10;
export type ArrearsSortField = 'oldestDueDate';

const PLAN_LEASES = ['active', 'periodic', 'notice_given', 'ended'];

interface ArrearsAggregate {
  leaseId: string;
  currencyCode: string;
  outstanding: string;
  d30: string;
  d60: string;
  d90: string;
  over: string;
  oldestDue: string;
  days: number;
}

/**
 * Arrears (LET-05; wireframes AR-1, AR-2; readiness §5.4; P7-D10): balance
 * and ageing per lease as of a date, the company's own steps (no legal
 * thresholds, P7-D3), the actions taken and payment plans. Amounts per
 * currency, never summed across currencies. Reading needs rent.view; acting,
 * arrears.manage, on the lease.
 */
@Injectable()
export class ArrearsService {
  constructor(private readonly audit: AuditService) {}

  async list(tx: Tx, ctx: TenantContext, query: ParsedListQuery<ArrearsSortField>, asOfInput: string | undefined): Promise<ArrearsPageDto> {
    const asOf = asOfInput ?? todayIn(await companyTimezone(tx, ctx));
    if (!isRealDate(asOf)) throw Problems.validation([{ field: 'asOf', code: 'invalid', message: 'Use a real date such as 2026-11-28.' }]);
    const f = query.filters;
    let rows = await arrearsAsOf(tx, ctx, asOf, {
      officeIds: Array.isArray(f['officeId']) ? f['officeId'] : null,
      leaseIds: Array.isArray(f['leaseId']) ? f['leaseId'] : null,
      currencies: Array.isArray(f['currency']) ? f['currency'] : null,
    });
    const bucket = Array.isArray(f['bucket']) ? f['bucket'] : null;
    if (bucket) rows = rows.filter((row) => bucket.includes(bucketOf(row.days)));
    const details = rows.length === 0 ? new Map<string, Detail>() : await detailsFor(tx, rows.map((row) => row.leaseId));
    if (f['nextActionDue'] === true) rows = rows.filter((row) => { const next = details.get(row.leaseId)?.nextActionDate; return next !== null && next !== undefined && next <= asOf; });

    const minor = await minorUnits(tx, rows.map((row) => row.currencyCode));
    const totals = new Map<string, { leases: number; outstanding: bigint }>();
    for (const row of rows) {
      const total = totals.get(row.currencyCode) ?? { leases: 0, outstanding: 0n };
      total.leases += 1;
      total.outstanding += scaled(row.outstanding);
      totals.set(row.currencyCode, total);
    }
    const direction = query.sort.direction === 'desc' ? -1 : 1;
    rows.sort((a, b) => direction * (a.oldestDue < b.oldestDue ? -1 : a.oldestDue > b.oldestDue ? 1 : a.leaseId < b.leaseId ? -1 : a.leaseId > b.leaseId ? 1 : 0));
    if (query.cursor) {
      const { v, id } = query.cursor;
      rows = rows.filter((row) => direction * (row.oldestDue < v ? -1 : row.oldestDue > v ? 1 : row.leaseId < id ? -1 : row.leaseId > id ? 1 : 0) > 0);
    }
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      asOf,
      data: page.map((row) => toRow(row, details.get(row.leaseId)!, minor.get(row.currencyCode) ?? 2)),
      page: { limit: query.limit, nextCursor: rows.length > query.limit && last ? encodeCursor(last.oldestDue, last.leaseId) : null },
      totals: [...totals.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([currency, total]) => ({ currency, leases: total.leases, outstanding: toMoney(unscaled(total.outstanding), currency, minor.get(currency) ?? 2) })),
    };
  }

  /** AR-2: one lease's arrears as of a date, its step, actions and plans. */
  async forLease(tx: Tx, ctx: TenantContext, leaseId: string, asOfInput: string | undefined): Promise<LeaseArrearsDto> {
    const lease = await this.lease(tx, ctx, leaseId, false);
    const asOf = asOfInput ?? todayIn(lease.timezone);
    if (!isRealDate(asOf)) throw Problems.validation([{ field: 'asOf', code: 'invalid', message: 'Use a real date such as 2026-11-28.' }]);
    const [row] = await arrearsAsOf(tx, ctx, asOf, { officeIds: null, leaseIds: [leaseId], currencies: null, unscoped: true });
    const minor = (await minorUnits(tx, [lease.currencyCode])).get(lease.currencyCode) ?? 2;
    const steps = await arrearsSteps(tx);
    const days = row?.days ?? 0;
    const reached = steps.filter((step) => step.afterDays <= days);
    const actions = await tx
      .selectFrom('arrearsActions as a')
      .leftJoin('companyMemberships as m', 'm.id', 'a.performedBy')
      .leftJoin('users as u', 'u.id', 'm.userId')
      .select(['a.id', 'a.actionCode', 'a.actionDate', sql<string | null>`a.arrears_amount::text`.as('arrears'), 'a.notes', 'a.nextActionDate', 'a.performedBy', 'u.displayName', 'a.source', 'a.createdAt'])
      .where('a.leaseId', '=', leaseId)
      .orderBy('a.actionDate', 'desc')
      .orderBy('a.createdAt', 'desc')
      .execute();
    return {
      lease: { id: leaseId, name: lease.reference },
      asOf,
      currency: lease.currencyCode,
      outstanding: toMoney(row?.outstanding ?? '0', lease.currencyCode, minor),
      oldestDueDate: row?.oldestDue ?? null,
      daysPastDue: days,
      steps,
      currentStep: reached.length > 0 ? reached[reached.length - 1]! : null,
      actions: actions.map((action): ArrearsActionDto => ({
        id: action.id,
        actionCode: action.actionCode,
        actionDate: action.actionDate,
        arrears: action.arrears === null ? null : toMoney(action.arrears, lease.currencyCode, minor),
        notes: action.notes,
        nextActionDate: action.nextActionDate,
        performedBy: action.performedBy ? { id: action.performedBy, name: action.displayName ?? '' } : null,
        source: action.source,
        createdAt: action.createdAt.toISOString(),
      })),
      plans: await this.plans(tx, leaseId, lease.currencyCode, minor, todayIn(lease.timezone)),
    };
  }

  async recordAction(tx: Tx, ctx: TenantContext, leaseId: string, body: ArrearsActionBody): Promise<LeaseArrearsDto> {
    const lease = await this.lease(tx, ctx, leaseId, true);
    const errors: FieldError[] = [];
    const code = await checkPicklistCode(tx, 'arrears_action', body.actionCode, lease.countryCode, 'actionCode');
    if (code) errors.push(code);
    const today = todayIn(lease.timezone);
    if (!isRealDate(body.actionDate)) errors.push({ field: 'actionDate', code: 'invalid', message: 'Use a real date such as 2026-11-28.' });
    else if (body.actionDate > today) errors.push({ field: 'actionDate', code: 'future', message: 'Record an action once it is taken.' });
    if (body.nextActionDate && (!isRealDate(body.nextActionDate) || (isRealDate(body.actionDate) && body.nextActionDate < body.actionDate))) {
      errors.push({ field: 'nextActionDate', code: 'invalid', message: 'The next action is on or after this one.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    const [row] = await arrearsAsOf(tx, ctx, today, { officeIds: null, leaseIds: [leaseId], currencies: null, unscoped: true });
    const inserted = await tx
      .insertInto('arrearsActions')
      .values({
        companyId: ctx.companyId,
        leaseId,
        actionCode: body.actionCode,
        actionDate: body.actionDate,
        arrearsAmount: row?.outstanding ?? '0',
        notes: body.notes?.trim() || null,
        nextActionDate: body.nextActionDate ?? null,
        performedBy: actingMembership(ctx),
        source: 'manual',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, { action: 'arrears.action_recorded', entityType: 'lease', entityId: leaseId, metadata: { arrearsActionId: inserted.id, actionCode: body.actionCode, actionDate: body.actionDate, source: 'manual' } });
    await this.audit.emit(tx, ctx, { eventType: 'arrears.action_recorded', aggregateType: 'lease', aggregateId: leaseId, payload: { leaseId, arrearsActionId: inserted.id, actionCode: body.actionCode } });
    return this.forLease(tx, ctx, leaseId, undefined);
  }

  async createPlan(tx: Tx, ctx: TenantContext, leaseId: string, body: PaymentPlanBody): Promise<LeaseArrearsDto> {
    const lease = await this.lease(tx, ctx, leaseId, true);
    if (!PLAN_LEASES.includes(lease.status)) throw Problems.businessRule('Payment plans are agreed on an active, periodic, notice-given or ended lease.');
    const errors: FieldError[] = [];
    const today = todayIn(lease.timezone);
    if (!isRealDate(body.agreedOn)) errors.push({ field: 'agreedOn', code: 'invalid', message: 'Use a real date such as 2026-11-28.' });
    else if (body.agreedOn > today) errors.push({ field: 'agreedOn', code: 'future', message: 'Record the plan once it is agreed.' });
    let total = 0n;
    let previous = '';
    for (const [index, item] of body.instalments.entries()) {
      await checkAmount(tx, item.amount, lease.currencyCode, `instalments[${index}].amount`, errors);
      if (!isRealDate(item.dueDate) || item.dueDate < body.agreedOn || item.dueDate <= previous) {
        errors.push({ field: `instalments[${index}].dueDate`, code: 'order', message: 'Instalments are due in order, from the day the plan is agreed.' });
      }
      previous = item.dueDate;
      if (/^\d/.test(item.amount.amount)) total += scaled(item.amount.amount);
    }
    const [row] = await arrearsAsOf(tx, ctx, today, { officeIds: null, leaseIds: [leaseId], currencies: null, unscoped: true, includeDue: true });
    if (errors.length === 0 && total > scaled(row?.outstanding ?? '0')) {
      errors.push({ field: 'instalments', code: 'above-outstanding', message: 'The plan is for more than the lease owes.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    const open = await tx.selectFrom('paymentPlans').select('id').where('leaseId', '=', leaseId).where('status', '=', 'active').executeTakeFirst();
    if (open) throw Problems.conflict('This lease has an active payment plan already. Close it before agreeing another.');
    const inserted = await tx
      .insertInto('paymentPlans')
      .values({
        companyId: ctx.companyId,
        leaseId,
        currencyCode: lease.currencyCode,
        totalAmount: unscaled(total),
        instalments: JSON.stringify(body.instalments.map((item) => ({ due_date: item.dueDate, amount: item.amount.amount }))),
        agreedOn: body.agreedOn,
        createdBy: actingMembership(ctx),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('arrearsActions')
      .values({ companyId: ctx.companyId, leaseId, actionCode: 'payment_plan', actionDate: body.agreedOn, arrearsAmount: row?.outstanding ?? '0', performedBy: actingMembership(ctx), source: 'manual' })
      .execute();
    await this.audit.record(tx, ctx, { action: 'payment_plan.agreed', entityType: 'payment_plan', entityId: inserted.id, metadata: { leaseId, total: unscaled(total), currency: lease.currencyCode, instalments: body.instalments.length, agreedOn: body.agreedOn } });
    await this.audit.emit(tx, ctx, { eventType: 'payment_plan.agreed', aggregateType: 'payment_plan', aggregateId: inserted.id, payload: { paymentPlanId: inserted.id, leaseId } });
    return this.forLease(tx, ctx, leaseId, undefined);
  }

  /** Active → completed, broken or cancelled (final); a reason for broken and cancelled plans. */
  async closePlan(tx: Tx, ctx: TenantContext, leaseId: string, planId: string, expectedVersion: number, body: ClosePlanBody): Promise<LeaseArrearsDto> {
    const lease = await this.lease(tx, ctx, leaseId, true);
    const plan = await tx.selectFrom('paymentPlans').select(['id', 'status', 'agreedOn', 'version']).where('id', '=', planId).where('leaseId', '=', leaseId).forUpdate().executeTakeFirst();
    if (!plan) throw Problems.notFound();
    if (plan.version !== expectedVersion) throw Problems.preconditionFailed();
    if (plan.status !== 'active') throw Problems.businessRule(`This plan is ${plan.status}.`);
    const errors: FieldError[] = [];
    if (!isRealDate(body.closedOn) || body.closedOn < plan.agreedOn || body.closedOn > todayIn(lease.timezone)) {
      errors.push({ field: 'closedOn', code: 'out-of-range', message: `Use a date from ${plan.agreedOn} to today.` });
    }
    if (body.status !== 'completed' && !body.reason?.trim()) errors.push({ field: 'reason', code: 'required', message: 'Say why the plan ended.' });
    if (errors.length > 0) throw Problems.validation(errors);
    await tx
      .updateTable('paymentPlans')
      .set({ status: body.status, closedOn: body.closedOn, closedReason: body.reason?.trim() || null, closedBy: actingMembership(ctx) })
      .where('id', '=', planId)
      .execute();
    await this.audit.record(tx, ctx, { action: `payment_plan.${body.status}`, entityType: 'payment_plan', entityId: planId, changes: { status: { old: 'active', new: body.status } }, metadata: { leaseId, closedOn: body.closedOn } });
    await this.audit.emit(tx, ctx, { eventType: `payment_plan.${body.status}`, aggregateType: 'payment_plan', aggregateId: planId, payload: { paymentPlanId: planId, leaseId } });
    return this.forLease(tx, ctx, leaseId, undefined);
  }

  private async plans(tx: Tx, leaseId: string, currency: string, minor: number, today: string): Promise<PaymentPlanDto[]> {
    const plans = await tx
      .selectFrom('paymentPlans')
      .select(['id', 'leaseId', sql<string>`total_amount::text`.as('total'), 'instalments', 'agreedOn', 'status', 'closedOn', 'closedReason', 'version'])
      .where('leaseId', '=', leaseId)
      .orderBy('agreedOn', 'desc')
      .orderBy('createdAt', 'desc')
      .execute();
    const result: PaymentPlanDto[] = [];
    for (const plan of plans) {
      const paid = await sql<{ paid: string }>`
        select coalesce(sum(a.amount), 0)::text as paid from payment_allocations a join rent_charges c on c.id = a.rent_charge_id
         where c.lease_id = ${leaseId}::uuid and a.allocated_on >= ${plan.agreedOn}::date`.execute(tx);
      const items = (plan.instalments as Array<{ due_date: string; amount: string }>) ?? [];
      let running = 0n;
      let due = 0n;
      const instalments = items.map((item) => {
        running += scaled(item.amount);
        if (item.due_date <= today) due = running;
        return { dueDate: item.due_date, amount: toMoney(item.amount, currency, minor), dueToDate: toMoney(unscaled(running), currency, minor) };
      });
      const paidSince = scaled(paid.rows[0]!.paid);
      result.push({
        id: plan.id,
        leaseId: plan.leaseId,
        total: toMoney(plan.total, currency, minor),
        instalments,
        agreedOn: plan.agreedOn,
        status: plan.status,
        paidSinceAgreed: toSignedMoney(unscaled(paidSince), currency, minor),
        dueToDate: toMoney(unscaled(due), currency, minor),
        behind: plan.status === 'active' && paidSince < due,
        closedOn: plan.closedOn,
        closedReason: plan.closedReason,
        version: plan.version,
      });
    }
    return result;
  }

  private async lease(tx: Tx, ctx: TenantContext, leaseId: string, change: boolean) {
    const access = await leaseAccess(tx, leaseId);
    if (!access || !canOnLease(ctx, 'rent.view', access)) throw Problems.notFound();
    if (change && !canOnLease(ctx, 'arrears.manage', access)) throw Problems.forbidden('Your role does not allow arrears actions on this lease.');
    let qb = tx
      .selectFrom('leases as l')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .innerJoin('offices as o', 'o.id', 'p.officeId')
      .select(['l.id', 'l.reference', 'l.status', 'l.currencyCode', 'p.timezone', 'o.countryCode'])
      .where('l.id', '=', leaseId);
    if (change) qb = qb.forUpdate('l');
    return qb.executeTakeFirstOrThrow();
  }
}

// ------------------------------------------------------------------- steps (ST-2)

export async function arrearsSteps(tx: Tx): Promise<ArrearsStepDto[]> {
  const row = await tx.selectFrom('companySettings').select('value').where('officeId', 'is', null).where('key', '=', ARREARS_STEPS_KEY).executeTakeFirst();
  const value = row?.value;
  if (!Array.isArray(value)) return [];
  return value
    .filter((step): step is { actionCode: string; afterDays: number } => typeof step === 'object' && step !== null && typeof (step as Record<string, unknown>)['actionCode'] === 'string' && Number.isInteger((step as Record<string, unknown>)['afterDays']))
    .map((step) => ({ actionCode: step.actionCode, afterDays: step.afterDays }));
}

/** Steps in increasing days, each a known action, at most MAX_ARREARS_STEPS. */
export async function checkArrearsSteps(tx: Tx, ctx: TenantContext, steps: ArrearsStepInput[]): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  if (steps.length > MAX_ARREARS_STEPS) errors.push({ field: 'arrearsSteps', code: 'too-many', message: `At most ${MAX_ARREARS_STEPS} steps.` });
  const country = (await tx.selectFrom('companies').select('headquartersCountryCode').where('id', '=', ctx.companyId).executeTakeFirstOrThrow()).headquartersCountryCode;
  let previous = 0;
  for (const [index, step] of steps.entries()) {
    const code = await checkPicklistCode(tx, 'arrears_action', step.actionCode, country, `arrearsSteps[${index}].actionCode`);
    if (code) errors.push(code);
    if (step.afterDays <= previous) errors.push({ field: `arrearsSteps[${index}].afterDays`, code: 'order', message: 'Each step comes later than the one before.' });
    previous = step.afterDays;
  }
  return errors;
}

// ------------------------------------------------------------------- the as-of computation

/**
 * Overdue balance per lease as of a date: charges posted and due before the
 * date, less what was allocated and adjusted by then. Charges owing now are
 * read from the maintained balances (index rent_charges_open_idx); charges
 * settled since the date are added back from their later allocations and
 * adjustments, so a past date reproduces its figures (AR-1).
 */
export async function arrearsAsOf(
  tx: Tx,
  ctx: TenantContext,
  asOf: string,
  filter: { officeIds: string[] | null; leaseIds: string[] | null; currencies: string[] | null; unscoped?: boolean; includeDue?: boolean },
): Promise<ArrearsAggregate[]> {
  const scope = filter.unscoped ? sql<boolean>`true` : leaseScopeSql(ctx.permissions.get('rent.view')?.scope, ctx);
  const due = filter.includeDue ? sql`true` : sql`c.due_date < ${asOf}::date`;
  const leaseFilter = filter.leaseIds ? sql`and c.lease_id = any(${filter.leaseIds}::uuid[])` : sql``;
  const { rows } = await sql<ArrearsAggregate>`
    with later as (
      select a.rent_charge_id as id from payment_allocations a where a.allocated_on > ${asOf}::date
      union select j.rent_charge_id from rent_charge_adjustments j where j.adjusted_on > ${asOf}::date
    ),
    candidates as (
      select c.id, c.lease_id, c.currency_code, c.due_date, c.total_amount + c.adjusted_amount - c.allocated_amount as now_owed
        from rent_charges c
       where c.status = 'posted' and ${due} and c.allocated_amount <> c.amount + c.tax_amount + c.adjusted_amount ${leaseFilter}
      union
      select c.id, c.lease_id, c.currency_code, c.due_date, c.total_amount + c.adjusted_amount - c.allocated_amount
        from rent_charges c join later on later.id = c.id
       where c.status = 'posted' and ${due} ${leaseFilter}
    ),
    dated as (
      select k.lease_id, k.currency_code, k.due_date,
             k.now_owed
               + coalesce((select sum(a.amount) from payment_allocations a where a.rent_charge_id = k.id and a.allocated_on > ${asOf}::date), 0)
               - coalesce((select sum(j.amount) from rent_charge_adjustments j where j.rent_charge_id = k.id and j.adjusted_on > ${asOf}::date), 0) as owed
        from candidates k
    )
    select d.lease_id as "leaseId", d.currency_code as "currencyCode", sum(d.owed)::text as outstanding,
           coalesce(sum(d.owed) filter (where ${asOf}::date - d.due_date between 1 and 30), 0)::text as d30,
           coalesce(sum(d.owed) filter (where ${asOf}::date - d.due_date between 31 and 60), 0)::text as d60,
           coalesce(sum(d.owed) filter (where ${asOf}::date - d.due_date between 61 and 90), 0)::text as d90,
           coalesce(sum(d.owed) filter (where ${asOf}::date - d.due_date > 90), 0)::text as over,
           min(d.due_date)::text as "oldestDue", (${asOf}::date - min(d.due_date))::integer as days
      from dated d
      join leases l on l.id = d.lease_id join units u on u.id = l.unit_id join properties p on p.id = u.property_id
     where d.owed > 0 and ${scope}
       ${filter.officeIds ? sql`and p.office_id = any(${filter.officeIds}::uuid[])` : sql``}
       ${filter.currencies ? sql`and d.currency_code = any(${filter.currencies}::text[])` : sql``}
     group by d.lease_id, d.currency_code`.execute(tx);
  return rows.map((row) => ({ ...row, days: Math.max(0, Number(row.days)) }));
}

interface Detail {
  reference: string;
  tenantId: string | null;
  tenantName: string | null;
  lastActionCode: string | null;
  nextActionDate: string | null;
  planActive: boolean;
}

async function detailsFor(tx: Tx, leaseIds: string[]): Promise<Map<string, Detail>> {
  const { rows } = await sql<{ id: string; reference: string; tenantId: string | null; tenantName: string | null; lastActionCode: string | null; nextActionDate: string | null; planActive: boolean }>`
    select l.id, l.reference, pt.contact_id as "tenantId", tc.display_name as "tenantName",
           la.action_code as "lastActionCode", la.next_action_date::text as "nextActionDate",
           exists (select 1 from payment_plans pp where pp.lease_id = l.id and pp.status = 'active') as "planActive"
      from leases l
      left join lease_parties pt on pt.lease_id = l.id and pt.is_primary and pt.party_role in ('tenant', 'co_tenant')
      left join contacts tc on tc.id = pt.contact_id
      left join lateral (select a.action_code, a.next_action_date from arrears_actions a where a.lease_id = l.id
                          order by a.action_date desc, a.created_at desc limit 1) la on true
     where l.id = any(${leaseIds}::uuid[])`.execute(tx);
  return new Map(rows.map((row) => [row.id, row]));
}

function bucketOf(days: number): string {
  return days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
}

function toRow(row: ArrearsAggregate, detail: Detail, minor: number): ArrearsRowDto {
  const money = (value: string) => toMoney(value, row.currencyCode, minor);
  return {
    lease: { id: row.leaseId, name: detail.reference },
    tenant: detail.tenantId ? { id: detail.tenantId, name: detail.tenantName ?? '' } : null,
    currency: row.currencyCode,
    outstanding: money(row.outstanding),
    days1To30: money(row.d30),
    days31To60: money(row.d60),
    days61To90: money(row.d90),
    daysOver90: money(row.over),
    oldestDueDate: row.oldestDue,
    daysPastDue: row.days,
    lastActionCode: detail.lastActionCode,
    nextActionDate: detail.nextActionDate,
    planActive: detail.planActive,
  };
}
