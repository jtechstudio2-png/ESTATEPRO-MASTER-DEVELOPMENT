import { type RawBuilder, sql } from 'kysely';

import type { PermissionScope, TenantContext } from '../common/request-context.js';
import type { MemberGrant } from '../crm/lead-access.js';

/**
 * Record scope for deals, and for the offers and viewings that follow a deal
 * (ADR-008 §5; S2-D2; one definition since S3, closing S2-R3):
 *   all     every deal of the company
 *   office  deals of the member's offices
 *   own     deals the member owns (the responsible agent) or is an agent on
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

/** The same rule in SQL, for a query that joins the deal as `alias` (default d). */
export function dealScopeSql(scope: PermissionScope | null | undefined, ctx: TenantContext, alias = 'd'): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0 ? sql<boolean>`${column('office_id')} = any(${[...ctx.officeIds]}::uuid[])` : sql<boolean>`false`;
    case 'own':
      return sql<boolean>`(${column('owner_membership_id')} = ${ctx.membershipId}::uuid
        or exists (select 1 from deal_agents da where da.company_id = ${column('company_id')} and da.deal_id = ${column('id')} and da.membership_id = ${ctx.membershipId}::uuid))`;
    default:
      return sql<boolean>`false`;
  }
}

/**
 * Reassigning a deal and setting its agents are manager actions (readiness
 * §4.3 "reassignment by managers"): deal.update with company or office scope.
 */
export function managesDeal(ctx: TenantContext, row: DealAccessRow): boolean {
  const scope = ctx.permissions.get('deal.update')?.scope;
  return (scope === 'all' || scope === 'office') && dealWithin(scope, ctx, row);
}

/** Whether another member's deal.view grant covers a deal they would own or work on. */
export function grantCoversDeal(grant: MemberGrant, row: { officeId: string }, asOwnerOrAgent: boolean): boolean {
  switch (grant.scope) {
    case 'all':
      return true;
    case 'office':
      return grant.officeIds.includes(row.officeId);
    case 'own':
      return asOwnerOrAgent;
    default:
      return false;
  }
}
