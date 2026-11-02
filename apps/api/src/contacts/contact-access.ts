import { type RawBuilder, sql } from 'kysely';

import type { PermissionScope, TenantContext } from '../common/request-context.js';

/**
 * Record-level scope for contacts (approved CRM wireframes §2.1). RLS limits
 * rows to the company; these rules narrow them to the role's scope:
 *   all     every contact of the company
 *   office  contacts of the member's offices
 *   own     contacts the member is responsible for (owner)
 * Decision D1: for reading, "own" also covers contacts behind leads and open
 * tasks assigned to the member (read-only). Writing and revealing protected
 * data use the narrower rules without D1.
 */
export interface ContactAccessRow {
  officeId: string | null;
  ownerMembershipId: string | null;
}

export type ContactAccessMode = 'read' | 'write';

export function contactWithinScope(scope: PermissionScope, ctx: TenantContext, row: ContactAccessRow): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'office':
      return row.officeId !== null && ctx.officeIds.includes(row.officeId);
    case 'own':
      return row.ownerMembershipId !== null && row.ownerMembershipId === ctx.membershipId;
    default:
      return false;
  }
}

/** The same rules as SQL, for lists and counts (`alias` is the contacts alias). */
export function contactScopeSql(scope: PermissionScope, ctx: TenantContext, alias: string, mode: ContactAccessMode): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0 ? sql<boolean>`${column('officeId')} = any(${[...ctx.officeIds]}::uuid[])` : sql<boolean>`false`;
    case 'own': {
      const owner = sql<boolean>`${column('ownerMembershipId')} = ${ctx.membershipId}::uuid`;
      if (mode === 'write') return owner;
      // Uncorrelated id lists (row-level security limits them to the company):
      // the database computes each once per query instead of once per contact.
      return sql<boolean>`(${owner}
        or ${column('id')} in (select l.contact_id from leads l
                                where l.assigned_to = ${ctx.membershipId}::uuid and l.archived_at is null)
        or ${column('id')} in (select t.entity_id from tasks t
                                where t.assigned_to = ${ctx.membershipId}::uuid and t.status = 'open' and t.entity_type = 'contact')
        or ${column('id')} in (select l2.contact_id from leads l2
                                where l2.id in (select t2.entity_id from tasks t2
                                                 where t2.assigned_to = ${ctx.membershipId}::uuid and t2.status = 'open' and t2.entity_type = 'lead')))`;
    }
    default:
      return sql<boolean>`false`;
  }
}

/** The member's scope for a permission, or null when the role does not grant it. */
export function scopeFor(ctx: TenantContext, permission: string): PermissionScope | null {
  return ctx.permissions.get(permission)?.scope ?? null;
}
