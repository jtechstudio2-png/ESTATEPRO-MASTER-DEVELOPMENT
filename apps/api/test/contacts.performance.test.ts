import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Contact register performance (Phase 1 §6: list and search p95 under 1 s).
 * 100,000 contacts in one company, each with a phone method and a role; a
 * fifth have an Arabic name. Requests go through the full API (auth, tenant
 * transaction, RLS and scope, including the agent's lead and task rule, D1).
 */
const CONTACTS = 100_000;
const TARGET_P95_MS = 1_000;

describe('contact register performance (100,000 contacts)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let ownerToken: string;
  let agentToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    await fx.linkIdentity(company.ownerUserId, `contacts-perf-owner-${company.companyId}`);
    await fx.linkIdentity(agent.userId, `contacts-perf-agent-${company.companyId}`);
    const authTime = Math.floor(Date.now() / 1000);
    ownerToken = await t.idp.token({ sub: `contacts-perf-owner-${company.companyId}`, amr: ['pwd', 'mfa'], authTime });
    agentToken = await t.idp.token({ sub: `contacts-perf-agent-${company.companyId}`, amr: ['pwd', 'mfa'], authTime });
    const c = company.companyId;

    // Owners spread over the owner and the agent; every 50th contact has a lead for the agent.
    await sql`
      insert into contacts (company_id, reference, contact_type, display_name, display_name_local, primary_phone_e164,
                            primary_email, office_id, owner_membership_id)
      select ${c}::uuid, 'PERF-C-' || n, 'person', 'Contact ' || n || ' ' || (array['Owusu', 'Mensah', 'Asante', 'Boateng', 'Darko'])[1 + n % 5],
             case when n % 5 = 0 then 'أحمد ' || n end,
             '+23320' || lpad(n::text, 7, '0'), 'contact' || n || '@perf.test', ${company.officeId}::uuid,
             case when n % 10 = 0 then ${agent.membershipId}::uuid else ${company.ownerMembershipId}::uuid end
        from generate_series(1, ${CONTACTS}) n
    `.execute(fx.db);
    await sql`
      insert into contact_methods (company_id, contact_id, method_type, value, normalised, is_primary)
      select company_id, id, 'mobile', primary_phone_e164, primary_phone_e164, true from contacts
       where company_id = ${c}::uuid and reference like 'PERF-C-%'
    `.execute(fx.db);
    await sql`
      insert into contact_relationships (company_id, contact_id, relationship_type)
      select company_id, id, (array['buyer', 'seller', 'landlord', 'tenant'])[1 + (abs(hashtext(reference)) % 4)] from contacts
       where company_id = ${c}::uuid and reference like 'PERF-C-%'
    `.execute(fx.db);
    await sql`
      insert into leads (company_id, reference, contact_id, lead_type, source_code, assigned_to)
      select company_id, 'PERF-LEA-' || reference, id, 'buy', 'website', ${agent.membershipId}::uuid from contacts
       where company_id = ${c}::uuid and reference like 'PERF-C-%' and substring(reference from 8)::int % 50 = 0
    `.execute(fx.db);
    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-contacts-perf-analyze');
    try {
      await sql`vacuum (analyze) contacts, contact_methods, contact_relationships, leads`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 600_000);

  // The data stays in this run's own company: the test database is rebuilt for
  // every run, and deleting 100,000 contacts (38 referencing tables) would take minutes.
  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers register, view, search and duplicate queries at p95 under ${TARGET_P95_MS} ms`, async () => {
    const count = await sql<{ n: number }>`select count(*)::int as n from contacts where company_id = ${company.companyId}::uuid and reference like 'PERF-C-%'`.execute(fx.db);
    expect(count.rows[0]!.n).toBe(CONTACTS);

    const queries = [
      '/api/v1/contacts',
      '/api/v1/contacts?sort=displayName&limit=100',
      '/api/v1/contacts?filter[relationship]=landlord',
      '/api/v1/contacts?filter[relationship]=buyer,tenant&sort=-createdAt',
      `/api/v1/contacts?q=${encodeURIComponent('Contact 77777')}`,
      `/api/v1/contacts?q=${encodeURIComponent('Mensah')}`,
      `/api/v1/contacts?q=${encodeURIComponent('احمد 4545')}`,
      `/api/v1/contacts?q=${encodeURIComponent('020 004 2424')}`,
      '/api/v1/contacts?q=PERF-C-31337',
    ];
    const samples: number[] = [];
    let slowest = { ms: 0, path: '' };
    const time = async (who: string, run: () => Promise<unknown>, label: string) => {
      const started = performance.now();
      await run();
      const elapsed = performance.now() - started;
      samples.push(elapsed);
      if (elapsed > slowest.ms) slowest = { ms: elapsed, path: `${label} (${who === ownerToken ? 'owner' : 'agent'})` };
    };
    for (const who of [ownerToken, agentToken]) {
      for (const path of queries) {
        for (let run = 0; run < 3; run++) {
          await time(who, () => t.http.get(path).auth(who, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200), path);
        }
      }
      for (let run = 0; run < 3; run++) {
        await time(
          who,
          () =>
            t.http
              .post('/api/v1/contacts/duplicate-check')
              .auth(who, { type: 'bearer' })
              .set('X-Company-Id', company.companyId)
              .send({ primaryPhone: `020 00${String(12345 + run).padStart(5, '0')}`, primaryEmail: `contact${run + 99}@perf.test` })
              .expect(200),
          'duplicate-check',
        );
      }
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        await time(
          who,
          async () => {
            const res: { body: { page: { nextCursor: string | null } } } = await t.http
              .get(`/api/v1/contacts?sort=displayName&limit=100${cursor ? `&cursor=${cursor}` : ''}`)
              .auth(who, { type: 'bearer' })
              .set('X-Company-Id', company.companyId)
              .expect(200);
            cursor = res.body.page.nextCursor;
          },
          'paging',
        );
      }
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    console.info(
      `contact register: ${samples.length} requests, median ${samples[Math.floor(samples.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, slowest ${slowest.ms.toFixed(0)} ms (${slowest.path})`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);
});
