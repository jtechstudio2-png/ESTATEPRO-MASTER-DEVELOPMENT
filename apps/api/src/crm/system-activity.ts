import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';

export type ActivityEntityType = 'contact' | 'lead' | 'listing' | 'property';

export interface ActivityLink {
  entityType: ActivityEntityType;
  entityId: string;
}

/**
 * A system entry on the activity timeline (wireframe A-1): status changes and
 * consent changes. System entries are written in the same transaction as the
 * change they describe and can never be edited or archived (migration 0024).
 */
export async function recordSystemActivity(
  tx: Tx,
  ctx: TenantContext,
  entry: { activityType: 'status_change' | 'system'; subject: string; body?: string | null; links: ActivityLink[] },
): Promise<string> {
  const activity = await tx
    .insertInto('activities')
    .values({
      companyId: ctx.companyId,
      activityType: entry.activityType,
      direction: 'internal',
      subject: entry.subject.slice(0, 200),
      body: entry.body ?? null,
      performedBy: ctx.system ? null : ctx.membershipId,
      createdBy: ctx.system ? null : ctx.membershipId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const unique = new Map(entry.links.map((link) => [`${link.entityType}:${link.entityId}`, link]));
  await tx
    .insertInto('activityLinks')
    .values([...unique.values()].map((link) => ({ companyId: ctx.companyId, activityId: activity.id, entityType: link.entityType, entityId: link.entityId })))
    .execute();
  return activity.id;
}
