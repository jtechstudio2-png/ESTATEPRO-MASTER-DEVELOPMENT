import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

/** Read endpoints for the web interface (M6 API gaps A-1, A-2, A-4 to A-10, U-10). */
describe('web interface read endpoints (Phase 4 M6)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  let propertyId: string;
  let kumasiPropertyId: string;
  let unitId: string;
  let listingId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};

  const as = (who: string, companyId = company.companyId) => ({
    get: (path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId),
    post: (path: string, body?: object) => t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body ?? {}),
    patch: (path: string, body: object, version: number) =>
      t.http.patch(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).set('If-Match', `"${version}"`).send(body),
    put: (path: string, body: object) => t.http.put(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body),
  });

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      agentKumasi: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      manager: { ...(await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    for (const [name, person] of Object.entries(people)) {
      members[name] = person.membershipId;
      await fx.linkIdentity(person.userId, `ws-${name}-${person.companyId}`);
      tokens[name] = await t.idp.token({ sub: `ws-${name}-${person.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    }
    await fx.db.updateTable('users').set({ displayName: 'Ama Boateng', localeCode: 'ar-QA', timezone: 'Asia/Qatar' }).where('id', '=', (await fx.db.selectFrom('companyMemberships').select('userId').where('id', '=', members['agent']!).executeTakeFirstOrThrow()).userId).execute();
    members['suspended'] = (await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId], status: 'suspended' })).membershipId;

    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();
    const create = async (name: string, officeId: string, extra: object = {}) =>
      (
        await as('owner')
          .post('/api/v1/properties', {
            name,
            propertyTypeId: type.id,
            officeId,
            address: { countryCode: 'GH', addressLine1: `${name} Road`, locality: 'Accra', adminArea1: 'Greater Accra', ...extra },
          })
          .expect(201)
      ).body.id as string;
    propertyId = await create('Searchable Court', company.officeId, { latitude: 5.5571, longitude: -0.1818 });
    kumasiPropertyId = await create('Kumasi Gardens', kumasiOfficeId);
    unitId = (await as('owner').post(`/api/v1/properties/${propertyId}/units`, { unitLabel: 'Flat Alpha' }).expect(201)).body.id;
    listingId = (
      await as('owner')
        .post('/api/v1/listings', {
          unitId,
          listingType: 'rent',
          officeId: company.officeId,
          agentMembershipId: members['agent'],
          price: { amount: '6000.00', currency: 'GHS' },
          rentFrequency: 'monthly',
          title: 'Searchable two-bed',
          defaultLocaleCode: 'en-GH',
        })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('session context (A-1)', () => {
    it('returns the member, company, offices, permissions with scopes, locale and direction', async () => {
      const res = await as('agent').get('/api/v1/me/context').expect(200);
      expect(res.body).toMatchObject({
        user: { displayName: 'Ama Boateng' },
        company: { id: company.companyId, baseCurrencyCode: 'GHS', headquartersCountryCode: 'GH' },
        membershipId: members['agent'],
        roleKey: 'agent',
        roleName: 'Agent',
        officeIds: [company.officeId],
        locale: 'ar-QA',
        textDirection: 'rtl',
        timezone: 'Asia/Qatar',
      });
      const grants = Object.fromEntries(res.body.permissions.map((p: { key: string; scope: string }) => [p.key, p.scope]));
      expect(grants).toMatchObject({ 'listing.view': 'office', 'listing.update': 'own', 'property_note.create': 'office', 'key.issue': 'office' });
      expect(grants['property_note.manage']).toBeUndefined();

      const owner = await as('owner').get('/api/v1/me/context').expect(200);
      expect(owner.body).toMatchObject({ locale: 'en-GH', textDirection: 'ltr', timezone: 'Africa/Accra' });
      expect(owner.body.permissions.find((p: { key: string }) => p.key === 'property_note.manage')).toMatchObject({ scope: 'all', isSensitive: true });
    });
  });

  describe('staff picker (A-2)', () => {
    it('lists active staff, optionally those a permission covers in an office', async () => {
      const all = await as('agent').get('/api/v1/members').expect(200);
      const ids = all.body.data.map((m: { membershipId: string }) => m.membershipId);
      expect(ids).toEqual(expect.arrayContaining([members['owner'], members['agent'], members['manager'], members['accountant']]));
      expect(ids).not.toContain(members['suspended']);
      expect(all.body.data[0]).toEqual({ membershipId: expect.any(String), displayName: expect.any(String), roleName: expect.any(String) });

      const agents = await as('agent').get(`/api/v1/members?filter[permission]=listing.update&filter[officeId]=${company.officeId}`).expect(200);
      const eligible = agents.body.data.map((m: { membershipId: string }) => m.membershipId);
      expect(eligible).toEqual(expect.arrayContaining([members['owner'], members['agent'], members['manager']]));
      expect(eligible).not.toContain(members['agentKumasi']);
      expect(eligible).not.toContain(members['accountant']);

      const named = await as('agent').get('/api/v1/members?q=ama%20bo').expect(200);
      expect(named.body.data.map((m: { membershipId: string }) => m.membershipId)).toEqual([members['agent']]);

      const bad = await as('agent').get('/api/v1/members?q=a&filter[officeId]=x&filter[role]=agent').expect(422);
      expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['filter', 'filter[officeId]', 'filter[officeId]', 'q']);
      await as('agent').get('/api/v1/members?filter[permission]=Bad Key').expect(422);
      const otherCompany = await as('otherOwner', other.companyId).get('/api/v1/members').expect(200);
      expect(otherCompany.body.data.map((m: { membershipId: string }) => m.membershipId)).toEqual([members['otherOwner']]);
    });
  });

  describe('search (A-6)', () => {
    it('groups properties, units and listings within scope, exact references first', async () => {
      const res = await as('owner').get('/api/v1/search?q=searchable').expect(200);
      expect(res.body.properties.hits.map((h: { id: string }) => h.id)).toEqual([propertyId]);
      expect(res.body.listings.hits.map((h: { id: string }) => h.id)).toEqual([listingId]);
      expect(res.body.listings.hits[0]).toMatchObject({ title: 'Searchable two-bed', context: 'rent · draft' });

      const unit = await as('owner').get('/api/v1/search?q=flat%20alpha').expect(200);
      expect(unit.body.units.hits[0]).toMatchObject({ id: unitId, title: 'Flat Alpha', propertyId, context: 'Searchable Court · available' });

      const property = await as('owner').get(`/api/v1/properties/${propertyId}`).expect(200);
      const byReference = await as('owner').get(`/api/v1/search?q=${property.body.reference}`).expect(200);
      expect(byReference.body.properties.hits[0].id).toBe(propertyId);

      // Office scope: the Kumasi agent finds nothing in Accra.
      const kumasi = await as('agentKumasi').get('/api/v1/search?q=searchable').expect(200);
      expect(kumasi.body).toMatchObject({ properties: { hits: [], hasMore: false }, listings: { hits: [], hasMore: false } });
      const gardens = await as('agentKumasi').get('/api/v1/search?q=gardens').expect(200);
      expect(gardens.body.properties.hits.map((h: { id: string }) => h.id)).toEqual([kumasiPropertyId]);
      await as('owner').get('/api/v1/search?q=x').expect(422);
    });

    it('omits groups the member cannot see and flags more results', async () => {
      const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();
      for (let n = 0; n < 6; n += 1) {
        await as('owner')
          .post('/api/v1/properties', { name: `Many Homes ${n}`, propertyTypeId: type.id, officeId: company.officeId, address: { countryCode: 'GH', addressLine1: `${n} Many St`, locality: 'Accra', adminArea1: 'Greater Accra' } })
          .expect(201);
      }
      const many = await as('owner').get('/api/v1/search?q=many%20homes').expect(200);
      expect(many.body.properties).toMatchObject({ hasMore: true });
      expect(many.body.properties.hits).toHaveLength(5);
      const tech = await fx.member(company.companyId, { roleKey: 'maintenance_staff' });
      await fx.linkIdentity(tech.userId, `ws-tech-${company.companyId}`);
      const techToken = await t.idp.token({ sub: `ws-tech-${company.companyId}`, amr: ['pwd'], authTime: Math.floor(Date.now() / 1000) });
      const techSearch = await t.http.get('/api/v1/search?q=many').auth(techToken, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);
      expect(techSearch.body).toMatchObject({ properties: { hits: [] }, listings: null });
    });
  });

  describe('reference data (A-9)', () => {
    it('serves countries with address formats and bounds, currencies, locales and picklists', async () => {
      const countries = await as('agent').get('/api/v1/reference/countries').expect(200);
      const ghana = countries.body.data.find((c: { code: string }) => c.code === 'GH');
      expect(ghana).toMatchObject({ defaultCurrencyCode: 'GHS', defaultTimezone: 'Africa/Accra', areaDisplayUnit: 'sqm', bounds: [-3.31, 4.65, 1.25, 11.22] });
      expect(ghana.addressFormat.local_components[0]).toMatchObject({ key: 'digital_address' });

      const currencies = await as('agent').get('/api/v1/reference/currencies').expect(200);
      expect(currencies.body.data.find((c: { code: string }) => c.code === 'QAR')).toMatchObject({ minorUnits: 2 });
      const locales = await as('agent').get('/api/v1/reference/locales').expect(200);
      expect(locales.body.data.find((l: { code: string }) => l.code === 'ar-QA')).toMatchObject({ textDirection: 'rtl' });

      const tenure = await as('agent').get('/api/v1/reference/picklists/tenure?countryCode=GH').expect(200);
      const codes = tenure.body.data.map((v: { code: string }) => v.code);
      expect(codes).toEqual(expect.arrayContaining(['freehold', 'leasehold', 'customary_freehold']));
      expect(codes).not.toContain('usufruct');
      const platformOnly = await as('agent').get('/api/v1/reference/picklists/tenure').expect(200);
      expect(platformOnly.body.data.map((v: { code: string }) => v.code)).not.toContain('customary_freehold');

      // A company value with the same code replaces the platform value; translations are used.
      const value = await fx.db
        .insertInto('picklistValues')
        .values({ companyId: company.companyId, listKey: 'tenure', code: 'leasehold', label: 'Leasehold (99 years)', sortOrder: 2 })
        .returning('id')
        .executeTakeFirstOrThrow();
      await fx.db.insertInto('picklistValueTranslations').values({ companyId: company.companyId, picklistValueId: value.id, localeCode: 'ar', label: 'إيجار طويل' }).execute();
      const arabic = await as('agent').get('/api/v1/reference/picklists/tenure?countryCode=GH&locale=ar-QA').expect(200);
      expect(arabic.body.data.find((v: { code: string }) => v.code === 'leasehold')).toEqual({ code: 'leasehold', label: 'إيجار طويل', countryCode: null, isCompanyValue: true });
      const otherCompany = await as('otherOwner', other.companyId).get('/api/v1/reference/picklists/tenure').expect(200);
      expect(otherCompany.body.data.find((v: { code: string }) => v.code === 'leasehold')).toMatchObject({ label: 'Leasehold', isCompanyValue: false });

      const bad = await as('agent').get('/api/v1/reference/picklists/Bad-Key?countryCode=gh&locale=english').expect(422);
      expect(bad.body.errors).toHaveLength(3);
    });
  });

  describe('property summary, history and list fields (A-4, A-7, A-8)', () => {
    it('counts tab contents and hides sections without permission', async () => {
      await as('manager').post(`/api/v1/properties/${propertyId}/notes`, { body: 'Pinned access note', isPinned: true }).expect(201);
      await as('manager').post(`/api/v1/properties/${propertyId}/key-sets`, { label: 'WS-1' }).expect(201);
      const summary = await as('owner').get(`/api/v1/properties/${propertyId}/summary`).expect(200);
      expect(summary.body).toEqual({
        units: { total: 1, available: 1, underMaintenance: 0, unavailable: 0 },
        media: { photos: 0, plans: 0, links: 0, processing: 0, rejected: 0 },
        listings: { live: 0, draft: 1 },
        notes: { total: 1, pinned: 1 },
        keys: { active: 1, out: 0, overdue: 0 },
      });
      const tech = await fx.member(company.companyId, { roleKey: 'maintenance_staff' });
      await fx.linkIdentity(tech.userId, `ws-tech2-${company.companyId}`);
      await fx.assignWorkOrder(company.companyId, propertyId, tech.membershipId, company.ownerMembershipId);
      const techToken = await t.idp.token({ sub: `ws-tech2-${company.companyId}`, amr: ['pwd'], authTime: Math.floor(Date.now() / 1000) });
      const techSummary = await t.http.get(`/api/v1/properties/${propertyId}/summary`).auth(techToken, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);
      expect(techSummary.body).toMatchObject({ listings: null, notes: null, keys: null });
      await as('agentKumasi').get(`/api/v1/properties/${propertyId}/summary`).expect(404);
    });

    it('collects audit history of the property and its records, never note text', async () => {
      const history = await as('owner').get(`/api/v1/properties/${propertyId}/history`).expect(200);
      const actions = history.body.data.map((e: { action: string }) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['property.created', 'unit.created', 'listing.created', 'property_note.created', 'key_set.created']));
      expect(JSON.stringify(history.body)).not.toContain('Pinned access note');
      expect(history.body.data[0]).toMatchObject({ entityType: expect.any(String), actorType: 'user', actorName: expect.any(String) });

      const onlyKeys = await as('owner').get(`/api/v1/properties/${propertyId}/history?filter[entityType]=key_set`).expect(200);
      expect(onlyKeys.body.data.map((e: { action: string }) => e.action)).toEqual(['key_set.created']);
      // P-6 date filter (whole UTC days).
      const today = new Date().toISOString().slice(0, 10);
      const sinceToday = await as('owner').get(`/api/v1/properties/${propertyId}/history?filter[occurredAt][gte]=${today}&filter[occurredAt][lte]=${today}`).expect(200);
      expect(sinceToday.body.data.length).toBe(history.body.data.length);
      const future = await as('owner').get(`/api/v1/properties/${propertyId}/history?filter[occurredAt][gte]=2999-01-01`).expect(200);
      expect(future.body.data).toEqual([]);
      const past = await as('owner').get(`/api/v1/properties/${propertyId}/history?filter[occurredAt][lte]=2000-01-01`).expect(200);
      expect(past.body.data).toEqual([]);
      await as('owner').get(`/api/v1/properties/${propertyId}/history?filter[occurredAt][gte]=yesterday`).expect(422);
      const paged = await as('owner').get(`/api/v1/properties/${propertyId}/history?limit=2`).expect(200);
      const next = await as('owner').get(`/api/v1/properties/${propertyId}/history?limit=2&cursor=${paged.body.page.nextCursor}`).expect(200);
      expect(next.body.data[0].occurredAt <= paged.body.data[1].occurredAt).toBe(true);

      // Accountants have no key permission: key entries are not shown.
      const accountant = await as('accountant').get(`/api/v1/properties/${propertyId}/history`).expect(200);
      expect(accountant.body.data.map((e: { action: string }) => e.action)).not.toContain('key_set.created');
    });

    it('marks stale locations on list items and filters by them', async () => {
      const property = await as('owner').get(`/api/v1/properties/${propertyId}`).expect(200);
      await as('owner')
        .patch(`/api/v1/properties/${propertyId}`, { address: { countryCode: 'GH', addressLine1: 'Moved Road', locality: 'Accra', adminArea1: 'Greater Accra' } }, property.body.version)
        .expect(200);
      const stale = await as('owner').get('/api/v1/properties?filter[locationStale]=true').expect(200);
      expect(stale.body.data.map((p: { id: string }) => p.id)).toEqual([propertyId]);
      expect(stale.body.data[0]).toMatchObject({ geocodeSource: 'manual_pin', locationStale: true });
    });
  });

  describe('listing readiness and attention (A-5, A-10)', () => {
    it('reports publishing blockers without publishing', async () => {
      await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: null, requireSellerKyc: false, minPhotosToPublish: 3, requireFloorPlanToPublish: true }).expect(200);
      const readiness = await as('agent').get(`/api/v1/listings/${listingId}/readiness`).expect(200);
      expect(readiness.body).toMatchObject({ canPublish: false, isPublished: false });
      expect(readiness.body.blockers.map((b: { code: string }) => b.code).sort()).toEqual(['floor-plan', 'photos']);
      await as('agentKumasi').get(`/api/v1/listings/${listingId}/readiness`).expect(404);
    });

    it('counts listings needing attention exactly as the list filter returns them', async () => {
      const counts = await as('owner').get('/api/v1/dashboards/property/listings').expect(200);
      expect(counts.body).toMatchObject({ notReady: 1, photos: 1, floorPlan: 1, mandateExpiring: 0, coverAlt: 0, priceStale: 0 });
      const notReady = await as('owner').get('/api/v1/listings?filter[attention]=not-ready').expect(200);
      expect(notReady.body.data.map((l: { id: string }) => l.id)).toEqual([listingId]);
      const either = await as('owner').get('/api/v1/listings?filter[attention]=photos,price-stale').expect(200);
      expect(either.body.data).toHaveLength(1);

      // An old available listing with an unchanged price, and a mandate ending soon.
      const second = await as('owner').post(`/api/v1/properties/${propertyId}/units`, { unitLabel: 'Flat Beta' }).expect(201);
      const stale = await fx.listing(company.companyId, second.body.id, company.ownerMembershipId, company.officeId);
      await fx.db
        .updateTable('listings')
        .set({ listedAt: new Date(Date.now() - 90 * 86_400_000), mandateExpiresOn: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) })
        .where('id', '=', stale.id)
        .execute();
      const after = await as('owner').get('/api/v1/dashboards/property/listings').expect(200);
      expect(after.body).toMatchObject({ priceStale: 1, mandateExpiring: 1, photos: 2 });
      const priceStale = await as('owner').get('/api/v1/listings?filter[attention]=price-stale').expect(200);
      expect(priceStale.body.data.map((l: { id: string }) => l.id)).toEqual([stale.id]);
      const kumasi = await as('agentKumasi').get('/api/v1/dashboards/property/listings').expect(200);
      expect(kumasi.body).toMatchObject({ notReady: 0, photos: 0, priceStale: 0 });
      const office = await as('owner').get(`/api/v1/dashboards/property/listings?filter[officeId]=${kumasiOfficeId}`).expect(200);
      expect(office.body.photos).toBe(0);
      await as('owner').get('/api/v1/dashboards/property/listings?filter[officeId]=nope').expect(422);
      // Rent / Sale / Both (D-1): the same counts as the list with filter[listingType].
      const sale = await as('owner').get('/api/v1/dashboards/property/listings?filter[listingType]=sale').expect(200);
      const saleList = await as('owner').get('/api/v1/listings?filter[attention]=price-stale&filter[listingType]=sale').expect(200);
      expect(sale.body.priceStale).toBe(saleList.body.data.length);
      const both = await as('owner').get('/api/v1/dashboards/property/listings?filter[listingType]=rent,sale').expect(200);
      expect(both.body).toEqual(after.body);
      const rent = await as('owner').get('/api/v1/dashboards/property/listings?filter[listingType]=rent').expect(200);
      expect(rent.body.photos + sale.body.photos).toBe(after.body.photos);
      await as('owner').get('/api/v1/dashboards/property/listings?filter[listingType]=lease').expect(422);
      await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: null, requireSellerKyc: false, minPhotosToPublish: null, requireFloorPlanToPublish: false }).expect(200);
    });
  });

  describe('property dashboard panels (A-5)', () => {
    it('counts maintenance, keys, locations and rejected media within scope', async () => {
      const unit = await as('owner').get(`/api/v1/units/${unitId}`).expect(200);
      await as('owner').post(`/api/v1/units/${unitId}/availability`, { availability: 'under_maintenance', note: 'Leak repair' }).set('If-Match', `"${unit.body.version}"`).expect(200);
      const maintenance = await as('manager').get('/api/v1/dashboards/property/maintenance').expect(200);
      expect(maintenance.body).toMatchObject({ count: 1, units: [{ unitId, unitLabel: 'Flat Alpha', propertyId, propertyName: 'Searchable Court', note: 'Leak repair' }] });

      const keys = await as('manager').get('/api/v1/dashboards/property/keys').expect(200);
      expect(keys.body).toEqual({ overdue: 0, out: 0, lost: 0 });
      const locations = await as('owner').get('/api/v1/dashboards/property/locations').expect(200);
      expect(locations.body).toMatchObject({ stale: 1 });
      expect(locations.body.missing).toBeGreaterThanOrEqual(7);
      const kumasiLocations = await as('agentKumasi').get('/api/v1/dashboards/property/locations').expect(200);
      expect(kumasiLocations.body).toEqual({ missing: 1, stale: 0 });

      await sql`insert into property_media (company_id, property_id, media_type, processing_status, original_filename, rejection_reason, storage_key)
        values (${company.companyId}::uuid, ${propertyId}::uuid, 'photo', 'rejected', 'virus.jpg', 'Failed the security scan', ${`${company.companyId}/quarantine/x`})`.execute(fx.db);
      const media = await as('owner').get('/api/v1/dashboards/property/media').expect(200);
      expect(media.body).toMatchObject({ rejected: 1, recent: [{ propertyId, fileName: 'virus.jpg', reason: 'Failed the security scan' }] });
      await as('accountant').get('/api/v1/dashboards/property/keys').expect(403);
    });
  });
});
