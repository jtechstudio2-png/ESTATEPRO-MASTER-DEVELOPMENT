import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { EICAR, sha256Hex } from './support/media-files.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let counter = 0;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });

/** L3 rules answered with field codes: receipts, allocation, reversals, the import, arrears and plans. */
describe('L3: receipt and arrears rules', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Company;
  let token: string;
  let account: string;
  let aedAccount: string;
  let lease: { id: string; tenantId: string };
  let draft: { id: string };
  let charges: Body[];

  const as = () => {
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
      patch: (path: string, version: number, body: object) => auth(t.http.patch(path)).set('If-Match', `"${version}"`).send(body),
    };
  };
  const codes = (res: { body: Body }) => (res.body.errors ?? []).map((e: Body) => `${e.field}:${e.code}`);
  const receipt = (extra: object = {}) => ({ payerContactId: lease.tenantId, leaseId: lease.id, bankAccountId: account, methodCode: 'cash', amount: ghs('100.00'), receivedOn: '2026-08-05', ...extra });

  async function insertLease(status: 'active' | 'draft', start: string, end: string) {
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as()
      .post('/api/v1/properties', {
        name: `Rules Villa ${counter}`, propertyTypeId: typeId, officeId: company.officeId, createWholePropertyUnit: true,
        address: { countryCode: 'GH', addressLine1: `${counter++} Rules Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    const tenant = await as().post('/api/v1/contacts', { contactType: 'person', displayName: `Tenant ${counter}`, primaryPhone: `024${String(8100000 + counter++).padStart(7, '0')}` }).expect(201);
    const row = await fx.db
      .insertInto('leases')
      .values({
        companyId: company.companyId, reference: `RRL-${counter++}`, unitId, jurisdictionCode: 'GH', leaseType: 'fixed_term', status,
        startDate: start, endDate: end, currencyCode: 'GHS', rentAmount: '1000', rentFrequency: 'monthly', rentDueDay: 1, advancePeriods: 0,
        signedAt: status === 'active' ? new Date() : null, rentScheduleFrom: status === 'active' ? start : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await fx.db.insertInto('leaseParties').values({ companyId: company.companyId, leaseId: row.id, contactId: tenant.body.id, partyRole: 'tenant', isPrimary: true }).execute();
    return { id: row.id, tenantId: tenant.body.id as string };
  }

  async function bankFile(content: Buffer, scan = true) {
    const ticket = await as()
      .post('/api/v1/documents/uploads', {
        entityType: 'bank_account', entityId: account, title: 'Statement', documentTypeCode: 'bank_statement', isSigned: false,
        fileName: 'statement.csv', contentType: 'text/csv', size: content.length, sha256: sha256Hex(content),
      })
      .expect(201);
    await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: content });
    const confirmed = await as().post(`/api/v1/documents/uploads/${ticket.body.id}/confirm`).expect(201);
    if (scan) await worker.runOnce();
    return confirmed.body.id as string;
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, now: () => new Date('2026-11-01T08:00:00Z'), jobTypes: ['document.scan'] }));
    company = await fx.company();
    await fx.linkIdentity(company.ownerUserId, `l3r-owner-${company.companyId}`);
    token = await t.idp.token({ sub: `l3r-owner-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    account = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'GHS', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'GHS' }).returning('id').executeTakeFirstOrThrow()).id;
    aedAccount = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'AED', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'AED' }).returning('id').executeTakeFirstOrThrow()).id;
    await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'Closed', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'GHS', isActive: false }).execute();
    lease = await insertLease('active', '2026-06-01', '2026-08-31');
    draft = await insertLease('draft', '2031-01-01', '2031-12-31');
    await t.http.put('/api/v1/settings/lettings').auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId).send({ chargeLeadDays: 14, requireSignedLease: false }).expect(200);
    await worker.runRentSchedule(company.companyId);
    charges = (await as().get(`/api/v1/rent-charges?filter[leaseId]=${lease.id}&sort=dueDate`).expect(200)).body.data;
    await fx.db
      .insertInto('financialPeriods')
      .values({ companyId: company.companyId, periodStart: '2026-07-01', periodEnd: '2026-07-31', status: 'locked', lockedBy: company.ownerMembershipId, lockedAt: new Date() })
      .execute();
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  it('checks a receipt field by field', async () => {
    expect(charges.map((c) => c.dueDate)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
    const closed = (await fx.db.selectFrom('bankAccounts').select('id').where('name', '=', 'Closed').where('companyId', '=', company.companyId).executeTakeFirstOrThrow()).id;
    expect(codes(await as().post('/api/v1/payments', receipt({ bankAccountId: closed, payerContactId: randomUUID(), receivedOn: '2026-02-30', instrumentDate: '2026-02-30' })))).toEqual(
      expect.arrayContaining(['bankAccountId:unknown', 'payerContactId:unknown', 'receivedOn:invalid', 'instrumentDate:invalid']),
    );
    expect(codes(await as().post('/api/v1/payments', receipt({ leaseId: randomUUID() })))).toEqual(['leaseId:unknown']);
    expect(codes(await as().post('/api/v1/payments', receipt({ leaseId: draft.id, payerContactId: (draft as { tenantId: string }).tenantId })))).toContain('leaseId:lease-status');
    expect(codes(await as().post('/api/v1/payments', receipt({ amount: { amount: '1.00', currency: 'AED' } })))).toEqual(['amount.currency:currency-mismatch']);
    expect(codes(await as().post('/api/v1/payments', receipt({ amount: ghs('0.00') })))).toEqual(['amount.amount:positive']);
    // A receipt without a lease, cleared at once.
    const free = await as().post('/api/v1/payments', receipt({ leaseId: null })).expect(201);
    expect(free.body).toMatchObject({ lease: null, status: 'cleared' });
    const view = (await as().get(`/api/v1/payments/${free.body.id}/allocations`).expect(200)).body;
    expect(view.suggestion.map((s: Body) => s.dueDate)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
  });

  it('lists with every filter', async () => {
    const all = (await as().get(`/api/v1/payments?filter[methodCode]=cash&filter[payerContactId]=${lease.tenantId}&filter[bankAccountId]=${account}&filter[currency]=GHS&filter[status]=cleared&filter[receivedOn][gte]=2026-08-01&filter[receivedOn][lte]=2026-08-31&sort=receivedOn&limit=1`).expect(200)).body;
    expect(all.data).toHaveLength(1);
    const all2 = (await as().get(`/api/v1/payments?filter[payerContactId]=${lease.tenantId}&filter[receivedOn][gte]=2026-08-01&filter[receivedOn][lte]=2026-08-31&sort=receivedOn&limit=50`).expect(200)).body;
    if (all.page.nextCursor) {
      const next = (await as().get(`/api/v1/payments?filter[payerContactId]=${lease.tenantId}&filter[receivedOn][gte]=2026-08-01&filter[receivedOn][lte]=2026-08-31&sort=receivedOn&limit=1&cursor=${all.page.nextCursor}`).expect(200)).body;
      expect(next.data[0].id).toBe(all2.data[1].id);
    } else {
      expect(all2.data).toHaveLength(1);
    }
    const cheques = (await as().get('/api/v1/payments?filter[instrumentDate][gte]=2026-01-01&sort=-instrumentDate').expect(200)).body;
    expect(cheques.data).toEqual([]);
    await as().get(`/api/v1/payments/${randomUUID()}`).expect(404);
  });

  it('checks clearing, reversals and allocation dates against the periods', async () => {
    const pending = await as().post('/api/v1/payments', receipt({ methodCode: 'cheque', instrumentNumber: '7', instrumentDate: '2099-01-01' })).expect(201);
    expect(codes(await as().action(`/api/v1/payments/${pending.body.id}/clear`, pending.body.version, { valueDate: '2026-02-30' }))).toEqual(['valueDate:invalid']);
    expect(codes(await as().action(`/api/v1/payments/${pending.body.id}/void`, pending.body.version, { reason: 'Wrong', on: '2026-02-30' }))).toEqual(['on:invalid']);
    const voided = await as().action(`/api/v1/payments/${pending.body.id}/void`, pending.body.version, { reason: 'Entered twice', on: '2026-08-05' }).expect(200);
    expect(voided.body.payment.status).toBe('voided');

    const paid = await as().post('/api/v1/payments', receipt({ amount: ghs('1000.00'), receivedOn: '2026-06-20' })).expect(201);
    expect(codes(await as().action(`/api/v1/payments/${paid.body.id}/refund`, paid.body.version, { reason: 'Back', on: '2026-07-15' }))).toEqual(['on:period-locked']);
    expect(codes(await as().post(`/api/v1/payments/${paid.body.id}/allocations`, { allocatedOn: '2026-02-30', lines: [{ rentChargeId: charges[0]!.id, amount: ghs('1.00') }] }))).toContain('allocatedOn:invalid');
    expect(codes(await as().post(`/api/v1/payments/${paid.body.id}/allocations`, { allocatedOn: '2026-07-10', lines: [{ rentChargeId: charges[0]!.id, amount: ghs('1.00') }] }))).toContain('allocatedOn:period-locked');
    const aed = await as().post('/api/v1/payments', { payerContactId: lease.tenantId, bankAccountId: aedAccount, methodCode: 'cash', amount: { amount: '10.00', currency: 'AED' }, receivedOn: '2026-08-05' }).expect(201);
    expect(codes(await as().post(`/api/v1/payments/${aed.body.id}/allocations`, { allocatedOn: '2026-08-05', lines: [{ rentChargeId: charges[0]!.id, amount: { amount: '1.00', currency: 'AED' } }] }))).toContain('lines[0].rentChargeId:currency-mismatch');

    const done = await as().post(`/api/v1/payments/${paid.body.id}/allocations`, { allocatedOn: '2026-06-20', lines: [{ rentChargeId: charges[0]!.id, amount: ghs('1000.00') }] }).expect(201);
    const allocation = done.body.allocations[0];
    expect(codes(await as().post(`/api/v1/payments/${paid.body.id}/allocations/${allocation.id}/reverse`, { on: '2026-02-30' }))).toEqual(['on:invalid']);
    expect(codes(await as().post(`/api/v1/payments/${paid.body.id}/allocations/${allocation.id}/reverse`, { on: '2026-07-20' }))).toEqual(['on:period-locked']);
    // Waived charges take no allocation.
    const aug = (await as().get(`/api/v1/rent-charges/${charges[2]!.id}`).expect(200)).body;
    await as().action(`/api/v1/rent-charges/${aug.id}/waive`, aug.version, { reason: 'Goodwill' }).expect(200);
    const another = await as().post('/api/v1/payments', receipt({ amount: ghs('50.00') })).expect(201);
    expect(codes(await as().post(`/api/v1/payments/${another.body.id}/allocations`, { allocatedOn: '2026-08-05', lines: [{ rentChargeId: aug.id, amount: ghs('1.00') }] }))).toContain('lines[0].rentChargeId:not-posted');
  });

  it('checks imports: the file, its scan, versions and the payers chosen', async () => {
    expect(codes(await as().post('/api/v1/payments/imports', { bankAccountId: randomUUID(), documentId: randomUUID() }))).toEqual(['bankAccountId:unknown']);
    const pending = await bankFile(Buffer.from('date,amount,currency,reference\n2026-08-20,1.00,GHS,X\n'), false);
    expect(codes(await as().post('/api/v1/payments/imports', { bankAccountId: account, documentId: pending }))).toEqual(['documentId:scan-pending']);
    await worker.runOnce();
    const failed = await bankFile(EICAR);
    expect(codes(await as().post('/api/v1/payments/imports', { bankAccountId: account, documentId: failed }))).toEqual(['documentId:scan-failed']);
    const binary = await bankFile(Buffer.from([0x64, 0x00, 0x01, 0x02]));
    expect(codes(await as().post('/api/v1/payments/imports', { bankAccountId: account, documentId: binary }))).toEqual(['documentId:scan-failed']);

    const checked = await as().post('/api/v1/payments/imports', { bankAccountId: account, documentId: pending }).expect(201);
    const path = `/api/v1/payments/imports/${checked.body.id}`;
    await as().action(`${path}/commit`, checked.body.version + 1, { choices: [] }).expect(412);
    await as().action(`${path}/cancel`, checked.body.version + 1).expect(412);
    expect(codes(await as().action(`${path}/commit`, checked.body.version, { choices: [{ lineNo: 1, payerContactId: randomUUID() }] }))).toEqual(['choices[0].payerContactId:unknown']);
    expect(codes(await as().action(`${path}/commit`, checked.body.version, { choices: [{ lineNo: 1, payerContactId: lease.tenantId, leaseId: randomUUID() }] }))).toEqual(['choices[0].leaseId:unknown']);
    expect(codes(await as().action(`${path}/commit`, checked.body.version, { choices: [{ lineNo: 1, payerContactId: lease.tenantId, leaseId: draft.id }] }))).toEqual(['choices[0].leaseId:lease-mismatch']);
    const committed = await as().action(`${path}/commit`, checked.body.version, { choices: [] }).expect(200);
    expect(committed.body.summary.queued).toBe(1);
    await as().action(`/api/v1/payments/imports/${randomUUID()}/commit`, 1, { choices: [] }).expect(404);
    await as().action(`/api/v1/payments/imports/${randomUUID()}/cancel`, 1).expect(404);
    const queue = (await as().get('/api/v1/payments/import-lines?limit=1').expect(200)).body;
    const line = queue.data[0];
    await as().action(`/api/v1/payments/import-lines/${line.id}/match`, line.version + 1, { payerContactId: lease.tenantId }).expect(412);
    await as().action(`/api/v1/payments/import-lines/${randomUUID()}/match`, 1, { payerContactId: lease.tenantId }).expect(404);
    const matched = await as().action(`/api/v1/payments/import-lines/${line.id}/match`, line.version, { payerContactId: lease.tenantId }).expect(200);
    expect(matched.body).toMatchObject({ status: 'imported', lease: null });
  });

  it('checks arrears, actions and plans field by field', async () => {
    const list = (await as().get(`/api/v1/arrears?filter[leaseId]=${lease.id}&sort=-oldestDueDate`).expect(200)).body;
    expect(list.data).toHaveLength(1);
    await as().get(`/api/v1/leases/${lease.id}/arrears?asOf=2026-02-30`).expect(422);
    await as().get(`/api/v1/leases/${randomUUID()}/arrears`).expect(404);
    await as().get('/api/v1/arrears?asOf=2026-01-01&asOf=2026-01-02').expect(422);
    expect(codes(await as().post(`/api/v1/leases/${lease.id}/arrears-actions`, { actionCode: 'call', actionDate: '2026-02-30' }))).toEqual(['actionDate:invalid']);
    expect((await as().post(`/api/v1/leases/${draft.id}/payment-plans`, { agreedOn: '2026-08-01', instalments: [{ dueDate: '2099-01-01', amount: ghs('1.00') }] })).body.detail).toContain('active, periodic');
    const plans = `/api/v1/leases/${lease.id}/payment-plans`;
    expect(codes(await as().post(plans, { agreedOn: '2026-02-30', instalments: [{ dueDate: '2099-01-01', amount: ghs('1.00') }] }))).toEqual(['agreedOn:invalid']);
    expect(codes(await as().post(plans, { agreedOn: '2999-01-01', instalments: [{ dueDate: '2999-02-01', amount: ghs('1.00') }] }))).toEqual(['agreedOn:future']);
    expect(codes(await as().post(plans, { agreedOn: '2026-08-01', instalments: [{ dueDate: '2026-02-30', amount: ghs('1.00') }] }))).toEqual(['instalments[0].dueDate:order']);
    const agreed = await as().post(plans, { agreedOn: '2026-08-01', instalments: [{ dueDate: '2026-08-15', amount: ghs('500.00') }, { dueDate: '2099-01-01', amount: ghs('500.00') }] }).expect(201);
    const plan = agreed.body.plans[0];
    expect(plan).toMatchObject({ dueToDate: ghs('500.00'), behind: true });
    const completed = await as().patch(`${plans}/${plan.id}`, plan.version, { status: 'completed', closedOn: '2026-08-20' }).expect(200);
    expect(completed.body.plans[0]).toMatchObject({ status: 'completed', closedReason: null, behind: false });
  });
});
