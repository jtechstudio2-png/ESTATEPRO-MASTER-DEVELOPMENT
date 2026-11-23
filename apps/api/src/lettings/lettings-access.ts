import { type RawBuilder, sql } from 'kysely';

import { Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';

/**
 * Record scope for leases (Phase 1 §11.2, readiness report §3.1; seeded
 * permissions of migration 0014):
 *   all     every lease of the company
 *   office  leases of units in properties of the member's offices
 *   own     leases the member drew up, or of letting deals they own or work on
 * The portal scope "linked" is milestone L5; it matches nothing here.
 */
export interface LeaseAccessRow {
  officeId: string;
  createdBy: string | null;
  dealOwnerId: string | null;
  dealAgentIds: readonly string[];
}

export function leaseWithin(scope: PermissionScope | null | undefined, ctx: TenantContext, row: LeaseAccessRow): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'office':
      return ctx.officeIds.includes(row.officeId);
    case 'own':
      return row.createdBy === ctx.membershipId || row.dealOwnerId === ctx.membershipId || row.dealAgentIds.includes(ctx.membershipId);
    default:
      return false;
  }
}

export function canOnLease(ctx: TenantContext, permission: string, row: LeaseAccessRow): boolean {
  return leaseWithin(ctx.permissions.get(permission)?.scope, ctx, row);
}

/** The same rule in SQL for a query joining the lease as `l` and its property as `p`. */
export function leaseScopeSql(scope: PermissionScope | null | undefined, ctx: TenantContext): RawBuilder<boolean> {
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0 ? sql<boolean>`p.office_id = any(${[...ctx.officeIds]}::uuid[])` : sql<boolean>`false`;
    case 'own':
      return sql<boolean>`(l.created_by = ${ctx.membershipId}::uuid
        or exists (select 1 from deals d where d.company_id = l.company_id and d.id = l.deal_id
                     and (d.owner_membership_id = ${ctx.membershipId}::uuid
                          or exists (select 1 from deal_agents da where da.company_id = d.company_id and da.deal_id = d.id and da.membership_id = ${ctx.membershipId}::uuid))))`;
    default:
      return sql<boolean>`false`;
  }
}

/** Who may see a lease: its office (through the unit's property) and the people it is "own" for. */
export async function leaseAccess(tx: Tx, leaseId: string): Promise<(LeaseAccessRow & { status: string }) | null> {
  const row = await tx
    .selectFrom('leases as l')
    .innerJoin('units as u', 'u.id', 'l.unitId')
    .innerJoin('properties as p', 'p.id', 'u.propertyId')
    .leftJoin('deals as d', 'd.id', 'l.dealId')
    .select(['p.officeId', 'l.createdBy', 'd.ownerMembershipId as dealOwnerId', 'l.dealId', 'l.status'])
    .where('l.id', '=', leaseId)
    .executeTakeFirst();
  if (!row) return null;
  const agents = row.dealId ? await tx.selectFrom('dealAgents').select('membershipId').where('dealId', '=', row.dealId).execute() : [];
  return { officeId: row.officeId, createdBy: row.createdBy, dealOwnerId: row.dealOwnerId, dealAgentIds: agents.map((a) => a.membershipId), status: row.status };
}

/**
 * Record scope for management agreements: all, or office (the property's
 * office). No role holds an "own" scope for agreements.
 */
export function agreementWithin(scope: PermissionScope | null | undefined, ctx: TenantContext, row: { officeId: string }): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'office':
      return ctx.officeIds.includes(row.officeId);
    default:
      return false;
  }
}

export function canOnAgreement(ctx: TenantContext, permission: string, row: { officeId: string }): boolean {
  return agreementWithin(ctx.permissions.get(permission)?.scope, ctx, row);
}

/** The same rule in SQL for a query joining the agreement's property as `p`. */
export function agreementScopeSql(scope: PermissionScope | null | undefined, ctx: TenantContext): RawBuilder<boolean> {
  switch (scope) {
    case 'all':
      return sql<boolean>`true`;
    case 'office':
      return ctx.officeIds.length > 0 ? sql<boolean>`p.office_id = any(${[...ctx.officeIds]}::uuid[])` : sql<boolean>`false`;
    default:
      return sql<boolean>`false`;
  }
}

export async function agreementOffice(tx: Tx, agreementId: string): Promise<{ officeId: string; status: string } | null> {
  const row = await tx
    .selectFrom('managementAgreements as m')
    .innerJoin('properties as p', 'p.id', 'm.propertyId')
    .select(['p.officeId', 'm.status'])
    .where('m.id', '=', agreementId)
    .executeTakeFirst();
  return row ?? null;
}

export type LettingsEntity = 'lease' | 'management_agreement' | 'bank_account';

/**
 * Access to a lease or an agreement for its documents: 404 when the member may
 * not see the record, 403 when `action` (on the record) is not granted.
 */
export async function assertLettingsRecord(tx: Tx, ctx: TenantContext, entityType: LettingsEntity, entityId: string, action: 'view' | 'change'): Promise<void> {
  if (entityType === 'bank_account') {
    // Bank accounts are company-wide; their statement files are for the members who record receipts (L3).
    const account = await tx.selectFrom('bankAccounts').select('id').where('id', '=', entityId).executeTakeFirst();
    const allowed = ctx.permissions.get('payment.record')?.scope === 'all' || ctx.permissions.get('bank_account.manage')?.scope === 'all';
    if (!account || !allowed) throw Problems.notFound();
    if (action === 'change' && ctx.permissions.get('payment.record')?.scope !== 'all') throw Problems.forbidden('Your role does not allow importing bank files.');
    return;
  }
  if (entityType === 'lease') {
    const row = await leaseAccess(tx, entityId);
    if (!row || !canOnLease(ctx, 'lease.view', row)) throw Problems.notFound();
    if (action === 'change' && !canOnLease(ctx, 'lease.update', row)) throw Problems.forbidden('Your role does not allow changes to this lease.');
    return;
  }
  const row = await agreementOffice(tx, entityId);
  if (!row || !canOnAgreement(ctx, 'management_agreement.view', row)) throw Problems.notFound();
  if (action === 'change' && !canOnAgreement(ctx, 'management_agreement.manage', row)) {
    throw Problems.forbidden('Your role does not allow changes to this management agreement.');
  }
}
