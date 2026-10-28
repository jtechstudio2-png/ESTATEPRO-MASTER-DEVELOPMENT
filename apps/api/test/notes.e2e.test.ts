import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_PINNED_NOTES } from '../src/notes/notes.service.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

describe('property notes (Phase 4 M5, ADR-006 L-D6 to L-D9)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let propertyId: string;
  let secondPropertyId: string;
  let kumasiPropertyId: string;
  let unitId: string;
  let otherUnitId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};

  const as = (who: string, companyId = company.companyId) => ({
    get: (path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId),
    post: (path: string, body?: object) => t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body ?? {}),
    patch: (path: string, body: object, version?: number) => {
      const req = t.http.patch(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body);
      return version === undefined ? req : req.set('If-Match', `"${version}"`);
    },
    action: (path: string, version: number, body?: object) =>
      t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).set('If-Match', `"${version}"`).send(body ?? {}),
  });

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    const kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      agent2: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      agentKumasi: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      manager: { ...(await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      sales: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      technician: { ...(await fx.member(company.companyId, { roleKey: 'maintenance_staff' })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    for (const [name, person] of Object.entries(people)) {
      members[name] = person.membershipId;
      await fx.linkIdentity(person.userId, `notes-${name}-${person.companyId}`);
      tokens[name] = await t.idp.token({ sub: `notes-${name}-${person.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    }
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();
    const create = async (name: string, officeId: string) =>
      (
        await as('owner')
          .post('/api/v1/properties', {
            name,
            propertyTypeId: type.id,
            officeId,
            address: { countryCode: 'GH', addressLine1: `${name} Street`, locality: 'Accra', adminArea1: 'Greater Accra' },
          })
          .expect(201)
      ).body.id as string;
    propertyId = await create('Notes Court', company.officeId);
    secondPropertyId = await create('Second Court', company.officeId);
    kumasiPropertyId = await create('Kumasi Court', kumasiOfficeId);
    unitId = (await as('owner').post(`/api/v1/properties/${propertyId}/units`, { unitLabel: 'Flat 1' }).expect(201)).body.id;
    otherUnitId = (await as('owner').post(`/api/v1/properties/${secondPropertyId}/units`, { unitLabel: 'Flat 9' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  const notesOf = (id: string) => `/api/v1/properties/${id}/notes`;

  it('lets agents add internal notes and never puts the text in the audit log (L-D7)', async () => {
    const res = await as('agent')
      .post(notesOf(propertyId), { body: 'Gate is stiff; lift and push.  ', category: 'access' })
      .set('Idempotency-Key', 'note-create-1')
      .expect(201);
    expect(res.headers['location']).toBe(`/api/v1/property-notes/${res.body.id}`);
    expect(res.headers['etag']).toBe('"1"');
    expect(res.body).toMatchObject({
      propertyId,
      unitId: null,
      body: 'Gate is stiff; lift and push.',
      category: 'access',
      visibility: 'internal',
      isPinned: false,
      source: 'user',
      author: { membershipId: members['agent'] },
      revisionCount: 0,
      version: 1,
    });
    const again = await as('agent')
      .post(notesOf(propertyId), { body: 'Gate is stiff; lift and push.  ', category: 'access' })
      .set('Idempotency-Key', 'note-create-1')
      .expect(201);
    expect(again.body.id).toBe(res.body.id);

    const audit = await fx.db.selectFrom('auditLogs').selectAll().where('entityId', '=', res.body.id).execute();
    expect(audit.map((row) => row.action)).toEqual(['property_note.created']);
    expect(audit[0]!.metadata).toMatchObject({ propertyId, category: 'access', visibility: 'internal', bodyLength: 29 });
    expect(JSON.stringify(audit)).not.toContain('Gate is stiff');
  });

  it('allows only managers and admins to share notes outside the company (L-D8)', async () => {
    const denied = await as('agent').post(notesOf(propertyId), { body: 'For the landlord', visibility: 'landlord' }).expect(403);
    expect(denied.body.detail).toMatch(/managers and admins/);
    const tenantWithoutUnit = await as('manager').post(notesOf(propertyId), { body: 'Bins on Tuesday', visibility: 'tenant' }).expect(422);
    expect(tenantWithoutUnit.body.errors).toContainEqual(expect.objectContaining({ field: 'unitId', code: 'required' }));
    const wrongUnit = await as('manager').post(notesOf(propertyId), { body: 'Bins on Tuesday', visibility: 'tenant', unitId: otherUnitId }).expect(422);
    expect(wrongUnit.body.errors).toContainEqual(expect.objectContaining({ field: 'unitId', code: 'not-found' }));
    await as('manager').post(notesOf(propertyId), { body: 'Bins on Tuesday', visibility: 'tenant', unitId }).expect(201);
    await as('sales').post(notesOf(propertyId), { body: 'Owner prefers email', visibility: 'landlord' }).expect(201);
    await as('owner').post(notesOf(propertyId), { body: 'Annual check booked', visibility: 'landlord' }).expect(201);

    // An agent cannot make an existing note external either.
    const own = await as('agent').post(notesOf(propertyId), { body: 'Will share later' }).expect(201);
    await as('agent').patch(`/api/v1/property-notes/${own.body.id}`, { visibility: 'landlord' }, 1).expect(403);
    const shared = await as('manager').patch(`/api/v1/property-notes/${own.body.id}`, { visibility: 'landlord' }, 1).expect(200);
    expect(shared.body.visibility).toBe('landlord');
    const audit = await fx.db
      .selectFrom('auditLogs')
      .select(['changes'])
      .where('entityId', '=', own.body.id)
      .where('action', '=', 'property_note.visibility_changed')
      .executeTakeFirstOrThrow();
    expect(audit.changes).toEqual({ visibility: { old: 'internal', new: 'landlord' } });
  });

  it('keeps earlier text as revisions, visible to the author and managers only', async () => {
    const note = await as('agent').post(notesOf(propertyId), { body: 'Call Ama on 024 000 0000 before visiting' }).expect(201);
    const id = note.body.id as string;
    await as('agent').patch(`/api/v1/property-notes/${id}`, { body: 'Call the tenant before visiting' }).expect(428);
    await as('agent').patch(`/api/v1/property-notes/${id}`, { body: 'Call the tenant before visiting' }, 9).expect(412);
    const edited = await as('agent').patch(`/api/v1/property-notes/${id}`, { body: 'Call the tenant before visiting' }, 1).expect(200);
    expect(edited.body).toMatchObject({ body: 'Call the tenant before visiting', revisionCount: 1, version: 2, updatedBy: { membershipId: members['agent'] } });
    const twice = await as('agent').patch(`/api/v1/property-notes/${id}`, { body: 'Call the tenant first', category: 'viewing' }, 2).expect(200);
    // Unchanged values are a no-op.
    const noop = await as('agent').patch(`/api/v1/property-notes/${id}`, { body: 'Call the tenant first', category: 'viewing' }, 3).expect(200);
    expect(noop.body.version).toBe(twice.body.version);

    const history = await as('agent').get(`/api/v1/property-notes/${id}/revisions`).expect(200);
    expect(history.body.data.map((r: { body: string }) => r.body)).toEqual(['Call the tenant before visiting', 'Call Ama on 024 000 0000 before visiting']);
    expect(history.body.data[1]).toMatchObject({ revision: 1, writtenBy: { membershipId: members['agent'] }, redactedAt: null });
    expect(history.body.data[0].writtenAt).toBe(history.body.data[1].supersededAt);
    const firstPage = await as('manager').get(`/api/v1/property-notes/${id}/revisions?limit=1`).expect(200);
    expect(firstPage.body.nextBefore).toBe(2);
    const older = await as('manager').get(`/api/v1/property-notes/${id}/revisions?limit=1&before=2`).expect(200);
    expect(older.body).toMatchObject({ data: [{ revision: 1 }], nextBefore: null });
    await as('manager').get(`/api/v1/property-notes/${id}/revisions?limit=0`).expect(422);
    await as('manager').get(`/api/v1/property-notes/${id}/revisions?before=x`).expect(422);

    await as('agent2').get(`/api/v1/property-notes/${id}`).expect(200);
    await as('agent2').get(`/api/v1/property-notes/${id}/revisions`).expect(403);
    await as('agent2').patch(`/api/v1/property-notes/${id}`, { body: 'Not mine' }, 3).expect(403);
    const managed = await as('manager').patch(`/api/v1/property-notes/${id}`, { isPinned: true }, 3).expect(200);
    expect(managed.body).toMatchObject({ isPinned: true, pinnedAt: expect.any(String) });

    const audit = await fx.db.selectFrom('auditLogs').select(['action', 'changes', 'metadata']).where('entityId', '=', id).orderBy('occurredAt').execute();
    expect(audit.map((row) => row.action)).toEqual(['property_note.created', 'property_note.updated', 'property_note.updated', 'property_note.updated']);
    expect(audit[1]!.changes).toEqual({ bodyLength: { old: 40, new: 31 } });
    expect(audit[1]!.metadata).toMatchObject({ revision: 1 });
    expect(JSON.stringify(audit)).not.toMatch(/Call|tenant|Ama/);
  });

  it(`limits pinned notes to ${MAX_PINNED_NOTES} per property`, async () => {
    const pins = await as('manager').get(`${notesOf(secondPropertyId)}?filter[pinned]=true`).expect(200);
    expect(pins.body.data).toEqual([]);
    for (let n = 0; n < MAX_PINNED_NOTES; n += 1) {
      await as('manager').post(notesOf(secondPropertyId), { body: `Pinned ${n}`, isPinned: true }).expect(201);
    }
    const sixth = await as('manager').post(notesOf(secondPropertyId), { body: 'One too many', isPinned: true }).expect(422);
    expect(sixth.body.detail).toMatch(/at most 5 pinned/);
    const unpinned = await as('manager').post(notesOf(secondPropertyId), { body: 'Not pinned' }).expect(201);
    await as('manager').patch(`/api/v1/property-notes/${unpinned.body.id}`, { isPinned: true }, 1).expect(422);
    const pinned = await as('manager').get(`${notesOf(secondPropertyId)}?filter[pinned]=true`).expect(200);
    expect(pinned.body.data).toHaveLength(MAX_PINNED_NOTES);
  });

  it('archives and restores notes; archived notes leave the default list and cannot be edited', async () => {
    const note = await as('agent').post(notesOf(propertyId), { body: 'Old viewing time', isPinned: true }).expect(201);
    const id = note.body.id as string;
    await as('agent2').action(`/api/v1/property-notes/${id}/archive`, 1, { reason: 'Out of date' }).expect(403);
    const archived = await as('agent').action(`/api/v1/property-notes/${id}/archive`, 1, { reason: 'Out of date' }).expect(200);
    expect(archived.body).toMatchObject({ archivedReason: 'Out of date', isPinned: false });
    await as('agent').action(`/api/v1/property-notes/${id}/archive`, archived.body.version, { reason: 'Again' }).expect(422);
    await as('agent').patch(`/api/v1/property-notes/${id}`, { body: 'Edit' }, archived.body.version).expect(422);
    const list = await as('agent').get(notesOf(propertyId)).expect(200);
    expect(list.body.data.map((n: { id: string }) => n.id)).not.toContain(id);
    const archivedList = await as('agent').get(`${notesOf(propertyId)}?filter[archived]=true`).expect(200);
    expect(archivedList.body.data.map((n: { id: string }) => n.id)).toEqual([id]);
    const restored = await as('agent').action(`/api/v1/property-notes/${id}/restore`, archived.body.version).expect(200);
    expect(restored.body.archivedAt).toBeNull();
    await as('agent').action(`/api/v1/property-notes/${id}/restore`, restored.body.version).expect(422);
  });

  it('redacts a note and all its history (Manage Notes only)', async () => {
    const note = await as('agent').post(notesOf(propertyId), { body: 'Tenant Kofi owes rent' }).expect(201);
    const id = note.body.id as string;
    const edited = await as('agent').patch(`/api/v1/property-notes/${id}`, { body: 'Tenant Kofi owes two months of rent' }, 1).expect(200);
    await as('agent').action(`/api/v1/property-notes/${id}/redact`, edited.body.version, { reason: 'erasure_request' }).expect(403);
    await as('manager').action(`/api/v1/property-notes/${id}/redact`, edited.body.version, { reason: 'because' }).expect(422);
    const redacted = await as('manager').action(`/api/v1/property-notes/${id}/redact`, edited.body.version, { reason: 'erasure_request' }).expect(200);
    expect(redacted.body).toMatchObject({ body: '[Redacted]', redactedAt: expect.any(String) });
    await as('manager').action(`/api/v1/property-notes/${id}/redact`, redacted.body.version, { reason: 'other' }).expect(422);
    await as('agent').patch(`/api/v1/property-notes/${id}`, { body: 'Back again' }, redacted.body.version).expect(422);
    const history = await as('agent').get(`/api/v1/property-notes/${id}/revisions`).expect(200);
    expect(history.body.data.map((r: { body: string }) => r.body)).toEqual(['[Redacted]']);
    const rows = await fx.db.selectFrom('propertyNoteRevisions').select('body').where('noteId', '=', id).execute();
    expect(JSON.stringify(rows)).not.toContain('Kofi');
    const audit = await fx.db.selectFrom('auditLogs').select(['action', 'metadata']).where('entityId', '=', id).where('action', '=', 'property_note.redacted').executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ reason: 'erasure_request' });
  });

  it('follows property scope, roles and company isolation', async () => {
    const note = await as('manager').post(notesOf(propertyId), { body: 'Scoped note' }).expect(201);
    await as('agentKumasi').get(notesOf(propertyId)).expect(404);
    await as('agentKumasi').get(`/api/v1/property-notes/${note.body.id}`).expect(404);
    await as('agentKumasi').post(notesOf(propertyId), { body: 'Not my office' }).expect(404);
    await as('agentKumasi').post(notesOf(kumasiPropertyId), { body: 'My office' }).expect(201);
    await as('otherOwner', other.companyId).get(`/api/v1/property-notes/${note.body.id}`).expect(404);
    await as('otherOwner', other.companyId).get(notesOf(propertyId)).expect(404);

    // Accountants read; maintenance staff have no note access.
    const read = await as('accountant').get(notesOf(propertyId)).expect(200);
    expect(read.body.data.length).toBeGreaterThan(0);
    await as('accountant').post(notesOf(propertyId), { body: 'No' }).expect(403);
    await as('technician').get(notesOf(propertyId)).expect(403);
  });

  it('filters and pages the list', async () => {
    const byCategory = await as('owner').get(`${notesOf(propertyId)}?filter[category]=access`).expect(200);
    expect(byCategory.body.data.every((n: { category: string }) => n.category === 'access')).toBe(true);
    const byVisibility = await as('owner').get(`${notesOf(propertyId)}?filter[visibility]=tenant&filter[unitId]=${unitId}`).expect(200);
    expect(byVisibility.body.data.map((n: { body: string }) => n.body)).toEqual(['Bins on Tuesday']);
    const byAuthor = await as('owner').get(`${notesOf(propertyId)}?filter[authorId]=${members['sales']}`).expect(200);
    expect(byAuthor.body.data.map((n: { body: string }) => n.body)).toEqual(['Owner prefers email']);
    const first = await as('owner').get(`${notesOf(propertyId)}?limit=2&sort=createdAt`).expect(200);
    const second = await as('owner').get(`${notesOf(propertyId)}?limit=2&sort=createdAt&cursor=${first.body.page.nextCursor}`).expect(200);
    expect(second.body.data[0].createdAt >= first.body.data[1].createdAt).toBe(true);
    await as('owner').get(`${notesOf(propertyId)}?filter[category]=gossip`).expect(422);
  });

  it('rejects notes on archived properties and invalid bodies', async () => {
    await as('owner').post(notesOf(propertyId), { body: '' }).expect(422);
    await as('owner').post(notesOf(propertyId), { body: 'x'.repeat(10_001) }).expect(422);
    const property = await as('owner').get(`/api/v1/properties/${kumasiPropertyId}`).expect(200);
    await as('owner').action(`/api/v1/properties/${kumasiPropertyId}/archive`, property.body.version, { reason: 'Sold off' }).expect(200);
    const res = await as('owner').post(notesOf(kumasiPropertyId), { body: 'Too late' }).expect(422);
    expect(res.body.detail).toMatch(/archived property/);
  });
});
