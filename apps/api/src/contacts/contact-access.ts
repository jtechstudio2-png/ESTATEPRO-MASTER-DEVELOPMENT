import type { PermissionScope, TenantContext } from '../common/request-context.js';

/**
 * Record-level scope for contacts (approved CRM wireframes §2.1). RLS limits
 * rows to the company; these rules narrow them to the role's scope:
 *   all     every contact of the company
 *   office  contacts of the member's offices
 *   own     contacts the member is responsible for (owner)
 * Read-only visibility of contacts behind assigned leads and tasks (decision
 * D1) applies to viewing contacts, not to revealing protected data, and is
 * added with the contact endpoints.
 */
export interface ContactAccessRow {
  officeId: string | null;
  ownerMembershipId: string | null;
}

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
