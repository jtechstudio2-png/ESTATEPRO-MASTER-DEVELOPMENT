import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Problems } from '../common/problem.js';
import type { EstateProRequest } from '../common/request-context.js';
import { IS_PUBLIC, NO_COMPANY_CONTEXT, REQUIRED_PERMISSION } from './decorators.js';
import { IdentityService } from './identity.service.js';
import { TokenVerifier } from './token-verifier.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** System roles that always require MFA (ADR-001 §5). */
const MFA_ROLES = new Set(['company_owner', 'office_admin', 'accountant']);

const BLOCKED_STATUSES = new Set(['suspended', 'cancelled']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Authenticates every request, resolves the active company membership from
 * X-Company-Id, enforces MFA and company status, then checks the route's
 * required permission. Runs as the single global guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<EstateProRequest>();

    const token = await this.verifier.verify(this.bearerToken(req));
    const user = await this.identity.resolveUser(token);
    req.auth = { user, token };

    if (this.reflector.getAllAndOverride<boolean>(NO_COMPANY_CONTEXT, targets)) return true;

    const companyId = req.header('x-company-id');
    if (companyId === undefined || !UUID.test(companyId)) {
      throw Problems.validation([
        { field: 'X-Company-Id', code: 'required', message: 'Send the X-Company-Id header with the company you are working in.' },
      ]);
    }

    const membership = await this.identity.resolveMembership(user.id, companyId.toLowerCase());
    if (!membership) throw Problems.forbidden('You are not an active member of this company.');

    if (BLOCKED_STATUSES.has(membership.companyStatus)) {
      throw Problems.companyInactive('This company account is suspended or cancelled.');
    }
    if (membership.companyStatus === 'read_only' && !READ_METHODS.has(req.method)) {
      throw Problems.companyInactive('This company account is read-only. Changes cannot be saved.');
    }
    if (membership.membershipType !== 'staff') {
      // Portal users have their own endpoints (Phase 7); staff endpoints are closed to them.
      throw Problems.forbidden('This area is for company staff only.');
    }
    if ((membership.mfaRequired || MFA_ROLES.has(membership.roleKey)) && !this.verifier.hasMfa(token)) {
      throw Problems.mfaRequired();
    }

    req.tenant = {
      companyId: companyId.toLowerCase(),
      userId: user.id,
      membershipId: membership.membershipId,
      membershipType: membership.membershipType,
      roleKey: membership.roleKey,
      contactId: membership.contactId,
      officeIds: membership.officeIds,
      permissions: membership.permissions,
      requestId: req.requestId,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    };

    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_PERMISSION, targets);
    if (required !== undefined) {
      const grant = membership.permissions.get(required);
      if (!grant) throw Problems.forbidden();
      if (grant.isSensitive && !this.verifier.hasRecentMfa(token)) {
        throw Problems.mfaRequired('This action needs a recent sign-in with a second factor. Sign in again and retry.');
      }
      req.permissionScope = grant.scope;
    }
    return true;
  }

  private bearerToken(req: EstateProRequest): string {
    const header = req.header('authorization');
    const match = header !== undefined ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match?.[1]) throw Problems.unauthenticated();
    return match[1];
  }
}
