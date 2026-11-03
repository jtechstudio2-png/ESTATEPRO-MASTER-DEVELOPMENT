import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemContext } from '../src/common/request-context.js';
import { SensitiveDataService } from '../src/crypto/sensitive-data.service.js';
import { TenantDb } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

/** Unique Ghanaian mobile numbers so test cases never collide on duplicate detection. */
let phoneCounter = 1000;
const nextPhone = () => `024${String(5000000 + phoneCounter++).padStart(7, '0')}`;
const e164 = (local: string) => `+233${local.replace(/^0/, '')}`;

describe('contacts API (Phase 5 milestone C1)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};

  const as = (who: string, companyId = company.companyId) => {
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
      delete: (path: string) => auth(t.http.delete(path)),
    };
  };

  const person = (overrides: Record<string, unknown> = {}) => ({
    contactType: 'person',
    displayName: `Person ${randomUUID().slice(0, 6)}`,
    primaryPhone: nextPhone(),
    ...overrides,
  });

  async function create(who: string, body: Record<string, unknown>) {
    const response = await as(who).post('/api/v1/contacts', body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as { id: string; version: number; reference: string; [key: string]: unknown };
  }

  async function auditFor(entityId: string, action: string) {
    return fx.db.selectFrom('auditLogs').selectAll().where('entityId', '=', entityId).where('action', '=', action).orderBy('occurredAt').execute();
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
      agentKsi: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      technician: { ...(await fx.member(company.companyId, { roleKey: 'maintenance_staff' })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [name, member] of Object.entries(people)) {
      members[name] = member.membershipId;
      await fx.linkIdentity(member.userId, `contacts-${name}-${member.companyId}`);
      tokens[name] = await t.idp.token({ sub: `contacts-${name}-${member.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  async function lead(contactId: string, assignedTo: string, status = 'new') {
    return fx.db
      .insertInto('leads')
      .values({ companyId: company.companyId, reference: `LEA-T-${randomUUID().slice(0, 8)}`, contactId, leadType: 'buy', sourceCode: 'website', assignedTo, status })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  // ------------------------------------------------------------ create & read
  describe('create and read', () => {
    it('creates a person with roles, consents and encrypted protected details, returning only masked metadata', async () => {
      const phone = nextPhone();
      const body = person({
        displayName: 'Ama Owusu',
        displayNameLocal: 'آما أوسو',
        primaryPhone: phone,
        primaryEmail: 'Ama.Owusu@Example.TEST',
        dateOfBirth: '1984-06-12',
        taxNumber: 'P0099887766',
        organisationRegNumber: 'BN-2020-1188',
        sourceCode: 'website',
        relationships: ['buyer', 'landlord'],
        consents: [
          { purpose: 'property_alerts', channel: 'whatsapp', status: 'granted', lawfulBasis: 'consent', capturedVia: 'verbal' },
          { purpose: 'marketing', channel: 'email', status: 'withdrawn', capturedVia: 'web_form' },
        ],
      });
      const created = await create('owner', body);
      expect(created).toMatchObject({
        contactType: 'person',
        displayName: 'Ama Owusu',
        primaryPhone: e164(phone),
        primaryEmail: 'ama.owusu@example.test',
        taxNumber: null,
        organisationRegNumber: null,
        office: { id: company.officeId },
        owner: { id: members['owner'] },
        protected: { dateOfBirth: { recorded: true }, taxNumber: { recorded: true, last4: '7766' }, organisationRegNumber: { recorded: true } },
        access: { canEdit: true, canArchive: true, canMerge: true, canReveal: true },
      });
      expect(created.reference).toMatch(/^CON-\d{4}-\d{6}$/);
      expect((created['relationships'] as { relationshipType: string }[]).map((r) => r.relationshipType).sort()).toEqual(['buyer', 'landlord']);
      expect((created['methods'] as { methodType: string; isPrimary: boolean }[]).filter((m) => m.isPrimary).map((m) => m.methodType).sort()).toEqual(['email', 'mobile']);
      expect((created['consents'] as { purpose: string; status: string }[]).map((c) => `${c.purpose}:${c.status}`).sort()).toEqual(['marketing:withdrawn', 'property_alerts:granted']);
      const json = JSON.stringify(created);
      for (const secret of ['1984-06-12', 'P0099887766', 'BN-2020-1188']) expect(json).not.toContain(secret);

      const row = await fx.db.selectFrom('contacts').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
      expect(row.taxNumber).toBeNull();
      expect(row.organisationRegNumber).toBeNull();
      expect(row.dateOfBirthEncrypted!.toString('latin1')).not.toContain('1984-06-12');
      expect(row.taxNumberHash).toHaveLength(32);

      const reveal = await as('owner').post(`/api/v1/contacts/${created.id}/sensitive/dateOfBirth/reveal`, { reason: 'Checking the record after creation' });
      expect(reveal.body.value).toBe('1984-06-12');

      const [audit] = await auditFor(created.id, 'contact.created');
      expect(audit?.metadata).toMatchObject({ reference: created.reference, protectedFields: ['dateOfBirth', 'taxNumber', 'organisationRegNumber'] });
      expect(JSON.stringify(audit)).not.toContain('1984-06-12');
      expect((await auditFor(created.id, 'contact.consent_recorded')).length).toBe(2);
    });

    it('keeps an organisation’s public tax and registration numbers in plain text', async () => {
      const created = await create('owner', {
        contactType: 'organisation',
        displayName: 'Osu Ventures',
        organisationName: 'Osu Ventures Ltd',
        taxNumber: 'C0001234567',
        organisationRegNumber: 'CS-123456789',
        primaryEmail: `accounts-${randomUUID().slice(0, 6)}@osu-ventures.test`,
      });
      expect(created).toMatchObject({ taxNumber: 'C0001234567', organisationRegNumber: 'CS-123456789' });
      expect(created['protected']).toBeUndefined();
    });

    it('completes national phone numbers with the office country and accepts international formats', async () => {
      const kumasi = await create('owner', person({ primaryPhone: '(024) 777-0101', officeId: kumasiOfficeId }));
      expect(kumasi['primaryPhone']).toBe('+233247770101');
      const qatar = await create('owner', person({ primaryPhone: '00974 5500 1234' }));
      expect(qatar['primaryPhone']).toBe('+97455001234');
    });

    it('validates fields and explains every error', async () => {
      const response = await as('owner').post('/api/v1/contacts', {
        contactType: 'person',
        displayName: 'Invalid',
        primaryEmail: 'not-an-email',
        dateOfBirth: '2999-01-01',
        nationalityCountryCode: 'ZZ',
        sourceCode: 'billboard',
        consents: [
          { purpose: 'marketing', channel: 'email', status: 'granted', capturedVia: 'verbal' },
          { purpose: 'marketing', channel: 'sms', status: 'withdrawn', lawfulBasis: 'consent', capturedVia: 'verbal' },
        ],
      });
      expect(response.status).toBe(422);
      const fields = (response.body.errors as { field: string }[]).map((error) => error.field).sort();
      expect(fields).toEqual(['consents[0].lawfulBasis', 'consents[1].lawfulBasis', 'dateOfBirth', 'nationalityCountryCode', 'primaryEmail', 'sourceCode']);
      const noMethod = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: 'Nobody' });
      expect(noMethod.status).toBe(422);
      expect(noMethod.body.errors[0].field).toBe('primaryPhone');
      const orgDob = await as('owner').post('/api/v1/contacts', { contactType: 'organisation', displayName: 'Org', organisationName: 'Org Ltd', primaryPhone: nextPhone(), dateOfBirth: '1990-01-01' });
      expect(orgDob.body.errors.map((e: { field: string }) => e.field)).toEqual(['dateOfBirth']);
      expect((await as('owner').post('/api/v1/contacts', person({ primaryPhone: '12' }))).status).toBe(422);
      expect((await as('owner').post('/api/v1/contacts', person({ isVip: true }))).status).toBe(422);
    });

    it('shows protected metadata only to members with kyc.view on the contact', async () => {
      const agentContact = await create('agent', person({ dateOfBirth: '1990-03-04' }));
      expect(agentContact['owner']).toMatchObject({ id: members['agent'] });
      expect(agentContact['protected']).toMatchObject({ dateOfBirth: { recorded: true } });
      expect(agentContact['access']).toMatchObject({ canEdit: true, canMerge: false, canReveal: false });

      const ownersContact = await create('owner', person({ dateOfBirth: '1971-01-01' }));
      await lead(ownersContact.id, members['agent']!);
      const viaLead = await as('agent').get(`/api/v1/contacts/${ownersContact.id}`);
      expect(viaLead.status).toBe(200);
      expect(viaLead.body.protected).toBeUndefined();
      expect(viaLead.body.access).toMatchObject({ canEdit: false, canReveal: false });

      for (const who of ['accountant', 'sales']) {
        const response = await as(who).get(`/api/v1/contacts/${ownersContact.id}`);
        expect(response.status, who).toBe(200);
        expect(response.body.protected, who).toMatchObject({ dateOfBirth: { recorded: true } });
      }
      expect((await as('salesKsi').get(`/api/v1/contacts/${ownersContact.id}`)).status).toBe(404);
      expect((await as('technician').get(`/api/v1/contacts/${ownersContact.id}`)).status).toBe(404);
      expect((await as('otherOwner', other.companyId).get(`/api/v1/contacts/${ownersContact.id}`)).status).toBe(404);
    });

    it('lets agents create contacts only for themselves and in their own offices', async () => {
      expect((await as('agent').post('/api/v1/contacts', person({ ownerMembershipId: members['agent2'] }))).status).toBe(403);
      expect((await as('agent').post('/api/v1/contacts', person({ officeId: kumasiOfficeId }))).status).toBe(403);
      expect((await as('technician').post('/api/v1/contacts', person())).status).toBe(403);
      const owned = await create('sales', person({ ownerMembershipId: members['agent'] }));
      expect(owned['owner']).toMatchObject({ id: members['agent'] });
    });
  });

  // -------------------------------------------------------------------- list
  describe('register and views', () => {
    let tag: string;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      tag = randomUUID().slice(0, 6);
      ids['ownBuyer'] = (await create('agent', person({ displayName: `List ${tag} Own buyer`, relationships: ['buyer'] }))).id;
      ids['leadContact'] = (await create('owner', person({ displayName: `List ${tag} Via lead`, relationships: ['seller'] }))).id;
      ids['taskContact'] = (await create('owner', person({ displayName: `List ${tag} Via task`, relationships: ['landlord'] }))).id;
      ids['hidden'] = (await create('owner', person({ displayName: `List ${tag} Hidden`, relationships: ['landlord'] }))).id;
      ids['kumasi'] = (await create('owner', person({ displayName: `List ${tag} Kumasi`, officeId: kumasiOfficeId, relationships: ['tenant'] }))).id;
      ids['arabic'] = (await create('owner', person({ displayName: `List ${tag} Arabic`, displayNameLocal: 'أحمد الكوارى', primaryPhone: '+97455012345' }))).id;
      await lead(ids['leadContact'], members['agent']!);
      await fx.db
        .insertInto('tasks')
        .values({ companyId: company.companyId, title: 'Call back', assignedTo: members['agent']!, entityType: 'contact', entityId: ids['taskContact'] })
        .execute();
    });

    const names = async (who: string, query = '') => {
      const response = await as(who).get(`/api/v1/contacts?q=${encodeURIComponent(`List ${tag}`)}&limit=100${query}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (response.body.data as { displayName: string }[]).map((row) => row.displayName.replace(`List ${tag} `, '')).sort();
    };

    it('limits agents to their own contacts plus those behind their leads and open tasks (D1)', async () => {
      expect(await names('agent')).toEqual(['Own buyer', 'Via lead', 'Via task']);
      expect(await names('agent2')).toEqual([]);
      expect(await names('salesKsi')).toEqual(['Kumasi']);
      expect(await names('owner')).toEqual(['Arabic', 'Hidden', 'Kumasi', 'Own buyer', 'Via lead', 'Via task']);
      expect(await names('technician')).toEqual([]);
    });

    it('offers Buyers, Sellers, Landlords and Tenants as views of the one register (D2)', async () => {
      expect(await names('owner', '&filter[relationship]=landlord')).toEqual(['Hidden', 'Via task']);
      expect(await names('owner', '&filter[relationship]=buyer,seller')).toEqual(['Own buyer', 'Via lead']);
      expect(await names('owner', '&filter[relationship]=tenant&filter[officeId]=' + kumasiOfficeId)).toEqual(['Kumasi']);
    });

    it('finds contacts by any spelling of an Arabic name, by phone in local format and by reference', async () => {
      const search = async (q: string) =>
        ((await as('owner').get(`/api/v1/contacts?q=${encodeURIComponent(q)}`).expect(200)).body.data as { id: string }[]).map((row) => row.id);
      expect(await search('احمد الكواري')).toContain(ids['arabic']);
      expect(await search('5501 2345')).toContain(ids['arabic']);
      const reference = (await as('owner').get(`/api/v1/contacts/${ids['hidden']}`)).body.reference as string;
      expect(await search(reference)).toEqual([ids['hidden']]);
    });

    it('masks phone numbers in the list and pages with a cursor', async () => {
      const first = await as('owner').get(`/api/v1/contacts?q=${encodeURIComponent(`List ${tag}`)}&limit=4&sort=displayName`).expect(200);
      expect(first.body.data).toHaveLength(4);
      expect(first.body.data[0].primaryPhoneMasked).toMatch(/^\+\d{5}•••\d{4}$/);
      expect(JSON.stringify(first.body)).not.toContain('primaryPhone"');
      const second = await as('owner')
        .get(`/api/v1/contacts?q=${encodeURIComponent(`List ${tag}`)}&limit=4&sort=displayName&cursor=${first.body.page.nextCursor}`)
        .expect(200);
      expect(second.body.data).toHaveLength(2);
      expect(second.body.page.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------- duplicates
  describe('duplicate detection (CRM-02)', () => {
    it('refuses a likely duplicate until the person confirms, and never merges automatically', async () => {
      const phone = nextPhone();
      const original = await create('owner', person({ displayName: 'Kwame Mensah', primaryPhone: phone }));
      const attempt = await as('owner').post('/api/v1/contacts', person({ displayName: 'Kwame M.', primaryPhone: `+233 ${phone.slice(1)}` }));
      expect(attempt.status).toBe(409);
      expect(attempt.body.type).toMatch(/possible-duplicates$/);
      expect(attempt.body.candidates).toEqual([
        expect.objectContaining({ visible: true, id: original.id, displayName: 'Kwame Mensah', matchedOn: ['phone'], archived: false }),
      ]);
      const confirmed = await create('owner', person({ displayName: 'Kwame M.', primaryPhone: phone, confirmNotDuplicate: true }));
      const [audit] = await auditFor(confirmed.id, 'contact.created');
      expect(audit?.metadata).toMatchObject({ confirmedNotDuplicate: true, confirmedNotDuplicateOf: [original.id] });
      const rows = await fx.db.selectFrom('contacts').select(['id', 'mergedIntoContactId']).where('id', 'in', [original.id, confirmed.id]).execute();
      expect(rows.map((row) => row.mergedIntoContactId)).toEqual([null, null]);
    });

    it('matches emails on any method, tax numbers by keyed hash in any format, and edits that create duplicates', async () => {
      const email = `dup-${randomUUID().slice(0, 6)}@example.test`;
      const holder = await create('owner', person({ taxNumber: 'GHA-723-118-905' }));
      await as('owner').post(`/api/v1/contacts/${holder.id}/methods`, { methodType: 'email', value: email.toUpperCase() }).expect(201);
      const byEmail = await as('owner').post('/api/v1/contacts', person({ primaryEmail: email }));
      expect(byEmail.status).toBe(409);
      expect(byEmail.body.candidates[0]).toMatchObject({ id: holder.id, matchedOn: ['email'] });
      const byTax = await as('owner').post('/api/v1/contacts', person({ taxNumber: 'gha 723118905' }));
      expect(byTax.body.candidates[0]).toMatchObject({ id: holder.id, matchedOn: ['tax_number'] });

      const editable = await create('owner', person());
      const holderPhone = (await as('owner').get(`/api/v1/contacts/${holder.id}`)).body.primaryPhone as string;
      const edit = await as('owner').patch(`/api/v1/contacts/${editable.id}`, { primaryPhone: holderPhone }, editable.version);
      expect(edit.status).toBe(409);
      expect((await as('owner').patch(`/api/v1/contacts/${editable.id}`, { primaryPhone: holderPhone, confirmNotDuplicate: true }, editable.version)).status).toBe(200);
    });

    it('reports matches outside the member’s access without any detail', async () => {
      const phone = nextPhone();
      await create('owner', person({ displayName: 'Private Person', primaryPhone: phone }));
      const response = await as('agentKsi').post('/api/v1/contacts/duplicate-check', { primaryPhone: phone }).expect(200);
      expect(response.body.candidates).toEqual([{ visible: false, id: null, reference: null, displayName: null, ownerName: null, archived: false, matchedOn: ['phone'] }]);
      expect(JSON.stringify(response.body)).not.toContain('Private Person');
    });

    it('ignores merged and anonymised contacts, audits checks without values, and rate-limits', async () => {
      const phone = nextPhone();
      const anonymised = await create('owner', person({ primaryPhone: phone }));
      await fx.db.updateTable('contacts').set({ isAnonymised: true }).where('id', '=', anonymised.id).execute();
      const keeper = await create('owner', person());
      const mergedAway = await create('owner', person({ primaryPhone: phone, confirmNotDuplicate: true }));
      await fx.db.updateTable('contacts').set({ mergedIntoContactId: keeper.id, archivedAt: new Date() }).where('id', '=', mergedAway.id).execute();
      const result = await as('owner').post('/api/v1/contacts/duplicate-check', { primaryPhone: phone }).expect(200);
      expect(result.body.candidates).toEqual([]);
      const audits = await fx.db
        .selectFrom('auditLogs')
        .select('metadata')
        .where('companyId', '=', company.companyId)
        .where('action', '=', 'contact.duplicate_check')
        .orderBy('occurredAt', 'desc')
        .limit(1)
        .execute();
      expect(audits[0]?.metadata).toMatchObject({ checked: ['phone'], candidates: 0 });
      expect(JSON.stringify(audits)).not.toContain(phone.slice(1));
      expect((await as('owner').post('/api/v1/contacts/duplicate-check', {})).status).toBe(422);

      const limited = await createTestApp({ DUPLICATE_CHECK_RATE_LIMIT_PER_MINUTE: '2' });
      try {
        const subject = `contacts-limit-${company.companyId}`;
        await fx.linkIdentity(company.ownerUserId, subject, limited.idp.provider);
        const token = await limited.idp.token({ sub: subject, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
        const check = () => limited.http.post('/api/v1/contacts/duplicate-check').auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId).send({ primaryPhone: phone });
        expect((await check()).status).toBe(200);
        expect((await check()).status).toBe(200);
        const third = await check();
        expect(third.status).toBe(429);
        expect(third.headers['retry-after']).toBeDefined();
      } finally {
        await limited.close();
      }
    });
  });

  // -------------------------------------------------------------------- edit
  describe('editing', () => {
    it('updates with optimistic concurrency and audits changes without protected values', async () => {
      const created = await create('owner', person({ dateOfBirth: '1980-01-01', taxNumber: 'P111222333' }));
      expect((await as('owner').patch(`/api/v1/contacts/${created.id}`, { title: 'Dr' })).status).toBe(428);
      const updated = await as('owner').patch(`/api/v1/contacts/${created.id}`, { title: 'Dr', dateOfBirth: '1981-02-02', taxNumber: null, notes: 'Prefers mornings' }, created.version);
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ title: 'Dr', notes: 'Prefers mornings', protected: { dateOfBirth: { recorded: true }, taxNumber: { recorded: false, last4: null } } });
      expect(updated.headers['etag']).toBe(`"${updated.body.version}"`);
      expect((await as('owner').patch(`/api/v1/contacts/${created.id}`, { title: 'Prof' }, created.version)).status).toBe(412);

      const reveal = await as('owner').post(`/api/v1/contacts/${created.id}/sensitive/dateOfBirth/reveal`, { reason: 'Verify the corrected date' });
      expect(reveal.body.value).toBe('1981-02-02');
      const [audit] = await auditFor(created.id, 'contact.updated');
      expect(audit?.changes).toMatchObject({ title: { old: null, new: 'Dr' }, dateOfBirth: { old: '[protected]', new: '[protected]' }, taxNumber: { old: '[protected]', new: null } });
      const text = JSON.stringify(audit);
      for (const value of ['1980-01-01', '1981-02-02', 'P111222333', 'Encrypted']) expect(text).not.toContain(value);
      expect((await as('owner').patch(`/api/v1/contacts/${created.id}`, { contactType: 'organisation' }, updated.body.version)).status).toBe(422);
    });

    it('keeps the list of contact methods in step when the primary phone changes', async () => {
      const created = await create('owner', person());
      const phone = nextPhone();
      const updated = await as('owner').patch(`/api/v1/contacts/${created.id}`, { primaryPhone: phone }, created.version).expect(200);
      const mobiles = (updated.body.methods as { methodType: string; value: string; isPrimary: boolean }[]).filter((m) => m.methodType === 'mobile');
      expect(mobiles.filter((m) => m.isPrimary).map((m) => m.value)).toEqual([e164(phone)]);
      expect(mobiles).toHaveLength(2);
    });

    it('lets agents edit only contacts they own, not those seen through a lead', async () => {
      const ownersContact = await create('owner', person());
      await lead(ownersContact.id, members['agent']!);
      expect((await as('agent').patch(`/api/v1/contacts/${ownersContact.id}`, { title: 'Ms' }, ownersContact.version)).status).toBe(403);
      const own = await create('agent', person());
      expect((await as('agent').patch(`/api/v1/contacts/${own.id}`, { ownerMembershipId: members['agent2'] }, own.version)).status).toBe(403);
      expect((await as('agent2').patch(`/api/v1/contacts/${own.id}`, { title: 'Ms' }, own.version)).status).toBe(404);
    });
  });

  // ------------------------------------------- methods, roles and consent
  describe('contact methods, roles and consent', () => {
    it('adds, de-duplicates, promotes, opts out and removes contact methods', async () => {
      const created = await create('owner', person({ primaryEmail: `first-${randomUUID().slice(0, 6)}@example.test` }));
      const second = `second-${randomUUID().slice(0, 6)}@example.test`;
      const added = await as('owner').post(`/api/v1/contacts/${created.id}/methods`, { methodType: 'email', value: second, label: 'Work' }).expect(201);
      expect(added.body.version).toBeGreaterThan(created.version);
      expect((await as('owner').post(`/api/v1/contacts/${created.id}/methods`, { methodType: 'email', value: second.toUpperCase() })).status).toBe(409);
      expect((await as('owner').post(`/api/v1/contacts/${created.id}/methods`, { methodType: 'whatsapp', value: 'not a number' })).status).toBe(422);
      const secondMethod = (added.body.methods as { id: string; value: string }[]).find((m) => m.value === second)!;
      const promoted = await as('owner').patch(`/api/v1/contacts/${created.id}/methods/${secondMethod.id}`, { isPrimary: true, optedOut: true, verified: true }).expect(200);
      expect(promoted.body.primaryEmail).toBe(second);
      const method = (promoted.body.methods as { id: string; optedOutAt: string | null; verifiedAt: string | null; isPrimary: boolean }[]).find((m) => m.id === secondMethod.id)!;
      expect(method).toMatchObject({ isPrimary: true });
      expect(method.optedOutAt).not.toBeNull();
      expect(method.verifiedAt).not.toBeNull();
      const mobile = (promoted.body.methods as { id: string; methodType: string }[]).find((m) => m.methodType === 'mobile')!;
      expect((await as('owner').delete(`/api/v1/contacts/${created.id}/methods/${mobile.id}`)).status).toBe(200);
      const after = await as('owner').delete(`/api/v1/contacts/${created.id}/methods/${secondMethod.id}`);
      expect(after.status).toBe(422);
      expect((await auditFor(created.id, 'contact.method_added')).length).toBe(1);
    });

    it('adds and ends roles, keeping their history', async () => {
      const created = await create('owner', person({ relationships: ['buyer'] }));
      expect((await as('owner').post(`/api/v1/contacts/${created.id}/relationships`, { relationshipType: 'buyer' })).status).toBe(409);
      const withTenant = await as('owner').post(`/api/v1/contacts/${created.id}/relationships`, { relationshipType: 'tenant' }).expect(201);
      const buyer = (withTenant.body.relationships as { id: string; relationshipType: string }[]).find((r) => r.relationshipType === 'buyer')!;
      expect((await as('owner').post(`/api/v1/contacts/${created.id}/relationships/${buyer.id}/end`, { endedOn: '2000-01-01' })).status).toBe(422);
      const ended = await as('owner').post(`/api/v1/contacts/${created.id}/relationships/${buyer.id}/end`, {}).expect(200);
      expect((ended.body.relationships as { relationshipType: string; status: string }[]).map((r) => `${r.relationshipType}:${r.status}`).sort()).toEqual([
        'buyer:inactive',
        'tenant:active',
      ]);
      expect((await as('owner').post(`/api/v1/contacts/${created.id}/relationships/${buyer.id}/end`, {})).status).toBe(422);
      const again = await as('owner').post(`/api/v1/contacts/${created.id}/relationships`, { relationshipType: 'buyer' });
      expect(again.status).toBe(201);
    });

    it('records consent as append-only history, with the latest record in force', async () => {
      const created = await create('owner', person());
      const path = `/api/v1/contacts/${created.id}/consents`;
      await as('owner').post(path, { purpose: 'marketing', channel: 'sms', status: 'granted', lawfulBasis: 'consent', capturedVia: 'paper', evidence: 'Form 2026/031' }).expect(201);
      const history = await as('owner').post(path, { purpose: 'marketing', channel: 'sms', status: 'withdrawn', capturedVia: 'verbal' }).expect(201);
      expect((history.body.data as { status: string }[]).map((c) => c.status)).toEqual(['withdrawn', 'granted']);
      const record = await as('owner').get(`/api/v1/contacts/${created.id}`).expect(200);
      expect(record.body.consents).toEqual([expect.objectContaining({ purpose: 'marketing', channel: 'sms', status: 'withdrawn' })]);
      expect((await as('owner').post(path, { purpose: 'marketing', channel: 'sms', status: 'granted', capturedVia: 'verbal' })).status).toBe(422);
      const future = new Date(Date.now() + 86_400_000).toISOString();
      expect((await as('owner').post(path, { purpose: 'marketing', channel: 'sms', status: 'withdrawn', capturedVia: 'verbal', capturedAt: future })).status).toBe(422);
      expect((await as('agent2').get(path)).status).toBe(404);
    });
  });

  // ----------------------------------------------------------------- archive
  describe('archive and restore', () => {
    it('archives with a reason, blocks while leads are open, hides from the register and restores', async () => {
      const created = await create('owner', person({ displayName: `Archive ${randomUUID().slice(0, 6)}` }));
      const open = await lead(created.id, members['agent']!);
      expect((await as('owner').action(`/api/v1/contacts/${created.id}/archive`, created.version, {})).status).toBe(422);
      const blocked = await as('owner').action(`/api/v1/contacts/${created.id}/archive`, created.version, { reason: 'Moved abroad' });
      expect(blocked.status).toBe(422);
      expect(blocked.body.detail).toMatch(/open lead/);
      await fx.db.updateTable('leads').set({ status: 'lost', lostReasonCode: 'no_response' }).where('id', '=', open.id).execute();

      const archived = await as('owner').action(`/api/v1/contacts/${created.id}/archive`, created.version, { reason: 'Moved abroad' }).expect(200);
      expect(archived.body).toMatchObject({ archivedReason: 'Moved abroad', access: { canEdit: false } });
      expect((await as('owner').patch(`/api/v1/contacts/${created.id}`, { title: 'Mr' }, archived.body.version)).status).toBe(422);
      const listed = await as('owner').get(`/api/v1/contacts?q=${encodeURIComponent(created['displayName'] as string)}`).expect(200);
      expect(listed.body.data).toEqual([]);
      const archivedList = await as('owner').get(`/api/v1/contacts?q=${encodeURIComponent(created['displayName'] as string)}&filter[archived]=true`).expect(200);
      expect(archivedList.body.data).toHaveLength(1);
      expect((await as('agent').action(`/api/v1/contacts/${created.id}/restore`, archived.body.version)).status).toBe(403);
      const restored = await as('owner').action(`/api/v1/contacts/${created.id}/restore`, archived.body.version).expect(200);
      expect(restored.body).toMatchObject({ archivedAt: null, archivedReason: null });
      expect((await auditFor(created.id, 'contact.archived'))[0]?.metadata).toMatchObject({ reason: 'Moved abroad' });
      expect((await auditFor(created.id, 'contact.restored')).length).toBe(1);
    });
  });

  // ------------------------------------------------------------------- merge
  describe('merge (wireframe C-4)', () => {
    async function seal(contactId: string, document: { number: string }) {
      const tenantDb = t.app.get(TenantDb);
      const sensitive = t.app.get(SensitiveDataService);
      const id = randomUUID();
      const ctx = systemContext(company.companyId, 'test-merge');
      await tenantDb.run(ctx, async (tx) => {
        const value = await sensitive.protectIdentifier(tx, ctx, { table: 'identity_documents', column: 'number_encrypted', rowId: id }, 'identity_number', document.number);
        await tx
          .insertInto('identityDocuments')
          .values({ id, companyId: company.companyId, contactId, documentTypeCode: 'passport', issuingCountryCode: 'GH', numberEncrypted: value.encrypted, numberHash: value.hash, numberLast4: value.last4 })
          .execute();
      });
      return id;
    }

    it('previews references and blockers, then moves everything to the kept contact with the chosen values', async () => {
      const keep = await create('owner', person({ displayName: 'Efua Asante', relationships: ['buyer'], dateOfBirth: '1990-09-09' }));
      const mergeEmail = `efua-${randomUUID().slice(0, 6)}@example.test`;
      const merge = await create('owner', person({
        displayName: 'Efua A.',
        primaryEmail: mergeEmail,
        relationships: ['buyer', 'landlord'],
        dateOfBirth: '1990-09-19',
        taxNumber: 'P555666777',
        consents: [
          { purpose: 'marketing', channel: 'email', status: 'withdrawn', capturedVia: 'web_form', capturedAt: new Date(Date.now() - 86_400_000).toISOString() },
        ],
      }));
      await as('owner').post(`/api/v1/contacts/${keep.id}/consents`, { purpose: 'marketing', channel: 'email', status: 'granted', lawfulBasis: 'consent', capturedVia: 'web_form' }).expect(201);
      const mergeLead = await lead(merge.id, members['agent']!);
      await fx.db.insertInto('requirements').values({ companyId: company.companyId, contactId: merge.id, requirementType: 'buy', currencyCode: 'GHS' }).execute();
      await fx.db.insertInto('tasks').values({ companyId: company.companyId, title: 'Follow up', assignedTo: members['agent']!, entityType: 'contact', entityId: merge.id }).execute();
      const activity = await fx.db.insertInto('activities').values({ companyId: company.companyId, activityType: 'note', subject: 'Met' }).returning('id').executeTakeFirstOrThrow();
      await fx.db.insertInto('activityLinks').values({ companyId: company.companyId, activityId: activity.id, entityType: 'contact', entityId: merge.id }).execute();
      const documentId = await seal(merge.id, { number: 'G7788990' });

      const keepNow = (await as('owner').get(`/api/v1/contacts/${keep.id}`)).body;
      const mergeNow = (await as('owner').get(`/api/v1/contacts/${merge.id}`)).body;
      const preview = await as('owner').get(`/api/v1/contacts/${keep.id}/merge-preview?mergeContactId=${merge.id}`).expect(200);
      expect(preview.body.blockers).toEqual([]);
      expect(preview.body.merge.references).toMatchObject({
        'leads.contact_id': 1,
        'requirements.contact_id': 1,
        'identity_documents.contact_id': 1,
        'tasks.entity_id': 1,
        'activity_links.entity_id': 2, // the note, and the consent entry on its timeline (C3)
        'contact_relationships.contact_id': 2,
      });
      expect(JSON.stringify(preview.body)).not.toContain('P555666777');

      const merged = await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keepNow.version, {
        mergeContactId: merge.id,
        mergeVersion: mergeNow.version,
        fields: { primaryEmail: 'merge', dateOfBirth: 'merge', taxNumber: 'merge' },
      });
      expect(merged.status, JSON.stringify(merged.body)).toBe(200);
      expect(merged.body.contact).toMatchObject({ id: keep.id, displayName: 'Efua Asante', primaryEmail: mergeEmail, protected: { taxNumber: { recorded: true, last4: '6777' } } });
      expect(merged.body.moved).toMatchObject({ 'leads.contact_id': 1, 'requirements.contact_id': 1, 'identity_documents.contact_id': 1, 'tasks.entity_id': 1 });
      expect((merged.body.contact.relationships as { relationshipType: string; status: string }[]).filter((r) => r.status === 'active').map((r) => r.relationshipType).sort()).toEqual(['buyer', 'landlord']);

      // Protected values were re-encrypted for the kept row and reveal correctly there.
      expect((await as('owner').post(`/api/v1/contacts/${keep.id}/sensitive/dateOfBirth/reveal`, { reason: 'Check merged date of birth' })).body.value).toBe('1990-09-19');
      expect((await as('owner').post(`/api/v1/contacts/${keep.id}/sensitive/taxNumber/reveal`, { reason: 'Check merged tax number' })).body.value).toBe('P555666777');
      expect((await as('owner').post(`/api/v1/contacts/${keep.id}/identity-documents/${documentId}/reveal`, { reason: 'Check moved document' })).body.value).toBe('G7788990');

      // A withdrawal on the merged contact stays in force over a later grant on the kept one.
      expect(merged.body.contact.consents).toEqual([expect.objectContaining({ purpose: 'marketing', channel: 'email', status: 'withdrawn' })]);

      expect((await fx.db.selectFrom('leads').select('contactId').where('id', '=', mergeLead.id).executeTakeFirstOrThrow()).contactId).toBe(keep.id);
      const mergedRecord = await as('owner').get(`/api/v1/contacts/${merge.id}`).expect(200);
      expect(mergedRecord.body).toMatchObject({ mergedIntoContactId: keep.id, access: { canEdit: false, canMerge: false } });
      expect(mergedRecord.body.archivedReason).toMatch(/^Merged into CON-/);
      expect((await as('owner').patch(`/api/v1/contacts/${merge.id}`, { title: 'Ms' }, mergedRecord.body.version)).status).toBe(422);
      expect((await as('owner').get(`/api/v1/contacts?q=${encodeURIComponent('Efua A.')}&filter[archived]=all`)).body.data.map((r: { id: string }) => r.id)).not.toContain(merge.id);

      const [audit] = await auditFor(keep.id, 'contact.merged');
      expect(audit?.metadata).toMatchObject({ mergedContactId: merge.id, fieldsFromMergedContact: ['primaryEmail', 'dateOfBirth', 'taxNumber'], withdrawalsKept: ['marketing/email'] });
      expect(JSON.stringify(audit)).not.toContain('P555666777');
      expect((await auditFor(merge.id, 'contact.merged_into')).length).toBe(1);
    });

    it('refuses merges that would re-attribute financial records, mix types, repeat or use stale versions', async () => {
      const keep = await create('owner', person());
      const withAccount = await create('owner', person());
      await fx.db
        .insertInto('contactPaymentAccounts')
        .values({ companyId: company.companyId, contactId: withAccount.id, accountType: 'bank', accountName: 'Test', providerName: 'GCB', countryCode: 'GH', currencyCode: 'GHS', accountNumberEncrypted: Buffer.from([1]), last4: '1234' })
        .execute();
      const blocked = await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: withAccount.id, mergeVersion: withAccount.version });
      expect(blocked.status).toBe(422);
      expect(blocked.body.detail).toMatch(/payout accounts/);
      const preview = await as('owner').get(`/api/v1/contacts/${keep.id}/merge-preview?mergeContactId=${withAccount.id}`).expect(200);
      expect(preview.body.blockers.join(' ')).toMatch(/payout accounts/);

      const organisation = await create('owner', { contactType: 'organisation', displayName: 'Org', organisationName: 'Org Ltd', primaryPhone: nextPhone() });
      expect((await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: organisation.id, mergeVersion: organisation.version })).body.detail).toMatch(/person and an organisation/);
      expect((await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: keep.id, mergeVersion: keep.version })).status).toBe(422);

      const second = await create('owner', person());
      expect((await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: second.id, mergeVersion: second.version + 5 })).status).toBe(412);
      expect((await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: second.id, mergeVersion: second.version, fields: { favouriteColour: 'merge' } })).status).toBe(422);
      expect((await as('agent').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: second.id, mergeVersion: second.version })).status).toBe(403);
      await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: second.id, mergeVersion: second.version }).expect(200);
      const keepAfter = (await as('owner').get(`/api/v1/contacts/${keep.id}`)).body;
      const again = await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keepAfter.version, { mergeContactId: second.id, mergeVersion: second.version + 1 });
      expect(again.status).toBe(422);
      expect(again.body.detail).toMatch(/already merged/);

      const foreign = (await as('otherOwner', other.companyId).post('/api/v1/contacts', person()).expect(201)).body;
      expect((await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keepAfter.version, { mergeContactId: foreign.id, mergeVersion: foreign.version })).status).toBe(404);
    });

    it('lets a sales manager merge within the office only', async () => {
      const keep = await create('sales', person());
      const kumasi = await create('owner', person({ officeId: kumasiOfficeId }));
      expect((await as('sales').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: kumasi.id, mergeVersion: kumasi.version })).status).toBe(404);
      const sameOffice = await create('sales', person());
      const result = await as('sales').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: sameOffice.id, mergeVersion: sameOffice.version });
      expect(result.status).toBe(200);
      const rows = await sql<{ n: number }>`select count(*)::int as n from contacts where merged_into_contact_id = ${keep.id}`.execute(fx.db);
      expect(rows.rows[0]?.n).toBe(1);
    });
  });

  // ------------------------------------------------------- edge cases & errors
  describe('edge cases and error paths', () => {
    const missing = '01a1b2c3-0000-7000-8000-000000000000';

    it('answers 404 for unknown contacts, methods and roles on every endpoint', async () => {
      expect((await as('owner').get(`/api/v1/contacts/${missing}`)).status).toBe(404);
      expect((await as('owner').get('/api/v1/contacts/not-a-uuid')).status).toBe(404);
      expect((await as('owner').patch(`/api/v1/contacts/${missing}`, { title: 'X' }, 1)).status).toBe(404);
      expect((await as('owner').action(`/api/v1/contacts/${missing}/archive`, 1, { reason: 'Gone away' })).status).toBe(404);
      expect((await as('owner').action(`/api/v1/contacts/${missing}/restore`, 1)).status).toBe(404);
      expect((await as('owner').post(`/api/v1/contacts/${missing}/methods`, { methodType: 'email', value: 'a@b.co' })).status).toBe(404);
      expect((await as('owner').get(`/api/v1/contacts/${missing}/consents`)).status).toBe(404);
      expect((await as('owner').get(`/api/v1/contacts/${missing}/merge-preview?mergeContactId=${missing}`)).status).toBe(404);
      const created = await create('owner', person());
      expect((await as('owner').patch(`/api/v1/contacts/${created.id}/methods/${missing}`, { label: 'x' })).status).toBe(404);
      expect((await as('owner').delete(`/api/v1/contacts/${created.id}/methods/${missing}`)).status).toBe(404);
      expect((await as('owner').post(`/api/v1/contacts/${created.id}/relationships/${missing}/end`, {})).status).toBe(404);
      expect((await as('owner').action(`/api/v1/contacts/${created.id}/restore`, created.version)).status).toBe(422);
      expect((await as('owner').action(`/api/v1/contacts/${created.id}/archive`, created.version + 3, { reason: 'Stale' })).status).toBe(412);
    });

    it('validates edits: required names, contact details, offices, owners and reference data', async () => {
      const created = await create('owner', person({ primaryEmail: `edit-${randomUUID().slice(0, 6)}@example.test` }));
      const patch = (body: object) => as('owner').patch(`/api/v1/contacts/${created.id}`, body, created.version);
      expect((await patch({ displayName: null })).status).toBe(422);
      expect((await patch({ primaryEmail: 'broken' })).body.errors[0].field).toBe('primaryEmail');
      expect((await patch({ primaryEmail: null, primaryPhone: null })).body.errors[0].field).toBe('primaryPhone');
      expect((await patch({ officeId: missing })).body.errors[0].field).toBe('officeId');
      expect((await patch({ ownerMembershipId: missing })).body.errors[0].field).toBe('ownerMembershipId');
      expect((await patch({ preferredLocaleCode: 'xx-XX' })).body.errors[0].field).toBe('preferredLocaleCode');
      expect((await patch({ residenceCountryCode: 'ZZ' })).body.errors[0].field).toBe('residenceCountryCode');
      const unchanged = await patch({ title: null });
      expect(unchanged.status).toBe(200);
      expect(unchanged.body.version).toBe(created.version);
      const valid = await patch({ primaryEmail: null, preferredLocaleCode: 'en', residenceCountryCode: 'QA', ownerMembershipId: null, dateOfBirth: null, organisationRegNumber: 'SOLE-1' });
      expect(valid.status, JSON.stringify(valid.body)).toBe(200);
      expect(valid.body).toMatchObject({ primaryEmail: null, preferredLocaleCode: 'en', residenceCountryCode: 'QA', owner: null, protected: { organisationRegNumber: { recorded: true } } });
      const cleared = await as('owner').patch(`/api/v1/contacts/${created.id}`, { organisationRegNumber: null }, valid.body.version).expect(200);
      expect(cleared.body.protected.organisationRegNumber.recorded).toBe(false);
    });

    it('lets company-wide roles keep contacts without an office, using the company country for phone numbers', async () => {
      const admin = await as('admin').post('/api/v1/contacts', person({ primaryPhone: '020 111 2222', officeId: null, sourceCode: 'website' }));
      expect(admin.status, JSON.stringify(admin.body)).toBe(201);
      expect(admin.body).toMatchObject({ office: null, primaryPhone: '+233201112222' });
      const check = await as('admin').post('/api/v1/contacts/duplicate-check', { primaryPhone: '020 111 2222' }).expect(200);
      expect(check.body.candidates.map((c: { id: string }) => c.id)).toContain(admin.body.id);
      expect((await as('sales').post('/api/v1/contacts', person({ officeId: null }))).status).toBe(422);
    });

    it('edits organisations’ public numbers and protects their names', async () => {
      const org = await create('owner', { contactType: 'organisation', displayName: 'Labone Holdings', organisationName: 'Labone Holdings Ltd', primaryPhone: nextPhone() });
      const updated = await as('owner').patch(`/api/v1/contacts/${org.id}`, { taxNumber: 'C0009998887', organisationRegNumber: 'CS-0001' }, org.version).expect(200);
      expect(updated.body).toMatchObject({ taxNumber: 'C0009998887', organisationRegNumber: 'CS-0001' });
      expect((await as('owner').patch(`/api/v1/contacts/${org.id}`, { organisationName: null }, updated.body.version)).status).toBe(422);
      expect((await as('owner').patch(`/api/v1/contacts/${org.id}`, { dateOfBirth: '1990-01-01' }, updated.body.version)).status).toBe(422);
      expect((await as('owner').post('/api/v1/contacts', { contactType: 'organisation', displayName: 'No name', primaryPhone: nextPhone() })).body.errors[0].field).toBe('organisationName');
    });

    it('keeps one primary per kind of method, stores websites as typed, and blocks archived or anonymised contacts', async () => {
      const created = await create('owner', person());
      const site = await as('owner').post(`/api/v1/contacts/${created.id}/methods`, { methodType: 'website', value: 'https://Example.com/Agent' }).expect(201);
      expect((site.body.methods as { value: string }[]).map((m) => m.value)).toContain('https://Example.com/Agent');
      const wa = await as('owner').post(`/api/v1/contacts/${created.id}/methods`, { methodType: 'whatsapp', value: nextPhone(), isPrimary: true }).expect(201);
      const whatsapp = (wa.body.methods as { methodType: string; isPrimary: boolean; id: string }[]).filter((m) => m.methodType === 'whatsapp');
      expect(whatsapp.map((m) => m.isPrimary)).toEqual([true]);
      expect((await as('owner').patch(`/api/v1/contacts/${created.id}/methods/${whatsapp[0]!.id}`, { isPrimary: false })).status).toBe(422);
      const mobile = (wa.body.methods as { methodType: string; id: string }[]).find((m) => m.methodType === 'mobile')!;
      const landline = await as('owner').post(`/api/v1/contacts/${created.id}/methods`, { methodType: 'phone', value: nextPhone(), isPrimary: true }).expect(201);
      expect(landline.body.primaryPhone).not.toBe(created['primaryPhone']);
      expect((landline.body.methods as { id: string; isPrimary: boolean }[]).find((m) => m.id === mobile.id)!.isPrimary).toBe(false);
      await as('owner').patch(`/api/v1/contacts/${created.id}/methods/${whatsapp[0]!.id}`, { optedOut: false, verified: false, label: 'Personal' }).expect(200);
      expect((await as('owner').delete(`/api/v1/contacts/${created.id}/methods/${whatsapp[0]!.id}`)).status).toBe(200);

      await fx.db.updateTable('contacts').set({ isAnonymised: true }).where('id', '=', created.id).execute();
      const now = (await as('owner').get(`/api/v1/contacts/${created.id}`)).body;
      expect((await as('owner').patch(`/api/v1/contacts/${created.id}`, { title: 'Mr' }, now.version)).status).toBe(422);
      expect((await as('owner').post(`/api/v1/contacts/${created.id}/consents`, { purpose: 'marketing', channel: 'sms', status: 'withdrawn', capturedVia: 'verbal' })).status).toBe(422);

      const archived = await create('owner', person());
      const done = await as('owner').action(`/api/v1/contacts/${archived.id}/archive`, archived.version, { reason: 'Duplicate record' }).expect(200);
      expect((await as('owner').action(`/api/v1/contacts/${archived.id}/archive`, done.body.version, { reason: 'Again' })).status).toBe(422);
      expect((await as('owner').post(`/api/v1/contacts/${archived.id}/methods`, { methodType: 'email', value: 'x@y.co' })).status).toBe(422);
      const consent = await as('owner').post(`/api/v1/contacts/${archived.id}/consents`, {
        purpose: 'marketing', channel: 'email', status: 'withdrawn', capturedVia: 'email', capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
      });
      expect(consent.status).toBe(201);
    });

    it('refuses to archive a contact with portal access', async () => {
      const created = await create('owner', person());
      const user = await fx.db.insertInto('users').values({ email: `portal-${randomUUID().slice(0, 6)}@example.test`, displayName: 'Portal' }).returning('id').executeTakeFirstOrThrow();
      const role = await fx.db.selectFrom('roles').select('id').where('key', '=', 'landlord').where('companyId', 'is', null).executeTakeFirstOrThrow();
      await fx.db.insertInto('companyMemberships').values({ companyId: company.companyId, userId: user.id, roleId: role.id, membershipType: 'portal', contactId: created.id, status: 'active' }).execute();
      const response = await as('owner').action(`/api/v1/contacts/${created.id}/archive`, created.version, { reason: 'Left the company' });
      expect(response.status).toBe(422);
      expect(response.body.detail).toMatch(/portal access/);

      const other = await create('owner', person());
      const user2 = await fx.db.insertInto('users').values({ email: `portal-${randomUUID().slice(0, 6)}@example.test`, displayName: 'Portal 2' }).returning('id').executeTakeFirstOrThrow();
      await fx.db.insertInto('companyMemberships').values({ companyId: company.companyId, userId: user2.id, roleId: role.id, membershipType: 'portal', contactId: other.id, status: 'active' }).execute();
      const preview = await as('owner').get(`/api/v1/contacts/${created.id}/merge-preview?mergeContactId=${other.id}`).expect(200);
      expect(preview.body.blockers.join(' ')).toMatch(/Both contacts have portal access/);
    });

    it('reports every merge blocker in the preview and keeps at least one way to reach the person', async () => {
      const keep = await create('owner', person({ primaryEmail: null }));
      const archivedKeep = await create('owner', person());
      const done = await as('owner').action(`/api/v1/contacts/${archivedKeep.id}/archive`, archivedKeep.version, { reason: 'Archived for test' }).expect(200);
      const anonymous = await create('owner', person());
      await fx.db.updateTable('contacts').set({ isAnonymised: true }).where('id', '=', anonymous.id).execute();
      const preview = await as('owner').get(`/api/v1/contacts/${archivedKeep.id}/merge-preview?mergeContactId=${anonymous.id}`).expect(200);
      expect(preview.body.blockers.join(' ')).toMatch(/Anonymised/);
      expect(preview.body.blockers.join(' ')).toMatch(/archived/);
      void done;

      const emailOnly = await create('owner', { contactType: 'person', displayName: 'Email only', primaryEmail: `only-${randomUUID().slice(0, 6)}@example.test` });
      const result = await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, {
        mergeContactId: emailOnly.id,
        mergeVersion: emailOnly.version,
        fields: { primaryPhone: 'merge', primaryEmail: 'merge' },
      });
      expect(result.status).toBe(200);
      expect(result.body.contact).toMatchObject({ primaryPhone: null, primaryEmail: emailOnly['primaryEmail'] });
      const phoneless = await create('owner', { contactType: 'person', displayName: 'Phone only', primaryPhone: nextPhone() });
      const both = await as('owner').get(`/api/v1/contacts/${keep.id}`);
      const refused = await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, both.body.version, {
        mergeContactId: phoneless.id,
        mergeVersion: phoneless.version,
        fields: { primaryEmail: 'merge' },
      });
      expect(refused.status).toBe(422);
      expect(refused.body.detail).toMatch(/neither a mobile number nor an email/);
    });

    it('merges organisations, taking their public numbers and names as chosen', async () => {
      const keep = await create('owner', { contactType: 'organisation', displayName: 'Ridge Estates', organisationName: 'Ridge Estates Ltd', primaryPhone: nextPhone(), taxNumber: 'C111' });
      const merge = await create('owner', { contactType: 'organisation', displayName: 'Ridge Estates Limited', organisationName: 'Ridge Estates Limited', primaryPhone: nextPhone(), taxNumber: 'C222', organisationRegNumber: 'CS-9', displayNameLocal: 'ريدج' });
      const result = await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, {
        mergeContactId: merge.id,
        mergeVersion: merge.version,
        fields: { taxNumber: 'merge', organisationRegNumber: 'merge', organisationName: 'merge', displayNameLocal: 'merge', displayName: 'keep' },
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.contact).toMatchObject({ displayName: 'Ridge Estates', taxNumber: 'C222', organisationRegNumber: 'CS-9', organisationName: 'Ridge Estates Limited', displayNameLocal: 'ريدج' });
    });
  });
});
