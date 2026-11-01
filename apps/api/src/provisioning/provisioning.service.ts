import { sql } from 'kysely';
import { z } from 'zod';

import type { Db } from '../database/database.module.js';

const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const PROVISIONING_ROLES = ['platform_owner', 'super_admin'];

export const provisionCompanySchema = z.object({
  staffEmail: z.email(),
  legalName: z.string().trim().min(2).max(200),
  tradingName: z.string().trim().min(1).max(200).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  jurisdictionCode: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/).optional(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  localeCode: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).optional(),
  timezone: z.string().min(1).max(64).optional(),
  dataRegion: z.string().regex(/^[a-z0-9-]{2,32}$/),
  businessTypes: z
    .array(z.enum(['agency', 'property_manager', 'developer', 'landlord', 'broker']))
    .min(1)
    .default(['agency']),
  status: z.enum(['trial', 'active']).default('trial'),
  trialDays: z.number().int().min(1).max(90).default(30),
  /** Plan whose entitlements (for example the media storage quota) apply until billing (Phase 14) takes over. */
  planCode: z.string().regex(/^[a-z][a-z0-9_]*$/).default('starter'),
  office: z.object({
    code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,15}$/),
    name: z.string().trim().min(2).max(120),
  }),
  owner: z.object({
    email: z.email(),
    displayName: z.string().trim().min(2).max(120),
  }),
});

export type ProvisionCompanyInput = z.input<typeof provisionCompanySchema>;

export interface ProvisionCompanyResult {
  companyId: string;
  officeId: string;
  ownerUserId: string;
  ownerMembershipId: string;
}

export class ProvisioningError extends Error {}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a pilot company with its head office and owner (audit item IS-5).
 * Runs with the estatepro_platform role, performed by named platform staff,
 * and records an audit event in the new company's audit log.
 */
export class ProvisioningService {
  constructor(private readonly platformDb: Db) {}

