import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';

import { Problems } from '../common/problem.js';
import type {
  AuthenticatedUser,
  EstateProRequest,
  PermissionScope,
  TenantContext,
} from '../common/request-context.js';

export const IS_PUBLIC = 'estatepro:isPublic';
export const NO_COMPANY_CONTEXT = 'estatepro:noCompanyContext';
export const REQUIRED_PERMISSION = 'estatepro:requiredPermission';
export const PORTAL_ENDPOINT = 'estatepro:portalEndpoint';

/** No authentication (health checks only). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/** Authenticated, but not tied to one company (e.g. listing your memberships). */
export const NoCompanyContext = (): MethodDecorator & ClassDecorator => SetMetadata(NO_COMPANY_CONTEXT, true);

/** The caller's role must grant this permission; the granted scope is available via @Scope(). */
export const RequirePermission = (permission: string): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/**
 * A landlord or tenant portal endpoint: portal memberships may call it (every
 * other endpoint is for company staff only). The endpoint itself decides what
 * a portal member sees (S4: the reduced landlord views).
 */
export const PortalEndpoint = (): MethodDecorator & ClassDecorator => SetMetadata(PORTAL_ENDPOINT, true);

export const Tenant = createParamDecorator((_data: unknown, context: ExecutionContext): TenantContext => {
  const req = context.switchToHttp().getRequest<EstateProRequest>();
  if (!req.tenant) throw Problems.internal();
  return req.tenant;
});

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedUser => {
  const req = context.switchToHttp().getRequest<EstateProRequest>();
  if (!req.auth) throw Problems.internal();
  return req.auth.user;
});

export const Scope = createParamDecorator((_data: unknown, context: ExecutionContext): PermissionScope => {
  const req = context.switchToHttp().getRequest<EstateProRequest>();
  if (!req.permissionScope) throw Problems.internal();
  return req.permissionScope;
});
