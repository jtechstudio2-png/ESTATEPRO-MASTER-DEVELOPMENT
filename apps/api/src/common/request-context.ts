import type { Request } from 'express';

import type { VerifiedToken } from '../auth/token-verifier.service.js';

export type PermissionScope = 'all' | 'office' | 'team' | 'own' | 'linked' | 'assigned';

export interface GrantedPermission {
  scope: PermissionScope;
  isSensitive: boolean;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
}

/** Everything a company-scoped request handler may rely on. */
export interface TenantContext {
  companyId: string;
  userId: string;
  membershipId: string;
  membershipType: 'staff' | 'portal';
  roleKey: string;
  contactId: string | null;
  officeIds: readonly string[];
  permissions: ReadonlyMap<string, GrantedPermission>;
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
  /** Set for background work (the worker): no user, audited as actor type "system". */
  system?: true;
}

/**
 * Context for background jobs acting on one company. Row-level security still
 * applies (the company is set on the transaction); there is no user, no
 * membership and no permission, so record-level checks must not be called.
 */
export function systemContext(companyId: string, requestId: string): TenantContext {
  return {
    companyId,
    userId: '',
    membershipId: '',
    membershipType: 'staff',
    roleKey: 'system',
    contactId: null,
    officeIds: [],
    permissions: new Map(),
    requestId,
    ipAddress: null,
    userAgent: null,
    system: true,
  };
}

/** The acting membership for "changed by" columns; null for the system. */
export function actingMembership(ctx: TenantContext): string | null {
  return ctx.system ? null : ctx.membershipId;
}

export interface EstateProRequest extends Request {
  requestId: string;
  auth?: { user: AuthenticatedUser; token: VerifiedToken };
  tenant?: TenantContext;
  permissionScope?: PermissionScope;
}
