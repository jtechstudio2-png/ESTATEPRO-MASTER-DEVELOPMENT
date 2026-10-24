import { type RawBuilder, sql } from 'kysely';

import { Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';

/**
 * Record-level scope for properties (Phase 1 §11.4). RLS already limits rows to
 * the company; these rules narrow them to what the member's role allows:
 *   all      — every property of the company
 *   office   — properties of the member's offices
 *   own      — properties the member created
 *   assigned — properties with a work order actively assigned to the member
 * Scopes that do not apply to properties (team, linked) match nothing.
 */
export function propertyScopeSql(scope: PermissionScope, ctx: TenantContext, alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0
        ? sql<boolean>`${column('officeId')} = any(${[...ctx.officeIds]}::uuid[])`
        : sql<boolean>`false`;
    case 'own':
      return sql<boolean>`${column('createdBy')} = ${ctx.membershipId}::uuid`;
    case 'assigned':
      return sql<boolean>`exists (
        select 1 from maintenance_requests mr
          join maintenance_assignments ma on ma.company_id = mr.company_id and ma.request_id = mr.id
         where mr.company_id = ${column('companyId')} and mr.property_id = ${column('id')}
           and ma.assignee_membership_id = ${ctx.membershipId}::uuid and ma.status = 'active')`;
    default:
      return sql<boolean>`false`;
  }
}

export interface PropertyAccessRow {
  id: string;
  officeId: string;
  createdBy: string | null;
}

async function within(tx: Tx, ctx: TenantContext, scope: PermissionScope, row: PropertyAccessRow): Promise<boolean> {
  switch (scope) {
    case 'all':
      return true;
    case 'office':
      return ctx.officeIds.includes(row.officeId);
    case 'own':
      return row.createdBy === ctx.membershipId;
    case 'assigned': {
      const found = await tx
        .selectFrom('properties as p')
        .select('p.id')
        .where('p.id', '=', row.id)
        .where(propertyScopeSql('assigned', ctx, 'p'))
        .executeTakeFirst();
      return found !== undefined;
    }
    default:
      return false;
  }
}

/**
 * Throws 404 when the member may not see the property at all, and 403 when
 * they can see it but the permission's scope does not cover it.
 */
export async function assertPropertyAccess(
  tx: Tx,
  ctx: TenantContext,
  row: PropertyAccessRow,
  permission: string,
): Promise<void> {
  const view = ctx.permissions.get('property.view');
  if (!view || !(await within(tx, ctx, view.scope, row))) throw Problems.notFound();
  const grant = ctx.permissions.get(permission);
  if (!grant || !(await within(tx, ctx, grant.scope, row))) {
    throw Problems.forbidden('Your role does not allow this change for this property.');
  }
}

/** Whether a member may place a property in an office (create or move). */
export function canUseOffice(ctx: TenantContext, scope: PermissionScope, officeId: string): boolean {
  if (scope === 'all') return true;
  if (scope === 'office' || scope === 'own') return ctx.officeIds.includes(officeId);
  return false;
}
