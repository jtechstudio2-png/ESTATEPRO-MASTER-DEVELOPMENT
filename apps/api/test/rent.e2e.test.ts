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
const nextPhone = () => `024${String(7600000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Phase 7 milestone L2: lettings settings (ST-2), the rent schedule (P7-D6:
 * pro-rated first period, advance periods at signing, lead time, idempotent),
 * charges (RC-1, RC-2, RC-4), adjustments (RC-3, #1), the lease ledger and
 * ageing (RL-1), rent reviews (RR-1, LET-08), scope, isolation, audit and
 * outbox. The worker runs with a fixed clock, so the dates are the lease's.
 */
describe('L2: rent schedule, charges, adjustments, ledger and rent reviews', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let clock = new Date('2027-03-20T08:00:00Z');
  let company: Company;
  let other: Company;
  let bankAccountId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};

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

  async function contact(name = `Party ${randomUUID().slice(0, 6)}`) {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function place(ownerId: string, officeId = company.officeId) {
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: `Rent Villa ${counter}`,
        propertyTypeId: typeId,
        officeId,
        address: { countryCode: 'GH', addressLine1: `${counter++} Rent Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
        createWholePropertyUnit: true,
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: property.body.id, ownerContactId: ownerId, effectiveFrom: '2020-01-01', ownershipType: 'legal_owner' }).execute();
    return { propertyId: property.body.id as string, unitId };
  }

  const getLease = async (id: string, who = 'owner') => (await as(who).get(`/api/v1/leases/${id}`).expect(200)).body as Body;

  async function leaseAct(id: string, action: string, body: object = {}, expected = 200) {
    const current = await getLease(id);
    const res = await as('owner').action(`/api/v1/leases/${id}/${action}`, current.version, body);
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return res.body as Body;
  }

  /** A lease drawn up, sent for signature and activated (the signed-lease rule is off in this company). */
  async function activeLease(extra: Record<string, unknown> = {}, officeId = company.officeId) {
    const landlord = await contact();
    const tenant = await contact(`Tenant ${randomUUID().slice(0, 6)}`);
    const { unitId, propertyId } = await place(landlord.id, officeId);
    const created = await as('owner').post('/api/v1/leases', {
      unitId,
      leaseType: 'fixed_term',
      startDate: '2027-01-15',
      endDate: '2027-12-31',
      rent: ghs('3000.00'),
      rentFrequency: 'monthly',
      rentDueDay: 1,
      advancePeriods: 1,
      parties: [{ contactId: tenant.id, partyRole: 'tenant', isPrimary: true }],
      ...extra,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await leaseAct(created.body.id, 'send-for-signature');
    await leaseAct(created.body.id, 'activate', { signedOn: today() });
    return { id: created.body.id as string, tenantId: tenant.id, landlordId: landlord.id, propertyId, unitId };
  }

  const charges = async (leaseId: string, who = 'owner', query = '') =>
    (await as(who).get(`/api/v1/rent-charges?filter[leaseId]=${leaseId}&filter[status]=scheduled,posted,waived,cancelled${query}`).expect(200)).body as Body;
  const auditActions = async (entityId: string) =>
    (await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', entityId).orderBy('occurredAt').orderBy('entryNo').execute()).map((row) => row.action);
  const outbox = async (aggregateId: string) =>
    (await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', aggregateId).orderBy('occurredAt').execute()).map((row) => row.eventType);

  /** A cleared receipt allocated to a charge (receipts and allocation are L3; inserted directly here). */
  async function pay(leaseId: string, payerId: string, chargeId: string, amount: string, on: string) {
    const payment = await fx.db
      .insertInto('payments')
      .values({ companyId: company.companyId, reference: `RCP-L2-${counter++}`, payerContactId: payerId, leaseId, bankAccountId, methodCode: 'bank_transfer', currencyCode: 'GHS', amount, receivedOn: on, status: 'pending' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await fx.db.updateTable('payments').set({ status: 'cleared', valueDate: on }).where('id', '=', payment.id).execute();
    await fx.db.insertInto('paymentAllocations').values({ companyId: company.companyId, paymentId: payment.id, rentChargeId: chargeId, amount, allocatedOn: on }).execute();
    return payment.id;
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, now: () => clock, jobTypes: ['rent.schedule', 'rent.post_due'] }));
    company = await fx.company();
    other = await fx.company();
    const officeB = await fx.office(company.companyId, `L2B${counter++}`);
    const pm = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    const pmB = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [officeB.id] });
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    Object.assign(members, { owner: company.ownerMembershipId, pm: pm.membershipId, accountant: accountant.membershipId, officeB: officeB.id });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['pm', pm.userId, company.companyId],
      ['pmB', pmB.userId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['accountant', accountant.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `l2-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `l2-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    bankAccountId = (
      await fx.db
        .insertInto('bankAccounts')
        .values({ companyId: company.companyId, name: 'Client account', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'GHS' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  describe('lettings settings (ST-2)', () => {
    it('start empty, are saved by members with settings.manage, and are audited', async () => {
      expect((await as('pm').get('/api/v1/settings/lettings').expect(200)).body).toEqual({ chargeLeadDays: null, requireSignedLease: true });
      await as('pm').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false }).expect(403);
      const invalid = await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 91, requireSignedLease: false });
      expect(invalid.status).toBe(422);
      const saved = await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: null, requireSignedLease: false }).expect(200);
      expect(saved.body).toEqual({ chargeLeadDays: null, requireSignedLease: false });
      expect((await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: null, requireSignedLease: false }).expect(200)).body).toEqual(saved.body);
      expect(await auditActions(company.companyId)).toContain('settings.lettings_updated');
    });
  });

  describe('the rent schedule (P7-D6)', () => {
    let lease: Awaited<ReturnType<typeof activeLease>>;

    it('charges the pro-rated first period and the advance period at activation, even with no lead time', async () => {
      lease = await activeLease();
      const record = await getLease(lease.id);
      expect(record).toMatchObject({ rentScheduleFrom: '2027-01-15', currentRent: ghs('3000.00') });
      const list = await charges(lease.id);
      expect(list.data.map((c: Body) => [c.periodStart, c.periodEnd, c.dueDate, c.amount.amount, c.status, c.source])).toEqual([
        ['2027-01-15', '2027-01-31', '2027-01-15', '1645.16', 'posted', 'schedule'],
        ['2027-02-01', '2027-02-28', '2027-01-15', '3000.00', 'posted', 'schedule'],
      ]);
      expect(list.totals).toEqual([{ currency: 'GHS', count: 2, total: ghs('4645.16'), outstanding: ghs('4645.16') }]);
      expect(await auditActions(list.data[0].id)).toEqual(['rent_charge.posted']);
      expect(await outbox(list.data[0].id)).toEqual(['rent_charge.posted']);
      // Idle without a lead time (W7-D7).
      expect(await worker.runRentSchedule(company.companyId)).toEqual({ leases: 0, posted: 0 });
    });

    it('creates each later charge the lead time before it is due, once', async () => {
      await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false }).expect(200);
      clock = new Date('2027-03-20T08:00:00Z');
      const first = await worker.runRentSchedule(company.companyId);
      expect(first.posted).toBe(2);
      const again = await worker.runRentSchedule(company.companyId);
      expect(again.posted).toBe(0);
      const list = await charges(lease.id);
      expect(list.data.map((c: Body) => [c.periodStart, c.dueDate, c.amount.amount])).toEqual([
        ['2027-01-15', '2027-01-15', '1645.16'],
        ['2027-02-01', '2027-01-15', '3000.00'],
        ['2027-03-01', '2027-03-01', '3000.00'],
        ['2027-04-01', '2027-04-01', '3000.00'],
      ]);
      // Through the scheduler: the daily job is discovered and run; nothing more is due the same day.
      const tick = await worker.runOnce();
      expect(tick.failed).toBe(0);
      expect((await charges(lease.id)).data).toHaveLength(4);
    });

    it('keeps the ledger in date order with the running balance and ageing', async () => {
      const list = (await charges(lease.id)).data;
      await pay(lease.id, lease.tenantId, list[0].id, '1645.16', '2027-02-01');
      const ledger = (await as('pm').get(`/api/v1/leases/${lease.id}/ledger?asOf=2027-03-20`).expect(200)).body;
      expect(ledger.entries.map((e: Body) => [e.date, e.kind, e.charge?.amount ?? e.paid?.amount, e.balance.amount])).toEqual([
        ['2027-01-15', 'charge', '1645.16', '1645.16'],
        ['2027-01-15', 'charge', '3000.00', '4645.16'],
        ['2027-02-01', 'payment', '1645.16', '3000.00'],
        ['2027-03-01', 'charge', '3000.00', '6000.00'],
      ]);
      expect(ledger.entries[2].paymentReference).toMatch(/^RCP-L2-/);
      expect(ledger.entries[2].payerName).toMatch(/^Tenant /);
      expect(ledger.ageing).toMatchObject({ outstanding: ghs('6000.00'), days1To30: ghs('3000.00'), days61To90: ghs('3000.00'), current: ghs('0.00') });
      expect(ledger.upcoming.map((c: Body) => c.dueDate)).toEqual(['2027-04-01']);
      await as('owner').get(`/api/v1/leases/${lease.id}/ledger?asOf=2027-02-30`).expect(422);
      await as('agent').get(`/api/v1/leases/${lease.id}/ledger`).expect(403);
      await as('pmB').get(`/api/v1/leases/${lease.id}/ledger`).expect(404);
      await as('otherOwner').get(`/api/v1/leases/${lease.id}/ledger`).expect(404);
    });

    it('lists charges per scope with totals per currency', async () => {
      const pm = await charges(lease.id, 'pm');
      expect(pm.data).toHaveLength(4);
      const pmB = await charges(lease.id, 'pmB');
      expect(pmB).toMatchObject({ data: [], totals: [] });
      await as('agent').get('/api/v1/rent-charges').expect(403);
      const march = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${lease.id}&filter[dueDate][gte]=2027-03-01&filter[dueDate][lte]=2027-03-31&filter[currency]=GHS&filter[chargeType]=rent`).expect(200)).body;
      expect(march.data.map((c: Body) => c.dueDate)).toEqual(['2027-03-01']);
      expect(march.totals[0]).toMatchObject({ count: 1, outstanding: ghs('3000.00') });
      const paged = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${lease.id}&limit=3&sort=-dueDate`).expect(200)).body;
      expect(paged.data.map((c: Body) => c.dueDate)).toEqual(['2027-04-01', '2027-03-01', '2027-01-15']);
      const next = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${lease.id}&limit=3&sort=-dueDate&cursor=${paged.page.nextCursor}`).expect(200)).body;
      expect(next.data.map((c: Body) => c.dueDate)).toEqual(['2027-01-15']);
      expect(paged.totals[0].count).toBe(4);
      const one = (await as('pm').get(`/api/v1/rent-charges/${pm.data[0].id}`).expect(200)).body;
      expect(one.balance).toEqual({ total: ghs('1645.16'), adjustments: ghs('0.00'), paid: ghs('1645.16'), outstanding: ghs('0.00') });
      await as('pmB').get(`/api/v1/rent-charges/${pm.data[0].id}`).expect(404);
      await as('otherOwner').get(`/api/v1/rent-charges/${pm.data[0].id}`).expect(404);
    });

    it('adds charges posted now or on their due date', async () => {
      const service = await as('owner').post(`/api/v1/leases/${lease.id}/charges`, {
        chargeType: 'service_charge', description: 'Service charge Q2', periodStart: '2027-04-01', periodEnd: '2027-06-30', dueDate: '2027-04-01', amount: ghs('900.00'), when: 'post',
      });
      expect(service.status, JSON.stringify(service.body)).toBe(201);
      expect(service.body).toMatchObject({ status: 'posted', source: 'manual', amount: ghs('900.00'), tax: ghs('0.00') });
      expect(await outbox(service.body.id)).toEqual(['rent_charge.posted']);
      const duplicate = await as('owner').post(`/api/v1/leases/${lease.id}/charges`, {
        chargeType: 'service_charge', description: 'Again', periodStart: '2027-04-01', periodEnd: '2027-06-30', dueDate: '2027-04-01', amount: ghs('900.00'), when: 'post',
      });
      expect(duplicate.status).toBe(422);
      expect(duplicate.body.errors[0]).toMatchObject({ field: 'periodStart', code: 'duplicate' });
      const wrong = await as('owner').post(`/api/v1/leases/${lease.id}/charges`, { chargeType: 'fee', description: 'Keys', dueDate: '2027-04-01', amount: { amount: '10.00', currency: 'AED' }, when: 'post' });
      expect(wrong.body.errors.map((e: Body) => e.code)).toContain('currency-mismatch');
      const past = await as('owner').post(`/api/v1/leases/${lease.id}/charges`, { chargeType: 'fee', description: 'Keys', dueDate: '2020-01-01', amount: ghs('10.00'), when: 'schedule' });
      expect(past.body.errors.map((e: Body) => e.code)).toContain('not-future');
      await as('pm').post(`/api/v1/leases/${lease.id}/charges`, { chargeType: 'fee', description: 'Keys', dueDate: '2027-04-01', amount: ghs('10.00'), when: 'post' }).expect(403);
      await as('owner').post(`/api/v1/leases/${lease.id}/charges`, { chargeType: 'rent', description: 'Rent', dueDate: '2027-04-01', amount: ghs('10.00'), when: 'post' }).expect(422);

      const scheduled = await as('accountant').post(`/api/v1/leases/${lease.id}/charges`, { chargeType: 'utility', description: 'Water May', dueDate: '2099-05-10', amount: ghs('120.00'), when: 'schedule' });
      expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
      expect(scheduled.body).toMatchObject({ status: 'scheduled', postedAt: null, balance: { outstanding: ghs('0.00') } });
      clock = new Date('2099-05-10T09:00:00Z');
      expect(await worker.runRentPostDue(company.companyId)).toMatchObject({ charges: 1 });
      const posted = (await as('owner').get(`/api/v1/rent-charges/${scheduled.body.id}`).expect(200)).body;
      expect(posted).toMatchObject({ status: 'posted', balance: { outstanding: ghs('120.00') } });
      expect(await auditActions(scheduled.body.id)).toEqual(['rent_charge.created', 'rent_charge.posted']);
      const cancelled = await as('owner').action(`/api/v1/rent-charges/${posted.id}/cancel`, posted.version).expect(200);
      expect(cancelled.body.status).toBe('cancelled');
      clock = new Date('2027-03-20T08:00:00Z');
    });

    it('computes tax from the code\'s components', async () => {
      const code = await fx.db.insertInto('taxCodes').values({ companyId: company.companyId, jurisdictionCode: 'GH', code: `l2_${counter++}`, name: 'Levy' }).returning('id').executeTakeFirstOrThrow();
      await fx.db.insertInto('taxCodeComponents').values({ taxCodeId: code.id, companyId: company.companyId, name: 'Levy', ratePercent: '5', effectiveFrom: '2020-01-01' }).execute();
      const res = await as('owner').post(`/api/v1/leases/${lease.id}/charges`, { chargeType: 'fee', description: 'Admin fee', dueDate: '2027-04-02', amount: ghs('200.00'), taxCodeId: code.id, when: 'post' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ tax: ghs('10.00'), balance: { total: ghs('210.00') } });
      const unknown = await as('owner').post(`/api/v1/leases/${lease.id}/charges`, { chargeType: 'fee', description: 'Admin fee', dueDate: '2027-04-02', amount: ghs('200.00'), taxCodeId: randomUUID(), when: 'post' });
      expect(unknown.body.errors[0]).toMatchObject({ field: 'taxCodeId', code: 'unknown' });
    });

    it('corrects a posted charge only by an approved adjustment, never below what is paid', async () => {
      const list = (await charges(lease.id, 'owner', '&filter[chargeType]=rent')).data as Body[];
      const feb = list.find((c) => c.periodStart === '2027-02-01')!;
      const stub = list.find((c) => c.periodStart === '2027-01-15')!;
      const body = { direction: 'credit', amount: ghs('500.00'), adjustedOn: today(), reason: 'Broken water heater', approvedBy: members['accountant'] };
      const preview = (await as('owner').post(`/api/v1/rent-charges/${feb.id}/adjustments/preview`, body).expect(200)).body;
      expect(preview).toEqual({
        before: { total: ghs('3000.00'), adjustments: ghs('0.00'), paid: ghs('0.00'), outstanding: ghs('3000.00') },
        after: { total: ghs('3000.00'), adjustments: ghs('-500.00'), paid: ghs('0.00'), outstanding: ghs('2500.00') },
      });
      const notApprover = await as('owner').post(`/api/v1/rent-charges/${feb.id}/adjustments`, { ...body, approvedBy: members['pm'] });
      expect(notApprover.body.errors[0]).toMatchObject({ field: 'approvedBy', code: 'not-allowed' });
      const future = await as('owner').post(`/api/v1/rent-charges/${feb.id}/adjustments`, { ...body, adjustedOn: '2999-01-01' });
      expect(future.body.errors[0]).toMatchObject({ field: 'adjustedOn', code: 'future' });
      const belowPaid = await as('owner').post(`/api/v1/rent-charges/${stub.id}/adjustments`, { ...body, amount: ghs('1.00') });
      expect(belowPaid.body.errors[0]).toMatchObject({ code: 'below-paid' });
      const tooMuch = await as('owner').post(`/api/v1/rent-charges/${feb.id}/adjustments`, { ...body, amount: ghs('3000.01') });
      expect(tooMuch.body.errors[0]).toMatchObject({ code: 'below-zero' });
      await as('pm').post(`/api/v1/rent-charges/${feb.id}/adjustments`, body).expect(403);

      const done = await as('owner').post(`/api/v1/rent-charges/${feb.id}/adjustments`, body).expect(201);
      expect(done.body.adjustment).toMatchObject({ amount: ghs('-500.00'), reason: 'Broken water heater', approvedBy: { id: members['accountant'] } });
      expect(done.body.charge.balance.outstanding).toEqual(ghs('2500.00'));
      const debit = await as('accountant').post(`/api/v1/rent-charges/${feb.id}/adjustments`, { ...body, direction: 'debit', amount: ghs('100.00'), reason: 'Correction' }).expect(201);
      expect(debit.body.charge.balance).toMatchObject({ adjustments: ghs('-400.00'), outstanding: ghs('2600.00') });
      expect(await auditActions(feb.id)).toEqual(['rent_charge.posted', 'rent_charge.adjusted', 'rent_charge.adjusted']);
      const ledger = (await as('owner').get(`/api/v1/leases/${lease.id}/ledger`).expect(200)).body;
      const adjustments = ledger.entries.filter((e: Body) => e.kind === 'adjustment');
      expect(adjustments.map((e: Body) => e.adjustment.amount)).toEqual(['-500.00', '100.00']);
      expect(adjustments[0].approvedByName).toBeTruthy();
    });

    it('waives or cancels a posted charge only with nothing allocated', async () => {
      const list = (await charges(lease.id, 'owner', '&filter[chargeType]=rent')).data as Body[];
      const stub = list.find((c) => c.periodStart === '2027-01-15')!;
      const march = list.find((c) => c.periodStart === '2027-03-01')!;
      const april = list.find((c) => c.periodStart === '2027-04-01')!;
      const blocked = await as('owner').action(`/api/v1/rent-charges/${stub.id}/waive`, stub.version, { reason: 'Goodwill' });
      expect(blocked.status).toBe(422);
      expect(blocked.body.detail).toContain('Reverse the allocations');
      await as('owner').action(`/api/v1/rent-charges/${march.id}/waive`, march.version + 1, { reason: 'Goodwill' }).expect(412);
      const waived = await as('owner').action(`/api/v1/rent-charges/${march.id}/waive`, march.version, { reason: 'Goodwill gesture' }).expect(200);
      expect(waived.body).toMatchObject({ status: 'waived', waivedReason: 'Goodwill gesture', balance: { outstanding: ghs('0.00') } });
      await as('owner').action(`/api/v1/rent-charges/${march.id}/waive`, waived.body.version, { reason: 'Again' }).expect(422);
      await as('owner').action(`/api/v1/rent-charges/${march.id}/cancel`, waived.body.version).expect(422);
      await as('pm').action(`/api/v1/rent-charges/${april.id}/cancel`, april.version).expect(403);
      expect(await auditActions(march.id)).toEqual(['rent_charge.posted', 'rent_charge.waived']);
      expect(await outbox(march.id)).toEqual(['rent_charge.posted', 'rent_charge.waived']);
      // A waived period is not charged again by the schedule.
      expect((await worker.runRentSchedule(company.companyId)).posted).toBe(0);
      const ledger = (await as('owner').get(`/api/v1/leases/${lease.id}/ledger?asOf=2027-03-20`).expect(200)).body;
      expect(ledger.entries.find((e: Body) => e.rentChargeId === march.id)).toMatchObject({ counted: false, chargeStatus: 'waived' });
    });

    it('reviews the rent: proposal and agreement, applied from a period not yet charged', async () => {
      const scheduled = await as('pm').post(`/api/v1/leases/${lease.id}/rent-reviews`, { reviewDate: '2027-05-01', method: 'negotiated', notes: 'Annual review' });
      expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201);
      expect(scheduled.body).toMatchObject({ status: 'scheduled', current: ghs('3000.00'), proposed: null });
      await as('pm').post(`/api/v1/leases/${lease.id}/rent-reviews`, { reviewDate: '2027-06-01', method: 'market' }).expect(409);
      await as('accountant').post(`/api/v1/leases/${lease.id}/rent-reviews`, { reviewDate: '2027-06-01', method: 'market' }).expect(403);
      const id = scheduled.body.id as string;
      const path = `/api/v1/leases/${lease.id}/rent-reviews/${id}`;
      const proposedRes = await as('pm').patch(path, scheduled.body.version, { action: 'propose', proposed: ghs('3300.00') });
      expect(proposedRes.status, JSON.stringify(proposedRes.body)).toBe(200);
      expect(await outbox(id)).toEqual(['rent_review.scheduled', 'rent_review.proposed']);
      const disputed = await as('pm').patch(path, proposedRes.body.version, { action: 'dispute', notes: 'Tenant asks for less' }).expect(200);
      await as('pm').patch(path, disputed.body.version, { action: 'dispute' }).expect(422);
      const early = await as('pm').patch(path, disputed.body.version, { action: 'agree', agreed: ghs('3200.00'), effectiveFrom: '2027-04-01' });
      expect(early.body.errors[0]).toMatchObject({ field: 'effectiveFrom', code: 'already-charged' });
      await as('pm').action(`${path}/apply`, disputed.body.version).expect(422);
      const agreed = await as('pm').patch(path, disputed.body.version, { action: 'agree', agreed: ghs('3200.00'), effectiveFrom: '2027-06-01' }).expect(200);
      expect(agreed.body).toMatchObject({ status: 'agreed', agreed: ghs('3200.00'), effectiveFrom: '2027-06-01' });
      await as('pm').patch(path, agreed.body.version, { action: 'edit', method: 'market' }).expect(422);
      const applied = await as('pm').action(`${path}/apply`, agreed.body.version).expect(200);
      expect(applied.body.status).toBe('applied');
      expect(await auditActions(id)).toEqual(['rent_review.scheduled', 'rent_review.proposed', 'rent_review.disputed', 'rent_review.agreed', 'rent_review.applied']);

      clock = new Date('2027-06-01T08:00:00Z');
      expect((await worker.runRentSchedule(company.companyId)).posted).toBe(2);
      const rent = (await charges(lease.id, 'owner', '&filter[chargeType]=rent')).data as Body[];
      expect(rent.filter((c) => c.periodStart >= '2027-05-01').map((c) => [c.periodStart, c.amount.amount])).toEqual([
        ['2027-05-01', '3000.00'],
        ['2027-06-01', '3200.00'],
      ]);
      await as('agent').get(`/api/v1/leases/${lease.id}/rent-reviews`).expect(404);
      expect((await as('pm').get(`/api/v1/leases/${lease.id}/rent-reviews`).expect(200)).body.data.map((r: Body) => r.status)).toEqual(['applied']);
    });

    it('writes the "review due" notice once the review date comes', async () => {
      const next = await as('owner').post(`/api/v1/leases/${lease.id}/rent-reviews`, { reviewDate: '2027-09-01', method: 'percentage' }).expect(201);
      expect(next.body.current).toEqual(ghs('3200.00'));
      clock = new Date('2027-08-31T08:00:00Z');
      expect((await worker.runRentPostDue(company.companyId)).reviews).toBe(0);
      clock = new Date('2027-09-01T08:00:00Z');
      expect((await worker.runRentPostDue(company.companyId)).reviews).toBe(1);
      expect((await worker.runRentPostDue(company.companyId)).reviews).toBe(0);
      const reviews = (await as('owner').get(`/api/v1/leases/${lease.id}/rent-reviews`).expect(200)).body.data;
      expect(reviews[0].dueNotifiedAt).not.toBeNull();
      expect(await outbox(next.body.id)).toEqual(['rent_review.scheduled', 'rent_review.due']);
      const cancelled = await as('owner').patch(`/api/v1/leases/${lease.id}/rent-reviews/${next.body.id}`, reviews[0].version, { action: 'cancel' }).expect(200);
      expect(cancelled.body.status).toBe('cancelled');
      await as('owner').patch(`/api/v1/leases/${lease.id}/rent-reviews/${next.body.id}`, cancelled.body.version, { action: 'propose', proposed: ghs('1.00') }).expect(422);
      clock = new Date('2027-03-20T08:00:00Z');
    });
  });

  describe('collection rules, imported leases and isolation', () => {
    it('charges nothing under a let-only agreement and refuses manual charges there', async () => {
      const landlord = await contact();
      const { propertyId, unitId } = await place(landlord.id);
      const agreement = await as('owner').post('/api/v1/management-agreements', { landlordContactId: landlord.id, propertyId, serviceLevel: 'let_only', currencyCode: 'GHS', feeBasis: 'one_off', feeFixed: ghs('500.00'), startDate: '2026-01-01' }).expect(201);
      await fx.db.updateTable('managementAgreements').set({ status: 'active' }).where('id', '=', agreement.body.id).execute();
      const tenant = await contact();
      const created = await as('owner').post('/api/v1/leases', {
        unitId, managementAgreementId: agreement.body.id, leaseType: 'fixed_term', startDate: '2027-02-01', endDate: '2027-07-31', rent: ghs('2000.00'), rentFrequency: 'monthly', rentDueDay: 1, advancePeriods: 2,
        parties: [{ contactId: tenant.id, partyRole: 'tenant', isPrimary: true }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      await leaseAct(created.body.id, 'send-for-signature');
      await leaseAct(created.body.id, 'activate', { signedOn: today() });
      expect((await charges(created.body.id)).data).toEqual([]);
      const refused = await as('owner').post(`/api/v1/leases/${created.body.id}/charges`, { chargeType: 'fee', description: 'Keys', dueDate: '2027-03-01', amount: ghs('10.00'), when: 'post' });
      expect(refused.status).toBe(422);
      expect(refused.body.detail).toContain('let only');
    });

    it('starts the schedule of an imported live lease once, from a chosen date', async () => {
      const landlord = await contact();
      const tenant = await contact();
      const { unitId } = await place(landlord.id);
      const imported = await fx.db
        .insertInto('leases')
        .values({
          companyId: company.companyId, reference: `IMP-L2-${counter++}`, unitId, jurisdictionCode: 'GH', leaseType: 'fixed_term', status: 'active',
          startDate: '2029-12-15', endDate: '2030-12-31', currencyCode: 'GHS', rentAmount: '1000', rentFrequency: 'monthly', rentDueDay: 1, advancePeriods: 1, signedAt: new Date(),
        })
        .returning(['id', 'version'])
        .executeTakeFirstOrThrow();
      await fx.db.insertInto('leaseParties').values({ companyId: company.companyId, leaseId: imported.id, contactId: tenant.id, partyRole: 'tenant', isPrimary: true }).execute();
      expect((await getLease(imported.id)).rentScheduleFrom).toBeNull();
      const before = await as('owner').action(`/api/v1/leases/${imported.id}/rent-schedule`, imported.version, { from: '2029-12-01' });
      expect(before.body.errors[0]).toMatchObject({ field: 'from', code: 'before-start' });
      await as('owner').action(`/api/v1/leases/${imported.id}/rent-schedule`, imported.version + 5, { from: '2030-01-01' }).expect(412);
      await as('pm').action(`/api/v1/leases/${imported.id}/rent-schedule`, imported.version, { from: '2030-01-01' }).expect(403);
      // From 1 January 2030: the pro-rated December period is before it; January, the advance period, is charged at once (due on the start date).
      const started = await as('owner').action(`/api/v1/leases/${imported.id}/rent-schedule`, imported.version, { from: '2030-01-01' }).expect(200);
      expect(started.body.posted).toBe(1);
      const lease = await getLease(imported.id);
      expect(lease.rentScheduleFrom).toBe('2030-01-01');
      await as('owner').action(`/api/v1/leases/${imported.id}/rent-schedule`, lease.version, { from: '2030-02-01' }).expect(422);
      clock = new Date('2030-01-20T08:00:00Z');
      await worker.runRentSchedule(company.companyId);
      expect((await charges(imported.id)).data.map((c: Body) => [c.periodStart, c.dueDate, c.amount.amount])).toEqual([
        ['2030-01-01', '2029-12-15', '1000.00'],
        ['2030-02-01', '2030-02-01', '1000.00'],
      ]);
      expect(await auditActions(imported.id)).toContain('lease.rent_schedule_started');
      clock = new Date('2027-03-20T08:00:00Z');
    });

    it('keeps each company\'s rent apart', async () => {
      const list = (await as('otherOwner').get('/api/v1/rent-charges?filter[status]=scheduled,posted,waived,cancelled').expect(200)).body;
      expect(list).toMatchObject({ data: [], totals: [] });
      // Without a due-date or lease filter the list covers this month (company time zone).
      const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Accra' }).format(new Date()).slice(0, 7);
      expect(list.dueDateWindow.gte).toBe(`${month}-01`);
      expect((await as('owner').get(`/api/v1/rent-charges?filter[dueDate][gte]=2027-01-01`).expect(200)).body.dueDateWindow).toBeNull();
      expect(await worker.runRentSchedule(other.companyId)).toEqual({ leases: 0, posted: 0 });
    });
  });
});
