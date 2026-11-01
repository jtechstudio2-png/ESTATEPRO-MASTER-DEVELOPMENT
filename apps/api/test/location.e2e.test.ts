import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAP_POINT_LIMIT } from '../src/location/map-results.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

/** Real places (WGS 84) used across the tests. */
const PLACES = {
  osu: { latitude: 5.5571, longitude: -0.1818 },
  eastLegon: { latitude: 5.635, longitude: -0.16 },
  tema: { latitude: 5.6698, longitude: -0.0166 },
  kumasi: { latitude: 6.6885, longitude: -1.6244 },
  london: { latitude: 51.5072, longitude: -0.1276 },
};

describe('location search (Phase 4 M5, ADR-006)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const types: Record<string, string> = {};

  const as = (who: string, companyId = company.companyId) => ({
    get: (path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId),
    post: (path: string, body?: object) => t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body ?? {}),
    patch: (path: string, body: object, version: number) =>
      t.http.patch(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).set('If-Match', `"${version}"`).send(body),
  });

  const property = (name: string, place: { latitude: number; longitude: number } | null, officeId = company.officeId, extra: object = {}) => ({
    name,
    propertyTypeId: types['house_detached'],
    officeId,
    createWholePropertyUnit: true,
    address: {
      countryCode: 'GH',
      addressLine1: `${name} Road`,
      locality: name === 'Kumasi Villa' ? 'Kumasi' : 'Accra',
      adminArea1: name === 'Kumasi Villa' ? 'Ashanti' : 'Greater Accra',
      ...(place ?? {}),
      ...extra,
    },
  });

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const agentKumasi = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [kumasiOfficeId] });
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['agentKumasi', agentKumasi.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `loc-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `loc-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    }
    for (const row of await fx.db.selectFrom('propertyTypes').select(['id', 'code']).where('companyId', 'is', null).execute()) types[row.code] = row.id;

    const create = async (key: string, body: object, who = 'owner', companyId = company.companyId) => {
      const res = await as(who, companyId).post('/api/v1/properties', body).expect(201);
      ids[key] = res.body.id;
      const unit = await fx.db.selectFrom('units').select('id').where('propertyId', '=', res.body.id).executeTakeFirstOrThrow();
      ids[`${key}Unit`] = unit.id;
    };
    await create('osu', property('Osu House', PLACES.osu));
    await create('eastLegon', property('East Legon House', PLACES.eastLegon));
    await create('tema', property('Tema House', PLACES.tema));
    await create('kumasi', property('Kumasi Villa', PLACES.kumasi, kumasiOfficeId));
    await create('nowhere', property('Unmapped House', null));
    await create('otherOsu', { ...property('Other Osu', PLACES.osu), officeId: other.officeId }, 'otherOwner', other.companyId);

    for (const key of ['osu', 'eastLegon', 'tema', 'kumasi']) {
      const officeId = key === 'kumasi' ? kumasiOfficeId : company.officeId;
      ids[`${key}Listing`] = (await fx.listing(company.companyId, ids[`${key}Unit`]!, company.ownerMembershipId, officeId)).id;
    }
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  const near = (place: { latitude: number; longitude: number }, radius: number) =>
    `filter[near]=${place.latitude},${place.longitude}&filter[radius]=${radius}`;
  const names = (body: { data: Array<{ name?: string; id: string }> }) => body.data.map((row) => row.name ?? row.id).sort();

  describe('stored locations', () => {
    it('records how a point was found and when it was confirmed', async () => {
      const res = await as('owner').get(`/api/v1/properties/${ids['osu']}`).expect(200);
      expect(res.body.address).toMatchObject({
        latitude: PLACES.osu.latitude,
        longitude: PLACES.osu.longitude,
        geocodeSource: 'manual_pin',
        geocodeAccuracy: null,
        locationStale: false,
      });
      expect(res.body.address.geocodedAt).toEqual(expect.any(String));
      expect(res.body).not.toHaveProperty('internalNotes');

      const suggested = await as('owner')
        .post('/api/v1/properties', property('Suggested House', PLACES.eastLegon, company.officeId, { geocodeSource: 'geocoder', geocodeAccuracy: 'street' }))
        .expect(201);
      expect(suggested.body.address).toMatchObject({ geocodeSource: 'geocoder', geocodeAccuracy: 'street' });
    });

    it('rejects 0,0, points outside the country, and a source without a point (L-D5)', async () => {
      const zero = await as('owner').post('/api/v1/properties', property('Null Island', { latitude: 0, longitude: 0 })).expect(422);
      expect(zero.body.errors).toContainEqual(expect.objectContaining({ field: 'address.latitude', code: 'invalid-coordinates' }));
      const london = await as('owner').post('/api/v1/properties', property('Wrong Country', PLACES.london)).expect(422);
      expect(london.body.errors).toContainEqual(expect.objectContaining({ field: 'address.latitude', code: 'outside-country' }));
      const sourceOnly = await as('owner').post('/api/v1/properties', property('No Point', null, company.officeId, { geocodeSource: 'geocoder' })).expect(422);
      expect(sourceOnly.body.errors).toContainEqual(expect.objectContaining({ field: 'address.geocodeSource', code: 'needs-coordinates' }));
      const half = await as('owner').post('/api/v1/properties', property('Half', null, company.officeId, { latitude: 5.6, longitude: null })).expect(422);
      expect(half.body.errors).toContainEqual(expect.objectContaining({ field: 'address.latitude', code: 'pair' }));
    });

    it('keeps the point when the address is edited without coordinates, and flags it for checking', async () => {
      const created = await as('owner').post('/api/v1/properties', property('Moving House', PLACES.osu)).expect(201);
      const id = created.body.id as string;
      const address = { countryCode: 'GH', addressLine1: 'Moving House Road', locality: 'Accra', adminArea1: 'Greater Accra' };

      // Same text, no coordinates: nothing changes.
      const same = await as('owner').patch(`/api/v1/properties/${id}`, { address }, created.body.version).expect(200);
      expect(same.body.version).toBe(created.body.version);

      // New street, no coordinates: the point stays but is flagged.
      const moved = await as('owner').patch(`/api/v1/properties/${id}`, { address: { ...address, addressLine1: '1 New Road' } }, same.body.version).expect(200);
      expect(moved.body.address).toMatchObject({ latitude: PLACES.osu.latitude, geocodeSource: 'manual_pin', locationStale: true });

      // Confirming a new pin clears the flag and is audited as a location change.
      const pinned = await as('owner')
        .patch(`/api/v1/properties/${id}`, { address: { ...address, addressLine1: '1 New Road', ...PLACES.eastLegon } }, moved.body.version)
        .expect(200);
      expect(pinned.body.address).toMatchObject({ latitude: PLACES.eastLegon.latitude, locationStale: false });
      const audit = await fx.db
        .selectFrom('auditLogs')
        .select(['changes', 'metadata'])
        .where('entityId', '=', id)
        .where('action', '=', 'property.location_changed')
        .executeTakeFirstOrThrow();
      expect(audit.changes).toEqual({
        location: { old: { latitude: PLACES.osu.latitude, longitude: PLACES.osu.longitude }, new: PLACES.eastLegon },
      });
      expect(audit.metadata).toEqual({ geocodeSource: 'manual_pin', geocodeAccuracy: null });

      // Re-sending the same pin keeps the confirmation time.
      const again = await as('owner')
        .patch(`/api/v1/properties/${id}`, { address: { ...address, addressLine1: '1 New Road', ...PLACES.eastLegon }, name: 'Renamed' }, pinned.body.version)
        .expect(200);
      expect(again.body.address.geocodedAt).toBe(pinned.body.address.geocodedAt);

      // Explicit nulls remove the point.
      const cleared = await as('owner')
        .patch(`/api/v1/properties/${id}`, { address: { ...address, latitude: null, longitude: null } }, again.body.version)
        .expect(200);
      expect(cleared.body.address).toMatchObject({ latitude: null, longitude: null, geocodeSource: null, geocodedAt: null, locationStale: false });
    });
  });

  describe('property search', () => {
    it('finds properties within a radius, nearest first, with distances', async () => {
      const close = await as('owner').get(`/api/v1/properties?${near(PLACES.osu, 3_000)}`).expect(200);
      expect(names(close.body)).toEqual(['Osu House']);

      const wider = await as('owner').get(`/api/v1/properties?${near(PLACES.osu, 15_000)}&sort=distance&filter[propertyTypeId]=${types['house_detached']}`).expect(200);
      const matched = wider.body.data.filter((row: { name: string }) => ['Osu House', 'East Legon House'].includes(row.name));
      expect(matched.map((row: { name: string }) => row.name)).toEqual(['Osu House', 'East Legon House']);
      expect(matched[0].distanceMeters).toBe(0);
      // East Legon is about 9 km from Osu.
      expect(matched[1].distanceMeters).toBeGreaterThan(8_000);
      expect(matched[1].distanceMeters).toBeLessThan(10_000);
      expect(wider.body.data.map((row: { name: string }) => row.name)).not.toContain('Tema House');

      const all = await as('owner').get(`/api/v1/properties?${near(PLACES.osu, 50_000)}&sort=-distance&limit=1`).expect(200);
      expect(all.body.data[0].name).toBe('Tema House');
      const next = await as('owner').get(`/api/v1/properties?${near(PLACES.osu, 50_000)}&sort=-distance&limit=1&cursor=${all.body.page.nextCursor}`).expect(200);
      expect(next.body.data[0].distanceMeters).toBeLessThan(all.body.data[0].distanceMeters);
    });

    it('filters by map viewport, drawn polygon, missing location and place names', async () => {
      const accraViewport = '-0.35,5.45,0.05,5.75';
      const viewport = await as('owner').get(`/api/v1/properties?filter[bbox]=${accraViewport}&limit=100`).expect(200);
      expect(names(viewport.body)).toEqual(expect.arrayContaining(['East Legon House', 'Osu House', 'Tema House']));
      expect(names(viewport.body)).not.toContain('Kumasi Villa');

      // A triangle around Osu and East Legon (longitude latitude pairs).
      const triangle = encodeURIComponent('-0.25 5.50,-0.10 5.50,-0.17 5.70');
      const drawn = await as('owner').get(`/api/v1/properties?filter[polygon]=${triangle}&limit=100`).expect(200);
      expect(names(drawn.body)).toEqual(expect.arrayContaining(['East Legon House', 'Osu House']));
      expect(names(drawn.body)).not.toContain('Tema House');

      const unmapped = await as('owner').get('/api/v1/properties?filter[hasLocation]=false').expect(200);
      // "Renamed" had its point removed in the address test above.
      expect(names(unmapped.body)).toEqual(['Renamed', 'Unmapped House']);
      const mapped = await as('owner').get('/api/v1/properties?filter[hasLocation]=true&limit=100').expect(200);
      expect(names(mapped.body)).not.toContain('Unmapped House');

      const kumasi = await as('owner').get('/api/v1/properties?filter[locality]=kumasi').expect(200);
      expect(names(kumasi.body)).toEqual(['Kumasi Villa']);
      const ashanti = await as('owner').get('/api/v1/properties?filter[adminArea1]=ASHANTI').expect(200);
      expect(names(ashanti.body)).toEqual(['Kumasi Villa']);
    });

    it('applies office scope and company isolation before any location match', async () => {
      const kumasiAgent = await as('agentKumasi').get(`/api/v1/properties?${near(PLACES.osu, 50_000)}`).expect(200);
      expect(kumasiAgent.body.data).toEqual([]);
      const ownKumasi = await as('agentKumasi').get(`/api/v1/properties?${near(PLACES.kumasi, 1_000)}`).expect(200);
      expect(names(ownKumasi.body)).toEqual(['Kumasi Villa']);
      const otherCompany = await as('otherOwner', other.companyId).get(`/api/v1/properties?${near(PLACES.osu, 1_000)}`).expect(200);
      expect(names(otherCompany.body)).toEqual(['Other Osu']);
    });

    it('rejects incomplete, oversized and malformed shapes', async () => {
      const cases: Array<[string, string, string]> = [
        ['filter[near]=5.55,-0.18', 'filter[radius]', 'pair'],
        ['filter[radius]=500', 'filter[near]', 'pair'],
        [`${near(PLACES.osu, 50_001)}`, 'filter[radius]', 'radius-too-large'],
        ['filter[near]=95,-0.18&filter[radius]=10', 'filter[near]', 'invalid-coordinates'],
        ['sort=distance', 'sort', 'distance-sort-needs-near'],
        ['filter[bbox]=0.05,5.45,-0.35,5.75', 'filter[bbox]', 'invalid-bbox'],
        ['filter[bbox]=-40,0,0,5', 'filter[bbox]', 'area-too-large'],
        [`filter[polygon]=${encodeURIComponent('-0.2 5.5,-0.1 5.6,-0.2 5.6,-0.1 5.5')}`, 'filter[polygon]', 'invalid-polygon'],
        [`filter[polygon]=${encodeURIComponent('-3 5,1 5,1 11,-3 11')}`, 'filter[polygon]', 'area-too-large'],
        [`filter[polygon]=${encodeURIComponent('-0.2 5.5,-0.1 5.5,-0.2 5.5')}`, 'filter[polygon]', 'invalid-polygon'],
        ['filter[hasLocation]=false&filter[bbox]=-0.35,5.45,0.05,5.75', 'filter[hasLocation]', 'conflict'],
      ];
      for (const [query, field, code] of cases) {
        const res = await as('owner').get(`/api/v1/properties?${query}`).expect(422);
        expect(res.body.errors, query).toContainEqual(expect.objectContaining({ field, code }));
      }
      const tooMany = Array.from({ length: 101 }, (_, i) => `${(-0.2 + Math.cos(i) * 0.01).toFixed(5)} ${(5.6 + Math.sin(i) * 0.01).toFixed(5)}`).join(',');
      await as('owner').get(`/api/v1/properties?filter[polygon]=${encodeURIComponent(tooMany)}`).expect(422);
    });
  });

  describe('listing search', () => {
    it('combines location with listing filters and sorts by distance', async () => {
      const res = await as('owner').get(`/api/v1/listings?${near(PLACES.osu, 50_000)}&filter[status]=available&sort=distance`).expect(200);
      expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([ids['osuListing'], ids['eastLegonListing'], ids['temaListing']]);
      expect(res.body.data[0]).toMatchObject({ distanceMeters: 0, property: { latitude: PLACES.osu.latitude, longitude: PLACES.osu.longitude } });
      const page = await as('owner').get(`/api/v1/listings?${near(PLACES.osu, 50_000)}&sort=distance&limit=2`).expect(200);
      const rest = await as('owner').get(`/api/v1/listings?${near(PLACES.osu, 50_000)}&sort=distance&limit=2&cursor=${page.body.page.nextCursor}`).expect(200);
      expect(rest.body.data.map((row: { id: string }) => row.id)).toEqual([ids['temaListing']]);

      const viewport = await as('owner').get('/api/v1/listings?filter[bbox]=-2,6.5,-1.4,6.9').expect(200);
      expect(viewport.body.data.map((row: { id: string }) => row.id)).toEqual([ids['kumasiListing']]);
      expect(viewport.body.data[0].distanceMeters).toBeNull();
      const agentView = await as('agentKumasi').get(`/api/v1/listings?${near(PLACES.osu, 50_000)}`).expect(200);
      expect(agentView.body.data).toEqual([]);
    });

    it('shows listings on the map as points with price and cover', async () => {
      const res = await as('owner').get('/api/v1/listings/map?filter[bbox]=-0.35,5.45,0.05,5.75').expect(200);
      expect(res.body).toMatchObject({ total: 3, clustered: false, clusters: [] });
      const osu = res.body.points.find((point: { id: string }) => point.id === ids['osuListing']);
      expect(osu).toMatchObject({
        latitude: PLACES.osu.latitude,
        longitude: PLACES.osu.longitude,
        status: 'available',
        price: { amount: '450000.00', currency: 'GHS' },
        coverMediaId: null,
        propertyId: ids['osu'],
      });
      await as('owner').get('/api/v1/listings/map').expect(422);
    });
  });

  describe('property map', () => {
    it('returns points, and clusters above the point limit', async () => {
      const points = await as('owner').get('/api/v1/properties/map?filter[bbox]=-2,5,0.5,7').expect(200);
      expect(points.body.clustered).toBe(false);
      expect(points.body.points.map((point: { name: string }) => point.name)).toEqual(expect.arrayContaining(['Kumasi Villa', 'Osu House']));

      // A dense estate: more than MAP_POINT_LIMIT properties around Tema.
      const count = MAP_POINT_LIMIT + 20;
      await sql`
        with addresses_in as (
          insert into addresses (company_id, country_code, address_line_1, locality, latitude, longitude, geocode_source, geocoded_at)
          select ${company.companyId}::uuid, 'GH', 'Estate plot ' || n, 'Tema', 5.60 + (n % 30) * 0.002, -0.05 + (n / 30) * 0.002, 'import', now()
            from generate_series(1, ${count}) n
          returning id
        )
        insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone)
        select ${company.companyId}::uuid, 'EST-' || row_number() over (), ${types['house_detached']}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra'
          from addresses_in`.execute(fx.db);

      const clustered = await as('owner').get('/api/v1/properties/map?filter[bbox]=-0.35,5.45,0.05,5.75').expect(200);
      expect(clustered.body.clustered).toBe(true);
      expect(clustered.body.points).toEqual([]);
      expect(clustered.body.total).toBe(count + 3 + 1); // the estate, Osu, East Legon, Tema and the suggested house
      const cell = clustered.body.clusters[0];
      expect(cell.count).toBeGreaterThan(1);
      const [west, south, east, north] = cell.bounds;
      expect(west).toBeLessThanOrEqual(cell.longitude);
      expect(east).toBeGreaterThanOrEqual(cell.longitude);
      expect(south).toBeLessThanOrEqual(cell.latitude);
      expect(north).toBeGreaterThanOrEqual(cell.latitude);

      // The Kumasi agent's map stays empty in Accra: clusters never count hidden records.
      const hidden = await as('agentKumasi').get('/api/v1/properties/map?filter[bbox]=-0.35,5.45,0.05,5.75').expect(200);
      expect(hidden.body).toMatchObject({ total: 0, clustered: false, points: [] });
    });
  });
});

