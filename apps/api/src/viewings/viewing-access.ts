import { type RawBuilder, sql } from 'kysely';

import type { PermissionScope, TenantContext } from '../common/request-context.js';

/**
 * Record scope for viewings (readiness report §4.1, S1-D2):
 *   all     every viewing of the company
 *   office  viewings of listings in the member's offices
 *   own     viewings the member conducts, and viewings of their own listings,
 *           of leads assigned to them and of deals they own
 * Other scopes match nothing (fail closed).
 */
export interface ViewingAccessRow {
  agentMembershipId: string;
  listingOfficeId: string;
  listingAgentId: string;
  leadAssignedTo: string | null;
  dealOwnerId: string | null;
}

export function viewingWithin(scope: PermissionScope | null | undefined, ctx: TenantContext, row: ViewingAccessRow): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'office':
      return ctx.officeIds.includes(row.listingOfficeId);
    case 'own':
      return [row.agentMembershipId, row.listingAgentId, row.leadAssignedTo, row.dealOwnerId].includes(ctx.membershipId);
    default:
      return false;
  }
}

export function canOnViewing(ctx: TenantContext, permission: 'viewing.view' | 'viewing.manage', row: ViewingAccessRow): boolean {
  return viewingWithin(ctx.permissions.get(permission)?.scope, ctx, row);
}

/** The same rule in SQL; the query joins the viewing (v), listing (l), lead (ld) and deal (d). */
export function viewingScopeSql(scope: PermissionScope | null | undefined, ctx: TenantContext): RawBuilder<boolean> {
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0 ? sql<boolean>`l.office_id = any(${[...ctx.officeIds]}::uuid[])` : sql<boolean>`false`;
    case 'own': {
      const me = sql`${ctx.membershipId}::uuid`;
      return sql<boolean>`(v.agent_membership_id = ${me} or l.agent_membership_id = ${me} or ld.assigned_to = ${me} or d.owner_membership_id = ${me})`;
    }
    default:
      return sql<boolean>`false`;
  }
}
