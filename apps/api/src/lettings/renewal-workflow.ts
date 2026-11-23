import { sql } from 'kysely';

import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';

/** Leases one renewal-reminder transaction handles (#42 batching). */
export const RENEWAL_BATCH = 500;
/** Days before the end date at which a renewal reminder is written (readiness §5.6). */
export const RENEWAL_MARKS = [90, 60, 30] as const;
const PRIORITY: Record<number, string> = { 90: 'normal', 60: 'high', 30: 'urgent' };

/**
 * One batch of the daily renewal reminders (readiness §5.6, LS-7): for each
 * active fixed-term lease ending within 90 days (the property's local date)
 * without a decision, the renewal status becomes "pending decision" and a
 * renewal task is written at 90, 60 and 30 days before the end date, once
 * each (renewal_mark). A new reminder supersedes the open one. At 30 days
 * (or later) without a decision the reminder is urgent and the escalation is
 * written to the outbox (delivery with Phase 12). The task goes to the member
 * who drew the lease up, or the company owner if they have left. Marks passed
 * while the job was idle are not written one by one: only the latest reached.
 */
export async function renewalReminderBatch(
  tx: Tx,
  ctx: TenantContext,
  audit: AuditService,
  options: { afterId: string | null; now: Date; limit?: number },
): Promise<{ leases: number; lastId: string | null; reminded: number; escalated: number }> {
  const limit = options.limit ?? RENEWAL_BATCH;
  const { rows } = await sql<{ id: string; reference: string; endDate: string; days: number; mark: number | null; assignee: string | null; dueAt: Date }>`
    select l.id, l.reference, l.end_date::text as "endDate", (l.end_date - local.today)::integer as days, l.renewal_mark as mark,
           coalesce(
             (select m.id from company_memberships m where m.id = l.created_by and m.status = 'active'),
             (select m.id from company_memberships m join roles r on r.id = m.role_id
               where m.company_id = l.company_id and m.status = 'active' and r.key = 'company_owner'
               order by m.created_at, m.id limit 1)) as assignee,
           ((greatest(local.today, l.end_date - case when l.end_date - local.today > 60 then 60 when l.end_date - local.today > 30 then 30 else 0 end)
              + time '09:00') at time zone p.timezone) as "dueAt"
      from leases l
      join units u on u.id = l.unit_id
      join properties p on p.id = u.property_id
      cross join lateral (select (${options.now}::timestamptz at time zone p.timezone)::date as today) local
     where l.company_id = ${ctx.companyId}::uuid
       and l.status = 'active' and l.lease_type = 'fixed_term' and l.end_date is not null
       and l.renewal_status in ('not_due', 'pending_decision')
       and l.end_date <= (${options.now}::timestamptz at time zone 'UTC')::date + 91
       and (${options.afterId}::uuid is null or l.id > ${options.afterId}::uuid)
     order by l.id
     limit ${limit}`.execute(tx);

  const due = rows
    .map((row) => ({ ...row, reached: RENEWAL_MARKS.filter((mark) => row.days <= mark).at(-1) ?? null }))
    .filter((row): row is typeof row & { reached: number } => row.reached !== null && (row.mark === null || row.mark > row.reached));
  let escalated = 0;
  if (due.length > 0) {
    const ids = due.map((row) => row.id);
    // Each lease moves to the mark it reached (one statement).
    await sql`update leases l set renewal_status = 'pending_decision', renewal_mark = v.mark
                from (select unnest(${ids}::uuid[]) as id, unnest(${due.map((row) => row.reached)}::smallint[]) as mark) v
               where l.id = v.id`.execute(tx);
    // The new reminder supersedes the open one.
    const superseded = await tx
      .updateTable('tasks')
      .set({ status: 'cancelled', cancelledAt: sql<Date>`now()`, cancelReason: 'Superseded by the next renewal reminder' })
      .where('entityType', '=', 'lease')
      .where('entityId', 'in', ids)
      .where('taskType', '=', 'renewal')
      .where('source', '=', 'automation')
      .where('status', '=', 'open')
      .returning('id')
      .execute();
    const assigned = due.filter((row) => row.assignee !== null);
    const tasks = assigned.length === 0
      ? []
      : await tx
          .insertInto('tasks')
          .values(assigned.map((row) => ({
            companyId: ctx.companyId,
            title: `Renewal decision: ${row.reference} ends on ${row.endDate}`,
            taskType: 'renewal',
            priority: PRIORITY[row.reached]!,
            dueAt: row.dueAt,
            assignedTo: row.assignee!,
            entityType: 'lease',
            entityId: row.id,
            source: 'automation',
          })))
          .returning(['id', 'entityId', 'assignedTo'])
          .execute();
    const taskByLease = new Map(tasks.map((task) => [task.entityId, task]));
    await audit.recordMany(tx, ctx, [
      ...superseded.map((task) => ({ action: 'task.cancelled', entityType: 'task', entityId: task.id, metadata: { reason: 'superseded', source: 'automation' } })),
      ...due.map((row) => ({
        action: 'lease.renewal_reminder',
        entityType: 'lease',
        entityId: row.id,
        changes: { renewalMark: { old: row.mark, new: row.reached } },
        metadata: { endDate: row.endDate, daysToEnd: row.days, taskId: taskByLease.get(row.id)?.id ?? null, assignedTo: row.assignee, escalated: row.reached === 30 },
      })),
    ]);
    const events = due.map((row) => ({
      eventType: 'lease.renewal_reminder',
      aggregateType: 'lease',
      aggregateId: row.id,
      payload: { leaseId: row.id, endDate: row.endDate, daysToEnd: row.days, mark: row.reached, taskId: taskByLease.get(row.id)?.id ?? null, assignedTo: row.assignee },
    }));
    const escalations = due.filter((row) => row.reached === 30).map((row) => ({
      eventType: 'lease.renewal_escalated',
      aggregateType: 'lease',
      aggregateId: row.id,
      payload: { leaseId: row.id, endDate: row.endDate, daysToEnd: row.days, assignedTo: row.assignee },
    }));
    escalated = escalations.length;
    await audit.emitMany(tx, ctx, [...events, ...escalations]);
  }
  return { leases: rows.length, lastId: rows.at(-1)?.id ?? null, reminded: due.length, escalated };
}
