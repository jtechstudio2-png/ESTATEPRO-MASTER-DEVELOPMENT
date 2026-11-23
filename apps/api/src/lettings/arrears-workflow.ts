import { sql } from 'kysely';

import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import type { ArrearsStepDto } from './receipts.dto.js';

/** Leases one arrears-workflow transaction handles (#42 batching). */
export const ARREARS_BATCH = 500;

/**
 * One batch of the daily arrears workflow (P7-D10, readiness §5.4): for each
 * lease owing money past its due date (the property's local date) and without
 * an active payment plan, the latest of the company's steps the arrears have
 * reached is recorded once per arrears episode (since the oldest unpaid due
 * date), with the date of the next step, and a notice is written to the outbox
 * (delivery with Phase 12). Steps passed while the job was idle are not
 * recorded one by one: only the step reached now.
 */
export async function arrearsWorkflowBatch(
  tx: Tx,
  ctx: TenantContext,
  audit: AuditService,
  options: { afterId: string | null; now: Date; steps: readonly ArrearsStepDto[]; limit?: number },
): Promise<{ leases: number; lastId: string | null; recorded: number }> {
  const { rows } = await sql<{ leaseId: string; today: string; oldestDue: string; owed: string; days: number; codes: string[] }>`
    with owing as (
      select l.id as lease_id, (${options.now}::timestamptz at time zone p.timezone)::date as today
        from leases l join units u on u.id = l.unit_id join properties p on p.id = u.property_id
       where l.company_id = ${ctx.companyId}::uuid and (${options.afterId}::uuid is null or l.id > ${options.afterId}::uuid)
         and exists (select 1 from rent_charges c where c.lease_id = l.id and c.status = 'posted'
                       and c.allocated_amount <> c.amount + c.tax_amount + c.adjusted_amount)
       order by l.id
       limit ${options.limit ?? ARREARS_BATCH}
    ),
    overdue as (
      select o.lease_id, o.today, min(c.due_date) as oldest_due, sum(c.total_amount + c.adjusted_amount - c.allocated_amount) as owed
        from owing o join rent_charges c on c.lease_id = o.lease_id
       where c.status = 'posted' and c.allocated_amount <> c.amount + c.tax_amount + c.adjusted_amount and c.due_date < o.today
       group by o.lease_id, o.today
    )
    select o.lease_id as "leaseId", o.today::text as today, o.oldest_due::text as "oldestDue", o.owed::text as owed,
           (o.today - o.oldest_due)::integer as days,
           array(select distinct a.action_code from arrears_actions a where a.lease_id = o.lease_id and a.action_date >= o.oldest_due) as codes
      from overdue o
     where not exists (select 1 from payment_plans pp where pp.lease_id = o.lease_id and pp.status = 'active')
     order by o.lease_id`.execute(tx);
  const { rows: batch } = await sql<{ last: string | null; n: number }>`
    select max(l.id::text) as last, count(*)::integer as n from (
      select l.id from leases l
       where l.company_id = ${ctx.companyId}::uuid and (${options.afterId}::uuid is null or l.id > ${options.afterId}::uuid)
         and exists (select 1 from rent_charges c where c.lease_id = l.id and c.status = 'posted'
                       and c.allocated_amount <> c.amount + c.tax_amount + c.adjusted_amount)
       order by l.id limit ${options.limit ?? ARREARS_BATCH}) l`.execute(tx);

  const actions = [];
  for (const row of rows) {
    const reached = options.steps.filter((step) => step.afterDays <= Number(row.days));
    const step = reached[reached.length - 1];
    if (!step || row.codes.includes(step.actionCode)) continue;
    const next = options.steps.find((candidate) => candidate.afterDays > step.afterDays);
    actions.push({
      leaseId: row.leaseId,
      actionCode: step.actionCode,
      actionDate: row.today,
      owed: row.owed,
      days: Number(row.days),
      nextActionDate: next ? addDays(row.oldestDue, next.afterDays) : null,
    });
  }
  if (actions.length > 0) {
    const inserted = await tx
      .insertInto('arrearsActions')
      .values(actions.map((action) => ({
        companyId: ctx.companyId,
        leaseId: action.leaseId,
        actionCode: action.actionCode,
        actionDate: action.actionDate,
        arrearsAmount: action.owed,
        nextActionDate: action.nextActionDate,
        performedBy: null,
        source: 'automation',
      })))
      .returning(['id', 'leaseId'])
      .execute();
    const ids = new Map(inserted.map((row) => [row.leaseId, row.id]));
    await audit.recordMany(
      tx,
      ctx,
      actions.map((action) => ({
        action: 'arrears.action_recorded',
        entityType: 'lease',
        entityId: action.leaseId,
        metadata: { arrearsActionId: ids.get(action.leaseId), actionCode: action.actionCode, actionDate: action.actionDate, daysPastDue: action.days, source: 'automation' },
      })),
    );
    await audit.emitMany(
      tx,
      ctx,
      actions.map((action) => ({
        eventType: 'arrears.step_due',
        aggregateType: 'lease',
        aggregateId: action.leaseId,
        payload: { leaseId: action.leaseId, arrearsActionId: ids.get(action.leaseId), actionCode: action.actionCode, owed: action.owed, daysPastDue: action.days },
      })),
    );
  }
  return { leases: Number(batch[0]?.n ?? 0), lastId: batch[0]?.last ?? null, recorded: actions.length };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
