import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let counter = 0;
const nextPhone = () => `024${String(8100000 + counter++).padStart(7, '0')}`;
const ghs = (amount: string) => ({ amount, currency: 'GHS' });
const today = () => new Date().toISOString().slice(0, 10);
let slot = 0;
const nextSlot = () => {
  slot += 1;
  const start = new Date(Date.now() + (30 + slot * 2) * 3_600_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 30 * 60_000).toISOString() };
};

interface DealBody {
  id: string;
  reference: string;
  version: number;
  status: string;
  stage: { id: string; code: string; stageClass: string };
  owner: { id: string };
  listing: { id: string; status: string } | null;
  expectedValue: { amount: string; currency: string } | null;
  weightedValue: { amount: string; currency: string } | null;
  stalled: boolean;
  parties: Array<{ contact: { id: string }; partyRole: string; isPrimary: boolean; identityVerified: boolean | null }>;
  agents: Array<{ member: { id: string }; agentRole: string; splitPercent: number }>;
  milestones: Array<{ id: string; code: string; isRequired: boolean; automatic: boolean; completedAt: string | null; dueDate: string | null; notes: string | null }>;
  stageHistory: Array<{ toStage: { stageClass: string }; note: string | null }>;
  assignments: Array<{ from: { id: string } | null; to: { id: string }; note: string | null }>;
  acceptedOffer: { id: string } | null;
  sale: { reference: string; status: string; agreedPrice: { amount: string }; contractSignedOn: string | null; completedOn: string | null; fallenThroughReason: string | null } | null;
  identity: { required: boolean; unverifiedBuyerIds: string[] };
  access: { canEdit: boolean; nextStages: Array<{ id: string; stageClass: string }>; canReassign: boolean; canExchange: boolean; canComplete: boolean; canLose: boolean };
  lostReasonCode: string | null;
  lostNotes: string | null;
  sourceCode: string | null;
  lead: { id: string } | null;
}

/**
 * S3 deals (readiness report §4.3, §4.4, §5; P6-D2, P6-D5 to P6-D8, P6-D11):
 * direct creation and lead conversion, moving stages by hand within the life
 * cycle, editing, reassignment and splits (managers), parties, milestones
 * copied on acceptance with identity checks and automatic identity
 * milestones, exchange (verified buyers), completion (required milestones,
 * ownership transfer), losing with its effects, letting deals stopping at
 * "terms agreed", the board, the forecast, the stalled flag, scope (one deal
 * scope for deals, offers and viewings), tenant isolation, timeline, audit,
 * outbox and the access report.
 */
