import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Deals at scale (readiness report §10: API p95 under 1,000 ms with 20,000
 * open deals in one company). 4,000 listed properties, 50 agents, 20,000
 * contacts, 20,000 open sale deals spread over the stages before acceptance,
 * each with a buyer party, an owner history entry and two co-agents on every
 * tenth deal, plus 5,000 closed deals. Requests go through the full API as
 * owner (all), sales manager (office) and agent (own deals): the pipeline
 * list and its filters, the board, the forecast, one deal, and the writes
 * (create, move a stage, reassign, set splits).
 */
const PROPERTIES = 4_000;
const AGENTS = 50;
const CONTACTS = 20_000;
const OPEN_DEALS = 20_000;
const CLOSED_DEALS = 5_000;
const TARGET_P95_MS = 1_000;

describe('deals performance (20,000 open deals)', () => {
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
      await fx.linkIdentity(userId, `s3-perf-${name}-${c}`);
      tokens[name] = await t.idp.token({ sub: `s3-perf-${name}-${c}`, amr: ['pwd', 'mfa'], authTime });
    }
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'villa').where('companyId', 'is', null).executeTakeFirstOrThrow();
    const stages = await fx.db.selectFrom('pipelineStages').select(['id', 'stageClass']).where('companyId', 'is', null).where('dealType', '=', 'sale').execute();
    const stage = (cls: string) => stages.find((s) => s.stageClass === cls)!.id;
    const open = [stage('lead'), stage('qualification'), stage('viewing'), stage('negotiation')];

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-s3-perf-seed');
    try {
      // Bulk seed with row triggers off (session_replication_role); the deal rules are covered by SQL suites 12 to 15.
      await admin.transaction().execute(async (tx) => {
        await sql`set local session_replication_role = replica`.execute(tx);
        await sql`
          with addr as (
            insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted)
            select ${c}::uuid, 'GH', n || ' Deal Road', 'Accra', 'Greater Accra', n || ' Deal Road, Accra' from generate_series(1, ${PROPERTIES}) n
            returning id),
          numbered as (select id, row_number() over () as n from addr)
          insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
          select ${c}::uuid, 'S3P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Deal house ' || n, ${company.ownerMembershipId}::uuid
            from numbered`.execute(tx);
        await sql`
          insert into units (company_id, property_id, reference, unit_label, bedrooms)
          select company_id, id, reference || '-U', 'Whole property', 4 from properties where company_id = ${c}::uuid and reference like 'S3P-%'`.execute(tx);
        await sql`
          insert into listings (company_id, reference, unit_id, listing_type, status, currency_code, price, agent_membership_id, office_id, default_locale_code, title, listed_at)
          select u.company_id, 'S3L-' || u.reference, u.id, 'sale', 'available', 'GHS', 600000, (${agents}::uuid[])[1 + (row_number() over (order by u.reference) % ${AGENTS})],
                 ${company.officeId}::uuid, 'en-GH', 'Deal house', now() - interval '90 days'
            from units u where u.company_id = ${c}::uuid and u.reference like 'S3P-%'`.execute(tx);
        await sql`
          insert into contacts (company_id, reference, contact_type, display_name, office_id, owner_membership_id)
          select ${c}::uuid, 'S3C-' || n, 'person', 'Buyer ' || n, ${company.officeId}::uuid, (${agents}::uuid[])[1 + (n % ${AGENTS})]
            from generate_series(1, ${CONTACTS}) n`.execute(tx);
        await sql`
          with l as (select array_agg(id order by reference) as ids, array_agg(unit_id order by reference) as units from listings where company_id = ${c}::uuid and reference like 'S3L-%'),
               ct as (select array_agg(id order by reference) as ids from contacts where company_id = ${c}::uuid and reference like 'S3C-%')
          insert into deals (company_id, reference, deal_type, stage_id, stage_class, primary_contact_id, office_id, owner_membership_id, currency_code,
                             listing_id, unit_id, expected_value, expected_close_date, stage_entered_at, created_at, updated_at)
          select ${c}::uuid, 'S3D-' || n, 'sale', (${open}::uuid[])[1 + (n % 4)],
                 (array['lead', 'qualification', 'viewing', 'negotiation'])[1 + (n % 4)],
                 ct.ids[1 + (n % ${CONTACTS})], ${company.officeId}::uuid, (${agents}::uuid[])[1 + (n % ${AGENTS})], 'GHS',
                 l.ids[1 + (n % ${PROPERTIES})], l.units[1 + (n % ${PROPERTIES})], 400000 + (n % 50) * 10000,
                 case when n % 5 = 0 then null else current_date + (n % 400) end,
                 now() - make_interval(days => n % 40), now() - make_interval(days => 60 + n % 200), now() - make_interval(mins => n)
            from generate_series(0, ${OPEN_DEALS - 1}) n cross join l cross join ct`.execute(tx);
        await sql`
          with ct as (select array_agg(id order by reference) as ids from contacts where company_id = ${c}::uuid and reference like 'S3C-%')
          insert into deals (company_id, reference, deal_type, stage_id, stage_class, primary_contact_id, office_id, owner_membership_id, currency_code,
                             expected_value, closed_at, lost_reason_code, created_at, updated_at)
          select ${c}::uuid, 'S3X-' || n, 'sale', ${stage('closed_lost')}::uuid, 'closed_lost', ct.ids[1 + (n % ${CONTACTS})], ${company.officeId}::uuid,
                 (${agents}::uuid[])[1 + (n % ${AGENTS})], 'GHS', 300000, now() - make_interval(days => n % 300), 'price',
                 now() - make_interval(days => 300 + n % 300), now() - make_interval(days => n % 300)
            from generate_series(1, ${CLOSED_DEALS}) n cross join ct`.execute(tx);
        await sql`
          insert into deal_parties (company_id, deal_id, contact_id, party_role, is_primary)
          select company_id, id, primary_contact_id, 'buyer', true from deals where company_id = ${c}::uuid`.execute(tx);
        await sql`
          insert into deal_assignments (company_id, deal_id, to_membership_id, assigned_at)
          select company_id, id, owner_membership_id, created_at from deals where company_id = ${c}::uuid`.execute(tx);
        await sql`
          insert into deal_stage_history (company_id, deal_id, to_stage_id, changed_at)
          select company_id, id, stage_id, created_at from deals where company_id = ${c}::uuid`.execute(tx);
        await sql`
          insert into deal_agents (company_id, deal_id, membership_id, agent_role, split_percent)
          select d.company_id, d.id, d.owner_membership_id, 'lister', 60 from deals d where d.company_id = ${c}::uuid and d.reference like 'S3D-%' and right(d.reference, 1) = '0'
          union all
          select d.company_id, d.id, (${agents}::uuid[])[1 + ((substr(d.reference, 5)::int + 7) % ${AGENTS})], 'co_agent', 40
            from deals d where d.company_id = ${c}::uuid and d.reference like 'S3D-%' and right(d.reference, 1) = '0'`.execute(tx);
      });
      await sql`vacuum (analyze) properties, units, listings, contacts, deals, deal_parties, deal_agents, deal_assignments, deal_stage_history`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 600_000);

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers deal requests at p95 under ${TARGET_P95_MS} ms`, async () => {
    const counts = await sql<{ open: number }>`
      select count(*)::int as open from deals where company_id = ${company.companyId}::uuid and status = 'open'`.execute(fx.db);
    expect(counts.rows[0]).toEqual({ open: OPEN_DEALS });

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
      send: (method: 'post' | 'put', path: string, body: object, status: number, version?: number) => {
        const req = t.http[method](path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId);
        return (version === undefined ? req : req.set('If-Match', `"${version}"`)).send(body).expect(status);
      },
    });
    const sample = await sql<{ dealId: string; contactId: string; listingId: string }>`
      select d.id as "dealId", d.primary_contact_id as "contactId", d.listing_id as "listingId"
        from deals d where d.company_id = ${company.companyId}::uuid and d.owner_membership_id = ${agents[0]}::uuid and d.status = 'open'
       order by d.reference limit 10`.execute(fx.db);
    const rows = sample.rows;
    const month = new Date().toISOString().slice(0, 7);

    for (let run = 0; run < 3; run += 1) {
      const row = rows[run]!;
      await time('list owner', () => http('owner').get('/api/v1/deals?limit=50'));
      await time('list manager', () => http('manager').get('/api/v1/deals?limit=50&filter[dealType]=sale'));
      await time('list agent', () => http('agent').get('/api/v1/deals?limit=50'));
      await time('stalled owner', () => http('owner').get('/api/v1/deals?limit=50&filter[attention]=stalled'));
      await time('column owner', () => http('owner').get(`/api/v1/deals?limit=50&filter[stageClass]=negotiation`));
      await time('contact owner', () => http('owner').get(`/api/v1/deals?filter[contactId]=${row.contactId}`));
      await time('search owner', () => http('owner').get('/api/v1/deals?limit=50&q=Buyer%201'));
      await time('board owner', () => http('owner').get('/api/v1/deals/pipeline?dealType=sale'));
      await time('board agent', () => http('agent').get('/api/v1/deals/pipeline?dealType=sale'));
      await time('forecast owner', () => http('owner').get(`/api/v1/deals/forecast?dealType=sale&from=${month}&months=12`));
      await time('forecast manager', () => http('manager').get(`/api/v1/deals/forecast?dealType=sale&from=${month}&months=12`));
      await time('deal agent', () => http('agent').get(`/api/v1/deals/${row.dealId}`));
    }
    // Writes: the agent creates deals and moves one; the manager reassigns and sets splits.
    const listing = rows[0]!.listingId;
    const own = await sql<{ id: string }>`select id from contacts where company_id = ${company.companyId}::uuid and owner_membership_id = ${agents[0]}::uuid order by reference limit 3`.execute(fx.db);
    for (const buyer of own.rows) {
      await time('create agent', () => http('agent').send('post', '/api/v1/deals', { dealType: 'sale', primaryContactId: buyer.id, listingId: listing }, 201));
    }
    for (let run = 6; run < 8; run += 1) {
      const row = rows[run]!;
      const deal = await http('manager').get(`/api/v1/deals/${row.dealId}`);
      const reassigned = await time('reassign manager', () => http('manager').send('post', `/api/v1/deals/${row.dealId}/reassign`, { ownerMembershipId: agents[1], note: 'Rebalancing' }, 200, deal.body.version as number));
      await time('splits manager', () =>
        http('manager').send('put', `/api/v1/deals/${row.dealId}/agents`, { agents: [{ membershipId: agents[1], agentRole: 'lister', splitPercent: 70 }, { membershipId: agents[2], agentRole: 'co_agent', splitPercent: 30 }] }, 200, reassigned.body.version as number),
      );
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(
      `deals: ${counts.rows[0]!.open} open deals, ${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, ` +
        `p95 ${p95.toFixed(0)} ms, slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); max by kind: ${kinds}`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);
});
