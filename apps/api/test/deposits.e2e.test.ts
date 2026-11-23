import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { pdf, sha256Hex } from './support/media-files.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let counter = 0;
const nextPhone = () => `024${String(8300000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/**
 * Phase 7 milestone L4: deposits (LET-06; DP-1; readiness §5.5; P7-D3,
 * P7-D11): registration for the lease's amount, the deposit charge and the
 * receipt that makes the deposit held, protection with its deadline (from a
 * reviewed rule, or entered), deductions with evidence (agreed, disputed,
 * adjudicated, withdrawn) and the return of the rest.
 */
describe('L4: deposits', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Company;
  let other: Company;
  let account: string;
  let usdAccount: string;
  const tokens: Record<string, string> = {};

  const as = (who: string) => {
    const companyId = who === 'otherOwner' ? other.companyId : company.companyId;
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      put: (path: string, body: object, version?: number) => (version === undefined ? auth(t.http.put(path)) : auth(t.http.put(path)).set('If-Match', `"${version}"`)).send(body),
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
      patch: (path: string, version: number, body: object) => auth(t.http.patch(path)).set('If-Match', `"${version}"`).send(body),
    };
  };
  const codes = (res: { body: Body }) => (res.body.errors ?? []).map((e: Body) => `${e.field}:${e.code}`);
  const getLease = async (id: string) => (await as('owner').get(`/api/v1/leases/${id}`).expect(200)).body as Body;
  async function leaseAct(id: string, action: string, body: object = {}) {
    const lease = await getLease(id);
    const res = await as('owner').action(`/api/v1/leases/${id}/${action}`, lease.version, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  const deposit = async (leaseId: string, who = 'owner') => (await as(who).get(`/api/v1/leases/${leaseId}/deposit`).expect(200)).body as Body;

  async function contact(name = `Party ${randomUUID().slice(0, 6)}`) {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function lease(options: { deposit?: string | null; letOnly?: boolean; start?: string; end?: string; activate?: boolean } = {}) {
    const landlord = await contact();
    const tenant = await contact(`Tenant ${randomUUID().slice(0, 6)}`);
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner').post('/api/v1/properties', {
      name: `Deposit Villa ${counter}`, propertyTypeId: typeId, officeId: company.officeId, createWholePropertyUnit: true,
      address: { countryCode: 'GH', addressLine1: `${counter++} Deposit Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
    });
    expect(property.status, JSON.stringify(property.body)).toBe(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: property.body.id, ownerContactId: landlord.id, effectiveFrom: '2020-01-01', ownershipType: 'legal_owner' }).execute();
    let agreementId: string | undefined;
    if (options.letOnly) {
      agreementId = (await fx.db
        .insertInto('managementAgreements')
        .values({ companyId: company.companyId, reference: `MA-L4D-${counter++}`, landlordContactId: landlord.id, propertyId: property.body.id, serviceLevel: 'let_only', status: 'active', currencyCode: 'GHS', feeBasis: 'one_off', feeFixedAmount: '100', startDate: '2026-01-01' })
        .returning('id')
        .executeTakeFirstOrThrow()).id;
    }
    const created = await as('owner').post('/api/v1/leases', {
      unitId, leaseType: 'fixed_term', startDate: options.start ?? '2026-06-01', endDate: options.end ?? '2026-08-31', rent: ghs('3000.00'), rentFrequency: 'monthly', rentDueDay: 1,
      ...(options.deposit === null ? {} : { deposit: ghs(options.deposit ?? '6000.00') }),
      ...(agreementId ? { managementAgreementId: agreementId } : {}),
      parties: [{ contactId: tenant.id, partyRole: 'tenant', isPrimary: true }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await leaseAct(created.body.id, 'send-for-signature');
    if (options.activate ?? true) await leaseAct(created.body.id, 'activate', { signedOn: '2026-05-20' });
    return { id: created.body.id as string, tenantId: tenant.id };
  }

  /** Pays the lease's deposit charge in full. */
  async function payDeposit(leaseId: string, payer: string, on = today()) {
    const charge = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${leaseId}&filter[chargeType]=deposit&filter[dueDate][gte]=2000-01-01`).expect(200)).body.data[0];
    const receipt = await as('owner').post('/api/v1/payments', { payerContactId: payer, leaseId, bankAccountId: account, methodCode: 'bank_transfer', amount: charge.balance.outstanding, receivedOn: on }).expect(201);
    await as('owner').post(`/api/v1/payments/${receipt.body.id}/allocations`, { allocatedOn: on, lines: [{ rentChargeId: charge.id, amount: charge.balance.outstanding }] }).expect(201);
    return { receiptId: receipt.body.id as string, reference: receipt.body.reference as string };
  }

  async function evidence(leaseId: string) {
    const file = pdf();
    const ticket = await as('owner').post('/api/v1/documents/uploads', {
      entityType: 'lease', entityId: leaseId, title: 'Move-out report', documentTypeCode: 'inspection_report', isSigned: false,
      fileName: 'report.pdf', contentType: 'application/pdf', size: file.length, sha256: sha256Hex(file),
    });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    expect((await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file })).status).toBe(200);
    const confirmed = await as('owner').post(`/api/v1/documents/uploads/${ticket.body.id}/confirm`).expect(201);
    await worker.runOnce();
    return confirmed.body.id as string;
  }

  const auditActions = async (entityId: string) =>
    (await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', entityId).orderBy('occurredAt').orderBy('entryNo').execute()).map((row) => row.action);
  const outbox = async (aggregateId: string) =>
    (await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', aggregateId).orderBy('occurredAt').orderBy('entryNo').execute()).map((row) => row.eventType);

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, jobTypes: ['document.scan'] }));
    company = await fx.company();
    other = await fx.company();
    const pm = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const admin = await fx.member(company.companyId, { roleKey: 'office_admin', officeIds: [company.officeId] });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['pm', pm.userId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['admin', admin.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `l4d-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `l4d-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    account = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'Client account', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'GHS' }).returning('id').executeTakeFirstOrThrow()).id;
    usdAccount = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'USD account', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'USD' }).returning('id').executeTakeFirstOrThrow()).id;
    await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false }).expect(200);
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  describe('registration and receipt', () => {
    it('registers the amount the lease names; the deposit charge and its receipt make it held', async () => {
      const { id, tenantId } = await lease();
      const empty = await deposit(id);
      expect(empty).toEqual({ deposit: null, agreed: ghs('6000.00'), protectionRule: { reviewed: false, days: null, required: null, source: null } });
      expect(codes(await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent' }))).toEqual(['holdingAccountId:required']);
      expect(codes(await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: usdAccount }))).toEqual(['holdingAccountId:currency-mismatch']);
      expect(codes(await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: account, receivedOn: today() }))).toEqual(['receivedOn:collected']);
      expect((await as('agent').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: account })).status).toBe(403);
      expect((await as('admin').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: account })).status).toBe(403);

      const registered = await as('pm').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: account, protectionDeadline: '2026-07-01' });
      expect(registered.status, JSON.stringify(registered.body)).toBe(200);
      expect(registered.body.deposit).toMatchObject({
        status: 'expected', amount: ghs('6000.00'), holderType: 'agent', holdingAccount: { id: account }, collected: true, chargeOutstanding: ghs('6000.00'),
        protectionDeadline: '2026-07-01', protectionDeadlineSource: 'entered', receivedOn: null,
      });
      expect(registered.header['etag']).toBe(`"${registered.body.deposit.version}"`);
      expect((await as('pm').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: account })).status).toBe(422);
      const charges = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${id}&filter[chargeType]=deposit&filter[dueDate][gte]=2000-01-01`).expect(200)).body.data;
      expect(charges).toHaveLength(1);
      expect(charges[0]).toMatchObject({ dueDate: '2026-06-01', amount: ghs('6000.00'), status: 'posted', source: 'automation' });

      const paid = await payDeposit(id, tenantId);
      const held = (await deposit(id)).deposit;
      expect(held).toMatchObject({ status: 'held', receivedOn: today(), receivedPayment: { id: paid.receiptId, name: paid.reference }, chargeOutstanding: ghs('0.00'), protectionOverdue: true });
      expect(await auditActions(held.id)).toEqual(['deposit.registered']);
      expect(await outbox(held.id)).toEqual(['deposit.registered']);
    });

    it('records the day received when the agency does not collect (let only), with the deadline of a reviewed rule', async () => {
      // A reviewed protection period for Ghana, for this test only (test files run one at a time).
      await fx.db
        .insertInto('jurisdictionSettings')
        .values({ jurisdictionCode: 'GH', key: 'deposit_protection_deadline_days', value: JSON.stringify(30), effectiveFrom: '2000-01-01', sourceReference: 'Test value only' })
        .execute();
      try {
        await reviewedRule();
      } finally {
        await fx.db.deleteFrom('jurisdictionSettings').where('jurisdictionCode', '=', 'GH').where('key', '=', 'deposit_protection_deadline_days').execute();
      }
    });

    async function reviewedRule() {
      const { id } = await lease({ letOnly: true });
      expect((await deposit(id)).protectionRule).toEqual({ reviewed: true, days: 30, required: null, source: 'Test value only' });
      expect(codes(await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord', protectionDeadline: '2026-07-01' }))).toEqual(['protectionDeadline:set-by-rule']);
      expect(codes(await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord', receivedOn: addDays(today(), 1) }))).toEqual(['receivedOn:future']);
      const res = await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord', receivedOn: '2026-05-25' }).expect(200);
      expect(res.body.deposit).toMatchObject({ status: 'held', collected: false, chargeOutstanding: null, receivedOn: '2026-05-25', protectionDeadline: '2026-06-24', protectionDeadlineSource: 'jurisdiction' });
      expect(await outbox(res.body.deposit.id)).toEqual(['deposit.registered', 'deposit.received']);
      // Nothing to change: the same body is a no-op.
      const again = await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord' }, res.body.deposit.version).expect(200);
      expect(again.body.deposit.version).toBe(res.body.deposit.version);
      expect((await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'other' }, res.body.deposit.version + 5)).status).toBe(412);
    }

    it('raises the charge at activation for a deposit registered while awaiting signature', async () => {
      const { id, tenantId } = await lease({ activate: false });
      await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'protection_scheme' }).expect(200);
      expect((await deposit(id)).deposit.chargeOutstanding).toBeNull();
      await leaseAct(id, 'activate', { signedOn: '2026-05-20' });
      expect((await deposit(id)).deposit.chargeOutstanding).toEqual(ghs('6000.00'));
      await payDeposit(id, tenantId);
      expect((await deposit(id)).deposit.status).toBe('held');
    });

    it('needs a deposit in the lease terms and keeps companies apart', async () => {
      const { id } = await lease({ deposit: null });
      expect((await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord' })).body.detail).toContain('names no deposit');
      expect((await as('otherOwner').get(`/api/v1/leases/${id}/deposit`)).status).toBe(404);
    });
  });

  describe('protection, deductions and return', () => {
    it('protects a held deposit, then settles deductions and returns the rest after the lease ends', async () => {
      const { id, tenantId } = await lease();
      await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: account }).expect(200);
      let current = (await deposit(id)).deposit;
      expect((await as('owner').action(`/api/v1/deposits/${current.id}/protection`, current.version, { schemeName: 'Scheme', schemeReference: 'S-1', protectedOn: today() })).body.detail).toContain('not been received');
      await payDeposit(id, tenantId, '2026-06-02');
      current = (await deposit(id)).deposit;
      expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/protection`, current.version, { schemeName: 'Scheme', schemeReference: 'S-1', protectedOn: '2026-06-01' }))).toEqual(['protectedOn:before-receipt']);
      const protectedRes = await as('owner').action(`/api/v1/deposits/${current.id}/protection`, current.version, { schemeName: 'Rent Control', schemeReference: 'RCD-77', protectedOn: '2026-06-10' });
      expect(protectedRes.status, JSON.stringify(protectedRes.body)).toBe(200);
      expect(protectedRes.body).toMatchObject({ status: 'protected', schemeName: 'Rent Control', schemeReference: 'RCD-77' });
      current = protectedRes.body;
      expect((await as('owner').action(`/api/v1/deposits/${current.id}/protection`, current.version, { schemeName: 'X', schemeReference: 'Y', protectedOn: '2026-06-11' })).status).toBe(422);
      expect((await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord' }, current.version)).body.errors[0].code).toBe('protected');

      // Deductions wait for the end of the tenancy.
      const early = await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, current.version, { reasonCode: 'cleaning', description: 'Oven', amount: ghs('300.00') });
      expect(early.body.detail).toContain('end of the tenancy');
      await leaseAct(id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-01', endsOn: '2026-08-31' });
      current = (await deposit(id)).deposit;
      expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, current.version, { reasonCode: 'nonsense', description: 'X', amount: ghs('1.00') }))).toEqual(['reasonCode:unknown-code']);
      expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, current.version, { reasonCode: 'damage', description: 'Everything', amount: ghs('6000.01') }))).toEqual(['amount.amount:above-deposit']);
      const otherLease = await lease();
      const foreign = await evidence(otherLease.id);
      expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, current.version, { reasonCode: 'damage', description: 'Window', amount: ghs('500.00'), evidenceDocumentId: foreign }))).toEqual(['evidenceDocumentId:not-found']);
      const report = await evidence(id);
      const cleaning = await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, current.version, { reasonCode: 'cleaning', description: 'Oven and carpets', amount: ghs('300.00') });
      expect(cleaning.status, JSON.stringify(cleaning.body)).toBe(201);
      const window = await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, cleaning.body.version, { reasonCode: 'damage', description: 'Broken window', amount: ghs('1000.00'), evidenceDocumentId: report });
      expect(window.status, JSON.stringify(window.body)).toBe(201);
      const [first, second] = window.body.deductions as Body[];
      expect(second).toMatchObject({ status: 'proposed', evidenceDocument: { id: report, name: 'Move-out report' }, amount: ghs('1000.00'), settledAmount: null });

      const decide = (deduction: Body, body: object) => as('owner').patch(`/api/v1/deposits/${current.id}/deductions/${deduction.id}`, deduction.version, body);
      expect(codes(await decide(first!, { action: 'agree', settledAmount: ghs('10.00') }))).toEqual(['settledAmount:not-allowed']);
      expect((await decide(first!, { action: 'adjudicate', settledAmount: ghs('10.00') })).status).toBe(422);
      const attached = await decide(first!, { action: 'attach_evidence', evidenceDocumentId: report });
      expect(attached.status, JSON.stringify(attached.body)).toBe(200);
      const agreed = await decide(attached.body.deductions[0], { action: 'agree' });
      expect(agreed.body.deductions[0]).toMatchObject({ status: 'agreed', settledAmount: ghs('300.00') });
      expect((await decide(agreed.body.deductions[0], { action: 'withdraw' })).status).toBe(422);
      const disputed = await decide(second!, { action: 'dispute' });
      expect(disputed.body.status).toBe('disputed');
      expect(codes(await decide(disputed.body.deductions[1], { action: 'adjudicate', settledAmount: ghs('1200.00') }))).toEqual(['settledAmount.amount:above-claim']);

      // Returning waits for the end of the lease and for every deduction to be settled.
      current = disputed.body;
      expect((await as('owner').action(`/api/v1/deposits/${current.id}/return`, current.version, { returnedOn: today() })).body.detail).toContain('ended');
      await leaseAct(id, 'end', { moveOutDate: '2026-08-31' });
      current = (await deposit(id)).deposit;
      expect(current.status).toBe('disputed');
      expect((await as('owner').action(`/api/v1/deposits/${current.id}/return`, current.version, { returnedOn: today() })).body.detail).toContain('disputed');
      const adjudicated = await decide(current.deductions[1], { action: 'adjudicate', settledAmount: ghs('600.00') });
      expect(adjudicated.body).toMatchObject({ status: 'return_pending', settledDeductions: ghs('900.00'), toReturn: ghs('5100.00') });
      current = adjudicated.body;
      expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/return`, current.version, { returnedOn: addDays(today(), 2) }))).toEqual(['returnedOn:future']);
      const returned = await as('owner').action(`/api/v1/deposits/${current.id}/return`, current.version, { returnedOn: today() });
      expect(returned.status, JSON.stringify(returned.body)).toBe(200);
      expect(returned.body).toMatchObject({ status: 'partially_returned', returnedAmount: ghs('5100.00') });
      expect((await as('owner').action(`/api/v1/deposits/${current.id}/return`, returned.body.version, { returnedOn: today() })).status).toBe(422);
      expect((await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: account }, returned.body.version)).status).toBe(422);
      expect(await auditActions(current.id)).toEqual(expect.arrayContaining([
        'deposit.protected', 'deposit.deduction_proposed', 'deposit.deduction_evidence_attached', 'deposit.deduction_agreed',
        'deposit.deduction_disputed', 'deposit.deduction_adjudicated', 'deposit.returned',
      ]));
      expect(await outbox(current.id)).toEqual(expect.arrayContaining(['deposit.protected', 'deposit.deduction_agreed', 'deposit.deduction_disputed', 'deposit.deduction_adjudicated', 'deposit.returned']));

      // The settled lease closes.
      const check = (await as('owner').get(`/api/v1/leases/${id}/close-check`).expect(200)).body;
      expect(check.conditions.find((c: Body) => c.code === 'deposit')).toMatchObject({ met: true, status: 'partially_returned' });
    });

    it('returns everything without deductions, and nothing when all is deducted', async () => {
      for (const [deduct, status, returned] of [[null, 'returned', '6000.00'], ['6000.00', 'forfeited', '0.00']] as const) {
        const { id, tenantId } = await lease();
        await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: account }).expect(200);
        await payDeposit(id, tenantId, '2026-06-02');
        await leaseAct(id, 'end', { moveOutDate: '2026-08-31' });
        let current = (await deposit(id)).deposit;
        expect(current.status).toBe('return_pending');
        if (deduct) {
          const res = await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, current.version, { reasonCode: 'unpaid_rent', description: 'Rent owed', amount: ghs(deduct) });
          expect(res.status, JSON.stringify(res.body)).toBe(201);
          expect((await as('owner').action(`/api/v1/deposits/${current.id}/return`, res.body.version, { returnedOn: today() })).body.detail).toContain('still proposed');
          const agreed = await as('owner').patch(`/api/v1/deposits/${current.id}/deductions/${res.body.deductions[0].id}`, res.body.deductions[0].version, { action: 'agree' });
          current = agreed.body;
        }
        const done = await as('owner').action(`/api/v1/deposits/${current.id}/return`, current.version, { returnedOn: today() });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        expect(done.body).toMatchObject({ status, returnedAmount: ghs(returned) });
      }
    });
  });
});
