import { randomUUID } from 'node:crypto';

import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DB } from '../src/database/schema.js';
import { ErasureLedger } from '../src/privacy/erasure-ledger.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let counter = 0;
const nextPhone = () => `024${String(7300000 + counter++).padStart(7, '0')}`;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * P6-0 (readiness and governance for the sales pipeline):
 * #15 deterministic history order through the API, history cursors, the
 * erasure blockers for active deals and recorded sales, erasure of the
 * pipeline's free text through the data-subject request register, and the
 * accountant's read access.
 */
describe('P6-0: history order (#15) and sales-record protection', () => {
  let t: TestApp;
  let fx: Fixtures;
  let ledger: ErasureLedger;
  let company: Company;
  let other: Company;
  const tokens: Record<string, string> = {};
  let listingId: string;
  let unitId: string;
  let propertyId: string;

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

  /** Runs statements in one database transaction, so every row shares now(). */
  async function oneTransaction(work: (tx: Transaction<DB>) => Promise<void>) {
    await fx.db.transaction().execute(work);
  }

  async function contact(name = `P6 ${randomUUID().slice(0, 6)}`) {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function stageId(dealType: 'sale' | 'letting', code: string) {
    return (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', dealType).where('code', '=', code).executeTakeFirstOrThrow()).id;
  }

  async function deal(primaryContactId: string, code = 'negotiation') {
    const row = await fx.db
      .insertInto('deals')
      .values({
        companyId: company.companyId,
        reference: `DEA-P6-${randomUUID().slice(0, 8)}`,
        dealType: 'sale',
        stageId: await stageId('sale', code),
        stageClass: code,
        primaryContactId,
        officeId: company.officeId,
        ownerMembershipId: company.ownerMembershipId,
        currencyCode: 'GHS',
        listingId,
        unitId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ledger = ErasureLedger.fromConfig(t.config);
    company = await fx.company();
    other = await fx.company();
    const accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['accountant', accountant.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `p60-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `p60-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name: 'Ridge Villa',
        propertyTypeId: typeId,
        officeId: company.officeId,
        address: { countryCode: 'GH', addressLine1: '7 Ridge Road', locality: 'Accra', adminArea1: 'Greater Accra' },
        createWholePropertyUnit: true,
      })
      .expect(201);
    propertyId = property.body.id;
    unitId = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', propertyId).executeTakeFirstOrThrow()).id;
    const listing = await as('owner')
      .post('/api/v1/listings', { unitId, listingType: 'sale', price: { amount: '900000.00', currency: 'GHS' }, title: 'Ridge Villa', priceQualifierCode: 'negotiable', mandateTypeCode: 'sole_agency' })
      .expect(201);
    listingId = listing.body.id;
  });

  afterAll(async () => {
    ledger.destroy();
    await fx.close();
    await t.close();
  });

  describe('deterministic history order (#15)', () => {
    it('reads listing status changes written in one transaction in the order they were written, page by page', async () => {
      await oneTransaction(async (tx) => {
        for (const reason of ['one', 'two', 'three', 'four']) {
          await tx.insertInto('listingStatusHistory').values({ companyId: company.companyId, listingId, fromStatus: 'available', toStatus: 'available', reason }).execute();
        }
      });
      const all = await as('owner').get(`/api/v1/listings/${listingId}/status-history?limit=100`).expect(200);
      const tied = all.body.data.filter((row: { reason: string }) => ['one', 'two', 'three', 'four'].includes(row.reason));
      expect(tied.map((row: { reason: string }) => row.reason)).toEqual(['one', 'two', 'three', 'four']);
      expect(new Set(tied.map((row: { changedAt: string }) => row.changedAt)).size).toBe(1);

      // One row per page across the tie: nothing skipped, nothing repeated, same order.
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { data: Array<{ reason: string | null }>; page: { nextCursor: string | null } } } = await as('owner').get(`/api/v1/listings/${listingId}/status-history?limit=1${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
        seen.push(...page.body.data.map((row) => row.reason ?? '-'));
        cursor = page.body.page.nextCursor;
      } while (cursor);
      expect(seen.filter((reason) => ['one', 'two', 'three', 'four'].includes(reason))).toEqual(['one', 'two', 'three', 'four']);
      expect(seen).toHaveLength(all.body.data.length);

      const backwards = await as('owner').get(`/api/v1/listings/${listingId}/status-history?limit=100&sort=-changedAt`).expect(200);
      expect(backwards.body.data.filter((row: { reason: string }) => ['one', 'two', 'three', 'four'].includes(row.reason)).map((row: { reason: string }) => row.reason)).toEqual([
        'four', 'three', 'two', 'one',
      ]);
    });

    it('refuses a cursor issued before #15 and asks for the first page', async () => {
      const old = Buffer.from(JSON.stringify({ v: new Date().toISOString(), id: randomUUID() })).toString('base64url');
      const res = await as('owner').get(`/api/v1/listings/${listingId}/status-history?cursor=${old}`).expect(422);
      expect(res.body.errors[0]).toMatchObject({ field: 'cursor', code: 'invalid' });
      expect(res.body.errors[0].message).toContain('first page');
      // Record lists keep their id cursors.
      await as('owner').get(`/api/v1/listings?cursor=${old}`).expect(200);
    });

    it('orders audit trails, lead history and consents by insertion when times tie', async () => {
      await oneTransaction(async (tx) => {
        for (const action of ['p6.first', 'p6.second', 'p6.third']) {
          await tx
            .insertInto('auditLogs')
            .values({ companyId: company.companyId, actorType: 'system', action, entityType: 'property', entityId: propertyId })
            .execute();
        }
      });
      const activity = await as('owner').get(`/api/v1/properties/${propertyId}/history?limit=100`).expect(200);
      expect(activity.body.data.map((row: { action: string }) => row.action).filter((action: string) => action.startsWith('p6.'))).toEqual(['p6.third', 'p6.second', 'p6.first']);
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { data: Array<{ action: string }>; page: { nextCursor: string | null } } } = await as('owner').get(`/api/v1/properties/${propertyId}/history?limit=1${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
        paged.push(...page.body.data.map((row) => row.action));
        cursor = page.body.page.nextCursor;
      } while (cursor);
      expect(paged.filter((action) => action.startsWith('p6.'))).toEqual(['p6.third', 'p6.second', 'p6.first']);

      const person = await contact();
      const lead = await fx.db
        .insertInto('leads')
        .values({ companyId: company.companyId, reference: `LEA-P6-${randomUUID().slice(0, 8)}`, contactId: person.id, leadType: 'buy', sourceCode: 'website' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await oneTransaction(async (tx) => {
        for (const [from, to] of [['new', 'contacted'], ['contacted', 'qualified'], ['qualified', 'contacted']] as const) {
          await tx.insertInto('leadStatusHistory').values({ companyId: company.companyId, leadId: lead.id, fromStatus: from, toStatus: to }).execute();
        }
      });
      const record = await as('owner').get(`/api/v1/leads/${lead.id}`).expect(200);
      expect(record.body.statusHistory.map((row: { toStatus: string }) => row.toStatus)).toEqual(['contacted', 'qualified', 'contacted']);

      await oneTransaction(async (tx) => {
        await tx.insertInto('consents').values({ companyId: company.companyId, contactId: person.id, purpose: 'marketing', channel: 'sms', status: 'granted', capturedVia: 'web_form' }).execute();
        await tx.insertInto('consents').values({ companyId: company.companyId, contactId: person.id, purpose: 'marketing', channel: 'sms', status: 'withdrawn', capturedVia: 'portal' }).execute();
      });
      const shown = await as('owner').get(`/api/v1/contacts/${person.id}`).expect(200);
      expect(shown.body.consents.find((row: { purpose: string; channel: string }) => row.purpose === 'marketing' && row.channel === 'sms')).toMatchObject({ status: 'withdrawn' });
      const history = await as('owner').get(`/api/v1/contacts/${person.id}/consents`).expect(200);
      expect(history.body.data.filter((row: { channel: string }) => row.channel === 'sms').map((row: { status: string }) => row.status)).toEqual(['withdrawn', 'granted']);
    });

    it('writes deal stage history in the database, in order, for every stage change', async () => {
      const buyer = await contact();
      const id = await deal(buyer.id, 'lead');
      await oneTransaction(async (tx) => {
        for (const code of ['qualification', 'viewing', 'negotiation']) {
          await tx.updateTable('deals').set({ stageId: await stageId('sale', code) }).where('id', '=', id).execute();
        }
      });
      const rows = await fx.db
        .selectFrom('dealStageHistory as h')
        .innerJoin('pipelineStages as s', 's.id', 'h.toStageId')
        .select('s.code')
        .where('h.dealId', '=', id)
        .orderBy('h.changedAt')
        .orderBy('h.entryNo')
        .execute();
      expect(rows.map((row) => row.code)).toEqual(['lead', 'qualification', 'viewing', 'negotiation']);
    });
  });

  describe('sales records and erasure', () => {
    async function erasureRequest(contactId: string) {
      const created = await as('owner').post('/api/v1/privacy-requests', { contactId, requestType: 'erasure', channel: 'email', receivedOn: today() }).expect(201);
      const verified = await as('owner').action(`/api/v1/privacy-requests/${created.body.id}/verify-identity`, created.body.version, { method: 'documents_seen', note: 'Passport seen' }).expect(200);
      return (await as('owner').action(`/api/v1/privacy-requests/${created.body.id}/status`, verified.body.version, { status: 'in_progress' }).expect(200)).body as { id: string; version: number };
    }

    it('refuses to erase a party to an open deal, and explains why', async () => {
      const buyer = await contact();
      await deal(buyer.id);
      const request = await erasureRequest(buyer.id);
      const record = await as('owner').get(`/api/v1/privacy-requests/${request.id}`).expect(200);
      expect(record.body).toMatchObject({ erasureBlockers: ['open_deal'], canFulfil: false });
      const refused = await as('owner').action(`/api/v1/privacy-requests/${request.id}/erase`, request.version, { confirm: 'ERASE' }).expect(422);
      expect(refused.body.errors[0]).toMatchObject({ code: 'erasure-blocked:open_deal' });
      expect(refused.body.errors[0].message).toContain('still open');
    });

    it('keeps a recorded sale until its retention period has passed, then erases the free text and keeps the facts', async () => {
      const buyer = await contact();
      const seller = await contact();
      const id = await deal(buyer.id);
      await fx.db.insertInto('dealParties').values({ companyId: company.companyId, dealId: id, contactId: seller.id, partyRole: 'seller' }).execute();
      const offer = await fx.db
        .insertInto('offers')
        .values({ companyId: company.companyId, dealId: id, listingId, offeredByContactId: buyer.id, direction: 'from_buyer', currencyCode: 'GHS', amount: '850000', conditions: 'Subject to the buyer selling their flat in Osu', recordedBy: company.ownerMembershipId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await fx.db.updateTable('offers').set({ status: 'accepted', respondedAt: new Date() }).where('id', '=', offer.id).execute();
      // Since S1 a viewing is booked on a live listing, with an attendee, in one transaction.
      await fx.db.updateTable('listings').set({ status: 'available' }).where('id', '=', listingId).where('status', '=', 'draft').execute();
      const viewing = await fx.db.transaction().execute(async (tx) => {
        const row = await tx
          .insertInto('viewings')
          .values({ companyId: company.companyId, listingId, unitId, dealId: id, agentMembershipId: company.ownerMembershipId, scheduledStart: new Date('2016-01-04T10:00:00Z'), scheduledEnd: new Date('2016-01-04T10:30:00Z'), timezone: 'Africa/Accra' })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx.insertInto('viewingAttendees').values({ companyId: company.companyId, viewingId: row.id, contactId: buyer.id }).execute();
        return row;
      });
      await fx.db.updateTable('viewings').set({ status: 'completed', outcome: 'offer_made', feedback: 'Asked about the school run for their children' }).where('id', '=', viewing.id).execute();
      await fx.db.insertInto('salesTransactions').values({ companyId: company.companyId, reference: `SAL-P6-${randomUUID().slice(0, 8)}`, dealId: id, listingId, unitId, acceptedOfferId: offer.id, currencyCode: 'GHS', agreedPrice: '850000' }).execute();
      await fx.db.updateTable('salesTransactions').set({ status: 'exchanged', contractSignedOn: '2016-01-20' }).where('dealId', '=', id).execute();
      await fx.db.updateTable('salesTransactions').set({ status: 'completed', completedOn: '2016-03-01' }).where('dealId', '=', id).execute();
      await fx.db.updateTable('deals').set({ stageId: await stageId('sale', 'closed_won'), closedAt: new Date('2016-03-01T12:00:00Z') }).where('id', '=', id).execute();

      const sellerRequest = await erasureRequest(seller.id);
      expect((await as('owner').get(`/api/v1/privacy-requests/${sellerRequest.id}`).expect(200)).body.erasureBlockers).toEqual(['sale_record']);

      await fx.db
        .insertInto('jurisdictionSettings')
        .values({ jurisdictionCode: 'GH', key: 'sales_records_retention_years', value: JSON.stringify(5), effectiveFrom: '2000-01-01', sourceReference: 'Test value only' })
        .execute();
      try {
        const buyerRequest = await erasureRequest(buyer.id);
        expect((await as('owner').get(`/api/v1/privacy-requests/${buyerRequest.id}`).expect(200)).body.erasureBlockers).toEqual([]);
        const erased = await as('owner').action(`/api/v1/privacy-requests/${buyerRequest.id}/erase`, buyerRequest.version, { confirm: 'ERASE' });
        expect(erased.status, JSON.stringify(erased.body)).toBe(200);
      } finally {
        await fx.db.deleteFrom('jurisdictionSettings').where('key', '=', 'sales_records_retention_years').execute();
      }
      const kept = await fx.db.selectFrom('offers').select(['conditions', 'amount', 'status']).where('id', '=', offer.id).executeTakeFirstOrThrow();
      expect(kept).toEqual({ conditions: '[Erased]', amount: '850000.0000', status: 'accepted' });
      const seen = await fx.db.selectFrom('viewings').select(['feedback', 'outcome']).where('id', '=', viewing.id).executeTakeFirstOrThrow();
      expect(seen).toEqual({ feedback: '[Erased]', outcome: 'offer_made' });
      const sale = await fx.db.selectFrom('salesTransactions').select(['status', 'agreedPrice', 'completedOn']).where('dealId', '=', id).executeTakeFirstOrThrow();
      expect(sale).toEqual({ status: 'completed', agreedPrice: '850000.0000', completedOn: '2016-03-01' });
      // The audit row of the erasure names the pipeline counts, not values.
      const audit = await fx.db.selectFrom('auditLogs').select('metadata').where('action', '=', 'contact.erased').where('entityId', '=', buyer.id).executeTakeFirstOrThrow();
      expect(JSON.stringify(audit.metadata)).not.toContain('school run');
    });
  });

  describe('accountant access (specification §11.2)', () => {
    it('reads deals, viewings and offers across the company and changes none of them', async () => {
      const grants = await fx.db
        .selectFrom('rolePermissions as rp')
        .innerJoin('roles as r', 'r.id', 'rp.roleId')
        .select(['rp.permissionKey', 'rp.scope'])
        .where('r.key', '=', 'accountant')
        .where('r.companyId', 'is', null)
        .where('rp.permissionKey', 'like', sql<string>`any(array['deal.%', 'viewing.%', 'offer.%'])`)
        .orderBy('rp.permissionKey')
        .execute();
      expect(grants).toEqual([
        { permissionKey: 'deal.view', scope: 'all' },
        { permissionKey: 'offer.view', scope: 'all' },
        { permissionKey: 'viewing.view', scope: 'all' },
      ]);
      const me = await as('accountant').get('/api/v1/me/context').expect(200);
      const granted = (me.body.permissions as Array<{ key: string; scope: string }>).filter((grant) => /^(deal|viewing|offer)\./.test(grant.key)).map(({ key, scope }) => ({ key, scope }));
      expect(granted.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: 'deal.view', scope: 'all' },
        { key: 'offer.view', scope: 'all' },
        { key: 'viewing.view', scope: 'all' },
      ]);
    });

    it('keeps other companies out of these records', async () => {
      await as('otherOwner').get(`/api/v1/listings/${listingId}/status-history`).expect(404);
      await as('otherOwner').get(`/api/v1/properties/${propertyId}/history`).expect(404);
    });
  });
});
