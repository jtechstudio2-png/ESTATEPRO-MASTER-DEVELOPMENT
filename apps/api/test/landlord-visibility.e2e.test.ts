import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let counter = 0;
const nextPhone = () => `024${String(8600000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

interface ViewBody {
  listing: { id: string; visibleSince: string; openOffers: number | null; upcomingViewings: number | null; openDeals: number | null };
  offers: Array<Record<string, unknown>> | null;
  deals: Array<Record<string, unknown> & { milestones: Array<Record<string, unknown>> }> | null;
  viewings: Array<Record<string, unknown>> | null;
  notShown: string[];
}

/**
 * S4 landlord visibility (issue #5; readiness report §6; P6-D10): reduced,
 * read-only views of offers, deal progress and viewings on the landlord's
 * own listings, for landlord portal accounts; field by field what is shown
 * and never shown; joint owners; visibility from the start of the link and
 * ending with it; other properties and other companies; the staff preview
 * limited to the staff member's own access, audited.
 */
describe('S4: landlord visibility', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};
  const contacts: Record<string, string> = {};
  let listingId: string;
  let unitId: string;
  let propertyId: string;
  let buyer: { id: string; phone: string };
  let dealId: string;
  let dealReference: string;
  let oldOfferId: string;

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

  async function landlord(name: string) {
    const member = await fx.member(company.companyId, { roleKey: 'landlord', membershipType: 'portal' });
    const row = await fx.db.selectFrom('companyMemberships').select('contactId').where('id', '=', member.membershipId).executeTakeFirstOrThrow();
    contacts[name] = row.contactId!;
    await fx.linkIdentity(member.userId, `s4-${name}-${company.companyId}`);
    tokens[name] = await t.idp.token({ sub: `s4-${name}-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
  }

  const own = (contact: string, from: string, property = propertyId) =>
    fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: property, ownerContactId: contact, sharePercent: '50', effectiveFrom: from }).returning('id').executeTakeFirstOrThrow();

  async function viewing(status: 'completed' | 'cancelled' | 'scheduled', feedback: string | null, shared: boolean, start: Date) {
    return fx.db.transaction().execute(async (tx) => {
      const row = await tx
        .insertInto('viewings')
        .values({ companyId: company.companyId, listingId, unitId, dealId, agentMembershipId: members['agent']!, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 30 * 60_000), timezone: 'Africa/Accra', meetingPoint: 'Gate by the mango tree' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx.insertInto('viewingAttendees').values({ companyId: company.companyId, viewingId: row.id, contactId: buyer.id }).execute();
      if (status === 'completed') await tx.updateTable('viewings').set({ status, outcome: 'interested', feedback, sellerFeedbackShared: shared }).where('id', '=', row.id).execute();
      if (status === 'cancelled') await tx.updateTable('viewings').set({ status, cancelledReason: 'Buyer unwell' }).where('id', '=', row.id).execute();
      return row.id;
    });
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const agent2 = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    Object.assign(members, { owner: company.ownerMembershipId, agent: agent.membershipId, agent2: agent2.membershipId });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['agent2', agent2.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `s4-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `s4-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    await landlord('landlord');
    await landlord('coOwner');
    await landlord('stranger');

    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', { name: 'Labone Villa', propertyTypeId: typeId, officeId: company.officeId, address: { countryCode: 'GH', addressLine1: '4 Landlord Lane', locality: 'Accra', adminArea1: 'Greater Accra' }, createWholePropertyUnit: true })
      .expect(201);
    propertyId = property.body.id;
    unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', propertyId).executeTakeFirstOrThrow()).id;
    listingId = (await fx.listing(company.companyId, unitId, members['agent']!, company.officeId)).id;
    await own(contacts['landlord']!, '2020-01-01');
    // The stranger owns another property.
    const elsewhere = await as('owner')
      .post('/api/v1/properties', { name: 'Elsewhere', propertyTypeId: typeId, officeId: company.officeId, address: { countryCode: 'GH', addressLine1: '9 Other Road', locality: 'Accra', adminArea1: 'Greater Accra' }, createWholePropertyUnit: true })
      .expect(201);
    await own(contacts['stranger']!, '2020-01-01', elsewhere.body.id);

    const phone = nextPhone();
    const created = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: 'Yaw Buyer', primaryPhone: phone, primaryEmail: `yaw.${randomUUID().slice(0, 6)}@example.test` }).expect(201);
    buyer = { id: created.body.id, phone };
    const deal = await as('owner').post('/api/v1/deals', { dealType: 'sale', primaryContactId: buyer.id, listingId, ownerMembershipId: members['agent'], expectedFee: ghs('13500.00') }).expect(201);
    dealId = deal.body.id;
    dealReference = deal.body.reference;
    // An offer from before the co-owner's start, then one accepted today.
    const old = await fx.db
      .insertInto('offers')
      .values({ companyId: company.companyId, dealId, listingId, offeredByContactId: buyer.id, direction: 'from_buyer', currencyCode: 'GHS', amount: '400000', conditions: 'Subject to survey', submittedAt: daysAgo(10), recordedBy: members['agent']! })
      .returning('id')
      .executeTakeFirstOrThrow();
    oldOfferId = old.id;
    await fx.db.updateTable('offers').set({ status: 'rejected', respondedAt: daysAgo(9) }).where('id', '=', old.id).execute();
    await fx.db.updateTable('deals').set({ stageId: (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', 'sale').where('code', '=', 'negotiation').executeTakeFirstOrThrow()).id }).where('id', '=', dealId).execute();
    const offer = await as('owner').post('/api/v1/offers', { dealId, offeredByContactId: buyer.id, amount: ghs('440000.00'), conditions: 'Mortgage in principle', financingCode: 'mortgage' }).expect(201);
    await as('owner').action(`/api/v1/offers/${offer.body.id}/accept`, offer.body.version).expect(200);
    await viewing('completed', 'Loved the garden', true, daysAgo(1));
    await viewing('completed', 'Thinks the price is high', false, daysAgo(2));
    await viewing('cancelled', null, false, new Date(Date.now() + 48 * 3_600_000));
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it('shows the landlord their listings with counts, and one listing\'s offers, deal progress and viewings in reduced form', async () => {
    const list = (await as('landlord').get('/api/v1/portal/landlord/listings').expect(200)).body.data as Array<Record<string, unknown>>;
    expect(list).toEqual([
      expect.objectContaining({ id: listingId, status: 'reserved', propertyName: 'Labone Villa', visibleSince: '2020-01-01', openOffers: 0, upcomingViewings: 0, openDeals: 1 }),
    ]);
    const view = (await as('landlord').get(`/api/v1/portal/landlord/listings/${listingId}`).expect(200)).body as ViewBody;

    expect(view.offers!.map((o) => o['status'])).toEqual(['accepted', 'rejected']);
    expect(Object.keys(view.offers![0]!).sort()).toEqual(
      ['amount', 'conditions', 'direction', 'expiresAt', 'financingCode', 'id', 'offeredByName', 'parentOfferId', 'rentFrequency', 'respondedAt', 'status', 'submittedAt'].sort(),
    );
    expect(view.offers![0]).toMatchObject({ offeredByName: 'Yaw Buyer', amount: { amount: '440000.00', currency: 'GHS' }, conditions: 'Mortgage in principle', financingCode: 'mortgage' });

    expect(view.deals).toHaveLength(1);
    expect(Object.keys(view.deals![0]!).sort()).toEqual(['id', 'milestones', 'stageClass', 'stageName', 'status']);
    expect(view.deals![0]).toMatchObject({ stageClass: 'offer_accepted', stageName: 'Offer accepted', status: 'open' });
    expect(view.deals![0]!.milestones).toHaveLength(9);
    expect(Object.keys(view.deals![0]!.milestones[0]!).sort()).toEqual(['done', 'dueDate', 'name']);

    expect(view.viewings!.map((v) => [v['status'], v['feedback']])).toEqual([
      ['cancelled', null],
      ['completed', 'Loved the garden'],
      ['completed', null],
    ]);
    expect(Object.keys(view.viewings![0]!).sort()).toEqual(['feedback', 'id', 'outcome', 'scheduledEnd', 'scheduledStart', 'status', 'timezone', 'viewingType']);

    // Never shown: contact details and ids of the buyer, notes, fees, agents, other parties, attendees.
    const text = JSON.stringify(view);
    for (const secret of [buyer.id, buyer.phone, '@example.test', 'Thinks the price is high', 'Gate by the mango tree', 'Buyer unwell', '13500', members['agent']!, 'recordedBy', dealReference]) {
      expect(text).not.toContain(secret);
    }
    expect(view.notShown).toEqual(expect.arrayContaining(['buyer_contact_details', 'commission_fees_splits', 'attendee_identities', 'unshared_feedback']));
  });

  it('gives joint owners the same view from their own start, and ends visibility with the ownership', async () => {
    await own(contacts['coOwner']!, isoDay(new Date()));
    const coView = (await as('coOwner').get(`/api/v1/portal/landlord/listings/${listingId}`).expect(200)).body as ViewBody;
    const mine = (await as('landlord').get(`/api/v1/portal/landlord/listings/${listingId}`).expect(200)).body as ViewBody;
    // The offer from ten days ago predates the co-owner's link; everything since is the same.
    expect(coView.listing.visibleSince).toBe(isoDay(new Date()));
    expect(coView.offers!.map((o) => o['id'])).toEqual(mine.offers!.filter((o) => o['id'] !== oldOfferId).map((o) => o['id']));
    expect(coView.deals).toEqual(mine.deals);
    expect(coView.viewings!.map((v) => v['status'])).toEqual(['cancelled']);

    // An ownership that has ended gives nothing.
    const ended = await fx.db
      .insertInto('propertyOwnerships')
      .values({ companyId: company.companyId, propertyId, ownerContactId: contacts['stranger']!, sharePercent: '10', effectiveFrom: '2019-01-01', effectiveTo: isoDay(daysAgo(1)) })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(ended.id).toBeDefined();
    await as('stranger').get(`/api/v1/portal/landlord/listings/${listingId}`).expect(404);
    expect(((await as('stranger').get('/api/v1/portal/landlord/listings').expect(200)).body.data as unknown[]).map((l) => (l as { id: string }).id)).not.toContain(listingId);
  });

  it('keeps the views to landlord portal accounts and the staff APIs closed to landlords', async () => {
    await as('agent').get('/api/v1/portal/landlord/listings').expect(403);
    await as('owner').get(`/api/v1/portal/landlord/listings/${listingId}`).expect(403);
    await as('landlord').get(`/api/v1/portal/landlord/listings/${randomUUID()}`).expect(404);
    // Staff endpoints stay closed to portal accounts; only the portal endpoints open to them.
    for (const path of [`/api/v1/offers?filter[listingId]=${listingId}`, '/api/v1/deals', `/api/v1/deals/${dealId}`, `/api/v1/viewings?filter[listingId]=${listingId}`, `/api/v1/listings/${listingId}`]) {
      const res = await as('landlord').get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.detail).toContain('staff only');
    }
    await as('landlord').post('/api/v1/offers', { dealId, offeredByContactId: buyer.id, amount: ghs('1.00') }).expect(403);
    await as('landlord').get(`/api/v1/contacts/${contacts['landlord']}/portal-visibility-preview/listings/${listingId}`).expect(403);
  });

  it('previews what the landlord could see for staff, limited to their own access, and audits it', async () => {
    const landlordView = (await as('landlord').get(`/api/v1/portal/landlord/listings/${listingId}`).expect(200)).body as ViewBody;
    const preview = await as('owner').get(`/api/v1/contacts/${contacts['landlord']}/portal-visibility-preview/listings/${listingId}`).expect(200);
    expect(preview.body).toMatchObject({ contactId: contacts['landlord'], limitedToYourAccess: false });
    expect(preview.body.offers).toEqual(landlordView.offers);
    expect(preview.body.deals).toEqual(landlordView.deals);
    expect(preview.body.viewings).toEqual(landlordView.viewings);
    const audit = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', contacts['landlord']!).where('action', '=', 'contact.portal_preview').orderBy('entryNo', 'desc').executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ portal: 'landlord', listingId, offers: 2, deals: 1, viewings: 3 });

    // An agent who may see the landlord's contact but is not on the deal sees nothing of it through the preview.
    await as('agent2').get(`/api/v1/contacts/${contacts['landlord']}/portal-visibility-preview/listings/${listingId}`).expect(404);
    await fx.db.updateTable('contacts').set({ ownerMembershipId: members['agent2'] }).where('id', '=', contacts['landlord']!).execute();
    const limited = await as('agent2').get(`/api/v1/contacts/${contacts['landlord']}/portal-visibility-preview/listings/${listingId}`);
    expect(limited.status, JSON.stringify(limited.body)).toBe(200);
    expect(limited.body).toMatchObject({ limitedToYourAccess: true, offers: [], deals: [], viewings: [] });
    expect(limited.body.listing).toMatchObject({ openOffers: 0, openDeals: 0 });

    await as('owner').get(`/api/v1/contacts/${contacts['stranger']}/portal-visibility-preview/listings/${listingId}`).expect(404);
    await as('otherOwner').get(`/api/v1/contacts/${contacts['landlord']}/portal-visibility-preview/listings/${listingId}`).expect(404);
  });
});
