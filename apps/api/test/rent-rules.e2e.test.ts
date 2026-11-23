import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let counter = 0;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });
const today = () => new Date().toISOString().slice(0, 10);

/** L2 rules answered with field codes: charges, adjustments, the schedule start and rent reviews. */
describe('L2: rent rules', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let token: string;
  let live: { id: string };
  let draft: { id: string };
  let foreignCode: string;

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

  async function lease(status: 'active' | 'draft', start: string, end: string) {
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as()
      .post('/api/v1/properties', {
        name: `Rules Villa ${counter}`, propertyTypeId: typeId, officeId: company.officeId, createWholePropertyUnit: true,
        address: { countryCode: 'GH', addressLine1: `${counter++} Rules Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    return fx.db
      .insertInto('leases')
      .values({
        companyId: company.companyId, reference: `RUL-${counter++}`, unitId, jurisdictionCode: 'GH', leaseType: 'fixed_term', status,
        startDate: start, endDate: end, currencyCode: 'GHS', rentAmount: '1000', rentFrequency: 'monthly', rentDueDay: 1,
        signedAt: status === 'active' ? new Date() : null, rentScheduleFrom: status === 'active' ? start : null,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    await fx.linkIdentity(company.ownerUserId, `l2r-owner-${company.companyId}`);
    token = await t.idp.token({ sub: `l2r-owner-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    live = await lease('active', '2026-01-01', '2026-12-31');
    draft = await lease('draft', '2031-01-01', '2031-12-31');
    foreignCode = (await fx.db.insertInto('taxCodes').values({ companyId: company.companyId, jurisdictionCode: 'QA', code: `qa_${counter++}`, name: 'Other' }).returning('id').executeTakeFirstOrThrow()).id;
    await fx.db
      .insertInto('financialPeriods')
      .values({ companyId: company.companyId, periodStart: '2026-02-01', periodEnd: '2026-02-28', status: 'locked', lockedBy: company.ownerMembershipId, lockedAt: new Date() })
      .execute();
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it('checks a new charge field by field', async () => {
    expect((await as().post(`/api/v1/leases/${draft.id}/charges`, { chargeType: 'fee', description: 'x', dueDate: '2031-02-01', amount: ghs('1.00'), when: 'post' })).status).toBe(422);
    const bad = await as().post(`/api/v1/leases/${live.id}/charges`, {
      chargeType: 'fee', description: 'Fee', periodStart: '2026-03-31', periodEnd: '2026-03-01', dueDate: '2026-02-30', amount: ghs('0.00'), taxCodeId: foreignCode, when: 'post',
    });
    expect(codes(bad)).toEqual(expect.arrayContaining(['amount.amount:positive', 'dueDate:invalid', 'periodEnd:before-start', 'taxCodeId:jurisdiction']));
    const oneSided = await as().post(`/api/v1/leases/${live.id}/charges`, { chargeType: 'fee', description: 'Fee', periodStart: '2026-03-01', dueDate: '2026-03-01', amount: ghs('1.00'), when: 'post' });
    expect(codes(oneSided)).toContain('periodEnd:required');
    const locked = await as().post(`/api/v1/leases/${live.id}/charges`, { chargeType: 'fee', description: 'Fee', dueDate: '2026-02-10', amount: ghs('1.00'), when: 'post' });
    expect(codes(locked)).toContain('dueDate:period-locked');
    const precision = await as().post(`/api/v1/leases/${live.id}/charges`, { chargeType: 'fee', description: 'Fee', dueDate: '2026-03-01', amount: ghs('1.001'), when: 'post' });
    expect(codes(precision)).toContain('amount.amount:precision');
  });

  it('checks waivers, cancellations and adjustments against the charge\'s state', async () => {
    const posted = (await as().post(`/api/v1/leases/${live.id}/charges`, { chargeType: 'fee', description: 'Fee', dueDate: '2026-03-01', amount: ghs('50.00'), when: 'post' }).expect(201)).body;
    const cancelled = (await as().action(`/api/v1/rent-charges/${posted.id}/cancel`, posted.version).expect(200)).body;
    expect((await as().action(`/api/v1/rent-charges/${posted.id}/cancel`, cancelled.version)).body.detail).toContain('cannot be cancelled');
    const adjust = await as().post(`/api/v1/rent-charges/${posted.id}/adjustments`, { direction: 'credit', amount: ghs('1.00'), adjustedOn: today(), reason: 'Test', approvedBy: company.ownerMembershipId });
    expect(adjust.body.detail).toContain('Only a posted charge');
    await as().post(`/api/v1/rent-charges/${randomUUID()}/adjustments`, { direction: 'credit', amount: ghs('1.00'), adjustedOn: today(), reason: 'Test', approvedBy: company.ownerMembershipId }).expect(404);
    await as().action(`/api/v1/rent-charges/${randomUUID()}/waive`, 1, { reason: 'Test' }).expect(404);
    await as().get(`/api/v1/rent-charges/${randomUUID()}`).expect(404);

    const open = (await as().post(`/api/v1/leases/${live.id}/charges`, { chargeType: 'fee', description: 'Fee 2', dueDate: '2026-03-02', amount: ghs('50.00'), when: 'post' }).expect(201)).body;
    const dates = await as().post(`/api/v1/rent-charges/${open.id}/adjustments`, { direction: 'credit', amount: ghs('1.00'), adjustedOn: '2026-02-31', reason: 'Test', approvedBy: randomUUID() });
    expect(codes(dates)).toEqual(expect.arrayContaining(['adjustedOn:invalid', 'approvedBy:not-allowed']));
    const lockedDay = await as().post(`/api/v1/rent-charges/${open.id}/adjustments`, { direction: 'credit', amount: ghs('1.00'), adjustedOn: '2026-02-15', reason: 'Test', approvedBy: company.ownerMembershipId });
    expect(codes(lockedDay)).toContain('adjustedOn:period-locked');
    await as().action(`/api/v1/rent-charges/${open.id}/waive`, open.version, { reason: 'Goodwill' }).expect(200);

    const scheduled = (await as().post(`/api/v1/leases/${live.id}/charges`, { chargeType: 'fee', description: 'Later', dueDate: '2099-01-01', amount: ghs('5.00'), when: 'schedule' }).expect(201)).body;
    expect((await as().action(`/api/v1/rent-charges/${scheduled.id}/waive`, scheduled.version, { reason: 'Goodwill' })).body.detail).toContain('Only a posted charge');
    expect((await as().action(`/api/v1/rent-charges/${scheduled.id}/cancel`, scheduled.version).expect(200)).body.status).toBe('cancelled');
    const ledger = (await as().get(`/api/v1/leases/${live.id}/ledger?asOf=2026-12-31`).expect(200)).body;
    expect(ledger.entries.every((e: Body) => e.kind === 'charge')).toBe(true);
  });

  it('starts a schedule only for a live lease, within its dates', async () => {
    const record = (await as().get(`/api/v1/leases/${draft.id}`).expect(200)).body;
    expect((await as().action(`/api/v1/leases/${draft.id}/rent-schedule`, record.version, { from: '2031-01-01' })).body.detail).toContain('Rent is scheduled for');
    const scheduled = (await as().get(`/api/v1/leases/${live.id}`).expect(200)).body;
    expect((await as().action(`/api/v1/leases/${live.id}/rent-schedule`, scheduled.version, { from: '2026-02-01' })).body.detail).toContain('already starts');
    const fresh = await fx.db
      .insertInto('leases')
      .values({
        companyId: company.companyId, reference: `RUL-${counter++}`, unitId: (await fx.db.selectFrom('leases').select('unitId').where('id', '=', draft.id).executeTakeFirstOrThrow()).unitId,
        jurisdictionCode: 'GH', leaseType: 'fixed_term', status: 'active', startDate: '2033-01-01', endDate: '2033-06-30', currencyCode: 'GHS', rentAmount: '1000', rentFrequency: 'monthly', signedAt: new Date(),
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();
    const late = await as().action(`/api/v1/leases/${fresh.id}/rent-schedule`, fresh.version, { from: '2033-07-01' });
    expect(codes(late)).toEqual(['from:after-end']);
    const invalid = await as().action(`/api/v1/leases/${fresh.id}/rent-schedule`, fresh.version, { from: '2033-02-30' });
    expect(codes(invalid)).toEqual(['from:invalid']);
  });

  it('checks rent reviews field by field and by state', async () => {
    const base = `/api/v1/leases/${live.id}/rent-reviews`;
    expect((await as().post(`/api/v1/leases/${draft.id}/rent-reviews`, { reviewDate: '2031-06-01', method: 'market' })).status).toBe(422);
    expect(codes(await as().post(base, { reviewDate: '2026-02-30', method: 'market' }))).toEqual(['reviewDate:invalid']);
    expect(codes(await as().post(base, { reviewDate: '2025-06-01', method: 'market' }))).toEqual(['reviewDate:before-start']);
    const review = (await as().post(base, { reviewDate: '2026-06-01', method: 'market' }).expect(201)).body;
    const path = `${base}/${review.id}`;
    expect(codes(await as().patch(path, review.version, { action: 'edit' }))).toEqual(['action:nothing']);
    expect(codes(await as().patch(path, review.version, { action: 'edit', reviewDate: '2026-02-30' }))).toEqual(['reviewDate:invalid']);
    expect(codes(await as().patch(path, review.version, { action: 'edit', reviewDate: '2025-01-01' }))).toEqual(['reviewDate:before-start']);
    const edited = (await as().patch(path, review.version, { action: 'edit', reviewDate: '2026-07-01', method: 'index_linked', notes: 'Index' }).expect(200)).body;
    expect(edited).toMatchObject({ reviewDate: '2026-07-01', method: 'index_linked', notes: 'Index', status: 'scheduled' });
    await as().patch(path, review.version, { action: 'cancel' }).expect(412);
    expect(codes(await as().patch(path, edited.version, { action: 'propose' }))).toEqual(['proposed:required']);
    expect(codes(await as().patch(path, edited.version, { action: 'propose', proposed: { amount: '1.00', currency: 'AED' } }))).toEqual(['proposed.currency:currency-mismatch']);
    expect(codes(await as().patch(path, edited.version, { action: 'agree' }))).toEqual(['agreed:required', 'effectiveFrom:required']);
    expect(codes(await as().patch(path, edited.version, { action: 'agree', agreed: ghs('1100.00'), effectiveFrom: '2026-02-30' }))).toEqual(['effectiveFrom:invalid']);
    expect(codes(await as().patch(path, edited.version, { action: 'agree', agreed: ghs('1100.00'), effectiveFrom: '2025-12-01' }))).toEqual(['effectiveFrom:before-start']);
    const agreed = (await as().patch(path, edited.version, { action: 'agree', agreed: ghs('1100.00'), effectiveFrom: '2026-08-01', notes: 'Agreed by phone' }).expect(200)).body;
    expect(agreed).toMatchObject({ status: 'agreed', notes: 'Agreed by phone' });
    await as().action(`${base}/${randomUUID()}/apply`, 1).expect(404);
    await fx.db.updateTable('leases').set({ status: 'ended', moveOutDate: '2026-07-31' }).where('id', '=', live.id).execute();
    expect((await as().action(`${path}/apply`, agreed.version)).body.detail).toContain('applied to an active');
    await as().get(`/api/v1/leases/${randomUUID()}/rent-reviews`).expect(404);
  });
});
