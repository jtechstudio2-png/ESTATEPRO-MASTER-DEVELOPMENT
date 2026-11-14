import { type RawBuilder, sql } from 'kysely';

import type { PermissionScope, TenantContext } from '../common/request-context.js';

/**
 * Offers follow their deal (ADR-008 §5, S2-D2):
 *   all     every offer of the company
 *   office  offers on deals of the member's offices
 *   own     offers on deals the member owns or is an agent on
 * Other scopes match nothing here (the landlord's linked view is S4).
 */
export interface DealAccessRow {
  officeId: string;
  ownerMembershipId: string;
  agentIds: readonly string[];
}

export function dealWithin(scope: PermissionScope | null | undefined, ctx: TenantContext, row: DealAccessRow): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'office':
      return ctx.officeIds.includes(row.officeId);
    case 'own':
      return row.ownerMembershipId === ctx.membershipId || row.agentIds.includes(ctx.membershipId);
    default:
      return false;
  }
}

export function canOnDeal(ctx: TenantContext, permission: string, row: DealAccessRow): boolean {
  return dealWithin(ctx.permissions.get(permission)?.scope, ctx, row);
}

/** The same rule in SQL, for a query that joins the deal as d. */
export function dealScopeSql(scope: PermissionScope | null | undefined, ctx: TenantContext): RawBuilder<boolean> {
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0 ? sql<boolean>`d.office_id = any(${[...ctx.officeIds]}::uuid[])` : sql<boolean>`false`;
    case 'own':
      return sql<boolean>`(d.owner_membership_id = ${ctx.membershipId}::uuid
        or exists (select 1 from deal_agents da where da.deal_id = d.id and da.membership_id = ${ctx.membershipId}::uuid))`;
    default:
      return sql<boolean>`false`;
  }
}
