import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let counter = 0;
const nextPhone = () => `024${String(7900000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });

/**
 * Phase 7 milestone L3: arrears (AR-1, AR-2; P7-D10): balance and ageing as
 * of a date (a past date reproduces its figures), scope and totals per
 * currency, the company's steps (ST-2), actions, payment plans and the daily
 * workflow (once per step and episode, paused by an active plan).
 */
describe('L3: arrears, actions, payment plans and the workflow', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Company;
  let other: Company;
  let officeB: string;
  let account: string;
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
      patch: (path: string, version: number, body: object) => auth(t.http.patch(path)).set('If-Match', `"${version}"`).send(body),
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

  /** June to August 2026 at GHS 3,000 a month, all charged at activation. */
  async function pastLease(officeId: string) {
    const landlord = await contact();
    const tenant = await contact(`Tenant ${randomUUID().slice(0, 6)}`);
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: `Arrears Villa ${counter}`, propertyTypeId: typeId, officeId, createWholePropertyUnit: true,
        address: { countryCode: 'GH', addressLine1: `${counter++} Arrears Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
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
    return { id: created.body.id as string, tenantId: tenant.id };
  }

  const auditActions = async (entityId: string) =>
    (await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', entityId).orderBy('occurredAt').orderBy('entryNo').execute()).map((row) => row.action);
  const outbox = async (aggregateId: string) =>
    (await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', aggregateId).orderBy('occurredAt').execute()).map((row) => row.eventType);

  let leaseA: Awaited<ReturnType<typeof pastLease>>;
  let leaseB: Awaited<ReturnType<typeof pastLease>>;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, now: () => new Date('2026-11-01T08:00:00Z'), jobTypes: ['arrears.workflow'] }));
    company = await fx.company();
    other = await fx.company();
    officeB = (await fx.office(company.companyId, `L3A${counter++}`)).id;
    const pm = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['pm', pm.userId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['accountant', accountant.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `l3a-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `l3a-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    account = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'Client account', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'GHS' }).returning('id').executeTakeFirstOrThrow()).id;
    await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false }).expect(200);
    leaseA = await pastLease(company.officeId);
    leaseB = await pastLease(officeB);
    // June of lease A is paid on 10 July.
    const receipt = await as('owner').post('/api/v1/payments', { payerContactId: leaseA.tenantId, leaseId: leaseA.id, bankAccountId: account, methodCode: 'cash', amount: ghs('3000.00'), receivedOn: '2026-07-10' }).expect(201);
    const june = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${leaseA.id}&filter[dueDate][lte]=2026-06-30`).expect(200)).body.data[0];
    await as('owner').post(`/api/v1/payments/${receipt.body.id}/allocations`, { allocatedOn: '2026-07-10', lines: [{ rentChargeId: june.id, amount: ghs('3000.00') }] }).expect(201);
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  describe('arrears list (AR-1)', () => {
    it('ages each lease as of a date, and a past date reproduces its figures', async () => {
      const aug = (await as('owner').get(`/api/v1/arrears?asOf=2026-08-04&filter[leaseId]=${leaseA.id},${leaseB.id}`).expect(200)).body;
      const a = aug.data.find((row: Body) => row.lease.id === leaseA.id);
      expect(a).toMatchObject({ outstanding: ghs('6000.00'), days1To30: ghs('3000.00'), days31To60: ghs('3000.00'), days61To90: ghs('0.00'), oldestDueDate: '2026-07-01', daysPastDue: 34, planActive: false });
      expect(a.tenant.id).toBe(leaseA.tenantId);
      expect(aug.totals).toEqual([{ currency: 'GHS', leases: 2, outstanding: ghs('15000.00') }]);
      // On 15 June, June was not yet paid (the payment of 10 July is added back).
      const june = (await as('owner').get(`/api/v1/arrears?asOf=2026-06-15&filter[leaseId]=${leaseA.id}`).expect(200)).body;
      expect(june.data[0]).toMatchObject({ outstanding: ghs('3000.00'), days1To30: ghs('3000.00'), oldestDueDate: '2026-06-01', daysPastDue: 14 });
      const may = (await as('owner').get(`/api/v1/arrears?asOf=2026-05-31&filter[leaseId]=${leaseA.id}`).expect(200)).body;
      expect(may.data).toEqual([]);
      await as('owner').get('/api/v1/arrears?asOf=2026-02-30').expect(422);
    });

    it('filters, pages and keeps to scope', async () => {
      const ids = `${leaseA.id},${leaseB.id}`;
      const office = (await as('owner').get(`/api/v1/arrears?asOf=2026-08-04&filter[leaseId]=${ids}&filter[officeId]=${officeB}`).expect(200)).body;
      expect(office.data.map((row: Body) => row.lease.id)).toEqual([leaseB.id]);
      const bucket = (await as('owner').get(`/api/v1/arrears?asOf=2026-08-04&filter[leaseId]=${ids}&filter[bucket]=61-90`).expect(200)).body;
      expect(bucket.data.map((row: Body) => row.lease.id)).toEqual([leaseB.id]);
      const first = (await as('owner').get(`/api/v1/arrears?asOf=2026-08-04&filter[leaseId]=${ids}&limit=1`).expect(200)).body;
      expect(first.data.map((row: Body) => row.lease.id)).toEqual([leaseB.id]);
      const second = (await as('owner').get(`/api/v1/arrears?asOf=2026-08-04&filter[leaseId]=${ids}&limit=1&cursor=${first.page.nextCursor}`).expect(200)).body;
      expect(second.data.map((row: Body) => row.lease.id)).toEqual([leaseA.id]);
      expect(second.page.nextCursor).toBeNull();
      const pm = (await as('pm').get(`/api/v1/arrears?asOf=2026-08-04&filter[leaseId]=${ids}`).expect(200)).body;
      expect(pm.data.map((row: Body) => row.lease.id)).toEqual([leaseA.id]);
      expect((await as('owner').get(`/api/v1/arrears?filter[leaseId]=${ids}&filter[currency]=AED`).expect(200)).body).toMatchObject({ data: [], totals: [] });
      await as('agent').get('/api/v1/arrears').expect(403);
      expect((await as('otherOwner').get(`/api/v1/arrears?filter[leaseId]=${ids}`).expect(200)).body.data).toEqual([]);
    });
  });

  describe('steps, actions and the workflow (AR-2, ST-2)', () => {
    it('saves the company\'s steps in increasing days', async () => {
      const disorder = await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false, arrearsSteps: [{ actionCode: 'formal_notice', afterDays: 14 }, { actionCode: 'reminder', afterDays: 3 }] });
      expect(codes(disorder)).toEqual(['arrearsSteps[1].afterDays:order']);
      const unknown = await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false, arrearsSteps: [{ actionCode: 'nonsense', afterDays: 3 }] });
      expect(codes(unknown)).toEqual(['arrearsSteps[0].actionCode:unknown-code']);
      const steps = [{ actionCode: 'reminder', afterDays: 3 }, { actionCode: 'formal_notice', afterDays: 14 }, { actionCode: 'legal_referral', afterDays: 60 }];
      const saved = await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false, arrearsSteps: steps }).expect(200);
      expect(saved.body.arrearsSteps).toEqual(steps);
      // Leaving the steps out keeps them.
      expect((await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 10, requireSignedLease: false }).expect(200)).body.arrearsSteps).toEqual(steps);
    });

    it('records actions by hand, as a history', async () => {
      const tab = (await as('pm').get(`/api/v1/leases/${leaseA.id}/arrears?asOf=2026-08-04`).expect(200)).body;
      expect(tab).toMatchObject({ outstanding: ghs('6000.00'), daysPastDue: 34, currentStep: { actionCode: 'formal_notice', afterDays: 14 }, actions: [], plans: [] });
      const bad = await as('pm').post(`/api/v1/leases/${leaseA.id}/arrears-actions`, { actionCode: 'nonsense', actionDate: '2999-01-01', nextActionDate: '2026-01-01' });
      expect(codes(bad)).toEqual(expect.arrayContaining(['actionCode:unknown-code', 'actionDate:future', 'nextActionDate:invalid']));
      const done = await as('pm').post(`/api/v1/leases/${leaseA.id}/arrears-actions`, { actionCode: 'call', actionDate: '2026-08-05', notes: 'Promised to pay next week', nextActionDate: '2026-08-12' });
      expect(done.status, JSON.stringify(done.body)).toBe(201);
      expect(done.body.actions[0]).toMatchObject({ actionCode: 'call', source: 'manual', notes: 'Promised to pay next week', nextActionDate: '2026-08-12', arrears: ghs('6000.00') });
      await as('accountant').post(`/api/v1/leases/${leaseB.id}/arrears-actions`, { actionCode: 'call', actionDate: '2026-08-05' }).expect(201);
      await as('agent').post(`/api/v1/leases/${leaseA.id}/arrears-actions`, { actionCode: 'call', actionDate: '2026-08-05' }).expect(403);
      await as('pm').post(`/api/v1/leases/${leaseB.id}/arrears-actions`, { actionCode: 'call', actionDate: '2026-08-05' }).expect(404);
      expect(await outbox(leaseA.id)).toContain('arrears.action_recorded');
      const next = (await as('owner').get(`/api/v1/arrears?asOf=2026-08-20&filter[leaseId]=${leaseA.id}&filter[nextActionDue]=true`).expect(200)).body;
      expect(next.data[0]).toMatchObject({ lastActionCode: 'call', nextActionDate: '2026-08-12' });
    });

    it('agrees and closes payment plans', async () => {
      const path = `/api/v1/leases/${leaseB.id}/payment-plans`;
      const tooMuch = await as('owner').post(path, { agreedOn: '2026-11-01', instalments: [{ dueDate: '2099-01-01', amount: ghs('9000.01') }] });
      expect(codes(tooMuch)).toEqual(['instalments:above-outstanding']);
      const order = await as('owner').post(path, { agreedOn: '2026-11-01', instalments: [{ dueDate: '2099-02-01', amount: ghs('1.00') }, { dueDate: '2099-01-01', amount: ghs('1.00') }] });
      expect(codes(order)).toEqual(['instalments[1].dueDate:order']);
      const agreed = await as('accountant').post(path, { agreedOn: '2026-11-01', instalments: [{ dueDate: '2099-01-01', amount: ghs('4500.00') }, { dueDate: '2099-02-01', amount: ghs('4500.00') }] });
      expect(agreed.status, JSON.stringify(agreed.body)).toBe(201);
      const plan = agreed.body.plans[0];
      expect(plan).toMatchObject({ status: 'active', total: ghs('9000.00'), paidSinceAgreed: ghs('0.00'), dueToDate: ghs('0.00'), behind: false });
      expect(plan.instalments.map((i: Body) => i.dueToDate.amount)).toEqual(['4500.00', '9000.00']);
      expect(agreed.body.actions[0].actionCode).toBe('payment_plan');
      await as('owner').post(path, { agreedOn: '2026-11-01', instalments: [{ dueDate: '2099-01-01', amount: ghs('1.00') }] }).expect(409);
      expect(await auditActions(plan.id)).toEqual(['payment_plan.agreed']);
    });

    it('records the step each lease has reached, once, and pauses for an active plan', async () => {
      const first = await worker.runArrearsWorkflow(company.companyId);
      expect(first.recorded).toBeGreaterThanOrEqual(1);
      const tab = (await as('owner').get(`/api/v1/leases/${leaseA.id}/arrears`).expect(200)).body;
      const automatic = tab.actions.filter((a: Body) => a.source === 'automation');
      // On 1 November the oldest unpaid charge (1 July) is 123 days late: the legal referral step (60 days) is recorded.
      expect(automatic.map((a: Body) => [a.actionCode, a.actionDate, a.nextActionDate, a.arrears.amount])).toEqual([['legal_referral', '2026-11-01', null, '6000.00']]);
      expect(await outbox(leaseA.id)).toContain('arrears.step_due');
      expect((await as('owner').get(`/api/v1/leases/${leaseB.id}/arrears`).expect(200)).body.actions.filter((a: Body) => a.source === 'automation')).toEqual([]);
      const again = await worker.runArrearsWorkflow(company.companyId);
      expect(again.recorded).toBe(0);
      // Through the scheduler: the daily job is discovered and run.
      expect((await worker.runOnce()).failed).toBe(0);
    });

    it('closes a plan with a reason, once', async () => {
      const tab = (await as('owner').get(`/api/v1/leases/${leaseB.id}/arrears`).expect(200)).body;
      const plan = tab.plans[0];
      const path = `/api/v1/leases/${leaseB.id}/payment-plans/${plan.id}`;
      expect(codes(await as('owner').patch(path, plan.version, { status: 'broken', closedOn: '2026-11-01' }))).toEqual(['reason:required']);
      expect(codes(await as('owner').patch(path, plan.version, { status: 'broken', closedOn: '2026-10-01', reason: 'Missed' }))).toEqual(['closedOn:out-of-range']);
      await as('owner').patch(path, plan.version + 1, { status: 'cancelled', closedOn: '2026-11-01', reason: 'Tenant left' }).expect(412);
      const closed = await as('owner').patch(path, plan.version, { status: 'cancelled', closedOn: '2026-11-01', reason: 'Tenant left' }).expect(200);
      expect(closed.body.plans[0]).toMatchObject({ status: 'cancelled', closedOn: '2026-11-01', closedReason: 'Tenant left', behind: false });
      expect((await as('owner').patch(path, closed.body.plans[0].version, { status: 'completed', closedOn: '2026-11-01' })).body.detail).toContain('cancelled');
      await as('owner').patch(`/api/v1/leases/${leaseB.id}/payment-plans/${randomUUID()}`, 1, { status: 'completed', closedOn: '2026-11-01' }).expect(404);
      expect(await auditActions(plan.id)).toEqual(['payment_plan.agreed', 'payment_plan.cancelled']);
    });
  });
});
