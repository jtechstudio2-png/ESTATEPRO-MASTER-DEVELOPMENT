import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Rent at scale (readiness report §10): API p95 under 1,000 ms and the daily
 * rent job under 60 s with 20,000 leases, 500,000 rent charges, 300,000
 * payments and 400,000 allocations in one company. 2,000 properties of 10
 * units; each lease monthly from December 2024 to December 2026 with 24 rent
 * charges posted (December 2024 to November 2026) and one service charge; 15
 * receipts and 20 allocations per lease. The rent job then creates December
 * 2026 for every lease. Requests go through the full API as owner (all) and
 * property manager (office); the charges list without a date filter covers this
 * month (L2-D9), and a quarter is also requested.
 */
const PROPERTIES = 2_000;
const UNITS_PER_PROPERTY = 10;
const LEASES = PROPERTIES * UNITS_PER_PROPERTY;
const TARGET_P95_MS = 1_000;
const TARGET_JOB_MS = 60_000;

describe('rent performance (20,000 leases, 500,000 charges)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    const c = company.companyId;
    const pm = await fx.member(c, { roleKey: 'property_manager', officeIds: [company.officeId] });
    const accountant = await fx.member(c, { roleKey: 'accountant' });
    Object.assign(members, { accountant: accountant.membershipId });
    const authTime = Math.floor(Date.now() / 1000);
    for (const [name, userId] of [['owner', company.ownerUserId], ['pm', pm.userId]] as const) {
      await fx.linkIdentity(userId, `l2-perf-${name}-${c}`);
      tokens[name] = await t.idp.token({ sub: `l2-perf-${name}-${c}`, amr: ['pwd', 'mfa'], authTime });
    }
    ({ worker, close: closeWorker } = createWorker(t.config, { info: () => undefined, warn: () => undefined, error: () => undefined }, { scheduleEveryMs: 0, now: () => new Date('2026-11-20T06:00:00Z'), jobTypes: [] }));
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-l2-perf-seed');
    try {
      // Bulk seed with row triggers off (session_replication_role); the rules are covered by SQL suites 17 and 20.
      await admin.transaction().execute(async (tx) => {
        await sql`set local session_replication_role = replica`.execute(tx);
        await sql`
          with addr as (
            insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted)
            select ${c}::uuid, 'GH', n || ' Rent Road', 'Accra', 'Greater Accra', n || ' Rent Road, Accra' from generate_series(1, ${PROPERTIES}) n
            returning id),
          numbered as (select id, row_number() over () as n from addr)
          insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
          select ${c}::uuid, 'L2P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Rent court ' || n, ${company.ownerMembershipId}::uuid
            from numbered`.execute(tx);
        await sql`
          insert into units (company_id, property_id, reference, unit_label, bedrooms)
          select p.company_id, p.id, p.reference || '-U' || u, 'Flat ' || u, 2
            from properties p cross join generate_series(1, ${UNITS_PER_PROPERTY}) u where p.company_id = ${c}::uuid and p.reference like 'L2P-%'`.execute(tx);
        await sql`
          insert into contacts (company_id, reference, contact_type, display_name, office_id)
          select ${c}::uuid, 'L2T-' || n, 'person', 'Tenant ' || n, ${company.officeId}::uuid from generate_series(1, ${LEASES}) n`.execute(tx);
        await sql`
          with u as (select u.id, row_number() over (order by u.reference) as n from units u where u.company_id = ${c}::uuid and u.reference like 'L2P-%')
          insert into leases (company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date, currency_code,
                              rent_amount, rent_frequency, rent_due_day, advance_periods, signed_at, rent_schedule_from, created_by)
          select ${c}::uuid, 'L2S-' || u.n, u.id, 'GH', 'fixed_term', 'active', '2024-12-01', '2026-12-31', 'GHS',
                 3000 + (u.n % 50) * 100, 'monthly', 1, 1, now() - interval '700 days', '2024-12-01', ${company.ownerMembershipId}::uuid
            from u`.execute(tx);
        await sql`
          insert into lease_parties (company_id, lease_id, contact_id, party_role, is_primary)
          select l.company_id, l.id, t.id, 'tenant', true
            from leases l join contacts t on t.company_id = l.company_id and t.reference = 'L2T-' || substr(l.reference, 5)
           where l.company_id = ${c}::uuid and l.reference like 'L2S-%'`.execute(tx);
        // 24 rent periods (December 2024 to November 2026) and a service charge per lease: 500,000 charges.
        await sql`
          insert into rent_charges (company_id, lease_id, charge_type, description, period_start, period_end, due_date, currency_code, amount, status, source, posted_at)
          select l.company_id, l.id, 'rent', 'Rent ' || m::date, m::date, (m + interval '1 month' - interval '1 day')::date, m::date, 'GHS', l.rent_amount, 'posted', 'schedule', m
            from leases l cross join generate_series('2024-12-01'::date, '2026-11-01'::date, interval '1 month') m
           where l.company_id = ${c}::uuid and l.reference like 'L2S-%'
          union all
          select l.company_id, l.id, 'service_charge', 'Service charge 2026', '2026-01-01', '2026-12-31', '2026-01-15', 'GHS', 900, 'posted', 'manual', '2026-01-15'
            from leases l where l.company_id = ${c}::uuid and l.reference like 'L2S-%'`.execute(tx);
        // 15 receipts and 20 allocations per lease: the first 20 rent charges paid in full.
        await sql`
          create temporary table l2_alloc on commit drop as
          select rc.company_id, rc.lease_id, rc.id as charge_id, rc.total_amount as amount, rc.due_date,
                 ((row_number() over (partition by rc.lease_id order by rc.due_date) - 1) * 15 / 20) + 1 as payment_no,
                 row_number() over (partition by rc.lease_id order by rc.due_date) as k
            from rent_charges rc where rc.company_id = ${c}::uuid and rc.charge_type = 'rent'`.execute(tx);
        await sql`delete from l2_alloc where k > 20`.execute(tx);
        const bank = await sql<{ id: string }>`insert into bank_accounts (company_id, name, account_purpose, country_code, currency_code)
          values (${c}::uuid, 'Client account', 'client_money', 'GH', 'GHS') returning id`.execute(tx);
        await sql`
          insert into payments (company_id, reference, payer_contact_id, lease_id, bank_account_id, method_code, currency_code, amount, received_on, value_date, status)
          select a.company_id, 'L2R-' || l.reference || '-' || a.payment_no, lp.contact_id, a.lease_id, ${bank.rows[0]!.id}::uuid, 'bank_transfer', 'GHS',
                 sum(a.amount), max(a.due_date), max(a.due_date), 'cleared'
            from l2_alloc a join leases l on l.id = a.lease_id join lease_parties lp on lp.lease_id = l.id and lp.is_primary
           group by a.company_id, a.lease_id, l.reference, lp.contact_id, a.payment_no`.execute(tx);
        await sql`
          insert into payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
          select a.company_id, p.id, a.charge_id, a.amount, a.due_date
            from l2_alloc a join leases l on l.id = a.lease_id join payments p on p.company_id = a.company_id and p.reference = 'L2R-' || l.reference || '-' || a.payment_no`.execute(tx);
        await sql`insert into company_settings (company_id, office_id, key, value) values (${c}::uuid, null, 'lettings.charge_lead_days', '14'::jsonb)`.execute(tx);
      });
      await sql`vacuum (analyze) properties, units, contacts, leases, lease_parties, rent_charges, payments, payment_allocations, rent_charge_adjustments, rent_reviews`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 900_000);

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  it(`runs the daily rent job in under ${TARGET_JOB_MS / 1000} s and answers rent requests at p95 under ${TARGET_P95_MS} ms`, async () => {
    const counts = await sql<{ charges: number; payments: number; allocations: number }>`
      select (select count(*)::int from rent_charges where company_id = ${company.companyId}::uuid) as charges,
             (select count(*)::int from payments where company_id = ${company.companyId}::uuid) as payments,
             (select count(*)::int from payment_allocations where company_id = ${company.companyId}::uuid) as allocations`.execute(fx.db);
    expect(counts.rows[0]).toEqual({ charges: 500_000, payments: 300_000, allocations: 400_000 });

    const jobStarted = performance.now();
    const job = await worker.runRentSchedule(company.companyId);
    const jobMs = performance.now() - jobStarted;
    expect(job).toEqual({ leases: LEASES, posted: LEASES });
    const again = performance.now();
    expect((await worker.runRentSchedule(company.companyId)).posted).toBe(0);
    const againMs = performance.now() - again;

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
    const sample = await sql<{ leaseId: string; chargeId: string; openChargeId: string }>`
      select l.id as "leaseId",
             (select id from rent_charges where lease_id = l.id and charge_type = 'rent' order by due_date limit 1) as "chargeId",
             (select id from rent_charges where lease_id = l.id and charge_type = 'rent' and due_date = '2026-10-01') as "openChargeId"
        from leases l where l.company_id = ${company.companyId}::uuid and l.reference like 'L2S-%' order by l.reference limit 3`.execute(fx.db);

    for (let run = 0; run < 3; run += 1) {
      const row = sample.rows[run]!;
      await time('ledger owner', () => http('owner').get(`/api/v1/leases/${row.leaseId}/ledger?asOf=2026-11-20`));
      await time('ledger pm', () => http('pm').get(`/api/v1/leases/${row.leaseId}/ledger`));
      await time('charges owner', () => http('owner').get('/api/v1/rent-charges?limit=50'));
      await time('month pm', () => http('pm').get('/api/v1/rent-charges?limit=50&filter[dueDate][gte]=2026-11-01&filter[dueDate][lte]=2026-11-30'));
      await time('office owner', () => http('owner').get(`/api/v1/rent-charges?limit=50&filter[officeId]=${company.officeId}&filter[chargeType]=rent&sort=-dueDate`));
      await time('quarter owner', () => http('owner').get('/api/v1/rent-charges?limit=50&filter[dueDate][gte]=2026-07-01&filter[dueDate][lte]=2026-09-30'));
      await time('lease pm', () => http('pm').get(`/api/v1/rent-charges?filter[leaseId]=${row.leaseId}`));
      await time('charge pm', () => http('pm').get(`/api/v1/rent-charges/${row.chargeId}`));
      await time('reviews pm', () => http('pm').get(`/api/v1/leases/${row.leaseId}/rent-reviews`));
      await time('lease owner', () => http('owner').get(`/api/v1/leases/${row.leaseId}`));
      // Writes: add a charge, adjust, preview, waive; schedule a review.
      await time('create owner', () => http('owner').post(`/api/v1/leases/${row.leaseId}/charges`, { chargeType: 'utility', description: 'Water', dueDate: '2026-11-25', amount: { amount: '120.00', currency: 'GHS' }, when: 'post' }, 201));
      const body = { direction: 'credit', amount: { amount: '100.00', currency: 'GHS' }, adjustedOn: '2026-11-20', reason: 'Performance run', approvedBy: members['accountant'] };
      await time('preview owner', () => http('owner').post(`/api/v1/rent-charges/${row.openChargeId}/adjustments/preview`, body, 200));
      await time('adjust owner', () => http('owner').post(`/api/v1/rent-charges/${row.openChargeId}/adjustments`, body, 201));
      const charge = await http('owner').get(`/api/v1/rent-charges/${row.openChargeId}`);
      await time('waive owner', () => http('owner').post(`/api/v1/rent-charges/${row.openChargeId}/waive`, { reason: 'Performance run' }, 200, charge.body.version as number));
      await time('review pm', () => http('pm').post(`/api/v1/leases/${row.leaseId}/rent-reviews`, { reviewDate: '2026-12-01', method: 'negotiated' }, 201));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(
      `rent: ${counts.rows[0]!.charges} charges, ${counts.rows[0]!.payments} payments, ${counts.rows[0]!.allocations} allocations; ` +
        `daily job ${(jobMs / 1000).toFixed(1)} s for ${job.posted} charges (re-run ${(againMs / 1000).toFixed(1)} s); ` +
        `${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); max by kind: ${kinds}`,
    );
    expect(jobMs).toBeLessThan(TARGET_JOB_MS);
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 900_000);
});
