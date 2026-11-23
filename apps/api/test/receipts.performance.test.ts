import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { settleDatabase } from './support/settle.js';
import { sha256Hex } from './support/media-files.js';

/**
 * Receipts and arrears at scale (readiness report §10; P7-0 R1): API p95 under
 * 1,000 ms and the daily arrears workflow under 60 s with 20,000 leases,
 * 500,000 rent charges, 300,000 payments and 400,000 allocations in one
 * company (each lease: 24 monthly rent charges from December 2024 and a
 * service charge; 15 receipts and 20 allocations; the last four months and
 * the service charge unpaid, so every lease is in arrears). Balances are the
 * maintained ones of migration 0038. Requests go through the full API as
 * owner (all) and property manager (office); a 1,000-line bank file is checked
 * and committed.
 */
const PROPERTIES = 2_000;
const UNITS_PER_PROPERTY = 10;
const LEASES = PROPERTIES * UNITS_PER_PROPERTY;
const TARGET_P95_MS = 1_000;
const TARGET_JOB_MS = 60_000;
const FILE_LINES = 1_000;

describe('receipts and arrears performance (300,000 payments, 400,000 allocations)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let account: string;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    const c = company.companyId;
    const pm = await fx.member(c, { roleKey: 'property_manager', officeIds: [company.officeId] });
    const authTime = Math.floor(Date.now() / 1000);
    for (const [name, userId] of [['owner', company.ownerUserId], ['pm', pm.userId]] as const) {
      await fx.linkIdentity(userId, `l3-perf-${name}-${c}`);
      tokens[name] = await t.idp.token({ sub: `l3-perf-${name}-${c}`, amr: ['pwd', 'mfa'], authTime });
    }
    ({ worker, close: closeWorker } = createWorker(t.config, { info: () => undefined, warn: () => undefined, error: () => undefined }, { scheduleEveryMs: 0, now: () => new Date('2026-11-20T06:00:00Z'), jobTypes: ['document.scan'] }));
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-l3-perf-seed');
    try {
      // Bulk seed with row triggers off (session_replication_role); the rules are covered by SQL suites 17, 20 and 21.
      await admin.transaction().execute(async (tx) => {
        await sql`set local session_replication_role = replica`.execute(tx);
        await sql`
          with addr as (
            insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted)
            select ${c}::uuid, 'GH', n || ' Receipt Road', 'Accra', 'Greater Accra', n || ' Receipt Road, Accra' from generate_series(1, ${PROPERTIES}) n
            returning id),
          numbered as (select id, row_number() over () as n from addr)
          insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
          select ${c}::uuid, 'L3P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Receipt court ' || n, ${company.ownerMembershipId}::uuid
            from numbered`.execute(tx);
        await sql`
          insert into units (company_id, property_id, reference, unit_label, bedrooms)
          select p.company_id, p.id, p.reference || '-U' || u, 'Flat ' || u, 2
            from properties p cross join generate_series(1, ${UNITS_PER_PROPERTY}) u where p.company_id = ${c}::uuid and p.reference like 'L3P-%'`.execute(tx);
        await sql`
          insert into contacts (company_id, reference, contact_type, display_name, office_id)
          select ${c}::uuid, 'L3T-' || n, 'person', 'Tenant ' || n, ${company.officeId}::uuid from generate_series(1, ${LEASES}) n`.execute(tx);
        await sql`
          with u as (select u.id, row_number() over (order by u.reference) as n from units u where u.company_id = ${c}::uuid and u.reference like 'L3P-%')
          insert into leases (company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date, currency_code,
                              rent_amount, rent_frequency, rent_due_day, advance_periods, signed_at, rent_schedule_from, created_by)
          select ${c}::uuid, 'LSP-2026-' || lpad(u.n::text, 6, '0'), u.id, 'GH', 'fixed_term', 'active', '2024-12-01', '2026-12-31', 'GHS',
                 3000 + (u.n % 50) * 100, 'monthly', 1, 1, now() - interval '700 days', '2024-12-01', ${company.ownerMembershipId}::uuid
            from u`.execute(tx);
        await sql`
          insert into lease_parties (company_id, lease_id, contact_id, party_role, is_primary)
          select l.company_id, l.id, t.id, 'tenant', true
            from leases l join contacts t on t.company_id = l.company_id and t.reference = 'L3T-' || (substr(l.reference, 10)::int)
           where l.company_id = ${c}::uuid and l.reference like 'LSP-2026-%'`.execute(tx);
        await sql`
          insert into rent_charges (company_id, lease_id, charge_type, description, period_start, period_end, due_date, currency_code, amount, status, source, posted_at)
          select l.company_id, l.id, 'rent', 'Rent ' || m::date, m::date, (m + interval '1 month' - interval '1 day')::date, m::date, 'GHS', l.rent_amount, 'posted', 'schedule', m
            from leases l cross join generate_series('2024-12-01'::date, '2026-11-01'::date, interval '1 month') m
           where l.company_id = ${c}::uuid and l.reference like 'LSP-2026-%'
          union all
          select l.company_id, l.id, 'service_charge', 'Service charge 2026', '2026-01-01', '2026-12-31', '2026-01-15', 'GHS', 900, 'posted', 'manual', '2026-01-15'
            from leases l where l.company_id = ${c}::uuid and l.reference like 'LSP-2026-%'`.execute(tx);
        await sql`
          create temporary table l3_alloc on commit drop as
          select rc.company_id, rc.lease_id, rc.id as charge_id, rc.total_amount as amount, rc.due_date,
                 ((row_number() over (partition by rc.lease_id order by rc.due_date) - 1) * 15 / 20) + 1 as payment_no,
                 row_number() over (partition by rc.lease_id order by rc.due_date) as k
            from rent_charges rc where rc.company_id = ${c}::uuid and rc.charge_type = 'rent'`.execute(tx);
        await sql`delete from l3_alloc where k > 20`.execute(tx);
        const bank = await sql<{ id: string }>`insert into bank_accounts (company_id, name, account_purpose, country_code, currency_code)
          values (${c}::uuid, 'Client account', 'client_money', 'GH', 'GHS') returning id`.execute(tx);
        account = bank.rows[0]!.id;
        await sql`
          insert into payments (company_id, reference, payer_contact_id, lease_id, bank_account_id, method_code, currency_code, amount, received_on, value_date, status)
          select a.company_id, 'L3R-' || l.reference || '-' || a.payment_no, lp.contact_id, a.lease_id, ${account}::uuid, 'bank_transfer', 'GHS',
                 sum(a.amount), max(a.due_date), max(a.due_date), 'cleared'
            from l3_alloc a join leases l on l.id = a.lease_id join lease_parties lp on lp.lease_id = l.id and lp.is_primary
           group by a.company_id, a.lease_id, l.reference, lp.contact_id, a.payment_no`.execute(tx);
        await sql`
          insert into payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
          select a.company_id, p.id, a.charge_id, a.amount, a.due_date
            from l3_alloc a join leases l on l.id = a.lease_id join payments p on p.company_id = a.company_id and p.reference = 'L3R-' || l.reference || '-' || a.payment_no`.execute(tx);
        // The maintained balances (migration 0038), as the triggers would have kept them.
        await sql`update rent_charges c set allocated_amount = a.net
                    from (select rent_charge_id, sum(amount) as net from payment_allocations where company_id = ${c}::uuid group by rent_charge_id) a
                   where c.id = a.rent_charge_id`.execute(tx);
        await sql`update payments p set allocated_amount = a.net
                    from (select payment_id, sum(amount) as net from payment_allocations where company_id = ${c}::uuid group by payment_id) a
                   where p.id = a.payment_id`.execute(tx);
        await sql`insert into company_settings (company_id, office_id, key, value) values
                    (${c}::uuid, null, 'lettings.arrears_steps', '[{"actionCode": "reminder", "afterDays": 3}, {"actionCode": "formal_notice", "afterDays": 14}]'::jsonb),
                    (${c}::uuid, null, 'lettings.require_signed_lease', 'false'::jsonb)`.execute(tx);
      });
      await sql`vacuum (analyze) leases, lease_parties, rent_charges, payments, payment_allocations, rent_charge_adjustments, arrears_actions, payment_plans`.execute(admin);
      await settleDatabase(admin);
    } finally {
      await admin.destroy();
    }
  }, 900_000);

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  it(`answers receipt and arrears requests at p95 under ${TARGET_P95_MS} ms and runs the arrears workflow in under ${TARGET_JOB_MS / 1000} s`, async () => {
    const counts = await sql<{ charges: number; payments: number; allocations: number }>`
      select (select count(*)::int from rent_charges where company_id = ${company.companyId}::uuid) as charges,
             (select count(*)::int from payments where company_id = ${company.companyId}::uuid) as payments,
             (select count(*)::int from payment_allocations where company_id = ${company.companyId}::uuid) as allocations`.execute(fx.db);
    expect(counts.rows[0]).toEqual({ charges: 500_000, payments: 300_000, allocations: 400_000 });

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
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(who: string, req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId);
    const get = (who: string, path: string) => auth(who, t.http.get(path)).expect(200);
    const post = (who: string, path: string, body: object, status: number, version?: number) => {
      const req = auth(who, t.http.post(path));
      return (version === undefined ? req : req.set('If-Match', `"${version}"`)).send(body).expect(status);
    };
    const sample = await sql<{ leaseId: string; tenantId: string; reference: string; openCharge: string }>`
      select l.id as "leaseId", lp.contact_id as "tenantId", l.reference,
             (select id from rent_charges where lease_id = l.id and due_date = '2026-09-01') as "openCharge"
        from leases l join lease_parties lp on lp.lease_id = l.id and lp.is_primary
       where l.company_id = ${company.companyId}::uuid and l.reference like 'LSP-2026-%' order by l.reference limit 3`.execute(fx.db);

    for (let run = 0; run < 3; run += 1) {
      const row = sample.rows[run]!;
      await time('arrears owner', () => get('owner', '/api/v1/arrears?limit=50'));
      await time('arrears pm', () => get('pm', '/api/v1/arrears?limit=50&filter[bucket]=90%2B'));
      await time('monthend owner', () => get('owner', '/api/v1/arrears?asOf=2026-06-30&limit=50'));
      await time('tab pm', () => get('pm', `/api/v1/leases/${row.leaseId}/arrears`));
      await time('receipts owner', () => get('owner', '/api/v1/payments?limit=50'));
      await time('unallocated owner', () => get('owner', '/api/v1/payments?limit=50&filter[unallocated]=true&sort=receivedOn'));
      await time('lease pm', () => get('pm', `/api/v1/payments?filter[leaseId]=${row.leaseId}`));
      await time('cheques owner', () => get('owner', '/api/v1/payments?filter[status]=pending&filter[instrumentDate][lte]=2026-12-31&sort=instrumentDate'));
      const recorded = await time('record owner', () =>
        auth('owner', t.http.post('/api/v1/payments')).set('Idempotency-Key', `perf-${randomUUID()}`).send({ payerContactId: row.tenantId, leaseId: row.leaseId, bankAccountId: account, methodCode: 'cash', amount: { amount: '500.00', currency: 'GHS' }, receivedOn: '2026-11-20' }).expect(201),
      );
      await time('view owner', () => get('owner', `/api/v1/payments/${recorded.body.id}/allocations`));
      await time('allocate owner', () => post('owner', `/api/v1/payments/${recorded.body.id}/allocations`, { allocatedOn: '2026-11-20', lines: [{ rentChargeId: row.openCharge, amount: { amount: '500.00', currency: 'GHS' } }] }, 201));
      const current = await get('owner', `/api/v1/payments/${recorded.body.id}`);
      await time('void owner', () => post('owner', `/api/v1/payments/${recorded.body.id}/void`, { reason: 'Performance run', on: '2026-11-20' }, 200, current.body.version as number));
      await time('action pm', () => post('pm', `/api/v1/leases/${row.leaseId}/arrears-actions`, { actionCode: 'call', actionDate: '2026-11-20' }, 201));
    }

    // A 1,000-line bank file: half name a lease, half do not.
    const lines = ['date,amount,currency,reference,transaction_id'];
    for (let i = 0; i < FILE_LINES; i += 1) lines.push(`2026-11-1${i % 9},${100 + i}.00,GHS,${i % 2 === 0 ? `LSP-2026-${String(i + 1).padStart(6, '0')}` : `NOTE ${i}`},PERF-${i}`);
    const file = Buffer.from(lines.join('\n'), 'utf-8');
    const ticket = await post('owner', '/api/v1/documents/uploads', { entityType: 'bank_account', entityId: account, title: 'Statement', documentTypeCode: 'bank_statement', isSigned: false, fileName: 'statement.csv', contentType: 'text/csv', size: file.length, sha256: sha256Hex(file) }, 201);
    await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: file });
    const document = await post('owner', `/api/v1/documents/uploads/${ticket.body.id}/confirm`, {}, 201);
    await worker.runOnce();
    const checkStarted = performance.now();
    const checked = await post('owner', '/api/v1/payments/imports', { bankAccountId: account, documentId: document.body.id }, 201);
    const checkMs = performance.now() - checkStarted;
    expect(checked.body.summary).toMatchObject({ lines: FILE_LINES, matched: FILE_LINES / 2, unmatched: FILE_LINES / 2 });
    const commitStarted = performance.now();
    const committed = await post('owner', `/api/v1/payments/imports/${checked.body.id}/commit`, { choices: [] }, 200, checked.body.version as number);
    const commitMs = performance.now() - commitStarted;
    expect(committed.body.summary).toMatchObject({ imported: FILE_LINES / 2, queued: FILE_LINES / 2 });
    await time('queue owner', () => get('owner', '/api/v1/payments/import-lines?limit=50'));

    const jobStarted = performance.now();
    const job = await worker.runArrearsWorkflow(company.companyId);
    const jobMs = performance.now() - jobStarted;
    expect(job.recorded).toBe(LEASES);
    const againStarted = performance.now();
    expect((await worker.runArrearsWorkflow(company.companyId)).recorded).toBe(0);
    const againMs = performance.now() - againStarted;

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(
      `receipts: ${counts.rows[0]!.charges} charges, ${counts.rows[0]!.payments} payments, ${counts.rows[0]!.allocations} allocations; ` +
        `${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); ` +
        `bank file of ${FILE_LINES} lines: check ${checkMs.toFixed(0)} ms, commit ${commitMs.toFixed(0)} ms; ` +
        `arrears workflow ${(jobMs / 1000).toFixed(1)} s for ${job.recorded} leases (re-run ${(againMs / 1000).toFixed(1)} s); max by kind: ${kinds}`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
    expect(jobMs).toBeLessThan(TARGET_JOB_MS);
  }, 900_000);
});
