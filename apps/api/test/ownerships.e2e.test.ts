import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { todayIn } from '../src/common/dates.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Member = Awaited<ReturnType<Fixtures['member']>>;

/**
 * P5-H: ownership records (property "Ownership" tab, LL-1 "add ownership")
 * and the seller identity publish rule (issue #18).
 */
describe('ownership records and seller identity (P5-H, #18)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let agent: Member;
  let accountant: Member;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};
  const now = (): number => Math.floor(Date.now() / 1000);
  const today = todayIn('Africa/Accra');
  const daysAgo = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  let apartmentType: string;

  const as = (who: string) => {
    const cid = who === 'otherOwner' ? other.companyId : company.companyId;
    const auth = <R extends { auth: (token: string, options: { type: 'bearer' }) => R; set: (name: string, value: string) => R }>(req: R) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', cid);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body?: object) => auth(t.http.post(path)).send(body ?? {}),
      put: (path: string, body: object) => auth(t.http.put(path)).send(body),
      action: (path: string, version: number, body?: object) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body ?? {}),
    };
  };

  async function property(who = 'owner', officeId = company.officeId): Promise<{ id: string; units: string[] }> {
    const address = { countryCode: 'GH', addressLine1: `${Math.floor(Math.random() * 900) + 1} Ring Road`, locality: 'Accra', adminArea1: 'Greater Accra' };
    const created = await as(who).post('/api/v1/properties', { name: `Court ${randomUUID().slice(0, 6)}`, propertyTypeId: apartmentType, officeId, address });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const units: string[] = [];
    for (const label of ['A', 'B']) {
      const unit = await as(who).post(`/api/v1/properties/${created.body.id}/units`, { unitLabel: `Flat ${label}`, bedrooms: 2 }).expect(201);
      units.push(unit.body.id);
    }
    return { id: created.body.id, units };
  }

  async function contact(who = 'owner', overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await as(who).post('/api/v1/contacts', { contactType: 'person', displayName: `Owner ${randomUUID().slice(0, 6)}`, primaryEmail: `${randomUUID()}@owners.test`, ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  async function verify(contactId: string, checkType = 'identity', expiresOn: string | null = null): Promise<void> {
    await fx.db
      .insertInto('kycChecks')
      .values({ companyId: company.companyId, contactId, checkType, status: 'verified', riskRating: 'low', reviewedBy: members['owner']!, reviewedAt: new Date(), expiresOn, recordedBy: members['owner']! })
      .execute();
  }

  const ownerships = (propertyId: string, who = 'owner') => as(who).get(`/api/v1/properties/${propertyId}/ownerships`);

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    const technician = await fx.member(company.companyId, { roleKey: 'maintenance_staff' });
    for (const [name, userId] of Object.entries({
      owner: company.ownerUserId,
      agent: agent.userId,
      accountant: accountant.userId,
      technician: technician.userId,
      otherOwner: other.ownerUserId,
    })) {
      await fx.linkIdentity(userId, `own-${name}-${company.companyId}`);
      tokens[name] = await t.idp.token({ sub: `own-${name}-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: now() });
    }
    const ownerMembership = await fx.db.selectFrom('companyMemberships').select('id').where('companyId', '=', company.companyId).where('userId', '=', company.ownerUserId).executeTakeFirstOrThrow();
    members['owner'] = ownerMembership.id;
    apartmentType = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'apartment_building').executeTakeFirstOrThrow()).id;
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('ownership records', () => {
    it('adds whole-property and unit owners, lists them with identity status, and audits', async () => {
      const p = await property();
      const ama = await contact();
      const kofi = await contact();
      await verify(ama);

      const whole = await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: ama, effectiveFrom: daysAgo(30) });
      expect(whole.status, JSON.stringify(whole.body)).toBe(201);
      expect(whole.body).toMatchObject({
        unit: null,
        owner: { id: ama, contactType: 'person', identityVerified: true },
        sharePercent: 100,
        ownershipType: 'legal_owner',
        effectiveFrom: daysAgo(30),
        effectiveTo: null,
        current: true,
        createdBy: { id: members['owner'] },
        endedBy: null,
      });
      await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: kofi, unitId: p.units[0], sharePercent: 50, effectiveFrom: daysAgo(5) }).expect(201);

      const list = await ownerships(p.id).expect(200);
      expect(list.body.canManage).toBe(true);
      expect(list.body.data).toHaveLength(2);
      expect(list.body.data.find((row: { owner: { id: string } }) => row.owner.id === kofi)).toMatchObject({ unit: { id: p.units[0], unitLabel: 'Flat A' }, sharePercent: 50, owner: { identityVerified: false } });

      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'metadata', 'actorMembershipId']).where('entityId', '=', p.id).where('action', '=', 'property.ownership_added').execute();
      expect(audit).toHaveLength(2);
      expect(audit[0]!.actorMembershipId).toBe(members['owner']);
      expect(audit.map((row) => (row.metadata as { ownerContactId: string }).ownerContactId).sort()).toEqual([ama, kofi].sort());
    });

    it('validates dates, units, owners and shares', async () => {
      const p = await property();
      const elsewhere = await property();
      const a = await contact();
      const b = await contact();
      const path = `/api/v1/properties/${p.id}/ownerships`;
      const fields = (res: { body: { errors?: Array<{ field: string; code: string }> } }) => res.body.errors?.map((e) => `${e.field}:${e.code}`);

      expect(fields(await as('owner').post(path, { ownerContactId: a, effectiveFrom: tomorrow }).expect(422))).toEqual(['effectiveFrom:future']);
      expect(fields(await as('owner').post(path, { ownerContactId: a, effectiveFrom: '2026-02-30' }).expect(422))).toEqual(['effectiveFrom:invalid']);
      expect(fields(await as('owner').post(path, { ownerContactId: a, unitId: elsewhere.units[0], effectiveFrom: today }).expect(422))).toEqual(['unitId:not-found']);
      await as('owner').post(path, { ownerContactId: a, sharePercent: 0, effectiveFrom: today }).expect(422);
      await as('owner').post(path, { ownerContactId: a, sharePercent: 101, effectiveFrom: today }).expect(422);
      await as('owner').post(path, { ownerContactId: a, ownershipType: 'tenant', effectiveFrom: today }).expect(422);
      // A contact of another company is not found (no existence leak).
      const outsider = (await as('otherOwner').post('/api/v1/contacts', { contactType: 'person', displayName: 'Outsider', primaryEmail: `${randomUUID()}@other.test` }).expect(201)).body.id;
      expect(fields(await as('owner').post(path, { ownerContactId: outsider, effectiveFrom: today }).expect(422))).toEqual(['ownerContactId:not-found']);

      await as('owner').post(path, { ownerContactId: a, sharePercent: 60, effectiveFrom: daysAgo(10) }).expect(201);
      const over = await as('owner').post(path, { ownerContactId: b, sharePercent: 50, effectiveFrom: daysAgo(3) }).expect(422);
      expect(fields(over)).toEqual(['sharePercent:over-100']);
      expect(over.body.errors[0].message).toContain('40 %');
      await as('owner').post(path, { ownerContactId: b, sharePercent: 40, effectiveFrom: daysAgo(3) }).expect(201);
      // Another type of ownership has its own 100 %.
      await as('owner').post(path, { ownerContactId: b, sharePercent: 100, ownershipType: 'beneficial_owner', effectiveFrom: daysAgo(3) }).expect(201);
      const twice = await as('owner').post(path, { ownerContactId: a, sharePercent: 10, effectiveFrom: today }).expect(409);
      expect(twice.body.conflictingResource.type).toBe('property-ownership');

      // An archived contact or property cannot gain ownership.
      const archived = await contact();
      await fx.db.updateTable('contacts').set({ archivedAt: new Date(), archivedReason: 'Test' }).where('id', '=', archived).execute();
      expect(fields(await as('owner').post(`/api/v1/properties/${elsewhere.id}/ownerships`, { ownerContactId: archived, effectiveFrom: today }).expect(422))).toEqual(['ownerContactId:archived']);
      const current = await as('owner').get(`/api/v1/properties/${elsewhere.id}`).expect(200);
      await as('owner').action(`/api/v1/properties/${elsewhere.id}/archive`, current.body.version, { reason: 'Sold off' }).expect(200);
      await as('owner').post(`/api/v1/properties/${elsewhere.id}/ownerships`, { ownerContactId: a, effectiveFrom: today }).expect(422);
      expect((await ownerships(elsewhere.id).expect(200)).body.canManage).toBe(false);
    });

    it('ends a record once, keeping it as history, and frees its share', async () => {
      const p = await property();
      const seller = await contact();
      const buyer = await contact();
      const added = await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: seller, effectiveFrom: daysAgo(400) }).expect(201);
      const end = `/api/v1/property-ownerships/${added.body.id}/end`;

      await as('owner').post(end, { effectiveTo: daysAgo(400), reason: 'Sold' }).expect(422);
      await as('owner').post(end, { effectiveTo: tomorrow, reason: 'Sold' }).expect(422);
      await as('owner').post(end, { effectiveTo: daysAgo(2), reason: 'x' }).expect(422);
      const ended = await as('owner').post(end, { effectiveTo: daysAgo(2), reason: 'Sold to a new owner' }).expect(200);
      expect(ended.body).toMatchObject({ effectiveTo: daysAgo(2), current: false, endedBy: { id: members['owner'] }, endReason: 'Sold to a new owner' });
      await as('owner').post(end, { effectiveTo: daysAgo(1), reason: 'Again' }).expect(409);
      await as('owner').post(`/api/v1/property-ownerships/${randomUUID()}/end`, { effectiveTo: daysAgo(1), reason: 'Nothing' }).expect(404);

      await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: buyer, effectiveFrom: daysAgo(1) }).expect(201);
      const list = await ownerships(p.id).expect(200);
      expect(list.body.data.map((row: { owner: { id: string }; current: boolean }) => [row.owner.id, row.current])).toEqual([[buyer, true], [seller, false]]);
      const audit = await fx.db.selectFrom('auditLogs').select(['changes', 'metadata']).where('entityId', '=', p.id).where('action', '=', 'property.ownership_ended').executeTakeFirstOrThrow();
      expect(audit.changes).toEqual({ effectiveTo: { old: null, new: daysAgo(2) } });
      expect(audit.metadata).toMatchObject({ ownershipId: added.body.id, reason: 'Sold to a new owner' });
    });

    it('applies property and contact scopes, and isolates companies', async () => {
      const p = await property();
      const owner = await contact();
      await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: owner, effectiveFrom: today }).expect(201);

      // The accountant sees properties and contacts but may not change properties.
      expect((await ownerships(p.id, 'accountant').expect(200)).body).toMatchObject({ canManage: false, data: [{ owner: { id: owner } }] });
      await as('accountant').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: owner, effectiveFrom: today }).expect(403);
      // An agent sees the office's properties, but only contacts they are responsible for: the owner is withheld.
      const seen = await ownerships(p.id, 'agent').expect(200);
      expect(seen.body.data[0]).toMatchObject({ owner: null, sharePercent: 100 });
      expect(seen.body.canManage).toBe(false);
      // An agent records the owner of a property they created, with a contact of their own.
      const own = await property('agent');
      const mine = await contact('agent');
      await as('agent').post(`/api/v1/properties/${own.id}/ownerships`, { ownerContactId: mine, effectiveFrom: today }).expect(201);
      const notMine = await as('agent').post(`/api/v1/properties/${own.id}/ownerships`, { ownerContactId: owner, sharePercent: 1, ownershipType: 'developer', effectiveFrom: today }).expect(422);
      expect(notMine.body.errors[0]).toMatchObject({ field: 'ownerContactId', code: 'not-found' });
      // Without kyc.view on the contact the identity status is not shown.
      expect((await ownerships(own.id, 'agent').expect(200)).body.data[0].owner).toMatchObject({ id: mine });

      await ownerships(p.id, 'technician').expect(404);
      await ownerships(p.id, 'otherOwner').expect(404);
      await as('otherOwner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: owner, effectiveFrom: today }).expect(404);
      const record = (await ownerships(p.id).expect(200)).body.data[0];
      await as('otherOwner').post(`/api/v1/property-ownerships/${record.id}/end`, { effectiveTo: today, reason: 'Not yours' }).expect(404);
    });
  });

  describe('seller identity publish rule (#18)', () => {
    async function draftSale(unitId: string): Promise<{ id: string; version: number }> {
      const res = await as('owner').post('/api/v1/listings', {
        unitId,
        listingType: 'sale',
        price: { amount: '450000.00', currency: 'GHS' },
        title: 'Apartment for sale',
        priceQualifierCode: 'negotiable',
        mandateTypeCode: 'sole_agency',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    }
    const blockers = async (listing: { id: string; version: number }) => {
      const res = await as('owner').action(`/api/v1/listings/${listing.id}/publish`, listing.version);
      if (res.status === 200) return 'published';
      expect(res.body.type).toBe('urn:estatepro:problem:publish-blocked');
      return (res.body.errors as Array<{ field: string; code: string }>).map((e) => `${e.field}:${e.code}`);
    };
    const setRule = (on: boolean) => as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: null, requireSellerKyc: on }).expect(200);

    it('is unchanged when the rule is off', async () => {
      const p = await property();
      expect(await blockers(await draftSale(p.units[0]!))).toBe('published');
    });

    it('blocks without a recorded owner, and until every current owner is verified', async () => {
      await setRule(true);
      try {
        const p = await property();
        const listing = await draftSale(p.units[0]!);
        expect(await blockers(listing)).toEqual(['sellerKyc:no-owner']);

        const person = await contact();
        const organisation = await contact('owner', { contactType: 'organisation', displayName: `Ventures ${randomUUID().slice(0, 6)} Ltd`, organisationName: 'Ventures Ltd' });
        await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: person, sharePercent: 50, effectiveFrom: daysAgo(20) }).expect(201);
        await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: organisation, unitId: p.units[0], sharePercent: 50, effectiveFrom: daysAgo(20) }).expect(201);
        expect(await blockers(listing)).toEqual([`sellerKyc.${person}:unverified`, `sellerKyc.${organisation}:unverified`].sort());

        await verify(person);
        // An organisation proves its ownership, not a personal identity.
        await verify(organisation, 'identity');
        expect(await blockers(listing)).toEqual([`sellerKyc.${organisation}:unverified`]);
        await verify(organisation, 'company_ownership');
        expect(await blockers(listing)).toBe('published');

        // Another unit of the same property: only the whole-property owner applies.
        expect(await blockers(await draftSale(p.units[1]!))).toBe('published');
      } finally {
        await setRule(false);
      }
    });

    it('fails closed on an expired, superseded or erased identity, and ignores ended owners', async () => {
      await setRule(true);
      try {
        const p = await property();
        const expired = await contact();
        await verify(expired, 'identity', daysAgo(1));
        await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: expired, effectiveFrom: daysAgo(100) }).expect(201);
        const listing = await draftSale(p.units[0]!);
        expect(await blockers(listing)).toEqual([`sellerKyc.${expired}:unverified`]);

        // A newer pending check replaces an older verified one.
        const rechecked = await contact();
        await verify(rechecked);
        await fx.db.insertInto('kycChecks').values({ companyId: company.companyId, contactId: rechecked, checkType: 'identity', status: 'pending', recordedBy: members['owner']! }).execute();
        const record = (await ownerships(p.id).expect(200)).body.data[0];
        await as('owner').post(`/api/v1/property-ownerships/${record.id}/end`, { effectiveTo: daysAgo(1), reason: 'Sold' }).expect(200);
        await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: rechecked, effectiveFrom: today }).expect(201);
        // The ended owner no longer counts; the new owner's latest check is pending.
        expect(await blockers(listing)).toEqual([`sellerKyc.${rechecked}:unverified`]);

        const erased = await contact();
        await verify(erased);
        await fx.eraseContact(company.companyId, erased);
        const q = await property();
        await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: q.id, ownerContactId: erased, effectiveFrom: daysAgo(5) }).execute();
        expect(await blockers(await draftSale(q.units[0]!))).toEqual([`sellerKyc.${erased}:unverified`]);
      } finally {
        await setRule(false);
      }
    });

    it('applies the jurisdiction rule from data, which the company setting cannot relax', async () => {
      const p = await property();
      const listing = await draftSale(p.units[0]!);
      await fx.db
        .insertInto('jurisdictionSettings')
        .values({ jurisdictionCode: 'GH', key: 'listing_owner_identity_required', value: JSON.stringify(true), effectiveFrom: daysAgo(1), sourceReference: 'Test only' })
        .execute();
      try {
        // The company setting is off; the jurisdiction rule still applies.
        await setRule(false);
        expect(await blockers(listing)).toEqual(['sellerKyc:no-owner']);
        const owner = await contact();
        await verify(owner);
        await as('owner').post(`/api/v1/properties/${p.id}/ownerships`, { ownerContactId: owner, effectiveFrom: today }).expect(201);
        expect(await blockers(listing)).toBe('published');
      } finally {
        await fx.db.deleteFrom('jurisdictionSettings').where('key', '=', 'listing_owner_identity_required').execute();
      }
      // Rule removed: a property without owners publishes again.
      const q = await property();
      expect(await blockers(await draftSale(q.units[0]!))).toBe('published');
    });
  });
});
