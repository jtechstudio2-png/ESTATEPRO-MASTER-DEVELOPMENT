import { randomUUID } from 'node:crypto';

import { inject } from 'vitest';

import { createKysely, type Db } from '../../src/database/database.module.js';
import { type ProvisionCompanyInput, ProvisioningService } from '../../src/provisioning/provisioning.service.js';

/**
 * Test data built with the platform role (bypasses RLS) and the real
 * provisioning service. Names are randomised so test files never collide.
 */
export class Fixtures {
  readonly db: Db;
  readonly provisioning: ProvisioningService;
  private staffEmail: string | null = null;

  constructor() {
    this.db = createKysely(inject('databaseUrls').platform, 2, 'estatepro-tests');
    this.provisioning = new ProvisioningService(this.db);
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  uniqueSuffix(): string {
    return randomUUID().slice(0, 8);
  }

  async platformStaff(role: 'platform_owner' | 'super_admin' | 'support' = 'super_admin'): Promise<string> {
    if (this.staffEmail !== null && role === 'super_admin') return this.staffEmail;
    const email = `staff-${role}-${this.uniqueSuffix()}@estatepro.test`;
    const user = await this.db
      .insertInto('users')
      .values({ email, displayName: `Platform ${role}`, status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.db.insertInto('platformStaff').values({ userId: user.id, role }).execute();
    if (role === 'super_admin') this.staffEmail = email;
    return email;
  }

  async company(overrides: Partial<ProvisionCompanyInput> = {}) {
    const suffix = this.uniqueSuffix();
    const ownerEmail = `owner-${suffix}@company.test`;
    const result = await this.provisioning.provisionCompany({
      staffEmail: await this.platformStaff(),
      legalName: `Test Agency ${suffix} Ltd`,
      slug: `test-agency-${suffix}`,
      countryCode: 'GH',
      dataRegion: 'eu-west',
      status: 'active',
      office: { code: 'HQ', name: 'Head office' },
      owner: { email: ownerEmail, displayName: `Owner ${suffix}` },
      ...overrides,
    });
    return { ...result, ownerEmail };
  }

  async office(companyId: string, code: string, countryCode = 'GH', jurisdictionCode = 'GH') {
    const country = await this.db.selectFrom('countries').selectAll().where('code', '=', countryCode).executeTakeFirstOrThrow();
    return this.db
      .insertInto('offices')
      .values({
        companyId,
        code,
        name: `Office ${code}`,
        countryCode,
        jurisdictionCode,
        currencyCode: country.defaultCurrencyCode,
        localeCode: country.defaultLocaleCode,
        timezone: country.defaultTimezone,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  async member(
    companyId: string,
    options: {
      roleKey: string;
      officeIds?: string[];
      email?: string;
      status?: 'invited' | 'active' | 'suspended' | 'ended';
      mfaRequired?: boolean;
      membershipType?: 'staff' | 'portal';
      userStatus?: 'pending' | 'active' | 'locked' | 'disabled';
    },
  ) {
    const email = options.email ?? `${options.roleKey}-${this.uniqueSuffix()}@company.test`;
    const existing = await this.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    const userId =
      existing?.id ??
      (
        await this.db
          .insertInto('users')
          .values({ email, displayName: `${options.roleKey} user`, status: options.userStatus ?? 'active' })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const role = await this.db
      .selectFrom('roles')
      .select('id')
      .where('key', '=', options.roleKey)
      .where('companyId', 'is', null)
      .executeTakeFirstOrThrow();

    let contactId: string | null = null;
    if (options.membershipType === 'portal') {
      const contact = await this.db
        .insertInto('contacts')
        .values({ companyId, contactType: 'person', displayName: `Portal ${options.roleKey}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      contactId = contact.id;
    }

    const membership = await this.db
      .insertInto('companyMemberships')
      .values({
        companyId,
        userId,
        roleId: role.id,
        membershipType: options.membershipType ?? 'staff',
        contactId,
        status: options.status ?? 'active',
        mfaRequired: options.mfaRequired ?? false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const officeId of options.officeIds ?? []) {
      await this.db.insertInto('membershipOffices').values({ companyId, membershipId: membership.id, officeId }).execute();
    }
    return { userId, membershipId: membership.id, email };
  }

  /** Links an IdP subject to a user, as happens on first sign-in. */
  async linkIdentity(userId: string, subject: string, provider = 'test-idp'): Promise<void> {
    await this.db.insertInto('externalIdentities').values({ userId, provider, subject }).execute();
  }

  async setCompanyStatus(companyId: string, status: 'trial' | 'active' | 'past_due' | 'read_only' | 'suspended' | 'cancelled') {
    await this.db.updateTable('companies').set({ status }).where('id', '=', companyId).execute();
  }

  async setUserStatus(userId: string, status: 'pending' | 'active' | 'locked' | 'disabled') {
    await this.db.updateTable('users').set({ status }).where('id', '=', userId).execute();
  }
}
