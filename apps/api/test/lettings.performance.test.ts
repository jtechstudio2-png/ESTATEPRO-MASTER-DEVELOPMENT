import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Leases and agreements at scale (readiness report §10: API p95 under
 * 1,000 ms with 20,000 leases in one company). 2,000 properties of 10 units,
 * 20,000 leases (18,000 active, 1,000 ended or closed, 1,000 drafts), each
 * with a primary tenant and the landlord, and 2,000 management agreements
 * (one per property). Requests go through the full API as owner (all) and
 * property manager (office): lease lists and their filters and search, one
 * lease, agreement lists and one agreement, and the writes (draw up, edit,
 * send for signature, cancel).
 */
const PROPERTIES = 2_000;
const UNITS_PER_PROPERTY = 10;
const LEASES = PROPERTIES * UNITS_PER_PROPERTY;
const TARGET_P95_MS = 1_000;

describe('lettings performance (20,000 leases)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    const c = company.companyId;
    const pm = await fx.member(c, { roleKey: 'property_manager', officeIds: [company.officeId] });
    const authTime = Math.floor(Date.now() / 1000);
    for (const [name, userId] of [['owner', company.ownerUserId], ['pm', pm.userId]] as const) {
      await fx.linkIdentity(userId, `l1-perf-${name}-${c}`);
      tokens[name] = await t.idp.token({ sub: `l1-perf-${name}-${c}`, amr: ['pwd', 'mfa'], authTime });
    }
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();

    const admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-l1-perf-seed');
    try {
      // Bulk seed with row triggers off (session_replication_role); the lease rules are covered by SQL suite 19.
      await admin.transaction().execute(async (tx) => {
        await sql`set local session_replication_role = replica`.execute(tx);
        await sql`
          with addr as (
            insert into addresses (company_id, country_code, address_line_1, locality, admin_area_1, formatted)
            select ${c}::uuid, 'GH', n || ' Lease Road', 'Accra', 'Greater Accra', n || ' Lease Road, Accra' from generate_series(1, ${PROPERTIES}) n
            returning id),
          numbered as (select id, row_number() over () as n from addr)
          insert into properties (company_id, reference, property_type_id, office_id, address_id, jurisdiction_code, timezone, name, created_by)
          select ${c}::uuid, 'L1P-' || n, ${type.id}::uuid, ${company.officeId}::uuid, id, 'GH', 'Africa/Accra', 'Lease court ' || n, ${company.ownerMembershipId}::uuid
            from numbered`.execute(tx);
        await sql`
          insert into units (company_id, property_id, reference, unit_label, bedrooms)
          select p.company_id, p.id, p.reference || '-U' || u, 'Flat ' || u, 2
            from properties p cross join generate_series(1, ${UNITS_PER_PROPERTY}) u where p.company_id = ${c}::uuid and p.reference like 'L1P-%'`.execute(tx);
        await sql`
          insert into contacts (company_id, reference, contact_type, display_name, office_id)
          select ${c}::uuid, 'L1T-' || n, 'person', 'Tenant ' || n, ${company.officeId}::uuid from generate_series(1, ${LEASES}) n
          union all
          select ${c}::uuid, 'L1L-' || n, 'person', 'Landlord ' || n, ${company.officeId}::uuid from generate_series(1, ${PROPERTIES}) n`.execute(tx);
        await sql`
          insert into management_agreements (company_id, reference, landlord_contact_id, property_id, service_level, status, currency_code, fee_basis, fee_percent, start_date)
          select p.company_id, 'L1M-' || substr(p.reference, 5), l.id, p.id, 'fully_managed', 'active', 'GHS', 'percent_of_rent_collected', 10, '2024-01-01'
            from properties p join contacts l on l.company_id = p.company_id and l.reference = 'L1L-' || substr(p.reference, 5)
           where p.company_id = ${c}::uuid and p.reference like 'L1P-%'`.execute(tx);
        await sql`
          with u as (select u.id, u.property_id, row_number() over (order by u.reference) as n from units u where u.company_id = ${c}::uuid and u.reference like 'L1P-%')
          insert into leases (company_id, reference, unit_id, management_agreement_id, jurisdiction_code, lease_type, status, start_date, end_date, move_out_date,
                              currency_code, rent_amount, rent_frequency, rent_due_day, signed_at, created_by, created_at, updated_at)
          select ${c}::uuid, 'L1S-' || u.n, u.id, m.id, 'GH', 'fixed_term',
                 case when u.n % 20 = 0 then 'draft' when u.n % 20 = 1 then 'closed' else 'active' end,
                 date '2025-01-01' + (u.n % 365)::int, date '2026-01-01' + (u.n % 730)::int,
                 case when u.n % 20 = 1 then date '2026-01-01' + (u.n % 730)::int end,
                 'GHS', 3000 + (u.n % 50) * 100, 'monthly', 1,
                 case when u.n % 20 = 0 then null else now() - interval '300 days' end, ${company.ownerMembershipId}::uuid,
                 now() - make_interval(days => 300), now() - make_interval(mins => u.n::int)
            from u join management_agreements m on m.company_id = ${c}::uuid and m.property_id = u.property_id`.execute(tx);
        await sql`
          insert into lease_parties (company_id, lease_id, contact_id, party_role, is_primary)
          select l.company_id, l.id, t.id, 'tenant', true
            from leases l join contacts t on t.company_id = l.company_id and t.reference = 'L1T-' || substr(l.reference, 5)
           where l.company_id = ${c}::uuid and l.reference like 'L1S-%'
          union all
          select l.company_id, l.id, m.landlord_contact_id, 'landlord', false
            from leases l join management_agreements m on m.id = l.management_agreement_id
           where l.company_id = ${c}::uuid and l.reference like 'L1S-%'`.execute(tx);
      });
      await sql`vacuum (analyze) properties, units, contacts, management_agreements, leases, lease_parties`.execute(admin);
    } finally {
      await admin.destroy();
    }
  }, 600_000);

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it(`answers lease and agreement requests at p95 under ${TARGET_P95_MS} ms`, async () => {
    const counts = await sql<{ leases: number }>`select count(*)::int as leases from leases where company_id = ${company.companyId}::uuid`.execute(fx.db);
    expect(counts.rows[0]).toEqual({ leases: LEASES });

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
      send: (method: 'post' | 'patch', path: string, body: object, status: number, version?: number) => {
        const req = t.http[method](path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId);
        return (version === undefined ? req : req.set('If-Match', `"${version}"`)).send(body).expect(status);
      },
    });
    const sample = await sql<{ leaseId: string; tenantId: string; propertyId: string; agreementId: string }>`
      select l.id as "leaseId", lp.contact_id as "tenantId", u.property_id as "propertyId", l.management_agreement_id as "agreementId"
        from leases l join units u on u.id = l.unit_id join lease_parties lp on lp.lease_id = l.id and lp.is_primary
       where l.company_id = ${company.companyId}::uuid and l.status = 'active' order by l.reference limit 5`.execute(fx.db);
    const rows = sample.rows;

    for (let run = 0; run < 3; run += 1) {
      const row = rows[run]!;
      await time('list owner', () => http('owner').get('/api/v1/leases?limit=50'));
      await time('list pm', () => http('pm').get('/api/v1/leases?limit=50&filter[status]=active'));
      await time('ending pm', () => http('pm').get('/api/v1/leases?limit=50&filter[endDate][lte]=2026-03-31&sort=endDate'));
      await time('search owner', () => http('owner').get('/api/v1/leases?limit=50&q=Tenant%201234'));
      await time('contact owner', () => http('owner').get(`/api/v1/leases?filter[contactId]=${row.tenantId}`));
      await time('property pm', () => http('pm').get(`/api/v1/leases?filter[propertyId]=${row.propertyId}`));
      await time('lease pm', () => http('pm').get(`/api/v1/leases/${row.leaseId}`));
      await time('agreements owner', () => http('owner').get('/api/v1/management-agreements?limit=50'));
      await time('agreements pm', () => http('pm').get('/api/v1/management-agreements?limit=50&q=Landlord%2017'));
      await time('agreement pm', () => http('pm').get(`/api/v1/management-agreements/${row.agreementId}`));
    }
    // Writes: draw up leases for units whose leases closed, edit, send for signature, cancel.
    const free = await sql<{ unitId: string; tenantId: string; landlordId: string }>`
      select l.unit_id as "unitId", lp.contact_id as "tenantId", m.landlord_contact_id as "landlordId"
        from leases l join lease_parties lp on lp.lease_id = l.id and lp.is_primary join management_agreements m on m.id = l.management_agreement_id
       where l.company_id = ${company.companyId}::uuid and l.status = 'closed' order by l.reference limit 3`.execute(fx.db);
    for (const unit of free.rows) {
      const body = {
        unitId: unit.unitId,
        leaseType: 'fixed_term',
        startDate: '2030-01-01',
        endDate: '2030-12-31',
        rent: { amount: '4000.00', currency: 'GHS' },
        rentFrequency: 'monthly',
        parties: [{ contactId: unit.tenantId, partyRole: 'tenant', isPrimary: true }, { contactId: unit.landlordId, partyRole: 'landlord' }],
      };
      const created = await time('create pm', () => http('pm').send('post', '/api/v1/leases', body, 201));
      const edited = await time('edit pm', () => http('pm').send('patch', `/api/v1/leases/${created.body.id}`, { rent: { amount: '4100.00', currency: 'GHS' } }, 200, created.body.version as number));
      const sent = await time('sign pm', () => http('pm').send('post', `/api/v1/leases/${created.body.id}/send-for-signature`, {}, 200, edited.body.version as number));
      await time('cancel pm', () => http('pm').send('post', `/api/v1/leases/${created.body.id}/cancel`, { reason: 'Performance run' }, 200, sent.body.version as number));
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const kinds = [...byKind.entries()].map(([kind, values]) => `${kind} ${Math.max(...values).toFixed(0)}`).join(', ');
    console.info(
      `lettings: ${counts.rows[0]!.leases} leases, ${samples.length} requests, median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, ` +
        `p95 ${p95.toFixed(0)} ms, slowest ${slowest.ms.toFixed(0)} ms (${slowest.label}); max by kind: ${kinds}`,
    );
    expect(p95).toBeLessThan(TARGET_P95_MS);
  }, 600_000);
});
