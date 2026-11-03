import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

const PLACES = {
  osu: { latitude: 5.5571, longitude: -0.1818 },
  eastLegon: { latitude: 5.635, longitude: -0.16 },
  tema: { latitude: 5.6698, longitude: -0.0166 },
  kumasi: { latitude: 6.6885, longitude: -1.6244 },
};

let phoneCounter = 3000;
const nextPhone = () => `024${String(7000000 + phoneCounter++).padStart(7, '0')}`;

describe('requirements and matching (Phase 5 milestone C2, decision D4)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};
  const types: Record<string, string> = {};
  const units: Record<string, string> = {};
  const listings: Record<string, string> = {};
  let buyerId: string;
  let tenantId: string;

  const as = (who: string, companyId = who === 'otherOwner' ? other.companyId : company.companyId) => {
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      patch: (path: string, body: object, version?: number) => {
        const req = auth(t.http.patch(path)).send(body);
        return version === undefined ? req : req.set('If-Match', `"${version}"`);
      },
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
      delete: (path: string) => auth(t.http.delete(path)),
    };
  };

  async function contact(who: string, overrides: Record<string, unknown> = {}) {
    const res = await as(who).post('/api/v1/contacts', { contactType: 'person', displayName: `Buyer ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number };
  }

  async function requirement(who: string, contactId: string, body: Record<string, unknown>) {
    const res = await as(who).post(`/api/v1/contacts/${contactId}/requirements`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; matchCount: number | null; [key: string]: unknown };
  }

  async function property(key: string, name: string, locality: string, place: { latitude: number; longitude: number }, officeId: string, bedrooms: number, features: string[]) {
    const res = await as('owner')
      .post('/api/v1/properties', {
        name,
        propertyTypeId: types['house_detached'],
        officeId,
        createWholePropertyUnit: true,
        address: { countryCode: 'GH', addressLine1: `${name} Road`, locality, adminArea1: locality === 'Kumasi' ? 'Ashanti' : 'Greater Accra', ...place },
      })
      .expect(201);
    const unit = await fx.db.selectFrom('units').select('id').where('propertyId', '=', res.body.id).executeTakeFirstOrThrow();
    await fx.db.updateTable('units').set({ bedrooms }).where('id', '=', unit.id).execute();
    for (const featureCode of features) await fx.db.insertInto('unitFeatures').values({ companyId: company.companyId, unitId: unit.id, featureCode }).execute();
    units[key] = unit.id;
  }

  async function listing(
    key: string,
    unitKey: string,
    officeId: string,
    values: { listingType?: 'sale' | 'rent'; price: string; currencyCode?: string; rentFrequency?: string; published?: boolean },
  ) {
    const row = await fx.db
      .insertInto('listings')
      .values({
        companyId: company.companyId,
        reference: `LST-R-${randomUUID().slice(0, 8)}`,
        unitId: units[unitKey]!,
        listingType: values.listingType ?? 'sale',
        status: 'available',
        currencyCode: values.currencyCode ?? 'GHS',
        price: values.price,
        rentFrequency: values.rentFrequency ?? null,
        agentMembershipId: company.ownerMembershipId,
        officeId,
        defaultLocaleCode: 'en-GH',
        title: `${key} listing`,
        isPublished: values.published ?? true,
        publishedAt: values.published === false ? null : new Date(Date.now() - Object.keys(listings).length * 60_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    listings[key] = row.id;
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    for (const row of await fx.db.selectFrom('propertyTypes').select(['id', 'code']).where('companyId', 'is', null).execute()) types[row.code] = row.id;

    // A company role that may see contacts but not listings.
    const viewerRole = await fx.db
      .insertInto('roles')
      .values({ companyId: company.companyId, key: 'crm_viewer', name: 'CRM viewer', audience: 'staff' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await fx.db.insertInto('rolePermissions').values({ roleId: viewerRole.id, permissionKey: 'contact.view', scope: 'all' }).execute();
    const viewerUser = await fx.db.insertInto('users').values({ email: `viewer-${randomUUID()}@company.test`, displayName: 'Viewer' }).returning('id').executeTakeFirstOrThrow();
    const viewer = await fx.db
      .insertInto('companyMemberships')
      .values({ companyId: company.companyId, userId: viewerUser.id, roleId: viewerRole.id, membershipType: 'staff', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();

    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      sales: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      salesKsi: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      agent2: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      viewer: { userId: viewerUser.id, membershipId: viewer.id, companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [name, member] of Object.entries(people)) {
      members[name] = member.membershipId;
      await fx.linkIdentity(member.userId, `req-${name}-${member.companyId}`);
      tokens[name] = await t.idp.token({ sub: `req-${name}-${member.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }

    await property('osu', 'Osu House', 'Osu', PLACES.osu, company.officeId, 3, ['parking', 'backup_generator']);
    await property('eastLegon', 'East Legon House', 'East Legon', PLACES.eastLegon, company.officeId, 4, ['parking']);
    await property('tema', 'Tema House', 'Tema', PLACES.tema, company.officeId, 3, ['parking']);
    await property('kumasi', 'Kumasi Villa', 'Kumasi', PLACES.kumasi, kumasiOfficeId, 3, []);
    await property('osuDraft', 'Osu Draft', 'Osu', PLACES.osu, company.officeId, 3, ['parking']);
    await property('osuSmall', 'Osu Flat', 'Osu', PLACES.osu, company.officeId, 2, []);

    await listing('osu', 'osu', company.officeId, { price: '1000000.00' });
    await listing('eastLegon', 'eastLegon', company.officeId, { price: '1150000.00' });
    await listing('temaExpensive', 'tema', company.officeId, { price: '2000000.00' });
    await listing('kumasi', 'kumasi', kumasiOfficeId, { price: '900000.00' });
    await listing('osuDraft', 'osuDraft', company.officeId, { price: '1000000.00', published: false });
    await listing('osuSmall', 'osuSmall', company.officeId, { price: '1000000.00' });
    await listing('osuUsd', 'tema', company.officeId, { listingType: 'rent', price: '1000.00', currencyCode: 'USD', rentFrequency: 'monthly' });
    await listing('osuRentAnnual', 'osu', company.officeId, { listingType: 'rent', price: '72000.00', rentFrequency: 'annual' });
    await listing('eastLegonRent', 'eastLegon', company.officeId, { listingType: 'rent', price: '9000.00', rentFrequency: 'monthly' });

    buyerId = (await contact('owner', { relationships: ['buyer'] })).id;
    tenantId = (await contact('owner', { relationships: ['tenant'] })).id;
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  const buyBrief = () => ({
    requirementType: 'buy',
    currencyCode: 'GHS',
    minPrice: '900000',
    maxPrice: '1200000',
    minBedrooms: 3,
    maxBedrooms: 3,
    propertyTypeIds: [types['house_detached']],
    areas: [
      { kind: 'locality', locality: 'osu' },
      { kind: 'radius', latitude: PLACES.eastLegon.latitude, longitude: PLACES.eastLegon.longitude, radiusMetres: 2000, label: 'Near the school' },
    ],
    mustHaveFeatures: ['parking', 'backup_generator'],
    moveBy: '2027-01-31',
    financingStatus: 'mortgage_approved',
    notes: 'Wants a quiet street',
  });

  describe('recording requirements (B-2)', () => {
    it('records a buy requirement with budget, areas and wanted features, and counts its matches', async () => {
      const created = await requirement('owner', buyerId, buyBrief());
      expect(created).toMatchObject({
        contact: { id: buyerId },
        requirementType: 'buy',
        status: 'active',
        minPrice: { amount: '900000.00', currency: 'GHS' },
        maxPrice: { amount: '1200000.00', currency: 'GHS' },
        minBedrooms: 3,
        areas: [
          { kind: 'locality', locality: 'osu', adminArea1: null, label: null },
          { kind: 'radius', radiusMetres: 2000, label: 'Near the school' },
        ],
        mustHaveFeatures: ['parking', 'backup_generator'],
        matchCount: 2,
        version: 1,
      });
      const audit = await fx.db.selectFrom('auditLogs').selectAll().where('entityId', '=', created.id).where('action', '=', 'requirement.created').execute();
      expect(audit).toHaveLength(1);
      const listed = await as('owner').get(`/api/v1/contacts/${buyerId}/requirements`).expect(200);
      expect(listed.body.map((row: { id: string }) => row.id)).toContain(created.id);
      const single = await as('owner').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}`).expect(200);
      expect(single.headers['etag']).toBe('"1"');
    });

    it('ranks matches by wanted features, type and bedrooms, and explains each one', async () => {
      const created = await requirement('owner', buyerId, buyBrief());
      const res = await as('owner').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}/matches`).expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.rules).toContain('Same currency as the requirement');
      expect(res.body.data.map((m: { listingId: string }) => m.listingId)).toEqual([listings['osu'], listings['eastLegon']]);
      expect(res.body.data[0]).toMatchObject({
        price: { amount: '1000000.00', currency: 'GHS' },
        bedrooms: 3,
        locality: 'Osu',
        score: 4,
        breakdown: { featuresMatched: ['backup_generator', 'parking'], featuresMissing: [], propertyTypeMatched: true, withinMaxBedrooms: true },
      });
      expect(res.body.data[1]).toMatchObject({
        score: 2,
        breakdown: { featuresMatched: ['parking'], featuresMissing: ['backup_generator'], propertyTypeMatched: true, withinMaxBedrooms: false },
      });
      const one = await as('owner').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}/matches?limit=1`).expect(200);
      expect(one.body.data).toHaveLength(1);
      expect(one.body.total).toBe(2);
      await as('owner').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}/matches?limit=0`).expect(422);
    });

    it('matches anywhere without areas, but never unpublished, other-currency or over-budget listings', async () => {
      const created = await requirement('owner', buyerId, { requirementType: 'buy', currencyCode: 'GHS', maxPrice: '1200000' });
      const res = await as('owner').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}/matches`).expect(200);
      const ids = res.body.data.map((m: { listingId: string }) => m.listingId).sort();
      expect(ids).toEqual([listings['osu'], listings['eastLegon'], listings['kumasi'], listings['osuSmall']].sort());
      expect(res.body.data.every((m: { score: number; breakdown: { propertyTypeMatched: null; withinMaxBedrooms: null } }) =>
        m.score === 0 && m.breakdown.propertyTypeMatched === null && m.breakdown.withinMaxBedrooms === null)).toBe(true);
    });

    it('compares rent per the budget period (72,000 a year is 6,000 a month)', async () => {
      const created = await requirement('owner', tenantId, { requirementType: 'rent', currencyCode: 'GHS', maxPrice: '6500', rentFrequency: 'monthly', minBedrooms: 2 });
      const res = await as('owner').get(`/api/v1/contacts/${tenantId}/requirements/${created.id}/matches`).expect(200);
      expect(res.body.data.map((m: { listingId: string }) => m.listingId)).toEqual([listings['osuRentAnnual']]);
      expect(res.body.data[0]).toMatchObject({ listingType: 'rent', rentFrequency: 'annual', price: { amount: '72000.00' } });
      const usd = await requirement('owner', tenantId, { requirementType: 'rent', currencyCode: 'USD', maxPrice: '1500', rentFrequency: 'monthly' });
      expect(usd.matchCount).toBe(1);
    });

    it('matches a drawn area exactly', async () => {
      const square = (place: { latitude: number; longitude: number }, d: number) => [
        [place.longitude - d, place.latitude - d],
        [place.longitude + d, place.latitude - d],
        [place.longitude + d, place.latitude + d],
        [place.longitude - d, place.latitude + d],
      ];
      const created = await requirement('owner', buyerId, { requirementType: 'buy', currencyCode: 'GHS', areas: [{ kind: 'polygon', points: square(PLACES.tema, 0.01) }] });
      expect(created['areas']).toEqual([expect.objectContaining({ kind: 'polygon', points: expect.arrayContaining([square(PLACES.tema, 0.01)[0]]) })]);
      expect((created['areas'] as Array<{ points: number[][] }>)[0]!.points).toHaveLength(5);
      const res = await as('owner').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}/matches`).expect(200);
      expect(res.body.data.map((m: { listingId: string }) => m.listingId)).toEqual([listings['temaExpensive']]);
    });

    it('rejects incomplete or impossible requirements with field errors', async () => {
      const post = (body: object) => as('owner').post(`/api/v1/contacts/${buyerId}/requirements`, body);
      const fields = async (body: object) => {
        const res = await post(body).expect(422);
        return (res.body.errors as Array<{ field: string }>).map((e) => e.field).sort();
      };
      const base = { requirementType: 'buy', currencyCode: 'GHS' };
      expect(await fields({ ...base, minPrice: '10', maxPrice: '5' })).toEqual(['maxPrice']);
      expect(await fields({ ...base, minPrice: '10.555' })).toEqual(['minPrice']);
      expect(await fields({ ...base, rentFrequency: 'monthly' })).toEqual(['rentFrequency']);
      expect(await fields({ requirementType: 'rent', currencyCode: 'GHS', maxPrice: '5000' })).toEqual(['rentFrequency']);
      expect(await fields({ ...base, currencyCode: 'XXX' })).toEqual(['currencyCode']);
      expect(await fields({ ...base, minBedrooms: 4, maxBedrooms: 2 })).toEqual(['maxBedrooms']);
      expect(await fields({ ...base, mustHaveFeatures: ['jacuzzi_on_roof'] })).toEqual(['mustHaveFeatures[0]']);
      expect(await fields({ ...base, propertyTypeIds: [randomUUID()] })).toEqual(['propertyTypeIds']);
      expect(await fields({ ...base, moveBy: '2027-02-30' })).toEqual(['moveBy']);
      expect(await fields({ ...base, areas: [{ kind: 'locality' }] })).toEqual(['areas[0].locality']);
      expect(await fields({ ...base, areas: [{ kind: 'radius', latitude: 95, longitude: 0, radiusMetres: 60_000 }] })).toEqual(['areas[0].latitude', 'areas[0].radiusMetres']);
      expect(await fields({ ...base, areas: [{ kind: 'polygon', points: [[0, 0], [1, 1]] }] })).toEqual(['areas[0].points']);
      const bowTie = [[-0.2, 5.5], [-0.1, 5.6], [-0.1, 5.5], [-0.2, 5.6]];
      const crossed = await post({ ...base, areas: [{ kind: 'polygon', points: bowTie }] }).expect(422);
      expect(crossed.body.errors[0]).toMatchObject({ field: 'areas[0].points', code: 'invalid-polygon' });
      const huge = await post({ ...base, areas: [{ kind: 'polygon', points: [[-3, 5], [1, 5], [1, 9], [-3, 9]] }] }).expect(422);
      expect(huge.body.errors[0]).toMatchObject({ field: 'areas[0].points', code: 'area-too-large' });
      await post({ ...base, areas: Array.from({ length: 11 }, () => ({ kind: 'locality', locality: 'Osu' })) }).expect(422);
      await post({ ...base, unexpected: true }).expect(422);
    });

    it('refuses another company’s property types (row-level security hides them)', async () => {
      const otherType = await fx.db
        .insertInto('propertyTypes')
        .values({ companyId: other.companyId, code: `private_${randomUUID().slice(0, 6)}`, name: 'Other private type', usageClass: 'residential', appliesTo: 'both' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await as('owner').post(`/api/v1/contacts/${buyerId}/requirements`, { requirementType: 'buy', currencyCode: 'GHS', propertyTypeIds: [otherType.id] }).expect(422);
      expect(res.body.errors[0].field).toBe('propertyTypeIds');
    });
  });

  describe('editing (If-Match)', () => {
    it('updates with the current version, audits the changes and pauses matching', async () => {
      const created = await requirement('owner', buyerId, buyBrief());
      await as('owner').patch(`/api/v1/contacts/${buyerId}/requirements/${created.id}`, { maxPrice: '1100000' }).expect(428);
      await as('owner').patch(`/api/v1/contacts/${buyerId}/requirements/${created.id}`, { maxPrice: '1100000' }, 9).expect(412);
      const same = await as('owner').patch(`/api/v1/contacts/${buyerId}/requirements/${created.id}`, { maxPrice: '1200000.00', notes: 'Wants a quiet street' }, 1).expect(200);
      expect(same.body.version).toBe(1);
      const updated = await as('owner').patch(`/api/v1/contacts/${buyerId}/requirements/${created.id}`, { maxPrice: '1100000', areas: [], notes: '' }, 1).expect(200);
      expect(updated.body).toMatchObject({ version: 2, maxPrice: { amount: '1100000.00' }, areas: [], notes: null, matchCount: 2 }); // Osu and Kumasi, now that any area is fine
      expect(updated.headers['etag']).toBe('"2"');
      const audit = await fx.db.selectFrom('auditLogs').selectAll().where('entityId', '=', created.id).where('action', '=', 'requirement.updated').executeTakeFirstOrThrow();
      expect(Object.keys((audit.metadata as { changes: object }).changes).sort()).toEqual(['locations', 'maxPrice', 'notes']);
      const paused = await as('owner').patch(`/api/v1/contacts/${buyerId}/requirements/${created.id}`, { status: 'paused' }, 2).expect(200);
      expect(paused.body).toMatchObject({ status: 'paused', matchCount: 0 });
      const kept = await as('owner').patch(`/api/v1/contacts/${buyerId}/requirements/${created.id}`, { currencyCode: 'USD', minPrice: null, maxPrice: null }, 3).expect(200);
      expect(kept.body).toMatchObject({ currencyCode: 'USD', minPrice: null, areas: [] });
      await as('owner').patch(`/api/v1/contacts/${buyerId}/requirements/${randomUUID()}`, { notes: 'x' }, 1).expect(404);
    });

    it('refuses changes to requirements of archived contacts', async () => {
      const person = await contact('owner');
      const created = await requirement('owner', person.id, { requirementType: 'buy', currencyCode: 'GHS' });
      await as('owner').action(`/api/v1/contacts/${person.id}/archive`, person.version, { reason: 'No longer looking' }).expect(200);
      const res = await as('owner').patch(`/api/v1/contacts/${person.id}/requirements/${created.id}`, { notes: 'x' }, 1).expect(422);
      expect(res.body.type).toContain('business-rule-violated');
      await as('owner').post(`/api/v1/contacts/${person.id}/requirements`, { requirementType: 'buy', currencyCode: 'GHS' }).expect(422);
      // Still readable, but no longer in the register.
      await as('owner').get(`/api/v1/contacts/${person.id}/requirements/${created.id}`).expect(200);
      const register = await as('owner').get(`/api/v1/requirements?filter[contactId]=${person.id}`).expect(200);
      expect(register.body.data).toHaveLength(0);
    });
  });

  describe('not suitable listings (gap G2)', () => {
    it('stops showing a listing marked not suitable, audits it, and can restore it', async () => {
      const created = await requirement('owner', buyerId, buyBrief());
      const base = `/api/v1/contacts/${buyerId}/requirements/${created.id}`;
      const excluded = await as('owner').post(`${base}/exclusions`, { listingId: listings['osu'], reason: 'Too close to the main road' }).expect(201);
      expect(excluded.body).toEqual([
        expect.objectContaining({ listingId: listings['osu'], reason: 'Too close to the main road', excludedBy: { id: members['owner'], name: expect.any(String) } }),
      ]);
      await as('owner').post(`${base}/exclusions`, { listingId: listings['osu'], reason: 'Again' }).expect(409);
      const matches = await as('owner').get(`${base}/matches`).expect(200);
      expect(matches.body.data.map((m: { listingId: string }) => m.listingId)).toEqual([listings['eastLegon']]);
      expect((await as('owner').get(base).expect(200)).body.matchCount).toBe(1);
      const listed = await as('agent').get(`${base}/exclusions`);
      expect(listed.status).toBe(404); // the agent cannot see this contact
      expect((await as('sales').get(`${base}/exclusions`).expect(200)).body).toHaveLength(1);
      const restored = await as('owner').delete(`${base}/exclusions/${listings['osu']}`).expect(200);
      expect(restored.body).toEqual([]);
      await as('owner').delete(`${base}/exclusions/${listings['osu']}`).expect(404);
      const actions = await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', created.id).orderBy('occurredAt').execute();
      expect(actions.map((row) => row.action)).toEqual(['requirement.created', 'requirement.listing_excluded', 'requirement.listing_restored']);
    });

    it('only accepts listings the member can see', async () => {
      const own = await contact('agent');
      const created = await requirement('agent', own.id, { requirementType: 'buy', currencyCode: 'GHS' });
      const base = `/api/v1/contacts/${own.id}/requirements/${created.id}`;
      const res = await as('agent').post(`${base}/exclusions`, { listingId: listings['kumasi'], reason: 'Wrong city' }).expect(422);
      expect(res.body.errors[0].field).toBe('listingId');
      await as('agent').post(`${base}/exclusions`, { listingId: randomUUID(), reason: 'Unknown' }).expect(422);
      await as('agent').post(`${base}/exclusions`, { listingId: listings['osu'], reason: 'Seen it' }).expect(201);
    });
  });

  describe('access and tenant isolation', () => {
    it('lets agents work requirements of their own contacts and see matches in their listing scope only', async () => {
      const own = await contact('agent');
      const created = await requirement('agent', own.id, { requirementType: 'buy', currencyCode: 'GHS', maxPrice: '1200000' });
      const matches = await as('agent').get(`/api/v1/contacts/${own.id}/requirements/${created.id}/matches`).expect(200);
      const ids = matches.body.data.map((m: { listingId: string }) => m.listingId);
      expect(ids).not.toContain(listings['kumasi']); // Kumasi office listing: outside the agent's listing.view scope
      expect(ids).toContain(listings['osu']);
      expect(created.matchCount).toBe(ids.length);
      const owners = await as('owner').get(`/api/v1/contacts/${own.id}/requirements/${created.id}`).expect(200);
      expect(owners.body.matchCount).toBe(ids.length + 1);
    });

    it('keeps decision D1 read-only: an agent reads, but cannot change, requirements behind their lead', async () => {
      const created = await requirement('owner', buyerId, { requirementType: 'buy', currencyCode: 'GHS' });
      await as('agent2').get(`/api/v1/contacts/${buyerId}/requirements`).expect(404);
      await fx.db
        .insertInto('leads')
        .values({ companyId: company.companyId, reference: `LEA-R-${randomUUID().slice(0, 8)}`, contactId: buyerId, leadType: 'buy', sourceCode: 'website', assignedTo: members['agent2']! })
        .execute();
      await as('agent2').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}`).expect(200);
      await as('agent2').patch(`/api/v1/contacts/${buyerId}/requirements/${created.id}`, { notes: 'x' }, 1).expect(403);
      await as('agent2').post(`/api/v1/contacts/${buyerId}/requirements`, { requirementType: 'buy', currencyCode: 'GHS' }).expect(403);
      const register = await as('agent2').get(`/api/v1/requirements?filter[contactId]=${buyerId}`).expect(200);
      expect(register.body.data.length).toBeGreaterThan(0);
    });

    it('needs listing.view for matches, and shows no match counts without it', async () => {
      const created = await requirement('owner', buyerId, { requirementType: 'buy', currencyCode: 'GHS' });
      const res = await as('viewer').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}/matches`).expect(403);
      expect(res.body.detail).toContain('view listings');
      const read = await as('viewer').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}`).expect(200);
      expect(read.body.matchCount).toBeNull();
      await as('viewer').post(`/api/v1/contacts/${buyerId}/requirements`, { requirementType: 'buy', currencyCode: 'GHS' }).expect(403);
    });

    it('hides other offices’ and other companies’ contacts', async () => {
      const created = await requirement('owner', buyerId, { requirementType: 'buy', currencyCode: 'GHS' });
      await as('salesKsi').get(`/api/v1/contacts/${buyerId}/requirements`).expect(404);
      await as('otherOwner').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}`).expect(404);
      await as('otherOwner').get(`/api/v1/contacts/${buyerId}/requirements/${created.id}/matches`).expect(404);
      await as('otherOwner').post(`/api/v1/contacts/${buyerId}/requirements`, { requirementType: 'buy', currencyCode: 'GHS' }).expect(404);
      const register = await as('otherOwner').get('/api/v1/requirements').expect(200);
      expect(register.body.data).toHaveLength(0);
      await as('owner').get(`/api/v1/contacts/${tenantId}/requirements/${created.id}`).expect(404); // wrong contact for the requirement
    });
  });

  describe('requirements register (B-1)', () => {
    it('lists active requirements in scope with filters and keyset paging', async () => {
      const person = await contact('owner', { relationships: ['buyer'] });
      await requirement('owner', person.id, { requirementType: 'buy', currencyCode: 'GHS', minPrice: '500000', maxPrice: '800000', financingStatus: 'cash', moveBy: '2027-03-01', areas: [{ kind: 'locality', locality: 'East Legon' }] });
      await requirement('owner', person.id, { requirementType: 'rent', currencyCode: 'GHS', maxPrice: '3000', rentFrequency: 'monthly', status: 'paused' });
      const filter = `filter[contactId]=${person.id}`;
      expect((await as('owner').get(`/api/v1/requirements?${filter}`).expect(200)).body.data).toHaveLength(1);
      expect((await as('owner').get(`/api/v1/requirements?${filter}&filter[status]=active,paused`).expect(200)).body.data).toHaveLength(2);
      expect((await as('owner').get(`/api/v1/requirements?${filter}&filter[requirementType]=rent`).expect(200)).body.data).toHaveLength(0);
      expect((await as('owner').get(`/api/v1/requirements?${filter}&filter[budget][gte]=700000&filter[budget][lte]=900000`).expect(200)).body.data).toHaveLength(1);
      expect((await as('owner').get(`/api/v1/requirements?${filter}&filter[budget][gte]=900000`).expect(200)).body.data).toHaveLength(0);
      expect((await as('owner').get(`/api/v1/requirements?${filter}&filter[budget][lte]=400000`).expect(200)).body.data).toHaveLength(0);
      expect((await as('owner').get(`/api/v1/requirements?${filter}&filter[locality]=east legon`).expect(200)).body.data).toHaveLength(1);
      expect((await as('owner').get(`/api/v1/requirements?${filter}&filter[financingStatus]=cash&filter[currencyCode]=GHS`).expect(200)).body.data).toHaveLength(1);
      expect((await as('owner').get(`/api/v1/requirements?${filter}&filter[moveBy][gte]=2027-01-01&filter[moveBy][lte]=2027-12-31`).expect(200)).body.data).toHaveLength(1);
      const first = await as('owner').get('/api/v1/requirements?limit=2&sort=-createdAt').expect(200);
      expect(first.body.data).toHaveLength(2);
      const second = await as('owner').get(`/api/v1/requirements?limit=2&sort=-createdAt&cursor=${first.body.page.nextCursor}`).expect(200);
      expect(second.body.data[0].id).not.toBe(first.body.data[1].id);
      expect(first.body.data[0]).toHaveProperty('matchCount');
      await as('owner').get('/api/v1/requirements?filter[status]=open').expect(422);
    });

    it('scopes the register to the member’s contacts', async () => {
      const own = await contact('agent');
      const mine = await requirement('agent', own.id, { requirementType: 'buy', currencyCode: 'GHS' });
      const agentView = await as('agent').get('/api/v1/requirements?limit=100').expect(200);
      expect(agentView.body.data.map((row: { id: string }) => row.id)).toContain(mine.id);
      expect(agentView.body.data.every((row: { contact: { id: string } }) => row.contact.id !== tenantId)).toBe(true);
      const accountant = await as('accountant').get(`/api/v1/requirements?filter[contactId]=${own.id}`).expect(200);
      expect(accountant.body.data).toHaveLength(1);
    });
  });

  describe('merge integrity', () => {
    it('moves requirements and their not-suitable listings with a merged contact', async () => {
      const keep = await contact('owner', { displayName: 'Kwesi Mensah' });
      const merge = await contact('owner', { displayName: 'K. Mensah' });
      const created = await requirement('owner', merge.id, { requirementType: 'buy', currencyCode: 'GHS' });
      await as('owner').post(`/api/v1/contacts/${merge.id}/requirements/${created.id}/exclusions`, { listingId: listings['osu'], reason: 'Too small' }).expect(201);
      const keepNow = await as('owner').get(`/api/v1/contacts/${keep.id}`).expect(200);
      const mergeNow = await as('owner').get(`/api/v1/contacts/${merge.id}`).expect(200);
      await as('owner')
        .action(`/api/v1/contacts/${keep.id}/merge`, keepNow.body.version, { mergeContactId: merge.id, mergeVersion: mergeNow.body.version, fields: {} })
        .expect(200);
      const moved = await as('owner').get(`/api/v1/contacts/${keep.id}/requirements/${created.id}/exclusions`).expect(200);
      expect(moved.body).toHaveLength(1);
      await as('owner').get(`/api/v1/contacts/${merge.id}/requirements/${created.id}`).expect(404);
    });
  });
});
