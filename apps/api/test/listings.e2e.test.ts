import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Member = Awaited<ReturnType<Fixtures['member']>>;

describe('listings (Phase 4 M3)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  let agentA: Member;
  let agentB: Member;
  let agentKumasi: Member;
  let manager: Member;
  let accountant: Member;
  let technician: Member;
  const tokens: Record<string, string> = {};
  const types: Record<string, string> = {};
  const now = (): number => Math.floor(Date.now() / 1000);

  // Units created through the API in beforeAll.
  let osuProperty: { id: string; version: number };
  let kumasiProperty: { id: string };
  const units: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    agentA = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    agentB = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    agentKumasi = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [kumasiOfficeId] });
    manager = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    technician = await fx.member(company.companyId, { roleKey: 'maintenance_staff' });
    const otherOwner = { userId: other.ownerUserId };

    for (const [name, userId] of Object.entries({
      owner: company.ownerUserId,
      agentA: agentA.userId,
      agentB: agentB.userId,
      agentKumasi: agentKumasi.userId,
      manager: manager.userId,
      accountant: accountant.userId,
      technician: technician.userId,
      otherOwner: otherOwner.userId,
    })) {
      await fx.linkIdentity(userId, `lst-${name}-${company.companyId}`);
      tokens[name] = await t.idp.token({ sub: `lst-${name}-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: now() });
    }
    const typeRows = await fx.db.selectFrom('propertyTypes').select(['id', 'code']).where('companyId', 'is', null).execute();
    for (const row of typeRows) types[row.code] = row.id;

    const address = { countryCode: 'GH', addressLine1: '12 Oxford Street', locality: 'Accra', adminArea1: 'Greater Accra' };
    const osu = await as('owner').post('/api/v1/properties', { name: 'Osu Court', propertyTypeId: types['apartment_building'], officeId: company.officeId, address }).expect(201);
    osuProperty = osu.body;
    for (const label of ['1A', '1B', '1C', '2A', '2B', '2C', '3A', '3B', '3C', '4A', '4B', '4C']) {
      const unit = await as('owner').post(`/api/v1/properties/${osuProperty.id}/units`, { unitLabel: `Flat ${label}`, bedrooms: Number(label[0]) }).expect(201);
      units[label] = unit.body.id;
    }
    const kumasi = await as('owner')
      .post('/api/v1/properties', { name: 'Adum House', propertyTypeId: types['apartment_building'], officeId: kumasiOfficeId, address: { ...address, locality: 'Kumasi', adminArea1: 'Ashanti' }, createWholePropertyUnit: true })
      .expect(201);
    kumasiProperty = kumasi.body;
    const kumasiUnit = await fx.db.selectFrom('units').select('id').where('propertyId', '=', kumasiProperty.id).executeTakeFirstOrThrow();
    units['kumasi'] = kumasiUnit.id;
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  const as = (who: string, companyId?: string) => {
    const cid = () => companyId ?? (who === 'otherOwner' ? other.companyId : company.companyId);
    const auth = <R extends { auth: (token: string, options: { type: 'bearer' }) => R; set: (name: string, value: string) => R }>(req: R) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', cid());
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body?: object) => auth(t.http.post(path)).send(body ?? {}),
      put: (path: string, body: object) => auth(t.http.put(path)).send(body),
      patch: (path: string, body: object, version?: number) => {
        const req = auth(t.http.patch(path)).send(body);
        return version === undefined ? req : req.set('If-Match', `"${version}"`);
      },
      action: (path: string, version: number, body?: object) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body ?? {}),
      putAt: (path: string, version: number, body: object) => auth(t.http.put(path)).set('If-Match', `"${version}"`).send(body),
      del: (path: string, version: number) => auth(t.http.delete(path)).set('If-Match', `"${version}"`),
    };
  };

  const ghs = (amount: string) => ({ amount, currency: 'GHS' });
  const sale = (unitId: string, overrides: Record<string, unknown> = {}) => ({
    unitId,
    listingType: 'sale',
    price: ghs('450000.00'),
    title: '2-bed apartment, Osu',
    description: 'Bright apartment close to Oxford Street.',
    priceQualifierCode: 'negotiable',
    mandateTypeCode: 'sole_agency',
    ...overrides,
  });
  const rental = (unitId: string, overrides: Record<string, unknown> = {}) => ({
    unitId,
    listingType: 'rent',
    price: ghs('6000.00'),
    rentFrequency: 'monthly',
    advanceRentPeriods: 12,
    deposit: ghs('6000.00'),
    title: '2-bed apartment to let, Osu',
    ...overrides,
  });

  type Listing = { id: string; version: number; status: string; reference: string; isPublished: boolean };
  async function create(who: string, body: object): Promise<Listing> {
    const res = await as(who).post('/api/v1/listings', body).expect(201);
    return res.body as Listing;
  }
  async function published(who: string, body: object): Promise<Listing> {
    const draft = await create(who, body);
    return (await as(who).action(`/api/v1/listings/${draft.id}/publish`, draft.version).expect(200)).body as Listing;
  }

  // ------------------------------------------------------------------ seed

  it('seeds the approved listing permissions (D1, G2)', async () => {
    const grants = await fx.db
      .selectFrom('rolePermissions as rp')
      .innerJoin('roles as r', 'r.id', 'rp.roleId')
      .select(['r.key', 'rp.permissionKey', 'rp.scope'])
      .where('r.companyId', 'is', null)
      .where('rp.permissionKey', 'in', ['listing.publish', 'listing.archive'])
      .execute();
    const has = (role: string, key: string, scope: string) => grants.some((g) => g.key === role && g.permissionKey === key && g.scope === scope);
    expect(has('agent', 'listing.publish', 'own')).toBe(true);
    expect(has('company_owner', 'listing.archive', 'all')).toBe(true);
    expect(has('office_admin', 'listing.archive', 'all')).toBe(true);
    expect(has('sales_manager', 'listing.archive', 'office')).toBe(true);
    expect(has('property_manager', 'listing.archive', 'office')).toBe(true);
    expect(grants.some((g) => g.key === 'agent' && g.permissionKey === 'listing.archive')).toBe(false);
  });

  // ------------------------------------------------------------------ create

  describe('creating', () => {
    it('creates a draft sale listing for the agent, with history, audit and defaults', async () => {
      const res = await as('agentA').post('/api/v1/listings', sale(units['1A']!)).expect(201);
      expect(res.headers['etag']).toBe('"1"');
      expect(res.headers['location']).toBe(`/api/v1/listings/${res.body.id}`);
      expect(res.body).toMatchObject({
        listingType: 'sale',
        status: 'draft',
        isPublished: false,
        price: { amount: '450000.00', currency: 'GHS' },
        defaultLocaleCode: 'en-GH',
        office: { id: company.officeId },
        agent: { membershipId: agentA.membershipId },
        unit: { id: units['1A'], unitLabel: 'Flat 1A', bedrooms: 1, availability: 'available' },
        property: { id: osuProperty.id, name: 'Osu Court' },
        listedAt: null,
        translations: [],
        feeTerms: null,
      });
      expect(res.body.reference).toMatch(/^LST-\d{4}-\d{6}$/);
      const status = await as('agentA').get(`/api/v1/listings/${res.body.id}/status-history`).expect(200);
      expect(status.body.data).toEqual([expect.objectContaining({ fromStatus: null, toStatus: 'draft', changedByMembershipId: agentA.membershipId })]);
      const price = await as('agentA').get(`/api/v1/listings/${res.body.id}/price-history`).expect(200);
      expect(price.body.data).toEqual([expect.objectContaining({ oldPrice: null, newPrice: { amount: '450000.00', currency: 'GHS' } })]);
      const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', res.body.id).execute();
      expect(events.map((e) => e.eventType).sort()).toEqual(['listing.created', 'listing.status_changed']);
    });

    it('keeps agents to listings assigned to themselves in their own offices', async () => {
      await as('agentA').post('/api/v1/listings', sale(units['1B']!, { agentMembershipId: agentB.membershipId })).expect(403);
      await as('agentA').post('/api/v1/listings', sale(units['1B']!, { officeId: kumasiOfficeId })).expect(403);
      const hidden = await as('agentA').post('/api/v1/listings', sale(units['kumasi']!)).expect(422);
      expect(hidden.body.errors).toEqual([expect.objectContaining({ field: 'unitId', code: 'not-found' })]);
      await as('technician').post('/api/v1/listings', sale(units['1B']!)).expect(403);
    });

    it('lets managers assign an eligible agent and rejects ineligible ones', async () => {
      const ok = await as('manager').post('/api/v1/listings', sale(units['1B']!, { agentMembershipId: agentB.membershipId })).expect(201);
      expect(ok.body.agent.membershipId).toBe(agentB.membershipId);
      for (const agent of [agentKumasi.membershipId, technician.membershipId, accountant.membershipId, '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b']) {
        const res = await as('manager').post('/api/v1/listings', rental(units['1B']!, { agentMembershipId: agent })).expect(422);
        expect(res.body.errors).toEqual([expect.objectContaining({ field: 'agentMembershipId', code: 'not-eligible' })]);
      }
    });

    it('allows one open listing per unit and type, with a link to the existing one', async () => {
      const first = await create('owner', sale(units['1C']!));
      const clash = await as('owner').post('/api/v1/listings', sale(units['1C']!)).expect(409);
      expect(clash.body.conflictingResource).toEqual({ type: 'listing', id: first.id });
      await as('owner').post('/api/v1/listings', rental(units['1C']!)).expect(201);
    });

    it('validates terms against the listing type, currency and picklists', async () => {
      const saleErrors = await as('owner')
        .post('/api/v1/listings', sale(units['2A']!, { rentFrequency: 'monthly', deposit: ghs('10.00'), price: ghs('10.123'), mandateTypeCode: 'handshake' }))
        .expect(422);
      expect(saleErrors.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`).sort()).toEqual([
        'deposit:not-applicable',
        'mandateTypeCode:unknown-code',
        'price.amount:precision',
        'rentFrequency:not-applicable',
      ]);
      const rentErrors = await as('owner')
        .post('/api/v1/listings', rental(units['2A']!, { rentFrequency: undefined, serviceCharge: ghs('100.00'), mandateSignedOn: '2026-03-01', mandateExpiresOn: '2026-02-30' }))
        .expect(422);
      expect(rentErrors.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`).sort()).toEqual([
        'mandateExpiresOn:invalid',
        'rentFrequency:required',
        'serviceChargeFrequency:pair',
      ]);
      const dates = await as('owner').post('/api/v1/listings', sale(units['2A']!, { mandateSignedOn: '2026-03-01', mandateExpiresOn: '2026-02-01' })).expect(422);
      expect(dates.body.errors).toEqual([expect.objectContaining({ field: 'mandateExpiresOn', code: 'range' })]);
      const currency = await as('owner').post('/api/v1/listings', sale(units['2A']!, { price: { amount: '1.00', currency: 'XXX' }, defaultLocaleCode: 'fr' })).expect(422);
      expect(currency.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['defaultLocaleCode', 'price.currency']);
      const mixed = await as('owner').post('/api/v1/listings', rental(units['2A']!, { deposit: { amount: '100.00', currency: 'USD' } })).expect(422);
      expect(mixed.body.errors).toEqual([expect.objectContaining({ field: 'deposit.currency', code: 'currency-mismatch' })]);
      await as('owner').post('/api/v1/listings', sale(units['2A']!, { price: ghs('-1') })).expect(422);
      await as('owner').post('/api/v1/listings', sale(units['2A']!, { price: '450000.00' })).expect(422);
      await as('owner').post('/api/v1/listings', sale(units['2A']!, { colour: 'blue' })).expect(422);
      await as('owner').post('/api/v1/listings', sale(units['2A']!, { officeId: other.officeId })).expect(422);
      const fee = await as('owner').post('/api/v1/listings', sale(units['2A']!, { feeTerms: { basis: 'fixed', amount: ghs('5000.005'), taxInclusive: false } })).expect(422);
      expect(fee.body.errors).toEqual([expect.objectContaining({ field: 'feeTerms.amount.amount', code: 'precision' })]);
      await as('owner').post('/api/v1/listings', sale(units['2A']!, { feeTerms: { basis: 'percentage', taxInclusive: false } })).expect(422);
    });

    it('applies rental caps from jurisdiction settings, with company and office overrides', async () => {
      await fx.db
        .insertInto('jurisdictionSettings')
        .values({ jurisdictionCode: 'GH', key: 'advance_rent_max_months', value: JSON.stringify(24), effectiveFrom: '2000-01-01', sourceReference: 'test' })
        .execute();
      try {
        const annual = await as('owner').post('/api/v1/listings', rental(units['2A']!, { rentFrequency: 'annual', price: ghs('72000.00'), advanceRentPeriods: 3, deposit: null })).expect(422);
        expect(annual.body.errors).toEqual([expect.objectContaining({ field: 'advanceRentPeriods', code: 'limit' })]);
        await as('owner').post('/api/v1/listings', rental(units['2A']!, { rentFrequency: 'weekly', price: ghs('1500.00'), advanceRentPeriods: 105, deposit: null })).expect(422);
        const weekly = await create('owner', rental(units['2A']!, { rentFrequency: 'weekly', price: ghs('1500.00'), advanceRentPeriods: 104, deposit: null }));
        expect(weekly.status).toBe('draft');

        await fx.db.insertInto('companySettings').values({ companyId: company.companyId, key: 'deposit_max_rent_multiple', value: JSON.stringify(2) }).execute();
        const deposit = await as('owner').post('/api/v1/listings', rental(units['2B']!, { deposit: ghs('18000.00') })).expect(422);
        expect(deposit.body.errors).toEqual([expect.objectContaining({ field: 'deposit', code: 'limit' })]);
        await fx.db.insertInto('companySettings').values({ companyId: company.companyId, officeId: company.officeId, key: 'deposit_max_rent_multiple', value: JSON.stringify('3') }).execute();
        await as('owner').post('/api/v1/listings', rental(units['2B']!, { deposit: ghs('18000.00') })).expect(201);
      } finally {
        await fx.db.deleteFrom('jurisdictionSettings').where('jurisdictionCode', '=', 'GH').where('key', '=', 'advance_rent_max_months').execute();
        await fx.db.deleteFrom('companySettings').where('companyId', '=', company.companyId).where('key', '=', 'deposit_max_rent_multiple').execute();
      }
    });

    it('replays an idempotent create', async () => {
      const key = `listing-${fx.uniqueSuffix()}`;
      const first = await as('owner').post('/api/v1/listings', sale(units['2C']!)).set('Idempotency-Key', key).expect(201);
      const again = await as('owner').post('/api/v1/listings', sale(units['2C']!)).set('Idempotency-Key', key).expect(201);
      expect(again.body.id).toBe(first.body.id);
    });

    it('refuses archived units', async () => {
      const unit = await as('owner').post(`/api/v1/properties/${osuProperty.id}/units`, { unitLabel: 'Store room' }).expect(201);
      await as('owner').action(`/api/v1/units/${unit.body.id}/archive`, 1, { reason: 'Merged' }).expect(200);
      await as('owner').post('/api/v1/listings', sale(unit.body.id)).expect(422);
    });
  });

  // ------------------------------------------------------------------ publishing and status

  describe('publishing and status', () => {
    it('lets agents publish their own listings only (D1), and audits it', async () => {
      const own = await create('agentA', sale(units['3A']!));
      const someoneElses = await create('manager', sale(units['3B']!, { agentMembershipId: agentB.membershipId }));
      await as('agentA').action(`/api/v1/listings/${someoneElses.id}/publish`, 1).expect(403);
      await as('agentA').action(`/api/v1/listings/${own.id}/publish`, 1).expect(200).then((res) => {
        expect(res.body).toMatchObject({ status: 'available', isPublished: true, version: 2 });
        expect(res.body.listedAt).not.toBeNull();
        expect(res.body.publishedAt).not.toBeNull();
      });
      await as('agentA').action(`/api/v1/listings/${own.id}/publish`, 2).expect(422);
      await as('manager').action(`/api/v1/listings/${someoneElses.id}/publish`, 1).expect(200);
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'actorMembershipId']).where('entityId', '=', own.id).where('action', '=', 'listing.published').execute();
      expect(audit).toEqual([{ action: 'listing.published', actorMembershipId: agentA.membershipId }]);

      const hidden = await as('agentA').action(`/api/v1/listings/${own.id}/unpublish`, 2).expect(200);
      expect(hidden.body).toMatchObject({ status: 'available', isPublished: false });
      await as('agentA').action(`/api/v1/listings/${own.id}/unpublish`, 3).expect(422);
      const again = await as('agentA').action(`/api/v1/listings/${own.id}/publish`, 3).expect(200);
      expect(again.body).toMatchObject({ status: 'available', isPublished: true });
      const history = await as('agentA').get(`/api/v1/listings/${own.id}/status-history`).expect(200);
      expect(history.body.data.map((h: { toStatus: string }) => h.toStatus)).toEqual(['draft', 'available']);
    });

    it('blocks publishing with a checklist: unit availability, mandate, seller KYC and required documents', async () => {
      const listing = await create('owner', rental(units['3C']!, { mandateExpiresOn: '2020-01-31' }));
      const unit = await as('owner').get(`/api/v1/units/${units['3C']}`).expect(200);
      await as('owner').action(`/api/v1/units/${units['3C']}/availability`, unit.body.version, { availability: 'unavailable' }).expect(200);
      await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: null, requireSellerKyc: true }).expect(200);
      const rule = await fx.db
        .insertInto('requiredDocumentRules')
        .values({ companyId: company.companyId, jurisdictionCode: 'GH', appliesTo: 'listing', conditions: JSON.stringify({ listing_type: 'rent' }), documentTypeCode: 'safety_certificate', blockingStage: 'available' })
        .returning('id')
        .executeTakeFirstOrThrow();
      try {
        const blocked = await as('owner').action(`/api/v1/listings/${listing.id}/publish`, 1).expect(422);
        expect(blocked.body.type).toBe('urn:estatepro:problem:publish-blocked');
        expect(blocked.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['documents', 'mandateExpiresOn', 'sellerKyc', 'unit.availability']);

        await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: null, requireSellerKyc: false }).expect(200);
        await as('owner').action(`/api/v1/units/${units['3C']}/availability`, unit.body.version + 1, { availability: 'available' }).expect(200);
        const renewed = await as('owner').patch(`/api/v1/listings/${listing.id}`, { mandateExpiresOn: null }, 1).expect(200);
        const document = await fx.db
          .insertInto('documents')
          .values({ companyId: company.companyId, title: 'Gas safety', documentTypeCode: 'safety_certificate', category: 'compliance', expiresOn: '2099-01-01' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await fx.db.insertInto('documentLinks').values({ companyId: company.companyId, documentId: document.id, entityType: 'property', entityId: osuProperty.id }).execute();
        await as('owner').action(`/api/v1/listings/${listing.id}/publish`, renewed.body.version).expect(200);
      } finally {
        await fx.db.deleteFrom('requiredDocumentRules').where('id', '=', rule.id).execute();
      }
    });

    it('follows the approved status model (D3)', async () => {
      const listing = await published('owner', sale(units['4A']!));
      const step = async (version: number, toStatus: string, reason?: string, expected = 200) =>
        as('owner').action(`/api/v1/listings/${listing.id}/status-transitions`, version, { toStatus, ...(reason ? { reason } : {}) }).expect(expected);

      await step(2, 'rented', undefined, 422);
      await step(2, 'draft', undefined, 422);
      await step(2, 'reserved');
      await step(3, 'available', undefined, 422);
      const back = await step(3, 'available', 'Buyer’s mortgage refused');
      expect(back.body).toMatchObject({ status: 'available', isPublished: true });
      await step(4, 'under_contract');
      const sold = await step(5, 'sold');
      expect(sold.body).toMatchObject({ status: 'sold', isPublished: false });
      expect(sold.body.closedAt).not.toBeNull();
      const closed = await step(6, 'available', 'Back on the market', 422);
      expect(closed.body.detail).toContain('Relist');
      await as('owner').patch(`/api/v1/listings/${listing.id}`, { title: 'Changed' }, 6).expect(422);
      await as('owner').action(`/api/v1/listings/${listing.id}/publish`, 6).expect(422);

      const history = await as('owner').get(`/api/v1/listings/${listing.id}/status-history?limit=2`).expect(200);
      expect(history.body.data.map((h: { toStatus: string }) => h.toStatus)).toEqual(['draft', 'available']);
      const next = await as('owner').get(`/api/v1/listings/${listing.id}/status-history?limit=10&cursor=${history.body.page.nextCursor}`).expect(200);
      expect(next.body.data.map((h: { toStatus: string; reason: string | null }) => h.toStatus)).toEqual(['reserved', 'available', 'under_contract', 'sold']);
    });

    it('withdraws with a reason, expires only after the mandate ends, and blocks lettings under maintenance', async () => {
      const draft = await create('owner', sale(units['4B']!));
      await as('owner').action(`/api/v1/listings/${draft.id}/status-transitions`, 1, { toStatus: 'withdrawn' }).expect(422);
      await as('owner').action(`/api/v1/listings/${draft.id}/status-transitions`, 1, { toStatus: 'withdrawn', reason: 'Seller changed mind' }).expect(200);

      const letting = await published('owner', rental(units['4B']!, { mandateExpiresOn: '2099-12-31' }));
      await as('owner').action(`/api/v1/listings/${letting.id}/status-transitions`, 2, { toStatus: 'expired', reason: 'Mandate ended' }).expect(422);
      const unit = await as('owner').get(`/api/v1/units/${units['4B']}`).expect(200);
      const maintenance = await as('owner')
        .action(`/api/v1/units/${units['4B']}/availability`, unit.body.version, { availability: 'under_maintenance', note: 'Roof repair', until: '2099-01-31' })
        .expect(200);
      expect(maintenance.body).toMatchObject({ availability: 'under_maintenance', availabilityNote: 'Roof repair', availabilityUntil: '2099-01-31' });
      const blocked = await as('owner').action(`/api/v1/listings/${letting.id}/status-transitions`, 2, { toStatus: 'reserved' }).expect(422);
      expect(blocked.body.detail).toContain('maintenance');
      const listed = await as('owner').get(`/api/v1/listings/${letting.id}`).expect(200);
      expect(listed.body.unit.availability).toBe('under_maintenance');

      await as('owner').patch(`/api/v1/listings/${letting.id}`, { mandateExpiresOn: '2020-01-31' }, 2).expect(200);
      const expired = await as('owner').action(`/api/v1/listings/${letting.id}/status-transitions`, 3, { toStatus: 'expired', reason: 'Mandate ended' }).expect(200);
      expect(expired.body).toMatchObject({ status: 'expired', isPublished: false });
    });
  });

  // ------------------------------------------------------------------ unit availability

  describe('unit availability', () => {
    it('sets and clears the operational flag with If-Match and an audit entry', async () => {
      const unit = await as('owner').post(`/api/v1/properties/${osuProperty.id}/units`, { unitLabel: 'Flat 5A' }).expect(201);
      const path = `/api/v1/units/${unit.body.id}/availability`;
      await as('owner').post(path, { availability: 'under_maintenance' }).expect(428);
      await as('owner').action(path, 1, { availability: 'broken' }).expect(422);
      await as('owner').action(path, 1, { availability: 'under_maintenance', until: '2026-02-30' }).expect(422);
      await as('agentA').action(path, 1, { availability: 'under_maintenance' }).expect(403);
      const set = await as('owner').action(path, 1, { availability: 'under_maintenance', note: 'Damp', until: '2099-03-01' }).expect(200);
      expect(set.body.version).toBe(2);
      const same = await as('owner').action(path, 2, { availability: 'under_maintenance', note: 'Damp', until: '2099-03-01' }).expect(200);
      expect(same.body.version).toBe(2);
      const cleared = await as('owner').action(path, 2, { availability: 'available', note: 'ignored' }).expect(200);
      expect(cleared.body).toMatchObject({ availability: 'available', availabilityNote: null, availabilityUntil: null, version: 3 });
      await as('owner').action(path, 2, { availability: 'unavailable' }).expect(412);
      const audit = await fx.db.selectFrom('auditLogs').select('changes').where('entityId', '=', unit.body.id).where('action', '=', 'unit.availability_changed').orderBy('occurredAt').execute();
      expect(audit).toHaveLength(2);
      await as('owner').action(`/api/v1/units/${unit.body.id}/archive`, 3, { reason: 'Merged' }).expect(200);
      await as('owner').action(path, 4, { availability: 'available' }).expect(422);
      await as('owner').action('/api/v1/units/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/availability', 1, { availability: 'available' }).expect(404);
    });
  });

  // ------------------------------------------------------------------ editing and price approval

  describe('editing', () => {
    it('requires If-Match, skips no-op edits and records changes', async () => {
      const listing = await create('agentA', sale(units['4C']!, { feeTerms: { basis: 'percentage', rate: '2.5', taxInclusive: false } }));
      const path = `/api/v1/listings/${listing.id}`;
      await as('agentA').patch(path, { title: 'New title' }).expect(428);
      await as('agentA').patch(path, { title: 'New title' }, 9).expect(412);
      const same = await as('agentA').patch(path, { title: '2-bed apartment, Osu', price: ghs('450000'), feeTerms: { basis: 'percentage', rate: '2.5', taxInclusive: false } }, 1).expect(200);
      expect(same.body.version).toBe(1);
      await as('agentA').patch(path, { price: null }, 1).expect(422);
      await as('agentA').patch(path, { officeId: kumasiOfficeId }, 1).expect(403);
      const res = await as('agentA').patch(path, { title: 'New title', description: null, availableFrom: '2026-12-01', price: { amount: '38000.00', currency: 'USD' } }, 1).expect(200);
      expect(res.body).toMatchObject({ title: 'New title', description: null, availableFrom: '2026-12-01', price: { amount: '38000.00', currency: 'USD' }, version: 2 });
      expect(res.body.feeTerms).toEqual({ basis: 'percentage', rate: '2.5', taxInclusive: false });
      const price = await as('agentA').get(`${path}/price-history`).expect(200);
      // A currency change cannot express the old price in the new currency: the reason records it.
      expect(price.body.data[1]).toMatchObject({ oldPrice: null, newPrice: { amount: '38000.00', currency: 'USD' }, reason: 'Currency changed from GHS to USD' });

      const accountantView = await as('accountant').get(path).expect(200);
      expect(accountantView.body.feeTerms).toBeNull();
      await as('accountant').patch(path, { title: 'x' }, 2).expect(403);
      await as('agentB').patch(path, { title: 'Not mine' }, 2).expect(403);
      await as('agentKumasi').get(path).expect(404);
      await as('otherOwner').get(path).expect(404);

      const history = await as('agentA').get(`${path}/history`).expect(200);
      const updated = history.body.data.find((h: { action: string }) => h.action === 'listing.updated');
      expect(updated.changes).toMatchObject({ title: { old: '2-bed apartment, Osu', new: 'New title' }, currencyCode: { old: 'GHS', new: 'USD' } });
      expect(updated.actorName).toBe('agent user');

      await as('owner').action(`${path}/publish`, 2).expect(200);
      const live = await as('owner').patch(path, { price: ghs('38000.00') }, 3).expect(422);
      expect(live.body.detail).toContain('draft');
      const moved = await as('owner').patch(path, { officeId: kumasiOfficeId }, 3).expect(422);
      expect(moved.body.errors[0].field).toBe('officeId');
      await as('owner').patch(path, { feeTerms: null }, 3).expect(200).then((r) => expect(r.body.feeTerms).toBeNull());
    });

    it('requires manager approval for significant price reductions when configured (D2)', async () => {
      const auditBefore = await fx.db.selectFrom('auditLogs').select('id').where('companyId', '=', company.companyId).where('action', '=', 'settings.listings_updated').execute();
      const settings = await as('agentA').get('/api/v1/settings/listings').expect(200);
      expect(settings.body).toEqual({ priceReductionApprovalPercent: null, requireSellerKyc: false, minPhotosToPublish: null, requireFloorPlanToPublish: false });
      await as('agentA').put('/api/v1/settings/listings', { priceReductionApprovalPercent: 10, requireSellerKyc: false }).expect(403);
      await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: 0, requireSellerKyc: false }).expect(422);

      const unit = await as('owner').post(`/api/v1/properties/${osuProperty.id}/units`, { unitLabel: 'Flat 6A' }).expect(201);
      const listing = await published('agentA', sale(unit.body.id, { price: ghs('100000.00') }));
      const path = `/api/v1/listings/${listing.id}`;

      // Off by default: any reduction, with a reason.
      await as('agentA').patch(path, { price: ghs('90000.00') }, 2).expect(422);
      const off = await as('agentA').patch(path, { price: ghs('50000.00'), priceChangeReason: 'No viewings in 6 weeks' }, 2).expect(200);

      const saved = await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: 10, requireSellerKyc: false }).expect(200);
      expect(saved.body).toEqual({ priceReductionApprovalPercent: 10, requireSellerKyc: false, minPhotosToPublish: null, requireFloorPlanToPublish: false });
      await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: 10, requireSellerKyc: false }).expect(200);
      try {
        const within = await as('agentA').patch(path, { price: ghs('45000.00'), priceChangeReason: 'Exactly ten percent' }, off.body.version).expect(200);
        const blocked = await as('agentA').patch(path, { price: ghs('40000.00'), priceChangeReason: 'Quick sale' }, within.body.version).expect(403);
        expect(blocked.body.type).toBe('urn:estatepro:problem:approval-required');
        await as('agentA').patch(path, { price: ghs('60000.00') }, within.body.version).expect(200);
        const approved = await as('manager').patch(path, { price: ghs('40000.00'), priceChangeReason: 'Approved by sales manager' }, within.body.version + 1).expect(200);
        expect(approved.body.price).toEqual({ amount: '40000.00', currency: 'GHS' });
        const history = await as('agentA').get(`${path}/price-history`).expect(200);
        expect(history.body.data.at(-1)).toMatchObject({
          oldPrice: { amount: '60000.00', currency: 'GHS' },
          newPrice: { amount: '40000.00', currency: 'GHS' },
          approvedByMembershipId: manager.membershipId,
          reason: 'Approved by sales manager',
        });
        expect(history.body.data.filter((h: { approvedByMembershipId: string | null }) => h.approvedByMembershipId !== null)).toHaveLength(1);

        // Drafts are not marketed yet: no approval or reason needed.
        const draft = await create('agentA', rental(unit.body.id, { price: ghs('5000.00'), deposit: null }));
        await as('agentA').patch(`/api/v1/listings/${draft.id}`, { price: ghs('1000.00') }, 1).expect(200);
        // Changing a draft's currency requires every amount to be re-entered in it.
        await as('agentA').patch(`/api/v1/listings/${draft.id}`, { deposit: ghs('1000.00') }, 2).expect(200);
        const stale = await as('agentA').patch(`/api/v1/listings/${draft.id}`, { price: { amount: '80.00', currency: 'USD' } }, 3).expect(422);
        expect(stale.body.errors).toEqual([expect.objectContaining({ field: 'deposit', code: 'currency-mismatch' })]);
        const usd = { amount: '80.00', currency: 'USD' };
        await as('agentA').patch(`/api/v1/listings/${draft.id}`, { price: usd, deposit: usd }, 3).expect(200);
      } finally {
        await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: null, requireSellerKyc: false }).expect(200);
      }
      const audit = await fx.db.selectFrom('auditLogs').select('changes').where('companyId', '=', company.companyId).where('action', '=', 'settings.listings_updated').execute();
      expect(audit).toHaveLength(auditBefore.length + 2);
    });
  });

  // ------------------------------------------------------------------ assignment, archive, relist

  describe('assignment, archiving and relisting', () => {
    it('lets only managers and admins reassign listings (D4)', async () => {
      const unit = await as('owner').post(`/api/v1/properties/${osuProperty.id}/units`, { unitLabel: 'Flat 7A' }).expect(201);
      const listing = await create('agentA', sale(unit.body.id));
      const path = `/api/v1/listings/${listing.id}/assign`;
      await as('agentA').action(path, 1, { agentMembershipId: agentB.membershipId }).expect(403);
      await as('manager').action(path, 1, { agentMembershipId: agentKumasi.membershipId }).expect(422);
      const same = await as('manager').action(path, 1, { agentMembershipId: agentA.membershipId }).expect(200);
      expect(same.body.version).toBe(1);
      const moved = await as('manager').action(path, 1, { agentMembershipId: agentB.membershipId, reason: 'Holiday cover' }).expect(200);
      expect(moved.body.agent.membershipId).toBe(agentB.membershipId);
      await as('agentA').patch(`/api/v1/listings/${listing.id}`, { title: 'Still mine?' }, 2).expect(403);
      await as('agentA').get(`/api/v1/listings/${listing.id}`).expect(200);
      await as('agentB').patch(`/api/v1/listings/${listing.id}`, { title: 'Now mine' }, 2).expect(200);
      const event = await fx.db.selectFrom('outboxEvents').select('payload').where('aggregateId', '=', listing.id).where('eventType', '=', 'listing.agent_assigned').executeTakeFirstOrThrow();
      expect(event.payload).toMatchObject({ fromMembershipId: agentA.membershipId, toMembershipId: agentB.membershipId });
    });

    it('archives only drafts and closed listings, and restores them', async () => {
      const unit = await as('owner').post(`/api/v1/properties/${osuProperty.id}/units`, { unitLabel: 'Flat 7B' }).expect(201);
      const live = await published('manager', sale(unit.body.id, { agentMembershipId: agentA.membershipId }));
      const path = `/api/v1/listings/${live.id}`;
      await as('agentA').action(`${path}/archive`, 2, { reason: 'Done' }).expect(403);
      await as('manager').action(`${path}/archive`, 2, { reason: 'Done' }).expect(422);
      await as('manager').action(`${path}/status-transitions`, 2, { toStatus: 'withdrawn', reason: 'Owner withdrew' }).expect(200);
      const archived = await as('manager').action(`${path}/archive`, 3, { reason: 'Clean-up' }).expect(200);
      expect(archived.body.archivedAt).not.toBeNull();
      await as('manager').action(`${path}/archive`, 4, { reason: 'Again' }).expect(422);
      await as('manager').action(`${path}/status-transitions`, 4, { toStatus: 'available', reason: 'x' }).expect(422);
      await as('manager').action(`${path}/publish`, 4).expect(422);
      const list = await as('manager').get(`/api/v1/listings?filter[archived]=true&filter[unitId]=${unit.body.id}`).expect(200);
      expect(list.body.data.map((l: { id: string }) => l.id)).toEqual([live.id]);
      await as('manager').action(`${path}/restore`, 3).expect(412);
      const restored = await as('manager').action(`${path}/restore`, 4).expect(200);
      expect(restored.body.archivedAt).toBeNull();
      await as('manager').action(`${path}/restore`, 5).expect(422);

      const draft = await create('owner', rental(unit.body.id));
      await as('owner').action(`/api/v1/listings/${draft.id}/archive`, 1, { reason: 'Duplicate' }).expect(200);
      await create('owner', rental(unit.body.id));
      const clash = await as('owner').action(`/api/v1/listings/${draft.id}/restore`, 2).expect(409);
      expect(clash.body.conflictingResource.type).toBe('listing');
    });

    it('relists a closed listing as a new draft with its terms and translations (D3)', async () => {
      const unit = await as('owner').post(`/api/v1/properties/${osuProperty.id}/units`, { unitLabel: 'Flat 7C' }).expect(201);
      const first = await published('owner', rental(unit.body.id, { agentMembershipId: agentA.membershipId, mandateSignedOn: '2026-01-01', mandateExpiresOn: '2099-01-01', availableFrom: '2026-02-01' }));
      await as('owner').putAt(`/api/v1/listings/${first.id}/translations/ar-QA`, 2, { title: 'شقة للإيجار', description: 'وصف' }).expect(200);
      await as('owner').post(`/api/v1/listings/${first.id}/relist`).expect(422);
      for (const [version, toStatus] of [[3, 'reserved'], [4, 'under_contract'], [5, 'rented']] as const) {
        await as('owner').action(`/api/v1/listings/${first.id}/status-transitions`, version, { toStatus }).expect(200);
      }
      await as('agentKumasi').post(`/api/v1/listings/${first.id}/relist`).expect(404);
      await as('agentA').post(`/api/v1/listings/${first.id}/relist`, { agentMembershipId: agentB.membershipId }).expect(403);
      const relisted = await as('agentA').post(`/api/v1/listings/${first.id}/relist`).expect(201);
      expect(relisted.body).toMatchObject({
        status: 'draft',
        listingType: 'rent',
        price: { amount: '6000.00', currency: 'GHS' },
        deposit: { amount: '6000.00', currency: 'GHS' },
        rentFrequency: 'monthly',
        advanceRentPeriods: 12,
        mandateSignedOn: null,
        mandateExpiresOn: null,
        availableFrom: null,
        agent: { membershipId: agentA.membershipId },
        translations: [expect.objectContaining({ localeCode: 'ar-QA', title: 'شقة للإيجار' })],
      });
      expect(relisted.body.id).not.toBe(first.id);
      await as('owner').post(`/api/v1/listings/${first.id}/relist`).expect(409);
      const audit = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', first.id).where('action', '=', 'listing.relisted').executeTakeFirstOrThrow();
      expect(audit.metadata).toMatchObject({ newListingId: relisted.body.id });
      const created = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', relisted.body.id).where('action', '=', 'listing.created').executeTakeFirstOrThrow();
      expect(created.metadata).toMatchObject({ relistedFrom: { id: first.id } });
    });
  });

  // ------------------------------------------------------------------ translations

  describe('translations', () => {
    it('saves, replaces and removes translations, bumping the listing version only on change', async () => {
      const unit = await as('owner').post(`/api/v1/properties/${osuProperty.id}/units`, { unitLabel: 'Flat 8A' }).expect(201);
      const listing = await create('agentA', sale(unit.body.id));
      const path = `/api/v1/listings/${listing.id}/translations`;
      await as('agentA').putAt(`${path}/en-GH`, 1, { title: 'Same language' }).expect(422);
      await as('agentA').putAt(`${path}/xx`, 1, { title: 'Unknown' }).expect(404);
      await as('agentA').putAt(`${path}/not a locale`, 1, { title: 'Bad' }).expect(404);
      await as('agentA').putAt(`${path}/ar`, 1, { title: 'x' }).expect(422);
      await as('agentA').put(`${path}/ar`, { title: 'شقة' }).expect(428);
      const saved = await as('agentA').putAt(`${path}/ar`, 1, { title: 'شقة من غرفتين في أوسو', description: 'وصف' }).expect(200);
      expect(saved.body.version).toBe(2);
      expect(saved.body.translations).toEqual([expect.objectContaining({ localeCode: 'ar', title: 'شقة من غرفتين في أوسو', description: 'وصف', source: 'manual' })]);
      const same = await as('agentA').putAt(`${path}/ar`, 2, { title: 'شقة من غرفتين في أوسو', description: 'وصف' }).expect(200);
      expect(same.body.version).toBe(2);
      await as('agentA').putAt(`${path}/ar`, 2, { title: 'شقة جديدة' }).expect(200);

      const search = await as('agentA').get(`/api/v1/listings?q=${encodeURIComponent('شقة جديدة')}`).expect(200);
      expect(search.body.data.map((l: { id: string }) => l.id)).toEqual([listing.id]);

      await as('agentB').putAt(`${path}/ar`, 3, { title: 'Not mine' }).expect(403);
      await as('agentA').del(`${path}/en-GB`, 3).expect(404);
      await as('agentA').del(`${path}/zz zz`, 3).expect(404);
      const removed = await as('agentA').del(`${path}/ar`, 3).expect(204);
      expect(removed.headers['etag']).toBe('"4"');
      const after = await as('agentA').get(`/api/v1/listings/${listing.id}`).expect(200);
      expect(after.body).toMatchObject({ translations: [], version: 4 });
      const actions = await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', listing.id).where('action', 'like', 'listing.translation%').execute();
      expect(actions.map((a) => a.action).sort()).toEqual(['listing.translation_removed', 'listing.translation_saved', 'listing.translation_saved']);
    });
  });

  // ------------------------------------------------------------------ lists

  describe('lists, search and filters', () => {
    it('applies record scope: agents see their offices, accountants everything, technicians nothing', async () => {
      const kumasiListing = await create('owner', sale(units['kumasi']!, { agentMembershipId: agentKumasi.membershipId }));
      const agentList = await as('agentA').get('/api/v1/listings?limit=100&filter[archived]=all').expect(200);
      const ids = agentList.body.data.map((l: { id: string }) => l.id);
      expect(ids).not.toContain(kumasiListing.id);
      expect(agentList.body.data.every((l: { office: { id: string } }) => l.office.id === company.officeId)).toBe(true);
      await as('agentA').get(`/api/v1/listings/${kumasiListing.id}`).expect(404);
      await as('agentA').get(`/api/v1/listings/${kumasiListing.id}/status-history`).expect(404);
      const accountantList = await as('accountant').get('/api/v1/listings?limit=100').expect(200);
      expect(accountantList.body.data.map((l: { id: string }) => l.id)).toContain(kumasiListing.id);
      await as('technician').get('/api/v1/listings').expect(403);
      const otherList = await as('otherOwner').get('/api/v1/listings').expect(200);
      expect(otherList.body.data).toEqual([]);
      await as('agentA').get('/api/v1/listings/not-a-uuid').expect(404);
    });

    it('filters by type, status, publication, office, agent, price, bedrooms and dates', async () => {
      const q = async (query: string) => (await as('owner').get(`/api/v1/listings?limit=100&${query}`).expect(200)).body.data as Array<Record<string, unknown>>;
      const rents = await q('filter[listingType]=rent');
      expect(rents.length).toBeGreaterThan(0);
      expect(rents.every((l) => l['listingType'] === 'rent')).toBe(true);
      const live = await q('filter[status]=available,reserved&filter[isPublished]=true');
      expect(live.every((l) => ['available', 'reserved'].includes(l['status'] as string) && l['isPublished'] === true)).toBe(true);
      expect((await q(`filter[officeId]=${kumasiOfficeId}`)).every((l) => (l['office'] as { id: string }).id === kumasiOfficeId)).toBe(true);
      expect((await q(`filter[agentMembershipId]=${agentB.membershipId}`)).every((l) => (l['agent'] as { membershipId: string }).membershipId === agentB.membershipId)).toBe(true);
      expect((await q(`filter[propertyId]=${kumasiProperty.id}`)).every((l) => (l['property'] as { id: string }).id === kumasiProperty.id)).toBe(true);

      const priced = await q('filter[currencyCode]=GHS&filter[price][gte]=5000&filter[price][lte]=7000');
      expect(priced.length).toBeGreaterThan(0);
      const amountOf = (l: Record<string, unknown>) => l['price'] as { amount: string; currency: string };
      expect(priced.every((l) => Number(amountOf(l).amount) >= 5000 && Number(amountOf(l).amount) <= 7000 && amountOf(l).currency === 'GHS')).toBe(true);
      const noCurrency = await as('owner').get('/api/v1/listings?filter[price][gte]=1').expect(422);
      expect(noCurrency.body.errors[0]).toMatchObject({ field: 'filter[price]', code: 'currency-required' });
      const beds = await q('filter[bedrooms][gte]=3&filter[bedrooms][lte]=3');
      expect(beds.length).toBeGreaterThan(0);
      expect(beds.every((l) => (l['unit'] as { bedrooms: number }).bedrooms === 3)).toBe(true);
      expect(await q('filter[availableFrom][gte]=2026-11-30&filter[availableFrom][lte]=2026-12-01')).toHaveLength(1);
      expect((await q('filter[mandateExpiresOn][gte]=2019-01-01&filter[mandateExpiresOn][lte]=2021-01-01')).length).toBeGreaterThan(0);
      await as('owner').get('/api/v1/listings?filter[status]=gone').expect(422);
      await as('owner').get('/api/v1/listings?sort=-colour').expect(422);
    });

    it('searches by reference and title, and pages through results sorted by price', async () => {
      const all = (await as('owner').get('/api/v1/listings?limit=100').expect(200)).body.data as Array<{ id: string; reference: string }>;
      const target = all[0]!;
      const byRef = await as('owner').get(`/api/v1/listings?q=${target.reference}`).expect(200);
      expect(byRef.body.data.map((l: { id: string }) => l.id)).toEqual([target.id]);
      const byTitle = await as('owner').get('/api/v1/listings?q=TO%20LET&limit=100').expect(200);
      expect(byTitle.body.data.length).toBeGreaterThan(0);
      await as('owner').get('/api/v1/listings?q=50%25_off').expect(200);

      const seen: string[] = [];
      const prices: number[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { data: Array<{ id: string; price: { amount: string } }>; page: { nextCursor: string | null } } } = await as('owner')
          .get(`/api/v1/listings?sort=-price&limit=3${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        for (const row of page.body.data) {
          seen.push(row.id);
          prices.push(Number(row.price.amount));
        }
        cursor = page.body.page.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(all.length);
      expect([...prices].sort((a, b) => b - a)).toEqual(prices);
      await as('owner').get('/api/v1/listings?sort=price&cursor=eyJ2IjoiYWJjIiwiaWQiOiIwMTkwYTFiMi1jM2Q0LTdlNWYtOGE5Yi0wYzFkMmUzZjRhNWIifQ').expect(422);
    });

    it('lists the listings of a visible property or unit only', async () => {
      const forProperty = await as('agentA').get(`/api/v1/properties/${osuProperty.id}/listings?limit=100`).expect(200);
      expect(forProperty.body.data.length).toBeGreaterThan(0);
      expect(forProperty.body.data.every((l: { property: { id: string } }) => l.property.id === osuProperty.id)).toBe(true);
      await as('agentA').get(`/api/v1/properties/${kumasiProperty.id}/listings`).expect(404);
      const forUnit = await as('agentA').get(`/api/v1/units/${units['1C']}/listings?filter[listingType]=sale`).expect(200);
      expect(forUnit.body.data).toHaveLength(1);
      await as('agentA').get(`/api/v1/units/${units['kumasi']}/listings`).expect(404);
      await as('accountant').get(`/api/v1/units/${units['kumasi']}/listings`).expect(200);
      await as('otherOwner').get(`/api/v1/properties/${osuProperty.id}/listings`).expect(404);
    });

    it('hides fee terms in the history from members who cannot edit the listing', async () => {
      const listing = await create('owner', rental(units['3B']!, { feeTerms: { basis: 'fixed', amount: ghs('500.00'), taxInclusive: true } }));
      const edited = await as('owner').patch(`/api/v1/listings/${listing.id}`, { feeTerms: { basis: 'fixed', amount: ghs('750.00'), taxInclusive: true } }, 1).expect(200);
      expect(edited.body.feeTerms).toEqual({ basis: 'fixed', amount: ghs('750.00'), taxInclusive: true });
      const forOwner = await as('owner').get(`/api/v1/listings/${listing.id}/history`).expect(200);
      expect(forOwner.body.data[0].changes.feeTerms.new).toEqual({ basis: 'fixed', amount: '750.00', taxInclusive: true });
      const forAccountant = await as('accountant').get(`/api/v1/listings/${listing.id}/history?limit=1`).expect(200);
      expect(forAccountant.body.data[0].changes.feeTerms).toEqual({ old: '(hidden)', new: '(hidden)' });
      expect(forAccountant.body.page.nextCursor).not.toBeNull();
      const page2 = await as('accountant').get(`/api/v1/listings/${listing.id}/history?limit=1&cursor=${forAccountant.body.page.nextCursor}`).expect(200);
      expect(page2.body.data[0].action).toBe('listing.created');
    });
  });

  it('enforces tenant isolation at the database for listing rows', async () => {
    const count = await sql<{ n: number }>`select count(*)::int as n from listings where company_id = ${other.companyId}::uuid`.execute(fx.db);
    expect(count.rows[0]!.n).toBe(0);
    const res = await as('otherOwner').post('/api/v1/listings', sale(units['1A']!)).expect(422);
    expect(res.body.errors[0].field).toBe('unitId');
  });
});
