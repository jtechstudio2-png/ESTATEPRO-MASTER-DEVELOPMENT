import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Landlord visibility at scale (readiness report §10: API p95 under 1,000 ms
 * with 20,000 open deals, 200,000 viewings and 100,000 offers in one
 * company; S4 seeds 100,000 viewings, the views read them per listing).
 * 4,000 properties each with an owner; one landlord owns 40 of them. 20,000
 * open deals, 100,000 offers and 100,000 viewings spread over all listings.
 * Requests: the landlord's listings (with counts) and one listing's view
 * through the portal, and the staff preview.
 */
const PROPERTIES = 4_000;
const LANDLORD_PROPERTIES = 40;
const DEALS = 20_000;
const OFFERS_PER_DEAL = 5;
const VIEWINGS = 100_000;
const TARGET_P95_MS = 1_000;

describe('landlord visibility performance (40 of 4,000 properties)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  const tokens: Record<string, string> = {};
  let landlordContact: string;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    const c = company.companyId;
    const agent = await fx.member(c, { roleKey: 'agent', officeIds: [company.officeId] });
    const landlord = await fx.member(c, { roleKey: 'landlord', membershipType: 'portal' });
    landlordContact = (await fx.db.selectFrom('companyMemberships').select('contactId').where('id', '=', landlord.membershipId).executeTakeFirstOrThrow()).contactId!;
    const authTime = Math.floor(Date.now() / 1000);
    for (const [name, userId] of [['owner', company.ownerUserId], ['landlord', landlord.userId]] as const) {
      await fx.linkIdentity(userId, `s4-perf-${name}-${c}`);
      tokens[name] = await t.idp.token({ sub: `s4-perf-${name}-${c}`, amr: ['pwd', 'mfa'], authTime });
    }
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'villa').where('companyId', 'is', null).executeTakeFirstOrThrow();
    const negotiation = (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', 'sale').where('code', '=', 'negotiation').executeTakeFirstOrThrow()).id;

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-s4-perf-seed');
    try {
      // Bulk seed with row triggers off (session_replication_role); the rules are covered by SQL suites 12 to 16.
      await admin.transaction().execute(async (tx) => {
        await sql`set local session_replication_role = replica`.execute(tx);
        await sql`
          with addr as (
            insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted)
            select ${c}::uuid, 'GH', n || ' Owner Road', 'Accra', 'Greater Accra', n || ' Owner Road, Accra' from generate_series(1, ${PROPERTIES}) n
            returning id),
          numbered as (select id, row_number() over () as n from addr)
          insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
          select ${c}::uuid, 'S4P-' || lpad(n::text, 5, '0'), ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Owner house ' || n, ${company.ownerMembershipId}::uuid
            from numbered`.execute(tx);
        await sql`
          insert into units (company_id, property_id, reference, unit_label, bedrooms)
          select company_id, id, reference || '-U', 'Whole property', 4 from properties where company_id = ${c}::uuid and reference like 'S4P-%'`.execute(tx);
        await sql`
          insert into listings (company_id, reference, unit_id, listing_type, status, currency_code, price, agent_membership_id, office_id, default_locale_code, title, listed_at)
          select u.company_id, 'S4L-' || u.reference, u.id, 'sale', 'available', 'GHS', 600000, ${agent.membershipId}::uuid, ${company.officeId}::uuid, 'en-GH', 'Owner house', now() - interval '90 days'
            from units u where u.company_id = ${c}::uuid and u.reference like 'S4P-%'`.execute(tx);
        await sql`
          insert into contacts (company_id, reference, contact_type, display_name, office_id)
          select ${c}::uuid, 'S4C-' || lpad(n::text, 5, '0'), 'person', 'Person ' || n, ${company.officeId}::uuid from generate_series(1, ${PROPERTIES}) n`.execute(tx);
        // Each property has one owner; the landlord owns the first 40.
        await sql`
          with p as (select id, row_number() over (order by reference) as n from properties where company_id = ${c}::uuid and reference like 'S4P-%'),
               ct as (select id, row_number() over (order by reference) as n from contacts where company_id = ${c}::uuid and reference like 'S4C-%')
          insert into property_ownerships (company_id, property_id, owner_contact_id, effective_from)
          select ${c}::uuid, p.id, case when p.n <= ${LANDLORD_PROPERTIES} then ${landlordContact}::uuid else ct.id end, '2020-01-01'
            from p join ct on ct.n = p.n`.execute(tx);
        await sql`
          with l as (select array_agg(id order by reference) as ids, array_agg(unit_id order by reference) as units from listings where company_id = ${c}::uuid and reference like 'S4L-%'),
               ct as (select array_agg(id order by reference) as ids from contacts where company_id = ${c}::uuid and reference like 'S4C-%')
          insert into deals (company_id, reference, deal_type, stage_id, stage_class, primary_contact_id, office_id, owner_membership_id, currency_code, listing_id, unit_id)
          select ${c}::uuid, 'S4D-' || n, 'sale', ${negotiation}::uuid, 'negotiation', ct.ids[1 + (n % ${PROPERTIES})], ${company.officeId}::uuid, ${agent.membershipId}::uuid, 'GHS',
                 l.ids[1 + (n % ${PROPERTIES})], l.units[1 + (n % ${PROPERTIES})]
            from generate_series(0, ${DEALS - 1}) n cross join l cross join ct`.execute(tx);
        await sql`
          insert into offers (company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, status, submitted_at, responded_at, recorded_by)
          select d.company_id, d.id, d.listing_id, d.primary_contact_id, 'from_buyer', 'GHS', 500000 + k * 5000,
                 case when k < ${OFFERS_PER_DEAL} then 'rejected' else 'submitted' end,
                 now() - make_interval(days => (abs(hashtext(d.id::text)) % 300) + 1, hours => ${OFFERS_PER_DEAL} - k),
                 case when k < ${OFFERS_PER_DEAL} then now() - make_interval(days => (abs(hashtext(d.id::text)) % 300)) end, d.owner_membership_id
            from deals d cross join generate_series(1, ${OFFERS_PER_DEAL}) k where d.company_id = ${c}::uuid and d.reference like 'S4D-%'`.execute(tx);
        await sql`
          with l as (select array_agg(id order by reference) as ids, array_agg(unit_id order by reference) as units from listings where company_id = ${c}::uuid and reference like 'S4L-%')
          insert into viewings (company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone, status, outcome, feedback, seller_feedback_shared)
          select ${c}::uuid, l.ids[1 + (n % ${PROPERTIES})], l.units[1 + (n % ${PROPERTIES})], ${agent.membershipId}::uuid,
                 now() - make_interval(hours => n), now() - make_interval(hours => n) + interval '30 minutes', 'Africa/Accra',
                 'completed', 'interested', 'Liked it', n % 2 = 0
            from generate_series(1, ${VIEWINGS}) n cross join l`.execute(tx);
      });
      await sql`vacuum (analyze) properties, units, listings, contacts, property_ownerships, deals, offers, viewings`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 600_000);

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers the landlord views at p95 under ${TARGET_P95_MS} ms`, async () => {
    const samples: number[] = [];
    const byKind = new Map<string, number[]>();
    const time = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const result = await run();
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      byKind.set(label, [...(byKind.get(label) ?? []), elapsed]);
      return result;
    };
    const get = (who: string, path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);

    const list = await time('listings', () => get('landlord', '/api/v1/portal/landlord/listings'));
    expect(list.body.data).toHaveLength(LANDLORD_PROPERTIES);
    const ids = (list.body.data as Array<{ id: string }>).map((l) => l.id);
    for (let run = 0; run < 5; run += 1) {
      await time('listings', () => get('landlord', '/api/v1/portal/landlord/listings'));
      const view = await time('listing', () => get('landlord', `/api/v1/portal/landlord/listings/${ids[run]}`));
      expect(view.body.offers.length).toBeGreaterThan(0);
      await time('preview', () => get('owner', `/api/v1/contacts/${landlordContact}/portal-visibility-preview/listings/${ids[run]}`));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(`landlord views: ${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms; max by kind: ${kinds}`);
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);
});