describe('geocoding suggestions (L-D2)', () => {
  let stub: Server;
  let stubUrl: string;
  let lastRequest: URL | null = null;
  let mode: 'ok' | 'error' | 'hang' | 'garbage' | 'shape' = 'ok';
  let t: TestApp;
  let disabled: TestApp;
  let fx: Fixtures;
  let companyId: string;
  let token: string;
  let agentToken: string;

  beforeAll(async () => {
    stub = createServer((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = new URL(req.url ?? '/', 'http://stub');
      if (mode === 'hang') return;
      if (mode === 'error') {
        res.writeHead(401).end('{"message":"Not Authorized - Invalid Token"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (mode === 'garbage') return void res.end('not json');
      if (mode === 'shape') return void res.end('{"type":"FeatureCollection"}');
      res.end(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [-0.181812345, 5.557123456] },
              properties: { feature_type: 'address', full_address: '12 Oxford Street, Osu, Accra, Ghana', coordinates: { accuracy: 'rooftop' } },
            },
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [-0.16, 5.635] },
              properties: { feature_type: 'neighborhood', name: 'East Legon', place_formatted: 'Accra, Ghana' },
            },
            // Outside Ghana: never offered (L-D5).
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-0.1276, 51.5072] }, properties: { feature_type: 'place', name: 'London' } },
            // Unusable entries are skipped.
            { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { name: 'Area' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-0.2, 5.6] }, properties: {} },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
    t = await createTestApp({
      GEOCODER_PROVIDER: 'mapbox',
      MAPBOX_ACCESS_TOKEN: 'pk.test-token',
      MAPBOX_API_URL: stubUrl,
      GEOCODER_TIMEOUT_MS: '500',
      GEOCODER_RATE_LIMIT_PER_MINUTE: '6',
    });
    disabled = await createTestApp();
    fx = new Fixtures();
    const company = await fx.company();
    companyId = company.companyId;
    await fx.linkIdentity(company.ownerUserId, `geo-owner-${companyId}`);
    token = await t.idp.token({ sub: `geo-owner-${companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    const accountant = await fx.member(companyId, { roleKey: 'accountant' });
    await fx.linkIdentity(accountant.userId, `geo-acct-${companyId}`);
    agentToken = await t.idp.token({ sub: `geo-acct-${companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    stub.closeAllConnections();
    await new Promise((resolve) => stub.close(resolve));
    await fx.close();
    await t.close();
    await disabled.close();
  });

  const ask = (app: TestApp, query: string, bearer = token) =>
    app.http.get(`/api/v1/geocoding/suggestions?${query}`).auth(bearer, { type: 'bearer' }).set('X-Company-Id', companyId);

  it('returns suggestions inside the country with accuracy, never storing anything', async () => {
    mode = 'ok';
    const res = await ask(t, 'q=12%20Oxford%20Street&countryCode=GH&near=5.6,-0.2&language=en').expect(200);
    expect(res.body.data).toEqual([
      { label: '12 Oxford Street, Osu, Accra, Ghana', latitude: 5.557123, longitude: -0.181812, accuracy: 'rooftop', geocodeSource: 'geocoder' },
      { label: 'East Legon, Accra, Ghana', latitude: 5.635, longitude: -0.16, accuracy: 'locality', geocodeSource: 'geocoder' },
    ]);
    expect(lastRequest?.pathname).toBe('/search/geocode/v6/forward');
    expect(Object.fromEntries(lastRequest!.searchParams)).toMatchObject({
      q: '12 Oxford Street',
      country: 'gh',
      permanent: 'true',
      proximity: '-0.2,5.6',
      language: 'en',
      access_token: 'pk.test-token',
    });
  });

  it('validates input and needs a property editing role', async () => {
    const bad = await ask(t, 'q=ab&countryCode=gh&near=x&language=english').expect(422);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['countryCode', 'language', 'near', 'q']);
    await ask(t, 'q=Accra&countryCode=ZZ').expect(422);
    await ask(t, 'q=Accra&countryCode=GH', agentToken).expect(403);
  });

  it('reports the provider as unavailable on errors, bad answers and timeouts', async () => {
    for (const failure of ['error', 'garbage', 'shape', 'hang'] as const) {
      mode = failure;
      const res = await ask(t, 'q=Osu%20Accra&countryCode=GH').expect(503);
      expect(res.body.type).toBe('urn:estatepro:problem:geocoding-unavailable');
      expect(JSON.stringify(res.body)).not.toContain('pk.test-token');
    }
    mode = 'ok';
  });

  it('limits requests per company with Retry-After', async () => {
    // Six per minute are allowed in this app; earlier tests used some of them.
    let res = await ask(t, 'q=Osu%20Accra&countryCode=GH');
    while (res.status === 200) res = await ask(t, 'q=Osu%20Accra&countryCode=GH');
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body.type).toBe('urn:estatepro:problem:too-many-requests');
  });

  it('is unavailable when no provider is configured (pins still work)', async () => {
    const disabledToken = await disabled.idp.token({ sub: `geo-owner-${companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    const res = await ask(disabled, 'q=Osu%20Accra&countryCode=GH', disabledToken).expect(503);
    expect(res.body.type).toBe('urn:estatepro:problem:geocoding-unavailable');
  });
});
