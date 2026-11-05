import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let phoneCounter = 3000;
const nextPhone = () => `024${String(9300000 + phoneCounter++).padStart(7, '0')}`;

/**
 * Phase 5 milestone C6: register summaries (SE-1, B-1, LL-1), the company-wide
 * identity-check queue (SH-1), and codes for text the web app translates.
 * Every summary is limited to what the viewer may see.
 */
describe('CRM register summaries and identity-check queue (Phase 5 milestone C6)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};
  const types: Record<string, string> = {};

  const req = (who: string) => {
    const companyId = who === 'otherOwner' ? other.companyId : company.companyId;
    return {
      get: (path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId),
      post: (path: string, body: object = {}) => t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body),
    };
  };

  async function contact(who: string, overrides: Record<string, unknown> = {}) {
    const res = await req(who).post('/api/v1/contacts', { contactType: 'person', displayName: `C6 ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; reference: string; displayName: string };
  }

  async function property(name: string, officeId: string) {
    const res = await req('owner')
      .post('/api/v1/properties', {
        name,
        propertyTypeId: types['house_detached'],
        officeId,
        createWholePropertyUnit: true,
        address: { countryCode: 'GH', addressLine1: `${name} Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
      })
      .expect(201);
    const units = await req('owner').get(`/api/v1/properties/${res.body.id}/units`).expect(200);
    return { id: res.body.id as string, unitId: units.body.data[0].id as string };
  }

  const row = (page: { data: Array<{ id: string }> }, id: string) => page.data.find((item) => item.id === id) as Record<string, unknown> | undefined;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    for (const type of await fx.db.selectFrom('propertyTypes').select(['id', 'code']).where('companyId', 'is', null).execute()) types[type.code] = type.id;
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      sales: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      salesKsi: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [name, member] of Object.entries(people)) {
      members[name] = member.membershipId;
      await fx.linkIdentity(member.userId, `c6-${name}-${member.companyId}`);
      tokens[name] = await t.idp.token({ sub: `c6-${name}-${member.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('register summaries (SE-1, B-1, LL-1)', () => {
    it('shows sellers their listings, open valuation lead and next follow-up, and landlords their properties', async () => {
      const seller = await contact('owner', { relationships: ['seller', 'landlord'], officeId: company.officeId });
      const home = await property('Summary House', company.officeId);
      const listing = await fx.listing(company.companyId, home.unitId, members['owner']!, company.officeId);
      await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: home.id, ownerContactId: seller.id, effectiveFrom: '2020-01-01' }).execute();
      const lead = await req('owner').post('/api/v1/leads', { contactId: seller.id, leadType: 'valuation', sourceCode: 'referral', officeId: company.officeId }).set('Idempotency-Key', randomUUID()).expect(201);
      const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const sooner = new Date(Date.now() + 86_400_000).toISOString();
      await req('owner').post('/api/v1/tasks', { title: 'Send valuation', dueAt: later, about: { entityType: 'contact', entityId: seller.id } }).expect(201);
      await req('owner').post('/api/v1/tasks', { title: 'Call about valuation', dueAt: sooner, about: { entityType: 'lead', entityId: lead.body.id } }).expect(201);

      const sellers = await req('owner').get(`/api/v1/contacts?filter[relationship]=seller&q=${encodeURIComponent(seller.displayName)}`).expect(200);
      expect(row(sellers.body, seller.id)).toMatchObject({
        listings: { active: 1, published: 0, latest: { id: listing.id, status: 'available', isPublished: false } },
        valuationLead: { id: lead.body.id, status: 'new' },
        // The earlier of the two follow-ups, found through the lead.
        nextFollowUp: { dueAt: sooner, overdue: false },
      });
      const landlords = await req('owner').get(`/api/v1/contacts?filter[relationship]=landlord&q=${encodeURIComponent(seller.displayName)}`).expect(200);
      expect(row(landlords.body, seller.id)).toMatchObject({ properties: 1, listings: { active: 1 } });
      expect(row(landlords.body, seller.id)).not.toHaveProperty('valuationLead');
      // The plain register carries only the next follow-up.
      const all = await req('owner').get(`/api/v1/contacts?q=${encodeURIComponent(seller.displayName)}`).expect(200);
      const plain = row(all.body, seller.id)!;
      expect(plain['nextFollowUp']).toMatchObject({ dueAt: sooner });
      expect(plain).not.toHaveProperty('listings');
      expect(plain).not.toHaveProperty('properties');
    });

    it('counts only what the viewer may see', async () => {
      // A Kumasi listing on an Osu contact: the Osu manager sees the contact but not the listing or property.
      const seller = await contact('owner', { relationships: ['seller', 'landlord'], officeId: company.officeId });
      const ksi = await property('Kumasi Summary', kumasiOfficeId);
      await fx.listing(company.companyId, ksi.unitId, members['owner']!, kumasiOfficeId);
      await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: ksi.id, ownerContactId: seller.id, effectiveFrom: '2020-01-01' }).execute();
      const forOwner = await req('owner').get(`/api/v1/contacts?filter[relationship]=landlord&q=${encodeURIComponent(seller.displayName)}`).expect(200);
      expect(row(forOwner.body, seller.id)).toMatchObject({ properties: 1, listings: { active: 1 } });
      const forSales = await req('sales').get(`/api/v1/contacts?filter[relationship]=landlord&q=${encodeURIComponent(seller.displayName)}`).expect(200);
      expect(row(forSales.body, seller.id)).toMatchObject({ properties: 0, listings: { active: 0, published: 0, latest: null } });

      // A follow-up about the agent's own contact, assigned to someone else: the agent does not see it.
      const agentContact = await contact('agent');
      await req('owner').post('/api/v1/tasks', { title: 'Manager check', dueAt: new Date(Date.now() + 3_600_000).toISOString(), assignedTo: members['sales'], about: { entityType: 'contact', entityId: agentContact.id } }).expect(201);
      const forAgent = await req('agent').get(`/api/v1/contacts?q=${encodeURIComponent(agentContact.displayName)}`).expect(200);
      expect(row(forAgent.body, agentContact.id)).toMatchObject({ nextFollowUp: null });
      const forManager = await req('sales').get(`/api/v1/contacts?q=${encodeURIComponent(agentContact.displayName)}`).expect(200);
      expect(row(forManager.body, agentContact.id)!['nextFollowUp']).not.toBeNull();

      // Members without listing or property access get null, not zero.
      const forAccountant = await req('accountant').get(`/api/v1/contacts?filter[relationship]=seller&q=${encodeURIComponent(seller.displayName)}`).expect(200);
      expect(row(forAccountant.body, seller.id)).toMatchObject({ valuationLead: null });
    });

    it('adds the contact’s next follow-up to the requirements register (B-1)', async () => {
      const buyer = await contact('owner', { relationships: ['buyer'] });
      await req('owner').post(`/api/v1/contacts/${buyer.id}/requirements`, { requirementType: 'buy', currencyCode: 'GHS', maxPrice: '900000' }).expect(201);
      const due = new Date(Date.now() - 3_600_000).toISOString();
      const task = await req('owner').post('/api/v1/tasks', { title: 'Overdue call', dueAt: new Date(Date.now() + 60_000).toISOString(), about: { entityType: 'contact', entityId: buyer.id } }).expect(201);
      await fx.db.updateTable('tasks').set({ dueAt: new Date(due) }).where('id', '=', task.body.id).execute();
      const register = await req('owner').get(`/api/v1/requirements?filter[contactId]=${buyer.id}`).expect(200);
      expect(register.body.data[0]).toMatchObject({ contact: { id: buyer.id }, nextFollowUp: { dueAt: due, overdue: true } });
      // The per-contact list does not carry it.
      const own = await req('owner').get(`/api/v1/contacts/${buyer.id}/requirements`).expect(200);
      expect(own.body[0]).not.toHaveProperty('nextFollowUp');
    });
  });

  describe('identity-check queue (SH-1)', () => {
    it('lists open checks oldest first within the member’s scope, with filters', async () => {
      const ownersContact = await contact('owner', { displayName: 'Queue Owner Contact' });
      const agentsContact = await contact('agent', { displayName: 'Queue Agent Contact' });
      const first = await req('owner').post(`/api/v1/contacts/${ownersContact.id}/kyc-checks`, { checkType: 'identity' }).expect(201);
      const second = await req('agent').post(`/api/v1/contacts/${agentsContact.id}/kyc-checks`, { checkType: 'address', status: 'in_review' }).expect(201);
      const verified = await req('owner').post(`/api/v1/contacts/${ownersContact.id}/kyc-checks`, { checkType: 'sanctions_pep' }).expect(201);
      const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
      await req('owner')
        .post(`/api/v1/contacts/${ownersContact.id}/kyc-checks/${verified.body.id}/approve`, { riskRating: 'low', expiresOn: soon })
        .set('If-Match', `"${verified.body.version}"`)
        .expect(200);

      const queue = await req('owner').get('/api/v1/kyc-checks?limit=100').expect(200);
      const ids = queue.body.data.map((item: { id: string }) => item.id);
      expect(ids).toEqual(expect.arrayContaining([first.body.id, second.body.id]));
      expect(ids).not.toContain(verified.body.id);
      expect(ids.indexOf(first.body.id)).toBeLessThan(ids.indexOf(second.body.id));
      const item = queue.body.data.find((entry: { id: string }) => entry.id === first.body.id);
      expect(item).toMatchObject({ checkType: 'identity', status: 'pending', contact: { id: ownersContact.id, name: 'Queue Owner Contact' }, canDecide: true });
      // No document numbers, protected values or contact methods in the queue.
      expect(JSON.stringify(queue.body)).not.toMatch(/primaryPhone|taxNumber|documentNumber/);

      // Agents see only checks of contacts they own (never through a lead).
      const forAgent = await req('agent').get('/api/v1/kyc-checks?limit=100').expect(200);
      expect(forAgent.body.data.map((entry: { id: string }) => entry.id)).toEqual([second.body.id]);
      expect(forAgent.body.data[0]).toMatchObject({ canDecide: false });
      // The accountant reads every check but decides none.
      const forAccountant = await req('accountant').get('/api/v1/kyc-checks?limit=100').expect(200);
      expect(forAccountant.body.data.find((entry: { id: string }) => entry.id === first.body.id)).toMatchObject({ canEdit: false, canDecide: false });

      const expiring = await req('owner').get('/api/v1/kyc-checks?filter[expiring]=true').expect(200);
      expect(expiring.body.data.map((entry: { id: string }) => entry.id)).toEqual([verified.body.id]);
      const byStatus = await req('owner').get('/api/v1/kyc-checks?filter[status]=verified&filter[checkType]=sanctions_pep').expect(200);
      expect(byStatus.body.data.map((entry: { id: string }) => entry.id)).toContain(verified.body.id);
      await req('owner').get('/api/v1/kyc-checks?filter[status]=approved').expect(422);
    });

    it('is closed to members without kyc.view and to other companies', async () => {
      const otherQueue = await req('otherOwner').get('/api/v1/kyc-checks?limit=100').expect(200);
      expect(otherQueue.body.data).toEqual([]);
      const tech = await fx.member(company.companyId, { roleKey: 'maintenance_staff', officeIds: [company.officeId] });
      await fx.linkIdentity(tech.userId, `c6-tech-${company.companyId}`);
      const techToken = await t.idp.token({ sub: `c6-tech-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
      await t.http.get('/api/v1/kyc-checks').auth(techToken, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(403);
    });
  });

  describe('codes for translated screens', () => {
    it('gives the landlord preview’s hidden items and the merge blockers as codes', async () => {
      const landlord = await contact('owner', { relationships: ['landlord'] });
      const preview = await req('owner').get(`/api/v1/contacts/${landlord.id}/portal-visibility-preview`).expect(200);
      expect(preview.body.notVisibleCodes).toEqual(['other_owners', 'tenant_buyer_contacts', 'staff_records', 'protected_details']);
      expect(preview.body.notVisible).toHaveLength(4);

      const organisation = await contact('owner', { contactType: 'organisation', displayName: 'C6 Holdings Ltd', organisationName: 'C6 Holdings Ltd' });
      const merge = await req('owner').get(`/api/v1/contacts/${landlord.id}/merge-preview?mergeContactId=${organisation.id}`).expect(200);
      expect(merge.body.blockerDetails).toEqual([{ code: 'different_types', message: 'A person and an organisation cannot be merged.', records: [] }]);
      expect(merge.body.blockers).toEqual(['A person and an organisation cannot be merged.']);
    });
  });
});
