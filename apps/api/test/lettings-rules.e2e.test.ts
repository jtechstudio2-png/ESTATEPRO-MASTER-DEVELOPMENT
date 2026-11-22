import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScannerUnavailableError } from '../src/media/scanner.js';
import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { pdf, png, sha256Hex } from './support/media-files.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let counter = 0;
const nextPhone = () => `024${String(7500000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });
const codes = (body: Body) => (body.errors as Array<{ field: string; code: string }>).map((e) => `${e.field}:${e.code}`);

/**
 * L1 refusals: every rule the agreement, lease and document services check
 * before the database does, answered with its field and code (ADR-003), and
 * the scan outcomes of the document worker.
 */
describe('L1 rules: refusals and scan outcomes', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Company;
  const tokens: Record<string, string> = {};
  let pmMembership = '';

  const as = (who: string) => {
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
      patch: (path: string, version: number, body: object) => auth(t.http.patch(path)).set('If-Match', `"${version}"`).send(body),
      delete: (path: string, version: number) => auth(t.http.delete(path)).set('If-Match', `"${version}"`),
    };
  };

  async function contact() {
    return (await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: `Rule ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone() }).expect(201)).body as { id: string };
  }

  async function property(units = 2, owner?: string) {
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'apartment_building').executeTakeFirstOrThrow()).id;
    const created = await as('owner')
      .post('/api/v1/properties', { name: `Rules Court ${counter}`, propertyTypeId: typeId, officeId: company.officeId, address: { countryCode: 'GH', addressLine1: `${counter++} Rules Road`, locality: 'Accra', adminArea1: 'Greater Accra' } })
      .expect(201);
    const unitIds: string[] = [];
    for (let i = 0; i < units; i += 1) unitIds.push((await as('owner').post(`/api/v1/properties/${created.body.id}/units`, { unitLabel: `Flat ${i + 1}`, bedrooms: 2 }).expect(201)).body.id);
    if (owner) await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: created.body.id, ownerContactId: owner, effectiveFrom: '2020-01-01', ownershipType: 'legal_owner' }).execute();
    return { propertyId: created.body.id as string, unitIds };
  }

  async function uploadTicket(entityType: string, entityId: string, file: Buffer, contentType = 'application/pdf', who = 'owner') {
    const res = await as(who).post('/api/v1/documents/uploads', { entityType, entityId, title: 'Signed', documentTypeCode: entityType === 'lease' ? 'lease' : 'management_agreement', isSigned: true, fileName: 'f', contentType, size: file.length, sha256: sha256Hex(file) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; uploadUrl: string };
  }

  async function document(entityType: string, entityId: string, file = pdf(), contentType = 'application/pdf') {
    const ticket = await uploadTicket(entityType, entityId, file, contentType);
    await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
    const doc = (await as('owner').post(`/api/v1/documents/uploads/${ticket.id}/confirm`).expect(201)).body as { id: string };
    await worker.runOnce();
    return doc;
  }

  const draftAgreement = (landlordContactId: string, propertyId: string, extra: Record<string, unknown> = {}) => ({
    landlordContactId,
    propertyId,
    serviceLevel: 'fully_managed',
    currencyCode: 'GHS',
    feeBasis: 'percent_of_rent_collected',
    feePercent: 10,
    startDate: '2026-01-01',
    ...extra,
  });

  const lease = (unitId: string, tenantId: string, extra: Record<string, unknown> = {}) => ({
    unitId,
    leaseType: 'fixed_term',
    startDate: '2027-01-01',
    endDate: '2027-12-31',
    rent: ghs('5000.00'),
    rentFrequency: 'monthly',
    parties: [{ contactId: tenantId, partyRole: 'tenant', isPrimary: true }],
    ...extra,
  });

  const getLease = async (id: string) => (await as('owner').get(`/api/v1/leases/${id}`).expect(200)).body as Body;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, jobTypes: ['document.scan'] }));
    company = await fx.company();
    const pm = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    pmMembership = pm.membershipId;
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId] of [['owner', company.ownerUserId], ['pm', pm.userId]] as const) {
      await fx.linkIdentity(userId, `l1r-${name}-${company.companyId}`);
      tokens[name] = await t.idp.token({ sub: `l1r-${name}-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  it('checks agreement terms, landlords, units, money and dates, and the life cycle of each action', async () => {
    const landlord = await contact();
    const { propertyId, unitIds } = await property(2);
    const otherProperty = await property(1);
    const bad = await as('owner')
      .post('/api/v1/management-agreements', draftAgreement(randomUUID(), propertyId, { unitId: otherProperty.unitIds[0], feeBasis: 'fixed_per_period', feePercent: undefined, expenseApprovalLimit: { amount: '10.123', currency: 'GHS' }, floatAmount: { amount: '5.00', currency: 'USD' }, startDate: '2026-02-30', endDate: '2025-01-01' }))
      .expect(422);
    expect(codes(bad.body)).toEqual(expect.arrayContaining(['landlordContactId:not-found', 'unitId:not-found', 'feeFixed:required', 'expenseApprovalLimit.amount:precision', 'floatAmount.currency:currency-mismatch', 'startDate:invalid']));
    const backwards = await as('owner').post('/api/v1/management-agreements', draftAgreement(landlord.id, propertyId, { endDate: '2025-01-01' })).expect(422);
    expect(codes(backwards.body)).toEqual(['endDate:before-start']);
    await as('owner').post('/api/v1/management-agreements', draftAgreement(landlord.id, randomUUID())).expect(422);
    const archived = await contact();
    await fx.db.updateTable('contacts').set({ archivedAt: new Date() }).where('id', '=', archived.id).execute();
    expect(codes((await as('owner').post('/api/v1/management-agreements', draftAgreement(archived.id, propertyId)).expect(422)).body)).toEqual(['landlordContactId:not-active']);

    const draft = (await as('owner').post('/api/v1/management-agreements', draftAgreement(landlord.id, propertyId, { unitId: unitIds[0], floatAmount: ghs('100.00'), noticePeriodDays: 30 })).expect(201)).body as Body;
    // Draft edits: whole property, fixed fee, cleared limit; nothing changed returns the record as is.
    const same = await as('owner').patch(`/api/v1/management-agreements/${draft.id}`, draft.version, {}).expect(200);
    expect(same.body.version).toBe(draft.version);
    const edited = await as('owner').patch(`/api/v1/management-agreements/${draft.id}`, draft.version, { unitId: null, feeBasis: 'fixed_per_period', feePercent: null, feeFixed: ghs('300.00'), expenseApprovalLimit: null, startDate: '2026-02-01', endDate: null, noticePeriodDays: null, payoutFrequency: 'quarterly' }).expect(200);
    expect(edited.body).toMatchObject({ unit: null, fee: { basis: 'fixed_per_period', percent: null, fixed: ghs('300.00') }, payoutFrequency: 'quarterly', noticePeriodDays: null });
    await as('owner').patch(`/api/v1/management-agreements/${draft.id}`, draft.version, { feePercent: 5 }).expect(412);
    // Wrong states.
    await as('owner').action(`/api/v1/management-agreements/${draft.id}/suspend`, edited.body.version).expect(422);
    expect((await as('owner').action(`/api/v1/management-agreements/${draft.id}/end`, edited.body.version, { endDate: '2027-01-01' }).expect(422)).body.detail).toContain('never in force');
    // The landlord was erased meanwhile: activation names the problem.
    const doc = await document('management_agreement', draft.id);
    await fx.db.updateTable('contacts').set({ archivedAt: new Date() }).where('id', '=', landlord.id).execute();
    expect(codes((await as('owner').action(`/api/v1/management-agreements/${draft.id}/activate`, edited.body.version, { documentId: doc.id }).expect(422)).body)).toEqual(['landlordContactId:not-active']);
    await fx.db.updateTable('contacts').set({ archivedAt: null }).where('id', '=', landlord.id).execute();
    const active = await as('owner').action(`/api/v1/management-agreements/${draft.id}/activate`, edited.body.version, { documentId: doc.id }).expect(200);
    await as('owner').action(`/api/v1/management-agreements/${draft.id}/activate`, active.body.version, { documentId: doc.id }).expect(422);
    await as('owner').action(`/api/v1/management-agreements/${draft.id}/end`, active.body.version, { endDate: '2026-02-31' }).expect(422);
    const ended = await as('owner').action(`/api/v1/management-agreements/${draft.id}/end`, active.body.version, { endDate: '2027-01-31' }).expect(200);
    expect((await as('owner').patch(`/api/v1/management-agreements/${draft.id}`, ended.body.version, { payoutDay: 2 }).expect(422)).body.detail).toContain('ended');
    expect((await as('owner').action(`/api/v1/management-agreements/${draft.id}/end`, ended.body.version, { endDate: '2027-01-31' }).expect(422)).body.detail).toContain('already ended');
    await as('owner').get(`/api/v1/management-agreements/${randomUUID()}`).expect(404);
    await as('owner').get('/api/v1/management-agreements?q=MGA&sort=startDate').expect(200);
    // An archived property takes no new agreement.
    await fx.db.updateTable('properties').set({ archivedAt: new Date() }).where('id', '=', otherProperty.propertyId).execute();
    expect((await as('owner').post('/api/v1/management-agreements', draftAgreement(landlord.id, otherProperty.propertyId)).expect(422)).body.detail).toContain('archived');
  });

  it('checks lease terms, listings, agreements, parties and the state of each action', async () => {
    const landlord = await contact();
    const tenant = await contact();
    const { propertyId, unitIds } = await property(3, landlord.id);
    const [u1, u2, u3] = unitIds as [string, string, string];
    const agreement = (await as('owner').post('/api/v1/management-agreements', draftAgreement(landlord.id, propertyId, { unitId: u1, currencyCode: 'USD', feePercent: 8 })).expect(201)).body as Body;
    const listing = await fx.listing(company.companyId, u2, pmMembership, company.officeId);

    const bad = await as('pm')
      .post('/api/v1/leases', lease(u2, tenant.id, {
        managementAgreementId: agreement.id,
        listingId: listing.id,
        startDate: '2027-01-01',
        endDate: '2026-01-01',
        deposit: { amount: '1.00', currency: 'USD' },
        governingLocaleCode: 'xx-XX',
        breakClauseDate: '2026-06-01',
        nextRentReviewDate: '2027-13-01',
        parties: [
          { contactId: tenant.id, partyRole: 'tenant', isPrimary: true },
          { contactId: tenant.id, partyRole: 'tenant' },
          { contactId: landlord.id, partyRole: 'landlord', isPrimary: true, liabilityShare: 10 },
          { contactId: randomUUID(), partyRole: 'guarantor' },
        ],
      }))
      .expect(422);
    expect(codes(bad.body)).toEqual(
      expect.arrayContaining([
        'endDate:before-start', 'deposit.currency:currency-mismatch', 'governingLocaleCode:unknown-locale', 'breakClauseDate:before-start', 'nextRentReviewDate:invalid',
        'managementAgreementId:not-covering', 'listingId:not-found', 'parties.1:duplicate', 'parties.2.isPrimary:not-tenant', 'parties.2.liabilityShare:not-tenant', 'parties.3.contactId:not-found',
      ]),
    );
    const currency = await as('pm').post('/api/v1/leases', lease(u1, tenant.id, { managementAgreementId: agreement.id })).expect(422);
    expect(codes(currency.body)).toEqual(['rent.currency:currency-mismatch']);
    await as('pm').post('/api/v1/leases', lease(randomUUID(), tenant.id)).expect(422);

    // A rent listing with an accepted offer belongs to its deal.
    await fx.db.updateTable('listings').set({ listingType: 'rent', rentFrequency: 'monthly', price: '5000.00' }).where('id', '=', listing.id).execute();
    const applicant = await contact();
    const deal = await as('owner').post('/api/v1/deals', { dealType: 'letting', primaryContactId: applicant.id, listingId: listing.id }).expect(201);
    const offer = await as('owner').post('/api/v1/offers', { dealId: deal.body.id, offeredByContactId: applicant.id, amount: ghs('5000.00'), rentFrequency: 'monthly' }).expect(201);
    await as('owner').action(`/api/v1/offers/${offer.body.id}/accept`, offer.body.version).expect(200);
    expect(codes((await as('pm').post('/api/v1/leases', lease(u2, tenant.id, { listingId: listing.id })).expect(422)).body)).toEqual(['listingId:offer-accepted']);

    // A closed listing, an ended agreement.
    const closedListing = await fx.listing(company.companyId, u3, pmMembership, company.officeId);
    await fx.db.updateTable('listings').set({ listingType: 'rent', rentFrequency: 'monthly', status: 'withdrawn' }).where('id', '=', closedListing.id).execute();
    expect(codes((await as('pm').post('/api/v1/leases', lease(u3, tenant.id, { listingId: closedListing.id })).expect(422)).body)).toEqual(['listingId:closed']);
    const ended = (await as('owner').post('/api/v1/management-agreements', draftAgreement(landlord.id, propertyId, { unitId: u3 })).expect(201)).body as Body;
    const doc = await document('management_agreement', ended.id);
    const activated = await as('owner').action(`/api/v1/management-agreements/${ended.id}/activate`, ended.version, { documentId: doc.id }).expect(200);
    const draftUnderIt = (await as('pm').post('/api/v1/leases', lease(u3, tenant.id, { managementAgreementId: ended.id })).expect(201)).body as Body;
    // Suspended agreement: activation refused with its reference.
    await as('pm').action(`/api/v1/leases/${draftUnderIt.id}/send-for-signature`, draftUnderIt.version).expect(200);
    const suspended = await as('owner').action(`/api/v1/management-agreements/${ended.id}/suspend`, activated.body.version).expect(200);
    const leaseDoc = await document('lease', draftUnderIt.id);
    const pending = await getLease(draftUnderIt.id);
    expect((await as('owner').action(`/api/v1/leases/${draftUnderIt.id}/activate`, pending.version, { signedOn: '2026-01-01', documentId: leaseDoc.id }).expect(422)).body.detail).toContain('suspended');
    await as('owner').action(`/api/v1/leases/${draftUnderIt.id}/activate`, pending.version, { signedOn: '2026-02-30', moveInDate: '2027-02-30' }).expect(422);
    await as('pm').action(`/api/v1/leases/${draftUnderIt.id}/cancel`, pending.version, { reason: 'Agreement suspended' }).expect(200);
    const endedAgreement = await as('owner').action(`/api/v1/management-agreements/${ended.id}/end`, suspended.body.version, { endDate: '2026-12-31' }).expect(200);
    expect(endedAgreement.body.status).toBe('ended');
    expect(codes((await as('pm').post('/api/v1/leases', lease(u3, tenant.id, { managementAgreementId: ended.id })).expect(422)).body)).toEqual(['managementAgreementId:ended']);

    // Parties and life-cycle states on a draft.
    const draft = (await as('pm').post('/api/v1/leases', lease(u3, tenant.id, { leaseType: 'periodic', endDate: undefined })).expect(201)).body as Body;
    await as('pm').action(`/api/v1/leases/${draft.id}/return-to-draft`, draft.version).expect(422);
    await as('pm').action(`/api/v1/leases/${draft.id}/activate`, draft.version, { signedOn: '2026-01-01' }).expect(422);
    await as('pm').patch(`/api/v1/leases/${draft.id}/parties/${randomUUID()}/tenant`, draft.version, { portalAccess: false }).expect(404);
    await as('pm').patch(`/api/v1/leases/${draft.id}/parties/${tenant.id}/nobody`, draft.version, {}).expect(404);
    await as('pm').delete(`/api/v1/leases/${draft.id}/parties/${tenant.id}/nobody`, draft.version).expect(404);
    await as('pm').delete(`/api/v1/leases/${draft.id}/parties/${randomUUID()}/tenant`, draft.version).expect(404);
    const occupant = await contact();
    const withOccupant = await as('pm').action(`/api/v1/leases/${draft.id}/parties`, draft.version, { contactId: occupant.id, partyRole: 'occupant' }).expect(200);
    expect(codes((await as('pm').patch(`/api/v1/leases/${draft.id}/parties/${occupant.id}/occupant`, withOccupant.body.version, { isPrimary: true }).expect(422)).body)).toEqual(['isPrimary:not-tenant']);
    const unchanged = await as('pm').patch(`/api/v1/leases/${draft.id}/parties/${occupant.id}/occupant`, withOccupant.body.version, { portalAccess: true }).expect(200);
    expect(unchanged.body.version).toBe(withOccupant.body.version);
    const shared = await as('pm').patch(`/api/v1/leases/${draft.id}/parties/${tenant.id}/tenant`, withOccupant.body.version, { liabilityShare: 50 }).expect(200);
    const cleared = await as('pm').patch(`/api/v1/leases/${draft.id}/parties/${tenant.id}/tenant`, shared.body.version, { liabilityShare: null }).expect(200);
    const removed = await as('pm').delete(`/api/v1/leases/${draft.id}/parties/${occupant.id}/occupant`, cleared.body.version).expect(200);
    expect(removed.body.parties.map((p: Body) => p.partyRole)).toEqual(['tenant', 'landlord']);
    const merged = await contact();
    await fx.db.updateTable('contacts').set({ mergedIntoContactId: tenant.id, archivedAt: new Date() }).where('id', '=', merged.id).execute();
    expect(codes((await as('pm').action(`/api/v1/leases/${draft.id}/parties`, removed.body.version, { contactId: merged.id, partyRole: 'guarantor' }).expect(422)).body)).toEqual(['parties.0.contactId:not-active']);
    // Draft edits: nothing changed, changed listing on a lease without a deal, periodic end date.
    const same = await as('pm').patch(`/api/v1/leases/${draft.id}`, removed.body.version, {}).expect(200);
    expect(same.body.version).toBe(removed.body.version);
    const edited = await as('pm').patch(`/api/v1/leases/${draft.id}`, removed.body.version, { usage: 'commercial', rentFrequency: 'quarterly', advancePeriods: 2, prorateFirstPeriod: false, deposit: null, noticePeriodDays: 90, breakNoticeDays: 30, governingLocaleCode: 'en-GH', rentDueDay: null }).expect(200);
    expect(edited.body).toMatchObject({ usage: 'commercial', rentFrequency: 'quarterly', advancePeriods: 2, prorateFirstPeriod: false, deposit: null, governingLocaleCode: 'en-GH' });

    // A unit with no recorded owner cannot be sent for signature without a landlord.
    const ownerless = await property(1);
    const noLandlord = (await as('pm').post('/api/v1/leases', lease(ownerless.unitIds[0]!, tenant.id)).expect(201)).body as Body;
    expect(codes((await as('pm').action(`/api/v1/leases/${noLandlord.id}/send-for-signature`, noLandlord.version).expect(422)).body)).toEqual(['parties:landlord']);
    await as('pm').action(`/api/v1/leases/${noLandlord.id}/cancel`, noLandlord.version, { reason: 'No owner' }).expect(200);
    const cancelled = await getLease(noLandlord.id);
    await as('pm').patch(`/api/v1/leases/${noLandlord.id}`, cancelled.version, { advancePeriods: 3 }).expect(422);
    await as('pm').patch(`/api/v1/leases/${noLandlord.id}/parties/${tenant.id}/tenant`, cancelled.version, { portalAccess: false }).expect(422);
    await as('pm').get(`/api/v1/leases/${randomUUID()}`).expect(404);
    // An archived unit takes no lease.
    await fx.db.updateTable('units').set({ archivedAt: new Date() }).where('id', '=', ownerless.unitIds[0]!).execute();
    expect((await as('pm').post('/api/v1/leases', lease(ownerless.unitIds[0]!, tenant.id)).expect(422)).body.detail).toContain('archived');
  });

  it('handles uploads that are confirmed twice, by someone else, never uploaded, of the wrong size, expired, or that fail the checks', async () => {
    const landlord = await contact();
    const { propertyId } = await property(1);
    const agreement = (await as('owner').post('/api/v1/management-agreements', draftAgreement(landlord.id, propertyId)).expect(201)).body as Body;
    const file = pdf();
    // Not uploaded yet, then confirmed twice (the second returns the same document), not by another member.
    const ticket = await uploadTicket('management_agreement', agreement.id, file);
    expect((await as('owner').post(`/api/v1/documents/uploads/${ticket.id}/confirm`).expect(422)).body.detail).toContain('not been uploaded');
    await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
    await as('pm').post(`/api/v1/documents/uploads/${ticket.id}/confirm`).expect(403);
    const first = (await as('owner').post(`/api/v1/documents/uploads/${ticket.id}/confirm`).expect(201)).body as Body;
    const again = (await as('owner').post(`/api/v1/documents/uploads/${ticket.id}/confirm`).expect(201)).body as Body;
    expect(again.id).toBe(first.id);
    await as('owner').post(`/api/v1/documents/uploads/${randomUUID()}/confirm`).expect(404);
    await as('owner').get(`/api/v1/documents/${randomUUID()}`).expect(404);
    // Wrong size: cancelled; then expired.
    const short = await uploadTicket('management_agreement', agreement.id, file);
    await fetch(short.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file.subarray(0, 100) }).catch(() => undefined);
    const stored = await fx.db.selectFrom('documentUploadSessions').select('storageKey').where('id', '=', short.id).executeTakeFirstOrThrow();
    const storage = (await import('../src/media/storage.js')).S3Storage.fromConfig(t.config);
    try {
      await storage.write(stored.storageKey, file.subarray(0, 100), 'application/pdf');
    } finally {
      storage.destroy();
    }
    expect((await as('owner').post(`/api/v1/documents/uploads/${short.id}/confirm`).expect(422)).body.detail).toContain('declared size');
    expect((await as('owner').post(`/api/v1/documents/uploads/${short.id}/confirm`).expect(422)).body.detail).toContain('cancelled');
    const late = await uploadTicket('management_agreement', agreement.id, file);
    await fx.db.updateTable('documentUploadSessions').set({ expiresAt: new Date(Date.now() - 1000) }).where('id', '=', late.id).execute();
    expect((await as('owner').post(`/api/v1/documents/uploads/${late.id}/confirm`).expect(422)).body.detail).toContain('expired');
    await as('owner').post('/api/v1/documents/uploads', { entityType: 'management_agreement', entityId: agreement.id, title: 'Big', documentTypeCode: 'management_agreement', fileName: 'big.pdf', contentType: 'application/pdf', size: 900_000_000, sha256: 'a'.repeat(64) }).expect(422);

    // The content does not match the declared type: failed, the file removed.
    const image = await png(40, 40);
    const mislabelled = await document('management_agreement', agreement.id, image, 'image/jpeg');
    expect((await as('owner').get(`/api/v1/documents/${mislabelled.id}`).expect(200)).body.scanStatus).toBe('failed');
    const rejected = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', mislabelled.id).where('action', '=', 'document.rejected').executeTakeFirstOrThrow();
    expect(rejected.metadata).toMatchObject({ code: 'type-mismatch', scanStatus: 'failed' });
    // An unsigned document cannot activate; a failed one neither.
    expect(codes((await as('owner').action(`/api/v1/management-agreements/${agreement.id}/activate`, agreement.version, { documentId: mislabelled.id }).expect(422)).body)).toEqual(['documentId:scan-failed']);

    // The scanner is down: the version stays pending, then fails after the last attempt.
    const down = createWorker(t.config, silent, { scanner: { scan: () => Promise.reject(new ScannerUnavailableError('clamd unavailable')) }, scheduleEveryMs: 60_000, jobTypes: ['document.scan'] });
    try {
      const pendingTicket = await uploadTicket('management_agreement', agreement.id, file);
      await fetch(pendingTicket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
      const pendingDoc = (await as('owner').post(`/api/v1/documents/uploads/${pendingTicket.id}/confirm`).expect(201)).body as Body;
      await down.worker.runOnce();
      const job = await fx.db.selectFrom('scheduledJobs').selectAll().where('entityId', '=', pendingDoc.id).executeTakeFirstOrThrow();
      expect(job).toMatchObject({ status: 'pending', attempts: 1 });
      await fx.db.updateTable('scheduledJobs').set({ runAt: new Date(), maxAttempts: 2 }).where('id', '=', job.id).execute();
      await down.worker.runOnce();
      expect((await as('owner').get(`/api/v1/documents/${pendingDoc.id}`).expect(200)).body.scanStatus).toBe('failed');
    } finally {
      await down.close();
    }
    // A missing file fails the check (the object vanished before the scan).
    const vanished = await uploadTicket('management_agreement', agreement.id, file);
    await fetch(vanished.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: file });
    const vanishedDoc = (await as('owner').post(`/api/v1/documents/uploads/${vanished.id}/confirm`).expect(201)).body as Body;
    const key = (await fx.db.selectFrom('documentUploadSessions').select('storageKey').where('id', '=', vanished.id).executeTakeFirstOrThrow()).storageKey;
    const cleaner = (await import('../src/media/storage.js')).S3Storage.fromConfig(t.config);
    try {
      await cleaner.remove([key]);
    } finally {
      cleaner.destroy();
    }
    await worker.runOnce();
    expect((await as('owner').get(`/api/v1/documents/${vanishedDoc.id}`).expect(200)).body.scanStatus).toBe('failed');
  });
});
