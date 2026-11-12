import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let phoneCounter = 4000;
const nextPhone = () => `024${String(9300000 + phoneCounter++).padStart(7, '0')}`;
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe('activity timeline and follow-ups (Phase 5 milestone C3; A-1, A-2, F-1, F-2; D5, D6)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};

  const as = (who: string, companyId = who === 'otherOwner' ? other.companyId : company.companyId) => {
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      patch: (path: string, body: object, version?: number) => {
        const req = auth(t.http.patch(path)).send(body);
        return version === undefined ? req : req.set('If-Match', `"${version}"`);
      },
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
    };
  };

  async function contact(who: string, overrides: Record<string, unknown> = {}) {
    const res = await as(who).post('/api/v1/contacts', { contactType: 'person', displayName: `Client ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number };
  }

  async function lead(who: string, contactId: string, overrides: Record<string, unknown> = {}) {
    const res = await as(who).post('/api/v1/leads', { contactId, leadType: 'buy', sourceCode: 'phone', ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; reference: string; [key: string]: unknown };
  }

  async function log(who: string, body: Record<string, unknown>) {
    const res = await as(who).post('/api/v1/activities', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; [key: string]: unknown };
  }

  async function task(who: string, body: Record<string, unknown>) {
    const res = await as(who).post('/api/v1/tasks', { title: 'Call back', dueAt: inHours(24), ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; [key: string]: unknown };
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      sales: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      salesKsi: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      agent2: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      agentKsi: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [name, member] of Object.entries(people)) {
      members[name] = member.membershipId;
      await fx.linkIdentity(member.userId, `act-${name}-${member.companyId}`);
      tokens[name] = await t.idp.token({ sub: `act-${name}-${member.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('logging activities (A-2)', () => {
    it('logs a call on a lead, links its contact, and records the first response', async () => {
      const person = await contact('agent');
      const created = await lead('agent', person.id, { receivedAt: new Date(Date.now() - 600_000).toISOString() });
      const call = await log('agent', {
        activityType: 'call',
        direction: 'outbound',
        durationSeconds: 360,
        outcomeCode: 'viewing_requested',
        body: 'Interested, wants evening viewings',
        links: [{ entityType: 'lead', entityId: created.id }],
      });
      expect(call).toMatchObject({
        activityType: 'call',
        direction: 'outbound',
        durationSeconds: 360,
        outcomeCode: 'viewing_requested',
        performedBy: { id: members['agent'] },
        createdBy: { id: members['agent'] },
        isSystem: false,
        canEdit: true,
        canArchive: true,
        revisions: [],
      });
      expect((call['links'] as Array<{ entityType: string; label: string }>).map((l) => `${l.entityType}:${l.label}`).sort()).toEqual([
        expect.stringMatching(/^contact:Client /),
        `lead:${created.reference}`,
      ]);
      const after = await as('agent').get(`/api/v1/leads/${created.id}`).expect(200);
      expect(after.body.firstResponseAt).toEqual(expect.any(String));
      const contactTimeline = await as('agent').get(`/api/v1/contacts/${person.id}/activities`).expect(200);
      expect(contactTimeline.body.data.map((a: { id: string }) => a.id)).toContain(call.id);
      const audit = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', call.id).where('action', '=', 'activity.logged').executeTakeFirstOrThrow();
      expect(audit.metadata).toMatchObject({ firstResponseFor: [created.id] });
      // An inbound message does not answer a lead.
      const second = await lead('agent', person.id);
      await log('agent', { activityType: 'whatsapp', direction: 'inbound', body: 'Thanks', links: [{ entityType: 'lead', entityId: second.id }] });
      expect((await as('agent').get(`/api/v1/leads/${second.id}`).expect(200)).body.firstResponseAt).toBeNull();
    });

    it('validates type, direction, timing, outcome and links', async () => {
      const person = await contact('owner');
      const link = [{ entityType: 'contact', entityId: person.id }];
      const fields = async (body: object, who = 'owner') => {
        const res = await as(who).post('/api/v1/activities', { links: link, ...body }).expect(422);
        return (res.body.errors as Array<{ field: string }>).map((e) => e.field).sort();
      };
      expect(await fields({ activityType: 'call' })).toEqual(['direction']);
      expect(await fields({ activityType: 'note', direction: 'outbound', body: 'x' })).toEqual(['direction']);
      expect(await fields({ activityType: 'note' })).toEqual(['body']);
      expect(await fields({ activityType: 'note', body: 'x', durationSeconds: 60 })).toEqual(['durationSeconds']);
      expect(await fields({ activityType: 'call', direction: 'outbound', occurredAt: inHours(2) })).toEqual(['occurredAt']);
      expect(await fields({ activityType: 'call', direction: 'outbound', outcomeCode: 'abducted' })).toEqual(['outcomeCode']);
      expect(await fields({ activityType: 'call', direction: 'outbound', performedBy: randomUUID() })).toEqual(['performedBy']);
      expect(await fields({ activityType: 'note', body: 'x', links: [{ entityType: 'listing', entityId: randomUUID() }] })).toEqual(['links', 'links[0].entityId']);
      expect(await fields({ activityType: 'note', body: 'x', links: [{ entityType: 'lead', entityId: randomUUID() }] })).toEqual(['links', 'links[0].entityId']);
      expect(await fields({ activityType: 'note', body: 'x', links: [...link, { entityType: 'property', entityId: randomUUID() }] })).toEqual(['links[1].entityId']);
      await as('owner').post('/api/v1/activities', { activityType: 'status_change', direction: 'internal', links: link }).expect(422);
      const noted = await log('owner', { activityType: 'note', body: 'Prefers WhatsApp after 6 pm', links: link, performedBy: members['sales'] });
      expect(noted).toMatchObject({ direction: 'internal', performedBy: { id: members['sales'] }, createdBy: { id: members['owner'] } });
    });

    it('needs write access to what it is about; an agent logs on their lead, not on others’ contacts (D1 read-only)', async () => {
      const someoneElses = await contact('owner');
      const res = await as('agent').post('/api/v1/activities', { activityType: 'note', body: 'x', links: [{ entityType: 'contact', entityId: someoneElses.id }] }).expect(422);
      expect(res.body.errors[0]).toMatchObject({ code: 'not-found' });
      const theirLead = await lead('sales', someoneElses.id, { assignedTo: members['agent'] });
      // The agent now reads the contact (D1) but writes only through the lead.
      const direct = await as('agent').post('/api/v1/activities', { activityType: 'note', body: 'x', links: [{ entityType: 'contact', entityId: someoneElses.id }] }).expect(422);
      expect(direct.body.errors[0]).toMatchObject({ code: 'forbidden' });
      await log('agent', { activityType: 'note', body: 'Via the lead', links: [{ entityType: 'lead', entityId: theirLead.id }, { entityType: 'contact', entityId: someoneElses.id }] });
      const notTheirs = await lead('sales', someoneElses.id, { assignedTo: members['agent2'] });
      const other = await as('agent').post('/api/v1/activities', { activityType: 'note', body: 'x', links: [{ entityType: 'lead', entityId: notTheirs.id }] }).expect(422);
      expect(other.body.errors[0].code).toBe('not-found');
      // Managers who can see but not update a lead (other office) are refused.
      const ksiLead = await lead('salesKsi', (await contact('salesKsi')).id, { officeId: kumasiOfficeId });
      await as('sales').post('/api/v1/activities', { activityType: 'note', body: 'x', links: [{ entityType: 'lead', entityId: ksiLead.id }] }).expect(422);
      await as('accountant').post('/api/v1/activities', { activityType: 'note', body: 'x', links: [{ entityType: 'contact', entityId: someoneElses.id }] }).expect(422);
    });
  });

  describe('timeline (A-1)', () => {
    it('orders same-time entries stably, pages with a cursor, filters by type and hides archived entries', async () => {
      const person = await contact('owner');
      const at = new Date(Date.now() - 3_600_000).toISOString();
      const ids: string[] = [];
      for (let n = 0; n < 5; n++) ids.push((await log('owner', { activityType: 'note', body: `Note ${n}`, occurredAt: at, links: [{ entityType: 'contact', entityId: person.id }] })).id);
      const call = await log('owner', { activityType: 'call', direction: 'inbound', links: [{ entityType: 'contact', entityId: person.id }] });
      const first = await as('owner').get(`/api/v1/contacts/${person.id}/activities?limit=3`).expect(200);
      expect(first.body.data.map((a: { id: string }) => a.id)).toEqual([call.id, ids[4], ids[3]]);
      const second = await as('owner').get(`/api/v1/contacts/${person.id}/activities?limit=3&cursor=${first.body.page.nextCursor}`).expect(200);
      expect(second.body.data.map((a: { id: string }) => a.id)).toEqual([ids[2], ids[1], ids[0]]);
      expect(second.body.page.nextCursor).toBeNull();
      const calls = await as('owner').get(`/api/v1/contacts/${person.id}/activities?filter[activityType]=call`).expect(200);
      expect(calls.body.data).toHaveLength(1);
      await as('owner').action(`/api/v1/activities/${ids[0]}/archive`, 1, { reason: 'Logged on the wrong client' }).expect(200);
      expect((await as('owner').get(`/api/v1/contacts/${person.id}/activities`).expect(200)).body.data).toHaveLength(5);
      expect((await as('owner').get(`/api/v1/contacts/${person.id}/activities?filter[archived]=all`).expect(200)).body.data).toHaveLength(6);
      for (const bad of ['limit=0', 'cursor=nonsense', 'filter[activityType]=dance', 'filter[archived]=yes', 'filter[colour]=red']) {
        await as('owner').get(`/api/v1/contacts/${person.id}/activities?${bad}`).expect(422);
      }
    });

    it('shows consent changes as system entries that cannot be edited or archived', async () => {
      const person = await contact('owner');
      await as('owner').post(`/api/v1/contacts/${person.id}/consents`, { purpose: 'marketing', channel: 'email', status: 'withdrawn', capturedVia: 'portal' }).expect(201);
      const timeline = await as('owner').get(`/api/v1/contacts/${person.id}/activities`).expect(200);
      const entry = timeline.body.data.find((a: { activityType: string }) => a.activityType === 'system');
      expect(entry).toMatchObject({ subject: 'Consent withdrawn: marketing (email) via portal', isSystem: true, canEdit: false, canArchive: false, editableUntil: null });
      await as('owner').patch(`/api/v1/activities/${entry.id}`, { body: 'x' }, 1).expect(422);
      await as('owner').action(`/api/v1/activities/${entry.id}/archive`, 1, { reason: 'Hide it' }).expect(422);
    });

    it('hides timelines and entries outside the member’s access', async () => {
      const person = await contact('owner');
      const entry = await log('owner', { activityType: 'note', body: 'Private', links: [{ entityType: 'contact', entityId: person.id }] });
      await as('agent').get(`/api/v1/contacts/${person.id}/activities`).expect(404);
      await as('agent').get(`/api/v1/activities/${entry.id}`).expect(404);
      await as('otherOwner').get(`/api/v1/activities/${entry.id}`).expect(404);
      await as('otherOwner').get(`/api/v1/contacts/${person.id}/activities`).expect(404);
      await as('agent').get(`/api/v1/leads/${randomUUID()}/activities`).expect(404);
    });
  });

  describe('editing and archiving (D5)', () => {
    it('lets the author edit within 24 hours and keeps every earlier version', async () => {
      const person = await contact('agent');
      const entry = await log('agent', { activityType: 'call', direction: 'outbound', body: 'Spoke to Ama', links: [{ entityType: 'contact', entityId: person.id }] });
      const path = `/api/v1/activities/${entry.id}`;
      await as('agent').patch(path, { body: 'x' }).expect(428);
      await as('agent').patch(path, { body: 'x' }, 9).expect(412);
      const same = await as('agent').patch(path, { body: 'Spoke to Ama' }, 1).expect(200);
      expect(same.body.version).toBe(1);
      const edited = await as('agent').patch(path, { body: 'Spoke to Ama and Kojo', outcomeCode: 'interested', durationSeconds: 120 }, 1).expect(200);
      expect(edited.body).toMatchObject({ body: 'Spoke to Ama and Kojo', version: 2, editedAt: expect.any(String) });
      expect(edited.body.revisions).toEqual([expect.objectContaining({ revisionNo: 1, body: 'Spoke to Ama', editedBy: expect.objectContaining({ id: members['agent'] }) })]);
      const again = await as('agent').patch(path, { direction: 'inbound', occurredAt: new Date(Date.now() - 60_000).toISOString() }, 2).expect(200);
      expect(again.body.revisions).toHaveLength(2);
      const audit = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', entry.id).where('action', '=', 'activity.edited').execute();
      expect(audit[0]!.metadata).toEqual({ fields: ['body', 'outcomeCode', 'durationSeconds'], revisionNo: 1 });
      expect(JSON.stringify(audit)).not.toContain('Kojo');
      for (const body of [{ direction: 'internal' }, { durationSeconds: 99999999 }, { occurredAt: inHours(3) }, { outcomeCode: 'teleported' }]) {
        await as('agent').patch(path, body, 3).expect(422);
      }
      // Only the author edits; others cannot, even managers.
      await as('sales').patch(path, { body: 'Manager edit' }, 3).expect(403);
    });

    it('closes the edit window after 24 hours; archiving is then the only change', async () => {
      const person = await contact('agent');
      const note = await log('agent', { activityType: 'note', body: 'Original', links: [{ entityType: 'contact', entityId: person.id }] });
      await as('agent').patch(`/api/v1/activities/${note.id}`, { body: '' }, 1).expect(422);
      await sql`update activities set created_at = now() - interval '25 hours' where id = ${note.id}::uuid`.execute(fx.db);
      const read = await as('agent').get(`/api/v1/activities/${note.id}`).expect(200);
      expect(read.body).toMatchObject({ canEdit: false, canArchive: true });
      const late = await as('agent').patch(`/api/v1/activities/${note.id}`, { body: 'Too late' }, read.body.version).expect(422);
      expect(late.body.detail).toContain('24 hours');
      await as('agent2').action(`/api/v1/activities/${note.id}/archive`, read.body.version, { reason: 'Not mine' }).expect(404);
      const archived = await as('agent').action(`/api/v1/activities/${note.id}/archive`, read.body.version, { reason: 'Logged on the wrong contact' }).expect(200);
      expect(archived.body).toMatchObject({ archivedReason: 'Logged on the wrong contact', canEdit: false, canArchive: false });
      await as('agent').action(`/api/v1/activities/${note.id}/archive`, archived.body.version, { reason: 'Again' }).expect(422);
      await as('agent').patch(`/api/v1/activities/${note.id}`, { body: 'x' }, archived.body.version).expect(422);
    });

    it('lets a manager archive entries on records they manage', async () => {
      const person = await contact('sales');
      const managed = await lead('sales', person.id, { assignedTo: members['agent'] });
      const entry = await log('agent', { activityType: 'note', body: 'Agent note', links: [{ entityType: 'lead', entityId: managed.id }] });
      await as('agent2').action(`/api/v1/activities/${entry.id}/archive`, 1, { reason: 'Nope' }).expect(404);
      await as('sales').action(`/api/v1/activities/${entry.id}/archive`, 1, { reason: 'Contains a bank number' }).expect(200);
      const owned = await contact('agent2');
      const agentNote = await log('agent2', { activityType: 'note', body: 'Note', links: [{ entityType: 'contact', entityId: owned.id }] });
      await as('sales').action(`/api/v1/activities/${agentNote.id}/archive`, 1, { reason: 'Office clean-up' }).expect(200);
    });
  });

  describe('follow-ups (F-1, F-2, D6)', () => {
    it('schedules a follow-up on a lead, setting and clearing its next action', async () => {
      const person = await contact('agent');
      const created = await lead('agent', person.id);
      const due = inHours(20);
      const followUp = await task('agent', { title: 'Call back about East Legon options', taskType: 'call', priority: 'high', dueAt: due, remindAt: inHours(19), about: { entityType: 'lead', entityId: created.id } });
      expect(followUp).toMatchObject({
        status: 'open',
        priority: 'high',
        assignedTo: { id: members['agent'] },
        about: { entityType: 'lead', entityId: created.id, label: expect.stringContaining(created.reference) },
        overdue: false,
        reminderDue: false,
        canEdit: true,
        canReassign: false,
      });
      expect((await as('agent').get(`/api/v1/leads/${created.id}`).expect(200)).body.nextActionAt).toBe(new Date(due).toISOString());
      const later = inHours(30);
      await as('agent').patch(`/api/v1/tasks/${followUp.id}`, { dueAt: later }, 1).expect(200);
      expect((await as('agent').get(`/api/v1/leads/${created.id}`).expect(200)).body.nextActionAt).toBe(new Date(later).toISOString());
      await as('agent').action(`/api/v1/tasks/${followUp.id}/complete`, 1).expect(412);
      const done = await as('agent').action(`/api/v1/tasks/${followUp.id}/complete`, 2).expect(200);
      expect(done.body).toMatchObject({ status: 'done', completedBy: { id: members['agent'] }, canEdit: false });
      expect((await as('agent').get(`/api/v1/leads/${created.id}`).expect(200)).body.nextActionAt).toBeNull();
      await as('agent').patch(`/api/v1/tasks/${followUp.id}`, { title: 'x' }, 3).expect(422);
      const doneList = await as('agent').get('/api/v1/tasks?filter[status]=done').expect(200);
      expect(doneList.body.data.map((row: { id: string }) => row.id)).toContain(followUp.id);
    });

    it('keeps assigning to others a manager action within their team (D6)', async () => {
      const person = await contact('sales');
      const managed = await lead('sales', person.id, { assignedTo: members['agent'] });
      const agentTry = await as('agent').post('/api/v1/tasks', { title: 'x', dueAt: inHours(5), assignedTo: members['agent2'] }).expect(422);
      expect(agentTry.body.errors[0]).toMatchObject({ field: 'assignedTo', code: 'not-allowed' });
      const given = await task('sales', { assignedTo: members['agent'], about: { entityType: 'lead', entityId: managed.id } });
      expect(given).toMatchObject({ assignedTo: { id: members['agent'] }, createdBy: { id: members['sales'] }, canReassign: true });
      const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', given.id).execute();
      expect(events.map((e) => e.eventType)).toEqual(['task.assigned']);
      const outside = await as('sales').post('/api/v1/tasks', { title: 'x', dueAt: inHours(5), assignedTo: members['agentKsi'] }).expect(422);
      expect(outside.body.errors[0].code).toBe('not-assignable');
      const cannotOpen = await as('sales').post('/api/v1/tasks', { title: 'x', dueAt: inHours(5), assignedTo: members['agent2'], about: { entityType: 'lead', entityId: managed.id } }).expect(422);
      expect(cannotOpen.body.errors[0].code).toBe('out-of-scope');
      await as('agent').action(`/api/v1/tasks/${given.id}/assign`, 1, { assignedTo: members['agent2'] }).expect(403);
      await as('sales').action(`/api/v1/tasks/${given.id}/assign`, 1, { assignedTo: members['agentKsi'] }).expect(422);
      const same = await as('sales').action(`/api/v1/tasks/${given.id}/assign`, 1, { assignedTo: members['agent'] }).expect(200);
      expect(same.body.version).toBe(1);
      // A follow-up about a contact gives the assignee read access to it (D1).
      const contactTask = await task('sales', { assignedTo: members['agent2'], about: { entityType: 'contact', entityId: person.id } });
      await as('agent2').get(`/api/v1/contacts/${person.id}`).expect(200);
      const reassigned = await as('sales').action(`/api/v1/tasks/${contactTask.id}/assign`, 1, { assignedTo: members['agent'] }).expect(200);
      expect(reassigned.body.assignedTo.id).toBe(members['agent']);
    });

    it('lists mine and the team’s, with overdue, reminder and due-date filters', async () => {
      const mine = await task('agent', { title: 'Mine', dueAt: inHours(2), remindAt: new Date(Date.now() + 60_000).toISOString() });
      const overdue = await task('agent', { title: 'Overdue' });
      await fx.db.updateTable('tasks').set({ dueAt: new Date(Date.now() - 3_600_000), remindAt: new Date(Date.now() - 7_200_000) }).where('id', '=', overdue.id).execute();
      const ids = async (who: string, query = '') => ((await as(who).get(`/api/v1/tasks?limit=100${query}`).expect(200)).body.data as Array<{ id: string }>).map((row) => row.id);
      expect(await ids('agent')).toEqual(expect.arrayContaining([mine.id, overdue.id]));
      expect(await ids('agent', '&filter[overdue]=true')).toEqual([overdue.id]);
      expect(await ids('agent', '&filter[reminderDue]=true')).toEqual([overdue.id]);
      expect(await ids('agent', `&filter[dueAt][gte]=${new Date().toISOString()}&filter[dueAt][lte]=${inHours(3)}`)).toEqual([mine.id]);
      expect(await ids('agent', '&filter[priority]=urgent')).toEqual([]);
      const listed = (await as('agent').get('/api/v1/tasks?limit=100&filter[overdue]=true').expect(200)).body.data[0];
      expect(listed).toMatchObject({ overdue: true, reminderDue: true });
      await as('agent').get('/api/v1/tasks?filter[view]=team').expect(403);
      expect(await ids('sales', '&filter[view]=team')).toEqual(expect.arrayContaining([mine.id, overdue.id]));
      expect(await ids('sales', `&filter[view]=team&filter[assignedTo]=${members['agent2']}`)).not.toContain(mine.id);
      expect(await ids('salesKsi', '&filter[view]=team')).not.toContain(mine.id);
      expect(await ids('owner', '&filter[view]=team')).toEqual(expect.arrayContaining([mine.id]));
      await as('agent').get(`/api/v1/tasks?filter[assignedTo]=${members['agent']}`).expect(422);
      await as('agent').get(`/api/v1/tasks?filter[entityType]=lead`).expect(422);
      const page = await as('agent').get('/api/v1/tasks?limit=1').expect(200);
      const next = await as('agent').get(`/api/v1/tasks?limit=1&cursor=${page.body.page.nextCursor}`).expect(200);
      expect(next.body.data[0].id).not.toBe(page.body.data[0].id);
      const desc = await as('agent').get('/api/v1/tasks?limit=100&sort=-dueAt').expect(200);
      expect(desc.body.data[0].id).not.toBe(overdue.id);
      await as('agent2').get(`/api/v1/tasks/${mine.id}`).expect(404);
      await as('sales').get(`/api/v1/tasks/${mine.id}`).expect(200);
      await as('otherOwner').get(`/api/v1/tasks/${mine.id}`).expect(404);
    });

    it('validates times and what a follow-up is about, and cancels with a reason', async () => {
      const fields = async (body: object) => {
        const res = await as('agent').post('/api/v1/tasks', { title: 'x', dueAt: inHours(2), ...body }).expect(422);
        return (res.body.errors as Array<{ field: string }>).map((e) => e.field).sort();
      };
      expect(await fields({ dueAt: new Date(Date.now() - 3_600_000).toISOString() })).toEqual(['dueAt']);
      expect(await fields({ remindAt: inHours(3) })).toEqual(['remindAt']);
      expect(await fields({ remindAt: new Date(Date.now() - 3_600_000).toISOString() })).toEqual(['remindAt']);
      expect(await fields({ about: { entityType: 'contact', entityId: (await contact('owner')).id } })).toEqual(['about.entityId']);
      expect(await fields({ about: { entityType: 'lead', entityId: randomUUID() } })).toEqual(['about.entityId']);
      const archivedLead = await lead('agent', (await contact('agent')).id);
      await as('agent').action(`/api/v1/leads/${archivedLead.id}/archive`, 1, { reason: 'Spam enquiry' }).expect(200);
      expect(await fields({ about: { entityType: 'lead', entityId: archivedLead.id } })).toEqual(['about.entityId']);
      await as('agent').post('/api/v1/tasks', { title: 'x', dueAt: inHours(2), taskType: 'arrears' }).expect(422);

      const item = await task('agent', { remindAt: inHours(23) });
      const path = `/api/v1/tasks/${item.id}`;
      await as('agent').patch(path, { remindAt: inHours(30) }, 1).expect(422);
      await as('agent').patch(path, { dueAt: inHours(10) }, 1).expect(422);
      const edited = await as('agent').patch(path, { title: 'Send valuation', description: 'With comparables', priority: 'urgent', remindAt: null }, 1).expect(200);
      expect(edited.body).toMatchObject({ title: 'Send valuation', priority: 'urgent', remindAt: null, version: 2 });
      expect((await as('agent').patch(path, { title: 'Send valuation' }, 2).expect(200)).body.version).toBe(2);
      await as('agent').action(`${path}/cancel`, 2, {}).expect(422);
      const cancelled = await as('agent').action(`${path}/cancel`, 2, { reason: 'Client sorted it out' }).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelReason: 'Client sorted it out', canEdit: false });
      await as('agent').action(`${path}/complete`, 3).expect(422);
      const audit = await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', item.id).orderBy('occurredAt').execute();
      expect(audit.map((row) => row.action)).toEqual(['task.created', 'task.updated', 'task.cancelled']);
    });
  });
});
