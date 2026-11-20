import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Phase 6 dashboards at the readiness budget's volumes (S6; S1-R3): one
 * company with 20,000 live listings, 20,000 open deals, 100,000 offers and
 * 200,000 viewings. The property dashboard ("No viewing in 21 days"), the CRM
 * dashboard's sales work, My day's viewings and offers, and the deals list's
 * "listing closed" filter must answer at p95 under 1,000 ms.
 */
const LISTINGS = 20_000;
const CONTACTS = 20_000;
const OFFERS_PER_DEAL = 5;
const VIEWINGS_PER_LISTING = 10;
const AGENTS = 20;
const TARGET_P95_MS = 1_000;

describe('Phase 6 dashboards performance (S6)', () => {
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
    let agentUser = '';
    for (let index = 0; index < AGENTS; index += 1) {
      const member = await fx.member(c, { roleKey: 'agent', officeIds: [company.officeId] });
      agents.push(member.membershipId);
      if (index === 0) agentUser = member.userId;
    }
    const manager = await fx.member(c, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    const authTime = Math.floor(Date.now() / 1000);
    for (const [name, userId] of [['owner', company.ownerUserId], ['agent', agentUser], ['manager', manager.userId]] as const) {
      await fx.linkIdentity(userId, `s6-perf-${name}-${c}`);
      tokens[name] = await t.idp.token({ sub: `s6-perf-${name}-${c}`, amr: ['pwd', 'mfa'], authTime });
    }
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'villa').where('companyId', 'is', null).executeTakeFirstOrThrow();
    const stages = await fx.db.selectFrom('pipelineStages').select(['id', 'stageClass']).where('companyId', 'is', null).where('dealType', '=', 'sale').execute();
    const open = ['lead', 'qualification', 'viewing', 'negotiation'].map((cls) => stages.find((s) => s.stageClass === cls)!.id);

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-s6-perf-seed');
    try {
      // Bulk seed with row triggers off (session_replication_role); the rules are covered by SQL suites 12 to 16.
      await admin.transaction().execute(async (tx) => {
        await sql`set local session_replication_role = replica`.execute(tx);
        await sql`
          with addr as (
            insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted)
            select ${c}::uuid, 'GH', n || ' Sales Road', 'Accra', 'Greater Accra', n || ' Sales Road, Accra' from generate_series(1, ${LISTINGS}) n
            returning id),
          numbered as (select id, row_number() over () as n from addr)
          insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
          select ${c}::uuid, 'S6P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Sales house ' || n, ${company.ownerMembershipId}::uuid
            from numbered`.execute(tx);
        await sql`
          insert into units (company_id, property_id, reference, unit_label, bedrooms)
          select company_id, id, reference || '-U', 'Whole property', 4 from properties where company_id = ${c}::uuid and reference like 'S6P-%'`.execute(tx);
        // One listing in 50 is already sold, so some open deals sit on a closed listing (S3-R3).
        await sql`
          insert into listings (company_id, reference, unit_id, listing_type, status, currency_code, price, agent_membership_id, office_id, default_locale_code, title, listed_at)
          select u.company_id, 'S6L-' || u.reference, u.id, 'sale',
                 case when row_number() over (order by u.reference) % 50 = 0 then 'sold' else 'available' end,
                 'GHS', 600000, (${agents}::uuid[])[1 + (row_number() over (order by u.reference) % ${AGENTS})],
                 ${company.officeId}::uuid, 'en-GH', 'Sales house', now() - interval '120 days'
            from units u where u.company_id = ${c}::uuid and u.reference like 'S6P-%'`.execute(tx);
        await sql`
          insert into contacts (company_id, reference, contact_type, display_name, office_id, owner_membership_id)
          select ${c}::uuid, 'S6C-' || n, 'person', 'Buyer ' || n, ${company.officeId}::uuid, (${agents}::uuid[])[1 + (n % ${AGENTS})]
            from generate_series(1, ${CONTACTS}) n`.execute(tx);
        await sql`
          with ct as (select array_agg(id order by reference) as ids from contacts where company_id = ${c}::uuid and reference like 'S6C-%')
          insert into deals (company_id, reference, deal_type, stage_id, stage_class, primary_contact_id, office_id, owner_membership_id, currency_code,
                             listing_id, unit_id, expected_value, expected_close_date, stage_entered_at, created_at, updated_at)
          select l.company_id, 'S6D-' || l.reference, 'sale', (${open}::uuid[])[1 + (n % 4)],
                 (array['lead', 'qualification', 'viewing', 'negotiation'])[1 + (n % 4)],
                 ct.ids[1 + (n % ${CONTACTS})], ${company.officeId}::uuid, l.agent_membership_id, 'GHS', l.id, l.unit_id,
                 400000 + (n % 50) * 10000, current_date + (n % 300), now() - make_interval(days => n % 40),
                 now() - interval '100 days', now() - make_interval(mins => n)
            from (select *, (row_number() over (order by reference))::int as n from listings where company_id = ${c}::uuid and reference like 'S6L-%') l
            cross join ct`.execute(tx);
        await sql`
          insert into deal_parties (company_id, deal_id, contact_id, party_role, is_primary)
          select company_id, id, primary_contact_id, 'buyer', true from deals where company_id = ${c}::uuid`.execute(tx);
        await sql`
          insert into offers (company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, status, submitted_at, responded_at, recorded_by)
          select d.company_id, d.id, d.listing_id, d.primary_contact_id, 'from_buyer', 'GHS', 500000 + k * 5000,
                 case when k < ${OFFERS_PER_DEAL} then (array['rejected', 'withdrawn', 'expired', 'countered'])[1 + (k % 4)] else 'submitted' end,
                 now() - make_interval(days => 60 - k), case when k < ${OFFERS_PER_DEAL} then now() - make_interval(days => 59 - k) end,
                 d.owner_membership_id
            from deals d cross join generate_series(1, ${OFFERS_PER_DEAL}) k
           where d.company_id = ${c}::uuid`.execute(tx);
        // Ten viewings per listing, conducted by the listing's agent, one hour apart per agent (agents cannot be double-booked),
        // spread over the past 410 days and the coming days.
        await sql`
          with inserted as (
            insert into viewings (company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone, status, outcome, cancelled_reason, created_by)
            select l.company_id, l.id, l.unit_id, l.agent_membership_id, s.start_at, s.start_at + interval '45 minutes', 'Africa/Accra',
                   case when s.start_at > now() then 'scheduled' when (l.n + k) % 40 = 0 then 'scheduled' when (l.n + k) % 10 = 0 then 'cancelled' else 'completed' end,
                   case when s.start_at <= now() and (l.n + k) % 40 <> 0 and (l.n + k) % 10 <> 0 then 'interested' end,
                   case when s.start_at <= now() and (l.n + k) % 40 <> 0 and (l.n + k) % 10 = 0 then 'Buyer unavailable' end,
                   l.agent_membership_id
              from (select *, (row_number() over (order by reference))::int as n from listings where company_id = ${c}::uuid and reference like 'S6L-%') l
              cross join generate_series(1, ${VIEWINGS_PER_LISTING}) k
              cross join lateral (select date_trunc('hour', now()) - interval '410 days' + make_interval(hours => (l.n / ${AGENTS}) * ${VIEWINGS_PER_LISTING} + k) as start_at) s
            returning id, listing_id)
          insert into viewing_attendees (company_id, viewing_id, contact_id, attendance)
          select ${c}::uuid, i.id, d.primary_contact_id, 'expected' from inserted i join deals d on d.listing_id = i.listing_id`.execute(tx);
      });
      await sql`vacuum (analyze) properties, units, listings, contacts, deals, deal_parties, offers, viewings, viewing_attendees`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 900_000);

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers the Phase 6 dashboards at p95 under ${TARGET_P95_MS} ms`, async () => {
    const c = company.companyId;
    const { rows: [counts] } = await sql<{ listings: number; deals: number; offers: number; viewings: number }>`
      select (select count(*)::int from listings where company_id = ${c}::uuid) as listings,
             (select count(*)::int from deals where company_id = ${c}::uuid and status = 'open') as deals,
             (select count(*)::int from offers where company_id = ${c}::uuid) as offers,
             (select count(*)::int from viewings where company_id = ${c}::uuid) as viewings`.execute(fx.db);
    expect(counts).toEqual({ listings: LISTINGS, deals: LISTINGS, offers: LISTINGS * OFFERS_PER_DEAL, viewings: LISTINGS * VIEWINGS_PER_LISTING });

    const samples: number[] = [];
    const byKind = new Map<string, number[]>();
    let slowest = { ms: 0, label: '' };
    const get = async (who: string, label: string, path: string) => {
      const started = performance.now();
      const res = await t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', c).expect(200);
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      const kind = label.split(' ')[0]!;
      byKind.set(kind, [...(byKind.get(kind) ?? []), elapsed]);
      if (elapsed > slowest.ms) slowest = { ms: elapsed, label };
      return res.body as Record<string, unknown>;
    };

    let crm: Record<string, unknown> = {};
    for (let run = 0; run < 3; run += 1) {
      await get('owner', 'property-dashboard owner', '/api/v1/dashboards/property/listings');
      await get('manager', 'property-dashboard manager', '/api/v1/dashboards/property/listings');
      crm = await get('owner', 'crm owner', '/api/v1/dashboards/crm');
      await get('manager', 'crm manager', '/api/v1/dashboards/crm');
      await get('agent', 'crm agent', '/api/v1/dashboards/crm');
      await get('agent', 'my-day agent', '/api/v1/dashboards/my-day');
      await get('owner', 'closed-listing owner', '/api/v1/deals?limit=50&filter[attention]=listing_closed');
      await get('agent', 'closed-listing agent', '/api/v1/deals?limit=50&filter[attention]=listing_closed');
    }
    // The counts are real: one listing in 50 sold, one past viewing in 40 still without an outcome.
    const sales = crm['sales'] as { viewingsNeedingOutcome: number; openDealsOnClosedListings: number };
    expect(sales.openDealsOnClosedListings).toBe(LISTINGS / 50);
    expect(sales.viewingsNeedingOutcome).toBeGreaterThan(0);

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(
      `phase 6 dashboards: ${counts!.listings} listings, ${counts!.deals} open deals, ${counts!.offers} offers, ${counts!.viewings} viewings; ` +
        `${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, ` +
        `slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); max by kind: ${kinds}`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 900_000);
});
