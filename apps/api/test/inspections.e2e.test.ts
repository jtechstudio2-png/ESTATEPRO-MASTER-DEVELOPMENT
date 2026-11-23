import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { pdf, png, sha256Hex } from './support/media-files.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let counter = 0;
const nextPhone = () => `024${String(8500000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });

/**
 * Phase 7 milestone L4: inspections (LET-09; IN-1 to IN-3; readiness §5.7;
 * W7-S1): scheduling in scope, items copied from the unit's last inspection,
 * recording by the inspector, photos of an item (scanned documents of the
 * inspection), completion, the move-in condition beside each item of a
 * move-out inspection, the tenant's acknowledgement and cancellation.
 */
describe('L4: inspections', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Company;
  let other: Company;
  let officeB: string;
  let staffMembership: string;
  let pmMembership: string;
  const tokens: Record<string, string> = {};

  const as = (who: string) => {
    const companyId = who === 'otherOwner' ? other.companyId : company.companyId;
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      put: (path: string, version: number, body: object) => auth(t.http.put(path)).set('If-Match', `"${version}"`).send(body),
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
      patch: (path: string, version: number, body: object) => auth(t.http.patch(path)).set('If-Match', `"${version}"`).send(body),
      del: (path: string, version: number) => auth(t.http.delete(path)).set('If-Match', `"${version}"`),
    };
  };
  const codes = (res: { body: Body }) => (res.body.errors ?? []).map((e: Body) => `${e.field}:${e.code}`);
  const get = async (id: string, who = 'owner') => (await as(who).get(`/api/v1/inspections/${id}`).expect(200)).body as Body;

  async function contact(name = `Party ${randomUUID().slice(0, 6)}`) {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function unitWithLease(officeId = company.officeId) {
    const landlord = await contact();
    const tenant = await contact();
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: `Inspection Villa ${counter}`, propertyTypeId: typeId, officeId, createWholePropertyUnit: true,
        address: { countryCode: 'GH', addressLine1: `${counter++} Inspection Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: property.body.id, ownerContactId: landlord.id, effectiveFrom: '2020-01-01', ownershipType: 'legal_owner' }).execute();
    const created = await as('owner').post('/api/v1/leases', {
      unitId, leaseType: 'fixed_term', startDate: '2026-06-01', endDate: '2026-08-31', rent: ghs('3000.00'), rentFrequency: 'monthly',
      parties: [{ contactId: tenant.id, partyRole: 'tenant', isPrimary: true }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    for (const [action, body] of [['send-for-signature', {}], ['activate', { signedOn: '2026-05-20' }]] as const) {
      const lease = (await as('owner').get(`/api/v1/leases/${created.body.id}`).expect(200)).body;
      await as('owner').action(`/api/v1/leases/${created.body.id}/${action}`, lease.version, body).expect(200);
    }
    return { propertyId: property.body.id as string, unitId, leaseId: created.body.id as string };
  }

  async function schedule(body: object, who = 'owner', expected = 201) {
    const res = await as(who).post('/api/v1/inspections', body);
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return res.body as Body;
  }

  async function photo(inspectionId: string, options: { file?: Buffer; contentType?: string; scan?: boolean } = {}) {
    const file = options.file ?? (await png(800, 600, '#cc8844'));
    const contentType = options.contentType ?? 'image/png';
    const ticket = await as('owner').post('/api/v1/documents/uploads', {
      entityType: 'inspection', entityId: inspectionId, title: 'Window', documentTypeCode: 'inspection_photo', isSigned: false,
      fileName: contentType === 'image/png' ? 'window.png' : 'report.pdf', contentType, size: file.length, sha256: sha256Hex(file),
    });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    expect((await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file })).status).toBe(200);
    const confirmed = await as('owner').post(`/api/v1/documents/uploads/${ticket.body.id}/confirm`).expect(201);
    if (options.scan ?? true) await worker.runOnce();
    return confirmed.body.id as string;
  }

  const items = (list: Array<[string, string, string | null]>) => list.map(([area, item, conditionCode]) => ({ area, item, conditionCode }));
  const auditActions = async (entityId: string) =>
    (await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', entityId).orderBy('occurredAt').orderBy('entryNo').execute()).map((row) => row.action);

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0, jobTypes: ['document.scan'] }));
    company = await fx.company();
    other = await fx.company();
    officeB = (await fx.office(company.companyId, `L4I${counter++}`)).id;
    const pm = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    pmMembership = pm.membershipId;
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const staff = await fx.member(company.companyId, { roleKey: 'maintenance_staff', officeIds: [company.officeId] });
    staffMembership = staff.membershipId;
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['pm', pm.userId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['staff', staff.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `l4i-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `l4i-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    await as('owner').put('/api/v1/settings/lettings', 0, { chargeLeadDays: null, requireSignedLease: false }).expect(200);
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  it('keeps the default inspection areas in the lettings settings (ST-2)', async () => {
    expect(codes(await as('owner').put('/api/v1/settings/lettings', 0, { chargeLeadDays: null, requireSignedLease: false, inspectionAreas: ['Kitchen', ' kitchen '] }))).toEqual(['inspectionAreas.1:duplicate']);
    const saved = await as('owner').put('/api/v1/settings/lettings', 0, { chargeLeadDays: null, requireSignedLease: false, inspectionAreas: ['Kitchen', 'Living room', 'Bedroom 1'] }).expect(200);
    expect(saved.body.inspectionAreas).toEqual(['Kitchen', 'Living room', 'Bedroom 1']);
    const kept = await as('owner').put('/api/v1/settings/lettings', 0, { chargeLeadDays: null, requireSignedLease: false }).expect(200);
    expect(kept.body.inspectionAreas).toEqual(['Kitchen', 'Living room', 'Bedroom 1']);
  });

  it('schedules in scope, records, photographs and completes a move-in inspection, then compares the move-out', async () => {
    const { propertyId, unitId, leaseId } = await unitWithLease();
    const scheduledAt = '2026-06-01T09:00:00Z';
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId, unitId, inspectionType: 'move_in', scheduledAt }))).toEqual(['leaseId:required']);
    const elsewhere = await unitWithLease();
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId, unitId, leaseId: elsewhere.leaseId, inspectionType: 'move_in', scheduledAt }))).toEqual(['leaseId:other-unit']);
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId, unitId, inspectionType: 'periodic', scheduledAt, inspectorMembershipId: randomUUID() }))).toEqual(['inspectorMembershipId:not-found']);
    expect((await as('agent').post('/api/v1/inspections', { propertyId, unitId, inspectionType: 'periodic', scheduledAt })).status).toBe(403);
    const officeBProperty = await unitWithLease(officeB);
    expect(codes(await as('pm').post('/api/v1/inspections', { propertyId: officeBProperty.propertyId, unitId: officeBProperty.unitId, inspectionType: 'periodic', scheduledAt }))).toEqual(['propertyId:not-found']);

    const moveIn = await schedule({ propertyId, unitId, leaseId, inspectionType: 'move_in', scheduledAt, inspectorMembershipId: pmMembership }, 'pm');
    expect(moveIn).toMatchObject({ status: 'scheduled', inspectionType: 'move_in', lease: { id: leaseId }, inspector: { id: pmMembership }, items: [], canEdit: true });
    expect(moveIn.reference).toMatch(/^INS-/);
    expect(codes(await as('owner').post('/api/v1/inspections', { propertyId, unitId, leaseId, inspectionType: 'move_in', scheduledAt }))).toEqual(['inspectionType:duplicate']);

    // Recording: items, then start; the inspector alone changes it once in progress (owner sees all).
    let current = moveIn;
    let res = await as('pm').put(`/api/v1/inspections/${current.id}/items`, current.version, { items: items([['Kitchen', 'Oven', null], ['kitchen', 'oven', null]]) });
    expect(codes(res)).toEqual(['items.1.item:duplicate']);
    res = await as('pm').put(`/api/v1/inspections/${current.id}/items`, current.version, { items: [...items([['Kitchen', 'Oven', null]]), { id: randomUUID(), area: 'Hall', item: 'Door' }] });
    expect(codes(res)).toEqual(['items.1.id:not-found']);
    res = await as('pm').put(`/api/v1/inspections/${current.id}/items`, current.version, { items: items([['Kitchen', 'Oven', 'good'], ['Living room', 'Window', null], ['Hall', 'Door', 'good']]) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    current = res.body;
    expect(current.items.map((item: Body) => item.item)).toEqual(['Oven', 'Window', 'Door']);
    expect(codes(await as('pm').action(`/api/v1/inspections/${current.id}/complete`, current.version))).toEqual([]);
    res = await as('pm').patch(`/api/v1/inspections/${current.id}`, current.version, { action: 'start', summary: 'Tenant present' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    current = res.body;
    expect(current).toMatchObject({ status: 'in_progress', summary: 'Tenant present' });
    expect(codes(await as('pm').patch(`/api/v1/inspections/${current.id}`, current.version, { scheduledAt: '2026-06-02T09:00:00Z' }))).toEqual(['scheduledAt:started']);

    // Photos: a scanned image of the inspection, linked to one item; completion waits for the scan.
    const window = current.items[1];
    const report = await photo(current.id, { file: pdf(), contentType: 'application/pdf' });
    expect(codes(await as('pm').action(`/api/v1/inspections/${current.id}/items/${window.id}/photos`, current.version, { documentId: report }))).toEqual(['documentId:not-photo']);
    const elsewherePhoto = await photo((await schedule({ propertyId, unitId, inspectionType: 'periodic', scheduledAt })).id);
    expect(codes(await as('pm').action(`/api/v1/inspections/${current.id}/items/${window.id}/photos`, current.version, { documentId: elsewherePhoto }))).toEqual(['documentId:not-found']);
    const pending = await photo(current.id, { scan: false });
    res = await as('pm').action(`/api/v1/inspections/${current.id}/items/${window.id}/photos`, current.version, { documentId: pending, caption: 'Crack in the lower pane' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    current = res.body;
    expect(current.items[1].photos).toEqual([{ document: { id: pending, name: 'Window' }, caption: 'Crack in the lower pane', scanStatus: 'pending' }]);
    expect(current.pendingPhotos).toBe(1);
    res = await as('pm').put(`/api/v1/inspections/${current.id}/items`, current.version, {
      items: current.items.map((item: Body) => ({ id: item.id, area: item.area, item: item.item, conditionCode: item.item === 'Window' ? 'damaged' : item.conditionCode, notes: item.item === 'Window' ? 'Cracked pane' : null, actionRequired: item.item === 'Window' })),
    });
    current = res.body;
    expect(current.items[1]).toMatchObject({ conditionCode: 'damaged', notes: 'Cracked pane', actionRequired: true, photos: [expect.objectContaining({ caption: 'Crack in the lower pane' })] });
    expect(codes(await as('pm').action(`/api/v1/inspections/${current.id}/complete`, current.version))).toEqual(['overallCondition:required']);
    current = (await as('pm').patch(`/api/v1/inspections/${current.id}`, current.version, { overallCondition: 'good' }).expect(200)).body;
    expect((await as('pm').action(`/api/v1/inspections/${current.id}/complete`, current.version)).body.detail).toContain('still being checked');
    await worker.runOnce();
    // Owner (all inspections) may change an inspection someone else is carrying out; another member may not.
    const othersRes = await as('pm').action(`/api/v1/inspections/${current.id}/complete`, current.version, { reportDocumentId: report });
    expect(othersRes.status, JSON.stringify(othersRes.body)).toBe(200);
    current = othersRes.body;
    expect(current).toMatchObject({ status: 'completed', overallCondition: 'good', reportDocument: { id: report }, canEdit: false });
    expect((await as('pm').put(`/api/v1/inspections/${current.id}/items`, current.version, { items: [] })).status).toBe(422);
    expect(await auditActions(current.id)).toEqual(expect.arrayContaining(['inspection.scheduled', 'inspection.items_saved', 'inspection.started', 'inspection.photo_added', 'inspection.completed']));

    // The tenant's acknowledgement, once, not before completion.
    expect(codes(await as('pm').action(`/api/v1/inspections/${current.id}/tenant-signed`, current.version, { acknowledgedAt: '2026-01-01T00:00:00Z' }))).toEqual(['acknowledgedAt:before-completion']);
    current = (await as('pm').action(`/api/v1/inspections/${current.id}/tenant-signed`, current.version, { acknowledgedAt: new Date().toISOString() }).expect(200)).body;
    expect(current.tenantSignedAt).not.toBeNull();
    expect((await as('pm').action(`/api/v1/inspections/${current.id}/tenant-signed`, current.version, { acknowledgedAt: new Date().toISOString() })).status).toBe(422);

    // The move-out inspection starts from the unit's last completed inspection, with the move-in condition beside each item.
    const moveOut = await schedule({ propertyId, unitId, leaseId, inspectionType: 'move_out', scheduledAt: '2026-08-31T09:00:00Z' });
    expect(moveOut.items.map((item: Body) => [item.area, item.item, item.conditionCode, item.moveInCondition])).toEqual([
      ['Kitchen', 'Oven', null, 'good'],
      ['Living room', 'Window', null, 'damaged'],
      ['Hall', 'Door', null, 'good'],
    ]);
    expect(moveOut.moveIn).toEqual({ id: current.id, name: current.reference });
    const documents = (await as('pm').get(`/api/v1/inspections/${current.id}/documents`).expect(200)).body.data;
    expect(documents.map((doc: Body) => doc.id).sort()).toEqual([pending, report].sort());
  });

  it('is read only to others while in progress, and cancelled with a reason', async () => {
    const { propertyId, unitId } = await unitWithLease();
    let current = await schedule({ propertyId, unitId, inspectionType: 'periodic', scheduledAt: '2026-09-01T09:00:00Z' }, 'pm');
    current = (await as('owner').patch(`/api/v1/inspections/${current.id}`, current.version, { action: 'start' }).expect(200)).body;
    expect(current.inspector).not.toBeNull();
    expect(current.inspector.id).not.toBe(pmMembership);
    const blocked = await as('pm').patch(`/api/v1/inspections/${current.id}`, current.version, { summary: 'Mine' });
    expect(blocked.body.detail).toContain('Another inspector');
    expect((await get(current.id, 'pm')).canEdit).toBe(false);
    expect((await as('owner').patch(`/api/v1/inspections/${current.id}`, current.version, { action: 'start' })).status).toBe(422);
    expect(codes(await as('owner').action(`/api/v1/inspections/${current.id}/cancel`, current.version, { reason: 'x' }))).toEqual(['reason:min-length']);
    current = (await as('owner').action(`/api/v1/inspections/${current.id}/cancel`, current.version, { reason: 'Tenant away' }).expect(200)).body;
    expect(current).toMatchObject({ status: 'cancelled', cancelledReason: 'Tenant away' });
    expect((await as('owner').patch(`/api/v1/inspections/${current.id}`, current.version, { summary: 'Late' })).status).toBe(422);
    expect((await as('owner').patch(`/api/v1/inspections/${current.id}`, current.version + 1, { summary: 'Late' })).status).toBe(412);
  });

  it('lists inspections in scope: assigned staff see theirs, other companies none', async () => {
    const { propertyId, unitId } = await unitWithLease();
    const assigned = await schedule({ propertyId, unitId, inspectionType: 'safety', scheduledAt: '2026-10-01T09:00:00Z', inspectorMembershipId: staffMembership });
    const notAssigned = await schedule({ propertyId, unitId, inspectionType: 'periodic', scheduledAt: '2026-10-02T09:00:00Z' });
    const staffList = (await as('staff').get('/api/v1/inspections?limit=100').expect(200)).body.data.map((row: Body) => row.id);
    expect(staffList).toContain(assigned.id);
    expect(staffList).not.toContain(notAssigned.id);
    expect((await as('staff').get(`/api/v1/inspections/${notAssigned.id}`)).status).toBe(404);
    const filtered = (await as('owner').get(`/api/v1/inspections?filter[unitId]=${unitId}&filter[scheduledAt][gte]=2026-10-01&filter[scheduledAt][lte]=2026-10-01&filter[inspectionType]=safety`).expect(200)).body.data;
    expect(filtered.map((row: Body) => row.id)).toEqual([assigned.id]);
    const page = (await as('owner').get(`/api/v1/inspections?filter[unitId]=${unitId}&limit=1&sort=scheduledAt`).expect(200)).body;
    expect(page.data[0].id).toBe(assigned.id);
    const next = (await as('owner').get(`/api/v1/inspections?filter[unitId]=${unitId}&limit=1&sort=scheduledAt&cursor=${page.page.nextCursor}`).expect(200)).body;
    expect(next.data[0].id).toBe(notAssigned.id);
    expect((await as('owner').get(`/api/v1/inspections?filter[status]=completed&sort=-completedAt&filter[unitId]=${unitId}`).expect(200)).body.data).toEqual([]);
    expect((await as('otherOwner').get(`/api/v1/inspections/${assigned.id}`)).status).toBe(404);
    expect((await as('otherOwner').get('/api/v1/inspections').expect(200)).body.data).toEqual([]);
    // Photos and the removal of a photo link.
    expect((await as('staff').patch(`/api/v1/inspections/${assigned.id}`, assigned.version, { action: 'start' })).status).toBe(403);
    let current = (await as('owner').put(`/api/v1/inspections/${assigned.id}/items`, assigned.version, { items: items([['Roof', 'Gutter', 'fair']]) }).expect(200)).body;
    const picture = await photo(assigned.id);
    current = (await as('owner').action(`/api/v1/inspections/${assigned.id}/items/${current.items[0].id}/photos`, current.version, { documentId: picture }).expect(200)).body;
    const again = await as('owner').action(`/api/v1/inspections/${assigned.id}/items/${current.items[0].id}/photos`, current.version, { documentId: picture }).expect(200);
    expect(again.body.items[0].photos).toHaveLength(1);
    current = (await as('owner').del(`/api/v1/inspections/${assigned.id}/items/${current.items[0].id}/photos/${picture}`, current.version).expect(200)).body;
    expect(current.items[0].photos).toEqual([]);
    expect((await as('owner').del(`/api/v1/inspections/${assigned.id}/items/${current.items[0].id}/photos/${picture}`, current.version)).status).toBe(404);
  });
});
