import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { systemContext } from '../src/common/request-context.js';
import { SensitiveDataService } from '../src/crypto/sensitive-data.service.js';
import { createKysely, TenantDb } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Requirements, matching and KYC at scale (Phase 1 §6: list and search p95
 * under 1 s). One company with 40,000 listings (half published) on 20,000
 * units around Accra, 50,000 contacts each with a requirement (a mix of
 * areas: none, locality, radius and drawn shape), 50,000 identity documents
 * and 50,000 KYC checks. Requests go through the full API as owner and as an
 * agent (listing scope by office, contact scope with decision D1).
 */
const PROPERTIES = 2_000;
const CONTACTS = 50_000;
const TARGET_P95_MS = 1_000;
const ACCRA = { latitude: 5.6037, longitude: -0.187 };

describe('requirements, matching and KYC performance', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let ownerToken: string;
  let agentToken: string;
  const sample: { contactId: string; requirementId: string }[] = [];
  let agentSample: { contactId: string; requirementId: string };

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    await fx.linkIdentity(company.ownerUserId, `c2-perf-owner-${company.companyId}`);
    await fx.linkIdentity(agent.userId, `c2-perf-agent-${company.companyId}`);
    const authTime = Math.floor(Date.now() / 1000);
    ownerToken = await t.idp.token({ sub: `c2-perf-owner-${company.companyId}`, amr: ['pwd', 'mfa'], authTime });
    agentToken = await t.idp.token({ sub: `c2-perf-agent-${company.companyId}`, amr: ['pwd', 'mfa'], authTime });
    const c = company.companyId;
    const owner = company.ownerMembershipId;
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'house_detached').where('companyId', 'is', null).executeTakeFirstOrThrow();

    // Listings: 2,000 properties × 10 units × sale and rent; about half published.
    await sql`
      with addr as (
        insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted, latitude, longitude, geocode_source, geocoded_at)
        select ${c}::uuid, 'GH', n || ' Match Road', (array['Osu', 'East Legon', 'Airport', 'Cantonments', 'Tema'])[1 + n % 5], 'Greater Accra', n || ' Match Road',
               round((${ACCRA.latitude} + ((abs(hashtext(n || 'y')) % 10000) / 10000.0 - 0.5) * 0.2)::numeric, 6),
               round((${ACCRA.longitude} + ((abs(hashtext(n || 'x')) % 10000) / 10000.0 - 0.5) * 0.2)::numeric, 6), 'import', now()
          from generate_series(1, ${PROPERTIES}) n
        returning id
      ), numbered as (select id, row_number() over () as n from addr)
      insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
      select ${c}::uuid, 'C2P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Match house ' || n, ${owner}::uuid
        from numbered`.execute(fx.db);
    await sql`
      insert into units (company_id, property_id, reference, unit_label, bedrooms)
      select p.company_id, p.id, p.reference || '-U' || u, 'Unit ' || u, (1 + u % 5)::smallint
        from properties p cross join generate_series(1, 10) u
       where p.company_id = ${c}::uuid and p.reference like 'C2P-%'`.execute(fx.db);
    await sql`
      insert into unit_features (company_id, unit_id, feature_code)
      select u.company_id, u.id, f.code
        from units u cross join (values ('parking'), ('backup_generator'), ('borehole')) as f (code)
       where u.company_id = ${c}::uuid and u.reference like 'C2P-%' and abs(hashtext(u.reference || f.code)) % 3 = 0`.execute(fx.db);
    await sql`
      insert into listings (company_id, reference, unit_id, listing_type, status, currency_code, price, rent_frequency,
                            agent_membership_id, office_id, default_locale_code, title, is_published, published_at, listed_at)
      select u.company_id, 'C2L-' || k.kind || '-' || u.reference, u.id, k.kind, 'available', 'GHS',
             case k.kind when 'sale' then 300000 + (abs(hashtext(u.reference)) % 1700000) else 2000 + (abs(hashtext(u.reference)) % 18000) end,
             case when k.kind = 'rent' then (array['monthly', 'annual'])[1 + abs(hashtext(u.reference || 'f')) % 2] end,
             ${owner}::uuid, ${company.officeId}::uuid, 'en-GH', 'Match listing ' || u.reference,
             abs(hashtext(u.reference || k.kind)) % 2 = 0, now() - make_interval(mins => abs(hashtext(u.reference)) % 10000), now()
        from units u cross join (values ('sale'), ('rent')) as k (kind)
       where u.company_id = ${c}::uuid and u.reference like 'C2P-%'`.execute(fx.db);
    await sql`update listings set rent_frequency = 'monthly', price = price * 12 where company_id = ${c}::uuid and reference like 'C2L-rent-%' and rent_frequency = 'annual'`.execute(fx.db);

    // Contacts with one requirement each; every 20th is the agent's.
    await sql`
      insert into contacts (company_id, reference, contact_type, display_name, primary_phone_e164, office_id, owner_membership_id)
      select ${c}::uuid, 'C2C-' || n, 'person', 'Client ' || n, '+23326' || lpad(n::text, 7, '0'), ${company.officeId}::uuid,
             case when n % 20 = 0 then ${agent.membershipId}::uuid else ${owner}::uuid end
        from generate_series(1, ${CONTACTS}) n`.execute(fx.db);
    await sql`
      insert into requirements (company_id, contact_id, requirement_type, currency_code, min_price, max_price, rent_frequency,
                                min_bedrooms, max_bedrooms, locations, must_have_features, financing_status, move_by)
      select c.company_id, c.id, k.kind, 'GHS',
             case k.kind when 'buy' then 300000 + (n % 10) * 100000 else 2000 + (n % 10) * 1000 end,
             case k.kind when 'buy' then 900000 + (n % 10) * 100000 else 6000 + (n % 10) * 1000 end,
             case when k.kind = 'rent' then 'monthly' end,
             (1 + n % 3)::smallint, (3 + n % 3)::smallint,
             case n % 4
               when 0 then '[]'::jsonb
               when 1 then jsonb_build_array(jsonb_build_object('kind', 'locality', 'locality', (array['Osu', 'East Legon', 'Airport'])[1 + n % 3]))
               when 2 then jsonb_build_array(jsonb_build_object('kind', 'radius', 'latitude', ${ACCRA.latitude}::float8, 'longitude', ${ACCRA.longitude}::float8, 'radiusMetres', 3000 + (n % 5) * 1000))
               else jsonb_build_array(jsonb_build_object('kind', 'polygon', 'points', jsonb_build_array(
                      jsonb_build_array(-0.22, 5.57), jsonb_build_array(-0.15, 5.57), jsonb_build_array(-0.15, 5.64),
                      jsonb_build_array(-0.22, 5.64), jsonb_build_array(-0.22, 5.57))))
             end,
             case when n % 2 = 0 then array['parking', 'backup_generator'] else '{}' end,
             (array['cash', 'mortgage_approved', 'not_started'])[1 + n % 3], current_date + (n % 365)
        from (select c.*, substring(c.reference from 5)::int as n from contacts c where c.company_id = ${c}::uuid and c.reference like 'C2C-%') c
        cross join lateral (select case when c.n % 2 = 0 then 'buy' else 'rent' end as kind) k`.execute(fx.db);
    await sql`
      insert into contact_relationships (company_id, contact_id, relationship_type)
      select company_id, id, (array['buyer', 'tenant', 'seller'])[1 + substring(reference from 5)::int % 3] from contacts
       where company_id = ${c}::uuid and reference like 'C2C-%'`.execute(fx.db);

    // Identity documents (real encryption for the documents the test reads) and KYC checks.
    await sql`
      insert into identity_documents (company_id, contact_id, document_type_code, issuing_country_code, number_encrypted, number_hash, number_last4, expires_on)
      select company_id, id, 'ghana_card', 'GH', '\\x00'::bytea, sha256(convert_to('C2-' || reference, 'UTF8')), right(reference, 4), current_date + 1000
        from contacts where company_id = ${c}::uuid and reference like 'C2C-%'`.execute(fx.db);
    await sql`
      insert into kyc_checks (company_id, contact_id, check_type, status, risk_rating, reviewed_by, reviewed_at, recorded_by)
      select company_id, id, 'identity', s.status, case when s.status = 'verified' then 'low' end,
             case when s.status = 'verified' then ${owner}::uuid end, case when s.status = 'verified' then now() end, ${owner}::uuid
        from contacts cross join lateral (select (array['pending', 'in_review', 'verified'])[1 + abs(hashtext(reference)) % 3] as status) s
       where company_id = ${c}::uuid and reference like 'C2C-%'`.execute(fx.db);

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-c2-perf-analyze');
    try {
      await sql`vacuum (analyze) addresses, properties, units, unit_features, listings, contacts, requirements, identity_documents, kyc_checks`.execute(admin);
    } finally {
      await admin.destroy();
    }
    const { rows } = await sql<{ contactId: string; requirementId: string; reference: string }>`
      select c.id as "contactId", r.id as "requirementId", c.reference from contacts c join requirements r on r.contact_id = c.id
       where c.company_id = ${c}::uuid and c.reference in ('C2C-101', 'C2C-202', 'C2C-303', 'C2C-404', 'C2C-1000')`.execute(fx.db);
    for (const row of rows) {
      if (row.reference === 'C2C-1000') agentSample = row;
      else sample.push(row);
    }
  }, 900_000);

  // The data stays in this run's own company: the test database is rebuilt for every run.
  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers register, matching and KYC requests at p95 under ${TARGET_P95_MS} ms`, async () => {
    const counts = await sql<{ listings: number; published: number; requirements: number }>`
      select (select count(*)::int from listings where company_id = ${company.companyId}::uuid) as listings,
             (select count(*)::int from listings where company_id = ${company.companyId}::uuid and is_published) as published,
             (select count(*)::int from requirements where company_id = ${company.companyId}::uuid) as requirements`.execute(fx.db);
    expect(counts.rows[0]).toMatchObject({ listings: PROPERTIES * 20, requirements: CONTACTS });

    const samples: number[] = [];
    const byKind = new Map<string, number[]>();
    let slowest = { ms: 0, label: '' };
    const time = async (label: string, run: () => Promise<unknown>) => {
      const started = performance.now();
      await run();
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      byKind.set(label.split(' ')[0]!, [...(byKind.get(label.split(' ')[0]!) ?? []), elapsed]);
      if (elapsed > slowest.ms) slowest = { ms: elapsed, label };
    };
    const get = (token: string, path: string) => t.http.get(path).auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);

    // A real encrypted document on one sample contact, for the duplicate check on create.
    const tenantDb = t.app.get(TenantDb);
    const sensitive = t.app.get(SensitiveDataService);
    const sealedNumber = 'GHA-799000001-1';
    await tenantDb.run(systemContext(company.companyId, 'perf-seed'), async (tx) => {
      const id = randomUUID();
      const ctx = systemContext(company.companyId, 'perf-seed');
      const number = await sensitive.protectIdentifier(tx, ctx, { table: 'identity_documents', column: 'number_encrypted', rowId: id }, 'identity_number', sealedNumber);
      await tx
        .insertInto('identityDocuments')
        .values({ id, companyId: company.companyId, contactId: sample[0]!.contactId, documentTypeCode: 'passport', issuingCountryCode: 'GH', numberEncrypted: number.encrypted, numberHash: number.hash, numberLast4: number.last4 })
        .execute();
    });

    for (const [who, token, mine] of [
      ['owner', ownerToken, sample],
      ['agent', agentToken, [agentSample]],
    ] as const) {
      for (let run = 0; run < 3; run++) {
        await time(`register ${who}`, () => get(token, '/api/v1/requirements'));
        await time(`register-filtered ${who}`, () => get(token, '/api/v1/requirements?filter[requirementType]=buy&filter[budget][gte]=800000&filter[budget][lte]=1200000&filter[locality]=Osu'));
        await time(`register-sorted ${who}`, () => get(token, '/api/v1/requirements?sort=-createdAt&limit=100&filter[financingStatus]=cash'));
        await time(`sellers-view ${who}`, () => get(token, '/api/v1/contacts?filter[relationship]=seller&limit=100'));
        for (const row of mine) {
          await time(`matches ${who}`, () => get(token, `/api/v1/contacts/${row.contactId}/requirements/${row.requirementId}/matches`));
          await time(`requirement ${who}`, () => get(token, `/api/v1/contacts/${row.contactId}/requirements`));
          await time(`documents ${who}`, () => get(token, `/api/v1/contacts/${row.contactId}/identity-documents`));
          await time(`checks ${who}`, () => get(token, `/api/v1/contacts/${row.contactId}/kyc-checks`));
        }
      }
    }
    // Recording documents: encryption plus the keyed-hash duplicate lookup over 50,000 documents.
    for (let run = 0; run < 5; run++) {
      await time('document-create owner', () =>
        t.http
          .post(`/api/v1/contacts/${sample[1]!.contactId}/identity-documents`)
          .auth(ownerToken, { type: 'bearer' })
          .set('X-Company-Id', company.companyId)
          .send({ documentTypeCode: 'passport', issuingCountryCode: 'GH', documentNumber: `G${String(4400000 + run)}` })
          .expect(201),
      );
    }
    await time('document-duplicate owner', () =>
      t.http
        .post(`/api/v1/contacts/${sample[2]!.contactId}/identity-documents`)
        .auth(ownerToken, { type: 'bearer' })
        .set('X-Company-Id', company.companyId)
        .send({ documentTypeCode: 'ghana_card', issuingCountryCode: 'GH', documentNumber: sealedNumber })
        .expect(409),
    );

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} max ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(
      `requirements/KYC: ${counts.rows[0]!.published} published listings, ${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, ` +
        `p95 ${p95.toFixed(0)} ms, slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); ${kinds}`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);
});
