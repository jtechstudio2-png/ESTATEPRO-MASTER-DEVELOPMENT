import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { sha256Hex } from './support/media-files.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let counter = 0;
const nextPhone = () => `024${String(7800000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });

/**
 * Phase 7 milestone L3: receipts (RP-2: record, idempotency, post-dated
 * cheques), allocation (RP-4: oldest-first suggestion, one transaction,
 * reversal), bounce, refund and void (RP-7, #3), the receipts list (RP-1,
 * RP-5, RP-6) and the bank-file import (RP-3, P7-D7): upload as a scanned
 * bank statement, check, commit, queue and match. Scope, isolation, audit and
 * outbox throughout.
 */
describe('L3: receipts, allocation and bank-file import', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Company;
  let other: Company;
  let account: string;
  let aedAccount: string;
  const tokens: Record<string, string> = {};

  const as = (who: string) => {
    const companyId = who === 'otherOwner' ? other.companyId : company.companyId;
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      put: (path: string, body: object) => auth(t.http.put(path)).send(body),
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
      keyed: (path: string, key: string, body: object) => auth(t.http.post(path)).set('Idempotency-Key', key).send(body),
    };
  };
  const codes = (res: { body: Body }) => (res.body.errors ?? []).map((e: Body) => `${e.field}:${e.code}`);

  async function contact(name = `Party ${randomUUID().slice(0, 6)}`) {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function leaseAct(id: string, action: string, body: object = {}) {
    const current = (await as('owner').get(`/api/v1/leases/${id}`).expect(200)).body;
    const res = await as('owner').action(`/api/v1/leases/${id}/${action}`, current.version, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  /** June to August 2026 at GHS 3,000 a month, all three months charged. */
  async function pastLease(officeId = company.officeId) {
    const landlord = await contact();
    const tenant = await contact(`Tenant ${randomUUID().slice(0, 6)}`);
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: `Receipts Villa ${counter}`, propertyTypeId: typeId, officeId, createWholePropertyUnit: true,
        address: { countryCode: 'GH', addressLine1: `${counter++} Receipts Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: property.body.id, ownerContactId: landlord.id, effectiveFrom: '2020-01-01', ownershipType: 'legal_owner' }).execute();
    const created = await as('owner').post('/api/v1/leases', {
      unitId, leaseType: 'fixed_term', startDate: '2026-06-01', endDate: '2026-08-31', rent: ghs('3000.00'), rentFrequency: 'monthly', rentDueDay: 1, advancePeriods: 1,
      parties: [{ contactId: tenant.id, partyRole: 'tenant', isPrimary: true }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await leaseAct(created.body.id, 'send-for-signature');
    await leaseAct(created.body.id, 'activate', { signedOn: '2026-05-20' });
    const reference = (await as('owner').get(`/api/v1/leases/${created.body.id}`).expect(200)).body.reference as string;
    return { id: created.body.id as string, reference, tenantId: tenant.id, landlordId: landlord.id };
  }

  const charges = async (leaseId: string) =>
    ((await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${leaseId}`).expect(200)).body.data as Body[]).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  const auditActions = async (entityId: string) =>
    (await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', entityId).orderBy('occurredAt').orderBy('entryNo').execute()).map((row) => row.action);
  const outbox = async (aggregateId: string) =>
    (await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', aggregateId).orderBy('occurredAt').execute()).map((row) => row.eventType);

  const cash = (lease: { id: string; tenantId: string }, amount: string, receivedOn: string, extra: object = {}) => ({
    payerContactId: lease.tenantId, leaseId: lease.id, bankAccountId: account, methodCode: 'cash', amount: ghs(amount), receivedOn, ...extra,
  });

  /** A bank file uploaded as a statement of the account and scanned. */
  async function bankFile(text: string, who = 'owner', accountId = account) {
    const file = Buffer.from(text, 'utf-8');
    const ticket = await as(who).post('/api/v1/documents/uploads', {
      entityType: 'bank_account', entityId: accountId, title: 'Statement', documentTypeCode: 'bank_statement', isSigned: false,
      fileName: 'statement.csv', contentType: 'text/csv', size: file.length, sha256: sha256Hex(file),
    });
    if (ticket.status !== 201) return { status: ticket.status, body: ticket.body as Body };
    const put = await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: file });
    expect(put.status).toBe(200);
    const confirmed = await as(who).post(`/api/v1/documents/uploads/${ticket.body.id}/confirm`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    await worker.runOnce();
    return { status: 201, body: (await as(who).get(`/api/v1/documents/${confirmed.body.id}`).expect(200)).body as Body };
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, now: () => new Date('2026-11-01T08:00:00Z'), jobTypes: ['document.scan'] }));
    company = await fx.company();
    other = await fx.company();
    const officeB = await fx.office(company.companyId, `L3B${counter++}`);
    const pm = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    const pmB = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [officeB.id] });
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['pm', pm.userId, company.companyId],
      ['pmB', pmB.userId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['accountant', accountant.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `l3-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `l3-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    account = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'Client account GHS', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'GHS' }).returning('id').executeTakeFirstOrThrow()).id;
    aedAccount = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'Client account AED', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'AED' }).returning('id').executeTakeFirstOrThrow()).id;
    await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false }).expect(200);
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  let lease: Awaited<ReturnType<typeof pastLease>>;
  let receipt: Body;

  describe('receipts (RP-2)', () => {
    it('records a receipt once, cleared, with the checks of RP-2', async () => {
      lease = await pastLease();
      // The lead time is set, so activation charged every period due by then (the lease is in the past).
      expect((await worker.runRentSchedule(company.companyId)).posted).toBe(0);
      expect((await charges(lease.id)).map((c) => c.dueDate)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);

      const bad = await as('owner').post('/api/v1/payments', { ...cash(lease, '1.001', '2999-01-01'), methodCode: 'nonsense', instrumentNumber: '12' });
      expect(codes(bad)).toEqual(expect.arrayContaining(['receivedOn:future', 'methodCode:unknown-code', 'instrumentNumber:not-a-cheque', 'amount.amount:precision']));
      const cheque = await as('owner').post('/api/v1/payments', { ...cash(lease, '10.00', '2026-08-05'), methodCode: 'cheque' });
      expect(codes(cheque)).toContain('instrumentNumber:required');
      const stranger = await contact();
      expect(codes(await as('owner').post('/api/v1/payments', { ...cash(lease, '10.00', '2026-08-05'), payerContactId: stranger.id }))).toContain('payerContactId:not-a-party');
      expect(codes(await as('owner').post('/api/v1/payments', { ...cash(lease, '10.00', '2026-08-05'), bankAccountId: aedAccount, amount: { amount: '10.00', currency: 'AED' } }))).toContain('bankAccountId:currency-mismatch');
      await as('pm').post('/api/v1/payments', cash(lease, '10.00', '2026-08-05')).expect(403);

      const key = `rcp-${randomUUID()}`;
      const first = await as('accountant').keyed('/api/v1/payments', key, cash(lease, '6000.00', '2026-08-05', { notes: 'Paid at the office' }));
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body).toMatchObject({ status: 'cleared', valueDate: '2026-08-05', amount: ghs('6000.00'), unallocated: ghs('6000.00'), allocated: ghs('0.00'), imported: false });
      expect(first.body.reference).toMatch(/^RCT-/);
      const again = await as('accountant').keyed('/api/v1/payments', key, cash(lease, '6000.00', '2026-08-05', { notes: 'Paid at the office' }));
      expect(again.body.id).toBe(first.body.id);
      receipt = first.body;
      expect(await auditActions(receipt.id)).toEqual(['payment.recorded']);
      expect(await outbox(receipt.id)).toEqual(['payment.received']);
    });

    it('lists receipts per scope: this month by default, all-time with a lease or unallocated filter', async () => {
      const month = (await as('owner').get('/api/v1/payments').expect(200)).body;
      expect(month.receivedOnWindow).not.toBeNull();
      expect(month.data.find((p: Body) => p.id === receipt.id)).toBeUndefined();
      const byLease = (await as('pm').get(`/api/v1/payments?filter[leaseId]=${lease.id}`).expect(200)).body;
      expect(byLease.data.map((p: Body) => p.id)).toEqual([receipt.id]);
      expect(byLease.receivedOnWindow).toBeNull();
      const unallocated = (await as('owner').get('/api/v1/payments?filter[unallocated]=true&sort=receivedOn').expect(200)).body;
      expect(unallocated.data.map((p: Body) => p.id)).toContain(receipt.id);
      expect((await as('pmB').get(`/api/v1/payments?filter[leaseId]=${lease.id}`).expect(200)).body.data).toEqual([]);
      await as('pmB').get(`/api/v1/payments/${receipt.id}`).expect(404);
      await as('agent').get('/api/v1/payments').expect(403);
      await as('otherOwner').get(`/api/v1/payments/${receipt.id}`).expect(404);
    });
  });

  describe('allocation (RP-4, P7-D8)', () => {
    it('suggests oldest first, allocates in one transaction, and checks every line', async () => {
      const view = (await as('pm').get(`/api/v1/payments/${receipt.id}/allocations`).expect(200)).body;
      expect(view.suggestion.map((s: Body) => [s.dueDate, s.outstanding.amount, s.suggested.amount])).toEqual([
        ['2026-06-01', '3000.00', '3000.00'],
        ['2026-07-01', '3000.00', '3000.00'],
        ['2026-08-01', '3000.00', '0.00'],
      ]);
      expect(view.allocations).toEqual([]);
      const [jun, jul, aug] = await charges(lease.id);
      const tooMuch = await as('owner').post(`/api/v1/payments/${receipt.id}/allocations`, { allocatedOn: '2026-08-05', lines: [{ rentChargeId: jun!.id, amount: ghs('3000.01') }] });
      expect(codes(tooMuch)).toContain('lines[0].amount:above-outstanding');
      const over = await as('owner').post(`/api/v1/payments/${receipt.id}/allocations`, {
        allocatedOn: '2026-08-05', lines: [{ rentChargeId: jun!.id, amount: ghs('3000.00') }, { rentChargeId: jul!.id, amount: ghs('3000.00') }, { rentChargeId: aug!.id, amount: ghs('1.00') }],
      });
      expect(codes(over)).toEqual(['lines:above-unallocated']);
      const twice = await as('owner').post(`/api/v1/payments/${receipt.id}/allocations`, { allocatedOn: '2026-08-05', lines: [{ rentChargeId: jun!.id, amount: ghs('1.00') }, { rentChargeId: jun!.id, amount: ghs('1.00') }] });
      expect(codes(twice)).toContain('lines[1].rentChargeId:duplicate');
      expect(codes(await as('owner').post(`/api/v1/payments/${receipt.id}/allocations`, { allocatedOn: '2999-01-01', lines: [{ rentChargeId: jun!.id, amount: ghs('1.00') }] }))).toContain('allocatedOn:future');
      expect(codes(await as('owner').post(`/api/v1/payments/${receipt.id}/allocations`, { allocatedOn: '2026-08-05', lines: [{ rentChargeId: randomUUID(), amount: ghs('1.00') }] }))).toContain('lines[0].rentChargeId:unknown');
      await as('pm').post(`/api/v1/payments/${receipt.id}/allocations`, { allocatedOn: '2026-08-05', lines: [{ rentChargeId: jun!.id, amount: ghs('1.00') }] }).expect(403);

      const done = await as('accountant').post(`/api/v1/payments/${receipt.id}/allocations`, {
        allocatedOn: '2026-08-05', lines: [{ rentChargeId: jun!.id, amount: ghs('3000.00') }, { rentChargeId: jul!.id, amount: ghs('3000.00') }],
      });
      expect(done.status, JSON.stringify(done.body)).toBe(201);
      expect(done.body.payment.unallocated).toEqual(ghs('0.00'));
      expect(done.body.allocations.map((a: Body) => a.amount.amount)).toEqual(['3000.00', '3000.00']);
      expect(done.body.suggestion.map((s: Body) => s.dueDate)).toEqual(['2026-08-01']);
      expect((await charges(lease.id)).map((c) => c.balance.outstanding.amount)).toEqual(['0.00', '0.00', '3000.00']);
      expect(await outbox(receipt.id)).toEqual(['payment.received', 'payment.allocated']);
    });

    it('reverses one allocation, once', async () => {
      const view = (await as('owner').get(`/api/v1/payments/${receipt.id}/allocations`).expect(200)).body;
      const jul = view.allocations[1];
      expect(codes(await as('owner').post(`/api/v1/payments/${receipt.id}/allocations/${jul.id}/reverse`, { on: '2026-08-01' }))).toContain('on:out-of-range');
      const reversed = await as('owner').post(`/api/v1/payments/${receipt.id}/allocations/${jul.id}/reverse`, { on: '2026-08-10' }).expect(200);
      expect(reversed.body.payment.unallocated).toEqual(ghs('3000.00'));
      expect(reversed.body.allocations.map((a: Body) => [a.amount.amount, a.reversed])).toEqual([['3000.00', false], ['3000.00', true], ['-3000.00', false]]);
      expect((await as('owner').post(`/api/v1/payments/${receipt.id}/allocations/${jul.id}/reverse`, { on: '2026-08-10' })).body.detail).toContain('reversed already');
      expect((await as('owner').post(`/api/v1/payments/${receipt.id}/allocations/${reversed.body.allocations[2].id}/reverse`, { on: '2026-08-10' })).body.detail).toContain('is a reversal');
      await as('owner').post(`/api/v1/payments/${receipt.id}/allocations/${randomUUID()}/reverse`, { on: '2026-08-10' }).expect(404);
      expect((await charges(lease.id)).map((c) => c.balance.outstanding.amount)).toEqual(['0.00', '3000.00', '3000.00']);
    });
  });

  describe('cheques and reversals (RP-6, RP-7)', () => {
    it('keeps a post-dated cheque pending until cleared', async () => {
      const pending = await as('owner').post('/api/v1/payments', { ...cash(lease, '3000.00', '2026-08-06'), methodCode: 'cheque', instrumentNumber: '000123', instrumentDate: '2099-01-01', instrumentBank: 'Test Bank' }).expect(201);
      expect(pending.body).toMatchObject({ status: 'pending', valueDate: null, unallocated: ghs('0.00') });
      const due = (await as('owner').get('/api/v1/payments?filter[status]=pending&filter[instrumentDate][lte]=2099-12-31&sort=instrumentDate').expect(200)).body;
      expect(due.data.map((p: Body) => p.id)).toContain(pending.body.id);
      const [, jul] = await charges(lease.id);
      expect((await as('owner').post(`/api/v1/payments/${pending.body.id}/allocations`, { allocatedOn: '2026-08-06', lines: [{ rentChargeId: jul!.id, amount: ghs('1.00') }] })).body.detail).toContain('once cleared');
      expect((await as('owner').action(`/api/v1/payments/${pending.body.id}/refund`, pending.body.version, { reason: 'Return', on: '2026-08-07' })).body.detail).toContain('Only a cleared');
      expect(codes(await as('owner').action(`/api/v1/payments/${pending.body.id}/clear`, pending.body.version, { valueDate: '2026-08-01' }))).toEqual(['valueDate:out-of-range']);
      await as('owner').action(`/api/v1/payments/${pending.body.id}/clear`, pending.body.version + 1, { valueDate: '2026-08-07' }).expect(412);
      const cleared = await as('owner').action(`/api/v1/payments/${pending.body.id}/clear`, pending.body.version, { valueDate: '2026-08-07' }).expect(200);
      expect(cleared.body).toMatchObject({ status: 'cleared', valueDate: '2026-08-07', unallocated: ghs('3000.00') });
      expect((await as('owner').action(`/api/v1/payments/${pending.body.id}/clear`, cleared.body.version, { valueDate: '2026-08-07' })).body.detail).toContain('Only a pending');
      await as('owner').post(`/api/v1/payments/${pending.body.id}/allocations`, { allocatedOn: '2026-08-07', lines: [{ rentChargeId: jul!.id, amount: ghs('3000.00') }] }).expect(201);

      // The cheque bounces: its allocation is reversed and July is owed again (#3).
      const latest = (await as('owner').get(`/api/v1/payments/${pending.body.id}`).expect(200)).body;
      const bounced = await as('owner').action(`/api/v1/payments/${pending.body.id}/bounce`, latest.version, { reason: 'Returned unpaid: insufficient funds', on: '2026-08-12' }).expect(200);
      expect(bounced.body).toMatchObject({ reversed: 1, payment: { status: 'bounced', statusReason: 'Returned unpaid: insufficient funds', allocated: ghs('0.00') } });
      expect((await charges(lease.id))[1]!.balance.outstanding).toEqual(ghs('3000.00'));
      expect((await as('owner').action(`/api/v1/payments/${pending.body.id}/void`, bounced.body.payment.version, { reason: 'Again', on: '2026-08-12' })).body.detail).toContain('bounced already');
      expect(await auditActions(pending.body.id)).toEqual(['payment.recorded', 'payment.cleared', 'payment.allocated', 'payment.bounced']);
      expect(await outbox(pending.body.id)).toEqual(['payment.recorded', 'payment.received', 'payment.allocated', 'payment.bounced']);
      const ledger = (await as('owner').get(`/api/v1/leases/${lease.id}/ledger?asOf=2026-08-31`).expect(200)).body;
      expect(ledger.entries.filter((e: Body) => e.kind === 'reversal').length).toBe(2);
    });

    it('voids and refunds other receipts; only cheques bounce', async () => {
      const wrong = await as('owner').post('/api/v1/payments', cash(lease, '50.00', '2026-08-08')).expect(201);
      expect((await as('owner').action(`/api/v1/payments/${wrong.body.id}/bounce`, wrong.body.version, { reason: 'Bounced', on: '2026-08-08' })).body.detail).toContain('Only a cheque');
      expect(codes(await as('owner').action(`/api/v1/payments/${wrong.body.id}/void`, wrong.body.version, { reason: 'Entered in error', on: '2026-08-01' }))).toEqual(['on:out-of-range']);
      const voided = await as('owner').action(`/api/v1/payments/${wrong.body.id}/void`, wrong.body.version, { reason: 'Entered in error', on: '2026-08-08' }).expect(200);
      expect(voided.body).toMatchObject({ reversed: 0, payment: { status: 'voided' } });
      const paid = await as('owner').post('/api/v1/payments', cash(lease, '100.00', '2026-08-09')).expect(201);
      const refunded = await as('owner').action(`/api/v1/payments/${paid.body.id}/refund`, paid.body.version, { reason: 'Paid twice', on: '2026-08-10' }).expect(200);
      expect(refunded.body.payment.status).toBe('refunded');
      await as('pm').action(`/api/v1/payments/${paid.body.id}/void`, refunded.body.payment.version, { reason: 'x', on: '2026-08-10' }).expect(403);
    });
  });

  describe('bank-file import (RP-3, P7-D7)', () => {
    let importId: string;
    let fileText: string;

    it('accepts a bank file only as a CSV bank statement of the account', async () => {
      const notCsv = await as('owner').post('/api/v1/documents/uploads', {
        entityType: 'bank_account', entityId: account, title: 'Statement', documentTypeCode: 'bank_statement', isSigned: false,
        fileName: 'statement.pdf', contentType: 'application/pdf', size: 100, sha256: 'a'.repeat(64),
      });
      expect(codes(notCsv)).toEqual(['contentType:unsupported']);
      const leaseCsv = await as('owner').post('/api/v1/documents/uploads', {
        entityType: 'lease', entityId: lease.id, title: 'Statement', documentTypeCode: 'lease', isSigned: false,
        fileName: 'statement.csv', contentType: 'text/csv', size: 100, sha256: 'a'.repeat(64),
      });
      expect(codes(leaseCsv)).toEqual(['contentType:unsupported']);
      expect((await bankFile('date,amount,currency,reference\n', 'pm')).status).toBe(404);
    });

    it('checks the lines: matched by lease reference, unmatched, in error, wrong currency', async () => {
      fileText = [
        'Date,Amount,Currency,Reference,Description,Transaction_ID',
        `2026-08-15,3000.00,GHS,${lease.reference},Rent August,TX-1`,
        '2026-08-15,1200.00,GHS,JAN RENT FLAT2,"Transfer, from ""Kofi""",TX-2',
        '2026-08-16,500.00,GHS,UNKNOWN,,TX-3',
        '2026-02-30,10.00,GHS,BAD,,TX-4',
        '2026-08-16,10.00,AED,FOREIGN,,TX-5',
        '2026-08-16,-5.00,GHS,NEGATIVE,,TX-6',
      ].join('\r\n');
      const uploaded = await bankFile(fileText);
      expect(uploaded.body.scanStatus).toBe('clean');
      await as('pm').post('/api/v1/payments/imports', { bankAccountId: account, documentId: uploaded.body.id }).expect(403);
      const checked = await as('accountant').post('/api/v1/payments/imports', { bankAccountId: account, documentId: uploaded.body.id });
      expect(checked.status, JSON.stringify(checked.body)).toBe(201);
      importId = checked.body.id;
      expect(checked.body.summary).toMatchObject({ lines: 6, matched: 1, unmatched: 2, error: 3, duplicate: 0 });
      expect(checked.body.lines.map((l: Body) => [l.lineNo, l.status, l.errorCode])).toEqual([
        [1, 'matched', null], [2, 'unmatched', null], [3, 'unmatched', null], [4, 'error', 'bad-date'], [5, 'error', 'wrong-currency'], [6, 'error', 'bad-amount'],
      ]);
      expect(checked.body.lines[0]).toMatchObject({ lease: { id: lease.id }, payer: { id: lease.tenantId } });
      expect(checked.body.lines[1].description).toBe('Transfer, from "Kofi"');
      await as('accountant').post('/api/v1/payments/imports', { bankAccountId: account, documentId: uploaded.body.id }).expect(409);
      const broken = await bankFile('date,amount\n2026-08-01,1.00\n');
      expect(codes(await as('owner').post('/api/v1/payments/imports', { bankAccountId: account, documentId: broken.body.id }))).toEqual(['documentId:missing-columns']);
      expect(codes(await as('owner').post('/api/v1/payments/imports', { bankAccountId: aedAccount, documentId: uploaded.body.id }))).toEqual(['documentId:not-found']);
    });

    it('commits: matched and chosen lines become cleared receipts, the rest wait in the queue', async () => {
      const current = (await as('owner').get(`/api/v1/payments/imports/${importId}`).expect(200)).body;
      const payer = await contact('Kofi Payer');
      expect(codes(await as('owner').action(`/api/v1/payments/imports/${importId}/commit`, current.version, { choices: [{ lineNo: 1, payerContactId: payer.id }] }))).toEqual(['choices[0].lineNo:not-unmatched']);
      const committed = await as('owner').action(`/api/v1/payments/imports/${importId}/commit`, current.version, { choices: [{ lineNo: 2, payerContactId: payer.id }] });
      expect(committed.status, JSON.stringify(committed.body)).toBe(200);
      expect(committed.body).toMatchObject({ status: 'committed', summary: { imported: 2, queued: 1, error: 3 } });
      const imported = committed.body.lines.filter((l: Body) => l.status === 'imported');
      const first = (await as('owner').get(`/api/v1/payments/${imported[0].paymentId}`).expect(200)).body;
      expect(first).toMatchObject({ status: 'cleared', imported: true, methodCode: 'bank_transfer', receivedOn: '2026-08-15', lease: { id: lease.id }, unallocated: ghs('3000.00') });
      expect(await outbox(first.id)).toEqual(['payment.received']);
      expect((await as('owner').action(`/api/v1/payments/imports/${importId}/commit`, committed.body.version, { choices: [] })).body.detail).toContain('committed');
      expect(await auditActions(importId)).toEqual(['payment_import.checked', 'payment_import.committed']);
    });

    it('skips lines already imported or queued when the same file comes again, and matches queued lines', async () => {
      const again = await bankFile(fileText);
      const checked = await as('owner').post('/api/v1/payments/imports', { bankAccountId: account, documentId: again.body.id }).expect(201);
      expect(checked.body.summary).toMatchObject({ duplicate: 3, matched: 0, unmatched: 0, error: 3 });
      const cancelled = await as('owner').action(`/api/v1/payments/imports/${checked.body.id}/cancel`, checked.body.version).expect(200);
      expect(cancelled.body.status).toBe('cancelled');
      await as('owner').action(`/api/v1/payments/imports/${checked.body.id}/cancel`, cancelled.body.version).expect(422);

      const queue = (await as('owner').get('/api/v1/payments/import-lines').expect(200)).body;
      expect(queue.data.map((l: Body) => l.reference)).toEqual(['UNKNOWN']);
      const line = queue.data[0];
      expect(codes(await as('owner').action(`/api/v1/payments/import-lines/${line.id}/match`, line.version, { payerContactId: randomUUID() }))).toEqual(['payerContactId:unknown']);
      expect(codes(await as('owner').action(`/api/v1/payments/import-lines/${line.id}/match`, line.version, { payerContactId: (await contact()).id, leaseId: lease.id }))).toEqual(['payerContactId:not-a-party']);
      const matched = await as('owner').action(`/api/v1/payments/import-lines/${line.id}/match`, line.version, { payerContactId: lease.tenantId, leaseId: lease.id }).expect(200);
      expect(matched.body).toMatchObject({ status: 'imported', lease: { id: lease.id } });
      expect((await as('owner').action(`/api/v1/payments/import-lines/${line.id}/match`, matched.body.version, { payerContactId: lease.tenantId })).body.detail).toContain('imported');
      expect((await as('owner').get('/api/v1/payments/import-lines').expect(200)).body.data).toEqual([]);
      await as('owner').get(`/api/v1/payments/imports/${randomUUID()}`).expect(404);
    });

    it('keeps each company\'s receipts and imports apart', async () => {
      await as('otherOwner').get(`/api/v1/payments/imports/${importId}`).expect(404);
      expect((await as('otherOwner').get(`/api/v1/payments?filter[leaseId]=${lease.id}`).expect(200)).body.data).toEqual([]);
      expect((await as('otherOwner').get('/api/v1/payments/import-lines').expect(200)).body.data).toEqual([]);
    });
  });
});
