import { type RawBuilder, sql } from 'kysely';

import { Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';

/**
 * Record-level scope for listings (Phase 1 §11.2; decisions D1 and D4):
 *   all    — every listing of the company
 *   office — listings of the member's offices (listings.office_id)
 *   own    — listings assigned to the member (listings.agent_membership_id)
 * Other scopes (linked, team, assigned) match nothing until their resolvers
 * exist (issue #12); they fail closed.
 */
export function listingScopeSql(scope: PermissionScope, ctx: TenantContext, alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0 ? sql<boolean>`${column('officeId')} = any(${[...ctx.officeIds]}::uuid[])` : sql<boolean>`false`;
    case 'own':
      return sql<boolean>`${column('agentMembershipId')} = ${ctx.membershipId}::uuid`;
    default:
      return sql<boolean>`false`;
  }
}

export interface ListingAccessRow {
  officeId: string;
  agentMembershipId: string;
}

export function listingWithin(ctx: TenantContext, scope: PermissionScope, row: ListingAccessRow): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'office':
      return ctx.officeIds.includes(row.officeId);
    case 'own':
      return row.agentMembershipId === ctx.membershipId;
    default:
      return false;
  }
}

/** Whether the member holds `permission` with a scope that covers the listing. */
export function hasListingPermission(ctx: TenantContext, row: ListingAccessRow, permission: string): boolean {
  const grant = ctx.permissions.get(permission);
  return grant !== undefined && listingWithin(ctx, grant.scope, row);
}

/** 404 when the member cannot see the listing; 403 when the action's scope does not cover it. */
export function assertListingAccess(ctx: TenantContext, row: ListingAccessRow, permission: string): void {
  if (!hasListingPermission(ctx, row, 'listing.view')) throw Problems.notFound();
  if (!hasListingPermission(ctx, row, permission)) {
    throw Problems.forbidden('Your role does not allow this action on this listing.');
  }
}

/** Offices a member may place a listing in, by the scope of their create/update grant. */
export function canPlaceListingInOffice(ctx: TenantContext, scope: PermissionScope, officeId: string): boolean {
  if (scope === 'all') return true;
  if (scope === 'office' || scope === 'own') return ctx.officeIds.includes(officeId);
  return false;
}

/** D4: only office- or company-wide grants may change who a listing belongs to. */
export function canReassign(ctx: TenantContext, row: ListingAccessRow): boolean {
  const grant = ctx.permissions.get('listing.update');
  return grant !== undefined && (grant.scope === 'all' || grant.scope === 'office') && listingWithin(ctx, grant.scope, row);
}
