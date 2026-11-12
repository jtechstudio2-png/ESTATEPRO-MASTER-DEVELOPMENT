import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createWorker } from '../src/worker/create-worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Dashboards, exports and the landlord preview at scale. One company with
 * 50,000 contacts, 100,000 leads, 100,000 follow-ups, 20,000 active
 * requirements, 20,000 listings (half published) and a landlord who owns
 * 100 properties. Dashboards and the preview must answer within 1 s at
 * p95; an export of 20,000 contacts (written to object storage) within 5 s.
 */
const CONTACTS = 50_000;
const LEADS = 100_000;
const TASKS = 100_000;
const REQUIREMENTS = 20_000;
const PROPERTIES = 1_000;
const TARGET_P95_MS = 1_000;
const EXPORT_TARGET_MS = 5_000;

describe('dashboards, exports and preview performance', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  const tokens: Record<string, string> = {};
  let landlordId: string;
  let ksiOfficeId: string;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    ksiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const sales = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    for (const [name, userId] of [['owner', company.ownerUserId], ['agent', agent.userId], ['sales', sales.userId]] as const) {
      await fx.linkIdentity(userId, `c4-perf-${name}-${company.companyId}`);
    }
    const c = company.companyId;
    const owner = company.ownerMembershipId;
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();

    await sql`
      insert into contacts (company_id, reference, contact_type, display_name, primary_phone_e164, primary_email, office_id, owner_membership_id)
      select ${c}::uuid, 'C4C-' || n, 'person', 'Dash Client ' || n, '+23328' || lpad(n::text, 7, '0'), 'c4-' || n || '@perf.test',
             case when n % 3 = 0 then ${ksiOfficeId}::uuid else ${company.officeId}::uuid end,
             case when n % 20 = 0 then ${agent.membershipId}::uuid when n % 50 = 1 then null else ${owner}::uuid end
        from generate_series(1, ${CONTACTS}) n`.execute(fx.db);
    await sql`
      insert into contact_methods (company_id, contact_id, method_type, value, normalised, is_primary)
      select company_id, id, 'mobile', primary_phone_e164, primary_phone_e164, true from contacts where company_id = ${c}::uuid and reference like 'C4C-%'`.execute(fx.db);
    await sql`
      insert into contact_relationships (company_id, contact_id, relationship_type)
      select company_id, id, (array['buyer', 'tenant', 'landlord', 'seller'])[1 + substring(reference from 5)::int % 4]
        from contacts where company_id = ${c}::uuid and reference like 'C4C-%'`.execute(fx.db);
    await sql`
      insert into leads (company_id, reference, contact_id, lead_type, status, lost_reason_code, source_code, office_id, assigned_to, received_at, first_response_at)
      select ${c}::uuid, 'C4L-' || n, c.id, (array['buy', 'rent', 'sell'])[1 + n % 3], (array['new', 'contacted', 'qualified', 'lost'])[1 + n % 4],
             case when n % 4 = 3 then 'price' end,
             (array['website', 'property_portal', 'phone', 'walk_in', 'referral'])[1 + n % 5], c.office_id,
             case when n % 10 = 0 then null when n % 20 = 1 then ${agent.membershipId}::uuid else ${owner}::uuid end,
             now() - make_interval(mins => n % 60000), case when n % 4 <> 0 then now() - make_interval(mins => n % 60000) + make_interval(mins => n % 180) end
        from generate_series(1, ${LEADS}) n
        join contacts c on c.company_id = ${c}::uuid and c.reference = 'C4C-' || (1 + n % ${CONTACTS})`.execute(fx.db);
    await sql`
      insert into lead_status_history (company_id, lead_id, from_status, to_status, changed_at)
      select company_id, id, 'contacted', 'qualified', received_at + interval '1 day' from leads where company_id = ${c}::uuid and status = 'qualified'`.execute(fx.db);
    await sql`
      insert into tasks (company_id, title, due_at, assigned_to, entity_type, entity_id, created_by)
      select ${c}::uuid, 'Follow up ' || n, now() + make_interval(mins => n % 20000 - 5000),
             case when n % 20 = 0 then ${agent.membershipId}::uuid when n % 5 = 0 then ${sales.membershipId}::uuid else ${owner}::uuid end,
             'lead', l.id, ${owner}::uuid
        from generate_series(1, ${TASKS}) n join leads l on l.company_id = ${c}::uuid and l.reference = 'C4L-' || (1 + n % ${LEADS})`.execute(fx.db);
    await sql`
      with addr as (
        insert into addresses (company_id, country_code, address_line_1, locality, formatted, latitude, longitude, geocode_source, geocoded_at)
        select ${c}::uuid, 'GH', n || ' Dash Road', 'Accra', n || ' Dash Road', 5.55 + (n % 100) / 1000.0, -0.2 + (n % 97) / 1000.0, 'import', now()
          from generate_series(1, ${PROPERTIES}) n returning id
      ), numbered as (select id, row_number() over () as n from addr)
      insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
      select ${c}::uuid, 'C4P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Dash house ' || n, ${owner}::uuid from numbered`.execute(fx.db);
    await sql`
      insert into units (company_id, property_id, reference, unit_label, bedrooms)
      select p.company_id, p.id, p.reference || '-U' || u, 'Unit ' || u, (1 + u % 4)::smallint
        from properties p cross join generate_series(1, 10) u where p.company_id = ${c}::uuid and p.reference like 'C4P-%'`.execute(fx.db);
    await sql`
      insert into listings (company_id, reference, unit_id, listing_type, status, currency_code, price, rent_frequency, agent_membership_id, office_id,
                            default_locale_code, title, is_published, published_at)
      select u.company_id, 'C4LS-' || k.kind || '-' || u.reference, u.id, k.kind, 'available', 'GHS',
             case k.kind when 'sale' then 200000 + (abs(hashtext(u.reference)) % 1800000) else 2000 + (abs(hashtext(u.reference)) % 10000) end,
             case when k.kind = 'rent' then 'monthly' end, ${owner}::uuid, ${company.officeId}::uuid, 'en-GH', 'Dash listing', abs(hashtext(u.reference || k.kind)) % 2 = 0, now()
        from units u cross join (values ('sale'), ('rent')) as k (kind) where u.company_id = ${c}::uuid and u.reference like 'C4P-%'`.execute(fx.db);
    await sql`
      insert into requirements (company_id, contact_id, requirement_type, currency_code, min_price, max_price, rent_frequency, min_bedrooms, locations)
      select c.company_id, c.id, case when n % 2 = 0 then 'buy' else 'rent' end, 'GHS',
             case when n % 2 = 0 then 300000 + (n % 10) * 100000 else 2000 + (n % 10) * 500 end,
             case when n % 2 = 0 then 600000 + (n % 10) * 150000 else 4000 + (n % 10) * 800 end,
             case when n % 2 = 1 then 'monthly' end, (1 + n % 4)::smallint,
             case when n % 5 = 0 then jsonb_build_array(jsonb_build_object('kind', 'locality', 'locality', 'Kumasi')) else '[]'::jsonb end
        from (select c.*, substring(c.reference from 5)::int as n from contacts c where c.company_id = ${c}::uuid and c.reference like 'C4C-%') c
       where c.n <= ${REQUIREMENTS}`.execute(fx.db);
    landlordId = (await fx.db.selectFrom('contacts').select('id').where('companyId', '=', c).where('reference', '=', 'C4C-3').executeTakeFirstOrThrow()).id;
    await sql`
      insert into property_ownerships (company_id, property_id, owner_contact_id, effective_from)
      select company_id, id, ${landlordId}::uuid, '2020-01-01' from properties
       where company_id = ${c}::uuid and reference like 'C4P-%' and substring(reference from 5)::int <= 100`.execute(fx.db);
    await fx.db.insertInto('companySettings').values({ companyId: c, officeId: null, key: 'crm.lead_response_minutes', value: JSON.stringify(60), updatedBy: company.ownerUserId }).execute();
    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-c4-perf-analyze');
    try {
      await sql`vacuum (analyze) contacts, contact_methods, contact_relationships, leads, lead_status_history, tasks, properties, units, listings, requirements, property_ownerships`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 900_000);

  // The data stays in this run's own company: the test database is rebuilt for every run.
  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers dashboards and the preview at p95 under ${TARGET_P95_MS} ms, and exports 20,000 contacts within ${EXPORT_TARGET_MS} ms`, async () => {
    // Tokens are issued after the (long) seeding so they are fresh.
    const authTime = Math.floor(Date.now() / 1000);
    for (const name of ['owner', 'agent', 'sales']) {
      tokens[name] = await t.idp.token({ sub: `c4-perf-${name}-${company.companyId}`, amr: ['pwd', 'mfa'], authTime });
    }
    // Background refresh of the "no match" status (worker job, every 15 minutes).
    const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const { worker, close } = createWorker(t.config, silent, { scheduleEveryMs: 0 });
    const refreshStarted = performance.now();
    try {
      await worker.runOnce();
    } finally {
      await close();
    }
    const refreshMs = performance.now() - refreshStarted;
    const samples: number[] = [];
    const byKind = new Map<string, number>();
    const time = async (label: string, run: () => Promise<unknown>) => {
      const started = performance.now();
      await run();
      const elapsed = performance.now() - started;
      if (process.env['PERF_TRACE']) console.info(`perf ${label} ${elapsed.toFixed(0)} ms`);
      byKind.set(label, Math.max(byKind.get(label) ?? 0, elapsed));
      return elapsed;
    };
    const get = async (who: string, path: string) => {
      const res = await t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId);
      expect(res.status, `${who} ${path} ${JSON.stringify(res.body)}`).toBe(200);
      return res;
    };

    for (let run = 0; run < 3; run++) {
      for (const who of ['owner', 'sales', 'agent']) {
        samples.push(await time(`crm-${who}`, () => get(who, '/api/v1/dashboards/crm')));
        samples.push(await time(`my-day-${who}`, () => get(who, '/api/v1/dashboards/my-day')));
      }
      samples.push(await time('crm-office', () => get('owner', `/api/v1/dashboards/crm?officeId=${company.officeId}&days=7`)));
      samples.push(await time('admin', () => get('owner', '/api/v1/dashboards/admin')));
      samples.push(await time('admin-office', () => get('owner', `/api/v1/dashboards/admin?officeId=${ksiOfficeId}`)));
      samples.push(await time('preview', () => get('owner', `/api/v1/contacts/${landlordId}/portal-visibility-preview`)));
    }
    let exportRows = 0;
    const exportMs = await time('contact-export', async () => {
      const res = await t.http
        .post('/api/v1/contacts/exports')
        .auth(tokens['owner']!, { type: 'bearer' })
        .set('X-Company-Id', company.companyId)
        .send({ purpose: 'Performance export of one office', officeId: ksiOfficeId })
        .expect(201);
      exportRows = res.body.rowCount;
    });
    const leadExportMs = await time('lead-export', () =>
      t.http
        .post('/api/v1/leads/exports')
        .auth(tokens['owner']!, { type: 'bearer' })
        .set('X-Company-Id', company.companyId)
        .send({ purpose: 'Performance export of new leads', statuses: ['new'], officeId: ksiOfficeId })
        .expect(201),
    );

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    console.info(
      `dashboards/preview: ${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms; ` +
        `max by kind: ${[...byKind.entries()].map(([kind, ms]) => `${kind} ${ms.toFixed(0)}`).join(', ')}; contact export ${exportRows} rows; match refresh (worker) ${refreshMs.toFixed(0)} ms`,
    );
    expect(exportRows).toBeGreaterThan(15_000);
    expect(refreshMs).toBeLessThan(60_000);
    expect(p95).toBeLessThan(TARGET_P95_MS);
    expect(exportMs).toBeLessThan(EXPORT_TARGET_MS);
    expect(leadExportMs).toBeLessThan(EXPORT_TARGET_MS);
  }, 600_000);
});
