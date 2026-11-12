import { type RawBuilder, sql } from 'kysely';

import { Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';

/**
 * Record-level scope for leads (approved CRM wireframes §2.1):
 *   all     every lead of the company
 *   office  leads of the member's offices (leads.office_id)
 *   own     leads assigned to the member
 * Other scopes match nothing (fail closed).
 */
export interface LeadAccessRow {
  officeId: string | null;
  assignedTo: string | null;
}

export function leadWithinScope(scope: PermissionScope | null, ctx: TenantContext, row: LeadAccessRow): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'office':
      return row.officeId !== null && ctx.officeIds.includes(row.officeId);
    case 'own':
      return row.assignedTo !== null && row.assignedTo === ctx.membershipId;
    default:
      return false;
  }
}

export function leadScopeSql(scope: PermissionScope | null, ctx: TenantContext, alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0 ? sql<boolean>`${column('officeId')} = any(${[...ctx.officeIds]}::uuid[])` : sql<boolean>`false`;
    case 'own':
      return sql<boolean>`${column('assignedTo')} = ${ctx.membershipId}::uuid`;
    default:
      return sql<boolean>`false`;
  }
}

export function scopeOf(ctx: TenantContext, permission: string): PermissionScope | null {
  return ctx.permissions.get(permission)?.scope ?? null;
}

export function canOnLead(ctx: TenantContext, permission: string, row: LeadAccessRow): boolean {
  return leadWithinScope(scopeOf(ctx, permission), ctx, row);
}

/** 404 when the member cannot see the lead; 403 when the permission's scope does not cover it. */
export function assertLeadPermission(ctx: TenantContext, row: LeadAccessRow, permission: string): void {
  if (!canOnLead(ctx, 'lead.view', row)) throw Problems.notFound();
  if (!canOnLead(ctx, permission, row)) throw Problems.forbidden('Your role does not allow this action on this lead.');
}

export interface MemberGrant {
  membershipId: string;
  name: string;
  scope: PermissionScope | null;
  officeIds: string[];
}

/** An active staff member of the company and their scope for a permission (null when they do not hold it). */
export async function memberGrant(tx: Tx, membershipId: string, permission: string): Promise<MemberGrant | null> {
  const member = await tx
    .selectFrom('companyMemberships as m')
    .innerJoin('users as u', 'u.id', 'm.userId')
    .leftJoin('rolePermissions as rp', (join) => join.onRef('rp.roleId', '=', 'm.roleId').on('rp.permissionKey', '=', permission))
    .select(['m.id', 'u.displayName', 'rp.scope'])
    .where('m.id', '=', membershipId)
    .where('m.status', '=', 'active')
    .where('m.membershipType', '=', 'staff')
    .executeTakeFirst();
  if (!member) return null;
  const offices = await tx.selectFrom('membershipOffices').select('officeId').where('membershipId', '=', membershipId).execute();
  return { membershipId: member.id, name: member.displayName, scope: (member.scope as PermissionScope | null) ?? null, officeIds: offices.map((row) => row.officeId) };
}

/** Whether a member's grant covers a lead (the same rules as leadWithinScope, for another member). */
export function grantCoversLead(grant: MemberGrant, row: LeadAccessRow): boolean {
  switch (grant.scope) {
    case 'all':
      return true;
    case 'office':
      return row.officeId !== null && grant.officeIds.includes(row.officeId);
    case 'own':
      return row.assignedTo === grant.membershipId;
    default:
      return false;
  }
}

/**
 * Decision D6: assigning work to someone else is a manager action. The
 * assigner's scope must cover the assignee: company-wide covers everyone,
 * office scope covers members of the assigner's offices.
 */
export function assignerCovers(ctx: TenantContext, assignee: MemberGrant): boolean {
  const scope = scopeOf(ctx, 'lead.assign');
  if (scope === 'all') return true;
  if (scope === 'office') return assignee.officeIds.some((office) => ctx.officeIds.includes(office));
  return false;
}