  async provisionCompany(rawInput: ProvisionCompanyInput): Promise<ProvisionCompanyResult> {
    const parsed = provisionCompanySchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new ProvisioningError(
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }
    const input = parsed.data;

    return this.platformDb.transaction().execute(async (tx) => {
      const staff = await tx
        .selectFrom('platformStaff as ps')
        .innerJoin('users as u', 'u.id', 'ps.userId')
        .select(['u.id', 'ps.role'])
        .where('u.email', '=', input.staffEmail)
        .where('ps.isActive', '=', true)
        .executeTakeFirst();
      if (!staff || !PROVISIONING_ROLES.includes(staff.role)) {
        throw new ProvisioningError(`${input.staffEmail} is not active platform staff allowed to provision companies.`);
      }

      const country = await tx
        .selectFrom('countries')
        .selectAll()
        .where('code', '=', input.countryCode)
        .where('isActive', '=', true)
        .executeTakeFirst();
      if (!country) throw new ProvisioningError(`Country ${input.countryCode} is not supported.`);

      const jurisdictionCode = await this.resolveJurisdiction(tx, input.countryCode, input.jurisdictionCode);
      const currencyCode = input.currencyCode ?? country.defaultCurrencyCode;
      const localeCode = input.localeCode ?? country.defaultLocaleCode;
      const timezone = input.timezone ?? country.defaultTimezone;
      if (!isValidTimezone(timezone)) throw new ProvisioningError(`${timezone} is not a valid IANA time zone.`);

      const currency = await tx.selectFrom('currencies').select('code').where('code', '=', currencyCode).where('isActive', '=', true).executeTakeFirst();
      if (!currency) throw new ProvisioningError(`Currency ${currencyCode} is not supported.`);
      const locale = await tx.selectFrom('locales').select('code').where('code', '=', localeCode).where('isActive', '=', true).executeTakeFirst();
      if (!locale) throw new ProvisioningError(`Locale ${localeCode} is not supported.`);

      const slugTaken = await tx.selectFrom('companies').select('id').where('slug', '=', input.slug).executeTakeFirst();
      if (slugTaken) throw new ProvisioningError(`The company slug "${input.slug}" is already in use.`);

      const company = await tx
        .insertInto('companies')
        .values({
          legalName: input.legalName,
          tradingName: input.tradingName ?? null,
          slug: input.slug,
          status: input.status,
          businessTypes: input.businessTypes,
          headquartersCountryCode: input.countryCode,
          baseCurrencyCode: currencyCode,
          defaultLocaleCode: localeCode,
          defaultTimezone: timezone,
          dataRegion: input.dataRegion,
          trialEndsAt: input.status === 'trial' ? sql<Date>`now() + make_interval(days => ${input.trialDays})` : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('billingProfiles')
        .values({ companyId: company.id, billingEmail: input.owner.email, billingName: input.legalName })
        .execute();

      const plan = await tx.selectFrom('plans').select('code').where('code', '=', input.planCode).where('isActive', '=', true).executeTakeFirst();
      if (!plan) throw new ProvisioningError(`Plan ${input.planCode} does not exist.`);
      await tx
        .insertInto('subscriptions')
        .values({
          companyId: company.id,
          planCode: plan.code,
          status: input.status === 'trial' ? 'trialing' : 'active',
          billingInterval: 'month',
          currencyCode,
          currentPeriodStart: sql<Date>`now()`,
          currentPeriodEnd: input.status === 'trial' ? sql<Date>`now() + make_interval(days => ${input.trialDays})` : null,
        })
        .execute();

      const address = await tx
        .insertInto('addresses')
        .values({ companyId: company.id, countryCode: input.countryCode })
        .returning('id')
        .executeTakeFirstOrThrow();

      const weekend = new Set(country.weekendDays);
      const office = await tx
        .insertInto('offices')
        .values({
          companyId: company.id,
          code: input.office.code,
          name: input.office.name,
          countryCode: input.countryCode,
          jurisdictionCode,
          currencyCode,
          localeCode,
          timezone,
          workingDays: ISO_WEEKDAYS.filter((day) => !weekend.has(day)),
          addressId: address.id,
          isHeadOffice: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await sql`select app.provision_company_defaults(${company.id}::uuid)`.execute(tx);

      const existingOwner = await tx.selectFrom('users').select(['id', 'status']).where('email', '=', input.owner.email).executeTakeFirst();
      if (existingOwner && (existingOwner.status === 'locked' || existingOwner.status === 'disabled')) {
        throw new ProvisioningError(`The user ${input.owner.email} is ${existingOwner.status}.`);
      }
      const ownerUserId =
        existingOwner?.id ??
        (
          await tx
            .insertInto('users')
            .values({ email: input.owner.email, displayName: input.owner.displayName, status: 'pending', localeCode })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;

      const ownerRole = await tx
        .selectFrom('roles')
        .select('id')
        .where('key', '=', 'company_owner')
        .where('companyId', 'is', null)
        .executeTakeFirstOrThrow();

      const membership = await tx
        .insertInto('companyMemberships')
        .values({
          companyId: company.id,
          userId: ownerUserId,
          roleId: ownerRole.id,
          membershipType: 'staff',
          status: 'active',
          mfaRequired: true,
          joinedAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('membershipOffices')
        .values({ companyId: company.id, membershipId: membership.id, officeId: office.id, isPrimary: true })
        .execute();

      await tx
        .insertInto('auditLogs')
        .values({
          companyId: company.id,
          actorType: 'platform_staff',
          actorUserId: staff.id,
          action: 'company.provisioned',
          entityType: 'company',
          entityId: company.id,
          metadata: JSON.stringify({ slug: input.slug, ownerEmail: input.owner.email, officeId: office.id, planCode: plan.code }),
        })
        .execute();

      await tx
        .insertInto('outboxEvents')
        .values({
          companyId: company.id,
          eventType: 'company.provisioned',
          aggregateType: 'company',
          aggregateId: company.id,
          payload: JSON.stringify({ companyId: company.id, ownerUserId, officeId: office.id }),
        })
        .execute();

      return { companyId: company.id, officeId: office.id, ownerUserId, ownerMembershipId: membership.id };
    });
  }

  private async resolveJurisdiction(db: Db, countryCode: string, requested: string | undefined): Promise<string> {
    const jurisdictions = await db
      .selectFrom('jurisdictions')
      .select(['code', 'parentCode'])
      .where('countryCode', '=', countryCode)
      .where('isActive', '=', true)
      .execute();
    if (requested !== undefined) {
      if (!jurisdictions.some((j) => j.code === requested)) {
        throw new ProvisioningError(`Jurisdiction ${requested} does not belong to ${countryCode}.`);
      }
      return requested;
    }
    const hasSubdivisions = jurisdictions.some((j) => j.parentCode !== null);
    if (hasSubdivisions) {
      const options = jurisdictions.filter((j) => j.parentCode !== null).map((j) => j.code).join(', ');
      throw new ProvisioningError(`${countryCode} has several legal jurisdictions; choose one with --jurisdiction (${options}).`);
    }
    const root = jurisdictions.find((j) => j.code === countryCode);
    if (!root) throw new ProvisioningError(`No jurisdiction is configured for ${countryCode}.`);
    return root.code;
  }
}
