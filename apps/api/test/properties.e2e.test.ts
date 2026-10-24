import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

describe('properties, units and property types (Phase 4 M2)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  let agentA: Awaited<ReturnType<Fixtures['member']>>;
  let agentKumasi: Awaited<ReturnType<Fixtures['member']>>;
  let manager: Awaited<ReturnType<Fixtures['member']>>;
  let technician: Awaited<ReturnType<Fixtures['member']>>;
  const types: Record<string, string> = {};

  const tokens: Record<string, string> = {};
  const now = (): number => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    agentA = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    agentKumasi = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [kumasiOfficeId] });
    manager = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    technician = await fx.member(company.companyId, { roleKey: 'maintenance_staff' });
    const otherAgent = await fx.member(other.companyId, { roleKey: 'agent', officeIds: [other.officeId] });

    for (const [name, userId] of Object.entries({
      owner: company.ownerUserId,
      agentA: agentA.userId,
      agentKumasi: agentKumasi.userId,
      manager: manager.userId,
      technician: technician.userId,
      otherAgent: otherAgent.userId,
    })) {
      await fx.linkIdentity(userId, `props-${name}-${company.companyId}`);
      tokens[name] = await t.idp.token({ sub: `props-${name}-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: now() });
    }

    const typeRows = await fx.db.selectFrom('propertyTypes').select(['id', 'code']).where('companyId', 'is', null).execute();
    for (const row of typeRows) types[row.code] = row.id;
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  const as = (who: string, companyId = company.companyId) => ({
    get: (path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId),
    post: (path: string, body?: object) =>
      t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body ?? {}),
    patch: (path: string, body: object, version?: number | string) => {
      const req = t.http.patch(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body);
      return version === undefined ? req : req.set('If-Match', typeof version === 'number' ? `"${version}"` : version);
    },
    action: (path: string, version: number, body?: object) =>
      t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).set('If-Match', `"${version}"`).send(body ?? {}),
  });

  const ghanaProperty = (overrides: Record<string, unknown> = {}) => ({
    name: 'Osu Court',
    propertyTypeId: types['apartment_building'],
    officeId: company.officeId,
    address: {
      countryCode: 'GH',
      addressLine1: '12 Oxford Street',
      locality: 'Accra',
      adminArea1: 'Greater Accra',
      dependentLocality: 'Osu',
      localComponents: { digital_address: 'ga-123-4567' },
      latitude: 5.5571,
      longitude: -0.1818,
    },
    ...overrides,
  });

  async function createProperty(who = 'owner', overrides: Record<string, unknown> = {}) {
    const res = await as(who).post('/api/v1/properties', ghanaProperty(overrides)).expect(201);
    return res.body as { id: string; version: number; reference: string };
  }

  // ------------------------------------------------------------------ types

  describe('property types', () => {
    it('lists platform types for a country, with company types alongside', async () => {
      const res = await as('agentA').get('/api/v1/property-types?filter[countryCode]=GH').expect(200);
      const codes = res.body.data.map((type: { code: string }) => type.code);
      expect(codes).toEqual(expect.arrayContaining(['apartment', 'chamber_and_hall', 'compound_house']));
      expect(codes).not.toContain('terraced');
      expect(codes).not.toContain('compound_villa');
      expect(res.body.data[0]).toMatchObject({ isCompanyDefined: false, isActive: true });
    });

    it('filters by what a type applies to and localises names', async () => {
      const units = await as('agentA').get('/api/v1/property-types?filter[appliesTo]=unit').expect(200);
      expect(units.body.data.every((type: { appliesTo: string }) => type.appliesTo !== 'property')).toBe(true);

      const arabic = await as('agentA').get('/api/v1/property-types?filter[countryCode]=QA').set('Accept-Language', 'ar-QA, en;q=0.5').expect(200);
      expect(arabic.body.data.find((type: { code: string }) => type.code === 'apartment').name).toBe('شقة');
      const english = await as('agentA').get('/api/v1/property-types').set('Accept-Language', 'fr').expect(200);
      expect(english.body.data.find((type: { code: string }) => type.code === 'apartment').name).toBe('Apartment / flat');
    });

    it('rejects unknown or invalid filters', async () => {
      await as('agentA').get('/api/v1/property-types?filter[colour]=red').expect(422);
      await as('agentA').get('/api/v1/property-types?filter[countryCode]=ghana').expect(422);
      await as('agentA').get('/api/v1/property-types?filter=x').expect(422);
    });

    it('lets administrators add, rename and deactivate company types', async () => {
      const created = await as('owner')
        .post('/api/v1/property-types', { code: 'shop_with_flat', name: 'Shop with flat above', usageClass: 'mixed_use', appliesTo: 'property', countryCode: 'GH', parentId: types['mixed_use'] })
        .expect(201);
      expect(created.headers['location']).toBe(`/api/v1/property-types/${created.body.id}`);
      expect(created.body).toMatchObject({ isCompanyDefined: true, version: 1, sortOrder: 100 });

      await as('owner').post('/api/v1/property-types', { code: 'shop_with_flat', name: 'Duplicate', usageClass: 'mixed_use', appliesTo: 'property', countryCode: 'GH' }).expect(409);
      await as('owner').post('/api/v1/property-types', { code: 'zz_type', name: 'Bad country', usageClass: 'other', appliesTo: 'both', countryCode: 'ZZ' }).expect(422);
      await as('owner').post('/api/v1/property-types', { code: 'zz_type', name: 'Bad parent', usageClass: 'other', appliesTo: 'both', parentId: other.companyId }).expect(422);

      await as('owner').patch(`/api/v1/property-types/${created.body.id}`, { name: 'Shop + flat' }).expect(428);
      await as('owner').patch(`/api/v1/property-types/${created.body.id}`, { name: 'Shop + flat' }, 9).expect(412);
      const renamed = await as('owner').patch(`/api/v1/property-types/${created.body.id}`, { name: 'Shop + flat', isActive: false }, 1).expect(200);
      expect(renamed.body).toMatchObject({ name: 'Shop + flat', isActive: false, version: 2 });
      expect(renamed.headers['etag']).toBe('"2"');

      const inactive = await as('agentA').get('/api/v1/property-types?filter[active]=false').expect(200);
      expect(inactive.body.data.map((type: { id: string }) => type.id)).toEqual([created.body.id]);

      // Invisible to other companies.
      const otherList = await as('otherAgent', other.companyId).get('/api/v1/property-types?filter[active]=all').expect(200);
      expect(otherList.body.data.map((type: { id: string }) => type.id)).not.toContain(created.body.id);
    });

    it('protects platform types and requires settings.manage', async () => {
      await as('owner').patch(`/api/v1/property-types/${types['apartment']}`, { name: 'Flat' }, 1).expect(403);
      await as('owner').patch(`/api/v1/property-types/${other.companyId}`, { name: 'Missing' }, 1).expect(404);
      await as('agentA').post('/api/v1/property-types', { code: 'agent_type', name: 'Agent type', usageClass: 'other', appliesTo: 'both' }).expect(403);
    });
  });

  // ------------------------------------------------------------- properties

  describe('creating properties', () => {
    it('creates a property with a validated Ghana address, defaults and a whole-property unit', async () => {
      const res = await as('owner')
        .post('/api/v1/properties', ghanaProperty({
          name: 'Labone House',
          propertyTypeId: types['house_detached'],
          createWholePropertyUnit: true,
          tenureCode: 'customary_freehold',
          yearBuilt: 2015,
          landArea: { value: 0.25, unit: 'acre' },
        }))
        .expect(201);

      expect(res.headers['location']).toBe(`/api/v1/properties/${res.body.id}`);
      expect(res.headers['etag']).toBe('"1"');
      expect(res.body).toMatchObject({
        reference: expect.stringMatching(/^PRP-\d{4}-\d{6}$/),
        name: 'Labone House',
        propertyType: { code: 'house_detached' },
        office: { id: company.officeId, code: 'HQ' },
        jurisdictionCode: 'GH',
        timezone: 'Africa/Accra',
        tenureCode: 'customary_freehold',
        yearBuilt: 2015,
        landArea: { sqm: 1011.71, value: 0.25, unit: 'acre' },
        unitCount: 1,
        isManaged: false,
        archivedAt: null,
        version: 1,
      });
      expect(res.body.address).toMatchObject({
        countryCode: 'GH',
        localComponents: { digital_address: 'GA-123-4567' },
        formatted: '12 Oxford Street, GhanaPost GPS address GA-123-4567, Osu, Accra, Greater Accra',
        latitude: 5.5571,
        longitude: -0.1818,
      });

      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'entityType']).where('companyId', '=', company.companyId).where('entityId', '=', res.body.id).execute();
      expect(audit).toEqual([{ action: 'property.created', entityType: 'property' }]);
      const event = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', res.body.id).executeTakeFirstOrThrow();
      expect(event.eventType).toBe('property.created');
    });

    it('keeps plot areas as entered without inventing square metres', async () => {
      const res = await as('owner').post('/api/v1/properties', ghanaProperty({ propertyTypeId: types['residential_plot'], landArea: { value: 2, unit: 'plot' } })).expect(201);
      expect(res.body.landArea).toEqual({ sqm: null, value: 2, unit: 'plot' });
    });

    it('validates addresses against the country format', async () => {
      const gb = await as('owner')
        .post('/api/v1/properties', ghanaProperty({
          propertyTypeId: types['terraced'],
          jurisdictionCode: 'GB-ENG',
          address: { countryCode: 'GB', addressLine1: '1 High Street', locality: 'London' },
        }))
        .expect(422);
      expect(gb.body.errors).toEqual([expect.objectContaining({ field: 'address.postalCode', code: 'required' })]);

      const qa = await as('owner')
        .post('/api/v1/properties', ghanaProperty({
          address: { countryCode: 'QA', locality: 'West Bay', postalCode: '12345', localComponents: { zone_number: '66', street_number: '950' } },
        }))
        .expect(422);
      expect(qa.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`)).toEqual(
        expect.arrayContaining(['address.postalCode:not-used', 'address.localComponents.building_number:required']),
      );

      const gh = await as('owner')
        .post('/api/v1/properties', ghanaProperty({
          address: { countryCode: 'GH', locality: 'Accra', adminArea1: 'Greater Accra', localComponents: { digital_address: 'GA-12', parcel: 'x' } },
        }))
        .expect(422);
      expect(gh.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`)).toEqual(
        expect.arrayContaining(['address.localComponents.digital_address:format', 'address.localComponents.parcel:unknown-field']),
      );

      const empty = await as('owner')
        .post('/api/v1/properties', ghanaProperty({ address: { countryCode: 'GH', locality: 'Accra', adminArea1: 'Greater Accra', latitude: 5 } }))
        .expect(422);
      expect(empty.body.errors.map((e: { field: string }) => e.field)).toEqual(expect.arrayContaining(['address.addressLine1', 'address.latitude']));

      await as('owner').post('/api/v1/properties', ghanaProperty({ address: { countryCode: 'ZZ', addressLine1: 'x' } })).expect(422);
      const blank = await as('owner')
        .post('/api/v1/properties', ghanaProperty({ address: { countryCode: 'GH', addressLine1: '1 Road', locality: 'Accra', adminArea1: 'GA', localComponents: { digital_address: '   ' } } }))
        .expect(422);
      expect(blank.body.errors).toEqual([expect.objectContaining({ field: 'address.localComponents.digital_address', code: 'invalid' })]);
    });

    it('accepts a UK property managed from Ghana when the jurisdiction is chosen, normalising the postcode', async () => {
      const missing = await as('owner')
        .post('/api/v1/properties', ghanaProperty({
          propertyTypeId: types['terraced'],
          address: { countryCode: 'GB', addressLine1: '1 High Street', locality: 'London', postalCode: 'sw1a1aa' },
        }))
        .expect(422);
      expect(missing.body.errors).toEqual([expect.objectContaining({ field: 'jurisdictionCode', code: 'required' })]);

      const ok = await as('owner')
        .post('/api/v1/properties', ghanaProperty({
          propertyTypeId: types['terraced'],
          jurisdictionCode: 'GB-ENG',
          address: { countryCode: 'GB', addressLine1: '1 High Street', locality: 'London', postalCode: 'sw1a  1aa' },
        }))
        .expect(201);
      expect(ok.body).toMatchObject({ jurisdictionCode: 'GB-ENG', timezone: 'Europe/London' });
      expect(ok.body.address.postalCode).toBe('SW1A 1AA');

      const wrongJurisdiction = await as('owner')
        .post('/api/v1/properties', ghanaProperty({ jurisdictionCode: 'GB-ENG' }))
        .expect(422);
      expect(wrongJurisdiction.body.errors).toEqual([expect.objectContaining({ field: 'jurisdictionCode', code: 'country-mismatch' })]);

      const qatar = await as('owner')
        .post('/api/v1/properties', ghanaProperty({
          propertyTypeId: types['compound_villa'] ? types['villa'] : types['villa'],
          address: { countryCode: 'QA', locality: 'Al Waab', localComponents: { zone_number: '55', street_number: '340', building_number: '12' } },
        }))
        .expect(201);
      expect(qatar.body).toMatchObject({ jurisdictionCode: 'QA', timezone: 'Asia/Qatar' });
      expect(qatar.body.address.formatted).toBe('Zone 55, Street 340, Building 12, Al Waab');
    });

    it('checks property types, tenure, timezone and year built', async () => {
      const res = await as('owner')
        .post('/api/v1/properties', ghanaProperty({
          propertyTypeId: types['terraced'],
          tenureCode: 'usufruct',
          timezone: 'Mars/Olympus',
          yearBuilt: 2100,
          tenureExpiresOn: '2026-02-30',
        }))
        .expect(422);
      expect(res.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`).sort()).toEqual([
        'propertyTypeId:country-mismatch',
        'tenureCode:unknown-code',
        'tenureExpiresOn:invalid',
        'timezone:invalid',
        'yearBuilt:range',
      ]);

      const unitOnly = await as('owner').post('/api/v1/properties', ghanaProperty({ propertyTypeId: types['studio'] })).expect(422);
      expect(unitOnly.body.errors).toEqual([expect.objectContaining({ field: 'propertyTypeId', code: 'not-applicable' })]);
      await as('owner').post('/api/v1/properties', ghanaProperty({ propertyTypeId: other.companyId })).expect(422);
      await as('owner').post('/api/v1/properties', ghanaProperty({ officeId: other.officeId })).expect(422);
      await as('owner').post('/api/v1/properties', ghanaProperty({ colour: 'blue' })).expect(422);
    });

    it('replays an idempotent create and rejects a reused key with a different body', async () => {
      const key = `create-${fx.uniqueSuffix()}`;
      const first = await as('owner').post('/api/v1/properties', ghanaProperty({ name: 'Idem' })).set('Idempotency-Key', key).expect(201);
      const second = await as('owner').post('/api/v1/properties', ghanaProperty({ name: 'Idem' })).set('Idempotency-Key', key).expect(201);
      expect(second.body.id).toBe(first.body.id);
      const count = await fx.db.selectFrom('properties').select('id').where('companyId', '=', company.companyId).where('name', '=', 'Idem').execute();
      expect(count).toHaveLength(1);

      const reused = await as('owner').post('/api/v1/properties', ghanaProperty({ name: 'Different' })).set('Idempotency-Key', key).expect(422);
      expect(reused.body.type).toBe('urn:estatepro:problem:idempotency-key-reused');
      await as('owner').post('/api/v1/properties', ghanaProperty()).set('Idempotency-Key', 'short').expect(422);
    });

    it('limits agents to their own offices', async () => {
      await createProperty('agentA');
      const res = await as('agentA').post('/api/v1/properties', ghanaProperty({ officeId: kumasiOfficeId })).expect(403);
      expect(res.body.detail).toBe('You can only add properties to your own offices.');
    });
  });

  describe('reading and listing', () => {
    let accra: { id: string; reference: string };
    let kumasi: { id: string; reference: string };

    beforeAll(async () => {
      accra = await createProperty('owner', { name: 'Listing Test Accra' });
      kumasi = await createProperty('owner', { name: 'Listing Test Kumasi', officeId: kumasiOfficeId });
    });

    it('returns a property with its ETag; 404 for other companies and malformed ids', async () => {
      const res = await as('agentA').get(`/api/v1/properties/${accra.id}`).expect(200);
      expect(res.headers['etag']).toBe('"1"');
      await as('otherAgent', other.companyId).get(`/api/v1/properties/${accra.id}`).expect(404);
      await as('agentA').get('/api/v1/properties/not-a-uuid').expect(404);
    });

    it('applies office scope: agents see only their offices’ properties', async () => {
      await as('agentA').get(`/api/v1/properties/${kumasi.id}`).expect(404);
      await as('agentKumasi').get(`/api/v1/properties/${kumasi.id}`).expect(200);

      const list = await as('agentA').get('/api/v1/properties?limit=100').expect(200);
      const ids = list.body.data.map((p: { id: string }) => p.id);
      expect(ids).toContain(accra.id);
      expect(ids).not.toContain(kumasi.id);

      const ownerList = await as('owner').get('/api/v1/properties?limit=100').expect(200);
      expect(ownerList.body.data.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([accra.id, kumasi.id]));
    });

    it('applies assigned scope: technicians see only properties with their active work orders', async () => {
      await fx.assignWorkOrder(company.companyId, accra.id, technician.membershipId, manager.membershipId);
      const list = await as('technician').get('/api/v1/properties?limit=100').expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([accra.id]);
      await as('technician').get(`/api/v1/properties/${kumasi.id}`).expect(404);
      await as('technician').get(`/api/v1/properties/${accra.id}`).expect(200);
    });

    it('filters, searches and paginates without repeats', async () => {
      const byOffice = await as('owner').get(`/api/v1/properties?filter[officeId]=${kumasiOfficeId}`).expect(200);
      expect(byOffice.body.data.every((p: { office: { id: string } }) => p.office.id === kumasiOfficeId)).toBe(true);

      const search = await as('owner').get(`/api/v1/properties?q=${accra.reference}`).expect(200);
      expect(search.body.data.map((p: { id: string }) => p.id)).toEqual([accra.id]);
      const byAddress = await as('owner').get('/api/v1/properties?q=oxford%20street&limit=100').expect(200);
      expect(byAddress.body.data.length).toBeGreaterThan(1);
      const escaped = await as('owner').get('/api/v1/properties?q=%25%25').expect(200);
      expect(escaped.body.data).toEqual([]);

      const ghana = await as('owner').get('/api/v1/properties?filter[countryCode]=GH&filter[isManaged]=false&limit=100').expect(200);
      expect(ghana.body.data.every((p: { countryCode: string }) => p.countryCode === 'GH')).toBe(true);
      const byType = await as('owner').get(`/api/v1/properties?filter[propertyTypeId]=${types['terraced']}`).expect(200);
      expect(byType.body.data.every((p: { propertyType: { code: string } }) => p.propertyType.code === 'terraced')).toBe(true);

      for (const sort of ['reference', '-createdAt', 'updatedAt']) {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page: { body: { data: Array<{ id: string }>; page: { nextCursor: string | null; limit: number } } } = await as('owner')
            .get(`/api/v1/properties?sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
            .expect(200);
          expect(page.body.page.limit).toBe(2);
          seen.push(...page.body.data.map((p) => p.id));
          cursor = page.body.page.nextCursor;
        } while (cursor);
        const all = await as('owner').get(`/api/v1/properties?sort=${sort}&limit=100`).expect(200);
        expect(seen).toEqual(all.body.data.map((p: { id: string }) => p.id));
        expect(new Set(seen).size).toBe(seen.length);
      }
    });

    it('rejects invalid list parameters', async () => {
      const res = await as('owner').get('/api/v1/properties?limit=0&sort=colour&cursor=abc&q=x').expect(422);
      expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['cursor', 'limit', 'q', 'sort']);
      await as('owner').get('/api/v1/properties?filter[officeId]=nope').expect(422);
      await as('owner').get('/api/v1/properties?filter[isManaged]=maybe').expect(422);
      await as('owner').get('/api/v1/properties?filter[archived]=maybe').expect(422);
      await as('owner').get('/api/v1/properties?filter[officeId][x]=1').expect(422);
      const badCursor = Buffer.from(JSON.stringify({ v: 'not-a-date', id: accra.id })).toString('base64url');
      await as('owner').get(`/api/v1/properties?sort=createdAt&cursor=${badCursor}`).expect(422);
    });
  });

  describe('updating', () => {
    it('requires If-Match, rejects stale versions and records field changes', async () => {
      const property = await createProperty('owner', { name: 'Before' });
      await as('owner').patch(`/api/v1/properties/${property.id}`, { name: 'After' }).expect(428);
      await as('owner').patch(`/api/v1/properties/${property.id}`, { name: 'After' }, 'W/"1"').expect(412);
      await as('owner').patch(`/api/v1/properties/${property.id}`, { name: 'After' }, 2).expect(412);

      const res = await as('owner').patch(`/api/v1/properties/${property.id}`, { name: 'After', floorsCount: 3, isManaged: true }, 1).expect(200);
      expect(res.body).toMatchObject({ name: 'After', floorsCount: 3, isManaged: true, version: 2 });
      expect(res.headers['etag']).toBe('"2"');

      const audit = await fx.db.selectFrom('auditLogs').select('changes').where('entityId', '=', property.id).where('action', '=', 'property.updated').executeTakeFirstOrThrow();
      expect(audit.changes).toMatchObject({ name: { old: 'Before', new: 'After' }, floorsCount: { old: null, new: 3 } });
    });

    it('does not change the version for an unchanged patch, and clears fields with null', async () => {
      const property = await createProperty('owner', { name: 'Same', landArea: { value: 500, unit: 'sqm' } });
      const same = await as('owner').patch(`/api/v1/properties/${property.id}`, { name: 'Same', landArea: { value: 500, unit: 'sqm' } }, 1).expect(200);
      expect(same.body.version).toBe(1);
      const cleared = await as('owner').patch(`/api/v1/properties/${property.id}`, { name: null, landArea: null }, 1).expect(200);
      expect(cleared.body).toMatchObject({ name: null, landArea: null, version: 2 });
    });

    it('re-validates a new address and requires a jurisdiction when the country changes', async () => {
      const property = await createProperty('owner');
      const newAddress = await as('owner')
        .patch(`/api/v1/properties/${property.id}`, { address: { countryCode: 'GH', addressLine1: '5 Ring Road', locality: 'Accra', adminArea1: 'Greater Accra' } }, 1)
        .expect(200);
      expect(newAddress.body.address.formatted).toBe('5 Ring Road, Accra, Greater Accra');
      expect(newAddress.body.version).toBe(2);
      const audit = await fx.db.selectFrom('auditLogs').select('changes').where('entityId', '=', property.id).where('action', '=', 'property.updated').executeTakeFirstOrThrow();
      expect(audit.changes).toHaveProperty(['address.addressLine1']);

      const ukAddress = { countryCode: 'GB', addressLine1: '1 High Street', locality: 'Leeds', postalCode: 'LS1 1AA' };
      const missing = await as('owner').patch(`/api/v1/properties/${property.id}`, { address: ukAddress, propertyTypeId: types['terraced'] }, 2).expect(422);
      expect(missing.body.errors).toEqual([expect.objectContaining({ field: 'jurisdictionCode', code: 'required' })]);
      const moved = await as('owner')
        .patch(`/api/v1/properties/${property.id}`, { address: ukAddress, propertyTypeId: types['terraced'], jurisdictionCode: 'GB-ENG' }, 2)
        .expect(200);
      expect(moved.body).toMatchObject({ jurisdictionCode: 'GB-ENG', timezone: 'Europe/London', propertyType: { code: 'terraced' } });

      const badType = await as('owner').patch(`/api/v1/properties/${property.id}`, { propertyTypeId: types['chamber_and_hall'] }, 3).expect(422);
      expect(badType.body.errors[0].code).toBe('not-applicable');
    });

    it('changes jurisdiction and time zone within a country, and validates them', async () => {
      const property = await createProperty('owner');
      await as('owner').patch(`/api/v1/properties/${property.id}`, { jurisdictionCode: 'QA', timezone: 'Nowhere/City' }, 1).expect(422);
      const res = await as('owner').patch(`/api/v1/properties/${property.id}`, { timezone: 'Africa/Lagos', tenureCode: 'leasehold' }, 1).expect(200);
      expect(res.body).toMatchObject({ timezone: 'Africa/Lagos', tenureCode: 'leasehold' });
    });

    it('enforces scopes: agents edit only what they created, and move only to their offices', async () => {
      const ownersProperty = await createProperty('owner');
      const denied = await as('agentA').patch(`/api/v1/properties/${ownersProperty.id}`, { name: 'Agent edit' }, 1).expect(403);
      expect(denied.body.detail).toBe('Your role does not allow this change for this property.');

      const agentsProperty = await createProperty('agentA');
      await as('agentA').patch(`/api/v1/properties/${agentsProperty.id}`, { name: 'Agent edit' }, 1).expect(200);
      await as('agentA').patch(`/api/v1/properties/${agentsProperty.id}`, { officeId: kumasiOfficeId }, 2).expect(403);
      await as('owner').patch(`/api/v1/properties/${agentsProperty.id}`, { officeId: other.officeId }, 2).expect(422);
      const moved = await as('owner').patch(`/api/v1/properties/${agentsProperty.id}`, { officeId: kumasiOfficeId }, 2).expect(200);
      expect(moved.body.office.code).toBe('KSI');
    });
  });

  describe('archiving and restoring', () => {
    it('archives with a reason (cascading to units), blocks edits, and restores both', async () => {
      const property = await as('owner').post('/api/v1/properties', ghanaProperty({ createWholePropertyUnit: true })).expect(201);
      await as('owner').action(`/api/v1/properties/${property.body.id}/archive`, 1, {}).expect(422);
      await as('agentA').action(`/api/v1/properties/${property.body.id}/archive`, 1, { reason: 'Sold privately' }).expect(403);

      const archived = await as('owner').action(`/api/v1/properties/${property.body.id}/archive`, 1, { reason: 'Instruction ended' }).expect(200);
      expect(archived.body).toMatchObject({ archivedReason: 'Instruction ended', unitCount: 0, version: 2 });
      expect(archived.body.archivedAt).not.toBeNull();

      await as('owner').action(`/api/v1/properties/${property.body.id}/archive`, 2, { reason: 'Again' }).expect(422);
      const edit = await as('owner').patch(`/api/v1/properties/${property.body.id}`, { name: 'x' }, 2).expect(422);
      expect(edit.body.detail).toContain('Restore the property first');

      const units = await as('owner').get(`/api/v1/properties/${property.body.id}/units?filter[archived]=true`).expect(200);
      expect(units.body.data).toHaveLength(1);
      await as('owner').post(`/api/v1/properties/${property.body.id}/units`, { unitLabel: 'Annex' }).expect(422);

      const listed = await as('owner').get('/api/v1/properties?filter[archived]=true&limit=100').expect(200);
      expect(listed.body.data.map((p: { id: string }) => p.id)).toContain(property.body.id);

      await as('owner').action(`/api/v1/properties/${property.body.id}/restore`, 1).expect(412);
      const restored = await as('owner').action(`/api/v1/properties/${property.body.id}/restore`, 2).expect(200);
      expect(restored.body).toMatchObject({ archivedAt: null, archivedReason: null, unitCount: 1, version: 3 });
      await as('owner').action(`/api/v1/properties/${property.body.id}/restore`, 3).expect(422);
      await as('owner').action(`/api/v1/properties/${other.officeId}/restore`, 1).expect(404);
    });

    it('refuses to archive while a listing is open', async () => {
      const property = await as('owner').post('/api/v1/properties', ghanaProperty({ createWholePropertyUnit: true })).expect(201);
      const unit = await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow();
      await fx.listing(company.companyId, unit.id, agentA.membershipId, company.officeId);
      const res = await as('owner').action(`/api/v1/properties/${property.body.id}/archive`, 1, { reason: 'No longer instructed' }).expect(422);
      expect(res.body.detail).toBe('There are open listings. Withdraw or close them before archiving.');
      const unitRes = await as('owner').action(`/api/v1/units/${unit.id}/archive`, 1, { reason: 'Gone' }).expect(422);
      expect(unitRes.body.detail).toContain('open listings');
    });

    it('refuses to archive while a lease is live', async () => {
      const property = await as('owner').post('/api/v1/properties', ghanaProperty({ createWholePropertyUnit: true })).expect(201);
      const unit = await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow();
      await fx.db
        .insertInto('leases')
        .values({
          companyId: company.companyId,
          reference: `LSE-T-${fx.uniqueSuffix()}`,
          unitId: unit.id,
          jurisdictionCode: 'GH',
          leaseType: 'fixed_term',
          status: 'active',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          currencyCode: 'GHS',
          rentAmount: '6000',
          rentFrequency: 'monthly',
          signedAt: new Date(),
        })
        .execute();
      const res = await as('owner').action(`/api/v1/properties/${property.body.id}/archive`, 1, { reason: 'No longer instructed' }).expect(422);
      expect(res.body.detail).toBe('There are live leases. End them before archiving.');
    });

    it('cannot restore a property whose office is archived', async () => {
      const office = await fx.office(company.companyId, `T${fx.uniqueSuffix().slice(0, 4).toUpperCase()}`);
      const property = await createProperty('owner', { officeId: office.id });
      await as('owner').action(`/api/v1/properties/${property.id}/archive`, 1, { reason: 'Closing office' }).expect(200);
      await fx.db.updateTable('offices').set({ archivedAt: new Date() }).where('id', '=', office.id).execute();
      const res = await as('owner').action(`/api/v1/properties/${property.id}/restore`, 2).expect(422);
      expect(res.body.detail).toContain('office is archived');
    });

    it('blocks writes in read-only companies', async () => {
      const readOnly = await fx.company();
      await fx.linkIdentity(readOnly.ownerUserId, `ro-owner-${readOnly.companyId}`);
      const token = await t.idp.token({ sub: `ro-owner-${readOnly.companyId}`, amr: ['mfa'] });
      await fx.setCompanyStatus(readOnly.companyId, 'read_only');
      const res = await t.http
        .post('/api/v1/properties')
        .auth(token, { type: 'bearer' })
        .set('X-Company-Id', readOnly.companyId)
        .send(ghanaProperty({ officeId: readOnly.officeId }))
        .expect(403);
      expect(res.body.type).toBe('urn:estatepro:problem:company-inactive');
    });
  });

  // ------------------------------------------------------------------ units

  describe('units', () => {
    let building: { id: string };

    beforeAll(async () => {
      building = await createProperty('owner', { name: 'Unit Test Court' });
    });

    it('creates a unit with converted areas, features and furnishing', async () => {
      const res = await as('owner')
        .post(`/api/v1/properties/${building.id}/units`, {
          unitLabel: 'Flat 1A',
          unitTypeId: types['apartment'],
          floorLabel: '1',
          bedrooms: 2,
          bathrooms: 1.5,
          receptionRooms: 1,
          floorArea: { value: 900, unit: 'sqft' },
          parkingSpaces: 1,
          furnishingCode: 'part_furnished',
          energyRating: 'B',
          featureCodes: ['parking', 'borehole', 'air_conditioning'],
        })
        .expect(201);
      expect(res.headers['location']).toBe(`/api/v1/units/${res.body.id}`);
      expect(res.body).toMatchObject({
        reference: expect.stringMatching(/^UNT-\d{4}-\d{6}$/),
        propertyId: building.id,
        unitType: { code: 'apartment' },
        bathrooms: 1.5,
        floorArea: { sqm: 83.61, value: 900, unit: 'sqft' },
        availability: 'available',
        featureCodes: ['air_conditioning', 'borehole', 'parking'],
        version: 1,
      });
    });

    it('validates unit fields and country-specific choices', async () => {
      const res = await as('owner')
        .post(`/api/v1/properties/${building.id}/units`, {
          unitLabel: 'Flat 9',
          unitTypeId: types['apartment_building'],
          bathrooms: 1.2,
          furnishingCode: 'luxury',
          featureCodes: ['central_heating'],
        })
        .expect(422);
      expect(res.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`).sort()).toEqual([
        'bathrooms:step',
        'featureCodes.0:unknown-code',
        'furnishingCode:unknown-code',
        'unitTypeId:not-applicable',
      ]);
      await as('owner').post(`/api/v1/properties/${building.id}/units`, { unitLabel: 'Villa', unitTypeId: types['compound_villa'] }).expect(422);
    });

    it('rejects duplicate labels and a second whole-property unit', async () => {
      await as('owner').post(`/api/v1/properties/${building.id}/units`, { unitLabel: 'Flat 2A' }).expect(201);
      const duplicate = await as('owner').post(`/api/v1/properties/${building.id}/units`, { unitLabel: 'Flat 2A' }).expect(409);
      expect(duplicate.body.detail).toBe('Another unit of this property already has this label.');

      await as('owner').post(`/api/v1/properties/${building.id}/units`, { unitLabel: 'Whole', isWholeProperty: true }).expect(201);
      const second = await as('owner').post(`/api/v1/properties/${building.id}/units`, { unitLabel: 'Whole 2', isWholeProperty: true }).expect(409);
      expect(second.body.detail).toBe('This property already has a "whole property" unit.');
    });

    it('lists units with pagination and filters', async () => {
      for (const label of ['B1', 'B2', 'B3']) {
        await as('owner').post(`/api/v1/properties/${building.id}/units`, { unitLabel: label }).expect(201);
      }
      const first = await as('agentA').get(`/api/v1/properties/${building.id}/units?limit=2`).expect(200);
      expect(first.body.data.map((u: { unitLabel: string }) => u.unitLabel)).toEqual(['B1', 'B2']);
      const second = await as('agentA').get(`/api/v1/properties/${building.id}/units?limit=2&cursor=${first.body.page.nextCursor}`).expect(200);
      expect(second.body.data.map((u: { unitLabel: string }) => u.unitLabel)).toEqual(['B3', 'Flat 1A']);

      const available = await as('agentA').get(`/api/v1/properties/${building.id}/units?filter[availability]=available&sort=-createdAt&limit=100`).expect(200);
      expect(available.body.data.length).toBeGreaterThanOrEqual(5);
      await as('agentA').get(`/api/v1/properties/${building.id}/units?filter[availability]=broken`).expect(422);
      await as('otherAgent', other.companyId).get(`/api/v1/properties/${building.id}/units`).expect(404);
    });

    it('updates units, replacing features, without bumping the version for no-op changes', async () => {
      const created = await as('owner').post(`/api/v1/properties/${building.id}/units`, { unitLabel: 'Flat 3C', featureCodes: ['parking'] }).expect(201);
      const id = created.body.id;
      const same = await as('owner').patch(`/api/v1/units/${id}`, { unitLabel: 'Flat 3C', featureCodes: ['parking'] }, 1).expect(200);
      expect(same.body.version).toBe(1);

      const features = await as('owner').patch(`/api/v1/units/${id}`, { featureCodes: ['parking', 'balcony'] }, 1).expect(200);
      expect(features.body).toMatchObject({ featureCodes: ['balcony', 'parking'], version: 2 });

      const res = await as('owner').patch(`/api/v1/units/${id}`, { bedrooms: 3, floorArea: { value: 120, unit: 'sqm' }, energyRating: null }, 2).expect(200);
      expect(res.body).toMatchObject({ bedrooms: 3, floorArea: { sqm: 120, value: 120, unit: 'sqm' }, version: 3 });
      await as('owner').patch(`/api/v1/units/${id}`, { bedrooms: 4 }, 2).expect(412);
      await as('owner').patch(`/api/v1/units/${id}`, { floorArea: null, featureCodes: [] }, 3).expect(200);

      const audit = await fx.db.selectFrom('auditLogs').select('changes').where('entityId', '=', id).where('action', '=', 'unit.updated').orderBy('occurredAt').execute();
      expect(audit[0]?.changes).toMatchObject({ featureCodes: { old: ['parking'], new: ['balcony', 'parking'] } });
    });

    it('archives and restores units, respecting the property', async () => {
      const created = await as('owner').post(`/api/v1/properties/${building.id}/units`, { unitLabel: 'Flat 4D' }).expect(201);
      const id = created.body.id;
      await as('agentA').action(`/api/v1/units/${id}/archive`, 1, { reason: 'Merged' }).expect(403);
      const archived = await as('owner').action(`/api/v1/units/${id}/archive`, 1, { reason: 'Merged with 4E' }).expect(200);
      expect(archived.body.archivedAt).not.toBeNull();
      await as('owner').action(`/api/v1/units/${id}/archive`, 2, { reason: 'Again' }).expect(422);
      await as('owner').patch(`/api/v1/units/${id}`, { bedrooms: 1 }, 2).expect(422);
      await as('owner').action(`/api/v1/units/${id}/restore`, 1).expect(412);
      const restored = await as('owner').action(`/api/v1/units/${id}/restore`, 2).expect(200);
      expect(restored.body.archivedAt).toBeNull();
      await as('owner').action(`/api/v1/units/${id}/restore`, 3).expect(422);
    });

    it('cannot restore a unit of an archived property', async () => {
      const property = await as('owner').post('/api/v1/properties', ghanaProperty({ createWholePropertyUnit: true })).expect(201);
      const unit = await fx.db.selectFrom('units').select(['id', 'version']).where('propertyId', '=', property.body.id).executeTakeFirstOrThrow();
      await as('owner').action(`/api/v1/units/${unit.id}/archive`, 1, { reason: 'Demolished' }).expect(200);
      await as('owner').action(`/api/v1/properties/${property.body.id}/archive`, 1, { reason: 'Demolished' }).expect(200);
      const res = await as('owner').action(`/api/v1/units/${unit.id}/restore`, 2).expect(422);
      expect(res.body.detail).toBe('Restore the property before restoring its units.');
    });

    it('hides units of other companies and of out-of-scope properties', async () => {
      const unit = await as('owner').post(`/api/v1/properties/${building.id}/units`, { unitLabel: 'Flat 5E' }).expect(201);
      await as('otherAgent', other.companyId).get(`/api/v1/units/${unit.body.id}`).expect(404);
      await as('agentKumasi').get(`/api/v1/units/${unit.body.id}`).expect(404);
      await as('agentA').get(`/api/v1/units/${unit.body.id}`).expect(200);
      await as('agentA').get('/api/v1/units/not-a-uuid').expect(404);
      await as('owner').patch(`/api/v1/units/${other.officeId}`, { bedrooms: 1 }, 1).expect(404);
      await as('owner').action(`/api/v1/units/${other.officeId}/archive`, 1, { reason: 'Unknown' }).expect(404);
      await as('owner').action(`/api/v1/units/${other.officeId}/restore`, 1).expect(404);
      await as('owner').post(`/api/v1/properties/${other.officeId}/units`, { unitLabel: 'X' }).expect(404);
    });
  });
});
