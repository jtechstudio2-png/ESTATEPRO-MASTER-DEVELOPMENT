import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseProvisionArgs } from '../src/cli/provision-company-args.js';
import { ProvisioningError } from '../src/provisioning/provisioning.service.js';
import { Fixtures } from './support/fixtures.js';

describe('company provisioning (audit IS-5)', () => {
  let fx: Fixtures;
  let staffEmail: string;

  beforeAll(async () => {
    fx = new Fixtures();
    staffEmail = await fx.platformStaff();
  });

  afterAll(async () => {
    await fx.close();
  });

  const input = (overrides: Record<string, unknown> = {}) => {
    const suffix = fx.uniqueSuffix();
    return {
      staffEmail,
      legalName: `Doha Realty ${suffix} WLL`,
      slug: `doha-realty-${suffix}`,
      countryCode: 'QA',
      dataRegion: 'me-central',
      office: { code: 'WB', name: 'West Bay' },
      owner: { email: `owner-${suffix}@doha.test`, displayName: 'Fatima Al-Thani' },
      ...overrides,
    };
  };

  it('creates the company, office, owner membership, defaults, audit event and outbox event', async () => {
    const result = await fx.provisioning.provisionCompany(input());

    const company = await fx.db.selectFrom('companies').selectAll().where('id', '=', result.companyId).executeTakeFirstOrThrow();
    expect(company).toMatchObject({
      status: 'trial',
      baseCurrencyCode: 'QAR',
      defaultLocaleCode: 'ar-QA',
      defaultTimezone: 'Asia/Qatar',
      headquartersCountryCode: 'QA',
    });
    expect(company.trialEndsAt).toBeInstanceOf(Date);

    const office = await fx.db.selectFrom('offices').selectAll().where('id', '=', result.officeId).executeTakeFirstOrThrow();
    expect(office).toMatchObject({ isHeadOffice: true, jurisdictionCode: 'QA', workingDays: [1, 2, 3, 4, 7] });

    const membership = await fx.db
      .selectFrom('companyMemberships as m')
      .innerJoin('roles as r', 'r.id', 'm.roleId')
      .select(['r.key', 'm.status', 'm.mfaRequired'])
      .where('m.id', '=', result.ownerMembershipId)
      .executeTakeFirstOrThrow();
    expect(membership).toEqual({ key: 'company_owner', status: 'active', mfaRequired: true });

    const owner = await fx.db.selectFrom('users').select(['status', 'localeCode']).where('id', '=', result.ownerUserId).executeTakeFirstOrThrow();
    expect(owner).toEqual({ status: 'pending', localeCode: 'ar-QA' });

    const sequences = await fx.db.selectFrom('numberSequences').select('sequenceKey').where('companyId', '=', result.companyId).execute();
    expect(sequences.map((s) => s.sequenceKey)).toEqual(expect.arrayContaining(['property', 'unit', 'listing']));

    const audit = await fx.db.selectFrom('auditLogs').selectAll().where('companyId', '=', result.companyId).execute();
    expect(audit).toEqual([expect.objectContaining({ action: 'company.provisioned', actorType: 'platform_staff' })]);

    const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('companyId', '=', result.companyId).execute();
    expect(events).toEqual([{ eventType: 'company.provisioned' }]);

    const billing = await fx.db.selectFrom('billingProfiles').select('billingEmail').where('companyId', '=', result.companyId).executeTakeFirstOrThrow();
    const ownerEmail = await fx.db.selectFrom('users').select('email').where('id', '=', result.ownerUserId).executeTakeFirstOrThrow();
    expect(billing.billingEmail).toBe(ownerEmail.email);
  });

  it('creates an active company without a trial end when status is active', async () => {
    const result = await fx.provisioning.provisionCompany(input({ status: 'active', tradingName: 'Doha Realty' }));
    const company = await fx.db.selectFrom('companies').select(['status', 'trialEndsAt', 'tradingName']).where('id', '=', result.companyId).executeTakeFirstOrThrow();
    expect(company).toEqual({ status: 'active', trialEndsAt: null, tradingName: 'Doha Realty' });
  });

  it('requires an explicit jurisdiction for the United Kingdom', async () => {
    await expect(fx.provisioning.provisionCompany(input({ countryCode: 'GB' }))).rejects.toThrow(/choose one with --jurisdiction \(GB-ENG/);
    const ok = await fx.provisioning.provisionCompany(input({ countryCode: 'GB', jurisdictionCode: 'GB-SCT' }));
    const office = await fx.db.selectFrom('offices').select(['jurisdictionCode', 'currencyCode']).where('id', '=', ok.officeId).executeTakeFirstOrThrow();
    expect(office).toEqual({ jurisdictionCode: 'GB-SCT', currencyCode: 'GBP' });
  });

  it('rejects a jurisdiction from another country', async () => {
    await expect(fx.provisioning.provisionCompany(input({ jurisdictionCode: 'GB-ENG' }))).rejects.toThrow('does not belong to QA');
  });

  it('reuses an existing user as owner', async () => {
    const existing = await fx.member((await fx.company()).companyId, { roleKey: 'agent' });
    const result = await fx.provisioning.provisionCompany(input({ owner: { email: existing.email, displayName: 'Existing' } }));
    expect(result.ownerUserId).toBe(existing.userId);
  });

  it.each([
    ['unknown staff', { staffEmail: 'nobody@estatepro.test' }, 'not active platform staff'],
    ['unsupported country', { countryCode: 'ZZ' }, 'Country ZZ is not supported'],
    ['unsupported currency', { currencyCode: 'XXX' }, 'Currency XXX is not supported'],
    ['unsupported locale', { localeCode: 'fr-FR' }, 'Locale fr-FR is not supported'],
    ['invalid timezone', { timezone: 'Mars/Olympus' }, 'not a valid IANA time zone'],
    ['invalid input', { slug: 'Bad Slug' }, 'slug'],
  ])('rejects %s', async (_name, overrides, message) => {
    await expect(fx.provisioning.provisionCompany(input(overrides))).rejects.toThrow(message);
  });

  it('rejects support staff (only owners and super admins may provision)', async () => {
    const support = await fx.platformStaff('support');
    await expect(fx.provisioning.provisionCompany(input({ staffEmail: support }))).rejects.toBeInstanceOf(ProvisioningError);
  });

  it('rejects a slug already in use', async () => {
    const first = input();
    await fx.provisioning.provisionCompany(first);
    await expect(fx.provisioning.provisionCompany({ ...input(), slug: first.slug })).rejects.toThrow('already in use');
  });

  it('rejects a disabled owner account', async () => {
    const member = await fx.member((await fx.company()).companyId, { roleKey: 'agent', userStatus: 'disabled' });
    await expect(
      fx.provisioning.provisionCompany(input({ owner: { email: member.email, displayName: 'Disabled Owner' } })),
    ).rejects.toThrow('is disabled');
  });

  it('rolls back everything when a step fails', async () => {
    const slug = `rollback-${fx.uniqueSuffix()}`;
    await expect(fx.provisioning.provisionCompany(input({ slug, timezone: 'Not/AZone' }))).rejects.toThrow();
    const company = await fx.db.selectFrom('companies').select('id').where('slug', '=', slug).executeTakeFirst();
    expect(company).toBeUndefined();
  });
});

describe('provision-company command-line arguments', () => {
  it('maps flags to provisioning input', () => {
    const parsed = parseProvisionArgs([
      '--staff-email', 'ops@estatepro.test',
      '--legal-name', 'Accra Homes Ltd',
      '--trading-name', 'Accra Homes',
      '--slug', 'accra-homes',
      '--country', 'GH',
      '--jurisdiction', 'GH',
      '--currency', 'GHS',
      '--locale', 'en-GH',
      '--timezone', 'Africa/Accra',
      '--data-region', 'eu-west',
      '--business-types', 'agency, property_manager',
      '--status', 'active',
      '--trial-days', '14',
      '--office-code', 'OSU',
      '--office-name', 'Osu',
      '--owner-email', 'ama@accrahomes.test',
      '--owner-name', 'Ama Mensah',
    ]);
    expect(parsed).toEqual({
      staffEmail: 'ops@estatepro.test',
      legalName: 'Accra Homes Ltd',
      tradingName: 'Accra Homes',
      slug: 'accra-homes',
      countryCode: 'GH',
      jurisdictionCode: 'GH',
      currencyCode: 'GHS',
      localeCode: 'en-GH',
      timezone: 'Africa/Accra',
      dataRegion: 'eu-west',
      businessTypes: ['agency', 'property_manager'],
      status: 'active',
      trialDays: 14,
      office: { code: 'OSU', name: 'Osu' },
      owner: { email: 'ama@accrahomes.test', displayName: 'Ama Mensah' },
    });
  });

  it('leaves missing values for the service to reject', () => {
    const parsed = parseProvisionArgs([]);
    expect(parsed).toMatchObject({ staffEmail: '', slug: '', trialDays: undefined, businessTypes: undefined });
  });

  it('rejects unknown flags', () => {
    expect(() => parseProvisionArgs(['--colour', 'blue'])).toThrow();
  });
});
