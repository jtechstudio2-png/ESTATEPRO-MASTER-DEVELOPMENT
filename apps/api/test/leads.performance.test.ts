import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Leads, timelines and follow-ups at scale (Phase 1 §6: list and search p95
 * under 1 s). One company with 50,000 contacts, 100,000 leads across two
 * offices, 300,000 activities (one busy contact has 2,000) and 100,000
 * follow-ups. Requests go through the full API as owner, office manager and
 * agent (row-level security, lead scope and decision D1).
 */
const CONTACTS = 50_000;
const LEADS = 100_000;
const ACTIVITIES = 300_000;
const TASKS = 100_000;
const TARGET_P95_MS = 1_000;

describe('leads, timeline and follow-up performance', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  const tokens: Record<string, string> = {};
  let busyContactId: string;
  let agentLeadId: string;
  let agentContactId: string;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    const ksi = (await fx.office(company.companyId, 'KSI')).id;
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const sales = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    const authTime = Math.floor(Date.now() / 1000);
    for (const [name, userId] of [['owner', company.ownerUserId], ['agent', agent.userId], ['sales', sales.userId]] as const) {
      await fx.linkIdentity(userId, `c3-perf-${name}-${company.companyId}`);
      tokens[name] = await t.idp.token({ sub: `c3-perf-${name}-${company.companyId}`, amr: ['pwd', 'mfa'], authTime });
    }
    const c = company.companyId;
    const owner = company.ownerMembershipId;

    await sql`
      insert into contacts (company_id, reference, contact_type, display_name, primary_phone_e164, office_id, owner_membership_id)
      select ${c}::uuid, 'C3C-' || n, 'person', 'Lead Client ' || n, '+23327' || lpad(n::text, 7, '0'),
             case when n % 3 = 0 then ${ksi}::uuid else ${company.officeId}::uuid end,
             case when n % 20 = 0 then ${agent.membershipId}::uuid else ${owner}::uuid end
        from generate_series(1, ${CONTACTS}) n`.execute(fx.db);
    await sql`
      insert into leads (company_id, reference, contact_id, lead_type, status, source_code, office_id, assigned_to, received_at, first_response_at, message, created_by)
      select ${c}::uuid, 'C3L-' || n, c.id, (array['buy', 'rent', 'sell', 'valuation'])[1 + n % 4],
             (array['new', 'contacted', 'qualified', 'unqualified'])[1 + n % 4], (array['website', 'property_portal', 'phone', 'walk_in'])[1 + n % 4],
             c.office_id,
             case when n % 10 = 0 then null when n % 20 = 1 then ${agent.membershipId}::uuid else ${owner}::uuid end,
             now() - make_interval(mins => n), case when n % 2 = 0 then now() - make_interval(mins => n) + interval '20 minutes' end,
             'Enquiry ' || n || E'\nSecond line', ${owner}::uuid
        from generate_series(1, ${LEADS}) n
        join contacts c on c.company_id = ${c}::uuid and c.reference = 'C3C-' || (1 + n % ${CONTACTS})`.execute(fx.db);
    await sql`
      with a as (
        insert into activities (company_id, activity_type, direction, body, occurred_at, performed_by, created_by, subject)
        select ${c}::uuid, (array['call', 'whatsapp', 'note', 'email'])[1 + n % 4], case when n % 4 = 2 then 'internal' else 'outbound' end,
               'Activity body ' || n, now() - make_interval(secs => n * 7), ${owner}::uuid, ${owner}::uuid, 'n' || n
          from generate_series(1, ${ACTIVITIES}) n
        returning id, subject
      )
      insert into activity_links (company_id, activity_id, entity_type, entity_id)
      select ${c}::uuid, a.id, 'lead', l.id
        from a join leads l on l.company_id = ${c}::uuid and l.reference = 'C3L-' || (1 + substring(a.subject from 2)::int % ${LEADS})`.execute(fx.db);
    await sql`
      insert into activity_links (company_id, activity_id, entity_type, entity_id)
      select k.company_id, k.activity_id, 'contact', l.contact_id
        from activity_links k join leads l on l.id = k.entity_id
       where k.company_id = ${c}::uuid and k.entity_type = 'lead'`.execute(fx.db);
    // One busy contact: 2,000 more entries.
    busyContactId = (await fx.db.selectFrom('contacts').select('id').where('companyId', '=', c).where('reference', '=', 'C3C-7').executeTakeFirstOrThrow()).id;
    await sql`
      with a as (
        insert into activities (company_id, activity_type, direction, body, occurred_at, performed_by, created_by)
        select ${c}::uuid, 'call', 'inbound', 'Busy ' || n, now() - make_interval(mins => n), ${owner}::uuid, ${owner}::uuid
          from generate_series(1, 2000) n
        returning id
      )
      insert into activity_links (company_id, activity_id, entity_type, entity_id) select ${c}::uuid, id, 'contact', ${busyContactId}::uuid from a`.execute(fx.db);
    await sql`
      insert into tasks (company_id, title, task_type, priority, due_at, remind_at, assigned_to, entity_type, entity_id, created_by)
      select ${c}::uuid, 'Follow up ' || n, 'follow_up', (array['low', 'normal', 'high'])[1 + n % 3],
             now() + make_interval(mins => n % 20000 - 2000), now() + make_interval(mins => n % 20000 - 2060),
             case when n % 20 = 0 then ${agent.membershipId}::uuid when n % 5 = 0 then ${sales.membershipId}::uuid else ${owner}::uuid end,
             'lead', l.id, ${owner}::uuid
        from generate_series(1, ${TASKS}) n
        join leads l on l.company_id = ${c}::uuid and l.reference = 'C3L-' || (1 + n % ${LEADS})`.execute(fx.db);
    await fx.db
      .insertInto('companySettings')
      .values({ companyId: c, officeId: null, key: 'crm.lead_response_minutes', value: JSON.stringify(30), updatedBy: company.ownerUserId })
      .execute();
    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-c3-perf-analyze');
    try {
      await sql`vacuum (analyze) contacts, leads, activities, activity_links, tasks`.execute(admin);
    } finally {
      await admin.destroy();
    }
    const agentLead = await fx.db.selectFrom('leads').select(['id', 'contactId']).where('companyId', '=', c).where('reference', '=', 'C3L-21').executeTakeFirstOrThrow();
    agentLeadId = agentLead.id;
    agentContactId = agentLead.contactId;
  }, 900_000);

  // The data stays in this run's own company: the test database is rebuilt for every run.
  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers inbox, timeline and follow-up requests at p95 under ${TARGET_P95_MS} ms`, async () => {
    const samples: number[] = [];
    const byKind = new Map<string, number>();
    let slowest = { ms: 0, label: '' };
    const time = async (label: string, run: () => Promise<unknown>) => {
      const started = performance.now();
      await run();
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      const kind = label.split(' ')[0]!;
      byKind.set(kind, Math.max(byKind.get(kind) ?? 0, elapsed));
      if (elapsed > slowest.ms) slowest = { ms: elapsed, label };
    };
    const get = (who: string, path: string) =>
      t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);

    for (let run = 0; run < 3; run++) {
      for (const who of ['owner', 'sales', 'agent']) {
        await time(`inbox ${who}`, () => get(who, '/api/v1/leads?filter[status]=new'));
        await time(`mine ${who}`, () => get(who, '/api/v1/leads?filter[assignedTo]=me'));
        await time(`open ${who}`, () => get(who, '/api/v1/leads?filter[status]=new,contacted,qualified&sort=-updatedAt'));
        await time(`overdue ${who}`, () => get(who, '/api/v1/leads?filter[attention]=response_overdue'));
        await time(`search ${who}`, () => get(who, '/api/v1/leads?q=Lead%20Client%201234'));
        await time(`follow-ups ${who}`, () => get(who, '/api/v1/tasks'));
        await time(`overdue-tasks ${who}`, () => get(who, '/api/v1/tasks?filter[overdue]=true'));
      }
      await time('unassigned sales', () => get('sales', '/api/v1/leads?filter[assignedTo]=unassigned'));
      await time('team sales', () => get('sales', '/api/v1/tasks?filter[view]=team'));
      await time('team owner', () => get('owner', '/api/v1/tasks?filter[view]=team&filter[priority]=high'));
      await time('lead agent', () => get('agent', `/api/v1/leads/${agentLeadId}`));
      await time('lead-timeline agent', () => get('agent', `/api/v1/leads/${agentLeadId}/activities`));
      await time('contact-timeline agent', () => get('agent', `/api/v1/contacts/${agentContactId}/activities`));
      const busy = await get('owner', `/api/v1/contacts/${busyContactId}/activities?limit=100`);
      await time('busy-timeline owner', () => get('owner', `/api/v1/contacts/${busyContactId}/activities?limit=100&cursor=${busy.body.page.nextCursor}`));
      await time('log-activity agent', () =>
        t.http
          .post('/api/v1/activities')
          .auth(tokens['agent']!, { type: 'bearer' })
          .set('X-Company-Id', company.companyId)
          .send({ activityType: 'call', direction: 'outbound', links: [{ entityType: 'lead', entityId: agentLeadId }] })
          .expect(201),
      );
      await time('schedule agent', () =>
        t.http
          .post('/api/v1/tasks')
          .auth(tokens['agent']!, { type: 'bearer' })
          .set('X-Company-Id', company.companyId)
          .send({ title: 'Perf follow-up', dueAt: new Date(Date.now() + 86_400_000).toISOString(), about: { entityType: 'lead', entityId: agentLeadId } })
          .expect(201),
      );
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    console.info(
      `leads/timeline/follow-ups: ${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, ` +
        `slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); ${[...byKind.entries()].map(([kind, ms]) => `${kind} ${ms.toFixed(0)}`).join(', ')}`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);
});
