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
}

export interface EstateProRequest extends Request {
  requestId: string;
  auth?: { user: AuthenticatedUser; token: VerifiedToken };
  tenant?: TenantContext;
  permissionScope?: PermissionScope;
}