describe('S3: deals', () => {
  let t: TestApp;
  let fx: Fixtures;
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
      patch: (path: string, version: number, body: object) => auth(t.http.patch(path)).set('If-Match', `"${version}"`).send(body),
      put: (path: string, version: number, body: object) => auth(t.http.put(path)).set('If-Match', `"${version}"`).send(body),
    };
  };

  async function contact(who = 'owner', name = `Party ${randomUUID().slice(0, 6)}`) {
    const res = await as(who).post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function newListing(listingType: 'sale' | 'rent' = 'sale', agent = members['agent']!) {
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: `Deal Villa ${counter}`,
        propertyTypeId: typeId,
        officeId: company.officeId,
        address: { countryCode: 'GH', addressLine1: `${counter++} Deal Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
        createWholePropertyUnit: true,
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    const listing = await fx.listing(company.companyId, unitId, agent, company.officeId);
    if (listingType === 'rent') await fx.db.updateTable('listings').set({ listingType: 'rent', rentFrequency: 'monthly', price: '6000.00' }).where('id', '=', listing.id).execute();
    return { listingId: listing.id, unitId, propertyId: property.body.id as string };
  }

  async function create(who: string, body: Record<string, unknown>, expected = 201) {
    const res = await as(who).post('/api/v1/deals', body);
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return res.body as DealBody;
  }

  const get = async (who: string, id: string) => (await as(who).get(`/api/v1/deals/${id}`).expect(200)).body as DealBody;

  async function act(who: string, id: string, action: string, body: object = {}, expected = 200) {
    const current = await get('owner', id);
    const res = await as(who).action(`/api/v1/deals/${id}/${action}`, current.version, body);
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return res.body as DealBody & { errors?: Array<{ field: string; code: string }>; detail?: string };
  }

  async function offerAccepted(buyerId: string, place: { listingId: string }, owner = members['agent']!) {
    const deal = await create('owner', { dealType: 'sale', primaryContactId: buyerId, listingId: place.listingId, ownerMembershipId: owner });
    const offer = await as('owner').post('/api/v1/offers', { dealId: deal.id, offeredByContactId: buyerId, amount: ghs('440000.00') });
    expect(offer.status, JSON.stringify(offer.body)).toBe(201);
    const accepted = await as('owner').action(`/api/v1/offers/${offer.body.id}/accept`, offer.body.version);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return { deal: await get('owner', deal.id), offerId: offer.body.id as string };
  }

  async function verify(contactId: string) {
    const checks = (await as('owner').get(`/api/v1/contacts/${contactId}/kyc-checks`).expect(200)).body as Array<{ id: string; status: string; checkType: string; version: number }>;
    let check = checks.find((c) => c.checkType === 'identity' && c.status === 'pending');
    if (!check) check = (await as('owner').post(`/api/v1/contacts/${contactId}/kyc-checks`, { checkType: 'identity' }).expect(201)).body;
    await as('owner').action(`/api/v1/contacts/${contactId}/kyc-checks/${check!.id}/approve`, check!.version, { riskRating: 'low' }).expect(200);
  }

  const auditActions = async (entityId: string) =>
    (await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', entityId).orderBy('occurredAt').orderBy('entryNo').execute()).map((row) => row.action);

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const agent2 = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const agent3 = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const manager = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    const accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    const officeB = await fx.office(company.companyId, `S3B${counter++}`);
    const managerB = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [officeB.id] });
    const agentB = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [officeB.id] });
    Object.assign(members, { owner: company.ownerMembershipId, agent: agent.membershipId, agent2: agent2.membershipId, agent3: agent3.membershipId, manager: manager.membershipId, managerB: managerB.membershipId, agentB: agentB.membershipId, officeB: officeB.id });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['agent2', agent2.userId, company.companyId],
      ['manager', manager.userId, company.companyId],
      ['accountant', accountant.userId, company.companyId],
      ['managerB', managerB.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `s3-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `s3-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('creating', () => {
    it('creates a deal directly: lead stage, the buyer as primary party, value from the listing; history, timeline, audit and outbox', async () => {
      const buyer = await contact('agent');
      const place = await newListing();
      const deal = await create('agent', { dealType: 'sale', primaryContactId: buyer.id, listingId: place.listingId, sourceCode: 'walk_in', expectedCloseDate: '2027-03-31' });
      expect(deal).toMatchObject({
        status: 'open',
        stage: { stageClass: 'lead' },
        owner: { id: members['agent'] },
        listing: { id: place.listingId },
        expectedValue: { amount: '450000.00', currency: 'GHS' },
        weightedValue: { amount: '22500.00', currency: 'GHS' },
        sourceCode: 'walk_in',
        parties: [{ contact: { id: buyer.id }, partyRole: 'buyer', isPrimary: true }],
        assignments: [{ from: null, to: { id: members['agent'] } }],
        access: { canEdit: true, canReassign: false, canExchange: false, canComplete: false, canLose: false },
      });
      expect(deal.reference).toMatch(/^DEA-/);
      expect(deal.stageHistory.map((h) => h.toStage.stageClass)).toEqual(['lead']);
      expect(deal.access.nextStages.map((s) => s.stageClass).sort()).toEqual(['negotiation', 'qualification', 'viewing']);
      expect(await auditActions(deal.id)).toEqual(['deal.created']);
      const event = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', deal.id).executeTakeFirstOrThrow();
      expect(event.eventType).toBe('deal.created');
      const timeline = await fx.db
        .selectFrom('activityLinks as k')
        .innerJoin('activities as a', 'a.id', 'k.activityId')
        .select(['a.subject', 'k.entityType'])
        .where('k.entityId', '=', deal.id)
        .execute();
      expect(timeline).toEqual([{ subject: expect.stringContaining(`Deal ${deal.reference} created`), entityType: 'deal' }]);
    });

    it('checks the listing, the owner, the contact, the money and the source', async () => {
      const buyer = await contact();
      const place = await newListing();
      const codes = async (who: string, body: Record<string, unknown>) =>
        ((await create(who, body, 422)) as unknown as { errors: Array<{ field: string; code: string }> }).errors.map((e) => `${e.field}:${e.code}`);
      expect(await codes('owner', { dealType: 'letting', primaryContactId: buyer.id, listingId: place.listingId })).toContain('listingId:type-mismatch');
      expect(await codes('agent', { dealType: 'sale', primaryContactId: buyer.id, ownerMembershipId: members['agent2'] })).toContain('ownerMembershipId:not-allowed');
      expect(await codes('owner', { dealType: 'sale', primaryContactId: randomUUID() })).toContain('primaryContactId:not-found');
      expect(await codes('owner', { dealType: 'sale', primaryContactId: buyer.id, listingId: place.listingId, expectedValue: { amount: '1.00', currency: 'USD' } })).toContain('expectedValue.currency:currency-mismatch');
      expect(await codes('owner', { dealType: 'sale', primaryContactId: buyer.id, sourceCode: 'carrier_pigeon' })).toContain('sourceCode:unknown-code');
      const withdrawn = await newListing();
      await fx.db.updateTable('listings').set({ status: 'withdrawn' }).where('id', '=', withdrawn.listingId).execute();
      expect(await codes('owner', { dealType: 'sale', primaryContactId: buyer.id, listingId: withdrawn.listingId })).toContain('listingId:listing-not-live');
      // A manager may create a deal for an agent of their office; a letting deal takes the rent per year.
      const rent = await newListing('rent');
      const letting = await create('manager', { dealType: 'letting', primaryContactId: buyer.id, listingId: rent.listingId, ownerMembershipId: members['agent'] });
      expect(letting).toMatchObject({ owner: { id: members['agent'] }, expectedValue: { amount: '72000.00' }, parties: [{ partyRole: 'tenant', isPrimary: true }] });
    });

    it('converts a buy lead into its one deal: viewing stage, viewings joined, source kept, lead converted with history', async () => {
      const person = await contact('agent');
      const place = await newListing();
      const lead = (await as('agent').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'phone', listingId: place.listingId }).expect(201)).body;
      const viewing = await as('agent').post('/api/v1/viewings', { listingId: place.listingId, leadId: lead.id, attendeeContactIds: [person.id], ...nextSlot() });
      expect(viewing.status, JSON.stringify(viewing.body)).toBe(201);
      const current = (await as('agent').get(`/api/v1/leads/${lead.id}`).expect(200)).body;
      const converted = await as('agent').action(`/api/v1/leads/${lead.id}/convert`, current.version, {});
      expect(converted.status, JSON.stringify(converted.body)).toBe(201);
      expect(converted.headers['location']).toBe(`/api/v1/deals/${converted.body.id}`);
      const deal = converted.body as DealBody;
      expect(deal).toMatchObject({ stage: { stageClass: 'viewing' }, lead: { id: lead.id }, sourceCode: 'phone', owner: { id: members['agent'] }, listing: { id: place.listingId } });
      const after = (await as('agent').get(`/api/v1/leads/${lead.id}`).expect(200)).body;
      expect(after).toMatchObject({ status: 'converted', convertedDealId: deal.id, access: { nextStatuses: [] } });
      expect(after.statusHistory.at(-1)).toMatchObject({ fromStatus: 'contacted', toStatus: 'converted', note: `Converted to deal ${deal.reference}` });
      const joined = (await as('agent').get(`/api/v1/viewings/${viewing.body.id}`).expect(200)).body;
      expect(joined.deal).toEqual({ id: deal.id, reference: deal.reference });
      expect(await auditActions(lead.id)).toContain('lead.converted');

      const again = await as('agent').action(`/api/v1/leads/${lead.id}/convert`, after.version, {});
      expect(again.status).toBe(422);
      const sell = (await as('agent').post('/api/v1/leads', { contactId: person.id, leadType: 'sell', sourceCode: 'phone' }).expect(201)).body;
      const refused = await as('agent').action(`/api/v1/leads/${sell.id}/convert`, sell.version, {});
      expect(refused.status).toBe(422);
      expect(refused.body.errors[0]).toMatchObject({ field: 'leadType', code: 'not-convertible' });
      // Without a booked viewing a converted lead starts at qualification; accountants cannot convert.
      const rentLead = (await as('owner').post('/api/v1/leads', { contactId: person.id, leadType: 'rent', sourceCode: 'phone' }).expect(201)).body;
      await as('accountant').action(`/api/v1/leads/${rentLead.id}/convert`, rentLead.version, {}).expect(403);
      const letting = await as('owner').action(`/api/v1/leads/${rentLead.id}/convert`, rentLead.version, {}).expect(201);
      expect(letting.body).toMatchObject({ dealType: 'letting', stage: { stageClass: 'qualification' }, listing: null, parties: [{ partyRole: 'tenant' }] });
    });
  });

  describe('working the deal', () => {
    it('moves stages by hand within the life cycle; later stages follow their actions; the note goes to the history', async () => {
      const buyer = await contact('agent');
      const deal = await create('agent', { dealType: 'sale', primaryContactId: buyer.id });
      const qualification = deal.access.nextStages.find((s) => s.stageClass === 'qualification')!;
      const moved = await act('agent', deal.id, 'stage', { stageId: qualification.id, note: 'Budget confirmed' });
      expect(moved.stage.stageClass).toBe('qualification');
      expect(moved.stageHistory.at(-1)).toMatchObject({ toStage: { stageClass: 'qualification' }, note: 'Budget confirmed' });
      const stage = async (code: string) => (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', 'sale').where('code', '=', code).executeTakeFirstOrThrow()).id;
      const back = await act('agent', deal.id, 'stage', { stageId: await stage('lead') }, 422);
      expect(back.errors?.[0]).toMatchObject({ field: 'stageId', code: 'stage-change' });
      const jump = await act('agent', deal.id, 'stage', { stageId: await stage('offer_accepted') }, 422);
      expect(jump.errors?.[0]).toMatchObject({ field: 'stageId', code: 'action-stage' });
      const letting = await act('agent', deal.id, 'stage', { stageId: (await fx.db.selectFrom('pipelineStages').select('id').where('dealType', '=', 'letting').where('code', '=', 'viewing').executeTakeFirstOrThrow()).id }, 422);
      expect(letting.errors?.[0]).toMatchObject({ code: 'not-found' });
      await as('agent').action(`/api/v1/deals/${deal.id}/stage`, 1, { stageId: await stage('viewing') }).expect(412);
      expect(await auditActions(deal.id)).toEqual(['deal.created', 'deal.stage_changed']);
    });

    it('edits the expected value, close date and probability; the listing until offers exist', async () => {
      const buyer = await contact();
      const place = await newListing();
      const deal = await create('owner', { dealType: 'sale', primaryContactId: buyer.id });
      const edited = await as('owner').patch(`/api/v1/deals/${deal.id}`, deal.version, { listingId: place.listingId, expectedValue: ghs('500000.00'), probabilityOverride: 50, expectedCloseDate: '2027-01-31' });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body).toMatchObject({ listing: { id: place.listingId }, expectedValue: { amount: '500000.00' }, weightedValue: { amount: '250000.00' }, probability: 50, expectedCloseDate: '2027-01-31' });
      const audit = await fx.db.selectFrom('auditLogs').select(['changes']).where('entityId', '=', deal.id).where('action', '=', 'deal.updated').executeTakeFirstOrThrow();
      expect(Object.keys(audit.changes as object).sort()).toEqual(['expectedCloseDate', 'expectedValue', 'listingId', 'probabilityOverride', 'unitId']);
      await as('owner').post('/api/v1/offers', { dealId: deal.id, offeredByContactId: buyer.id, amount: ghs('480000.00') }).expect(201);
      const current = await get('owner', deal.id);
      const another = await newListing();
      const refused = await as('owner').patch(`/api/v1/deals/${deal.id}`, current.version, { listingId: another.listingId });
      expect(refused.status).toBe(422);
      expect(refused.body.errors[0]).toMatchObject({ field: 'listingId', code: 'has-offers' });
      const cleared = await as('owner').patch(`/api/v1/deals/${deal.id}`, current.version, { probabilityOverride: null });
      expect(cleared.body).toMatchObject({ probability: 40 });
    });

    it('reassigns and sets splits as manager actions, recorded with the note; a co-agent sees the deal and its viewings', async () => {
      const buyer = await contact();
      const place = await newListing('sale', members['agent2']);
      const deal = await create('owner', { dealType: 'sale', primaryContactId: buyer.id, listingId: place.listingId, ownerMembershipId: members['agent2'] });
      await as('agent').get(`/api/v1/deals/${deal.id}`).expect(404);
      const viewing = await as('owner').post('/api/v1/viewings', { listingId: place.listingId, dealId: deal.id, agentMembershipId: members['agent2'], attendeeContactIds: [buyer.id], ...nextSlot() });
      expect(viewing.status, JSON.stringify(viewing.body)).toBe(201);
      await as('agent').get(`/api/v1/viewings/${viewing.body.id}`).expect(404);
      // The booked viewing moved the deal to the viewing stage (S1), so its version moved too.
      const booked = await get('owner', deal.id);
      expect(booked.stage.stageClass).toBe('viewing');

      const agentTry = await as('agent2').action(`/api/v1/deals/${deal.id}/reassign`, booked.version, { ownerMembershipId: members['agent'] });
      expect(agentTry.status).toBe(403);
      const splitsWrong = await as('manager').put(`/api/v1/deals/${deal.id}/agents`, booked.version, {
        agents: [
          { membershipId: members['agent2'], agentRole: 'lister', splitPercent: 60 },
          { membershipId: members['agent'], agentRole: 'co_agent', splitPercent: 30 },
        ],
      });
      expect(splitsWrong.status).toBe(422);
      expect(splitsWrong.body.errors[0]).toMatchObject({ field: 'agents', code: 'splits-total' });
      const split = await as('manager').put(`/api/v1/deals/${deal.id}/agents`, booked.version, {
        agents: [
          { membershipId: members['agent2'], agentRole: 'lister', splitPercent: 60 },
          { membershipId: members['agent'], agentRole: 'co_agent', splitPercent: 40 },
        ],
      });
      expect(split.status, JSON.stringify(split.body)).toBe(200);
      expect(split.body.agents).toEqual([
        { member: { id: members['agent2'], name: expect.any(String) }, agentRole: 'lister', splitPercent: 60 },
        { member: { id: members['agent'], name: expect.any(String) }, agentRole: 'co_agent', splitPercent: 40 },
      ]);
      // One deal scope (S2-R3): the co-agent now sees the deal, its offers and its viewings.
      await as('agent').get(`/api/v1/deals/${deal.id}`).expect(200);
      expect((await as('agent').get('/api/v1/deals?filter[ownerMembershipId]=' + members['agent2']).expect(200)).body.data.map((d: { id: string }) => d.id)).toContain(deal.id);
      await as('agent').get(`/api/v1/viewings/${viewing.body.id}`).expect(200);

      const reassigned = await as('manager').action(`/api/v1/deals/${deal.id}/reassign`, split.body.version, { ownerMembershipId: members['agent'], note: 'Covering leave' });
      expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
      expect(reassigned.body.owner.id).toBe(members['agent']);
      expect(reassigned.body.assignments.at(-1)).toMatchObject({ from: { id: members['agent2'] }, to: { id: members['agent'] }, assignedBy: { id: members['manager'] }, note: 'Covering leave' });
      const accountant = await as('accountant').post('/api/v1/deals', {});
      expect(accountant.status).toBe(403);
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'metadata']).where('entityId', '=', deal.id).where('action', 'in', ['deal.reassigned', 'deal.agents_changed']).orderBy('entryNo').execute();
      expect(audit.map((a) => a.action)).toEqual(['deal.agents_changed', 'deal.reassigned']);
      expect(JSON.stringify(audit)).not.toContain('Covering leave');
    });

    it('adds and removes parties; the primary contact stays', async () => {
      const buyer = await contact();
      const lawyer = await contact();
      const deal = await create('owner', { dealType: 'sale', primaryContactId: buyer.id });
      const added = await act('owner', deal.id, 'parties', { contactId: lawyer.id, partyRole: 'buyer_lawyer' });
      expect(added.parties.map((p) => p.partyRole)).toEqual(['buyer', 'buyer_lawyer']);
      await act('owner', deal.id, 'parties', { contactId: lawyer.id, partyRole: 'buyer_lawyer' }, 409);
      const primary = await act('owner', deal.id, 'parties/remove', { contactId: buyer.id, partyRole: 'buyer' }, 422);
      expect(primary.errors?.[0]).toMatchObject({ code: 'primary-contact' });
      const removed = await act('owner', deal.id, 'parties/remove', { contactId: lawyer.id, partyRole: 'buyer_lawyer' });
      expect(removed.parties.map((p) => p.partyRole)).toEqual(['buyer']);
      expect(await auditActions(deal.id)).toEqual(['deal.created', 'deal.party_added', 'deal.party_removed']);
    });
  });

  describe('from acceptance to completion', () => {
    it('copies milestones and starts identity checks on acceptance; identity milestones complete themselves (P6-D7)', async () => {
      const buyer = await contact();
      const place = await newListing();
      const { deal } = await offerAccepted(buyer.id, place);
      expect(deal.stage.stageClass).toBe('offer_accepted');
      expect(deal.milestones.map((m) => m.code)).toEqual(['buyer_kyc', 'seller_kyc', 'reservation_deposit', 'title_verified', 'financing_approved', 'contract_signed', 'balance_paid', 'title_transfer', 'keys_handed_over']);
      expect(deal.milestones.filter((m) => m.automatic).map((m) => m.code)).toEqual(['buyer_kyc', 'seller_kyc']);
      expect(deal.milestones.every((m) => m.dueDate !== null && m.completedAt === null)).toBe(true);
      expect(deal.identity).toEqual({ required: true, unverifiedBuyerIds: [buyer.id] });
      const check = await fx.db.selectFrom('kycChecks').select(['status', 'dealId', 'checkType']).where('contactId', '=', buyer.id).executeTakeFirstOrThrow();
      expect(check).toEqual({ status: 'pending', dealId: deal.id, checkType: 'identity' });

      const manual = await act('owner', deal.id, `milestones/${deal.milestones[0]!.id}/complete`, {}, 422);
      expect(manual.errors?.[0]).toMatchObject({ code: 'automatic' });
      await verify(buyer.id);
      const after = await get('owner', deal.id);
      expect(after.milestones[0]).toMatchObject({ code: 'buyer_kyc', completedAt: expect.any(String), notes: expect.stringContaining('Completed automatically') });
      expect(after.identity.unverifiedBuyerIds).toEqual([]);
      expect(after.parties[0]!.identityVerified).toBe(true);
      const audit = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', deal.id).where('action', '=', 'deal.milestone_completed').executeTakeFirstOrThrow();
      expect(audit.metadata).toMatchObject({ code: 'buyer_kyc', automatic: true });
    });

    it('exchanges with verified buyers only, completes with required milestones done, sells the listing and transfers the ownership (P6-D6 to P6-D8)', async () => {
      const buyer = await contact();
      const seller = await contact();
      const place = await newListing();
      await as('owner').post(`/api/v1/properties/${place.propertyId}/ownerships`, { ownerContactId: seller.id, effectiveFrom: '2020-01-01' }).expect(201);
      const { deal, offerId } = await offerAccepted(buyer.id, place);
      expect(deal.access.canExchange).toBe(true);

      const unverified = await act('agent', deal.id, 'exchange', { contractSignedOn: today() }, 422);
      expect(unverified.errors).toEqual([expect.objectContaining({ field: `buyerIdentity.${buyer.id}`, code: 'unverified' })]);
      await act('agent', deal.id, 'exchange', { contractSignedOn: '2999-01-01' }, 422);
      await verify(buyer.id);
      await verify(seller.id);
      const exchanged = await act('agent', deal.id, 'exchange', { contractSignedOn: today(), agencyFee: ghs('13200.00') });
      expect(exchanged).toMatchObject({ stage: { stageClass: 'contract' }, listing: { status: 'under_contract' }, sale: { status: 'exchanged', agreedPrice: { amount: '440000.00' }, contractSignedOn: today() } });
      expect(exchanged.sale!.reference).toMatch(/^SAL-/);
      expect(exchanged.milestones.filter((m) => m.automatic).every((m) => m.completedAt !== null)).toBe(true);

      // P6-D5: the listing follows the deal; it is not withdrawn by hand while contracts are exchanged.
      const listing = (await as('owner').get(`/api/v1/listings/${place.listingId}`).expect(200)).body;
      const withdraw = await as('owner').action(`/api/v1/listings/${place.listingId}/status-transitions`, listing.version, { toStatus: 'withdrawn', reason: 'Seller changed their mind' });
      expect(withdraw.status).toBe(422);
      expect(withdraw.body.errors[0]).toMatchObject({ code: 'listing-sale-exchanged' });

      const early = await act('owner', deal.id, 'complete', { completedOn: today() }, 422);
      expect(early.errors!.map((e) => e.field)).toEqual(['milestones.title_verified', 'milestones.contract_signed', 'milestones.balance_paid', 'milestones.title_transfer', 'milestones.keys_handed_over']);
      for (const code of ['title_verified', 'contract_signed', 'balance_paid', 'title_transfer', 'keys_handed_over']) {
        const current = await get('owner', deal.id);
        const milestone = current.milestones.find((m) => m.code === code)!;
        await as('agent').action(`/api/v1/deals/${deal.id}/milestones/${milestone.id}/complete`, current.version, { notes: `${code} checked` }).expect(200);
      }
      await act('agent', deal.id, 'complete', { completedOn: today() }, 403);
      const won = await act('owner', deal.id, 'complete', { completedOn: today(), titleTransferRef: 'LC/2026/0451' });
      expect(won).toMatchObject({ status: 'won', stage: { stageClass: 'closed_won' }, listing: { status: 'sold' }, sale: { status: 'completed', completedOn: today() }, acceptedOffer: { id: offerId } });
      expect(won.access).toMatchObject({ canEdit: false, canLose: false, nextStages: [] });

      const owners = (await as('owner').get(`/api/v1/properties/${place.propertyId}/ownerships`).expect(200)).body.data as Array<{ owner: { id: string }; current: boolean; effectiveTo: string | null; endReason: string | null }>;
      expect(owners.find((o) => o.owner.id === buyer.id)).toMatchObject({ current: true, effectiveTo: null });
      expect(owners.find((o) => o.owner.id === seller.id)).toMatchObject({ current: false, endReason: `Sold: ${won.sale!.reference}` });
      const actions = await auditActions(deal.id);
      expect(actions).toEqual(expect.arrayContaining(['deal.created', 'deal.stage_changed', 'deal.milestone_completed', 'deal.won']));
      const saleActions = (await fx.db.selectFrom('auditLogs').select('action').where('entityType', '=', 'sale').where('metadata', '@>', JSON.stringify({ dealId: deal.id })).orderBy('entryNo').execute()).map((r) => r.action);
      expect(saleActions).toEqual(['sale.recorded', 'sale.exchanged', 'sale.completed']);
      // A closed deal does not change.
      const closed = await as('owner').patch(`/api/v1/deals/${deal.id}`, won.version, { expectedValue: ghs('1.00') });
      expect(closed.status).toBe(422);
    });

    it('completes without the transfer when asked, and refuses a whole-property record over several units', async () => {
      const buyer = await contact();
      const seller = await contact();
      const place = await newListing();
      await fx.db.insertInto('units').values({ companyId: company.companyId, propertyId: place.propertyId, reference: `UNT-S3-${randomUUID().slice(0, 6)}`, unitLabel: 'Annex' }).execute();
      await as('owner').post(`/api/v1/properties/${place.propertyId}/ownerships`, { ownerContactId: seller.id, effectiveFrom: '2020-01-01' }).expect(201);
      const { deal } = await offerAccepted(buyer.id, place);
      await verify(buyer.id);
      await verify(seller.id);
      await act('owner', deal.id, 'exchange', { contractSignedOn: today() });
      for (const milestone of (await get('owner', deal.id)).milestones.filter((m) => m.isRequired && m.completedAt === null)) {
        await act('owner', deal.id, `milestones/${milestone.id}/complete`);
      }
      const shared = await act('owner', deal.id, 'complete', { completedOn: today() }, 422);
      expect(shared.errors?.[0]).toMatchObject({ field: 'transferOwnership', code: 'ownership-shared' });
      const won = await act('owner', deal.id, 'complete', { completedOn: today(), transferOwnership: false });
      expect(won.status).toBe('won');
      const owners = (await as('owner').get(`/api/v1/properties/${place.propertyId}/ownerships`).expect(200)).body.data as Array<{ owner: { id: string }; current: boolean }>;
      expect(owners).toEqual([expect.objectContaining({ owner: expect.objectContaining({ id: seller.id }), current: true })]);
    });

    it('stops letting deals at "terms agreed" (P6-D2)', async () => {
      const tenant = await contact();
      const place = await newListing('rent');
      const deal = await create('owner', { dealType: 'letting', primaryContactId: tenant.id, listingId: place.listingId });
      const offer = await as('owner').post('/api/v1/offers', { dealId: deal.id, offeredByContactId: tenant.id, amount: ghs('5800.00'), rentFrequency: 'monthly' }).expect(201);
      await as('owner').action(`/api/v1/offers/${offer.body.id}/accept`, offer.body.version).expect(200);
      const agreed = await get('owner', deal.id);
      expect(agreed).toMatchObject({ stage: { stageClass: 'offer_accepted' }, identity: { required: false }, access: { canExchange: false, canComplete: false } });
      expect(agreed.milestones.map((m) => m.code)).toEqual(['references_checked', 'holding_deposit', 'lease_signed', 'advance_received', 'move_in_inspection']);
      const refused = await act('owner', deal.id, 'exchange', { contractSignedOn: today() }, 422);
      expect(refused).toMatchObject({ detail: expect.stringContaining('Phase 7') });
    });
  });

  describe('losing', () => {
    it('loses a deal with an accepted offer: the offer is withdrawn, other open offers too, the listing is available again', async () => {
      const buyer = await contact();
      const place = await newListing();
      const { deal, offerId } = await offerAccepted(buyer.id, place);
      const open = await as('owner').post('/api/v1/offers', { dealId: deal.id, offeredByContactId: buyer.id, amount: ghs('445000.00') });
      expect(open.status, JSON.stringify(open.body)).toBe(201);
      await act('agent', deal.id, 'lose', { lostReasonCode: 'financing_failed' }, 403);
      const unknown = await act('owner', deal.id, 'lose', { lostReasonCode: 'aliens' }, 422);
      expect(unknown.errors?.[0]).toMatchObject({ field: 'lostReasonCode', code: 'unknown-code' });
      const lost = await act('manager', deal.id, 'lose', { lostReasonCode: 'financing_failed', notes: 'Mortgage offer withdrawn by the bank' });
      expect(lost).toMatchObject({ status: 'lost', stage: { stageClass: 'closed_lost' }, lostReasonCode: 'financing_failed', lostNotes: 'Mortgage offer withdrawn by the bank', listing: { status: 'available' }, acceptedOffer: null });
      const offers = await fx.db.selectFrom('offers').select(['id', 'status']).where('dealId', '=', deal.id).orderBy('submittedAt').execute();
      expect(offers).toEqual([{ id: offerId, status: 'withdrawn' }, { id: open.body.id, status: 'withdrawn' }]);
      const audit = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', deal.id).where('action', '=', 'deal.lost').executeTakeFirstOrThrow();
      expect(audit.metadata).toMatchObject({ lostReasonCode: 'financing_failed', fromStageClass: 'offer_accepted', offersWithdrawn: 1 });
      expect(JSON.stringify(audit.metadata)).not.toContain('Mortgage');
      await act('manager', deal.id, 'lose', { lostReasonCode: 'price' }, 422);
    });

    it('a sale falls through after exchange: the sale keeps the reason, the listing returns to available', async () => {
      const buyer = await contact();
      const place = await newListing();
      const { deal } = await offerAccepted(buyer.id, place);
      await verify(buyer.id);
      await act('owner', deal.id, 'exchange', { contractSignedOn: today() });
      const lost = await act('owner', deal.id, 'lose', { lostReasonCode: 'failed_due_diligence', notes: 'Title search found a lien' });
      expect(lost).toMatchObject({ status: 'lost', listing: { status: 'available' }, sale: { status: 'fallen_through', fallenThroughReason: 'Title search found a lien' } });
    });
  });

  describe('board, forecast and stalled deals', () => {
    it('counts open deals per stage with totals per currency; forecasts by expected close month; flags stalled deals', async () => {
      const buyer = await contact();
      const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15)).toISOString().slice(0, 10);
      const thisMonth = new Date().toISOString().slice(0, 7);
      const a = await create('owner', { dealType: 'sale', primaryContactId: buyer.id, ownerMembershipId: members['agent3'], expectedValue: ghs('100000.00'), expectedCloseDate: nextMonth });
      const b = await create('owner', { dealType: 'sale', primaryContactId: buyer.id, ownerMembershipId: members['agent3'], expectedValue: ghs('200000.00') });
      await act('owner', b.id, 'stage', { stageId: b.access.nextStages.find((s) => s.stageClass === 'qualification')!.id });
      await fx.db.updateTable('deals').set({ stageEnteredAt: new Date(Date.now() - 10 * 86_400_000) }).where('id', '=', a.id).execute();

      const board = (await as('owner').get(`/api/v1/deals/pipeline?dealType=sale&ownerMembershipId=${members['agent3']}`).expect(200)).body as { columns: Array<{ stage: { stageClass: string }; count: number; stalledCount: number; totals: Array<{ currency: string; count: number; expectedValue: { amount: string }; weightedValue: { amount: string } }> }> };
      const column = (stageClass: string) => board.columns.find((c) => c.stage.stageClass === stageClass)!;
      expect(board.columns.map((c) => c.stage.stageClass)).toEqual(['lead', 'qualification', 'viewing', 'negotiation', 'offer_accepted', 'contract']);
      expect(column('lead')).toMatchObject({ count: 1, stalledCount: 1, totals: [{ currency: 'GHS', count: 1, expectedValue: { amount: '100000.00' }, weightedValue: { amount: '5000.00' } }] });
      expect(column('qualification')).toMatchObject({ count: 1, stalledCount: 0, totals: [{ weightedValue: { amount: '20000.00' } }] });

      const forecast = (await as('owner').get(`/api/v1/deals/forecast?dealType=sale&from=${thisMonth}&months=3&ownerMembershipId=${members['agent3']}`).expect(200)).body as { months: Array<{ month: string; totals: Array<{ weightedValue: { amount: string } }> }>; undated: Array<{ count: number; weightedValue: { amount: string } }> };
      expect(forecast.months.map((m) => m.month)).toHaveLength(3);
      expect(forecast.months[1]!.totals).toEqual([expect.objectContaining({ weightedValue: { amount: '5000.00', currency: 'GHS' } })]);
      expect(forecast.undated).toEqual([expect.objectContaining({ count: 1, weightedValue: { amount: '20000.00', currency: 'GHS' } })]);

      const stalled = (await as('owner').get(`/api/v1/deals?filter[attention]=stalled&filter[ownerMembershipId]=${members['agent3']}`).expect(200)).body.data as DealBody[];
      expect(stalled.map((d) => d.id)).toEqual([a.id]);
      expect(stalled[0]!.stalled).toBe(true);
      const page = (await as('owner').get(`/api/v1/deals?limit=1&filter[ownerMembershipId]=${members['agent3']}`).expect(200)).body;
      const next = (await as('owner').get(`/api/v1/deals?limit=1&filter[ownerMembershipId]=${members['agent3']}&cursor=${page.page.nextCursor}`).expect(200)).body;
      expect([...page.data, ...next.data].map((d: DealBody) => d.id).sort()).toEqual([a.id, b.id].sort());
      const searched = (await as('owner').get(`/api/v1/deals?q=${encodeURIComponent(a.reference)}`).expect(200)).body.data as DealBody[];
      expect(searched.map((d) => d.id)).toEqual([a.id]);
      await as('owner').get('/api/v1/deals/pipeline').expect(422);
      await as('owner').get('/api/v1/deals/forecast?dealType=sale&months=30').expect(422);
      // Another company's board is empty; the agent sees only their own deals.
      const otherBoard = (await as('otherOwner').get('/api/v1/deals/pipeline?dealType=sale').expect(200)).body as { columns: Array<{ count: number }> };
      expect(otherBoard.columns.every((c) => c.count === 0)).toBe(true);
      const agentBoard = (await as('agent2').get(`/api/v1/deals/pipeline?dealType=sale&ownerMembershipId=${members['agent3']}`).expect(200)).body as { columns: Array<{ count: number }> };
      expect(agentBoard.columns.every((c) => c.count === 0)).toBe(true);
    });
  });

  describe('scope and privacy', () => {
    it('keeps deals to their scope: agents their own, accountants read all and change none, companies apart', async () => {
      const buyer = await contact();
      const deal = await create('owner', { dealType: 'sale', primaryContactId: buyer.id, ownerMembershipId: members['agent'] });
      await as('agent2').get(`/api/v1/deals/${deal.id}`).expect(404);
      expect((await as('agent2').get(`/api/v1/deals?filter[contactId]=${buyer.id}`).expect(200)).body.data).toEqual([]);
      const read = await get('accountant', deal.id);
      expect(read.access).toMatchObject({ canEdit: false, canReassign: false, canLose: false, nextStages: [] });
      await as('accountant').patch(`/api/v1/deals/${deal.id}`, read.version, { probabilityOverride: 1 }).expect(403);
      await as('otherOwner').get(`/api/v1/deals/${deal.id}`).expect(404);
      expect((await as('otherOwner').get('/api/v1/deals').expect(200)).body.data).toEqual([]);
      await as('otherOwner').patch(`/api/v1/deals/${deal.id}`, read.version, { probabilityOverride: 1 }).expect(404);
      await as('owner').get('/api/v1/deals/not-a-uuid').expect(404);
    });

    it('includes the person\'s deals in the access report and keeps the erasure blocked while a deal is open', async () => {
      const buyer = await contact();
      const deal = await create('owner', { dealType: 'sale', primaryContactId: buyer.id });
      const created = await as('owner').post('/api/v1/privacy-requests', { contactId: buyer.id, requestType: 'access', channel: 'email', receivedOn: today() }).expect(201);
      const path = `/api/v1/privacy-requests/${created.body.id}`;
      const verified = await as('owner').action(`${path}/verify-identity`, created.body.version, { method: 'documents_seen', note: 'Passport seen' }).expect(200);
      const working = await as('owner').action(`${path}/status`, verified.body.version, { status: 'in_progress' }).expect(200);
      const generated = await as('owner').action(`${path}/access-report`, working.body.version).expect(200);
      const link = await as('owner').post(`/api/v1/exports/${generated.body.accessReport.exportId}/download`).expect(200);
      const report = (await (await fetch(link.body.url)).json()) as { deals: Record<string, unknown>[] };
      expect(report.deals).toEqual([expect.objectContaining({ reference: deal.reference, dealType: 'sale', status: 'open', roles: ['buyer'] })]);

      const erasure = await as('owner').post('/api/v1/privacy-requests', { contactId: buyer.id, requestType: 'erasure', channel: 'email', receivedOn: today() }).expect(201);
      expect((await as('owner').get(`/api/v1/privacy-requests/${erasure.body.id}`).expect(200)).body.erasureBlockers).toEqual(['open_deal']);
      await act('owner', deal.id, 'lose', { lostReasonCode: 'no_response', notes: 'Stopped answering after the viewing' });
      expect((await as('owner').get(`/api/v1/privacy-requests/${erasure.body.id}`).expect(200)).body.erasureBlockers).toEqual([]);
      await fx.eraseContact(company.companyId, buyer.id);
      const after = await get('owner', deal.id);
      expect(after).toMatchObject({ lostNotes: '[Erased]', lostReasonCode: 'no_response', primaryContact: { name: 'Erased contact' } });
    });
  });

  describe('edge rules', () => {
    it('office scope: a manager sees and manages the deals of their offices, and only reaches members of their offices', async () => {
      const buyer = await contact();
      const deal = await create('owner', { dealType: 'sale', primaryContactId: buyer.id, ownerMembershipId: members['agent'] });
      await as('managerB').get(`/api/v1/deals/${deal.id}`).expect(404);
      expect((await as('managerB').get(`/api/v1/deals?filter[contactId]=${buyer.id}`).expect(200)).body.data).toEqual([]);
      const managed = await get('manager', deal.id);
      expect(managed.access).toMatchObject({ canEdit: true, canReassign: true, canLose: true });
      expect((await as('manager').get(`/api/v1/deals/pipeline?dealType=sale&officeId=${company.officeId}&ownerMembershipId=${members['agent']}`).expect(200)).body.columns[0].count).toBeGreaterThan(0);

      const far = await act('manager', deal.id, 'reassign', { ownerMembershipId: members['agentB'] }, 422);
      expect(far.errors?.[0]).toMatchObject({ field: 'ownerMembershipId', code: 'not-allowed' });
      const nobody = await act('manager', deal.id, 'reassign', { ownerMembershipId: randomUUID() }, 422);
      expect(nobody.errors?.[0]).toMatchObject({ code: 'not-assignable' });
      const same = await act('manager', deal.id, 'reassign', { ownerMembershipId: members['agent'] });
      expect(same.assignments).toHaveLength(1);
      const farAgent = await as('manager').put(`/api/v1/deals/${deal.id}/agents`, same.version, { agents: [{ membershipId: members['agentB'], agentRole: 'co_agent', splitPercent: 100 }] });
      expect(farAgent.status).toBe(422);
      expect(farAgent.body.errors[0]).toMatchObject({ field: 'agents[0].membershipId', code: 'not-allowed' });
      const twice = await as('manager').put(`/api/v1/deals/${deal.id}/agents`, same.version, {
        agents: [
          { membershipId: members['agent'], agentRole: 'lister', splitPercent: 50 },
          { membershipId: members['agent'], agentRole: 'lister', splitPercent: 50 },
        ],
      });
      expect(twice.body.errors.map((e: { code: string }) => e.code)).toContain('duplicate');
      const cleared = await as('manager').put(`/api/v1/deals/${deal.id}/agents`, same.version, { agents: [] });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(cleared.body.agents).toEqual([]);
      // The owner (company scope) may hand the deal to an agent of another office; an office manager outside it may not create there.
      const handed = await act('owner', deal.id, 'reassign', { ownerMembershipId: members['agentB'] });
      expect(handed.owner.id).toBe(members['agentB']);
      const outside = await as('managerB').post('/api/v1/deals', { dealType: 'sale', primaryContactId: buyer.id, officeId: company.officeId });
      expect(outside.status).toBe(422);
    });

    it('checks dates, money and stages on exchange and completion; milestones change until they are done', async () => {
      const buyer = await contact();
      const place = await newListing();
      const fresh = await create('owner', { dealType: 'sale', primaryContactId: buyer.id, listingId: place.listingId });
      expect((await act('owner', fresh.id, 'exchange', { contractSignedOn: today() }, 422)).detail).toContain('accepted');
      expect((await act('owner', fresh.id, 'complete', { completedOn: today() }, 422)).detail).toContain('exchanged');
      const same = await act('owner', fresh.id, 'stage', { stageId: fresh.stage.id });
      expect(same.stageHistory).toHaveLength(1);

      const { deal } = await offerAccepted(buyer.id, place);
      await verify(buyer.id);
      const bad = await act('owner', deal.id, 'exchange', { contractSignedOn: '2026-02-30', completionDueOn: '2026-13-01', agencyFee: { amount: '1.00', currency: 'USD' } }, 422);
      expect(bad.errors!.map((e) => `${e.field}:${e.code}`)).toEqual(['contractSignedOn:invalid', 'completionDueOn:invalid', 'agencyFee.currency:currency-mismatch']);
      const early = await act('owner', deal.id, 'exchange', { contractSignedOn: today(), completionDueOn: '2000-01-01' }, 422);
      expect(early.errors?.[0]).toMatchObject({ field: 'completionDueOn', code: 'before-contract' });

      const milestone = deal.milestones.find((m) => m.code === 'financing_approved')!;
      const current = await get('owner', deal.id);
      const edited = await as('owner').patch(`/api/v1/deals/${deal.id}/milestones/${milestone.id}`, current.version, { dueDate: '2027-02-01', notes: 'Bank valuation booked' });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.milestones.find((m: { code: string }) => m.code === 'financing_approved')).toMatchObject({ dueDate: '2027-02-01', notes: 'Bank valuation booked' });
      await as('owner').patch(`/api/v1/deals/${deal.id}/milestones/${milestone.id}`, edited.body.version, { dueDate: '2027-02-31' }).expect(422);
      const unchanged = await as('owner').patch(`/api/v1/deals/${deal.id}/milestones/${milestone.id}`, edited.body.version, {});
      expect(unchanged.body.version).toBe(edited.body.version);
      await as('owner').action(`/api/v1/deals/${deal.id}/milestones/${milestone.id}/complete`, edited.body.version, {}).expect(200);
      const done = await get('owner', deal.id);
      await as('owner').patch(`/api/v1/deals/${deal.id}/milestones/${milestone.id}`, done.version, { notes: 'Changed' }).expect(422);
      await as('owner').action(`/api/v1/deals/${deal.id}/milestones/${randomUUID()}/complete`, done.version, {}).expect(404);

      await act('owner', deal.id, 'exchange', { contractSignedOn: today() });
      const future = await act('owner', deal.id, 'complete', { completedOn: '2999-01-01' }, 422);
      expect(future.errors?.[0]).toMatchObject({ field: 'completedOn', code: 'future' });
      const before = await act('owner', deal.id, 'complete', { completedOn: '2000-01-01' }, 422);
      expect(before.errors?.[0]).toMatchObject({ field: 'completedOn', code: 'before-contract' });
      const invalid = await act('owner', deal.id, 'complete', { completedOn: '2026-02-30' }, 422);
      expect(invalid.errors?.[0]).toMatchObject({ field: 'completedOn', code: 'invalid' });
    });

    it('filters the list and validates edits and parties', async () => {
      const buyer = await contact();
      const partner = await contact();
      const place = await newListing('rent');
      const deal = await create('owner', { dealType: 'letting', primaryContactId: buyer.id, listingId: place.listingId, expectedCloseDate: '2027-06-15', expectedFee: ghs('6000.00') });
      await act('owner', deal.id, 'parties', { contactId: partner.id, partyRole: 'guarantor' });
      const ids = async (query: string) => ((await as('owner').get(`/api/v1/deals?${query}`).expect(200)).body.data as DealBody[]).map((d) => d.id);
      expect(await ids(`filter[contactId]=${partner.id}`)).toEqual([deal.id]);
      expect(await ids(`filter[listingId]=${place.listingId}&filter[dealType]=letting&filter[stageClass]=lead`)).toEqual([deal.id]);
      expect(await ids(`filter[listingId]=${place.listingId}&filter[expectedCloseDate][gte]=2027-06-01&filter[expectedCloseDate][lte]=2027-06-30`)).toEqual([deal.id]);
      expect(await ids(`filter[listingId]=${place.listingId}&filter[expectedCloseDate][gte]=2027-07-01`)).toEqual([]);
      expect(await ids(`filter[listingId]=${place.listingId}&filter[status]=lost`)).toEqual([]);
      expect(await ids(`filter[officeId]=${company.officeId}&filter[contactId]=${buyer.id}&sort=-createdAt`)).toEqual([deal.id]);
      await as('owner').get('/api/v1/deals?filter[ownerMembershipId]=someone').expect(422);
      await as('owner').get('/api/v1/deals/pipeline?dealType=sale&officeId=nope').expect(422);
      await as('owner').get('/api/v1/deals/forecast?dealType=sale&from=2026-13').expect(422);

      const badDate = await as('owner').patch(`/api/v1/deals/${deal.id}`, (await get('owner', deal.id)).version, { expectedCloseDate: '2027-02-30' });
      expect(badDate.body.errors[0]).toMatchObject({ field: 'expectedCloseDate', code: 'invalid' });
      const usd = await newListing('rent');
      await fx.db.updateTable('listings').set({ currencyCode: 'USD' }).where('id', '=', usd.listingId).execute();
      const mismatch = await as('owner').patch(`/api/v1/deals/${deal.id}`, (await get('owner', deal.id)).version, { listingId: usd.listingId });
      expect(mismatch.body.errors[0]).toMatchObject({ field: 'listingId', code: 'currency-mismatch' });
      const detached = await as('owner').patch(`/api/v1/deals/${deal.id}`, (await get('owner', deal.id)).version, { listingId: null, expectedFee: null, expectedCloseDate: null });
      expect(detached.body).toMatchObject({ listing: null, expectedFee: null, expectedCloseDate: null });

      await act('owner', deal.id, 'parties/remove', { contactId: partner.id, partyRole: 'buyer' }, 404);
      const archived = await contact();
      await fx.db.updateTable('contacts').set({ archivedAt: new Date(), archivedReason: 'Moved away' }).where('id', '=', archived.id).execute();
      const inactive = await act('owner', deal.id, 'parties', { contactId: archived.id, partyRole: 'guarantor' }, 422);
      expect(inactive.errors?.[0]).toMatchObject({ field: 'contactId', code: 'not-active' });
      // Losing a deal with no offers changes nothing else.
      const lost = await act('owner', deal.id, 'lose', { lostReasonCode: 'requirements_changed' });
      expect(lost).toMatchObject({ status: 'lost', lostNotes: null, access: { canEdit: false } });
      expect(await ids(`filter[contactId]=${partner.id}&filter[status]=lost`)).toEqual([deal.id]);
    });
  });
});
