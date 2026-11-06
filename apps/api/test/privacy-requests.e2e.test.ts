import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ErasureLedger } from '../src/privacy/erasure-ledger.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let counter = 0;
const nextPhone = () => `024${String(8500000 + counter++).padStart(7, '0')}`;
const today = () => new Date().toISOString().slice(0, 10);
const daysFrom = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/**
 * Data-subject request register (gap G3): access and erasure requests,
 * lifecycle, assignment, due dates, evidence, history, fulfilment, merge
 * blocking, the admin dashboard, permissions and tenant isolation.
 */
describe('data-subject request register (gap G3)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let ledger: ErasureLedger;
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
    };
  };

  async function contact(overrides: Record<string, unknown> = {}) {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: `DSR ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; displayName: string };
  }

  async function request(contactId: string, overrides: Record<string, unknown> = {}, who = 'owner') {
    const res = await as(who).post('/api/v1/privacy-requests', { contactId, requestType: 'erasure', channel: 'email', receivedOn: today(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; reference: string; status: string; dueOn: string; [key: string]: unknown };
  }

  /** Verifies identity and starts work: the state in which a request can be fulfilled. */
  async function started(id: string, version: number) {
    const verified = await as('owner').action(`/api/v1/privacy-requests/${id}/verify-identity`, version, { method: 'documents_seen', note: 'Passport seen at the Osu office' }).expect(200);
    return (await as('owner').action(`/api/v1/privacy-requests/${id}/status`, verified.body.version, { status: 'in_progress' }).expect(200)).body as { id: string; version: number; [key: string]: unknown };
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ledger = ErasureLedger.fromConfig(t.config);
    company = await fx.company();
    other = await fx.company();
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      admin: { ...(await fx.member(company.companyId, { roleKey: 'office_admin' })), companyId: company.companyId },
      sales: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [name, person] of Object.entries(people)) {
      members[name] = person.membershipId;
      await fx.linkIdentity(person.userId, `dsr-${name}-${person.companyId}`);
      tokens[name] = await t.idp.token({ sub: `dsr-${name}-${person.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    // The owner, signed in with a second factor 10 minutes ago: past the reveal window.
    tokens['ownerStale'] = await t.idp.token({ sub: `dsr-owner-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: now - 600 });
  });

  afterAll(async () => {
    ledger.destroy();
    await fx.close();
    await t.close();
  });

  describe('logging and tracking', () => {
    it('logs a request with a reference, a due date one month after receipt, the first evidence and its history', async () => {
      const person = await contact();
      const received = daysFrom(today(), -5);
      const created = await request(person.id, { requestType: 'access', channel: 'post', receivedOn: received, assignedTo: members['admin'], summary: 'Letter asking for a copy of their data' });
      expect(created).toMatchObject({
        reference: expect.stringMatching(/^DSR-/),
        requestType: 'access',
        status: 'received',
        channel: 'post',
        receivedOn: received,
        dueOn: daysFrom(received, 30),
        originalDueOn: daysFrom(received, 30),
        daysLeft: 25,
        overdue: false,
        identityVerified: false,
        assignedTo: { id: members['admin'] },
        contact: { id: person.id, name: person.displayName },
        nextStatuses: ['verifying', 'refused', 'withdrawn'],
        canManage: true,
        canFulfil: false,
      });
      expect(created['evidence']).toEqual([expect.objectContaining({ kind: 'request', summary: 'Letter asking for a copy of their data', receivedOn: received })]);
      expect(created['history']).toEqual([expect.objectContaining({ eventType: 'created', toStatus: 'received', actor: expect.objectContaining({ id: members['owner'] }) })]);
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'metadata']).where('entityId', '=', created.id).execute();
      expect(audit.map((row) => row.action)).toEqual(['privacy.request_created']);
    });

    it('refuses requests that cannot be logged', async () => {
      const person = await contact();
      const organisation = await contact({ contactType: 'organisation', organisationName: 'Not A Person Ltd', displayName: 'Not A Person Ltd' });
      const errors = async (body: Record<string, unknown>) =>
        ((await as('owner').post('/api/v1/privacy-requests', { contactId: person.id, requestType: 'access', channel: 'email', receivedOn: today(), ...body }).expect(422)).body.errors as { field: string; code: string }[]).map(
          (error) => `${error.field}:${error.code}`,
        );
      expect(await errors({ receivedOn: daysFrom(today(), 2) })).toEqual(['receivedOn:future']);
      expect(await errors({ receivedOn: '2026-02-30' })).toEqual(['receivedOn:invalid']);
      expect(await errors({ contactId: randomUUID() })).toEqual(['contactId:not-found']);
      expect(await errors({ contactId: organisation.id, requestType: 'erasure' })).toEqual(['contactId:not-a-person']);
      expect(await errors({ assignedTo: members['agent'] })).toEqual(['assignedTo:not-assignable']);
      expect((await as('owner').post('/api/v1/privacy-requests', { contactId: person.id, requestType: 'rectification', channel: 'email', receivedOn: today() })).status).toBe(422);
    });

    it('moves through its lifecycle: identity first, a due date extended once, refusals explained, closed requests final', async () => {
      const person = await contact();
      const created = await request(person.id, { requestType: 'access' });
      const path = `/api/v1/privacy-requests/${created.id}`;
      const early = await as('owner').action(`${path}/status`, created.version, { status: 'in_progress' }).expect(422);
      expect(early.body.errors[0].code).toBe('identity-not-verified');
      const verifying = await as('admin').action(`${path}/status`, created.version, { status: 'verifying' }).expect(200);
      expect(verifying.body).toMatchObject({ status: 'verifying', nextStatuses: ['refused', 'withdrawn'] });
      await as('admin').action(`${path}/status`, created.version, { status: 'refused', note: 'stale' }).expect(412);
      const verified = await as('admin').action(`${path}/verify-identity`, verifying.body.version, { method: 'known_contact_details' }).expect(200);
      expect(verified.body).toMatchObject({ identityVerified: true, identityMethod: 'known_contact_details', identityVerifiedBy: { id: members['admin'] }, nextStatuses: ['in_progress', 'refused', 'withdrawn'] });
      await as('admin').action(`${path}/verify-identity`, verified.body.version, { method: 'other' }).expect(422);

      const tooLong = await as('admin').action(`${path}/extend`, verified.body.version, { extendedDueOn: daysFrom(created.dueOn, 61), reason: 'Many records over several years' }).expect(422);
      expect(tooLong.body.errors[0].code).toBe('out-of-range');
      const extended = await as('admin').action(`${path}/extend`, verified.body.version, { extendedDueOn: daysFrom(created.dueOn, 60), reason: 'Many records over several years' }).expect(200);
      expect(extended.body).toMatchObject({ dueOn: daysFrom(created.dueOn, 60), originalDueOn: created.dueOn, extensionReason: 'Many records over several years' });
      expect((await as('admin').action(`${path}/extend`, extended.body.version, { extendedDueOn: daysFrom(created.dueOn, 50), reason: 'Once more, please' }).expect(422)).body.errors[0].code).toBe('already-extended');

      const working = await as('admin').action(`${path}/status`, extended.body.version, { status: 'in_progress' }).expect(200);
      expect((await as('admin').action(`${path}/status`, working.body.version, { status: 'refused' }).expect(422)).body.errors[0].field).toBe('note');
      await as('admin').post(`${path}/evidence`, { kind: 'response', summary: 'Sent the copy by recorded post', receivedOn: today() }).expect(201);
      const done = await as('admin').action(`${path}/status`, working.body.version, { status: 'completed' }).expect(200);
      expect(done.body).toMatchObject({ status: 'completed', closedBy: { id: members['admin'] }, daysLeft: null, nextStatuses: [] });
      expect((done.body.history as { eventType: string }[]).map((event) => event.eventType)).toEqual([
        'created', 'status_changed', 'identity_verified', 'due_extended', 'status_changed', 'evidence_added', 'status_changed',
      ]);
      await as('admin').action(`${path}/status`, done.body.version, { status: 'withdrawn', note: 'Changed mind' }).expect(422);
      await as('admin').action(`${path}/assign`, done.body.version, { assignedTo: null }).expect(422);
      // Evidence can still be recorded after closing (for example a later reply).
      await as('admin').post(`${path}/evidence`, { kind: 'correspondence', summary: 'Requester confirmed receipt', receivedOn: today() }).expect(201);
    });

    it('lists open requests soonest due first, with overdue, closed, assignee and contact views', async () => {
      const person = await contact();
      const overdue = await request(person.id, { requestType: 'access', receivedOn: daysFrom(today(), -40), assignedTo: members['owner'] });
      const fresh = await request(person.id, { requestType: 'access', receivedOn: today() });
      const open = await as('owner').get('/api/v1/privacy-requests?limit=100').expect(200);
      const ids = (open.body.data as { id: string }[]).map((row) => row.id);
      expect(ids.indexOf(overdue.id)).toBeLessThan(ids.indexOf(fresh.id));
      const late = await as('owner').get('/api/v1/privacy-requests?filter[view]=overdue&limit=100').expect(200);
      expect(late.body.data.find((row: { id: string }) => row.id === overdue.id)).toMatchObject({ overdue: true, daysLeft: -10 });
      expect(late.body.data.some((row: { id: string }) => row.id === fresh.id)).toBe(false);
      const mine = await as('owner').get('/api/v1/privacy-requests?filter[assignedTo]=me&limit=100').expect(200);
      expect((mine.body.data as { id: string }[]).map((row) => row.id)).toContain(overdue.id);
      expect((mine.body.data as { id: string }[]).map((row) => row.id)).not.toContain(fresh.id);
      const forContact = await as('owner').get(`/api/v1/privacy-requests?filter[view]=all&filter[contactId]=${person.id}`).expect(200);
      expect(forContact.body.data).toHaveLength(2);
      const page = await as('owner').get('/api/v1/privacy-requests?limit=1').expect(200);
      expect(page.body.page.nextCursor).not.toBeNull();
      const next = await as('owner').get(`/api/v1/privacy-requests?limit=1&cursor=${page.body.page.nextCursor}`).expect(200);
      expect(next.body.data[0].id).not.toBe(page.body.data[0].id);
      await as('owner').get('/api/v1/privacy-requests?filter[view]=everything').expect(422);
      const assignable = await as('owner').get('/api/v1/privacy-requests/assignable').expect(200);
      expect((assignable.body as { id: string }[]).map((m) => m.id).sort()).toEqual([members['owner'], members['admin']].sort());
    });
  });

  describe('fulfilment', () => {
    it('produces an access report with everything held, protected details included, for the owner only, audited', async () => {
      const person = await contact({ givenName: 'Abla', familyName: 'Reportee', dateOfBirth: '1984-04-04', primaryEmail: `abla-${counter}@example.test` });
      await as('owner').post('/api/v1/leads', { contactId: person.id, leadType: 'rent', sourceCode: 'phone', message: 'Looking for a 2-bed in Osu' }).expect(201);
      const created = await request(person.id, { requestType: 'access' });
      const working = await started(created.id, created.version);
      const path = `/api/v1/privacy-requests/${created.id}`;

      await as('admin').action(`${path}/access-report`, working.version).expect(403);
      expect((await as('ownerStale').action(`${path}/access-report`, working.version).expect(403)).body.type).toMatch(/mfa-required$/);
      const generated = await as('owner').action(`${path}/access-report`, working.version).expect(200);
      expect(generated.headers['cache-control']).toBe('no-store');
      expect(generated.body.accessReport).toMatchObject({ status: 'completed', canDownload: true });
      expect(generated.body.history.at(-1)).toMatchObject({ eventType: 'access_report_generated' });

      const exportId = generated.body.accessReport.exportId as string;
      const link = await as('owner').post(`/api/v1/exports/${exportId}/download`).expect(200);
      const file = await fetch(link.body.url);
      const report = (await file.json()) as Record<string, unknown> & { person: Record<string, unknown>; protectedDetails: Record<string, unknown>; leads: { message: string }[]; privacyRequests: unknown[] };
      expect(report).toMatchObject({ format: 'estatepro.subject-access-report', request: { reference: created.reference } });
      expect(report.person).toMatchObject({ givenName: 'Abla', familyName: 'Reportee' });
      expect(report.protectedDetails).toMatchObject({ dateOfBirth: '1984-04-04' });
      expect(report.leads[0]!.message).toBe('Looking for a 2-bed in Osu');
      expect(report.privacyRequests).toHaveLength(1);
      expect(JSON.stringify(report)).not.toMatch(/_encrypted|_hash|"numberHash"|wrapped/i);

      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'metadata']).where('entityId', '=', person.id).where('action', '=', 'privacy.access_report_generated').executeTakeFirstOrThrow();
      expect(audit.metadata).toMatchObject({ reference: created.reference, exportId, protectedFieldsIncluded: ['dateOfBirth'] });
      expect(JSON.stringify(audit.metadata)).not.toContain('1984-04-04');
      // Only the member who produced it can download it.
      await as('admin').post(`/api/v1/exports/${exportId}/download`).expect(403);

      const erasureRequest = await request(person.id);
      const erasureWorking = await started(erasureRequest.id, erasureRequest.version);
      await as('owner').action(`/api/v1/privacy-requests/${erasureRequest.id}/access-report`, erasureWorking.version).expect(422);
    });

    it('blocks merging while an erasure request is open, then erases the person and completes the request', async () => {
      const person = await contact({ givenName: 'Kwesi', primaryEmail: `kwesi-${counter}@example.test`, dateOfBirth: '1979-09-09' });
      const duplicate = await contact({ givenName: 'Kwesi dup', confirmNotDuplicate: true });
      const created = await request(person.id, { summary: 'Asked by email to delete everything' });
      const preview = await as('owner').get(`/api/v1/contacts/${duplicate.id}/merge-preview?mergeContactId=${person.id}`).expect(200);
      expect(preview.body.blockerDetails).toContainEqual(expect.objectContaining({ code: 'erasure_request', records: [created.reference] }));
      const merge = await as('owner').action(`/api/v1/contacts/${duplicate.id}/merge`, duplicate.version, { mergeContactId: person.id, mergeVersion: person.version, fields: {} });
      expect(merge.status).toBe(422);

      const path = `/api/v1/privacy-requests/${created.id}`;
      const notYet = await as('owner').action(`${path}/erase`, created.version, { confirm: 'ERASE' }).expect(422);
      expect(notYet.body.detail).toMatch(/Start work/);
      const working = await started(created.id, created.version);
      expect(working['canFulfil']).toBe(true);
      await as('owner').action(`${path}/status`, working.version, { status: 'completed' }).expect(422);
      await as('admin').action(`${path}/erase`, working.version, { confirm: 'ERASE' }).expect(403);
      await as('owner').action(`${path}/erase`, working.version, { confirm: 'erase' }).expect(422);
      expect((await as('ownerStale').action(`${path}/erase`, working.version, { confirm: 'ERASE' }).expect(403)).body.type).toMatch(/mfa-required$/);

      const erased = await as('owner').action(`${path}/erase`, working.version, { confirm: 'ERASE' }).expect(200);
      expect(erased.body).toMatchObject({ status: 'completed', erasureLedgerEntryId: expect.any(String), closedBy: { id: members['owner'] }, contact: { id: person.id, name: 'Erased contact' } });
      expect(erased.body.history.at(-1)).toMatchObject({ eventType: 'erasure_carried_out', fromStatus: 'in_progress', toStatus: 'completed' });
      // The register keeps its own evidence as the record of handling.
      expect(erased.body.evidence.map((item: { kind: string }) => item.kind)).toEqual(['request', 'identity']);
      const record = await as('owner').get(`/api/v1/contacts/${person.id}`).expect(200);
      expect(record.body).toMatchObject({ isAnonymised: true, primaryEmail: null });
      const entries = await ledger.entries();
      expect(entries.find((entry) => entry.id === erased.body.erasureLedgerEntryId)).toMatchObject({ type: 'contact_erasure', requestReference: created.reference, contactIds: [person.id] });
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'actorMembershipId']).where('entityId', '=', person.id).where('action', '=', 'contact.erased').executeTakeFirstOrThrow();
      expect(audit.actorMembershipId).toBe(members['owner']);
      // The merge is possible again for others; a new erasure request for the erased person is refused.
      expect((await as('owner').post('/api/v1/privacy-requests', { contactId: person.id, requestType: 'erasure', channel: 'email', receivedOn: today() }).expect(422)).body.errors[0].code).toBe('already-erased');
    });

    it('explains why a person cannot be erased and lets the request be refused with the reason', async () => {
      const person = await contact();
      await fx.db
        .insertInto('contactPaymentAccounts')
        .values({ companyId: company.companyId, contactId: person.id, accountType: 'bank', accountName: 'Payee', providerName: 'Test Bank', countryCode: 'GH', currencyCode: 'GHS', accountNumberEncrypted: Buffer.from('not-used'), last4: '9876' })
        .execute();
      const created = await request(person.id);
      const working = await started(created.id, created.version);
      expect(working).toMatchObject({ erasureBlockers: ['contact_payment_accounts'], canFulfil: false });
      const blocked = await as('owner').action(`/api/v1/privacy-requests/${created.id}/erase`, working.version, { confirm: 'ERASE' }).expect(422);
      expect(blocked.body.errors).toEqual([expect.objectContaining({ code: 'erasure-blocked:contact_payment_accounts' })]);
      const refused = await as('owner').action(`/api/v1/privacy-requests/${created.id}/status`, working.version, { status: 'refused', note: 'Payment records must be kept for 6 years' }).expect(200);
      expect(refused.body).toMatchObject({ status: 'refused', outcomeNote: 'Payment records must be kept for 6 years', erasureBlockers: [] });
    });
  });

  describe('dashboard, permissions and isolation', () => {
    it('counts open and overdue requests on the admin dashboard, linked to the register', async () => {
      const dashboard = await as('owner').get('/api/v1/dashboards/admin').expect(200);
      const open = await as('owner').get('/api/v1/privacy-requests?limit=100').expect(200);
      const overdue = (open.body.data as { overdue: boolean }[]).filter((row) => row.overdue).length;
      expect(dashboard.body.privacy).toMatchObject({ dataSubjectRequestsOpen: open.body.data.length, dataSubjectRequestsOverdue: overdue });
      expect(dashboard.body.needsAttention).toContainEqual(
        expect.objectContaining({ code: 'privacy_requests_overdue', count: overdue, link: '/api/v1/privacy-requests?filter[view]=overdue' }),
      );
    });

    it('is closed to members without the privacy permissions and to other companies', async () => {
      const person = await contact();
      const created = await request(person.id, { requestType: 'access' }, 'admin');
      for (const who of ['agent', 'sales']) {
        await as(who).get('/api/v1/privacy-requests').expect(403);
        await as(who).get(`/api/v1/privacy-requests/${created.id}`).expect(403);
        await as(who).post('/api/v1/privacy-requests', { contactId: person.id, requestType: 'access', channel: 'email', receivedOn: today() }).expect(403);
      }
      await as('otherOwner').get(`/api/v1/privacy-requests/${created.id}`).expect(404);
      const theirs = await as('otherOwner').get('/api/v1/privacy-requests?filter[view]=all').expect(200);
      expect(theirs.body.data).toEqual([]);
      const foreign = await as('otherOwner').post('/api/v1/privacy-requests', { contactId: person.id, requestType: 'access', channel: 'email', receivedOn: today() }).expect(422);
      expect(foreign.body.errors[0].code).toBe('not-found');
      // The admin manages but does not fulfil.
      const adminView = await as('admin').get(`/api/v1/privacy-requests/${created.id}`).expect(200);
      expect(adminView.body).toMatchObject({ canManage: true, canFulfil: false });
    });
  });
});
