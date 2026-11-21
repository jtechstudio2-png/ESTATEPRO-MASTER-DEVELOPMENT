import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Offers at scale (readiness report §10: API p95 under 1,000 ms with 20,000
 * open deals and 100,000 offers in one company). 4,000 listed properties,
 * 50 agents, 20,000 contacts, 20,000 open sale deals at negotiation and
 * 100,000 offers (five per deal, mostly answered). Requests go through the
 * full API as owner (all), sales manager (office) and agent (own deals):
 * newest offers, a deal's negotiation, a listing's and a contact's offers,
 * one offer, and the writes (record, accept, withdraw an accepted offer).
 */
const PROPERTIES = 4_000;
const AGENTS = 50;
const CONTACTS = 20_000;
const DEALS = 20_000;
const OFFERS_PER_DEAL = 5;
const TARGET_P95_MS = 1_000;

describe('offers performance (100,000 offers, 20,000 open deals)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  const tokens: Record<string, string> = {};
  const agents: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    const c = company.companyId;
    for (let i = 0; i < AGENTS; i += 1) agents.push((await fx.member(c, { roleKey: 'agent', officeIds: [company.officeId] })).membershipId);
    const agentUser = (await fx.db.selectFrom('companyMemberships').select('userId').where('id', '=', agents[0]!).executeTakeFirstOrThrow()).userId;
    const manager = await fx.member(c, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    const authTime = Math.floor(Date.now() / 1000);
    for (const [name, userId] of [['owner', company.ownerUserId], ['agent', agentUser], ['manager', manager.userId]] as const) {
      await fx.linkIdentity(userId, `s2-perf-${name}-${c}`);
      tokens[name] = await t.idp.token({ sub: `s2-perf-${name}-${c}`, amr: ['pwd', 'mfa'], authTime });
    }
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'villa').where('companyId', 'is', null).executeTakeFirstOrThrow();
    const negotiation = (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', 'sale').where('code', '=', 'negotiation').executeTakeFirstOrThrow()).id;

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-s2-perf-seed');
    try {
      // Bulk seed with row triggers off (session_replication_role); the offer rules are covered by SQL suites 12 and 14.
      await admin.transaction().execute(async (tx) => {
        await sql`set local session_replication_role = replica`.execute(tx);
        await sql`
          with addr as (
            insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted)
            select ${c}::uuid, 'GH', n || ' Offer Road', 'Accra', 'Greater Accra', n || ' Offer Road, Accra' from generate_series(1, ${PROPERTIES}) n
            returning id),
          numbered as (select id, row_number() over () as n from addr)
          insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
          select ${c}::uuid, 'S2P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Offer house ' || n, ${company.ownerMembershipId}::uuid
            from numbered`.execute(tx);
        await sql`
          insert into units (company_id, property_id, reference, unit_label, bedrooms)
          select company_id, id, reference || '-U', 'Whole property', 4 from properties where company_id = ${c}::uuid and reference like 'S2P-%'`.execute(tx);
        await sql`
          insert into listings (company_id, reference, unit_id, listing_type, status, currency_code, price, agent_membership_id, office_id, default_locale_code, title, listed_at)
          select u.company_id, 'S2L-' || u.reference, u.id, 'sale', 'available', 'GHS', 600000, (${agents}::uuid[])[1 + (row_number() over (order by u.reference) % ${AGENTS})],
                 ${company.officeId}::uuid, 'en-GH', 'Offer house', now() - interval '90 days'
            from units u where u.company_id = ${c}::uuid and u.reference like 'S2P-%'`.execute(tx);
        await sql`
          insert into contacts (company_id, reference, contact_type, display_name, office_id, owner_membership_id)
          select ${c}::uuid, 'S2C-' || n, 'person', 'Buyer ' || n, ${company.officeId}::uuid, (${agents}::uuid[])[1 + (n % ${AGENTS})]
            from generate_series(1, ${CONTACTS}) n`.execute(tx);
        await sql`
          with l as (select array_agg(id order by reference) as ids, array_agg(unit_id order by reference) as units from listings where company_id = ${c}::uuid and reference like 'S2L-%'),
               ct as (select array_agg(id order by reference) as ids from contacts where company_id = ${c}::uuid and reference like 'S2C-%')
          insert into deals (company_id, reference, deal_type, stage_id, stage_class, primary_contact_id, office_id, owner_membership_id, currency_code, listing_id, unit_id)
          select ${c}::uuid, 'S2D-' || n, 'sale', ${negotiation}::uuid, 'negotiation', ct.ids[1 + (n % ${CONTACTS})], ${company.officeId}::uuid,
                 (${agents}::uuid[])[1 + (n % ${AGENTS})], 'GHS', l.ids[1 + (n % ${PROPERTIES})], l.units[1 + (n % ${PROPERTIES})]
            from generate_series(0, ${DEALS - 1}) n cross join l cross join ct`.execute(tx);
        await sql`
          insert into offers (company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, status, submitted_at, responded_at, recorded_by)
          select d.company_id, d.id, d.listing_id, d.primary_contact_id, 'from_buyer', 'GHS', 500000 + k * 5000,
                 case when k < ${OFFERS_PER_DEAL} then (array['rejected', 'withdrawn', 'expired', 'countered'])[1 + (k % 4)] else 'submitted' end,
                 now() - make_interval(days => (abs(hashtext(d.id::text)) % 300) + 1, hours => ${OFFERS_PER_DEAL} - k),
                 case when k < ${OFFERS_PER_DEAL} then now() - make_interval(days => (abs(hashtext(d.id::text)) % 300)) end,
                 d.owner_membership_id
            from deals d cross join generate_series(1, ${OFFERS_PER_DEAL}) k
           where d.company_id = ${c}::uuid and d.reference like 'S2D-%'`.execute(tx);
      });
      await sql`vacuum (analyze) properties, units, listings, contacts, deals, deal_agents, offers`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 600_000);

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers offer requests at p95 under ${TARGET_P95_MS} ms`, async () => {
    const counts = await sql<{ offers: number; deals: number }>`
      select (select count(*)::int from offers where company_id = ${company.companyId}::uuid) as offers,
             (select count(*)::int from deals where company_id = ${company.companyId}::uuid and status = 'open') as deals`.execute(fx.db);
    expect(counts.rows[0]).toEqual({ offers: DEALS * OFFERS_PER_DEAL, deals: DEALS });

    const samples: number[] = [];
    const byKind = new Map<string, number[]>();
    let slowest = { ms: 0, label: '' };
    const time = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const result = await run();
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      const kind = label.split(' ')[0]!;
      byKind.set(kind, [...(byKind.get(kind) ?? []), elapsed]);
      if (elapsed > slowest.ms) slowest = { ms: elapsed, label };
      return result;
    };
    const http = (who: string) => ({
      get: (path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200),
      post: (path: string, body: object, status: number, version?: number) => {
        const req = t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId);
        return (version === undefined ? req : req.set('If-Match', `"${version}"`)).send(body).expect(status);
      },
    });
    const sample = await sql<{ dealId: string; listingId: string; contactId: string; offerId: string }>`
      select d.id as "dealId", d.listing_id as "listingId", d.primary_contact_id as "contactId",
             (select o.id from offers o where o.deal_id = d.id and o.status = 'submitted' limit 1) as "offerId"
        from deals d where d.company_id = ${company.companyId}::uuid and d.owner_membership_id = ${agents[0]}::uuid order by d.reference limit 10`.execute(fx.db);
    const rows = sample.rows;

    for (let run = 0; run < 3; run += 1) {
      const row = rows[run]!;
      await time('newest owner', () => http('owner').get('/api/v1/offers?limit=50'));
      await time('open owner', () => http('owner').get('/api/v1/offers?limit=50&filter[status]=submitted'));
      await time('newest manager', () => http('manager').get('/api/v1/offers?limit=50'));
      await time('newest agent', () => http('agent').get('/api/v1/offers?limit=50'));
      await time('open agent', () => http('agent').get('/api/v1/offers?limit=50&filter[status]=submitted'));
      await time('deal agent', () => http('agent').get(`/api/v1/offers?filter[dealId]=${row.dealId}&sort=submittedAt`));
      await time('listing owner', () => http('owner').get(`/api/v1/offers?limit=50&filter[listingId]=${row.listingId}`));
      await time('contact owner', () => http('owner').get(`/api/v1/offers?limit=50&filter[contactId]=${row.contactId}`));
      await time('offer agent', () => http('agent').get(`/api/v1/offers/${row.offerId}`));
    }
    // Writes: the agent records offers; the owner accepts offers and withdraws the acceptance (deal stage and listing status change each time).
    for (let run = 3; run < 6; run += 1) {
      const row = rows[run]!;
      await time('record agent', () => http('agent').post('/api/v1/offers', { dealId: row.dealId, offeredByContactId: row.contactId, amount: { amount: '555000.00', currency: 'GHS' } }, 201));
    }
    for (let run = 6; run < 8; run += 1) {
      const row = rows[run]!;
      const offer = await http('owner').get(`/api/v1/offers/${row.offerId}`);
      const accepted = await time('accept owner', () => http('owner').post(`/api/v1/offers/${row.offerId}/accept`, {}, 200, offer.body.version as number));
      await time('withdraw-accepted owner', () => http('owner').post(`/api/v1/offers/${row.offerId}/withdraw`, { reason: 'Finance fell through' }, 200, accepted.body.version as number));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(
      `offers: ${counts.rows[0]!.offers} offers on ${counts.rows[0]!.deals} open deals, ${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, ` +
        `p95 ${p95.toFixed(0)} ms, slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); max by kind: ${kinds}`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);
});
