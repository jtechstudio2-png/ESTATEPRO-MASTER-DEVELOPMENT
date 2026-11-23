import { sql } from 'kysely';

import type { AuditEntry, AuditService, DomainEvent } from '../audit/audit.service.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';

/** Company setting (P7-D6, ST-2): charges are created this many days before they are due. */
export const CHARGE_LEAD_DAYS_KEY = 'lettings.charge_lead_days';
/** Leases one rent-schedule transaction handles (#42 batching). */
export const RENT_SCHEDULE_BATCH = 500;
/** Scheduled charges or due reviews one transaction posts or notifies. */
export const RENT_POSTING_BATCH = 500;

/** The company's lead time, or null when not set (the schedule is idle, W7-D7). */
export async function chargeLeadDays(tx: Tx): Promise<number | null> {
  const row = await tx.selectFrom('companySettings').select('value').where('officeId', 'is', null).where('key', '=', CHARGE_LEAD_DAYS_KEY).executeTakeFirst();
  const value = row?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

interface PostedCharge {
  id: string;
  leaseId: string;
  chargeType: string;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string;
  currencyCode: string;
  amount: string;
  taxAmount: string;
  source: string;
}

/** Audit and outbox rows for charges just posted, in two statements. */
export async function recordPosted(tx: Tx, ctx: TenantContext, audit: AuditService, charges: readonly PostedCharge[], how: 'schedule' | 'scheduled-due'): Promise<void> {
  const entries: AuditEntry[] = charges.map((charge) => ({
    action: 'rent_charge.posted',
    entityType: 'rent_charge',
    entityId: charge.id,
    changes: how === 'scheduled-due' ? { status: { old: 'scheduled', new: 'posted' } } : null,
    metadata: {
      leaseId: charge.leaseId,
      chargeType: charge.chargeType,
      periodStart: charge.periodStart,
      periodEnd: charge.periodEnd,
      dueDate: charge.dueDate,
      amount: charge.amount,
      taxAmount: charge.taxAmount,
      currency: charge.currencyCode,
      source: charge.source,
    },
  }));
  const events: DomainEvent[] = charges.map((charge) => ({
    eventType: 'rent_charge.posted',
    aggregateType: 'rent_charge',
    aggregateId: charge.id,
    payload: { rentChargeId: charge.id, leaseId: charge.leaseId, chargeType: charge.chargeType, dueDate: charge.dueDate, amount: charge.amount, taxAmount: charge.taxAmount, currency: charge.currencyCode },
  }));
  await audit.recordMany(tx, ctx, entries);
  await audit.emitMany(tx, ctx, events);
}

const POSTED_COLUMNS = sql`c.id, c.lease_id as "leaseId", c.charge_type as "chargeType", c.period_start::text as "periodStart", c.period_end::text as "periodEnd",
  c.due_date::text as "dueDate", c.currency_code as "currencyCode", c.amount::text as amount, c.tax_amount::text as "taxAmount", c.source`;

/**
 * Posts one lease's uncharged rent up to `through` (app.post_rent_charges),
 * with audit and outbox rows. Used at activation (the periods due at signing).
 */
export async function postLeaseRent(tx: Tx, ctx: TenantContext, audit: AuditService, leaseId: string, through: string): Promise<number> {
  const { rows } = await sql<PostedCharge>`select ${POSTED_COLUMNS}
      from app.post_rent_charges(${ctx.companyId}::uuid, ${leaseId}::uuid, ${through}::date, ${ctx.system ? null : ctx.membershipId}::uuid) c`.execute(tx);
  await recordPosted(tx, ctx, audit, rows, 'schedule');
  return rows.length;
}

/**
 * One batch of the daily rent schedule (P7-D6): the next RENT_SCHEDULE_BATCH
 * scheduled leases after `afterId`, each charged up to its property's local
 * date plus the lead time. Returns how many leases were looked at, the last
 * lease id and the number of charges posted.
 */
export async function postRentBatch(
  tx: Tx,
  ctx: TenantContext,
  audit: AuditService,
  options: { afterId: string | null; leadDays: number; now: Date; limit?: number },
): Promise<{ leases: number; lastId: string | null; posted: number }> {
  const limit = options.limit ?? RENT_SCHEDULE_BATCH;
  const { rows: batch } = await sql<{ id: string; through: string }>`
    select l.id, ((${options.now}::timestamptz at time zone p.timezone)::date + ${options.leadDays}::integer)::text as through
      from leases l join units u on u.id = l.unit_id join properties p on p.id = u.property_id
     where l.company_id = ${ctx.companyId}::uuid and l.rent_schedule_from is not null and l.status in ('active', 'periodic', 'notice_given')
       and (${options.afterId}::uuid is null or l.id > ${options.afterId}::uuid)
     order by l.id
     limit ${limit}`.execute(tx);
  if (batch.length === 0) return { leases: 0, lastId: null, posted: 0 };
  const { rows } = await sql<PostedCharge>`select ${POSTED_COLUMNS}
      from unnest(${batch.map((row) => row.id)}::uuid[], ${batch.map((row) => row.through)}::date[]) as b (id, through)
      cross join lateral app.post_rent_charges(${ctx.companyId}::uuid, b.id, b.through, null) c`.execute(tx);
  await recordPosted(tx, ctx, audit, rows, 'schedule');
  return { leases: batch.length, lastId: batch[batch.length - 1]!.id, posted: rows.length };
}

/** Posts scheduled charges whose due date has come (property's local date). Returns how many. */
export async function postScheduledDue(tx: Tx, ctx: TenantContext, audit: AuditService, now: Date): Promise<number> {
  const { rows } = await sql<PostedCharge>`
    update rent_charges c set status = 'posted'
     where c.id in (
       select rc.id from rent_charges rc
         join leases l on l.id = rc.lease_id join units u on u.id = l.unit_id join properties p on p.id = u.property_id
        where rc.company_id = ${ctx.companyId}::uuid and rc.status = 'scheduled'
          and rc.due_date <= (${now}::timestamptz at time zone p.timezone)::date
        order by rc.due_date, rc.id
        limit ${RENT_POSTING_BATCH}
        for update of rc skip locked)
    returning ${POSTED_COLUMNS}`.execute(tx);
  await recordPosted(tx, ctx, audit, rows, 'scheduled-due');
  return rows.length;
}

/**
 * Writes the "rent review due" notice (LET-08) for open reviews whose date
 * has come, once each (delivery with Phase 12). Returns how many.
 */
export async function notifyReviewsDue(tx: Tx, ctx: TenantContext, audit: AuditService, now: Date): Promise<number> {
  const { rows } = await sql<{ id: string; leaseId: string; reviewDate: string; status: string }>`
    update rent_reviews r set due_notified_at = ${now}::timestamptz
     where r.id in (
       select rr.id from rent_reviews rr
         join leases l on l.id = rr.lease_id join units u on u.id = l.unit_id join properties p on p.id = u.property_id
        where rr.company_id = ${ctx.companyId}::uuid and rr.status in ('scheduled', 'proposed') and rr.due_notified_at is null
          and rr.review_date <= (${now}::timestamptz at time zone p.timezone)::date
        order by rr.review_date, rr.id
        limit ${RENT_POSTING_BATCH}
        for update of rr skip locked)
    returning r.id, r.lease_id as "leaseId", r.review_date::text as "reviewDate", r.status`.execute(tx);
  await audit.recordMany(
    tx,
    ctx,
    rows.map((row) => ({ action: 'rent_review.due_notified', entityType: 'rent_review', entityId: row.id, metadata: { leaseId: row.leaseId, reviewDate: row.reviewDate } })),
  );
  await audit.emitMany(
    tx,
    ctx,
    rows.map((row) => ({ eventType: 'rent_review.due', aggregateType: 'rent_review', aggregateId: row.id, payload: { rentReviewId: row.id, leaseId: row.leaseId, reviewDate: row.reviewDate, status: row.status } })),
  );
  return rows.length;
}
