import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { Problems } from '../common/problem.js';
import type { AuthenticatedUser, GrantedPermission, PermissionScope } from '../common/request-context.js';
import { AuthDb } from '../database/database.module.js';
import type { VerifiedToken } from './token-verifier.service.js';

export interface ResolvedMembership {
  membershipId: string;
  membershipType: 'staff' | 'portal';
  contactId: string | null;
  mfaRequired: boolean;
  roleKey: string;
  companyStatus: string;
  officeIds: string[];
  permissions: Map<string, GrantedPermission>;
}

export interface MembershipSummary {
  membershipId: string;
  companyId: string;
  companyName: string;
  companyStatus: string;
  roleKey: string;
  roleName: string;
  membershipType: 'staff' | 'portal';
}

/** Maps IdP identities to EstatePro users and resolves company memberships (ADR-001 §3–4). */
@Injectable()
export class IdentityService {
  constructor(
    private readonly authDb: AuthDb,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async resolveUser(token: VerifiedToken): Promise<AuthenticatedUser> {
    const db = this.authDb.db;
    const provider = this.config.OIDC_PROVIDER;

    const linked = await db
      .selectFrom('externalIdentities as ei')
      .innerJoin('users as u', 'u.id', 'ei.userId')
      .select(['u.id', 'u.email', 'u.displayName', 'u.status'])
      .where('ei.provider', '=', provider)
      .where('ei.subject', '=', token.subject)
      .executeTakeFirst();

    if (linked) return this.assertUsable(linked);

    // First sign-in: link to an existing EstatePro user by verified email only.
    const email = token.email;
    if (email === null || !token.emailVerified) {
      throw Problems.forbidden('No EstatePro account is linked to this sign-in. Ask your company administrator for an invitation.');
    }

    return db.transaction().execute(async (tx) => {
      const user = await tx
        .selectFrom('users')
        .select(['id', 'email', 'displayName', 'status'])
        .where('email', '=', email)
        .forUpdate()
        .executeTakeFirst();
      if (!user) {
        throw Problems.forbidden('No EstatePro account exists for this email address. Ask your company administrator for an invitation.');
      }

      const existingForProvider = await tx
        .selectFrom('externalIdentities')
        .select('subject')
        .where('userId', '=', user.id)
        .where('provider', '=', provider)
        .executeTakeFirst();
      if (existingForProvider) {
        // The account is already linked to a different identity at this IdP.
        throw Problems.forbidden('This EstatePro account is linked to a different sign-in. Contact support.');
      }

      await tx
        .insertInto('externalIdentities')
        .values({ userId: user.id, provider, subject: token.subject })
        .onConflict((oc) => oc.columns(['provider', 'subject']).doNothing())
        .execute();

      if (user.status === 'pending') {
        await tx
          .updateTable('users')
          .set({ status: 'active', emailVerifiedAt: new Date() })
          .where('id', '=', user.id)
          .execute();
        return this.assertUsable({ ...user, status: 'active' });
      }
      return this.assertUsable(user);
    });
  }

  async resolveMembership(userId: string, companyId: string): Promise<ResolvedMembership | null> {
    const db = this.authDb.db;
    const membership = await db
      .selectFrom('companyMemberships as m')
      .innerJoin('companies as c', 'c.id', 'm.companyId')
      .innerJoin('roles as r', 'r.id', 'm.roleId')
      .select([
        'm.id as membershipId',
        'm.membershipType',
        'm.contactId',
        'm.mfaRequired',
        'm.roleId',
        'r.key as roleKey',
        'c.status as companyStatus',
      ])
      .where('m.userId', '=', userId)
      .where('m.companyId', '=', companyId)
      .where('m.status', '=', 'active')
      .where('r.archivedAt', 'is', null)
      .executeTakeFirst();
    if (!membership) return null;

    const [grants, offices] = await Promise.all([
      db
        .selectFrom('rolePermissions as rp')
        .innerJoin('permissions as p', 'p.key', 'rp.permissionKey')
        .select(['rp.permissionKey', 'rp.scope', 'p.isSensitive'])
        .where('rp.roleId', '=', membership.roleId)
        .execute(),
      db
        .selectFrom('membershipOffices')
        .select('officeId')
        .where('membershipId', '=', membership.membershipId)
        .where('companyId', '=', companyId)
        .execute(),
    ]);

    return {
      membershipId: membership.membershipId,
      membershipType: membership.membershipType as 'staff' | 'portal',
      contactId: membership.contactId,
      mfaRequired: membership.mfaRequired,
      roleKey: membership.roleKey,
      companyStatus: membership.companyStatus,
      officeIds: offices.map((office) => office.officeId),
      permissions: new Map(
        grants.map((grant) => [
          grant.permissionKey,
          { scope: grant.scope as PermissionScope, isSensitive: grant.isSensitive },
        ]),
      ),
    };
  }

  async listMemberships(userId: string): Promise<MembershipSummary[]> {
    const rows = await this.authDb.db
      .selectFrom('companyMemberships as m')
      .innerJoin('companies as c', 'c.id', 'm.companyId')
      .innerJoin('roles as r', 'r.id', 'm.roleId')
      .select([
        'm.id as membershipId',
        'c.id as companyId',
        'c.legalName',
        'c.tradingName',
        'c.status as companyStatus',
        'r.key as roleKey',
        'r.name as roleName',
        'm.membershipType',
      ])
      .where('m.userId', '=', userId)
      .where('m.status', '=', 'active')
      .orderBy('c.legalName')
      .execute();

    return rows.map((row) => ({
      membershipId: row.membershipId,
      companyId: row.companyId,
      companyName: row.tradingName ?? row.legalName,
      companyStatus: row.companyStatus,
      roleKey: row.roleKey,
      roleName: row.roleName,
      membershipType: row.membershipType as 'staff' | 'portal',
    }));
  }

  private assertUsable(user: { id: string; email: string; displayName: string; status: string }): AuthenticatedUser {
    if (user.status === 'locked' || user.status === 'disabled') {
      throw Problems.forbidden('This EstatePro account is disabled. Contact your company administrator.');
    }
    return { id: user.id, email: user.email, displayName: user.displayName };
  }
}
