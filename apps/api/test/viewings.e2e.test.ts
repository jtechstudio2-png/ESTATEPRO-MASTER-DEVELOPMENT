import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let counter = 0;
const nextPhone = () => `024${String(7400000 + counter++).padStart(7, '0')}`;
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
let slot = 0;
/** A distinct future slot for each booking, so tests never collide in an agent's calendar. */
const nextSlot = (minutes = 30) => {
  slot += 1;
  const start = new Date(Date.now() + (24 + slot * 2) * 3_600_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + minutes * 60_000).toISOString() };
};

/**
 * S1 viewings (readiness report §4.1): booking on live listings, scope
 * (own, office, all), conflicts, the lifecycle (confirm, reschedule, cancel,
 * outcome, no-show, feedback sharing), effects on leads and deals, the
 * timeline, audit and outbox, keys for a viewing (with the contact-scope fix,
 * readiness R7), the "No viewing in 21 days" flag, the access report and
 * tenant isolation.
 */
describe('S1: viewings', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};
  let propertyId: string;
  let unitId: string;
  let listingId: string;
  let listingReference: string;
  let agentListingId: string;
  let agentUnitId: string;
  let ksiOfficeId: string;

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

  async function contact(who = 'owner', name = `Viewer ${randomUUID().slice(0, 6)}`) {
    const res = await as(who).post('/api/v1/contacts', { contactType: 'person', displayName: name, primaryPhone: nextPhone() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  async function book(who: string, body: Record<string, unknown>, expected = 201) {
    const res = await as(who).post('/api/v1/viewings', { listingId, ...nextSlot(), ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    return res.body as ViewingBody;
  }

  /** A viewing that has already started (the API never books in the past), with one attendee. */
  async function pastViewing(contactId: string, agent = members['agent']!) {
    return fx.db.transaction().execute(async (tx) => {
      const viewing = await tx
        .insertInto('viewings')
        .values({
          companyId: company.companyId,
          listingId,
          unitId,
          agentMembershipId: agent,
          scheduledStart: new Date(Date.now() - 2 * 3_600_000 - slot++ * 60_000),
          scheduledEnd: new Date(Date.now() - 3_600_000 - slot * 60_000),
          timezone: 'Africa/Accra',
          status: 'confirmed',
          createdBy: agent,
        })
        .returning(['id', 'version'])
        .executeTakeFirstOrThrow();
      await tx.insertInto('viewingAttendees').values({ companyId: company.companyId, viewingId: viewing.id, contactId }).execute();
      return viewing;
    });
  }

  async function newProperty(name: string) {
    const typeId = (await fx.db.selectFrom('propertyTypes').select('id').where('companyId', 'is', null).where('code', '=', 'villa').executeTakeFirstOrThrow()).id;
    const property = await as('owner')
      .post('/api/v1/properties', {
        name,
        propertyTypeId: typeId,
        officeId: company.officeId,
        address: { countryCode: 'GH', addressLine1: `${counter} Ridge Road`, locality: 'Accra', adminArea1: 'Greater Accra' },
        createWholePropertyUnit: true,
      })
      .expect(201);
    const unit = (await fx.db.selectFrom('units').select('id').where('propertyId', '=', property.body.id).executeTakeFirstOrThrow()).id;
    return { propertyId: property.body.id as string, unitId: unit };
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    const ksi = (await fx.office(company.companyId, 'KSI')).id;
    ksiOfficeId = ksi;
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const agent2 = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    const ksiAgent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [ksi] });
    const manager = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    const accountant = await fx.member(company.companyId, { roleKey: 'accountant' });
    Object.assign(members, { owner: company.ownerMembershipId, agent: agent.membershipId, agent2: agent2.membershipId, ksiAgent: ksiAgent.membershipId, manager: manager.membershipId });
    const now = Math.floor(Date.now() / 1000);
    for (const [name, userId, companyId] of [
      ['owner', company.ownerUserId, company.companyId],
      ['agent', agent.userId, company.companyId],
      ['agent2', agent2.userId, company.companyId],
      ['manager', manager.userId, company.companyId],
      ['accountant', accountant.userId, company.companyId],
      ['otherOwner', other.ownerUserId, other.companyId],
    ] as const) {
      await fx.linkIdentity(userId, `s1-${name}-${companyId}`);
      tokens[name] = await t.idp.token({ sub: `s1-${name}-${companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
    ({ propertyId, unitId } = await newProperty('Viewing Villa'));
    const listing = await fx.listing(company.companyId, unitId, agent.membershipId, company.officeId);
    listingId = listing.id;
    listingReference = (await fx.db.selectFrom('listings').select('reference').where('id', '=', listingId).executeTakeFirstOrThrow()).reference;
    // A second listing whose agent is agent2 (for the own-scope tests).
    const second = await newProperty('Second Villa');
    agentUnitId = second.unitId;
    agentListingId = (await fx.listing(company.companyId, agentUnitId, agent2.membershipId, company.officeId)).id;
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('booking', () => {
    it('books from a lead: the lead\'s contact attends, the new lead is contacted, the timeline, audit and outbox record it', async () => {
      const person = await contact();
      const lead = await as('owner').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'phone', listingId }).expect(201);
      expect(lead.body.status).toBe('new');
      const viewing = await book('owner', { leadId: lead.body.id, agentMembershipId: members['agent'], meetingPoint: 'Front gate' });
      expect(viewing).toMatchObject({
        status: 'scheduled',
        viewingType: 'in_person',
        timezone: 'Africa/Accra',
        agent: { id: members['agent'] },
        lead: { id: lead.body.id },
        listing: { id: listingId, reference: listingReference },
        attendees: [{ contact: { id: person.id }, attendance: 'expected' }],
        needsOutcome: false,
        canManage: true,
      });
      const after = await as('owner').get(`/api/v1/leads/${lead.body.id}`).expect(200);
      expect(after.body.status).toBe('contacted');
      const timeline = await as('owner').get(`/api/v1/contacts/${person.id}/activities`).expect(200);
      expect(timeline.body.data.map((entry: { subject: string }) => entry.subject).join('\n')).toContain(`Viewing booked: ${listingReference}`);
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'metadata']).where('entityId', '=', viewing.id).execute();
      expect(audit.map((row) => row.action)).toEqual(['viewing.booked']);
      const outbox = await fx.db.selectFrom('outboxEvents').select(['eventType', 'payload']).where('aggregateId', '=', viewing.id).execute();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ eventType: 'viewing.booked', payload: { viewingId: viewing.id, attendeeContactIds: [person.id], timezone: 'Africa/Accra' } });
    });

    it('refuses bookings that break the rules, with a field and a code for each', async () => {
      const person = await contact();
      const errors = async (body: Record<string, unknown>) => {
        const res = await as('owner').post('/api/v1/viewings', { listingId, ...nextSlot(), attendeeContactIds: [person.id], ...body });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        return (res.body.errors as { field: string; code: string }[]).map((e) => `${e.field}:${e.code}`);
      };
      expect(await errors({ scheduledStart: inHours(-3), scheduledEnd: inHours(-2) })).toContain('scheduledStart:in-past');
      const s = nextSlot();
      expect(await errors({ scheduledStart: s.scheduledEnd, scheduledEnd: s.scheduledStart })).toContain('scheduledEnd:before-start');
      expect(await errors({ scheduledStart: inHours(400), scheduledEnd: inHours(410) })).toContain('scheduledEnd:too-long');
      expect(await errors({ attendeeContactIds: [] })).toContain('attendeeContactIds:required');
      expect(await errors({ attendeeContactIds: [randomUUID()] })).toContain('attendeeContactIds[0]:not-found');

      const draft = await fx.listing(company.companyId, (await newProperty('Draft Villa')).unitId, members['agent']!, company.officeId, 'draft');
      expect(await errors({ listingId: draft.id })).toContain('listingId:listing-not-live');
      await fx.db.updateTable('units').set({ availability: 'under_maintenance' }).where('id', '=', unitId).execute();
      try {
        expect(await errors({})).toContain('listingId:unit-under-maintenance');
      } finally {
        await fx.db.updateTable('units').set({ availability: 'available' }).where('id', '=', unitId).execute();
      }
      // An open house needs no named attendees.
      const openHouse = await book('owner', { viewingType: 'open_house', attendeeContactIds: [], agentMembershipId: members['owner'] });
      expect(openHouse.attendees).toEqual([]);
    });

    it('refuses an overlapping viewing for the same agent (409), and warns about the same unit at the same time', async () => {
      const person = await contact();
      const time = nextSlot(60);
      const first = await book('owner', { ...time, attendeeContactIds: [person.id], agentMembershipId: members['agent'] });
      const clash = await as('owner').post('/api/v1/viewings', { listingId, ...time, attendeeContactIds: [person.id], agentMembershipId: members['agent'] });
      expect(clash.status).toBe(409);
      expect(clash.body.conflictingResource).toEqual({ type: 'viewing', id: first.id });
      const second = await book('owner', { ...time, attendeeContactIds: [person.id], agentMembershipId: members['agent2'] });
      expect(second.unitConflicts.map((c) => c.id)).toEqual([first.id]);
      const reread = await as('owner').get(`/api/v1/viewings/${first.id}`).expect(200);
      expect(reread.body.unitConflicts.map((c: { id: string }) => c.id)).toEqual([second.id]);
    });

    it('moves an open deal before the viewing stage to it, with a stage note', async () => {
      const person = await contact();
      const stage = (code: string) => fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', 'sale').where('code', '=', code).executeTakeFirstOrThrow();
      const deal = await fx.db
        .insertInto('deals')
        .values({
          companyId: company.companyId,
          reference: `DEA-S1-${randomUUID().slice(0, 8)}`,
          dealType: 'sale',
          stageId: (await stage('qualification')).id,
          stageClass: 'qualification',
          primaryContactId: person.id,
          officeId: company.officeId,
          ownerMembershipId: members['owner']!,
          currencyCode: 'GHS',
          listingId,
          unitId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const viewing = await book('owner', { dealId: deal.id, attendeeContactIds: [person.id] });
      expect(viewing.deal).toMatchObject({ id: deal.id });
      const row = await fx.db.selectFrom('deals').select(['stageClass']).where('id', '=', deal.id).executeTakeFirstOrThrow();
      expect(row.stageClass).toBe('viewing');
      const history = await fx.db.selectFrom('dealStageHistory').select(['note']).where('dealId', '=', deal.id).orderBy('entryNo').execute();
      expect(history.at(-1)!.note).toBe('Viewing booked');

      // A deal for another listing, or a closed one, is refused.
      const elsewhere = await as('owner').post('/api/v1/viewings', { listingId: agentListingId, ...nextSlot(), dealId: deal.id, attendeeContactIds: [person.id] });
      expect(elsewhere.status).toBe(422);
      expect(elsewhere.body.errors).toContainEqual(expect.objectContaining({ field: 'dealId', code: 'deal-listing-mismatch' }));
    });
  });

  describe('scope', () => {
    it('agents book their own listings and leads for themselves; managers book for agents in their office', async () => {
      const mine = await contact('agent');
      // Own listing (agent is the listing agent): allowed.
      const own = await book('agent', { attendeeContactIds: [mine.id] });
      expect(own.agent.id).toBe(members['agent']);
      // Someone else's listing, no lead or deal of theirs: forbidden.
      const foreign = await as('agent').post('/api/v1/viewings', { listingId: agentListingId, ...nextSlot(), attendeeContactIds: [mine.id] });
      expect(foreign.status).toBe(403);
      // ...unless it comes from a lead assigned to them.
      const lead = await as('owner').post('/api/v1/leads', { contactId: mine.id, leadType: 'buy', sourceCode: 'phone', assignedTo: members['agent'] });
      expect(lead.status, JSON.stringify(lead.body)).toBe(201);
      const fromLead = await as('agent').post('/api/v1/viewings', { listingId: agentListingId, ...nextSlot(), leadId: lead.body.id });
      expect(fromLead.status, JSON.stringify(fromLead.body)).toBe(201);
      // Booking for another agent is a manager action.
      const forOther = await as('agent').post('/api/v1/viewings', { ...nextSlot(), listingId, attendeeContactIds: [mine.id], agentMembershipId: members['agent2'] });
      expect(forOther.status).toBe(422);
      expect(forOther.body.errors[0]).toMatchObject({ field: 'agentMembershipId', code: 'not-allowed' });

      const person = await contact();
      const byManager = await book('manager', { attendeeContactIds: [person.id], agentMembershipId: members['agent2'] });
      expect(byManager.agent.id).toBe(members['agent2']);
      // An agent in another office cannot be booked by an office manager.
      const outside = await as('manager').post('/api/v1/viewings', { ...nextSlot(), listingId, attendeeContactIds: [person.id], agentMembershipId: members['ksiAgent'] });
      expect(outside.status).toBe(422);
      expect(outside.body.errors[0]).toMatchObject({ code: 'not-assignable' });
    });

    it('lists only viewings in scope; agents see theirs, accountants read all and manage none', async () => {
      const person = await contact();
      const other2 = await book('owner', { listingId: agentListingId, attendeeContactIds: [person.id], agentMembershipId: members['agent2'] });
      const agentList = await as('agent').get(`/api/v1/viewings?limit=100&filter[listingId]=${agentListingId}`).expect(200);
      expect(agentList.body.data.map((v: { id: string }) => v.id)).not.toContain(other2.id);
      await as('agent').get(`/api/v1/viewings/${other2.id}`).expect(404);
      const agent2List = await as('agent2').get(`/api/v1/viewings?limit=100&filter[listingId]=${agentListingId}`).expect(200);
      expect(agent2List.body.data.map((v: { id: string }) => v.id)).toContain(other2.id);

      const read = await as('accountant').get(`/api/v1/viewings/${other2.id}`).expect(200);
      expect(read.body.canManage).toBe(false);
      await as('accountant').action(`/api/v1/viewings/${other2.id}/confirm`, read.body.version).expect(403);
      await as('accountant').post('/api/v1/viewings', { listingId, ...nextSlot(), attendeeContactIds: [person.id] }).expect(403);
    });

    it('keeps companies apart', async () => {
      const person = await contact();
      const viewing = await book('owner', { attendeeContactIds: [person.id] });
      await as('otherOwner').get(`/api/v1/viewings/${viewing.id}`).expect(404);
      const list = await as('otherOwner').get('/api/v1/viewings?limit=100').expect(200);
      expect(list.body.data).toEqual([]);
      const foreign = await as('otherOwner').post('/api/v1/viewings', { listingId, ...nextSlot(), attendeeContactIds: [person.id] });
      expect(foreign.status).toBe(422);
      expect(foreign.body.errors).toContainEqual(expect.objectContaining({ field: 'listingId', code: 'not-found' }));
    });
  });

  describe('lifecycle', () => {
    it('confirms, reschedules (keeping the old viewing linked) and cancels with a reason; versions are checked', async () => {
      const person = await contact();
      const booked = await book('owner', { attendeeContactIds: [person.id], agentMembershipId: members['agent'] });
      await as('owner').action(`/api/v1/viewings/${booked.id}/confirm`, booked.version + 5).expect(412);
      const confirmed = await as('owner').action(`/api/v1/viewings/${booked.id}/confirm`, booked.version).expect(200);
      expect(confirmed.body.status).toBe('confirmed');

      // Reschedule 15 minutes later: overlaps the old slot for the same agent, which is allowed.
      const moved = new Date(new Date(booked.scheduledStart).getTime() + 15 * 60_000);
      const rescheduled = await as('owner')
        .action(`/api/v1/viewings/${booked.id}/reschedule`, confirmed.body.version, {
          scheduledStart: moved.toISOString(),
          scheduledEnd: new Date(moved.getTime() + 30 * 60_000).toISOString(),
          reason: 'Buyer running late',
        })
        .expect(200);
      expect(rescheduled.body).toMatchObject({ status: 'scheduled', rescheduledFromId: booked.id, attendees: [{ contact: { id: person.id } }] });
      const old = await as('owner').get(`/api/v1/viewings/${booked.id}`).expect(200);
      expect(old.body).toMatchObject({ status: 'rescheduled', rescheduledToId: rescheduled.body.id });
      expect((await as('owner').action(`/api/v1/viewings/${booked.id}/confirm`, old.body.version)).status).toBe(422);

      await as('owner').action(`/api/v1/viewings/${rescheduled.body.id}/cancel`, rescheduled.body.version, {}).expect(422);
      const cancelled = await as('owner').action(`/api/v1/viewings/${rescheduled.body.id}/cancel`, rescheduled.body.version, { reason: 'Buyer found another home' }).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'cancelled', cancelledReason: 'Buyer found another home' });
      const actions = await fx.db.selectFrom('auditLogs').select('action').where('entityId', 'in', [booked.id, rescheduled.body.id]).orderBy('entryNo').execute();
      expect(actions.map((row) => row.action)).toEqual(['viewing.booked', 'viewing.confirmed', 'viewing.rescheduled', 'viewing.cancelled']);
    });

    it('records the outcome only once the viewing has started; outcome and feedback are then final; sharing can change', async () => {
      const person = await contact();
      const future = await book('owner', { attendeeContactIds: [person.id] });
      const early = await as('owner').action(`/api/v1/viewings/${future.id}/outcome`, future.version, { outcome: 'interested' });
      expect(early.status).toBe(422);
      expect(early.body.errors[0]).toMatchObject({ code: 'not-started' });
      expect((await as('owner').action(`/api/v1/viewings/${future.id}/no-show`, future.version)).status).toBe(422);

      const second = await contact();
      const past = await pastViewing(person.id);
      await fx.db.insertInto('viewingAttendees').values({ companyId: company.companyId, viewingId: past.id, contactId: second.id }).execute();
      const needing = await as('owner').get(`/api/v1/viewings?limit=100&filter[needsOutcome]=true&filter[listingId]=${listingId}`).expect(200);
      expect(needing.body.data.map((v: { id: string }) => v.id)).toContain(past.id);
      expect(needing.body.data.every((v: { needsOutcome: boolean }) => v.needsOutcome)).toBe(true);

      const shareless = await as('owner').action(`/api/v1/viewings/${past.id}/outcome`, past.version, { outcome: 'interested', shareFeedback: true });
      expect(shareless.status).toBe(422);
      const recorded = await as('owner')
        .action(`/api/v1/viewings/${past.id}/outcome`, past.version, {
          outcome: 'second_viewing',
          feedback: 'Liked the garden, wants to see it in daylight',
          attendance: [{ contactId: second.id, attendance: 'absent' }],
        })
        .expect(200);
      expect(recorded.body).toMatchObject({ status: 'completed', outcome: 'second_viewing', feedbackShared: false, needsOutcome: false });
      const attendance = Object.fromEntries(recorded.body.attendees.map((a: { contact: { id: string }; attendance: string }) => [a.contact.id, a.attendance]));
      expect(attendance).toEqual({ [person.id]: 'attended', [second.id]: 'absent' });

      expect((await as('owner').action(`/api/v1/viewings/${past.id}/outcome`, recorded.body.version, { outcome: 'interested' })).status).toBe(422);
      const shared = await as('owner').action(`/api/v1/viewings/${past.id}/feedback-sharing`, recorded.body.version, { shared: true }).expect(200);
      expect(shared.body.feedbackShared).toBe(true);
      const unshared = await as('owner').action(`/api/v1/viewings/${past.id}/feedback-sharing`, shared.body.version, { shared: false }).expect(200);
      expect(unshared.body.feedbackShared).toBe(false);
      const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', past.id).orderBy('entryNo').execute();
      expect(events.map((row) => row.eventType)).toEqual(['viewing.completed', 'viewing.feedback_shared', 'viewing.feedback_shared']);
    });

    it('marks a no-show once the time has come; every attendee is absent', async () => {
      const person = await contact();
      const past = await pastViewing(person.id);
      const noShow = await as('owner').action(`/api/v1/viewings/${past.id}/no-show`, past.version, { note: 'Phone off' }).expect(200);
      expect(noShow.body).toMatchObject({ status: 'no_show', attendees: [{ attendance: 'absent' }] });
      await as('owner').action(`/api/v1/viewings/${past.id}/feedback-sharing`, noShow.body.version, { shared: true }).expect(422);
    });

    it('serves the agent calendar by time range and agent, paged in time order', async () => {
      const person = await contact();
      const created: string[] = [];
      for (let i = 0; i < 3; i += 1) created.push((await book('owner', { attendeeContactIds: [person.id], agentMembershipId: members['agent2'] })).id);
      const from = new Date(Date.now() + 23 * 3_600_000).toISOString();
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { data: { id: string; scheduledStart: string }[]; page: { nextCursor: string | null } } } = await as('owner')
          .get(`/api/v1/viewings?limit=2&filter[agentMembershipId]=${members['agent2']}&filter[scheduledStart][gte]=${encodeURIComponent(from)}&filter[status]=scheduled,confirmed${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        seen.push(...page.body.data.map((v) => v.id));
        cursor = page.body.page.nextCursor;
      } while (cursor);
      for (const id of created) expect(seen).toContain(id);
      expect(new Set(seen).size).toBe(seen.length);
      const contactCalendar = await as('owner').get(`/api/v1/viewings?limit=100&filter[contactId]=${person.id}`).expect(200);
      expect(contactCalendar.body.data.map((v: { id: string }) => v.id).sort()).toEqual([...created].sort());
    });
  });

  describe('remaining rules and filters', () => {
    it('refuses unknown or archived leads, invisible or closed deals and archived attendees', async () => {
      const person = await contact();
      const fieldErrors = async (body: Record<string, unknown>) => {
        const res = await as('owner').post('/api/v1/viewings', { listingId, ...nextSlot(), attendeeContactIds: [person.id], ...body });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        return (res.body.errors as { field: string; code: string }[]).map((e) => `${e.field}:${e.code}`);
      };
      expect(await fieldErrors({ leadId: randomUUID() })).toContain('leadId:not-found');
      const lead = await as('owner').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'phone' }).expect(201);
      await fx.db.updateTable('leads').set({ archivedAt: new Date(), archivedReason: 'Duplicate' }).where('id', '=', lead.body.id).execute();
      expect(await fieldErrors({ leadId: lead.body.id })).toContain('leadId:archived');
      expect(await fieldErrors({ dealId: randomUUID() })).toContain('dealId:not-found');
      const lost = await fx.db
        .insertInto('deals')
        .values({
          companyId: company.companyId,
          reference: `DEA-S1-${randomUUID().slice(0, 8)}`,
          dealType: 'sale',
          stageId: (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', 'sale').where('code', '=', 'closed_lost').executeTakeFirstOrThrow()).id,
          stageClass: 'closed_lost',
          lostReasonCode: 'price',
          closedAt: new Date(),
          primaryContactId: person.id,
          officeId: company.officeId,
          ownerMembershipId: members['owner']!,
          currencyCode: 'GHS',
          listingId,
          unitId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect(await fieldErrors({ dealId: lost.id })).toContain('dealId:deal-closed');
      const gone = await contact();
      await fx.db.updateTable('contacts').set({ archivedAt: new Date(), archivedReason: 'Left the country' }).where('id', '=', gone.id).execute();
      expect(await fieldErrors({ attendeeContactIds: [gone.id] })).toContain('attendeeContactIds[0]:archived');
    });

    it('keeps a deal already past the viewing stage where it is', async () => {
      const person = await contact();
      const deal = await fx.db
        .insertInto('deals')
        .values({
          companyId: company.companyId,
          reference: `DEA-S1-${randomUUID().slice(0, 8)}`,
          dealType: 'sale',
          stageId: (await fx.db.selectFrom('pipelineStages').select('id').where('companyId', 'is', null).where('dealType', '=', 'sale').where('code', '=', 'negotiation').executeTakeFirstOrThrow()).id,
          stageClass: 'negotiation',
          primaryContactId: person.id,
          officeId: company.officeId,
          ownerMembershipId: members['owner']!,
          currencyCode: 'GHS',
          listingId,
          unitId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await book('owner', { dealId: deal.id, attendeeContactIds: [person.id] });
      expect((await fx.db.selectFrom('deals').select('stageClass').where('id', '=', deal.id).executeTakeFirstOrThrow()).stageClass).toBe('negotiation');
      const byDeal = await as('owner').get(`/api/v1/viewings?filter[dealId]=${deal.id}`).expect(200);
      expect(byDeal.body.data).toHaveLength(1);
    });

    it('confirms idempotently; reschedules only to the future, and to another agent only as a manager', async () => {
      const person = await contact('agent');
      const booked = await book('agent', { attendeeContactIds: [person.id] });
      const confirmed = await as('agent').action(`/api/v1/viewings/${booked.id}/confirm`, booked.version).expect(200);
      const again = await as('agent').action(`/api/v1/viewings/${booked.id}/confirm`, confirmed.body.version).expect(200);
      expect(again.body.version).toBe(confirmed.body.version);
      const past = await as('agent').action(`/api/v1/viewings/${booked.id}/reschedule`, again.body.version, { scheduledStart: inHours(-5), scheduledEnd: inHours(-4) });
      expect(past.status).toBe(422);
      const s = nextSlot();
      const notMine = await as('agent').action(`/api/v1/viewings/${booked.id}/reschedule`, again.body.version, { ...s, agentMembershipId: members['agent2'] });
      expect(notMine.status).toBe(422);
      expect(notMine.body.errors[0]).toMatchObject({ code: 'not-allowed' });
      const handed = await as('manager').action(`/api/v1/viewings/${booked.id}/reschedule`, again.body.version, { ...s, agentMembershipId: members['agent2'] }).expect(200);
      expect(handed.body.agent.id).toBe(members['agent2']);
    });

    it('checks attendance, feedback sharing and keys against the viewing\'s state', async () => {
      const person = await contact();
      const stranger = await contact();
      const past = await pastViewing(person.id);
      const wrong = await as('owner').action(`/api/v1/viewings/${past.id}/outcome`, past.version, { outcome: 'interested', attendance: [{ contactId: stranger.id, attendance: 'attended' }] });
      expect(wrong.status).toBe(422);
      expect(wrong.body.errors[0]).toMatchObject({ field: 'attendance[0].contactId', code: 'not-attendee' });
      const quiet = await as('owner').action(`/api/v1/viewings/${past.id}/outcome`, past.version, { outcome: 'interested' }).expect(200);
      await as('owner').action(`/api/v1/viewings/${past.id}/feedback-sharing`, quiet.body.version, { shared: true }).expect(422);
      const same = await as('owner').action(`/api/v1/viewings/${past.id}/feedback-sharing`, quiet.body.version, { shared: false }).expect(200);
      expect(same.body.version).toBe(quiet.body.version);
      const keySet = await as('owner').post(`/api/v1/properties/${propertyId}/key-sets`, { label: `K-${randomUUID().slice(0, 6)}` }).expect(201);
      const keys = await as('owner').post(`/api/v1/viewings/${past.id}/keys/check-out`, { keySetId: keySet.body.id });
      expect(keys.status).toBe(422);

      // Sharing at the time of recording emits the sharing event too.
      const shared = await pastViewing(person.id);
      await as('owner').action(`/api/v1/viewings/${shared.id}/outcome`, shared.version, { outcome: 'offer_expected', feedback: 'Happy with the price', shareFeedback: true }).expect(200);
      const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', shared.id).orderBy('entryNo').execute();
      expect(events.map((row) => row.eventType)).toEqual(['viewing.completed', 'viewing.feedback_shared']);
    });

    it('filters by lead and by date range end, excludes those needing an outcome, and refuses actions across companies', async () => {
      const person = await contact();
      const lead = await as('owner').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'phone' }).expect(201);
      const viewing = await book('owner', { leadId: lead.body.id });
      const byLead = await as('owner').get(`/api/v1/viewings?filter[leadId]=${lead.body.id}&filter[scheduledStart][lte]=${encodeURIComponent(inHours(10_000))}`).expect(200);
      expect(byLead.body.data.map((v: { id: string }) => v.id)).toEqual([viewing.id]);
      const settled = await as('owner').get(`/api/v1/viewings?limit=100&filter[needsOutcome]=false&filter[listingId]=${listingId}`).expect(200);
      expect(settled.body.data.every((v: { needsOutcome: boolean }) => !v.needsOutcome)).toBe(true);
      await as('otherOwner').action(`/api/v1/viewings/${viewing.id}/cancel`, viewing.version, { reason: 'Not ours' }).expect(404);
      // A manager with no office sees nothing under office scope.
      const officeless = await fx.member(company.companyId, { roleKey: 'sales_manager' });
      await fx.linkIdentity(officeless.userId, `s1-officeless-${company.companyId}`);
      tokens['officeless'] = await t.idp.token({ sub: `s1-officeless-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
      const none = await as('officeless').get('/api/v1/viewings?limit=100').expect(200);
      expect(none.body.data).toEqual([]);
    });
  });

  describe('keys for a viewing (readiness R7)', () => {
    it('checks keys out to the agent or an attendee, recording the viewing; refuses others', async () => {
      const person = await contact();
      const viewing = await book('owner', { attendeeContactIds: [person.id], agentMembershipId: members['agent'] });
      const keySet = await as('owner').post(`/api/v1/properties/${propertyId}/key-sets`, { label: `K-${randomUUID().slice(0, 6)}` }).expect(201);
      const outsider = await contact();
      const refused = await as('owner').post(`/api/v1/viewings/${viewing.id}/keys/check-out`, { keySetId: keySet.body.id, contactId: outsider.id });
      expect(refused.status).toBe(422);
      expect(refused.body.errors[0]).toMatchObject({ field: 'contactId', code: 'not-attendee' });
      const out = await as('owner').post(`/api/v1/viewings/${viewing.id}/keys/check-out`, { keySetId: keySet.body.id }).expect(200);
      expect(out.body.status).toBe('checked_out');
      const movements = await as('owner').get(`/api/v1/key-sets/${keySet.body.id}/movements`).expect(200);
      expect(movements.body.data[0]).toMatchObject({ movement: 'check_out', viewingId: viewing.id, holder: { type: 'member', id: members['agent'] } });

      const elsewhere = await newProperty('Key Villa');
      const wrongSet = await as('owner').post(`/api/v1/properties/${elsewhere.propertyId}/key-sets`, { label: `K-${randomUUID().slice(0, 6)}` }).expect(201);
      const wrong = await as('owner').post(`/api/v1/viewings/${viewing.id}/keys/check-out`, { keySetId: wrongSet.body.id });
      expect(wrong.status).toBe(422);
      expect(wrong.body.errors[0]).toMatchObject({ code: 'not-for-viewing' });
    });

    it('refuses a key check-out to a contact the member cannot see (contact scope)', async () => {
      // A contact of another office, outside the sales manager's office scope.
      const hidden = await fx.db
        .insertInto('contacts')
        .values({ companyId: company.companyId, contactType: 'person', displayName: 'Kumasi buyer', officeId: ksiOfficeId })
        .returning('id')
        .executeTakeFirstOrThrow();
      const keySet = await as('owner').post(`/api/v1/properties/${propertyId}/key-sets`, { label: `K-${randomUUID().slice(0, 6)}` }).expect(201);
      const res = await as('manager').action(`/api/v1/key-sets/${keySet.body.id}/check-out`, keySet.body.version, { holderContactId: hidden.id });
      // The sales manager's contact scope is the office.
      const scope = await fx.db
        .selectFrom('rolePermissions as rp')
        .innerJoin('roles as r', 'r.id', 'rp.roleId')
        .select('rp.scope')
        .where('r.key', '=', 'sales_manager')
        .where('r.companyId', 'is', null)
        .where('rp.permissionKey', '=', 'contact.view')
        .executeTakeFirst();
      expect(scope?.scope).toBe('office');
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.errors[0]).toMatchObject({ field: 'holderContactId', code: 'not-found' });
    });
  });

  describe('listings and privacy', () => {
    it('flags available listings with no viewing in 21 days, and clears the flag once one is booked', async () => {
      const quiet = await newProperty('Quiet Villa');
      const listing = await fx.listing(company.companyId, quiet.unitId, members['agent']!, company.officeId);
      await fx.db.updateTable('listings').set({ listedAt: sql<Date>`now() - interval '30 days'` }).where('id', '=', listing.id).execute();
      const flagged = await as('owner').get('/api/v1/listings?limit=100&filter[attention]=no-viewing').expect(200);
      expect(flagged.body.data.map((l: { id: string }) => l.id)).toContain(listing.id);
      const counts = await as('owner').get('/api/v1/dashboards/property/listings').expect(200);
      expect(counts.body.noViewing).toBeGreaterThanOrEqual(1);
      const person = await contact();
      await book('owner', { listingId: listing.id, attendeeContactIds: [person.id] });
      const after = await as('owner').get('/api/v1/listings?limit=100&filter[attention]=no-viewing').expect(200);
      expect(after.body.data.map((l: { id: string }) => l.id)).not.toContain(listing.id);
    });

    it('includes the person\'s viewings in their access report', async () => {
      const person = await contact();
      const past = await pastViewing(person.id);
      await as('owner').action(`/api/v1/viewings/${past.id}/outcome`, past.version, { outcome: 'offer_expected', feedback: 'Will bring her brother next time' }).expect(200);
      const created = await as('owner').post('/api/v1/privacy-requests', { contactId: person.id, requestType: 'access', channel: 'email', receivedOn: new Date().toISOString().slice(0, 10) }).expect(201);
      const path = `/api/v1/privacy-requests/${created.body.id}`;
      const verified = await as('owner').action(`${path}/verify-identity`, created.body.version, { method: 'documents_seen', note: 'Passport seen' }).expect(200);
      const working = await as('owner').action(`${path}/status`, verified.body.version, { status: 'in_progress' }).expect(200);
      const generated = await as('owner').action(`${path}/access-report`, working.body.version).expect(200);
      const link = await as('owner').post(`/api/v1/exports/${generated.body.accessReport.exportId}/download`).expect(200);
      const report = (await (await fetch(link.body.url)).json()) as { viewings: Record<string, unknown>[] };
      expect(report.viewings).toEqual([
        expect.objectContaining({ listingReference, status: 'completed', outcome: 'offer_expected', feedback: 'Will bring her brother next time', attendance: 'attended' }),
      ]);
    });

    it('erases viewing feedback with the person and keeps the facts', async () => {
      const person = await contact();
      const past = await pastViewing(person.id);
      await as('owner').action(`/api/v1/viewings/${past.id}/outcome`, past.version, { outcome: 'not_interested', feedback: 'Too far from her mother in Tema' }).expect(200);
      await fx.eraseContact(company.companyId, person.id);
      const after = await as('owner').get(`/api/v1/viewings/${past.id}`).expect(200);
      expect(after.body).toMatchObject({ status: 'completed', outcome: 'not_interested', feedback: '[Erased]', attendees: [{ contact: { name: 'Erased contact' } }] });
    });
  });
});

interface ViewingBody {
  id: string;
  version: number;
  status: string;
  scheduledStart: string;
  agent: { id: string };
  deal: { id: string } | null;
  attendees: { contact: { id: string; name: string }; attendance: string }[];
  unitConflicts: { id: string }[];
}
