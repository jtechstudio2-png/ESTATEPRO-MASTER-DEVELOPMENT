import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let counter = 0;
const nextPhone = () => `024${String(7500000 + counter++).padStart(7, '0')}`;
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const ghs = (amount: string) => ({ amount, currency: 'GHS' });

/**
 * S2 offers (readiness report §4.2, P6-D4, P6-D5): recording on open deals,
 * terms and offeror checks, counter-offer chains, acceptance by owners and
 * sales managers only with the deal and listing effects, the listing status
 * rule, withdrawal (open and accepted), rejection, expiry by the worker,
 * scope, tenant isolation, timeline, audit, outbox and the access report.
 */
describe('S2: offers', () => {
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
    };
  };

  async function contact(who = 'owner', name = `Party ${randomUUID().slice(0, 6)}`) {
    const res = await as(who).post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function newListing(listingType: 'sale' | 'rent' = 'sale') {
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: `Offer Villa ${counter}`,
        propertyTypeId: typeId,
        officeId: company.officeId,
        address: { countryCode: 'GH', addressLine1: `${counter++} Offer Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
        createWholePropertyUnit: true,
      })
      .expect(201);
    const unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    const listing = await fx.listing(company.companyId, unitId, members['agent']!, company.officeId);
    if (listingType === 'rent') await fx.db.updateTable('listings').set({ listingType: 'rent', rentFrequency: 'monthly' }).where('id', '=', listing.id).execute();
    return { listingId: listing.id, unitId };
  }

  async function deal(options: { buyer: string; seller?: string; code?: string; owner?: string; dealType?: 'sale' | 'letting'; place?: { listingId: string; unitId: string } | null }) {
    const place = options.place === undefined ? await newListing(options.dealType === 'letting' ? 'rent' : 'sale') : options.place;
    const code = options.code ?? 'qualification';
    const dealType = options.dealType ?? 'sale';
    const row = await fx.db
      .insertInto('deals')
      .values({
        companyId: company.companyId,
        reference: `DEA-S2-${randomUUID().slice(0, 8)}`,
        dealType,
        stageId: (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', dealType).where('code', '=', code).executeTakeFirstOrThrow()).id,
        stageClass: code,
        primaryContactId: options.buyer,
        officeId: company.officeId,
        ownerMembershipId: options.owner ?? members['agent']!,
        currencyCode: 'GHS',
        listingId: place?.listingId ?? null,
        unitId: place?.unitId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (options.seller) await fx.db.insertInto('dealParties').values({ companyId: company.companyId, dealId: row.id, contactId: options.seller, partyRole: 'seller' }).execute();
    return { dealId: row.id, listingId: place?.listingId ?? null, unitId: place?.unitId ?? null };
  }

  async function record(who: string, body: Record<string, unknown>, expected = 201) {
    const res = await as(who).post('/api/v1/offers', body);
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return res.body as OfferBody;
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const agent2 = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const manager = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    const accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    Object.assign(members, { owner: company.ownerMembershipId, agent: agent.membershipId, agent2: agent2.membershipId, manager: manager.membershipId });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['agent2', agent2.userId, company.companyId],
      ['manager', manager.userId, company.companyId],
      ['accountant', accountant.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `s2-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `s2-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('recording', () => {
    it('records a buyer\'s offer: the deal moves to negotiation; timeline, audit and outbox record it', async () => {
      const buyer = await contact();
      const d = await deal({ buyer: buyer.id, code: 'viewing' });
      const offer = await record('agent', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('420000.00'), conditions: 'Subject to survey', financingCode: 'mortgage', expiresAt: inHours(48) });
      expect(offer).toMatchObject({
        status: 'submitted',
        direction: 'from_buyer',
        amount: { amount: '420000.00', currency: 'GHS' },
        conditions: 'Subject to survey',
        financingCode: 'mortgage',
        deal: { id: d.dealId },
        listing: { id: d.listingId, status: 'available' },
        offeredBy: { id: buyer.id },
        parentOfferId: null,
        otherOfferAccepted: false,
        canManage: true,
        canAccept: false,
      });
      const stage = await fx.db.selectFrom('deals').select('stageClass').where('id', '=', d.dealId).executeTakeFirstOrThrow();
      expect(stage.stageClass).toBe('negotiation');
      const note = await fx.db.selectFrom('dealStageHistory').select('note').where('dealId', '=', d.dealId).orderBy('entryNo', 'desc').executeTakeFirstOrThrow();
      expect(note.note).toBe('Offer recorded');
      const timeline = await as('owner').get(`/api/v1/contacts/${buyer.id}/activities`).expect(200);
      expect(timeline.body.data.map((a: { subject: string }) => a.subject).join('\n')).toContain('Offer recorded:');
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'metadata']).where('entityId', '=', offer.id).execute();
      expect(audit).toEqual([expect.objectContaining({ action: 'offer.submitted' })]);
      expect(JSON.stringify(audit)).not.toContain('Subject to survey');
      const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', offer.id).execute();
      expect(events.map((e) => e.eventType)).toEqual(['offer.submitted']);
    });

    it('refuses offers that break the rules, with a field and a code for each', async () => {
      const buyer = await contact();
      const stranger = await contact();
      const d = await deal({ buyer: buyer.id });
      const errors = async (body: Record<string, unknown>, who = 'owner') => {
        const res = await as(who).post('/api/v1/offers', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('400000.00'), ...body });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        return (res.body.errors as { field: string; code: string }[]).map((e) => `${e.field}:${e.code}`);
      };
      expect(await errors({ amount: { amount: '400000.00', currency: 'USD' } })).toContain('amount.currency:currency-mismatch');
      expect(await errors({ amount: ghs('400000.001') })).toContain('amount.amount:precision');
      expect(await errors({ rentFrequency: 'monthly' })).toContain('rentFrequency:not-applicable');
      expect(await errors({ financingCode: 'crypto' })).toContain('financingCode:unknown-code');
      expect(await errors({ expiresAt: inHours(-1) })).toContain('expiresAt:in-past');
      expect(await errors({ offeredByContactId: stranger.id })).toContain('offeredByContactId:not-buyer-side');
      expect(await errors({ offeredByContactId: stranger.id, direction: 'from_seller' })).toContain('offeredByContactId:not-seller-side');
      expect(await errors({ dealId: randomUUID() })).toContain('dealId:not-found');
      const bare = await deal({ buyer: buyer.id, place: null });
      expect(await errors({ dealId: bare.dealId })).toContain('dealId:deal-without-listing');
      const letting = await deal({ buyer: buyer.id, dealType: 'letting' });
      expect(await errors({ dealId: letting.dealId })).toContain('rentFrequency:required');
      const rent = await record('owner', { dealId: letting.dealId, offeredByContactId: buyer.id, amount: ghs('6500.00'), rentFrequency: 'monthly' });
      expect(rent.rentFrequency).toBe('monthly');
    });
  });

  describe('negotiation', () => {
    it('counters from the other side, keeping the chain; only open offers are countered', async () => {
      const buyer = await contact();
      const seller = await contact();
      const d = await deal({ buyer: buyer.id, seller: seller.id, code: 'negotiation' });
      const first = await record('agent', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('400000.00') });
      const wrongSide = await as('agent').action(`/api/v1/offers/${first.id}/counter`, first.version, { offeredByContactId: buyer.id, amount: ghs('450000.00') });
      expect(wrongSide.status).toBe(422);
      expect(wrongSide.body.errors[0]).toMatchObject({ code: 'not-seller-side' });
      const countered = await as('agent').action(`/api/v1/offers/${first.id}/counter`, first.version, { offeredByContactId: seller.id, amount: ghs('450000.00'), conditions: 'Completion within 60 days' });
      expect(countered.status, JSON.stringify(countered.body)).toBe(201);
      expect(countered.body).toMatchObject({ direction: 'from_seller', parentOfferId: first.id, status: 'submitted' });
      const parent = await as('agent').get(`/api/v1/offers/${first.id}`).expect(200);
      expect(parent.body).toMatchObject({ status: 'countered', counterOfferIds: [countered.body.id], canManage: false });
      expect((await as('agent').action(`/api/v1/offers/${first.id}/counter`, parent.body.version, { offeredByContactId: seller.id, amount: ghs('440000.00') })).status).toBe(422);
      const chain = await as('agent').get(`/api/v1/offers?filter[dealId]=${d.dealId}&sort=submittedAt`).expect(200);
      expect(chain.body.data.map((o: { id: string }) => o.id)).toEqual([first.id, countered.body.id]);
    });

    it('accepts only with offer.accept: the deal reaches "offer accepted", the listing is reserved; another open offer stays and is flagged', async () => {
      const buyer = await contact();
      const rival = await contact();
      const d = await deal({ buyer: buyer.id, code: 'negotiation' });
      const rivalDeal = await deal({ buyer: rival.id, code: 'negotiation', place: { listingId: d.listingId!, unitId: d.unitId! } });
      const offer = await record('agent', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('500000.00') });
      const rivalOffer = await record('agent', { dealId: rivalDeal.dealId, offeredByContactId: rival.id, amount: ghs('495000.00') });
      await as('agent').action(`/api/v1/offers/${offer.id}/accept`, offer.version).expect(403);
      await as('owner').action(`/api/v1/offers/${offer.id}/accept`, offer.version + 3).expect(412);
      const accepted = await as('manager').action(`/api/v1/offers/${offer.id}/accept`, offer.version).expect(200);
      expect(accepted.body).toMatchObject({ status: 'accepted', listing: { status: 'reserved' }, canAccept: false });
      expect((await fx.db.selectFrom('deals').select('stageClass').where('id', '=', d.dealId).executeTakeFirstOrThrow()).stageClass).toBe('offer_accepted');
      const history = await as('owner').get(`/api/v1/listings/${d.listingId}/status-history?limit=100`).expect(200);
      expect(history.body.data.at(-1)).toMatchObject({ fromStatus: 'available', toStatus: 'reserved', reason: 'Offer accepted' });

      const stillOpen = await as('owner').get(`/api/v1/offers/${rivalOffer.id}`).expect(200);
      expect(stillOpen.body).toMatchObject({ status: 'submitted', otherOfferAccepted: true });
      const clash = await as('owner').action(`/api/v1/offers/${rivalOffer.id}/accept`, stillOpen.body.version);
      expect(clash.status).toBe(409);
      expect(clash.body.conflictingResource).toEqual({ type: 'offer', id: offer.id });
    });

    it('keeps the listing\'s status with the deal (P6-D5); withdrawing the listing withdraws the accepted offer', async () => {
      const buyer = await contact();
      const d = await deal({ buyer: buyer.id, code: 'negotiation' });
      const offer = await record('owner', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('600000.00') });
      await as('owner').action(`/api/v1/offers/${offer.id}/accept`, offer.version).expect(200);
      const listing = await as('owner').get(`/api/v1/listings/${d.listingId}`).expect(200);
      const manual = await as('owner').action(`/api/v1/listings/${d.listingId}/status-transitions`, listing.body.version, { toStatus: 'available', reason: 'Buyer went quiet' });
      expect(manual.status).toBe(422);
      expect(manual.body.errors[0]).toMatchObject({ code: 'listing-has-accepted-offer' });
      const withdrawn = await as('owner').action(`/api/v1/listings/${d.listingId}/status-transitions`, listing.body.version, { toStatus: 'withdrawn', reason: 'Owner took it off the market' }).expect(200);
      expect(withdrawn.body.status).toBe('withdrawn');
      const after = await as('owner').get(`/api/v1/offers/${offer.id}`).expect(200);
      expect(after.body.status).toBe('withdrawn');
      expect((await fx.db.selectFrom('deals').select('stageClass').where('id', '=', d.dealId).executeTakeFirstOrThrow()).stageClass).toBe('negotiation');
    });

    it('withdraws an accepted offer only with a reason: the deal returns to negotiation and the listing to available', async () => {
      const buyer = await contact();
      const d = await deal({ buyer: buyer.id, code: 'negotiation' });
      const offer = await record('owner', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('610000.00') });
      const accepted = await as('owner').action(`/api/v1/offers/${offer.id}/accept`, offer.version).expect(200);
      expect((await as('agent').action(`/api/v1/offers/${offer.id}/withdraw`, accepted.body.version, {})).status).toBe(422);
      const back = await as('agent').action(`/api/v1/offers/${offer.id}/withdraw`, accepted.body.version, { reason: 'Mortgage refused' }).expect(200);
      expect(back.body).toMatchObject({ status: 'withdrawn', listing: { status: 'available' } });
      expect((await fx.db.selectFrom('deals').select('stageClass').where('id', '=', d.dealId).executeTakeFirstOrThrow()).stageClass).toBe('negotiation');
      const timeline = await as('owner').get(`/api/v1/contacts/${buyer.id}/activities`).expect(200);
      expect(timeline.body.data).toContainEqual(expect.objectContaining({ subject: expect.stringContaining('Accepted offer withdrawn'), body: 'Mortgage refused' }));
      const audit = await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', offer.id).orderBy('entryNo').execute();
      expect(audit.map((a) => a.action)).toEqual(['offer.submitted', 'offer.accepted', 'offer.withdrawn']);
      expect(JSON.stringify(await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', offer.id).execute())).not.toContain('Mortgage refused');
    });

    it('rejects and withdraws open offers; finished offers do not change', async () => {
      const buyer = await contact();
      const d = await deal({ buyer: buyer.id, code: 'negotiation' });
      const low = await record('agent', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('300000.00') });
      const rejected = await as('agent').action(`/api/v1/offers/${low.id}/reject`, low.version, { reason: 'Too low for the seller' }).expect(200);
      expect(rejected.body.status).toBe('rejected');
      expect((await as('agent').action(`/api/v1/offers/${low.id}/withdraw`, rejected.body.version, {})).status).toBe(422);
      expect((await as('agent').action(`/api/v1/offers/${low.id}/reject`, rejected.body.version, {})).status).toBe(422);
      expect((await as('owner').action(`/api/v1/offers/${low.id}/accept`, rejected.body.version)).status).toBe(422);
      const next = await record('agent', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('320000.00') });
      const gone = await as('agent').action(`/api/v1/offers/${next.id}/withdraw`, next.version, {}).expect(200);
      expect(gone.body.status).toBe('withdrawn');
    });

    it('expires open offers past their expiry time (worker job)', async () => {
      const buyer = await contact();
      const d = await deal({ buyer: buyer.id, code: 'negotiation' });
      const offer = await record('owner', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('350000.00'), expiresAt: inHours(1) });
      // Terms never change (the expiry included), so the worker runs with a clock two hours ahead.
      const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const { worker, close } = createWorker(t.config, silent, { scheduleEveryMs: 0, now: () => new Date(Date.now() + 2 * 3_600_000) });
      try {
        await worker.runOnce();
      } finally {
        await close();
      }
      const after = await as('owner').get(`/api/v1/offers/${offer.id}`).expect(200);
      expect(after.body.status).toBe('expired');
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'actorType']).where('entityId', '=', offer.id).orderBy('entryNo').execute();
      expect(audit.at(-1)).toEqual({ action: 'offer.expired', actorType: 'system' });
    });
  });

  describe('remaining rules', () => {
    it('lets a current owner counter, the buyer counter back, and refuses closed deals, zero amounts and unknown contacts', async () => {
      const buyer = await contact();
      const owner = await contact();
      const d = await deal({ buyer: buyer.id, code: 'negotiation' });
      const propertyId = (await fx.db.selectFrom('units').select('propertyId').where('id', '=', d.unitId!).executeTakeFirstOrThrow()).propertyId;
      await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId, unitId: d.unitId, ownerContactId: owner.id, effectiveFrom: '2020-01-01' }).execute();
      const first = await record('owner', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('400000.00') });
      const fromOwner = await as('owner').action(`/api/v1/offers/${first.id}/counter`, first.version, { offeredByContactId: owner.id, amount: ghs('460000.00') });
      expect(fromOwner.status, JSON.stringify(fromOwner.body)).toBe(201);
      const back = await as('owner').action(`/api/v1/offers/${fromOwner.body.id}/counter`, fromOwner.body.version, { offeredByContactId: buyer.id, amount: ghs('430000.00') });
      expect(back.status, JSON.stringify(back.body)).toBe(201);
      expect(back.body).toMatchObject({ direction: 'from_buyer', parentOfferId: fromOwner.body.id });

      const errors = async (body: Record<string, unknown>) => {
        const res = await as('owner').post('/api/v1/offers', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('1.00'), ...body });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        return (res.body.errors as { field: string; code: string }[]).map((e) => `${e.field}:${e.code}`);
      };
      expect(await errors({ amount: ghs('0') })).toContain('amount.amount:positive');
      expect(await errors({ offeredByContactId: randomUUID() })).toContain('offeredByContactId:not-found');
      const lost = await deal({ buyer: buyer.id, code: 'negotiation' });
      await fx.db
        .updateTable('deals')
        .set({ stageId: (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', 'sale').where('code', '=', 'closed_lost').executeTakeFirstOrThrow()).id, closedAt: new Date(), lostReasonCode: 'price' })
        .where('id', '=', lost.dealId)
        .execute();
      expect(await errors({ dealId: lost.dealId })).toContain('dealId:deal-closed');
    });

    it('refuses to accept on a listing that is off the market; lists a listing\'s offers page by page; links the deal\'s lead on the timeline', async () => {
      const buyer = await contact();
      const lead = await as('owner').post('/api/v1/leads', { contactId: buyer.id, leadType: 'buy', sourceCode: 'phone' }).expect(201);
      const d = await deal({ buyer: buyer.id, code: 'negotiation' });
      await fx.db.updateTable('deals').set({ leadId: lead.body.id }).where('id', '=', d.dealId).execute();
      const ids: string[] = [];
      for (const amount of ['400000.00', '401000.00', '402000.00']) ids.push((await record('owner', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs(amount) })).id);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { data: { id: string }[]; page: { nextCursor: string | null } } } = await as('owner')
          .get(`/api/v1/offers?limit=2&filter[listingId]=${d.listingId}${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        seen.push(...page.body.data.map((o) => o.id));
        cursor = page.body.page.nextCursor;
      } while (cursor);
      expect(seen).toEqual([...ids].reverse());
      const leadTimeline = await as('owner').get(`/api/v1/leads/${lead.body.id}/activities`).expect(200);
      expect(leadTimeline.body.data.map((a: { subject: string }) => a.subject).join('\n')).toContain('Offer recorded:');

      const listing = await as('owner').get(`/api/v1/listings/${d.listingId}`).expect(200);
      await as('owner').action(`/api/v1/listings/${d.listingId}/status-transitions`, listing.body.version, { toStatus: 'withdrawn', reason: 'Seller changed their mind' }).expect(200);
      const offer = await as('owner').get(`/api/v1/offers/${ids[0]}`).expect(200);
      const refused = await as('owner').action(`/api/v1/offers/${ids[0]}/accept`, offer.body.version);
      expect(refused.status).toBe(422);
      expect(refused.body.errors[0]).toMatchObject({ code: 'listing-not-available' });
    });
  });

  describe('scope and privacy', () => {
    it('shows agents the offers on their deals only; accountants read all and change none; companies stay apart', async () => {
      const buyer = await contact();
      const theirs = await deal({ buyer: buyer.id, code: 'negotiation', owner: members['agent2'] });
      const offer = await record('owner', { dealId: theirs.dealId, offeredByContactId: buyer.id, amount: ghs('410000.00') });
      await as('agent').get(`/api/v1/offers/${offer.id}`).expect(404);
      const list = await as('agent').get(`/api/v1/offers?filter[dealId]=${theirs.dealId}`).expect(200);
      expect(list.body.data).toEqual([]);
      const forbidden = await as('agent').post('/api/v1/offers', { dealId: theirs.dealId, offeredByContactId: buyer.id, amount: ghs('1.00') });
      expect(forbidden.status).toBe(422);
      expect(forbidden.body.errors[0]).toMatchObject({ field: 'dealId', code: 'not-found' });
      // A co-agent on the deal sees it.
      await fx.db.insertInto('dealAgents').values({ companyId: company.companyId, dealId: theirs.dealId, membershipId: members['agent']!, agentRole: 'co_agent', splitPercent: '0' }).execute();
      await as('agent').get(`/api/v1/offers/${offer.id}`).expect(200);

      const read = await as('accountant').get(`/api/v1/offers/${offer.id}`).expect(200);
      expect(read.body).toMatchObject({ canManage: false, canAccept: false });
      await as('accountant').action(`/api/v1/offers/${offer.id}/reject`, read.body.version, {}).expect(403);

      await as('otherOwner').get(`/api/v1/offers/${offer.id}`).expect(404);
      expect((await as('otherOwner').get('/api/v1/offers').expect(200)).body.data).toEqual([]);
      await as('otherOwner').action(`/api/v1/offers/${offer.id}/accept`, read.body.version).expect(404);
    });

    it('lists a contact\'s offers, includes them in the access report, and erases their conditions with them', async () => {
      const buyer = await contact();
      const d = await deal({ buyer: buyer.id, code: 'negotiation' });
      const offer = await record('owner', { dealId: d.dealId, offeredByContactId: buyer.id, amount: ghs('455000.00'), conditions: 'Needs to sell her flat in Tema first' });
      const byContact = await as('owner').get(`/api/v1/offers?filter[contactId]=${buyer.id}&filter[status]=submitted`).expect(200);
      expect(byContact.body.data.map((o: { id: string }) => o.id)).toEqual([offer.id]);

      const created = await as('owner').post('/api/v1/privacy-requests', { contactId: buyer.id, requestType: 'access', channel: 'email', receivedOn: new Date().toISOString().slice(0, 10) }).expect(201);
      const path = `/api/v1/privacy-requests/${created.body.id}`;
      const verified = await as('owner').action(`${path}/verify-identity`, created.body.version, { method: 'documents_seen', note: 'Passport seen' }).expect(200);
      const working = await as('owner').action(`${path}/status`, verified.body.version, { status: 'in_progress' }).expect(200);
      const generated = await as('owner').action(`${path}/access-report`, working.body.version).expect(200);
      const link = await as('owner').post(`/api/v1/exports/${generated.body.accessReport.exportId}/download`).expect(200);
      const report = (await (await fetch(link.body.url)).json()) as { offers: Record<string, unknown>[] };
      expect(report.offers).toEqual([expect.objectContaining({ amount: '455000.0000', currency: 'GHS', status: 'submitted', conditions: 'Needs to sell her flat in Tema first' })]);

      // Erasure needs the deal closed first (open_deal blocker); then the conditions go and the amount stays.
      await fx.db.updateTable('offers').set({ status: 'withdrawn', respondedAt: new Date() }).where('id', '=', offer.id).execute();
      await fx.db
        .updateTable('deals')
        .set({ stageId: (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', 'sale').where('code', '=', 'closed_lost').executeTakeFirstOrThrow()).id, closedAt: new Date(), lostReasonCode: 'price' })
        .where('id', '=', d.dealId)
        .execute();
      await fx.eraseContact(company.companyId, buyer.id);
      const after = await as('owner').get(`/api/v1/offers/${offer.id}`).expect(200);
      expect(after.body).toMatchObject({ conditions: '[Erased]', amount: { amount: '455000.00' }, offeredBy: { name: 'Erased contact' } });
    });
  });
});

interface OfferBody {
  id: string;
  version: number;
  status: string;
  rentFrequency: string | null;
}
