import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Viewings at scale (readiness report §10: API p95 under 1,000 ms with
 * 200,000 viewings in one company). 1,000 listed properties, 50 agents,
 * 20,000 contacts and 200,000 viewings over a year (past ones completed,
 * cancelled or awaiting an outcome; future ones scheduled or confirmed).
 * Requests go through the full API as owner (all), sales manager (office)
 * and agent (own): calendars, "needing feedback", a listing's and a
 * contact's viewings, one viewing, bookings, and the "No viewing in 21 days"
 * listing filter.
 */
const PROPERTIES = 1_000;
const AGENTS = 50;
const CONTACTS = 20_000;
const VIEWINGS = 200_000;
const TARGET_P95_MS = 1_000;

describe('viewings performance (200,000 viewings)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  const tokens: Record<string, string> = {};
  const agents: string[] = [];
  let listingIds: string[] = [];
  let contactIds: string[] = [];

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
      await fx.linkIdentity(userId, `s1-perf-${name}-${c}`);
      tokens[name] = await t.idp.token({ sub: `s1-perf-${name}-${c}`, amr: ['pwd', 'mfa'], authTime });
    }
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'villa').where('companyId', 'is', null).executeTakeFirstOrThrow();

    // Properties, one unit each, one available sale listing each (agents in turn).
    await sql`
      with addr as (
        insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted)
        select ${c}::uuid, 'GH', n || ' Viewing Road', 'Accra', 'Greater Accra', n || ' Viewing Road, Accra' from generate_series(1, ${PROPERTIES}) n
        returning id),
      numbered as (select id, row_number() over () as n from addr)
      insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
      select ${c}::uuid, 'S1P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Viewing house ' || n, ${company.ownerMembershipId}::uuid
        from numbered`.execute(fx.db);
    await sql`
      insert into units (company_id, property_id, reference, unit_label, bedrooms)
      select company_id, id, reference || '-U', 'Whole property', 3 from properties where company_id = ${c}::uuid and reference like 'S1P-%'`.execute(fx.db);
    await sql`
      insert into listings (company_id, reference, unit_id, listing_type, status, currency_code, price, agent_membership_id, office_id,
                            default_locale_code, title, listed_at)
      select u.company_id, 'S1L-' || u.reference, u.id, 'sale', 'available', 'GHS', 500000 + row_number() over (order by u.reference) * 100,
             (${agents}::uuid[])[1 + (row_number() over (order by u.reference) % ${AGENTS})], ${company.officeId}::uuid, 'en-GH',
             'Viewing house', now() - interval '400 days'
        from units u where u.company_id = ${c}::uuid and u.reference like 'S1P-%'`.execute(fx.db);
    listingIds = (await fx.db.selectFrom('listings').select('id').where('companyId', '=', c).where('reference', 'like', 'S1L-%').orderBy('reference').execute()).map((r) => r.id);
    await sql`
      insert into contacts (company_id, reference, contact_type, display_name, office_id, owner_membership_id)
      select ${c}::uuid, 'S1C-' || n, 'person', 'Viewer ' || n, ${company.officeId}::uuid, (${agents}::uuid[])[1 + (n % ${AGENTS})]
        from generate_series(1, ${CONTACTS}) n`.execute(fx.db);
    contactIds = (await fx.db.selectFrom('contacts').select('id').where('companyId', '=', c).where('reference', 'like', 'S1C-%').orderBy('reference').limit(100).execute()).map((r) => r.id);

    // 200,000 viewings: each agent's viewings two hours apart (no overlaps), from 200 days ago onwards.
    // Bulk seed with row triggers off (session_replication_role); the rules themselves are covered by SQL suite 13.
    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-s1-perf-seed');
    await admin.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await sql`
        with listing_ids as (select array_agg(id order by reference) as ids from listings where company_id = ${c}::uuid and reference like 'S1L-%'),
             contact_ids as (select array_agg(id order by reference) as ids from contacts where company_id = ${c}::uuid and reference like 'S1C-%'),
             series as (
               select n, (${agents}::uuid[])[1 + (n % ${AGENTS})] as agent,
                      date_trunc('hour', now()) - interval '200 days' + make_interval(hours => 2 * (n / ${AGENTS})) as start_at
                 from generate_series(0, ${VIEWINGS - 1}) n),
             inserted as (
               insert into viewings (company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone, status, outcome,
                                     feedback, cancelled_reason, created_by)
               select ${c}::uuid, l.id, l.unit_id, s.agent, s.start_at, s.start_at + interval '45 minutes', 'Africa/Accra',
                      case when s.start_at > now() then (case when s.n % 3 = 0 then 'confirmed' else 'scheduled' end)
                           when s.n % 50 = 0 then 'scheduled'
                           when s.n % 10 = 0 then 'cancelled'
                           else 'completed' end,
                      case when s.start_at <= now() and s.n % 50 <> 0 and s.n % 10 <> 0 then 'interested' end,
                      case when s.start_at <= now() and s.n % 50 <> 0 and s.n % 10 <> 0 then 'Feedback ' || s.n end,
                      case when s.start_at <= now() and s.n % 50 <> 0 and s.n % 10 = 0 then 'Buyer unavailable' end,
                      s.agent
                 from series s
                 cross join listing_ids li
                 join listings l on l.id = li.ids[1 + (s.n % ${PROPERTIES})]
               returning id, listing_id)
        insert into viewing_attendees (company_id, viewing_id, contact_id, attendance)
        select ${c}::uuid, i.id, ci.ids[1 + (abs(hashtext(i.id::text)) % ${CONTACTS})], 'expected'
          from inserted i cross join contact_ids ci`.execute(tx);
    });
    try {
      await sql`vacuum (analyze) properties, units, listings, contacts, viewings, viewing_attendees`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 600_000);

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers calendar, feedback, listing and contact requests at p95 under ${TARGET_P95_MS} ms`, async () => {
    const count = await fx.db.selectFrom('viewings').select(sql<number>`count(*)::int`.as('n')).where('companyId', '=', company.companyId).executeTakeFirstOrThrow();
    expect(count.n).toBe(VIEWINGS);

    const samples: number[] = [];
    const byKind = new Map<string, number[]>();
    let slowest = { ms: 0, label: '' };
    const time = async (label: string, run: () => Promise<unknown>) => {
      const started = performance.now();
      await run();
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      const kind = label.split(' ')[0]!;
      byKind.set(kind, [...(byKind.get(kind) ?? []), elapsed]);
      if (elapsed > slowest.ms) slowest = { ms: elapsed, label };
    };
    const get = (who: string, path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);
    const week = (offsetDays: number) => {
      const from = new Date(Date.now() + offsetDays * 86_400_000);
      return `filter[scheduledStart][gte]=${encodeURIComponent(from.toISOString())}&filter[scheduledStart][lte]=${encodeURIComponent(new Date(from.getTime() + 7 * 86_400_000).toISOString())}`;
    };

    const one = await get('owner', `/api/v1/viewings?limit=1&filter[listingId]=${listingIds[0]}`);
    const viewingId = (one.body.data[0] as { id: string }).id;
    for (let run = 0; run < 3; run += 1) {
      await time('calendar-own agent', () => get('agent', `/api/v1/viewings?limit=100&filter[agentMembershipId]=${agents[0]}&${week(run * 7)}`));
      await time('calendar-own-past agent', () => get('agent', `/api/v1/viewings?limit=100&filter[agentMembershipId]=${agents[0]}&${week(-30 - run * 7)}`));
      await time('agent-default agent', () => get('agent', '/api/v1/viewings?limit=50'));
      await time('needs-outcome agent', () => get('agent', '/api/v1/viewings?limit=50&filter[needsOutcome]=true'));
      await time('calendar-team manager', () => get('manager', `/api/v1/viewings?limit=100&${week(run * 7)}`));
      await time('calendar-team owner', () => get('owner', `/api/v1/viewings?limit=100&${week(run * 7)}`));
      await time('calendar-agents owner', () => get('owner', `/api/v1/viewings?limit=100&filter[agentMembershipId]=${agents.slice(0, 5).join(',')}&${week(run * 7)}`));
      await time('needs-outcome owner', () => get('owner', '/api/v1/viewings?limit=50&filter[needsOutcome]=true'));
      await time('listing owner', () => get('owner', `/api/v1/viewings?limit=50&sort=-scheduledStart&filter[listingId]=${listingIds[run * 10]}`));
      await time('contact owner', () => get('owner', `/api/v1/viewings?limit=50&filter[contactId]=${contactIds[run]}`));
      await time('viewing owner', () => get('owner', `/api/v1/viewings/${viewingId}`));
      await time('no-viewing-flag owner', () => get('owner', '/api/v1/listings?limit=50&filter[attention]=no-viewing'));
    }
    // Bookings: scope, attendee and conflict checks, effects, timeline, audit and outbox in one transaction.
    for (let run = 0; run < 5; run += 1) {
      const start = new Date(Date.now() + (400 + run) * 86_400_000);
      await time('book owner', () =>
        t.http
          .post('/api/v1/viewings')
          .auth(tokens['owner']!, { type: 'bearer' })
          .set('X-Company-Id', company.companyId)
          .send({
            listingId: listingIds[run]!,
            agentMembershipId: agents[run + 1],
            scheduledStart: start.toISOString(),
            scheduledEnd: new Date(start.getTime() + 30 * 60_000).toISOString(),
            attendeeContactIds: [contactIds[run]!],
          })
          .expect(201),
      );
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(
      `viewings: ${count.n} viewings, ${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, ` +
        `slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); max by kind: ${kinds}`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);
});
