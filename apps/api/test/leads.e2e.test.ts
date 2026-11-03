import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let phoneCounter = 1000;
const nextPhone = () => `024${String(9100000 + phoneCounter++).padStart(7, '0')}`;

describe('leads (Phase 5 milestone C3, wireframes L-1 to L-4)', () => {
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
      put: (path: string, body: object) => auth(t.http.put(path)).send(body),
      patch: (path: string, body: object, version?: number) => {
        const req = auth(t.http.patch(path)).send(body);
        return version === undefined ? req : req.set('If-Match', `"${version}"`);
      },
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
    };
  };

  async function contact(who: string, overrides: Record<string, unknown> = {}) {
    const res = await as(who).post('/api/v1/contacts', { contactType: 'person', displayName: `Enquirer ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number };
  }

  async function lead(who: string, body: Record<string, unknown>) {
    const res = await as(who).post('/api/v1/leads', { leadType: 'rent', sourceCode: 'walk_in', ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; reference: string; [key: string]: unknown };
  }

  const audits = (entityId: string, action: string) =>
    fx.db.selectFrom('auditLogs').selectAll().where('entityId', '=', entityId).where('action', '=', action).orderBy('occurredAt').execute();

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
      await fx.linkIdentity(member.userId, `lead-${name}-${member.companyId}`);
      tokens[name] = await t.idp.token({ sub: `lead-${name}-${member.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('capture (L-3)', () => {
    it('lets an agent capture a lead for their contact, assigned to themselves, with history and audit', async () => {
      const person = await contact('agent', { primaryPhone: '0245557781' });
      const created = await lead('agent', { contactId: person.id, message: 'Is the flat still available?\nI can view this weekend.', sourceDetail: 'Front desk' });
      expect(created).toMatchObject({
        reference: expect.stringMatching(/^LEA-\d{4}-\d{6}$/),
        contact: { id: person.id, primaryPhoneMasked: expect.stringContaining('•') },
        leadType: 'rent',
        status: 'new',
        sourceCode: 'walk_in',
        office: { id: company.officeId },
        assignedTo: { id: members['agent'] },
        messagePreview: 'Is the flat still available?',
        message: 'Is the flat still available?\nI can view this weekend.',
        response: null,
        score: null,
        scoreBreakdown: [],
        statusHistory: [expect.objectContaining({ fromStatus: null, toStatus: 'new', changedBy: expect.objectContaining({ id: members['agent'] }) })],
        assignments: [expect.objectContaining({ assignedTo: expect.objectContaining({ id: members['agent'] }), assignedBy: expect.objectContaining({ id: members['agent'] }) })],
        access: { canEdit: true, canAssign: false, canReopen: false, nextStatuses: ['contacted', 'qualified', 'unqualified', 'lost'] },
        version: 1,
      });
      expect(JSON.stringify(created)).not.toContain('5557781');
      const [audit] = await audits(created.id, 'lead.created');
      expect(audit!.metadata).toMatchObject({ contactId: person.id, contactCreated: false, assignedTo: members['agent'] });
      const read = await as('agent').get(`/api/v1/leads/${created.id}`).expect(200);
      expect(read.headers['etag']).toBe('"1"');
    });

    it('creates the contact inline, running the duplicate check and reporting its field errors under contact.', async () => {
      const phone = nextPhone();
      const created = await lead('sales', { contact: { contactType: 'person', displayName: 'Walk-in Visitor', primaryPhone: phone }, leadType: 'buy' });
      const [audit] = await audits(created.id, 'lead.created');
      expect(audit!.metadata).toMatchObject({ contactCreated: true });
      const again = await as('sales').post('/api/v1/leads', { contact: { contactType: 'person', displayName: 'Same Visitor', primaryPhone: phone }, leadType: 'buy', sourceCode: 'walk_in' }).expect(409);
      expect(again.body.type).toMatch(/possible-duplicates$/);
      const invalid = await as('sales').post('/api/v1/leads', { contact: { contactType: 'person', displayName: 'No Phone' }, leadType: 'buy', sourceCode: 'walk_in' }).expect(422);
      expect(invalid.body.errors[0].field).toBe('contact.primaryPhone');
      await as('sales').post('/api/v1/leads', { leadType: 'buy', sourceCode: 'walk_in' }).expect(422);
      const both = await as('sales').post('/api/v1/leads', { contactId: randomUUID(), contact: { contactType: 'person', displayName: 'X', primaryPhone: nextPhone() }, leadType: 'buy', sourceCode: 'walk_in' }).expect(422);
      expect(both.body.errors[0].code).toBe('one-of');
    });

    it('validates the source, listing, requirement, timing and contact', async () => {
      const person = await contact('owner');
      const archived = await contact('owner');
      await as('owner').action(`/api/v1/contacts/${archived.id}/archive`, archived.version, { reason: 'Moved abroad' }).expect(200);
      const fields = async (body: object, who = 'owner') => {
        const res = await as(who).post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'walk_in', ...body }).expect(422);
        return (res.body.errors as Array<{ field: string }>).map((e) => e.field).sort();
      };
      expect(await fields({ sourceCode: 'carrier_pigeon' })).toEqual(['sourceCode']);
      expect(await fields({ listingId: randomUUID() })).toEqual(['listingId']);
      expect(await fields({ requirementId: randomUUID() })).toEqual(['requirementId']);
      expect(await fields({ receivedAt: new Date(Date.now() + 3_600_000).toISOString() })).toEqual(['receivedAt']);
      expect(await fields({ contactId: archived.id })).toEqual(['contactId']);
      expect(await fields({ contactId: randomUUID() })).toEqual(['contactId']);
      expect(await fields({ officeId: randomUUID() })).toEqual(['officeId']);
      expect(await fields({ officeId: kumasiOfficeId }, 'sales')).toEqual(['officeId']);
      await as('accountant').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'walk_in' }).expect(403);
      await as('owner').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'walk_in', status: 'converted' }).expect(422);
    });

    it('keeps assignment a manager action (D6), within the manager’s offices', async () => {
      const person = await contact('sales');
      const agentTry = await as('agent').post('/api/v1/leads', { contactId: (await contact('agent')).id, leadType: 'buy', sourceCode: 'phone', assignedTo: members['agent2'] }).expect(422);
      expect(agentTry.body.errors[0]).toMatchObject({ field: 'assignedTo', code: 'not-allowed' });
      const assigned = await lead('sales', { contactId: person.id, assignedTo: members['agent'] });
      expect(assigned['assignedTo']).toMatchObject({ id: members['agent'] });
      const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', assigned.id).execute();
      expect(events.map((e) => e.eventType).sort()).toEqual(['lead.assigned', 'lead.created']);
      const wrongOffice = await as('sales').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'phone', assignedTo: members['agentKsi'] }).expect(422);
      expect(wrongOffice.body.errors[0].field).toBe('assignedTo');
      const nobody = await as('sales').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'phone', assignedTo: members['accountant'] }).expect(422);
      expect(nobody.body.errors[0].code).toBe('not-assignable');
      const unassigned = await as('sales').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'portal', assignedTo: null }).expect(422);
      expect(unassigned.body.errors[0].field).toBe('sourceCode');
      const inbox = await lead('sales', { contactId: person.id, sourceCode: 'property_portal', assignedTo: null });
      expect(inbox).toMatchObject({ assignedTo: null, assignments: [], office: { id: company.officeId } });
      const agentInbox = await as('agent').post('/api/v1/leads', { contactId: (await contact('agent')).id, leadType: 'buy', sourceCode: 'phone', assignedTo: null }).expect(422);
      expect(agentInbox.body.errors[0]).toMatchObject({ field: 'assignedTo', code: 'not-allowed' });
      const defaulted = await lead('owner', { contactId: (await contact('owner')).id });
      expect(defaulted['assignedTo']).toMatchObject({ id: members['owner'] });
    });
  });

  describe('inbox and register (L-1)', () => {
    it('scopes the inbox: agents see their own leads, managers their offices', async () => {
      const mine = await lead('agent', { contactId: (await contact('agent')).id });
      const theirs = await lead('agent2', { contactId: (await contact('agent2')).id });
      const ksi = await lead('salesKsi', { contactId: (await contact('salesKsi')).id, officeId: kumasiOfficeId });
      const ids = async (who: string) => ((await as(who).get('/api/v1/leads?limit=100').expect(200)).body.data as Array<{ id: string }>).map((row) => row.id);
      const agentView = await ids('agent');
      expect(agentView).toContain(mine.id);
      expect(agentView).not.toContain(theirs.id);
      const salesView = await ids('sales');
      expect(salesView).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      expect(salesView).not.toContain(ksi.id);
      expect(await ids('owner')).toEqual(expect.arrayContaining([mine.id, theirs.id, ksi.id]));
      await as('agent').get(`/api/v1/leads/${theirs.id}`).expect(404);
      await as('accountant').get('/api/v1/leads').expect(403);
      expect((await as('otherOwner').get('/api/v1/leads').expect(200)).body.data).toHaveLength(0);
      await as('otherOwner').get(`/api/v1/leads/${mine.id}`).expect(404);
    });

    it('filters by status, assignee, search, date and attention, with keyset paging', async () => {
      const person = await contact('sales', { displayName: 'Efua Searchable' });
      const created = await lead('sales', { contactId: person.id, assignedTo: null, receivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
      const has = async (who: string, query: string) =>
        ((await as(who).get(`/api/v1/leads?limit=100&${query}`).expect(200)).body.data as Array<{ id: string }>).some((row) => row.id === created.id);
      expect(await has('sales', 'filter[assignedTo]=unassigned')).toBe(true);
      await as('agent').get('/api/v1/leads?filter[assignedTo]=unassigned').expect(403);
      expect(await has('sales', 'filter[assignedTo]=me')).toBe(false);
      expect(await has('sales', 'q=Efua')).toBe(true);
      expect(await has('sales', `q=${created.reference}`)).toBe(true);
      expect(await has('sales', 'filter[status]=new&filter[leadType]=rent&filter[sourceCode]=walk_in')).toBe(true);
      expect(await has('sales', 'filter[status]=lost')).toBe(false);
      expect(await has('sales', `filter[receivedAt][lte]=${new Date(Date.now() - 3_600_000).toISOString()}`)).toBe(true);
      expect(await has('sales', `filter[receivedAt][gte]=${new Date(Date.now() - 60_000).toISOString()}`)).toBe(false);
      expect(await has('sales', 'filter[attention]=no_next_action')).toBe(true);
      expect(await has('sales', `filter[contactId]=${person.id}`)).toBe(true);
      const first = await as('owner').get('/api/v1/leads?limit=2').expect(200);
      const second = await as('owner').get(`/api/v1/leads?limit=2&cursor=${first.body.page.nextCursor}`).expect(200);
      expect(second.body.data[0].id).not.toBe(first.body.data[1].id);
      await as('owner').get('/api/v1/leads?filter[assignedTo]=someone').expect(422);
    });

    it('reports the response target only once the company sets one (D3)', async () => {
      const person = await contact('sales');
      const created = await lead('sales', { contactId: person.id, receivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
      expect(created['response']).toBeNull();
      const noTarget = await as('sales').get('/api/v1/leads?filter[attention]=response_overdue').expect(422);
      expect(noTarget.body.errors[0].code).toBe('no-response-target');
      expect((await as('sales').get('/api/v1/settings/crm').expect(200)).body).toEqual({ leadResponseMinutes: null });
      await as('sales').put('/api/v1/settings/crm', { leadResponseMinutes: 30 }).expect(403);
      await as('owner').put('/api/v1/settings/crm', { leadResponseMinutes: 0 }).expect(422);
      await as('owner').put('/api/v1/settings/crm', { leadResponseMinutes: 30 }).expect(200);
      await as('owner').put('/api/v1/settings/crm', { leadResponseMinutes: 30 }).expect(200);
      const read = await as('sales').get(`/api/v1/leads/${created.id}`).expect(200);
      expect(read.body.response).toMatchObject({ overdue: true, late: false });
      const overdue = await as('sales').get('/api/v1/leads?limit=100&filter[attention]=response_overdue').expect(200);
      expect(overdue.body.data.map((row: { id: string }) => row.id)).toContain(created.id);
      const changes = await fx.db.selectFrom('auditLogs').select('changes').where('action', '=', 'settings.crm_updated').where('entityId', '=', company.companyId).execute();
      expect(changes).toHaveLength(1);
      await as('owner').put('/api/v1/settings/crm', { leadResponseMinutes: null }).expect(200);
      expect((await as('sales').get(`/api/v1/leads/${created.id}`).expect(200)).body.response).toBeNull();
    });
  });

  describe('status, assignment and editing (L-2, L-4)', () => {
    it('moves through allowed statuses with If-Match, history, a timeline entry and audit', async () => {
      const person = await contact('agent');
      const created = await lead('agent', { contactId: person.id });
      const path = `/api/v1/leads/${created.id}/status`;
      await as('agent').post(path, { status: 'contacted' }).expect(428);
      await as('agent').action(path, 9, { status: 'contacted' }).expect(412);
      const contacted = await as('agent').action(path, 1, { status: 'contacted', note: 'Called back' }).expect(200);
      expect(contacted.body).toMatchObject({ status: 'contacted', version: 2, access: { nextStatuses: ['qualified', 'unqualified', 'lost'] } });
      expect(contacted.headers['etag']).toBe('"2"');
      const back = await as('agent').action(path, 2, { status: 'contacted' }).expect(422);
      expect(back.body.detail).toContain('qualified, unqualified, lost');
      await as('agent').action(path, 2, { status: 'converted' }).expect(422);
      const noReason = await as('agent').action(path, 2, { status: 'lost' }).expect(422);
      expect(noReason.body.errors[0].field).toBe('lostReasonCode');
      await as('agent').action(path, 2, { status: 'lost', lostReasonCode: 'aliens' }).expect(422);
      await as('agent').action(path, 2, { status: 'qualified', lostReasonCode: 'price' }).expect(422);
      const lost = await as('agent').action(path, 2, { status: 'lost', lostReasonCode: 'bought_elsewhere' }).expect(200);
      expect(lost.body).toMatchObject({ status: 'lost', lostReasonCode: 'bought_elsewhere', access: { nextStatuses: [], canReopen: false } });
      // Reopening is a manager action and needs a reason.
      await as('agent').action(path, 3, { status: 'contacted', note: 'They called again' }).expect(403);
      await as('sales').action(path, 3, { status: 'contacted' }).expect(422);
      const reopened = await as('sales').action(path, 3, { status: 'contacted', note: 'They called again' }).expect(200);
      expect(reopened.body).toMatchObject({ status: 'contacted', lostReasonCode: null });
      expect(reopened.body.statusHistory.map((h: { toStatus: string }) => h.toStatus)).toEqual(['new', 'contacted', 'lost', 'contacted']);
      const timeline = await as('agent').get(`/api/v1/leads/${created.id}/activities?filter[activityType]=status_change`).expect(200);
      expect(timeline.body.data.map((a: { subject: string }) => a.subject)).toEqual([
        `${created.reference}: Lost → Contacted`,
        `${created.reference}: Contacted → Lost`,
        `${created.reference}: New → Contacted`,
      ]);
      expect(timeline.body.data.every((a: { isSystem: boolean; canEdit: boolean }) => a.isSystem && !a.canEdit)).toBe(true);
      const statusAudits = await audits(created.id, 'lead.status_changed');
      expect(statusAudits).toHaveLength(3);
      expect(statusAudits[2]!.metadata).toMatchObject({ reopened: true });
      const unqualified = await as('agent').action(path, 4, { status: 'unqualified' }).expect(422);
      expect(unqualified.body.errors[0].field).toBe('note');
    });

    it('assigns within the manager’s scope and keeps the assignment history', async () => {
      const created = await lead('sales', { contactId: (await contact('sales')).id, assignedTo: members['agent'] });
      const path = `/api/v1/leads/${created.id}/assign`;
      await as('agent').action(path, 1, { assignedTo: members['agent2'] }).expect(403);
      await as('sales').action(path, 1, { assignedTo: members['agentKsi'] }).expect(422);
      await as('sales').action(path, 1, { assignedTo: randomUUID() }).expect(422);
      const same = await as('sales').action(path, 1, { assignedTo: members['agent'] }).expect(200);
      expect(same.body.version).toBe(1);
      const moved = await as('sales').action(path, 1, { assignedTo: members['agent2'], note: 'Agent on leave' }).expect(200);
      expect(moved.body.assignments.map((a: { assignedTo: { id: string } }) => a.assignedTo.id)).toEqual([members['agent'], members['agent2']]);
      expect(moved.body.assignments[1]).toMatchObject({ note: 'Agent on leave', assignedBy: { id: members['sales'] } });
      await as('agent').get(`/api/v1/leads/${created.id}`).expect(404);
      await as('agent2').get(`/api/v1/leads/${created.id}`).expect(200);
      await as('salesKsi').action(path, 2, { assignedTo: members['agentKsi'] }).expect(404);
      // A company-wide manager may assign anyone, but only to someone who works in the lead's office.
      const elsewhere = await as('owner').action(path, 2, { assignedTo: members['salesKsi'] }).expect(422);
      expect(elsewhere.body.errors[0]).toMatchObject({ field: 'assignedTo', code: 'out-of-scope' });
    });

    it('shows a score only with its breakdown (CRM-07, D7)', async () => {
      const created = await lead('owner', { contactId: (await contact('owner')).id });
      await fx.db
        .updateTable('leads')
        .set({ score: 62, scoreBreakdown: JSON.stringify({ 'Budget stated': 20, 'Move date within 60 days': 20, 'Responded to call': 22, note: 'ignored' }) })
        .where('id', '=', created.id)
        .execute();
      const read = await as('owner').get(`/api/v1/leads/${created.id}`).expect(200);
      expect(read.body).toMatchObject({
        score: 62,
        scoreBreakdown: [
          { rule: 'Responded to call', points: 22 },
          { rule: 'Budget stated', points: 20 },
          { rule: 'Move date within 60 days', points: 20 },
        ],
      });
    });

    it('edits details, refuses moves out of scope, and archives only without open follow-ups', async () => {
      const person = await contact('sales');
      const created = await lead('sales', { contactId: person.id });
      const path = `/api/v1/leads/${created.id}`;
      const same = await as('sales').patch(path, { leadType: 'rent' }, 1).expect(200);
      expect(same.body.version).toBe(1);
      const edited = await as('sales').patch(path, { leadType: 'let', campaign: 'Harmattan open day', sourceCode: 'referral', sourceDetail: '' }, 1).expect(200);
      expect(edited.body).toMatchObject({ leadType: 'let', campaign: 'Harmattan open day', sourceCode: 'referral', sourceDetail: null, version: 2 });
      await as('sales').patch(path, { officeId: kumasiOfficeId }, 2).expect(422);
      await as('sales').patch(path, { sourceCode: 'telepathy' }, 2).expect(422);
      await as('sales').patch(path, { requirementId: randomUUID() }, 2).expect(422);
      await as('sales').patch(path, { listingId: randomUUID() }, 2).expect(422);
      await as('owner').patch(path, { officeId: kumasiOfficeId }, 2).expect(200);
      await as('sales').get(path).expect(404);
      const task = await as('owner').post('/api/v1/tasks', { title: 'Call back', dueAt: new Date(Date.now() + 86_400_000).toISOString(), about: { entityType: 'lead', entityId: created.id } }).expect(201);
      await as('owner').action(`${path}/archive`, 4, { reason: 'Duplicate enquiry' }).expect(422);
      await as('owner').action(`/api/v1/tasks/${task.body.id}/complete`, 1).expect(200);
      const archived = await as('owner').action(`${path}/archive`, 5, { reason: 'Duplicate enquiry' }).expect(200);
      expect(archived.body).toMatchObject({ archivedReason: 'Duplicate enquiry', access: { canEdit: false, canAssign: false } });
      await as('owner').action(`${path}/status`, 6, { status: 'contacted' }).expect(422);
      await as('owner').action(`${path}/archive`, 6, { reason: 'Again' }).expect(422);
      const list = await as('owner').get('/api/v1/leads?limit=100').expect(200);
      expect(list.body.data.map((row: { id: string }) => row.id)).not.toContain(created.id);
      const archivedList = await as('owner').get('/api/v1/leads?limit=100&filter[archived]=true').expect(200);
      expect(archivedList.body.data.map((row: { id: string }) => row.id)).toContain(created.id);
      const restored = await as('owner').action(`${path}/restore`, 6).expect(200);
      expect(restored.body.archivedAt).toBeNull();
      await as('owner').action(`${path}/restore`, 7).expect(422);
    });
  });
});
