import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let phoneCounter = 2000;
const nextPhone = () => `024${String(9500000 + phoneCounter++).padStart(7, '0')}`;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

describe('dashboards (Phase 5 milestone C4; D-A, D-C, D-M)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const get = (who: string, path: string) =>
    t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', who === 'otherOwner' ? other.companyId : company.companyId);
  const post = (who: string, path: string, body: object) =>
    t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', company.companyId).send(body);

  async function contact(who: string, overrides: Record<string, unknown> = {}) {
    const res = await post(who, '/api/v1/contacts', { contactType: 'person', displayName: `Dash ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  async function lead(values: { contactId: string; assignedTo: string | null; officeId: string; status?: string; sourceCode?: string; receivedAt?: Date; firstResponseAt?: Date }) {
    const row = await fx.db
      .insertInto('leads')
      .values({
        companyId: company.companyId,
        reference: `LEA-D-${randomUUID().slice(0, 8)}`,
        contactId: values.contactId,
        leadType: 'buy',
        status: values.status ?? 'new',
        sourceCode: values.sourceCode ?? 'website',
        officeId: values.officeId,
        assignedTo: values.assignedTo,
        receivedAt: values.receivedAt ?? new Date(),
        firstResponseAt: values.firstResponseAt ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function task(assignedTo: string, dueAt: Date, title = 'Follow up') {
    return (
      await fx.db
        .insertInto('tasks')
        .values({ companyId: company.companyId, title, assignedTo, dueAt, createdBy: assignedTo })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      admin: { ...(await fx.member(company.companyId, { roleKey: 'office_admin' })), companyId: company.companyId },
      sales: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      salesKsi: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      agent2: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [name, member] of Object.entries(people)) {
      members[name] = member.membershipId;
      await fx.linkIdentity(member.userId, `dash-${name}-${member.companyId}`);
      tokens[name] = await t.idp.token({ sub: `dash-${name}-${member.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }

    // HQ: agent has a new lead (2 h old, unanswered) and an answered one; agent2 has a qualified lead;
    // one unassigned new lead; Kumasi has one lead.
    const c1 = await contact('owner');
    ids['agentNew'] = await lead({ contactId: c1, assignedTo: members['agent']!, officeId: company.officeId, receivedAt: hoursAgo(2) });
    ids['agentAnswered'] = await lead({ contactId: c1, assignedTo: members['agent']!, officeId: company.officeId, status: 'contacted', receivedAt: hoursAgo(5), firstResponseAt: hoursAgo(4.5) });
    ids['agent2Qualified'] = await lead({ contactId: c1, assignedTo: members['agent2']!, officeId: company.officeId, status: 'qualified', sourceCode: 'referral', receivedAt: hoursAgo(30), firstResponseAt: hoursAgo(29) });
    await fx.db.insertInto('leadStatusHistory').values({ companyId: company.companyId, leadId: ids['agent2Qualified'], fromStatus: 'contacted', toStatus: 'qualified' }).execute();
    ids['unassigned'] = await lead({ contactId: c1, assignedTo: null, officeId: company.officeId, receivedAt: hoursAgo(3) });
    ids['kumasi'] = await lead({ contactId: c1, assignedTo: members['salesKsi']!, officeId: kumasiOfficeId });
    // Follow-ups: agent overdue, today (later), next week; agent2 tomorrow.
    ids['overdueTask'] = await task(members['agent']!, hoursAgo(1), 'Overdue call');
    await task(members['agent']!, new Date(Date.now() + 10 * 60_000), 'Soon call');
    await task(members['agent']!, new Date(Date.now() + 9 * 86_400_000), 'Next week');
    await task(members['agent2']!, new Date(Date.now() + 26 * 3_600_000), 'Tomorrow');
    // Requirements: one buy with no listings to match, one rent.
    await post('owner', `/api/v1/contacts/${c1}/requirements`, { requirementType: 'buy', currencyCode: 'GHS', maxPrice: '1000' }).expect(201);
    await post('owner', `/api/v1/contacts/${c1}/requirements`, { requirementType: 'rent', currencyCode: 'GHS' }).expect(201);
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('CRM dashboard (D-C)', () => {
    it('shows the owner every office, with response times per agent once a target is set', async () => {
      const before = await get('owner', '/api/v1/dashboards/crm').expect(200);
      expect(before.body.responseTargetMinutes).toBeNull();
      expect(before.body.newNotContacted.items[0].overdue).toBeNull();
      await t.http.put('/api/v1/settings/crm').auth(tokens['owner']!, { type: 'bearer' }).set('X-Company-Id', company.companyId).send({ leadResponseMinutes: 60 }).expect(200);
      const pending = await get('owner', '/api/v1/dashboards/crm').expect(200);
      expect(pending.body.requirements).toMatchObject({ buy: 1, rent: 1, noMatch: 0, noMatchPending: 2, noMatchCheckedAt: null });
      // The worker refreshes the "no match" status every 15 minutes.
      const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const { worker, close } = createWorker(t.config, silent, { scheduleEveryMs: 0 });
      try {
        await worker.runOnce();
      } finally {
        await close();
      }
      const res = await get('owner', '/api/v1/dashboards/crm?days=30&timezone=Africa/Accra').expect(200);
      const body = res.body;
      expect(body.scope).toMatchObject({ officeId: null, timezone: 'Africa/Accra' });
      expect(body.responseTargetMinutes).toBe(60);
      expect(body.newNotContacted.total).toBe(3);
      expect(body.newNotContacted.items.map((item: { id: string }) => item.id)).toEqual([ids['unassigned'], ids['agentNew'], ids['kumasi']]);
      expect(body.newNotContacted.items[0]).toMatchObject({ assignedTo: null, overdue: true });
      expect(body.newNotContacted.items[2]).toMatchObject({ overdue: false });
      expect(body.leadsByStatus).toEqual({ new: 3, contacted: 1, qualified: 1, unqualified: 0, lost: 0 });
      const agentRow = body.responseTimes.find((row: { assignee: { id: string } }) => row.assignee.id === members['agent']);
      expect(agentRow).toMatchObject({ leads: 2, medianFirstResponseMinutes: 30, withinTarget: 1, withinTargetPercent: 50, qualified: 0 });
      const agent2Row = body.responseTimes.find((row: { assignee: { id: string } }) => row.assignee.id === members['agent2']);
      expect(agent2Row).toMatchObject({ leads: 1, qualified: 1, withinTargetPercent: 100 });
      expect(body.leadsBySource.map((row: { sourceCode: string }) => row.sourceCode)).toEqual(['website', 'referral']);
      expect(body.followUps).toMatchObject({ view: 'team', overdue: 1 });
      expect(body.followUps.today).toBeGreaterThanOrEqual(1);
      expect(body.requirements).toMatchObject({ buy: 1, rent: 1, noMatch: 2, noMatchPending: 0, noMatchCheckedAt: expect.any(String) });
    });

    it('limits an office manager to their office and an agent to their own leads, without the per-agent table', async () => {
      const sales = await get('sales', '/api/v1/dashboards/crm').expect(200);
      expect(sales.body.newNotContacted.total).toBe(2);
      expect(sales.body.responseTimes.map((row: { assignee: { id: string } }) => row.assignee.id)).not.toContain(members['salesKsi']);
      expect(sales.body.followUps.overdue).toBe(1);
      const ksi = await get('salesKsi', '/api/v1/dashboards/crm').expect(200);
      expect(ksi.body.newNotContacted.items.map((item: { id: string }) => item.id)).toEqual([ids['kumasi']]);
      expect(ksi.body.followUps).toMatchObject({ overdue: 0, today: 0 });
      const agent = await get('agent', '/api/v1/dashboards/crm').expect(200);
      expect(agent.body).toMatchObject({ responseTimes: null, followUps: { view: 'mine', overdue: 1 } });
      expect(agent.body.newNotContacted.items.map((item: { id: string }) => item.id)).toEqual([ids['agentNew']]);
      expect(agent.body.leadsByStatus).toMatchObject({ new: 1, contacted: 1, qualified: 0 });
      const filtered = await get('owner', `/api/v1/dashboards/crm?officeId=${kumasiOfficeId}`).expect(200);
      expect(filtered.body.newNotContacted.total).toBe(1);
      expect(filtered.body.requirements).toMatchObject({ buy: 0, rent: 0 });
    });

    it('validates its parameters and permissions', async () => {
      await get('sales', `/api/v1/dashboards/crm?officeId=${kumasiOfficeId}`).expect(422);
      await get('owner', `/api/v1/dashboards/crm?officeId=${randomUUID()}`).expect(422);
      await get('owner', '/api/v1/dashboards/crm?officeId=nope').expect(422);
      await get('owner', '/api/v1/dashboards/crm?days=0').expect(422);
      await get('owner', '/api/v1/dashboards/crm?timezone=Mars/Olympus').expect(422);
      await get('owner', '/api/v1/dashboards/crm?colour=red').expect(422);
      await get('accountant', '/api/v1/dashboards/crm').expect(403);
      const isolated = await get('otherOwner', '/api/v1/dashboards/crm').expect(200);
      expect(isolated.body.newNotContacted.total).toBe(0);
      expect(isolated.body.leadsByStatus).toEqual({ new: 0, contacted: 0, qualified: 0, unqualified: 0, lost: 0 });
    });
  });

  describe('admin dashboard (D-A)', () => {
    it('reports access, lead flow, data quality, privacy and account figures in one place', async () => {
      const shared = nextPhone();
      const first = await contact('owner', { primaryPhone: shared });
      await post('owner', '/api/v1/contacts', { contactType: 'person', displayName: 'Same phone', primaryPhone: shared, confirmNotDuplicate: true }).expect(201);
      await fx.db.updateTable('contacts').set({ ownerMembershipId: null }).where('id', '=', first).execute();
      const roleId = (await fx.db.selectFrom('roles').select('id').where('key', '=', 'agent').where('companyId', 'is', null).executeTakeFirstOrThrow()).id;
      await fx.db
        .insertInto('invitations')
        .values([
          { companyId: company.companyId, email: `pending-${randomUUID()}@x.test`, roleId, tokenHash: Buffer.from(randomUUID()), invitedBy: members['owner']!, expiresAt: new Date(Date.now() + 86_400_000) },
          { companyId: company.companyId, email: `expired-${randomUUID()}@x.test`, roleId, tokenHash: Buffer.from(randomUUID()), invitedBy: members['owner']!, expiresAt: hoursAgo(1) },
        ])
        .execute();
      await fx.db.insertInto('auditLogs').values({ companyId: company.companyId, action: 'contact.sensitive_revealed', entityType: 'contact', entityId: first, actorType: 'user' }).execute();
      await post('owner', `/api/v1/contacts/${first}/consents`, { purpose: 'marketing', channel: 'email', status: 'withdrawn', capturedVia: 'portal' }).expect(201);

      const res = await get('admin', '/api/v1/dashboards/admin').expect(200);
      const body = res.body;
      expect(body.usersAndAccess).toEqual({ pendingInvitations: 1, expiredInvitations: 1, usersWithoutRequiredMfa: null, agentLicencesExpiring: 0 });
      expect(body.dataQuality.possibleDuplicateGroups).toBeGreaterThanOrEqual(1);
      expect(body.dataQuality.contactsWithoutOwner).toBeGreaterThanOrEqual(1);
      expect(body.privacy).toMatchObject({ dataSubjectRequestsOpen: null, marketingWithdrawals: 1, sensitiveReveals: 1 });
      expect(body.leadFlow.responseTargetMinutes).toBe(60);
      const hq = body.leadFlow.offices.find((row: { office: { id: string } | null }) => row.office?.id === company.officeId);
      expect(hq).toMatchObject({ unassigned: 1, noResponsePastTarget: 2 });
      expect(body.needsAttention.map((item: { code: string }) => item.code)).toEqual(expect.arrayContaining(['unassigned_leads', 'response_overdue', 'expired_invitations']));
      expect(body.needsAttention.length).toBeLessThanOrEqual(5);
      expect(body.needsAttention.find((item: { code: string }) => item.code === 'unassigned_leads')).toMatchObject({ count: 1, link: '/api/v1/leads?filter[assignedTo]=unassigned' });
      expect(body.account.users.used).toBeGreaterThanOrEqual(7);
      expect(body.account.storage).toHaveProperty('used');
      const kumasi = await get('owner', `/api/v1/dashboards/admin?officeId=${kumasiOfficeId}`).expect(200);
      expect(kumasi.body.leadFlow.offices.map((row: { office: { id: string } }) => row.office.id)).toEqual([kumasiOfficeId]);
      await get('owner', '/api/v1/dashboards/admin?days=3').expect(422);
      await get('sales', '/api/v1/dashboards/admin').expect(403);
      await get('agent', '/api/v1/dashboards/admin').expect(403);
    });
  });

  describe('my day (D-M)', () => {
    it('lists my follow-ups due today or overdue and my new leads, overdue first', async () => {
      const res = await get('agent', '/api/v1/dashboards/my-day?timezone=Africa/Accra').expect(200);
      const body = res.body;
      expect(body.timezone).toBe('Africa/Accra');
      expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const titles = body.today.map((item: { title: string }) => item.title);
      // Both overdue items (the lead is past its response target) come first, oldest first.
      expect(titles.slice(0, 2)).toEqual(['New buy lead', 'Overdue call']);
      expect(titles[2]).toBe('Soon call');
      expect(titles).not.toContain('Next week');
      expect(body.today[1]).toMatchObject({ kind: 'follow_up', overdue: true, version: 1 });
      expect(body.today[0]).toMatchObject({ kind: 'new_lead', overdue: true, aboutType: 'lead', version: null });
      expect(body.laterThisWeek).toBeGreaterThanOrEqual(0);
      expect(body.waitingOnMe).toEqual({ newLeadsAssigned: 1, overdueFollowUps: 1, leadsPastTarget: 1 });
      expect(body.myLeadsByStatus).toMatchObject({ new: 1, contacted: 1 });
      const other = await get('agent2', '/api/v1/dashboards/my-day').expect(200);
      expect(other.body.today.map((item: { title: string }) => item.title)).not.toContain('Overdue call');
      await get('agent', '/api/v1/dashboards/my-day?officeId=x').expect(422);
      await get('accountant', '/api/v1/dashboards/my-day').expect(403);
    });
  });
});
