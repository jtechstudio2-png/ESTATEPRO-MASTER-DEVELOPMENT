import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { EICAR, pdf, sha256Hex } from './support/media-files.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let counter = 0;
const nextPhone = () => `024${String(7300000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Phase 7 milestone L1: documents (upload, scan, download, W7-A1),
 * management agreements (LET-02) and leases (LET-01): life cycle, parties,
 * activation with the signed copy (P7-D5), the listing rented (P7-D4), letting
 * deals drawn up into leases, scope, isolation, audit and outbox.
 */
describe('L1: management agreements, leases and documents', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Company;
  let other: Company;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};

  const as = (who: string) => {
    const companyId = who === 'otherOwner' ? other.companyId : company.companyId;
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
      patch: (path: string, version: number, body: object) => auth(t.http.patch(path)).set('If-Match', `"${version}"`).send(body),
      delete: (path: string, version: number) => auth(t.http.delete(path)).set('If-Match', `"${version}"`),
    };
  };

  async function contact(name = `Party ${randomUUID().slice(0, 6)}`) {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  /** A property in the main office (or another) with one whole-property unit, owned by `ownerId`. */
  async function place(ownerId: string, officeId = company.officeId) {
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: `Lettings Villa ${counter}`,
        propertyTypeId: typeId,
        officeId,
        address: { countryCode: 'GH', addressLine1: `${counter++} Lettings Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
        createWholePropertyUnit: true,
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: property.body.id, ownerContactId: ownerId, effectiveFrom: '2020-01-01', ownershipType: 'legal_owner' }).execute();
    return { propertyId: property.body.id as string, unitId };
  }

  async function rentListing(unitId: string) {
    const listing = await fx.listing(company.companyId, unitId, members['agent']!, company.officeId);
    await fx.db.updateTable('listings').set({ listingType: 'rent', rentFrequency: 'monthly', price: '6000.00' }).where('id', '=', listing.id).execute();
    return listing.id;
  }

  /** Request, PUT, confirm; optionally run the scan. */
  async function upload(entityType: 'lease' | 'management_agreement', entityId: string, options: { file?: Buffer; signed?: boolean; scan?: boolean; who?: string; documentTypeCode?: string } = {}) {
    const file = options.file ?? pdf();
    const ticket = await as(options.who ?? 'owner').post('/api/v1/documents/uploads', {
      entityType,
      entityId,
      title: entityType === 'lease' ? 'Signed lease' : 'Signed agreement',
      documentTypeCode: options.documentTypeCode ?? entityType,
      isSigned: options.signed ?? true,
      fileName: 'signed.pdf',
      contentType: 'application/pdf',
      size: file.length,
      sha256: sha256Hex(file),
    });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const put = await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
    expect(put.status).toBe(200);
    const confirmed = await as(options.who ?? 'owner').post(`/api/v1/documents/uploads/${ticket.body.id}/confirm`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    if (options.scan ?? true) await worker.runOnce();
    return confirmed.body as { id: string; scanStatus: string };
  }

  async function agreement(who: string, body: Record<string, unknown>, expected = 201) {
    const res = await as(who).post('/api/v1/management-agreements', body);
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return res.body as Body;
  }

  const getAgreement = async (id: string) => (await as('owner').get(`/api/v1/management-agreements/${id}`).expect(200)).body as Body;
  const getLease = async (id: string, who = 'owner') => (await as(who).get(`/api/v1/leases/${id}`).expect(200)).body as Body;

  async function leaseAct(who: string, id: string, action: string, body: object = {}, expected = 200) {
    const current = await getLease(id);
    const res = await as(who).action(`/api/v1/leases/${id}/${action}`, current.version, body);
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return res.body as Body;
  }

  async function activeAgreement(landlordId: string, propertyId: string) {
    const draft = await agreement('owner', { landlordContactId: landlordId, propertyId, serviceLevel: 'fully_managed', currencyCode: 'GHS', feeBasis: 'percent_of_rent_collected', feePercent: 10, startDate: '2026-01-01' });
    const doc = await upload('management_agreement', draft.id);
    const res = await as('owner').action(`/api/v1/management-agreements/${draft.id}/activate`, draft.version, { documentId: doc.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Body;
  }

  const leaseBody = (unitId: string, tenantId: string, extra: Record<string, unknown> = {}) => ({
    unitId,
    leaseType: 'fixed_term',
    startDate: '2027-01-01',
    endDate: '2027-12-31',
    rent: ghs('6000.00'),
    rentFrequency: 'monthly',
    rentDueDay: 1,
    advancePeriods: 12,
    deposit: ghs('12000.00'),
    noticePeriodDays: 60,
    parties: [{ contactId: tenantId, partyRole: 'tenant', isPrimary: true, liabilityShare: 100 }],
    ...extra,
  });

  const auditActions = async (entityId: string) =>
    (await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', entityId).orderBy('occurredAt').orderBy('entryNo').execute()).map((row) => row.action);

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, jobTypes: ['document.scan'] }));
    company = await fx.company();
    other = await fx.company();
    const officeB = await fx.office(company.companyId, `L1B${counter++}`);
    const pm = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    const pmB = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [officeB.id] });
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    const manager = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    Object.assign(members, { owner: company.ownerMembershipId, pm: pm.membershipId, pmB: pmB.membershipId, agent: agent.membershipId, officeB: officeB.id, manager: manager.membershipId });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['pm', pm.userId, company.companyId],
      ['pmB', pmB.userId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['accountant', accountant.userId, company.companyId],
      ['manager', manager.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `l1-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `l1-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  describe('documents (W7-A1)', () => {
    it('uploads, scans and downloads a document of an agreement; only clean files are offered', async () => {
      const landlord = await contact();
      const { propertyId } = await place(landlord.id);
      const draft = await agreement('owner', { landlordContactId: landlord.id, propertyId, serviceLevel: 'let_only', currencyCode: 'GHS', feeBasis: 'one_off', feeFixed: ghs('500.00'), startDate: '2026-01-01' });
      const pending = await upload('management_agreement', draft.id, { scan: false });
      expect(pending).toMatchObject({ scanStatus: 'pending', isSigned: true, links: [{ entityType: 'management_agreement', entityId: draft.id }], category: 'legal' });
      const early = await as('owner').post(`/api/v1/documents/${pending.id}/download`).expect(422);
      expect(early.body.detail).toContain('still being checked');
      await worker.runOnce();
      const clean = (await as('owner').get(`/api/v1/documents/${pending.id}`).expect(200)).body;
      expect(clean.scanStatus).toBe('clean');
      const link = await as('owner').post(`/api/v1/documents/${pending.id}/download`).expect(201);
      const file = await fetch(link.body.url);
      expect(file.status).toBe(200);
      expect(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
      expect(await auditActions(pending.id)).toEqual(['document.uploaded', 'document.scanned', 'document.downloaded']);
      const list = (await as('owner').get(`/api/v1/management-agreements/${draft.id}/documents`).expect(200)).body.data;
      expect(list.map((d: Body) => d.id)).toEqual([pending.id]);

      const infected = await upload('management_agreement', draft.id, { file: EICAR });
      // EICAR is declared as a PDF here: either the scanner or the type check rejects it.
      const blocked = (await as('owner').get(`/api/v1/documents/${infected.id}`).expect(200)).body;
      expect(['infected', 'failed']).toContain(blocked.scanStatus);
      expect((await as('owner').post(`/api/v1/documents/${infected.id}/download`).expect(422)).body.detail).toContain('security scan');
    });

    it('refuses other file types, unknown document types, other companies and members without access to the record', async () => {
      const landlord = await contact();
      const { propertyId } = await place(landlord.id, members['officeB']);
      const draft = await agreement('owner', { landlordContactId: landlord.id, propertyId, serviceLevel: 'let_only', currencyCode: 'GHS', feeBasis: 'one_off', feeFixed: ghs('500.00'), startDate: '2026-01-01' });
      const base = { entityType: 'management_agreement', entityId: draft.id, title: 'Plan', documentTypeCode: 'management_agreement', fileName: 'x.gif', contentType: 'image/gif', size: 10, sha256: 'a'.repeat(64) };
      expect((await as('owner').post('/api/v1/documents/uploads', base).expect(422)).body.errors[0]).toMatchObject({ field: 'contentType', code: 'unsupported' });
      expect((await as('owner').post('/api/v1/documents/uploads', { ...base, contentType: 'application/pdf', documentTypeCode: 'spaceship' }).expect(422)).body.errors[0]).toMatchObject({ field: 'documentTypeCode' });
      // The property manager of the main office cannot see an agreement of office B; the other company sees nothing.
      await as('pm').post('/api/v1/documents/uploads', { ...base, contentType: 'application/pdf' }).expect(404);
      await as('otherOwner').post('/api/v1/documents/uploads', { ...base, contentType: 'application/pdf' }).expect(404);
      const doc = await upload('management_agreement', draft.id);
      await as('pm').get(`/api/v1/documents/${doc.id}`).expect(404);
      await as('otherOwner').get(`/api/v1/documents/${doc.id}`).expect(404);
      await as('pmB').get(`/api/v1/documents/${doc.id}`).expect(200);
      // Agents read documents of their own records only; agreements are not theirs.
      await as('agent').get(`/api/v1/management-agreements/${draft.id}/documents`).expect(404);
    });
  });

  describe('management agreements (LET-02)', () => {
    it('records a draft, activates it with the signed agreement, then fixes its terms', async () => {
      const landlord = await contact();
      const { propertyId, unitId } = await place(landlord.id);
      const missing = await as('owner').post('/api/v1/management-agreements', { landlordContactId: landlord.id, propertyId, serviceLevel: 'rent_collection', currencyCode: 'GHS', feeBasis: 'percent_of_rent_due', startDate: '2026-01-01' }).expect(422);
      expect(missing.body.errors).toEqual([expect.objectContaining({ field: 'feePercent', code: 'required' })]);
      const draft = await agreement('pm', { landlordContactId: landlord.id, propertyId, unitId, serviceLevel: 'rent_collection', currencyCode: 'GHS', feeBasis: 'percent_of_rent_due', feePercent: 8, expenseApprovalLimit: ghs('2000.00'), startDate: '2026-01-01' });
      expect(draft).toMatchObject({ status: 'draft', reference: expect.stringMatching(/^MGA-/), unit: { id: unitId }, fee: { basis: 'percent_of_rent_due', percent: 8, fixed: null }, expenseApprovalLimit: ghs('2000.00'), floatAmount: ghs('0.00'), liveLeases: 0 });
      const edited = await as('pm').patch(`/api/v1/management-agreements/${draft.id}`, draft.version, { feePercent: 9 }).expect(200);
      expect(edited.body.fee.percent).toBe(9);
      await as('pm').action(`/api/v1/management-agreements/${draft.id}/activate`, edited.body.version, { documentId: randomUUID() }).expect(422);
      const unsigned = await upload('management_agreement', draft.id, { signed: false });
      const notSigned = await as('pm').action(`/api/v1/management-agreements/${draft.id}/activate`, edited.body.version, { documentId: unsigned.id }).expect(422);
      expect(notSigned.body.errors[0]).toMatchObject({ code: 'not-signed' });
      const signed = await upload('management_agreement', draft.id);
      const active = await as('pm').action(`/api/v1/management-agreements/${draft.id}/activate`, edited.body.version, { documentId: signed.id }).expect(200);
      expect(active.body).toMatchObject({ status: 'active', document: { id: signed.id } });
      const fixed = await as('pm').patch(`/api/v1/management-agreements/${draft.id}`, active.body.version, { feePercent: 12 }).expect(422);
      expect(fixed.body.errors[0]).toMatchObject({ field: 'feePercent', code: 'fixed' });
      const limit = await as('pm').patch(`/api/v1/management-agreements/${draft.id}`, active.body.version, { expenseApprovalLimit: ghs('3000.00'), payoutDay: 5 }).expect(200);
      expect(limit.body).toMatchObject({ expenseApprovalLimit: ghs('3000.00'), payoutDay: 5 });
      // One live agreement per unit: a whole-property agreement overlaps the unit agreement.
      const second = await agreement('owner', { landlordContactId: landlord.id, propertyId, serviceLevel: 'fully_managed', currencyCode: 'GHS', feeBasis: 'percent_of_rent_collected', feePercent: 10, startDate: '2026-01-01' });
      const secondDoc = await upload('management_agreement', second.id);
      const overlap = await as('owner').action(`/api/v1/management-agreements/${second.id}/activate`, second.version, { documentId: secondDoc.id }).expect(422);
      expect(overlap.body.detail).toContain(draft.reference);
      // Suspend and reactivate; end.
      const suspended = await as('pm').action(`/api/v1/management-agreements/${draft.id}/suspend`, limit.body.version).expect(200);
      expect(suspended.body.status).toBe('suspended');
      const again = await as('pm').action(`/api/v1/management-agreements/${draft.id}/activate`, suspended.body.version, { documentId: signed.id }).expect(200);
      await as('pm').action(`/api/v1/management-agreements/${draft.id}/end`, again.body.version, { endDate: '2025-12-31' }).expect(422);
      const ended = await as('pm').action(`/api/v1/management-agreements/${draft.id}/end`, again.body.version, { endDate: '2026-12-31' }).expect(200);
      expect(ended.body).toMatchObject({ status: 'ended', endDate: '2026-12-31' });
      await as('pm').action(`/api/v1/management-agreements/${draft.id}/activate`, ended.body.version, { documentId: signed.id }).expect(422);
      expect(await auditActions(draft.id)).toEqual([
        'management_agreement.created', 'management_agreement.updated', 'management_agreement.activated', 'management_agreement.updated',
        'management_agreement.suspended', 'management_agreement.activated', 'management_agreement.ended',
      ]);
      const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', draft.id).orderBy('occurredAt').orderBy('entryNo').execute();
      expect(events.map((e) => e.eventType)).toEqual(['management_agreement.created', 'management_agreement.activated', 'management_agreement.suspended', 'management_agreement.activated', 'management_agreement.ended']);
    });

    it('limits agreements to the member\'s scope and roles, and to the company', async () => {
      const landlord = await contact();
      const { propertyId } = await place(landlord.id, members['officeB']);
      const draft = await agreement('owner', { landlordContactId: landlord.id, propertyId, serviceLevel: 'let_only', currencyCode: 'GHS', feeBasis: 'one_off', feeFixed: ghs('900.00'), startDate: '2026-01-01' });
      await as('pm').get(`/api/v1/management-agreements/${draft.id}`).expect(404);
      await as('pmB').get(`/api/v1/management-agreements/${draft.id}`).expect(200);
      await as('pm').post('/api/v1/management-agreements', { landlordContactId: landlord.id, propertyId, serviceLevel: 'let_only', currencyCode: 'GHS', feeBasis: 'one_off', feeFixed: ghs('1.00'), startDate: '2026-01-01' }).expect(422);
      const mine = (await as('pm').get('/api/v1/management-agreements?limit=100').expect(200)).body.data.map((a: Body) => a.id);
      expect(mine).not.toContain(draft.id);
      // Accountants read agreements; agents and sales managers have none.
      await as('accountant').get(`/api/v1/management-agreements/${draft.id}`).expect(200);
      await as('accountant').patch(`/api/v1/management-agreements/${draft.id}`, draft.version, { feeFixed: ghs('1.00') }).expect(403);
      await as('agent').get('/api/v1/management-agreements').expect(403);
      await as('otherOwner').get(`/api/v1/management-agreements/${draft.id}`).expect(404);
      const filtered = (await as('owner').get(`/api/v1/management-agreements?filter[propertyId]=${propertyId}`).expect(200)).body.data;
      expect(filtered.map((a: Body) => a.id)).toEqual([draft.id]);
    });
  });

  describe('leases (LET-01)', () => {
    it('draws up a lease, sends it for signature and activates it with the signed copy; the listing is rented', async () => {
      const landlord = await contact('Ama Landlord');
      const tenant = await contact('Kojo Tenant');
      const { propertyId, unitId } = await place(landlord.id);
      const listingId = await rentListing(unitId);
      const mgt = await activeAgreement(landlord.id, propertyId);

      const invalid = await as('pm').post('/api/v1/leases', leaseBody(unitId, tenant.id, { endDate: undefined, parties: [{ contactId: tenant.id, partyRole: 'tenant' }] })).expect(422);
      expect(invalid.body.errors.map((e: Body) => e.code)).toEqual(expect.arrayContaining(['required', 'primary-tenant']));
      const created = await as('pm').post('/api/v1/leases', leaseBody(unitId, tenant.id, { listingId, managementAgreementId: mgt.id })).expect(201);
      const lease = created.body as Body;
      expect(lease).toMatchObject({
        status: 'draft',
        reference: expect.stringMatching(/^LSE-/),
        unit: { id: unitId },
        primaryTenant: { id: tenant.id },
        rent: ghs('6000.00'),
        deposit: ghs('12000.00'),
        managementAgreement: { id: mgt.id },
        listing: { id: listingId },
        jurisdictionCode: 'GH',
        rulesNotReviewed: true,
      });
      // The unit's owner became the landlord party.
      expect(lease.parties).toEqual([
        expect.objectContaining({ contact: { id: tenant.id, name: 'Kojo Tenant' }, partyRole: 'tenant', isPrimary: true, liabilityShare: 100, portalAccess: true }),
        expect.objectContaining({ contact: { id: landlord.id, name: 'Ama Landlord' }, partyRole: 'landlord' }),
      ]);
      const guarantor = await contact();
      const withGuarantor = await as('pm').action(`/api/v1/leases/${lease.id}/parties`, lease.version, { contactId: guarantor.id, partyRole: 'guarantor', portalAccess: false }).expect(200);
      const edited = await as('pm').patch(`/api/v1/leases/${lease.id}`, withGuarantor.body.version, { rent: ghs('6100.00'), nextRentReviewDate: '2027-10-01' }).expect(200);
      expect(edited.body).toMatchObject({ rent: ghs('6100.00'), nextRentReviewDate: '2027-10-01' });

      const pending = await leaseAct('pm', lease.id, 'send-for-signature');
      expect(pending.status).toBe('pending_signature');
      // A second lease for overlapping dates is refused.
      const clash = await as('pm').post('/api/v1/leases', leaseBody(unitId, guarantor.id, { startDate: '2027-06-01', endDate: '2028-05-31' })).expect(422);
      expect(clash.body.errors[0]).toMatchObject({ field: 'startDate', code: 'unit-let', message: expect.stringContaining(lease.reference) });

      // Activation: property managers and the owner only; the signed copy is required (P7-D5) and must be clean.
      await leaseAct('agent', lease.id, 'activate', { signedOn: today() }, 403);
      const noDoc = await leaseAct('pm', lease.id, 'activate', { signedOn: today() }, 422);
      expect(noDoc.errors[0]).toMatchObject({ field: 'documentId', code: 'required' });
      const scanning = await upload('lease', lease.id, { scan: false });
      expect((await leaseAct('pm', lease.id, 'activate', { signedOn: today(), documentId: scanning.id }, 422)).errors[0]).toMatchObject({ code: 'scan-pending' });
      await worker.runOnce();
      const future = await leaseAct('pm', lease.id, 'activate', { signedOn: '2999-01-01', documentId: scanning.id }, 422);
      expect(future.errors[0]).toMatchObject({ field: 'signedOn', code: 'future' });
      const active = await leaseAct('pm', lease.id, 'activate', { signedOn: today(), documentId: scanning.id });
      expect(active).toMatchObject({ status: 'active', document: { id: scanning.id }, moveInDate: '2027-01-01', signedAt: expect.any(String) });
      const listing = await fx.db.selectFrom('listings').select(['status', 'isPublished']).where('id', '=', listingId).executeTakeFirstOrThrow();
      expect(listing).toEqual({ status: 'rented', isPublished: false });
      expect((await getAgreement(mgt.id)).liveLeases).toBe(1);

      // Terms and parties are fixed now; portal access is not.
      expect((await as('pm').patch(`/api/v1/leases/${lease.id}`, active.version, { rent: ghs('100.00') }).expect(422)).body.detail).toContain('rent reviews');
      await as('pm').delete(`/api/v1/leases/${lease.id}/parties/${guarantor.id}/guarantor`, active.version).expect(422);
      await as('pm').patch(`/api/v1/leases/${lease.id}/parties/${guarantor.id}/guarantor`, active.version, { liabilityShare: 10 }).expect(422);
      const portal = await as('pm').patch(`/api/v1/leases/${lease.id}/parties/${guarantor.id}/guarantor`, active.version, { portalAccess: true }).expect(200);
      expect(portal.body.parties.find((p: Body) => p.partyRole === 'guarantor').portalAccess).toBe(true);
      await leaseAct('pm', lease.id, 'cancel', { reason: 'Changed mind' }, 422);
      // The agreement cannot end while the lease is live.
      const blocked = await as('pm').action(`/api/v1/management-agreements/${mgt.id}/end`, (await getAgreement(mgt.id)).version, { endDate: '2027-12-31' }).expect(422);
      expect(blocked.body.detail).toContain(lease.reference);

      expect(await auditActions(lease.id)).toEqual(['lease.created', 'lease.party_added', 'lease.updated', 'lease.sent_for_signature', 'lease.activated', 'lease.party_updated']);
      const activation = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', lease.id).where('action', '=', 'lease.activated').executeTakeFirstOrThrow();
      expect(activation.metadata).toMatchObject({ documentId: scanning.id, signedDocumentRequired: true });
      const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', lease.id).orderBy('occurredAt').orderBy('entryNo').execute();
      expect(events.map((e) => e.eventType)).toEqual(['lease.created', 'lease.sent_for_signature', 'lease.activated']);
    });

    it('lets a company turn the signed-document rule off (P7-D5), cancels leases not yet active, and keeps parties consistent', async () => {
      const landlord = await contact();
      const tenant = await contact();
      const { unitId } = await place(landlord.id);
      await fx.db.insertInto('companySettings').values({ companyId: company.companyId, key: 'lettings.require_signed_lease', value: JSON.stringify(false) }).execute();
      try {
        const lease = (await as('owner').post('/api/v1/leases', leaseBody(unitId, tenant.id)).expect(201)).body as Body;
        const second = await contact();
        await as('owner').action(`/api/v1/leases/${lease.id}/parties`, lease.version, { contactId: second.id, partyRole: 'co_tenant', isPrimary: true }).expect(422);
        const coTenant = await as('owner').action(`/api/v1/leases/${lease.id}/parties`, lease.version, { contactId: second.id, partyRole: 'co_tenant' }).expect(200);
        await as('owner').delete(`/api/v1/leases/${lease.id}/parties/${tenant.id}/tenant`, coTenant.body.version).expect(422);
        const switched = await as('owner').patch(`/api/v1/leases/${lease.id}/parties/${second.id}/co_tenant`, coTenant.body.version, { isPrimary: true }).expect(200);
        expect(switched.body.primaryTenant).toEqual({ id: second.id, name: expect.any(String) });
        await leaseAct('owner', lease.id, 'send-for-signature');
        const back = await leaseAct('owner', lease.id, 'return-to-draft');
        expect(back.status).toBe('draft');
        await leaseAct('owner', lease.id, 'send-for-signature');
        const active = await leaseAct('owner', lease.id, 'activate', { signedOn: today() });
        expect(active).toMatchObject({ status: 'active', document: null });

        const other2 = (await as('owner').post('/api/v1/leases', leaseBody(unitId, tenant.id, { startDate: '2028-01-01', endDate: '2028-12-31' })).expect(201)).body as Body;
        await leaseAct('owner', other2.id, 'cancel', { reason: 'x' }, 422);
        const cancelled = await leaseAct('owner', other2.id, 'cancel', { reason: 'Tenant found another flat' });
        expect(cancelled).toMatchObject({ status: 'cancelled', endedReason: 'Tenant found another flat' });
        await leaseAct('owner', other2.id, 'send-for-signature', {}, 422);
      } finally {
        await fx.db.deleteFrom('companySettings').where('companyId', '=', company.companyId).where('key', '=', 'lettings.require_signed_lease').execute();
      }
    });

    it('lists leases in scope with filters and search, and never across companies', async () => {
      const landlord = await contact();
      const tenant = await contact(`Searchable ${randomUUID().slice(0, 4)}`);
      const { unitId, propertyId } = await place(landlord.id, members['officeB']);
      const lease = (await as('owner').post('/api/v1/leases', leaseBody(unitId, tenant.id)).expect(201)).body as Body;
      const ids = async (who: string, query: string) => ((await as(who).get(`/api/v1/leases?limit=100&${query}`).expect(200)).body.data as Body[]).map((l) => l.id);
      expect(await ids('owner', `filter[propertyId]=${propertyId}`)).toEqual([lease.id]);
      expect(await ids('owner', `q=${encodeURIComponent(tenant.id ? 'Searchable' : '')}`)).toContain(lease.id);
      expect(await ids('owner', `filter[contactId]=${tenant.id}`)).toEqual([lease.id]);
      expect(await ids('owner', `filter[status]=active&filter[propertyId]=${propertyId}`)).toEqual([]);
      expect(await ids('pmB', `filter[propertyId]=${propertyId}`)).toEqual([lease.id]);
      expect(await ids('pm', `filter[propertyId]=${propertyId}`)).toEqual([]);
      await as('pm').get(`/api/v1/leases/${lease.id}`).expect(404);
      await as('otherOwner').get(`/api/v1/leases/${lease.id}`).expect(404);
      expect(await ids('otherOwner', '')).not.toContain(lease.id);
      // Agents see the leases they drew up.
      const agentUnit = await place(landlord.id);
      const mine = (await as('agent').post('/api/v1/leases', leaseBody(agentUnit.unitId, tenant.id)).expect(201)).body as Body;
      expect(await ids('agent', '')).toEqual([mine.id]);
      await as('agent').post('/api/v1/leases', leaseBody(unitId, tenant.id, { startDate: '2029-01-01', endDate: '2029-12-31' })).expect(422);
      await as('accountant').post('/api/v1/leases', leaseBody(agentUnit.unitId, tenant.id)).expect(403);
    });
  });

  describe('letting deals become leases (P7-D4)', () => {
    async function agreedDeal() {
      const landlord = await contact();
      const tenant = await contact();
      const { unitId } = await place(landlord.id);
      const listingId = await rentListing(unitId);
      const deal = await as('owner').post('/api/v1/deals', { dealType: 'letting', primaryContactId: tenant.id, listingId }).expect(201);
      const offer = await as('owner').post('/api/v1/offers', { dealId: deal.body.id, offeredByContactId: tenant.id, amount: ghs('5800.00'), rentFrequency: 'monthly' }).expect(201);
      await as('owner').action(`/api/v1/offers/${offer.body.id}/accept`, offer.body.version).expect(200);
      const agreed = (await as('owner').get(`/api/v1/deals/${deal.body.id}`).expect(200)).body as Body;
      return { deal: agreed, tenant, landlord, listingId, unitId };
    }

    it('draws up the lease from the deal, activates it, and completes the deal once its milestones are done', async () => {
      const { deal, tenant, landlord, listingId } = await agreedDeal();
      const created = await as('owner').action(`/api/v1/deals/${deal.id}/lease`, deal.version, { leaseType: 'fixed_term', startDate: '2027-02-01', endDate: '2028-01-31' }).expect(201);
      const lease = created.body as Body;
      expect(lease).toMatchObject({ status: 'draft', rent: ghs('5800.00'), rentFrequency: 'monthly', deal: { id: deal.id }, listing: { id: listingId }, primaryTenant: { id: tenant.id } });
      expect(lease.parties.map((p: Body) => [p.contact.id, p.partyRole])).toEqual([[tenant.id, 'tenant'], [landlord.id, 'landlord']]);
      const atSigning = (await as('owner').get(`/api/v1/deals/${deal.id}`).expect(200)).body as Body;
      expect(atSigning).toMatchObject({ stage: { stageClass: 'contract' }, listing: { status: 'under_contract' } });
      await as('owner').action(`/api/v1/deals/${deal.id}/lease`, atSigning.version, { leaseType: 'fixed_term', startDate: '2027-02-01', endDate: '2028-01-31' }).expect(422);
      // The rent of a deal's lease is the accepted offer.
      await as('owner').patch(`/api/v1/leases/${lease.id}`, lease.version, { rent: ghs('9000.00') }).expect(422);

      const early = await as('owner').action(`/api/v1/deals/${deal.id}/complete`, atSigning.version, { completedOn: today() }).expect(422);
      expect(early.body.detail).toContain('not active');
      await leaseAct('owner', lease.id, 'send-for-signature');
      const doc = await upload('lease', lease.id);
      await leaseAct('owner', lease.id, 'activate', { signedOn: today(), documentId: doc.id });
      const afterActivation = (await as('owner').get(`/api/v1/deals/${deal.id}`).expect(200)).body as Body;
      expect(afterActivation.milestones.find((m: Body) => m.code === 'lease_signed').completedAt).not.toBeNull();
      expect(afterActivation.listing.status).toBe('rented');
      const incomplete = await as('owner').action(`/api/v1/deals/${deal.id}/complete`, afterActivation.version, { completedOn: today() }).expect(422);
      expect(incomplete.body.errors.map((e: Body) => e.field)).toEqual(expect.arrayContaining(['milestones.references_checked', 'milestones.move_in_inspection']));
      await fx.db.updateTable('dealMilestones').set({ completedAt: new Date(), completedBy: members['owner'] }).where('dealId', '=', deal.id).where('completedAt', 'is', null).execute();
      await as('manager').action(`/api/v1/deals/${deal.id}/complete`, afterActivation.version, { completedOn: today() }).expect(200);
      const won = (await as('owner').get(`/api/v1/deals/${deal.id}`).expect(200)).body as Body;
      expect(won).toMatchObject({ status: 'won', stage: { stageClass: 'closed_won' } });
      const actions = (await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', deal.id).orderBy('occurredAt').orderBy('entryNo').execute()).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['deal.stage_changed', 'deal.milestone_completed', 'deal.won']));
    });

    it('losing a letting deal cancels its draft lease, but not one awaiting signature', async () => {
      const first = await agreedDeal();
      const draft = (await as('owner').action(`/api/v1/deals/${first.deal.id}/lease`, first.deal.version, { leaseType: 'periodic', startDate: '2027-03-01' }).expect(201)).body as Body;
      const atSigning = (await as('owner').get(`/api/v1/deals/${first.deal.id}`).expect(200)).body as Body;
      await as('manager').action(`/api/v1/deals/${first.deal.id}/lose`, atSigning.version, { lostReasonCode: 'price' }).expect(200);
      expect((await getLease(draft.id)).status).toBe('cancelled');
      expect((await fx.db.selectFrom('listings').select('status').where('id', '=', first.listingId).executeTakeFirstOrThrow()).status).toBe('available');

      const second = await agreedDeal();
      const lease = (await as('owner').action(`/api/v1/deals/${second.deal.id}/lease`, second.deal.version, { leaseType: 'periodic', startDate: '2027-03-01' }).expect(201)).body as Body;
      await leaseAct('owner', lease.id, 'send-for-signature');
      const current = (await as('owner').get(`/api/v1/deals/${second.deal.id}`).expect(200)).body as Body;
      const refused = await as('manager').action(`/api/v1/deals/${second.deal.id}/lose`, current.version, { lostReasonCode: 'price' }).expect(422);
      expect(refused.body.detail).toContain(lease.reference);
    });

    it('refuses deals that are not letting deals at terms agreed, and members without lease.create', async () => {
      const { deal } = await agreedDeal();
      await as('accountant').action(`/api/v1/deals/${deal.id}/lease`, deal.version, { leaseType: 'periodic', startDate: '2027-03-01' }).expect(403);
      const tenant = await contact();
      const early = await as('owner').post('/api/v1/deals', { dealType: 'letting', primaryContactId: tenant.id }).expect(201);
      const notAgreed = await as('owner').action(`/api/v1/deals/${early.body.id}/lease`, early.body.version, { leaseType: 'periodic', startDate: '2027-03-01' }).expect(422);
      expect(notAgreed.body.detail).toContain('terms are agreed');
    });
  });
});
