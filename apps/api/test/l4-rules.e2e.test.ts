import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { EICAR, pdf, png, sha256Hex } from './support/media-files.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let counter = 0;
const nextPhone = () => `024${String(8700000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/**
 * Phase 7 milestone L4: the field checks and life-cycle refusals of deposits,
 * notice, ending, closing, renewal and inspections, one by one (the happy
 * paths are in deposits, lease-ending and inspections e2e tests).
 */
describe('L4: rules of deposits, ending, renewal and inspections', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Company;
  let other: Company;
  let account: string;
  let closedAccount: string;
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
      del: (path: string, version: number) => auth(t.http.delete(path)).set('If-Match', `"${version}"`),
    };
  };
  const codes = (res: { body: Body }) => (res.body.errors ?? []).map((e: Body) => `${e.field}:${e.code}`);
  const getLease = async (id: string) => (await as('owner').get(`/api/v1/leases/${id}`).expect(200)).body as Body;
  const act = async (id: string, action: string, body: object = {}, who = 'owner') => as(who).action(`/api/v1/leases/${id}/${action}`, (await getLease(id)).version, body);
  async function ok(id: string, action: string, body: object = {}, status = 200) {
    const res = await act(id, action, body);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Body;
  }
  const deposit = async (leaseId: string) => (await as('owner').get(`/api/v1/leases/${leaseId}/deposit`).expect(200)).body.deposit as Body;

  async function contact() {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: `Party ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  /** A lease of a new villa; `stage` decides how far it goes. */
  async function lease(stage: 'draft' | 'pending' | 'active' = 'active', terms: object = {}) {
    const landlord = await contact();
    const tenant = await contact();
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: `Rules Villa ${counter}`, propertyTypeId: typeId, officeId: company.officeId, createWholePropertyUnit: true,
        address: { countryCode: 'GH', addressLine1: `${counter++} Rules Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: property.body.id, ownerContactId: landlord.id, effectiveFrom: '2020-01-01', ownershipType: 'legal_owner' }).execute();
    const created = await as('owner').post('/api/v1/leases', {
      unitId, leaseType: 'fixed_term', startDate: '2026-06-01', endDate: '2026-08-31', rent: ghs('3000.00'), rentFrequency: 'monthly', deposit: ghs('3000.00'),
      parties: [{ contactId: tenant.id, partyRole: 'tenant', isPrimary: true }], ...terms,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    if (stage !== 'draft') await ok(id, 'send-for-signature');
    if (stage === 'active') await ok(id, 'activate', { signedOn: '2026-05-20' });
    return { id, tenantId: tenant.id, unitId, propertyId: property.body.id as string };
  }

  async function heldDeposit(leaseId: string, tenantId: string) {
    await as('owner').put(`/api/v1/leases/${leaseId}/deposit`, { holderType: 'agent', holdingAccountId: account }).expect(200);
    const charge = (await as('owner').get(`/api/v1/rent-charges?filter[leaseId]=${leaseId}&filter[chargeType]=deposit&filter[dueDate][gte]=2000-01-01`).expect(200)).body.data[0];
    const receipt = await as('owner').post('/api/v1/payments', { payerContactId: tenantId, leaseId, bankAccountId: account, methodCode: 'cash', amount: charge.balance.outstanding, receivedOn: '2026-06-02' }).expect(201);
    await as('owner').post(`/api/v1/payments/${receipt.body.id}/allocations`, { allocatedOn: '2026-06-02', lines: [{ rentChargeId: charge.id, amount: charge.balance.outstanding }] }).expect(201);
    return deposit(leaseId);
  }

  async function upload(entityType: 'lease' | 'inspection', entityId: string, file: Buffer, contentType: string, documentTypeCode: string, scan = true) {
    const ticket = await as('owner').post('/api/v1/documents/uploads', {
      entityType, entityId, title: 'Evidence', documentTypeCode, isSigned: false, fileName: contentType === 'image/png' ? 'photo.png' : 'file.pdf', contentType, size: file.length, sha256: sha256Hex(file),
    });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    expect((await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file })).status).toBe(200);
    const confirmed = await as('owner').post(`/api/v1/documents/uploads/${ticket.body.id}/confirm`).expect(201);
    if (scan) await worker.runOnce();
    return confirmed.body.id as string;
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, jobTypes: ['document.scan'] }));
    company = await fx.company();
    other = await fx.company();
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['accountant', accountant.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `l4r-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `l4r-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    account = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'Client account', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'GHS' }).returning('id').executeTakeFirstOrThrow()).id;
    closedAccount = (await fx.db.insertInto('bankAccounts').values({ companyId: company.companyId, name: 'Closed', accountPurpose: 'client_money', countryCode: 'GH', currencyCode: 'GHS', isActive: false }).returning('id').executeTakeFirstOrThrow()).id;
    await as('owner').put('/api/v1/settings/lettings', { chargeLeadDays: 14, requireSignedLease: false }).expect(200);
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  it('deposits: registration and its changes', async () => {
    const draft = await lease('draft');
    expect((await as('owner').put(`/api/v1/leases/${draft.id}/deposit`, { holderType: 'landlord' })).body.detail).toContain('awaiting signature or running');
    expect((await as('agent').get(`/api/v1/leases/${draft.id}/deposit`)).status).toBe(403);
    expect((await as('otherOwner').put(`/api/v1/leases/${draft.id}/deposit`, { holderType: 'landlord' })).status).toBe(404);

    const { id } = await lease();
    expect(codes(await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'agent', holdingAccountId: closedAccount }))).toEqual(['holdingAccountId:not-found']);
    expect(codes(await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord', protectionDeadline: '2026-02-30', returnDueBy: '2026-13-01' }))).toEqual(['protectionDeadline:invalid', 'returnDueBy:invalid']);
    const first = (await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord', schemeName: 'Scheme A', returnDueBy: '2026-09-30' }).expect(200)).body.deposit;
    expect((await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord' })).body.detail).toContain('If-Match');
    const changed = await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'protection_scheme', schemeName: null, protectionDeadline: '2026-07-15', returnDueBy: null }, first.version).expect(200);
    expect(changed.body.deposit).toMatchObject({ holderType: 'protection_scheme', schemeName: null, protectionDeadline: '2026-07-15', protectionDeadlineSource: 'entered', returnDueBy: null });
    const cleared = await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'protection_scheme', protectionDeadline: null }, changed.body.deposit.version).expect(200);
    expect(cleared.body.deposit).toMatchObject({ protectionDeadline: null, protectionDeadlineSource: null });
    expect((await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', first.id).execute()).map((r) => r.action)).toEqual(['deposit.registered', 'deposit.updated', 'deposit.updated']);
  });

  it('deposits: protection, deductions and return refused out of order', async () => {
    const { id, tenantId } = await lease();
    let current = await heldDeposit(id, tenantId);
    expect((await as('owner').action(`/api/v1/deposits/${randomUUID()}/protection`, 1, { schemeName: 'S', schemeReference: 'R', protectedOn: today() })).status).toBe(404);
    expect((await as('owner').action(`/api/v1/deposits/${current.id}/protection`, current.version + 3, { schemeName: 'S', schemeReference: 'R', protectedOn: today() })).status).toBe(412);
    expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/protection`, current.version, { schemeName: 'S', schemeReference: 'R', protectedOn: '2026-02-31' }))).toEqual(['protectedOn:invalid']);
    expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/protection`, current.version, { schemeName: 'S', schemeReference: 'R', protectedOn: addDays(today(), 1) }))).toEqual(['protectedOn:future']);
    expect((await as('owner').action(`/api/v1/deposits/${current.id}/return`, current.version, { returnedOn: today() })).body.detail).toContain('ended');

    await ok(id, 'end', { moveOutDate: '2026-08-31' });
    current = await deposit(id);
    expect(current.status).toBe('return_pending');
    expect((await as('owner').action(`/api/v1/deposits/${current.id}/protection`, current.version, { schemeName: 'S', schemeReference: 'R', protectedOn: today() })).body.detail).toContain('Only a held deposit');
    expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/return`, current.version, { returnedOn: '2026-04-31' }))).toEqual(['returnedOn:invalid']);
    expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/return`, current.version, { returnedOn: '2026-06-01' }))).toEqual(['returnedOn:before-receipt']);
    expect(codes(await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, current.version, { reasonCode: 'cleaning', description: 'X', amount: { amount: '1.00', currency: 'USD' } }))).toEqual(['amount.currency:currency-mismatch']);

    const added = (await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, current.version, { reasonCode: 'cleaning', description: 'Oven', amount: ghs('100.00') }).expect(201)).body;
    const deduction = added.deductions[0];
    const decide = (body: object, version = deduction.version, deductionId = deduction.id) => as('owner').patch(`/api/v1/deposits/${current.id}/deductions/${deductionId}`, version, body);
    expect((await decide({ action: 'agree' }, deduction.version, randomUUID())).status).toBe(404);
    expect((await decide({ action: 'agree' }, deduction.version + 2)).status).toBe(412);
    expect(codes(await decide({ action: 'attach_evidence' }))).toEqual(['evidenceDocumentId:required']);
    expect(codes(await decide({ action: 'withdraw', evidenceDocumentId: randomUUID() }))).toEqual(['evidenceDocumentId:not-allowed']);
    expect((await decide({ action: 'adjudicate' })).status).toBe(422);
    const disputed = (await decide({ action: 'dispute' }).expect(200)).body.deductions[0];
    expect(codes(await decide({ action: 'adjudicate' }, disputed.version))).toEqual(['settledAmount:required']);
    expect(codes(await decide({ action: 'adjudicate', settledAmount: { amount: '1.00', currency: 'USD' } }, disputed.version))).toEqual(['settledAmount.currency:currency-mismatch']);
    const withdrawn = (await decide({ action: 'withdraw' }, disputed.version).expect(200)).body;
    expect(withdrawn).toMatchObject({ status: 'return_pending', settledDeductions: ghs('0.00') });
    const returned = (await as('owner').action(`/api/v1/deposits/${current.id}/return`, withdrawn.version, { returnedOn: today() }).expect(200)).body;
    expect(returned).toMatchObject({ status: 'returned', returnedAmount: ghs('3000.00') });
    expect((await as('owner').action(`/api/v1/deposits/${current.id}/deductions`, returned.version, { reasonCode: 'cleaning', description: 'Late', amount: ghs('1.00') })).body.detail).toContain('returned');
    expect((await decide({ action: 'agree' }, withdrawn.deductions[0].version)).body.detail).toContain('returned');
    expect((await as('owner').action(`/api/v1/deposits/${current.id}/return`, returned.version, { returnedOn: today() })).body.detail).toContain('returned');
  });

  it('deposits: never received, nothing to deduct or return', async () => {
    const { id } = await lease();
    const expected = (await as('owner').put(`/api/v1/leases/${id}/deposit`, { holderType: 'landlord' }).expect(200)).body.deposit;
    await ok(id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-01', endsOn: '2026-08-31' });
    expect((await as('owner').action(`/api/v1/deposits/${expected.id}/deductions`, expected.version, { reasonCode: 'cleaning', description: 'X', amount: ghs('1.00') })).body.detail).toContain('not been received');
    await ok(id, 'end', { moveOutDate: '2026-08-31' });
    const after = await deposit(id);
    expect(after.status).toBe('expected');
    expect((await as('owner').action(`/api/v1/deposits/${after.id}/return`, after.version, { returnedOn: today() })).body.detail).toContain('never received');
  });

  it('notice, ending, closing and renewal refused where they do not apply', async () => {
    const draft = await lease('draft');
    expect((await act(draft.id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-01', endsOn: '2026-08-01' })).body.detail).toContain('active or periodic');
    expect((await act(draft.id, 'end', { moveOutDate: '2026-08-01' })).body.detail).toContain('running lease');
    expect((await act(draft.id, 'close')).body.detail).toContain('once it has ended');
    expect((await act(draft.id, 'renewal-decision', { decision: 'renew' })).body.detail).toContain('active fixed-term');
    expect((await as('otherOwner').get(`/api/v1/leases/${draft.id}/close-check`)).status).toBe(404);
    expect((await act(draft.id, 'notice', { givenBy: 'tenant', givenOn: '2026-07-01' }, 'accountant')).status).toBe(403);

    const active = await lease();
    expect(codes(await act(active.id, 'notice', { givenBy: 'tenant', givenOn: '2026-06-31', endsOn: '2026-08-01' }))).toEqual(['givenOn:invalid']);
    expect(codes(await act(active.id, 'notice', { givenBy: 'tenant', givenOn: '2026-05-01', endsOn: '2026-05-15' }))).toEqual(['endsOn:before-start']);
    expect(codes(await act(active.id, 'end', { moveOutDate: '2026-08-32' }))).toEqual(['moveOutDate:invalid']);
    expect((await act(active.id, 'renewal', { endDate: '2027-08-31' }, 'accountant')).status).toBe(403);

    // A periodic lease has no end date until notice is given; it is not renewed.
    const periodic = await lease('active', { leaseType: 'periodic', endDate: undefined, startDate: '2026-06-01' });
    expect((await act(periodic.id, 'end', { moveOutDate: '2026-08-01' })).body.detail).toContain('Record notice first');
    expect((await act(periodic.id, 'renewal', {})).body.detail).toContain('active fixed-term');
    const noticed = await ok(periodic.id, 'notice', { givenBy: 'landlord', givenOn: '2026-07-01', endsOn: '2026-07-31' });
    expect(noticed.lease).toMatchObject({ status: 'notice_given', endDate: '2026-07-31' });

    // A renewal copies the terms not given, and "later" twice changes nothing.
    const base = await lease('active', { endDate: '2026-12-31', rentDueDay: 5, noticePeriodDays: 30, governingLocaleCode: 'en-GH' });
    await ok(base.id, 'renewal-decision', { decision: 'later' });
    const unchanged = await ok(base.id, 'renewal-decision', { decision: 'later' });
    expect(unchanged.renewalStatus).toBe('pending_decision');
    const periodicRenewal = await ok(base.id, 'renewal', { leaseType: 'periodic', rentFrequency: 'quarterly', rentDueDay: 1, noticePeriodDays: 90, nextRentReviewDate: '2027-06-01' }, 201);
    expect(periodicRenewal).toMatchObject({ leaseType: 'periodic', endDate: null, rentFrequency: 'quarterly', rentDueDay: 1, noticePeriodDays: 90, nextRentReviewDate: '2027-06-01', governingLocaleCode: 'en-GH', rent: ghs('3000.00') });
    expect((await getLease(base.id)).renewalStatus).toBe('renewing');
  });

  it('inspections: scheduling, recording and finishing refused where they do not apply', async () => {
    const { id: leaseId, propertyId, unitId } = await lease();
    const pending = await lease('pending');
    const draft = await lease('draft');
    const at = '2026-06-01T09:00:00Z';
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId: randomUUID(), inspectionType: 'periodic', scheduledAt: at }))).toEqual(['propertyId:not-found']);
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId, unitId: pending.unitId, inspectionType: 'periodic', scheduledAt: at }))).toEqual(['unitId:not-found']);
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId, unitId, leaseId: randomUUID(), inspectionType: 'periodic', scheduledAt: at }))).toEqual(['leaseId:not-found']);
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId: draft.propertyId, unitId: draft.unitId, leaseId: draft.id, inspectionType: 'move_in', scheduledAt: at }))).toEqual(['leaseId:lease-status']);
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId: pending.propertyId, unitId: pending.unitId, leaseId: pending.id, inspectionType: 'move_out', scheduledAt: at }))).toEqual(['leaseId:lease-status']);
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId, inspectionType: 'periodic', scheduledAt: 'tomorrow' }))).toEqual(['scheduledAt:is-iso8601']);

    let current = (await as('owner').post('/api/v1/inspections', { propertyId, inspectionType: 'safety', scheduledAt: at }).expect(201)).body;
    expect(current.unit).toBeNull();
    const member = (await fx.db.selectFrom('companyMemberships').select('id').where('companyId', '=', company.companyId).where('membershipType', '=', 'staff').executeTakeFirstOrThrow()).id;
    const updated = await as('owner').patch(`/api/v1/inspections/${current.id}`, current.version, { scheduledAt: '2026-06-02T09:00:00Z', inspectorMembershipId: member, overallCondition: 'fair', summary: '' });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ scheduledAt: '2026-06-02T09:00:00.000Z', inspector: { id: member }, overallCondition: 'fair', summary: null });
    current = updated.body;
    const same = await as('owner').patch(`/api/v1/inspections/${current.id}`, current.version, { overallCondition: 'fair' }).expect(200);
    expect(same.body.version).toBe(current.version);
    expect(codes(await as('owner').patch(`/api/v1/inspections/${current.id}`, current.version, { inspectorMembershipId: randomUUID() }))).toEqual(['inspectorMembershipId:not-found']);
    const item = randomUUID();
    expect(codes(await as('owner').put(`/api/v1/inspections/${current.id}/items`, { items: [{ area: 'Roof', item: 'Gutter' }] }, current.version))).toEqual([]);
    current = (await as('owner').get(`/api/v1/inspections/${current.id}`).expect(200)).body;
    expect(codes(await as('owner').put(`/api/v1/inspections/${current.id}/items`, { items: [{ id: current.items[0].id, area: 'Roof', item: 'Gutter' }, { id: current.items[0].id, area: 'Roof', item: 'Tiles' }] }, current.version))).toEqual(['items:duplicate-id']);
    expect((await as('owner').action(`/api/v1/inspections/${current.id}/items/${item}/photos`, current.version, { documentId: randomUUID() })).status).toBe(404);
    expect((await as('owner').del(`/api/v1/inspections/${current.id}/items/${current.items[0].id}/photos/${randomUUID()}`, current.version)).status).toBe(404);
    expect((await as('owner').action(`/api/v1/inspections/${current.id}/tenant-signed`, current.version, { acknowledgedAt: new Date().toISOString() })).body.detail).toContain('completed inspection');

    // An infected photo is refused; finishing needs the items' conditions; a report must be clean.
    const infected = await upload('inspection', current.id, EICAR, 'image/png', 'inspection_photo');
    expect(codes(await as('owner').action(`/api/v1/inspections/${current.id}/items/${current.items[0].id}/photos`, current.version, { documentId: infected }))).toEqual(['documentId:scan-failed']);
    current = (await as('owner').patch(`/api/v1/inspections/${current.id}`, current.version, { action: 'start' }).expect(200)).body;
    expect(codes(await as('owner').action(`/api/v1/inspections/${current.id}/complete`, current.version))).toEqual(['items.0.conditionCode:required']);
    current = (await as('owner').put(`/api/v1/inspections/${current.id}/items`, { items: [] }, current.version).expect(200)).body;
    expect(codes(await as('owner').action(`/api/v1/inspections/${current.id}/complete`, current.version))).toEqual(['items:required']);
    current = (await as('owner').put(`/api/v1/inspections/${current.id}/items`, { items: [{ area: 'Roof', item: 'Gutter', conditionCode: 'fair', cleanliness: 'dirty' }] }, current.version).expect(200)).body;
    expect(codes(await as('owner').action(`/api/v1/inspections/${current.id}/complete`, current.version, { reportDocumentId: infected }))).toEqual(['reportDocumentId:scan-failed']);
    // A "photo" that is really a PDF is linked while scanning, then fails the scan.
    const good = await upload('inspection', current.id, pdf(), 'image/png', 'inspection_photo', false);
    current = (await as('owner').action(`/api/v1/inspections/${current.id}/items/${current.items[0].id}/photos`, current.version, { documentId: good }).expect(200)).body;
    await worker.runOnce();
    expect((await as('owner').action(`/api/v1/inspections/${current.id}/complete`, current.version)).body.detail).toContain('did not pass');
    await as('owner').del(`/api/v1/inspections/${current.id}/items/${current.items[0].id}/photos/${good}`, current.version).expect(200);
    current = (await as('owner').get(`/api/v1/inspections/${current.id}`).expect(200)).body;
    current = (await as('owner').action(`/api/v1/inspections/${current.id}/complete`, current.version).expect(200)).body;
    expect((await as('owner').action(`/api/v1/inspections/${current.id}/tenant-signed`, current.version, { acknowledgedAt: new Date().toISOString() })).body.detail).toContain('not of a lease');

    // A move-in inspection's acknowledgement is never in the future.
    let moveIn = (await as('owner').post('/api/v1/inspections', { propertyId, unitId, leaseId, inspectionType: 'move_in', scheduledAt: at }).expect(201)).body;
    moveIn = (await as('owner').patch(`/api/v1/inspections/${moveIn.id}`, moveIn.version, { action: 'start', overallCondition: 'good' }).expect(200)).body;
    moveIn = (await as('owner').put(`/api/v1/inspections/${moveIn.id}/items`, { items: [{ area: 'Hall', item: 'Door', conditionCode: 'good' }] }, moveIn.version).expect(200)).body;
    moveIn = (await as('owner').action(`/api/v1/inspections/${moveIn.id}/complete`, moveIn.version).expect(200)).body;
    expect(codes(await as('owner').action(`/api/v1/inspections/${moveIn.id}/tenant-signed`, moveIn.version, { acknowledgedAt: '2099-01-01T00:00:00Z' }))).toEqual(['acknowledgedAt:future']);
    expect((await as('owner').action(`/api/v1/inspections/${moveIn.id}/cancel`, moveIn.version, { reason: 'Too late' })).status).toBe(422);
    expect((await as('owner').action(`/api/v1/inspections/${moveIn.id}/tenant-signed`, moveIn.version + 1, { acknowledgedAt: new Date().toISOString() })).status).toBe(412);
  });
});
