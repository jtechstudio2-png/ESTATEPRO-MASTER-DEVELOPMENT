import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Phase 1 §6 target: listing search with filters on 100,000 listings per
 * company at p95 under 1 s (gap G6). Data is bulk-loaded with SQL; requests go
 * through the full API (auth, tenant transaction, RLS, scope).
 */
const LISTINGS = 100_000;
const TARGET_P95_MS = 1_000;

describe('listing search performance (100,000 listings)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let token: string;
  let agentToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    await fx.linkIdentity(company.ownerUserId, `perf-owner-${company.companyId}`);
    await fx.linkIdentity(agent.userId, `perf-agent-${company.companyId}`);
    const authTime = Math.floor(Date.now() / 1000);
    token = await t.idp.token({ sub: `perf-owner-${company.companyId}`, amr: ['pwd', 'mfa'], authTime });
    agentToken = await t.idp.token({ sub: `perf-agent-${company.companyId}`, amr: ['pwd', 'mfa'], authTime });

    const owner = await fx.db
      .selectFrom('companyMemberships')
      .select('id')
      .where('companyId', '=', company.companyId)
      .where('userId', '=', company.ownerUserId)
      .executeTakeFirstOrThrow();
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();
    const c = company.companyId;
    // 1,000 properties × 50 units; each unit has a sale and a rental listing.
    await sql`
      with addr as (
        insert into addresses (company_id, country_code, address_line_1, locality, formatted)
        select ${c}::uuid, 'GH', n || ' Ring Road', 'Accra', n || ' Ring Road, Accra' from generate_series(1, 1000) n
        returning id
      ), numbered as (select id, row_number() over () as n from addr)
      insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
      select ${c}::uuid, 'PERF-P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Block ' || n, ${owner.id}::uuid from numbered
    `.execute(fx.db);
    await sql`
      insert into units (company_id, property_id, reference, unit_label, bedrooms)
      select p.company_id, p.id, p.reference || '-U' || u, 'Flat ' || u, (u % 5)::smallint
        from properties p cross join generate_series(1, 50) u
       where p.company_id = ${c}::uuid and p.reference like 'PERF-P-%'
    `.execute(fx.db);
    await sql`
      insert into listings (company_id, reference, unit_id, listing_type, status, currency_code, price, rent_frequency,
                            agent_membership_id, office_id, default_locale_code, title, is_published, listed_at)
      select u.company_id, 'PERF-L-' || t.kind || '-' || u.reference, u.id, t.kind,
             (array['draft', 'available', 'reserved', 'withdrawn'])[1 + (abs(hashtext(u.reference)) % 4)],
             'GHS',
             case when t.kind = 'sale' then 100000 + (abs(hashtext(u.reference)) % 900000) else 1000 + (abs(hashtext(u.reference)) % 9000) end,
             case when t.kind = 'rent' then 'monthly' end,
             ${owner.id}::uuid, ${company.officeId}::uuid, 'en-GH',
             u.bedrooms || '-bed ' || case when t.kind = 'sale' then 'apartment for sale' else 'apartment to let' end || ' in ' || u.unit_label,
             (abs(hashtext(u.reference)) % 4) in (1, 2), now()
        from units u cross join (values ('sale'), ('rent')) as t (kind)
       where u.company_id = ${c}::uuid and u.reference like 'PERF-P-%'
    `.execute(fx.db);
    // Steady state as autovacuum/autoanalyze would leave it after a bulk load
    // (run as the table owner: other roles' VACUUM/ANALYZE silently skip tables).
    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-perf-analyze');
    try {
      await sql`vacuum (analyze) addresses, properties, units, listings, listing_translations`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 300_000);

  afterAll(async () => {
    const c = company.companyId;
    await sql`delete from listings where company_id = ${c}::uuid and reference like 'PERF-L-%'`.execute(fx.db);
    await sql`delete from units where company_id = ${c}::uuid and reference like 'PERF-P-%'`.execute(fx.db);
    await sql`delete from properties where company_id = ${c}::uuid and reference like 'PERF-P-%'`.execute(fx.db);
    await fx.close();
    await t.close();
  }, 600_000);

  it(`answers typical list queries at p95 under ${TARGET_P95_MS} ms`, async () => {
    const count = await sql<{ n: number }>`select count(*)::int as n from listings where company_id = ${company.companyId}::uuid`.execute(fx.db);
    expect(count.rows[0]!.n).toBe(LISTINGS);

    const queries = [
      '/api/v1/listings',
      '/api/v1/listings?filter[status]=available&filter[listingType]=rent',
      '/api/v1/listings?filter[currencyCode]=GHS&filter[price][gte]=200000&filter[price][lte]=400000&filter[listingType]=sale',
      '/api/v1/listings?filter[bedrooms][gte]=3&filter[status]=available,reserved',
      '/api/v1/listings?sort=-price&filter[listingType]=sale&limit=100',
      '/api/v1/listings?filter[isPublished]=true&sort=createdAt',
      '/api/v1/listings?q=Flat%2042',
      '/api/v1/listings?q=PERF-L-rent-PERF-P-777-U9',
      '/api/v1/listings?q=to%20let%20in%20Flat%2017&filter[status]=available',
    ];
    const samples: number[] = [];
    let slowest = { ms: 0, path: '' };
    for (const who of [token, agentToken]) {
      for (const path of queries) {
        for (let run = 0; run < 3; run++) {
          const started = performance.now();
          const res = await t.http.get(path).auth(who, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);
          const elapsed = performance.now() - started;
          samples.push(elapsed);
          slowest = elapsed > slowest.ms ? { ms: elapsed, path } : slowest;
          expect(Array.isArray(res.body.data)).toBe(true);
        }
      }
      // Paging deep into the sorted result stays fast (keyset pagination).
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const started = performance.now();
        const res: { body: { page: { nextCursor: string | null } } } = await t.http
          .get(`/api/v1/listings?sort=-price&limit=100${cursor ? `&cursor=${cursor}` : ''}`)
          .auth(who, { type: 'bearer' })
          .set('X-Company-Id', company.companyId)
          .expect(200);
        samples.push(performance.now() - started);
        cursor = res.body.page.nextCursor;
      }
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    console.info(
      `listing search: ${samples.length} requests, median ${samples[Math.floor(samples.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, slowest ${slowest.ms.toFixed(0)} ms (${slowest.path})`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 300_000);
});
