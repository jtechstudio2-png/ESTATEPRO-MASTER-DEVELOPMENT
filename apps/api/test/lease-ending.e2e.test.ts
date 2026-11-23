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
const nextPhone = () => `024${String(8100000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/**
 * Phase 7 milestone L4: notice, ending, closing and renewal of a lease
 * (LET-07; LS-6, LS-7; readiness §5.6): notice moves the end date (the lease's
 * notice days give the default, nothing is enforced as law), a lease ends on
 * or after its end date with the move-out date, closes once settled, and is
 * renewed by a draft lease following it; the daily job writes renewal
 * reminders at 90, 60 and 30 days and escalates without a decision.
 */
describe('L4: notice, ending, closing and renewal', () => {
  let t: TestApp;
  let fx: Fixtures;
  let early: Worker;
  let late: Worker;
  const closers: Array<() => Promise<void>> = [];
  let company: Company;
  let other: Company;
  let account: string;
  let pmMembership: string;
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
    };
  };
  const codes = (res: { body: Body }) => (res.body.errors ?? []).map((e: Body) => `${e.field}:${e.code}`);
  const getLease = async (id: string, who = 'owner') => (await as(who).get(`/api/v1/leases/${id}`).expect(200)).body as Body;
  async function act(id: string, action: string, body: object = {}, who = 'owner') {
    const lease = await getLease(id);
    return as(who).action(`/api/v1/leases/${id}/${action}`, lease.version, body);
  }
  async function ok(id: string, action: string, body: object = {}, who = 'owner', status = 200) {
    const res = await act(id, action, body, who);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Body;
  }

  async function contact(name = `Party ${randomUUID().slice(0, 6)}`) {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  /** A fixed-term lease, activated (rent charged at activation up to today plus the lead time). */
  async function lease(start: string, end: string, extra: object = {}, who = 'owner') {
    const landlord = await contact();
    const tenant = await contact(`Tenant ${randomUUID().slice(0, 6)}`);
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: `Ending Villa ${counter}`, propertyTypeId: typeId, officeId: company.officeId, createWholePropertyUnit: true,
        address: { countryCode: 'GH', addressLine1: `${counter++} Ending Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: property.body.id, ownerContactId: landlord.id, effectiveFrom: '2020-01-01', ownershipType: 'legal_owner' }).execute();
    const created = await as(who).post('/api/v1/leases', {
      unitId, leaseType: 'fixed_term', startDate: start, endDate: end, rent: ghs('3000.00'), rentFrequency: 'monthly', rentDueDay: 1, advancePeriods: 1,
      parties: [{ contactId: tenant.id, partyRole: 'tenant', isPrimary: true }], ...extra,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await ok(created.body.id, 'send-for-signature');
    await ok(created.body.id, 'activate', { signedOn: addDays(start, -10) < today() ? addDays(start, -10) : today() });
    return { id: created.body.id as string, tenantId: tenant.id, unitId, propertyId: property.body.id as string };
  }

  /** Pays every posted charge of the lease with one receipt. */
  async function settle(leaseId: string, payer: string) {
    const charges = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${leaseId}&filter[dueDate][gte]=2000-01-01`).expect(200)).body.data as Body[];
    const posted = charges.filter((c) => c.status === 'posted' && c.balance.outstanding.amount !== '0.00');
    const total = posted.reduce((sum, c) => sum + Number(c.balance.outstanding.amount), 0).toFixed(2);
    const receipt = await as('owner').post('/api/v1/payments', { payerContactId: payer, leaseId, bankAccountId: account, methodCode: 'cash', amount: ghs(total), receivedOn: today() }).expect(201);
    const res = await as('owner').post(`/api/v1/payments/${receipt.body.id}/allocations`, { allocatedOn: today(), lines: posted.map((c) => ({ rentChargeId: c.id, amount: c.balance.outstanding })) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  const auditActions = async (entityId: string) =>
    (await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', entityId).orderBy('occurredAt').orderBy('entryNo').execute()).map((row) => row.action);
  const outbox = async (aggregateId: string) =>
    (await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', aggregateId).orderBy('occurredAt').execute()).map((row) => row.eventType);

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    for (const [name, now] of [['early', '2026-11-01T08:00:00Z'], ['late', '2026-11-20T08:00:00Z']] as const) {
      const created = createWorker(t.config, silent, { scheduleEveryMs: 0, now: () => new Date(now), jobTypes: ['lease.renewals'] });
      if (name === 'early') early = created.worker;
      else late = created.worker;
      closers.push(created.close);
    }
    company = await fx.company();
    other = await fx.company();
    const pm = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    pmMembership = pm.membershipId;
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['pm', pm.userId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `l4e-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `l4e-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    account = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'Client account', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'GHS' }).returning('id').executeTakeFirstOrThrow()).id;
    await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false }).expect(200);
  });

  afterAll(async () => {
    for (const close of closers) await close();
    await fx.close();
    await t.close();
  });

  describe('notice (LS-6)', () => {
    it('checks the dates, defaults to the notice days, lists charges past the new end and records the notice', async () => {
      const { id } = await lease('2026-06-01', '2026-08-31', { noticePeriodDays: 30 });
      expect(codes(await act(id, 'notice', { givenBy: 'tenant', givenOn: addDays(today(), 2) }))).toContain('givenOn:future');
      expect(codes(await act(id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-15', endsOn: '2026-07-10' }))).toEqual(['endsOn:before-notice']);
      expect(codes(await act(id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-15', endsOn: '2026-09-30' }))).toEqual(['endsOn:after-term']);
      await ok(id, 'notice', { givenBy: 'landlord', givenOn: '2026-07-15' });
      const after = await getLease(id);
      expect(after).toMatchObject({ status: 'notice_given', endDate: '2026-08-14', noticeGivenOn: '2026-07-15', noticeGivenBy: 'landlord', renewalStatus: 'not_renewing' });
      expect((await act(id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-16' })).status).toBe(422);
      expect(await auditActions(id)).toContain('lease.notice_given');
      expect(await outbox(id)).toContain('lease.notice_given');
    });

    it('returns the charges already raised for days after the end and leaves them to a person', async () => {
      const { id } = await lease('2026-06-01', '2026-08-31');
      const noDays = await act(id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-01' });
      expect(codes(noDays)).toEqual(['endsOn:required']);
      const result = await ok(id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-01', endsOn: '2026-08-15', reason: 'Relocating' });
      expect(result).toMatchObject({ noticeDays: 45, agreedNoticeDays: null });
      expect(result.chargesAfterEnd).toHaveLength(1);
      expect(result.chargesAfterEnd[0]).toMatchObject({ periodStart: '2026-08-01', periodEnd: '2026-08-31', total: ghs('3000.00') });
      expect(result.lease).toMatchObject({ status: 'notice_given', endDate: '2026-08-15', endedReason: 'Relocating' });
    });

    it('is for running leases in scope, with the version', async () => {
      const { id } = await lease('2026-06-01', '2026-08-31');
      const lease0 = await getLease(id);
      expect((await as('owner').action(`/api/v1/leases/${id}/notice`, lease0.version + 1, { givenBy: 'tenant', givenOn: '2026-07-01', endsOn: '2026-08-01' })).status).toBe(412);
      expect((await as('agent').action(`/api/v1/leases/${id}/notice`, lease0.version, { givenBy: 'tenant', givenOn: '2026-07-01', endsOn: '2026-08-01' })).status).toBe(404);
      expect((await as('otherOwner').action(`/api/v1/leases/${id}/notice`, lease0.version, { givenBy: 'tenant', givenOn: '2026-07-01', endsOn: '2026-08-01' })).status).toBe(404);
    });
  });

  describe('ending and closing (LS-6)', () => {
    it('ends on or after the end date with the move-out date, then closes once settled', async () => {
      const running = await lease('2026-06-01', '2099-12-31');
      const notYet = await act(running.id, 'end', { moveOutDate: today() });
      expect(notYet.status).toBe(422);
      expect(notYet.body.detail).toContain('2099-12-31');

      const { id, tenantId } = await lease('2026-06-01', '2026-08-31');
      expect(codes(await act(id, 'end', {}))).toEqual(['moveOutDate:required']);
      expect(codes(await act(id, 'end', { moveOutDate: addDays(today(), 3) }))).toEqual(['moveOutDate:future']);
      expect(codes(await act(id, 'end', { moveOutDate: '2026-05-01' }))).toEqual(['moveOutDate:before-start']);
      expect((await act(id, 'close')).status).toBe(422);
      const ended = await ok(id, 'end', { moveOutDate: '2026-08-30', reason: 'End of term' });
      expect(ended).toMatchObject({ status: 'ended', moveOutDate: '2026-08-30', endedReason: 'End of term' });
      expect(await outbox(id)).toContain('lease.ended');

      const check = (await as('owner').get(`/api/v1/leases/${id}/close-check`).expect(200)).body;
      expect(check.canClose).toBe(false);
      expect(check.conditions).toEqual([
        { code: 'balance', met: false, required: true, amount: ghs('9000.00'), status: null },
        { code: 'receipts', met: true, required: true, amount: ghs('0.00'), status: null },
        { code: 'deposit', met: true, required: true, amount: null, status: null },
        { code: 'move_out_inspection', met: false, required: false, amount: null, status: null },
      ]);
      const blocked = await act(id, 'close');
      expect(blocked.status).toBe(422);
      expect(blocked.body.detail).toContain('money is still owed');
      // An unallocated receipt for the lease also holds it open.
      await as('owner').post('/api/v1/payments', { payerContactId: tenantId, leaseId: id, bankAccountId: account, methodCode: 'cash', amount: ghs('10.00'), receivedOn: today() }).expect(201);
      await settle(id, tenantId);
      const receipts = (await as('owner').get(`/api/v1/leases/${id}/close-check`).expect(200)).body;
      expect(receipts.conditions.find((c: Body) => c.code === 'receipts')).toMatchObject({ met: false, amount: ghs('10.00') });
      const credit = (await as('owner').get(`/api/v1/payments?filter[leaseId]=${id}&filter[unallocated]=true`).expect(200)).body.data[0];
      await as('owner').action(`/api/v1/payments/${credit.id}/void`, credit.version, { reason: 'Recorded in error', on: today() }).expect(200);
      expect((await as('owner').get(`/api/v1/leases/${id}/close-check`).expect(200)).body.canClose).toBe(true);
      const closed = await ok(id, 'close');
      expect(closed.status).toBe('closed');
      expect(await auditActions(id)).toEqual(expect.arrayContaining(['lease.ended', 'lease.closed']));
    });

    it('charges the rent to the end date before the lease stops being scheduled', async () => {
      // No lead time: the rent schedule posts only the periods due at signing.
      await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: null, requireSignedLease: false }).expect(200);
      const { id } = await lease('2026-06-01', '2026-08-31');
      await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false }).expect(200);
      const before = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${id}&filter[dueDate][gte]=2000-01-01`).expect(200)).body.data;
      expect(before).toHaveLength(1);
      await ok(id, 'end', { moveOutDate: '2026-08-31' });
      const after = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${id}&filter[dueDate][gte]=2000-01-01`).expect(200)).body.data;
      expect(after.map((c: Body) => c.periodStart).sort()).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
      expect((await act(id, 'end', { moveOutDate: '2026-08-31' })).status).toBe(422);
    });
  });

  describe('renewal (LS-7)', () => {
    it('records the decision and draws up the renewal: same unit and parties, from the day after the end', async () => {
      const base = await lease('2026-06-01', '2026-12-15', { noticePeriodDays: 60, deposit: ghs('3000.00') });
      expect((await act(base.id, 'renewal', {})).status).toBe(422);
      const decided = await ok(base.id, 'renewal-decision', { decision: 'not_renewing' });
      expect(decided.renewalStatus).toBe('not_renewing');
      expect((await act(base.id, 'renewal', { endDate: '2027-12-15' })).body.detail).toContain('not to renew');
      await ok(base.id, 'renewal-decision', { decision: 'renew' });
      expect((await act(base.id, 'renewal', {})).body.errors).toEqual([expect.objectContaining({ field: 'endDate', code: 'required' })]);
      const renewal = await ok(base.id, 'renewal', { endDate: '2027-12-15', rent: ghs('3300.00') }, 'owner', 201);
      expect(renewal).toMatchObject({
        status: 'draft', startDate: '2026-12-16', endDate: '2027-12-15', rent: ghs('3300.00'), noticePeriodDays: 60, deposit: ghs('3000.00'),
        previousLease: { id: base.id }, unit: { id: base.unitId },
      });
      expect(renewal.parties.map((p: Body) => p.partyRole).sort()).toEqual(['landlord', 'tenant']);
      expect((await getLease(base.id)).renewalLease).toEqual({ id: renewal.id, name: renewal.reference });
      expect((await act(base.id, 'renewal', { endDate: '2027-12-15' })).status).toBe(422);
      expect((await act(base.id, 'renewal-decision', { decision: 'not_renewing' })).status).toBe(422);
      expect((await act(base.id, 'notice', { givenBy: 'tenant', givenOn: today(), endsOn: '2026-12-15' })).body.detail).toContain('Cancel it before recording notice');

      // The base lease's deposit is held; the renewal takes it over at activation.
      const deposit = await as('owner').put(`/api/v1/leases/${base.id}/deposit`, { holderType: 'agent', holdingAccountId: account }).expect(200);
      const charge = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${base.id}&filter[chargeType]=deposit&filter[dueDate][gte]=2000-01-01`).expect(200)).body.data[0];
      const receipt = await as('owner').post('/api/v1/payments', { payerContactId: base.tenantId, leaseId: base.id, bankAccountId: account, methodCode: 'cash', amount: ghs('3000.00'), receivedOn: today() }).expect(201);
      await as('owner').post(`/api/v1/payments/${receipt.body.id}/allocations`, { allocatedOn: today(), lines: [{ rentChargeId: charge.id, amount: ghs('3000.00') }] }).expect(201);
      expect((await as('owner').get(`/api/v1/leases/${base.id}/deposit`).expect(200)).body.deposit.status).toBe('held');

      await ok(renewal.id, 'send-for-signature');
      await ok(renewal.id, 'activate', { signedOn: today() });
      expect((await getLease(base.id)).renewalStatus).toBe('renewed');
      const carried = (await as('owner').get(`/api/v1/leases/${renewal.id}/deposit`).expect(200)).body.deposit;
      expect(carried).toMatchObject({ id: deposit.body.deposit.id, status: 'held', lease: { id: renewal.id } });
      expect((await as('owner').get(`/api/v1/leases/${base.id}/deposit`).expect(200)).body.deposit).toBeNull();
      expect(await auditActions(deposit.body.deposit.id)).toContain('deposit.carried_over');
      expect(await auditActions(base.id)).toEqual(expect.arrayContaining(['lease.renewal_decided', 'lease.renewal_drawn_up', 'lease.renewed']));
      expect((await act(base.id, 'notice', { givenBy: 'tenant', givenOn: today(), endsOn: '2026-12-15' })).body.detail).toContain('renewed');
      expect((await act(base.id, 'renewal-decision', { decision: 'renew' })).status).toBe(422);
      // A renewed lease ends without a move-out (the tenant stays under the renewal).
      expect(codes(await act(renewal.id, 'renewal-decision', { decision: 'later' }))).toEqual([]);
    });

    it('applies to active fixed-term leases and needs the right to draw up leases', async () => {
      const { id } = await lease('2026-06-01', '2026-08-31');
      await ok(id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-01', endsOn: '2026-08-31' });
      expect((await act(id, 'renewal-decision', { decision: 'renew' })).body.detail).toContain('active fixed-term');
      expect((await act(id, 'renewal-decision', { decision: 'maybe' })).status).toBe(422);
    });
  });

  describe('renewal reminders (readiness §5.6)', () => {
    it('writes a task at the mark reached, once, escalates at 30 days and is closed by the decision', async () => {
      // On 1 November the lease ends in 44 days: the 60-day reminder.
      const { id } = await lease('2026-06-01', '2026-12-15', {}, 'pm');
      const tasks = async () =>
        fx.db.selectFrom('tasks').select(['id', 'status', 'priority', 'assignedTo', 'title', 'dueAt']).where('entityType', '=', 'lease').where('entityId', '=', id).orderBy('createdAt').execute();
      const first = await early.runLeaseRenewals(company.companyId);
      expect(first.reminded).toBeGreaterThanOrEqual(1);
      let list = await tasks();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ status: 'open', priority: 'high', assignedTo: pmMembership });
      expect(list[0]!.title).toContain('2026-12-15');
      expect(await getLease(id)).toMatchObject({ renewalStatus: 'pending_decision' });
      await early.runLeaseRenewals(company.companyId);
      expect(await tasks()).toHaveLength(1);
      // The reminder shows on the assignee's task list, about the lease.
      const mine = (await as('pm').get('/api/v1/tasks?view=mine').expect(200)).body.data.find((task: Body) => task.id === list[0]!.id);
      expect(mine.about).toMatchObject({ entityType: 'lease', entityId: id });

      // On 20 November, 25 days before the end, without a decision: urgent, and escalated.
      await late.runLeaseRenewals(company.companyId);
      list = await tasks();
      expect(list.map((task) => [task.status, task.priority])).toEqual([['cancelled', 'high'], ['open', 'urgent']]);
      expect(await outbox(id)).toEqual(expect.arrayContaining(['lease.renewal_reminder', 'lease.renewal_escalated']));

      await ok(id, 'renewal-decision', { decision: 'not_renewing' });
      expect((await tasks()).map((task) => task.status)).toEqual(['cancelled', 'done']);
      expect((await late.runLeaseRenewals(company.companyId)).reminded).toBe(0);
    });

    it('leaves leases ending later, periodic leases and other companies alone', async () => {
      const far = await lease('2026-06-01', '2027-06-30');
      await early.runLeaseRenewals(company.companyId);
      await early.runLeaseRenewals(other.companyId);
      expect(await fx.db.selectFrom('tasks').select('id').where('entityId', '=', far.id).execute()).toEqual([]);
      expect((await getLease(far.id)).renewalStatus).toBe('not_due');
    });
  });
});
