import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * GIS targets (M5 verification report §7). 2,000 properties × 25 units × 2
 * listings = 100,000 listings, clustered realistically around Accra (40%),
 * Doha (30%) and London (30%), plus 100,000 contact addresses in the same
 * spatial index as noise. Requests go through the full API.
 */
const PROPERTIES = 2_000;
const LISTINGS = PROPERTIES * 25 * 2;
const TARGETS_MS = { radius: 1_000, sortedPages: 500, mapCity: 500, mapClustered: 800, polygon: 1_000, notes: 300 };
const ACCRA = { latitude: 5.6037, longitude: -0.187 };

const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;

describe('location search performance (100,000 listings)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let tokens: string[];
  let notedPropertyId: string;

  beforeAll(async () => {
    t = await createTestApp({ MAP_RATE_LIMIT_PER_MINUTE: '10000' });
    fx = new Fixtures();
    company = await fx.company();
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    await fx.linkIdentity(company.ownerUserId, `gis-owner-${company.companyId}`);
    await fx.linkIdentity(agent.userId, `gis-agent-${company.companyId}`);
    const authTime = Math.floor(Date.now() / 1000);
    tokens = [
      await t.idp.token({ sub: `gis-owner-${company.companyId}`, amr: ['pwd', 'mfa'], authTime }),
      await t.idp.token({ sub: `gis-agent-${company.companyId}`, amr: ['pwd', 'mfa'], authTime }),
    ];
    const c = company.companyId;
    const owner = company.ownerMembershipId;
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();

    // Deterministic "random" spread: the sum of two uniform offsets clusters points towards each city centre.
    await sql`
      with spec as (
        select n,
               case when n % 10 < 4 then 'GH' when n % 10 < 7 then 'QA' else 'GB' end as country,
               ((abs(hashtext(n || 'a')) % 10000) + (abs(hashtext(n || 'b')) % 10000)) / 20000.0 - 0.5 as dx,
               ((abs(hashtext(n || 'c')) % 10000) + (abs(hashtext(n || 'd')) % 10000)) / 20000.0 - 0.5 as dy
          from generate_series(1, ${PROPERTIES}) n
      ), addr as (
        insert into addresses (company_id, country_code, address_line_1, locality, formatted, latitude, longitude, geocode_source, geocoded_at)
        select ${c}::uuid, country, n || ' Spatial Road',
               case country when 'GH' then 'Accra' when 'QA' then 'Doha' else 'London' end,
               n || ' Spatial Road',
               round((case country when 'GH' then 5.6037 when 'QA' then 25.2854 else 51.5072 end + dy * 0.2)::numeric, 6),
               round((case country when 'GH' then -0.187 when 'QA' then 51.531 else -0.1276 end + dx * 0.2)::numeric, 6),
               'import', now()
          from spec
        returning id, country_code
      ), numbered as (select id, country_code, row_number() over () as n from addr)
      insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
      select ${c}::uuid, 'GIS-P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, country_code,
             case country_code when 'GH' then 'Africa/Accra' when 'QA' then 'Asia/Qatar' else 'Europe/London' end,
             'Spatial ' || n, ${owner}::uuid
        from numbered`.execute(fx.db);
    await sql`
      insert into units (company_id, property_id, reference, unit_label, bedrooms)
      select p.company_id, p.id, p.reference || '-U' || u, 'Flat ' || u, (u % 5)::smallint
        from properties p cross join generate_series(1, 25) u
       where p.company_id = ${c}::uuid and p.reference like 'GIS-P-%'`.execute(fx.db);
    await sql`
      insert into listings (company_id, reference, unit_id, listing_type, status, currency_code, price, rent_frequency,
                            agent_membership_id, office_id, default_locale_code, title, is_published, listed_at)
      select u.company_id, 'GIS-L-' || k.kind || '-' || u.reference, u.id, k.kind,
             (array['draft', 'available', 'reserved', 'withdrawn'])[1 + (abs(hashtext(u.reference)) % 4)],
             'GHS', 100000 + (abs(hashtext(u.reference)) % 900000), case when k.kind = 'rent' then 'monthly' end,
             ${owner}::uuid, ${company.officeId}::uuid, 'en-GH', 'Spatial listing ' || u.reference, (abs(hashtext(u.reference)) % 4) in (1, 2), now()
        from units u cross join (values ('sale'), ('rent')) as k (kind)
       where u.company_id = ${c}::uuid and u.reference like 'GIS-P-%'`.execute(fx.db);
    // Contact addresses share the table and its spatial index.
    await sql`
      insert into addresses (company_id, country_code, address_line_1, locality, latitude, longitude, geocode_source, geocoded_at)
      select ${c}::uuid, 'GH', n || ' Home Street', 'Accra',
             round((5.6037 + ((abs(hashtext(n || 'e')) % 10000) / 10000.0 - 0.5) * 0.3)::numeric, 6),
             round((-0.187 + ((abs(hashtext(n || 'f')) % 10000) / 10000.0 - 0.5) * 0.3)::numeric, 6), 'import', now()
        from generate_series(1, 100000) n`.execute(fx.db);

    notedPropertyId = (
      await fx.db.selectFrom('properties').select('id').where('companyId', '=', c).where('reference', '=', 'GIS-P-1').executeTakeFirstOrThrow()
    ).id;
    await sql`
      insert into property_notes (company_id, property_id, body, category, created_by, created_at)
      select ${c}::uuid, ${notedPropertyId}::uuid, 'Visit note ' || n || ': ' || repeat('details ', 20),
             (array['general', 'access', 'viewing'])[1 + n % 3], ${owner}::uuid, now() - make_interval(mins => n)
        from generate_series(1, 2000) n`.execute(fx.db);

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-gis-analyze');
    try {
      await sql`vacuum (analyze) addresses, properties, units, listings, property_notes`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 600_000);

  afterAll(async () => {
    const c = company.companyId;
    await sql`delete from property_notes where company_id = ${c}::uuid`.execute(fx.db);
    await sql`delete from listings where company_id = ${c}::uuid and reference like 'GIS-L-%'`.execute(fx.db);
    await sql`delete from units where company_id = ${c}::uuid and reference like 'GIS-P-%'`.execute(fx.db);
    await sql`delete from properties where company_id = ${c}::uuid and reference like 'GIS-P-%'`.execute(fx.db);
    await fx.close();
    await t.close();
  }, 600_000);

  const measure = async (paths: string[], runs = 3): Promise<number[]> => {
    const samples: number[] = [];
    for (const token of tokens) {
      for (const path of paths) {
        for (let run = 0; run < runs; run++) {
          const started = performance.now();
          const res = await t.http.get(path).auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId);
          samples.push(performance.now() - started);
          expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
        }
      }
    }
    return samples;
  };

  it('meets the GIS response-time targets', async () => {
    const count = await sql<{ n: number }>`select count(*)::int as n from listings where company_id = ${company.companyId}::uuid`.execute(fx.db);
    expect(count.rows[0]!.n).toBe(LISTINGS);
    const centre = `filter[near]=${ACCRA.latitude},${ACCRA.longitude}`;

    const radius = await measure([
      `/api/v1/listings?${centre}&filter[radius]=2000&filter[status]=available&filter[bedrooms][gte]=2`,
      `/api/v1/listings?${centre}&filter[radius]=2000&filter[currencyCode]=GHS&filter[price][lte]=500000`,
      `/api/v1/listings?${centre}&filter[radius]=10000&filter[listingType]=rent`,
      `/api/v1/properties?${centre}&filter[radius]=2000`,
      `/api/v1/listings?filter[near]=25.2854,51.531&filter[radius]=5000&filter[status]=available`,
    ]);

    const sortedPages: number[] = [];
    for (const token of tokens) {
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const started = performance.now();
        const res: { body: { data: unknown[]; page: { nextCursor: string | null } } } = await t.http
          .get(`/api/v1/listings?${centre}&filter[radius]=3000&sort=distance&limit=50${cursor ? `&cursor=${cursor}` : ''}`)
          .auth(token, { type: 'bearer' })
          .set('X-Company-Id', company.companyId)
          .expect(200);
        sortedPages.push(performance.now() - started);
        expect(res.body.data).toHaveLength(50);
        cursor = res.body.page.nextCursor;
      }
    }

    const mapCity = await measure([
      `/api/v1/listings/map?filter[bbox]=-0.190,5.601,-0.184,5.607&filter[status]=available`,
      `/api/v1/properties/map?filter[bbox]=-0.24,5.55,-0.13,5.66`,
    ]);
    const mapClustered = await measure([
      '/api/v1/listings/map?filter[bbox]=-0.35,5.45,0.0,5.75',
      '/api/v1/listings/map?filter[bbox]=-3.3,4.7,1.2,11.2&filter[listingType]=sale',
    ]);
    const circle = Array.from({ length: 100 }, (_, i) => {
      const angle = (2 * Math.PI * i) / 100;
      return `${(ACCRA.longitude + 0.027 * Math.cos(angle)).toFixed(6)} ${(ACCRA.latitude + 0.027 * Math.sin(angle)).toFixed(6)}`;
    }).join(',');
    const polygon = await measure([`/api/v1/listings?filter[polygon]=${encodeURIComponent(circle)}&filter[status]=available`]);
    const notes = await measure([
      `/api/v1/properties/${notedPropertyId}/notes`,
      `/api/v1/properties/${notedPropertyId}/notes?filter[category]=access&sort=-updatedAt`,
    ]);

    const results = { radius, sortedPages, mapCity, mapClustered, polygon, notes };
    console.info(
      Object.entries(results)
        .map(([name, samples]) => `${name}: n=${samples.length} p95 ${p95(samples).toFixed(0)} ms (target ${TARGETS_MS[name as keyof typeof TARGETS_MS]})`)
        .join('; '),
    );
    for (const [name, samples] of Object.entries(results)) {
      expect(p95(samples), name).toBeLessThan(TARGETS_MS[name as keyof typeof TARGETS_MS]);
    }

    const map = await t.http
      .get('/api/v1/listings/map?filter[bbox]=-0.35,5.45,0.0,5.75')
      .auth(tokens[0]!, { type: 'bearer' })
      .set('X-Company-Id', company.companyId)
      .expect(200);
    expect(map.body.clustered).toBe(true);
    expect(map.body.total).toBe(40_000);
  }, 600_000);

  it('uses the spatial index for location filters', async () => {
    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-gis-explain');
    try {
      const { rows } = await sql<{ 'QUERY PLAN': string }>`
        explain select id from addresses
         where company_id = ${company.companyId}::uuid
           and ST_DWithin(location, ST_SetSRID(ST_MakePoint(${ACCRA.longitude}::float8, ${ACCRA.latitude}::float8), 4326)::geography, 2000::float8)`.execute(admin);
      expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('addresses_location_gist_idx');
    } finally {
      await admin.destroy();
    }
  });
});
