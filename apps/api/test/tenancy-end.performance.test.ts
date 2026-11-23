import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { dropCompanyBulk, settleDatabase } from './support/settle.js';

/**
 * Deposits, inspections, ending and renewal at scale (readiness report §10:
 * API p95 under 1,000 ms; daily jobs under 60 s) for one company: 20,000
 * active fixed-term leases (5,000 ending within 90 days), 20,000 held
 * deposits, 40,000 inspections (a completed move-in and a scheduled
 * periodic inspection per lease) with 400,000 items. Measured: the renewal
 * reminder job, and the screens' requests as owner (all), property manager
 * (office) and maintenance staff (assigned): inspection lists and records, a
 * move-out compared with its move-in, the deposit tab, the close check, the
 * renewals list, and the writes (schedule with copied items, save items,
 * record notice).
 */
const PROPERTIES = 2_000;
const UNITS_PER_PROPERTY = 10;
const LEASES = PROPERTIES * UNITS_PER_PROPERTY;
const ENDING = 5_000;
const ITEMS = 10;
const TARGET_P95_MS = 1_000;
const TARGET_JOB_MS = 60_000;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('tenancy end performance (20,000 leases, 40,000 inspections)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let staffMembership: string;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, jobTypes: ['lease.renewals'] }));
    company = await fx.company();
    const c = company.companyId;
    const pm = await fx.member(c, { roleKey: 'property_manager', officeIds: [company.officeId] });
    const staff = await fx.member(c, { roleKey: 'maintenance_staff', officeIds: [company.officeId] });
    staffMembership = staff.membershipId;
    const authTime = Math.floor(Date.now() / 1000);
    for (const [name, userId] of [['owner', company.ownerUserId], ['pm', pm.userId], ['staff', staff.userId]] as const) {
      await fx.linkIdentity(userId, `l4-perf-${name}-${c}`);
      tokens[name] = await t.idp.token({ sub: `l4-perf-${name}-${c}`, amr: ['pwd', 'mfa'], authTime });
    }
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-l4-perf-seed');
    try {
      // Bulk seed with row triggers off (session_replication_role); the rules are covered by SQL suite 22.
      await admin.transaction().execute(async (tx) => {
        await sql`set local session_replication_role = replica`.execute(tx);
        await sql`
          with addr as (
            insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted)
            select ${c}::uuid, 'GH', n || ' End Road', 'Accra', 'Greater Accra', n || ' End Road, Accra' from generate_series(1, ${PROPERTIES}) n
            returning id),
          numbered as (select id, row_number() over () as n from addr)
          insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
          select ${c}::uuid, 'L4P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'End court ' || n, ${company.ownerMembershipId}::uuid
            from numbered`.execute(tx);
        await sql`
          insert into units (company_id, property_id, reference, unit_label, bedrooms)
          select p.company_id, p.id, p.reference || '-U' || u, 'Flat ' || u, 2
            from properties p cross join generate_series(1, ${UNITS_PER_PROPERTY}) u where p.company_id = ${c}::uuid and p.reference like 'L4P-%'`.execute(tx);
        await sql`
          insert into contacts (company_id, reference, contact_type, display_name, office_id)
          select ${c}::uuid, 'L4T-' || n, 'person', 'Tenant ' || n, ${company.officeId}::uuid from generate_series(1, ${LEASES}) n`.execute(tx);
        // Leases 1..5,000 end within 90 days of today; the rest end next year or later.
        await sql`
          with u as (select u.id, row_number() over (order by u.reference) as n from units u where u.company_id = ${c}::uuid and u.reference like 'L4P-%')
          insert into leases (company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date,
                              currency_code, rent_amount, rent_frequency, rent_due_day, deposit_amount, notice_period_days, signed_at, created_by)
          select ${c}::uuid, 'L4S-' || u.n, u.id, 'GH', 'fixed_term', 'active', date '2025-06-01',
                 case when u.n <= ${ENDING} then current_date + (u.n % 90)::int else current_date + 120 + (u.n % 600)::int end,
                 'GHS', 3000, 'monthly', 1, 6000, 30, now() - interval '600 days', ${company.ownerMembershipId}::uuid
            from u`.execute(tx);
        await sql`
          insert into lease_parties (company_id, lease_id, contact_id, party_role, is_primary)
          select l.company_id, l.id, t.id, 'tenant', true
            from leases l join contacts t on t.company_id = l.company_id and t.reference = 'L4T-' || substr(l.reference, 5)
           where l.company_id = ${c}::uuid and l.reference like 'L4S-%'`.execute(tx);
        await sql`
          insert into deposits (company_id, lease_id, currency_code, amount, holder_type, status, received_on, protection_deadline, protection_deadline_source)
          select company_id, id, 'GHS', 6000, 'landlord', 'held', date '2025-06-01', date '2025-07-01', 'entered'
            from leases where company_id = ${c}::uuid and reference like 'L4S-%'`.execute(tx);
        await sql`
          insert into inspections (company_id, reference, property_id, unit_id, lease_id, inspection_type, status, scheduled_at, started_at, completed_at,
                                   inspector_membership_id, overall_condition, created_by)
          select l.company_id, 'L4I-' || substr(l.reference, 5) || '-' || kind.k, u.property_id, u.id, l.id, kind.type,
                 case when kind.k = 1 then 'completed' else 'scheduled' end,
                 case when kind.k = 1 then timestamptz '2025-06-01 09:00+00' else now() + make_interval(days => (substr(l.reference, 5)::int % 60)) end,
                 case when kind.k = 1 then timestamptz '2025-06-01 09:00+00' end,
                 case when kind.k = 1 then timestamptz '2025-06-01 11:00+00' end,
                 case when substr(l.reference, 5)::int % 10 = 0 then ${staffMembership}::uuid else ${pm.membershipId}::uuid end,
                 case when kind.k = 1 then 'good' end, ${company.ownerMembershipId}::uuid
            from leases l join units u on u.id = l.unit_id
           cross join (values (1, 'move_in'), (2, 'periodic')) as kind (k, type)
           where l.company_id = ${c}::uuid and l.reference like 'L4S-%'`.execute(tx);
        await sql`
          insert into inspection_items (company_id, inspection_id, area, item, condition_code, sort_order)
          select i.company_id, i.id, 'Room ' || (n / 3 + 1), 'Item ' || n, case when i.status = 'completed' then 'good' end, n
            from inspections i cross join generate_series(1, ${ITEMS}) n
           where i.company_id = ${c}::uuid and i.reference like 'L4I-%'`.execute(tx);
      });
      await sql`vacuum (analyze) properties, units, contacts, leases, lease_parties, deposits, inspections, inspection_items`.execute(admin);
      await settleDatabase(admin);
    } finally {
      await admin.destroy();
    }
  }, 900_000);

  afterAll(async () => {
    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-perf-cleanup');
    try {
      await dropCompanyBulk(admin, company.companyId);
    } finally {
      await admin.destroy();
    }
    await closeWorker();
    await fx.close();
    await t.close();
  }, 900_000);

  it(`writes the renewal reminders in under ${TARGET_JOB_MS / 1000} s and answers requests at p95 under ${TARGET_P95_MS} ms`, async () => {
    const counts = await sql<{ leases: number; inspections: number; items: number }>`
      select (select count(*)::int from leases where company_id = ${company.companyId}::uuid) as leases,
             (select count(*)::int from inspections where company_id = ${company.companyId}::uuid) as inspections,
             (select count(*)::int from inspection_items where company_id = ${company.companyId}::uuid) as items`.execute(fx.db);
    expect(counts.rows[0]).toEqual({ leases: LEASES, inspections: LEASES * 2, items: LEASES * 2 * ITEMS });

    const jobStarted = performance.now();
    const job = await worker.runLeaseRenewals(company.companyId);
    const jobMs = performance.now() - jobStarted;
    expect(job.reminded).toBe(ENDING);
    const rerunStarted = performance.now();
    const rerun = await worker.runLeaseRenewals(company.companyId);
    const rerunMs = performance.now() - rerunStarted;
    expect(rerun.reminded).toBe(0);

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
    const sample = await sql<{ leaseId: string; propertyId: string; unitId: string; moveIn: string; periodic: string }>`
      select l.id as "leaseId", u.property_id as "propertyId", u.id as "unitId",
             (select i.id from inspections i where i.lease_id = l.id and i.inspection_type = 'move_in') as "moveIn",
             (select i.id from inspections i where i.lease_id = l.id and i.inspection_type = 'periodic') as periodic
        from leases l join units u on u.id = l.unit_id
       where l.company_id = ${company.companyId}::uuid and l.reference like 'L4S-%' and substr(l.reference, 5)::int > ${ENDING}
       order by l.reference limit 6`.execute(fx.db);

    for (let run = 0; run < 3; run += 1) {
      const row = sample.rows[run]!;
      await time('inspections owner', () => http('owner').get('/api/v1/inspections?limit=50'));
      await time('inspections pm', () => http('pm').get('/api/v1/inspections?limit=50&filter[status]=scheduled&sort=scheduledAt'));
      await time('inspections staff', () => http('staff').get('/api/v1/inspections?limit=50'));
      await time('completed pm', () => http('pm').get('/api/v1/inspections?limit=50&filter[status]=completed&sort=-completedAt'));
      await time('unit pm', () => http('pm').get(`/api/v1/inspections?filter[unitId]=${row.unitId}`));
      await time('inspection pm', () => http('pm').get(`/api/v1/inspections/${row.moveIn}`));
      await time('deposit pm', () => http('pm').get(`/api/v1/leases/${row.leaseId}/deposit`));
      await time('close-check pm', () => http('pm').get(`/api/v1/leases/${row.leaseId}/close-check`));
      await time('lease pm', () => http('pm').get(`/api/v1/leases/${row.leaseId}`));
      await time('renewals pm', () => http('pm').get('/api/v1/leases?limit=50&filter[renewalStatus]=pending_decision&sort=endDate'));
      await time('tasks pm', () => http('owner').get('/api/v1/tasks?view=mine&limit=50'));
    }
    // Writes: a move-out inspection (items copied from the move-in, compared with it), its items saved; notice on a lease.
    for (let run = 3; run < 6; run += 1) {
      const row = sample.rows[run]!;
      const moveOut = await time('schedule pm', () =>
        http('pm').send('post', '/api/v1/inspections', { propertyId: row.propertyId, unitId: row.unitId, leaseId: row.leaseId, inspectionType: 'move_out', scheduledAt: new Date().toISOString() }, 201));
      expect(moveOut.body.items).toHaveLength(ITEMS);
      expect(moveOut.body.items[0].moveInCondition).toBe('good');
      const items = moveOut.body.items.map((item: { id: string; area: string; item: string }) => ({ id: item.id, area: item.area, item: item.item, conditionCode: 'fair' }));
      await time('items pm', () => http('pm').send('put', `/api/v1/inspections/${moveOut.body.id}/items`, { items }, 200, moveOut.body.version as number));
      const lease = await http('pm').get(`/api/v1/leases/${row.leaseId}`);
      await time('notice pm', () => http('pm').send('post', `/api/v1/leases/${row.leaseId}/notice`, { givenBy: 'tenant', givenOn: new Date().toISOString().slice(0, 10) }, 200, lease.body.version as number));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(
      `tenancy end: ${LEASES} leases, ${LEASES * 2} inspections, ${LEASES * 2 * ITEMS} items; renewal job ${job.leases} leases, ${job.reminded} reminders ` +
        `(${job.escalated} escalated) in ${jobMs.toFixed(0)} ms, rerun ${rerunMs.toFixed(0)} ms; ${samples.length} requests, ` +
        `median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); max by kind: ${kinds}`,
    );
    expect(jobMs).toBeLessThan(TARGET_JOB_MS);
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 900_000);
});
