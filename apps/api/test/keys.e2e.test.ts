import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

describe('key register (Phase 4 M5, ADR-006 L-D10)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let propertyId: string;
  let kumasiPropertyId: string;
  let unitId: string;
  let otherUnitId: string;
  let contractorId: string;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};

  const as = (who: string, companyId = company.companyId) => ({
    get: (path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId),
    post: (path: string, body?: object) => t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body ?? {}),
    patch: (path: string, body: object, version: number) =>
      t.http.patch(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).set('If-Match', `"${version}"`).send(body),
    action: (path: string, version: number, body?: object) =>
      t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).set('If-Match', `"${version}"`).send(body ?? {}),
  });

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      agentKumasi: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      manager: { ...(await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    for (const [name, person] of Object.entries(people)) {
      members[name] = person.membershipId;
      await fx.linkIdentity(person.userId, `keys-${name}-${person.companyId}`);
      tokens[name] = await t.idp.token({ sub: `keys-${name}-${person.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    }
    members['suspended'] = (await fx.member(company.companyId, { roleKey: 'agent', status: 'suspended' })).membershipId;

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
    propertyId = await create('Keys Court', company.officeId);
    kumasiPropertyId = await create('Kumasi Keys', kumasiOfficeId);
    unitId = (await as('owner').post(`/api/v1/properties/${propertyId}/units`, { unitLabel: 'Flat 1' }).expect(201)).body.id;
    otherUnitId = (await as('owner').post(`/api/v1/properties/${kumasiPropertyId}/units`, { unitLabel: 'Flat 2' }).expect(201)).body.id;
    contractorId = (
      await fx.db
        .insertInto('contacts')
        // The agent's own contact: since S1 a contact holder must be in the member's contact scope (readiness R7).
        .values({ companyId: company.companyId, contactType: 'person', displayName: 'Kwame the plumber', ownerMembershipId: members['agent']!, officeId: company.officeId })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  const keysOf = (id: string) => `/api/v1/properties/${id}/key-sets`;

  it('registers key sets (managers) and lists them per property', async () => {
    await as('agent').post(keysOf(propertyId), { label: 'K-100' }).expect(403);
    const created = await as('manager')
      .post(keysOf(propertyId), { label: ' K-100 ', description: '2 front door, 1 gate fob', unitId })
      .set('Idempotency-Key', 'key-create-1')
      .expect(201);
    expect(created.headers['location']).toBe(`/api/v1/key-sets/${created.body.id}`);
    expect(created.body).toMatchObject({
      property: { id: propertyId, reference: expect.any(String), name: 'Keys Court', timezone: 'Africa/Accra' },
      unitId,
      unitLabel: expect.any(String),
      label: 'K-100',
      status: 'in_office',
      holder: null,
      isOverdue: false,
      version: 1,
    });
    const owner = await as('manager').post(keysOf(propertyId), { label: 'K-101', status: 'with_owner' }).expect(201);
    expect(owner.body.status).toBe('with_owner');
    const duplicate = await as('manager').post(keysOf(propertyId), { label: 'K-100' }).expect(409);
    expect(duplicate.body.detail).toMatch(/already in use/);
    const wrongUnit = await as('manager').post(keysOf(propertyId), { label: 'K-102', unitId: otherUnitId }).expect(422);
    expect(wrongUnit.body.errors).toContainEqual(expect.objectContaining({ field: 'unitId' }));

    const list = await as('agent').get(keysOf(propertyId)).expect(200);
    expect(list.body.data.map((k: { label: string }) => k.label)).toEqual(['K-100', 'K-101']);
  });

  it('checks keys out to staff or contacts, in again, and keeps an append-only history', async () => {
    const keySet = (await as('manager').post(keysOf(propertyId), { label: 'K-200' }).expect(201)).body;
    const path = `/api/v1/key-sets/${keySet.id}`;
    const dueBackAt = new Date(Date.now() + 2 * 3_600_000).toISOString();

    const bothHolders = await as('agent').action(`${path}/check-out`, 1, { holderMembershipId: members['agent'], holderContactId: contractorId }).expect(422);
    expect(bothHolders.body.errors).toContainEqual(expect.objectContaining({ code: 'one-holder' }));
    await as('agent').action(`${path}/check-out`, 1, {}).expect(422);
    const suspended = await as('agent').action(`${path}/check-out`, 1, { holderMembershipId: members['suspended'] }).expect(422);
    expect(suspended.body.errors).toContainEqual(expect.objectContaining({ field: 'holderMembershipId', code: 'not-found' }));
    const past = await as('agent')
      .action(`${path}/check-out`, 1, { holderMembershipId: members['agent'], dueBackAt: new Date(Date.now() - 60_000).toISOString() })
      .expect(422);
    expect(past.body.errors).toContainEqual(expect.objectContaining({ field: 'dueBackAt', code: 'past' }));

    const out = await as('agent').action(`${path}/check-out`, 1, { holderMembershipId: members['agent'], dueBackAt, note: 'Viewing at 3pm' }).expect(200);
    expect(out.body).toMatchObject({
      status: 'checked_out',
      holder: { type: 'member', id: members['agent'] },
      dueBackAt,
      isOverdue: false,
      checkedOutAt: expect.any(String),
      version: 2,
    });
    const twice = await as('agent').action(`${path}/check-out`, 2, { holderContactId: contractorId }).expect(422);
    expect(twice.body.detail).toBe('Keys that are checked out cannot be checked out.');
    await as('agent').action(`${path}/check-in`, 1).expect(412);
    const back = await as('agent').action(`${path}/check-in`, 2, { note: 'All keys returned' }).expect(200);
    expect(back.body).toMatchObject({ status: 'in_office', holder: null, dueBackAt: null, checkedOutAt: null });

    // A contact outside the agent's contact scope cannot hold the keys (readiness R7).
    const stranger = await fx.db.insertInto('contacts').values({ companyId: company.companyId, contactType: 'person', displayName: 'Unknown caller' }).returning('id').executeTakeFirstOrThrow();
    const outOfScope = await as('agent').action(`${path}/check-out`, back.body.version, { holderContactId: stranger.id }).expect(422);
    expect(outOfScope.body.errors).toContainEqual(expect.objectContaining({ field: 'holderContactId', code: 'not-found' }));
    const contractor = await as('agent').action(`${path}/check-out`, back.body.version, { holderContactId: contractorId }).expect(200);
    expect(contractor.body.holder).toEqual({ type: 'contact', id: contractorId, displayName: 'Kwame the plumber' });
    const lost = await as('agent').action(`${path}/report-lost`, contractor.body.version, { note: 'Contractor lost them' }).expect(200);
    expect(lost.body).toMatchObject({ status: 'lost', holder: null });
    await as('agent').action(`${path}/check-in`, lost.body.version).expect(422);
    const found = await as('agent').action(`${path}/found`, lost.body.version).expect(200);
    expect(found.body.status).toBe('in_office');

    const history = await as('agent').get(`${path}/movements`).expect(200);
    expect(history.body.data.map((m: { movement: string }) => m.movement)).toEqual(['found', 'lost', 'check_out', 'check_in', 'check_out']);
    expect(history.body.data[1]).toMatchObject({ holder: { type: 'contact', id: contractorId }, note: 'Contractor lost them' });
    expect(history.body.data[4]).toMatchObject({ holder: { type: 'member', id: members['agent'] }, dueBackAt, note: 'Viewing at 3pm' });
    expect(history.body.data[0].recordedBy).toMatchObject({ type: 'member', id: members['agent'] });
    const paged = await as('agent').get(`${path}/movements?limit=2`).expect(200);
    const rest = await as('agent').get(`${path}/movements?limit=2&cursor=${paged.body.page.nextCursor}`).expect(200);
    expect(rest.body.data.map((m: { movement: string }) => m.movement)).toEqual(['check_out', 'check_in']);

    const audit = await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', keySet.id).orderBy('occurredAt').execute();
    expect(audit.map((row) => row.action)).toEqual([
      'key_set.created',
      'key_set.checked_out',
      'key_set.checked_in',
      'key_set.checked_out',
      'key_set.lost',
      'key_set.found',
    ]);
  });

  it('lists keys that are out and overdue across the company', async () => {
    const keySet = (await as('manager').post(keysOf(propertyId), { label: 'K-300' }).expect(201)).body;
    const out = await as('agent')
      .action(`/api/v1/key-sets/${keySet.id}/check-out`, 1, { holderMembershipId: members['agent'], dueBackAt: new Date(Date.now() + 60_000).toISOString() })
      .expect(200);
    // The due-back time passes.
    await fx.db.updateTable('keySets').set({ dueBackAt: new Date(Date.now() - 3_600_000) }).where('id', '=', keySet.id).execute();
    const overdue = await as('manager').get('/api/v1/key-sets?filter[overdue]=true').expect(200);
    expect(overdue.body.data.map((k: { id: string; isOverdue: boolean }) => [k.id, k.isOverdue])).toEqual([[keySet.id, true]]);
    const notOverdue = await as('manager').get('/api/v1/key-sets?filter[overdue]=false').expect(200);
    expect(notOverdue.body.data.map((k: { id: string }) => k.id)).not.toContain(keySet.id);
    const byHolder = await as('manager').get(`/api/v1/key-sets?filter[holderMembershipId]=${members['agent']}&filter[status]=checked_out`).expect(200);
    expect(byHolder.body.data.map((k: { id: string }) => k.id)).toEqual([keySet.id]);
    const byOffice = await as('owner').get(`/api/v1/key-sets?filter[overdue]=true&filter[officeId]=${company.officeId}`).expect(200);
    expect(byOffice.body.data.map((k: { id: string }) => k.id)).toEqual([keySet.id]);
    const otherOffice = await as('owner').get(`/api/v1/key-sets?filter[overdue]=true&filter[officeId]=${kumasiOfficeId}`).expect(200);
    expect(otherOffice.body.data).toEqual([]);
    const byDue = await as('manager').get('/api/v1/key-sets?sort=dueBackAt').expect(200);
    expect(byDue.body.data.map((k: { id: string }) => k.id)).toEqual([keySet.id]);
    const one = await as('manager').get(`/api/v1/key-sets/${keySet.id}`).expect(200);
    expect(one.headers['etag']).toBe(`"${out.body.version + 1}"`);
  });

  it('edits and retires key sets; retired tags can be reused', async () => {
    const keySet = (await as('manager').post(keysOf(propertyId), { label: 'K-400', description: 'Back door' }).expect(201)).body;
    const path = `/api/v1/key-sets/${keySet.id}`;
    await as('agent').patch(path, { label: 'K-401' }, 1).expect(403);
    const edited = await as('manager').patch(path, { label: 'K-401', description: null, unitId }, 1).expect(200);
    expect(edited.body).toMatchObject({ label: 'K-401', description: null, unitId, version: 2 });
    const same = await as('manager').patch(path, { label: 'K-401' }, 2).expect(200);
    expect(same.body.version).toBe(2);

    const out = await as('agent').action(`${path}/check-out`, 2, { holderMembershipId: members['agent'] }).expect(200);
    const blocked = await as('manager').action(`${path}/retire`, out.body.version, { reason: 'Locks changed' }).expect(422);
    expect(blocked.body.detail).toMatch(/Check the keys in/);
    const back = await as('agent').action(`${path}/check-in`, out.body.version).expect(200);
    await as('agent').action(`${path}/retire`, back.body.version, { reason: 'Locks changed' }).expect(403);
    const retired = await as('manager').action(`${path}/retire`, back.body.version, { reason: 'Locks changed' }).expect(200);
    expect(retired.body).toMatchObject({ status: 'retired', retiredAt: expect.any(String) });
    await as('manager').action(`${path}/retire`, retired.body.version, { reason: 'Again' }).expect(422);
    await as('manager').patch(path, { label: 'K-402' }, retired.body.version).expect(422);
    await as('agent').action(`${path}/check-out`, retired.body.version, { holderMembershipId: members['agent'] }).expect(422);

    await as('manager').post(keysOf(propertyId), { label: 'K-401' }).expect(201);
    const active = await as('manager').get(keysOf(propertyId)).expect(200);
    expect(active.body.data.map((k: { id: string }) => k.id)).not.toContain(keySet.id);
    const withRetired = await as('manager').get(`${keysOf(propertyId)}?filter[status]=retired`).expect(200);
    expect(withRetired.body.data.map((k: { id: string }) => k.id)).toEqual([keySet.id]);
  });

  it('follows office scope, roles and company isolation', async () => {
    const keySet = (await as('owner').post(keysOf(kumasiPropertyId), { label: 'KSI-1' }).expect(201)).body;
    await as('agent').get(`/api/v1/key-sets/${keySet.id}`).expect(404);
    await as('agent').get(keysOf(kumasiPropertyId)).expect(404);
    await as('agent').action(`/api/v1/key-sets/${keySet.id}/check-out`, 1, { holderMembershipId: members['agent'] }).expect(404);
    const kumasiList = await as('agentKumasi').get('/api/v1/key-sets').expect(200);
    expect(kumasiList.body.data.map((k: { id: string }) => k.id)).toEqual([keySet.id]);
    await as('agentKumasi').action(`/api/v1/key-sets/${keySet.id}/check-out`, 1, { holderMembershipId: members['agentKumasi'] }).expect(200);
    await as('otherOwner', other.companyId).get(`/api/v1/key-sets/${keySet.id}`).expect(404);
    const otherList = await as('otherOwner', other.companyId).get('/api/v1/key-sets').expect(200);
    expect(otherList.body.data).toEqual([]);
    await as('accountant').get('/api/v1/key-sets').expect(403);
    await as('owner').get('/api/v1/key-sets/not-a-uuid').expect(404);
  });

  it('does not register keys for archived properties', async () => {
    const property = await as('owner').get(`/api/v1/properties/${propertyId}`).expect(200);
    await as('owner').action(`/api/v1/properties/${propertyId}/archive`, property.body.version, { reason: 'Sold' }).expect(200);
    const res = await as('owner').post(keysOf(propertyId), { label: 'K-999' }).expect(422);
    expect(res.body.detail).toMatch(/archived property/);
  });
});
