import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { type Cursor, encodeCursor, type Page, type RangeValue } from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { canOnLead, memberGrant } from '../crm/lead-access.js';
import { LeadsService } from '../crm/leads.service.js';
import { recordSystemActivity } from '../crm/system-activity.js';
import type { Tx } from '../database/database.module.js';
import { KeysService } from '../keys/keys.service.js';
import type { KeySetDto } from '../keys/dto.js';
import { canOnViewing, type ViewingAccessRow, viewingScopeSql } from './viewing-access.js';
import type {
  BookViewingBody,
  RecordOutcomeBody,
  RescheduleViewingBody,
  ViewingConflictDto,
  ViewingDto,
  ViewingKeyCheckOutBody,
} from './viewings.dto.js';

registerConstraintMessages({
  viewings_company_id_agent_membership_id_tstzrange_excl: 'The agent already has a viewing at that time. Choose another time or agent.',
  viewings_cancel_reason: 'Give a reason for cancelling the viewing.',
});

/** Bookings may start a few minutes in the past (clock drift, a form left open). */
const PAST_TOLERANCE_MS = 5 * 60_000;
const MAX_DURATION_MS = 8 * 60 * 60_000;
const LIVE = ['scheduled', 'confirmed'] as const;
const LIVE_LISTING = ['available', 'reserved', 'under_contract'];
/** Deal stages before "viewing": a booked viewing moves the deal on (readiness report §4.1). */
const STAGES_BEFORE_VIEWING = ['lead', 'qualification'];

export interface ViewingListQuery {
  limit: number;
  cursor: Cursor | null;
  direction: 'asc' | 'desc';
  start: RangeValue | null;
  statuses: string[] | null;
  agentIds: string[] | null;
  listingId: string | null;
  leadId: string | null;
  dealId: string | null;
  contactId: string | null;
  needsOutcome: boolean | null;
}

type Row = Awaited<ReturnType<ReturnType<ViewingsService['baseQuery']>['executeTakeFirstOrThrow']>>;

/**
 * Viewings (Phase 6 milestone S1; SAL-02, journey step 7; readiness report
 * §4.1). Booking, confirming, rescheduling, cancelling and recording; the
 * agent calendar and "viewings needing feedback" are list filters. Integrity
 * rules live in the database (migrations 0007, 0030, 0031); this service
 * checks them first to answer with field-level reasons, and adds scope, the
 * effects on leads and deals, the timeline, audit and outbox events.
 */
@Injectable()
export class ViewingsService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly leads: LeadsService,
    private readonly keys: KeysService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, query: ViewingListQuery): Promise<Page<ViewingDto>> {
    let qb = this.baseQuery(tx)
      .select(sql<string>`v.scheduled_start::text`.as('cursorValue'))
      .where(viewingScopeSql(ctx.permissions.get('viewing.view')?.scope, ctx));
    if (query.start?.gte) qb = qb.where('v.scheduledStart', '>=', new Date(query.start.gte));
    if (query.start?.lte) qb = qb.where('v.scheduledStart', '<=', new Date(query.start.lte));
    if (query.statuses) qb = qb.where('v.status', 'in', query.statuses);
    if (query.agentIds) qb = qb.where('v.agentMembershipId', 'in', query.agentIds);
    if (query.listingId) qb = qb.where('v.listingId', '=', query.listingId);
    if (query.leadId) qb = qb.where('v.leadId', '=', query.leadId);
    if (query.dealId) qb = qb.where('v.dealId', '=', query.dealId);
    if (query.contactId) {
      qb = qb.where(sql<boolean>`exists (select 1 from viewing_attendees a where a.viewing_id = v.id and a.contact_id = ${query.contactId}::uuid)`);
    }
    if (query.needsOutcome === true) qb = qb.where('v.status', 'in', [...LIVE]).where('v.scheduledEnd', '<', sql<Date>`now()`);
    if (query.needsOutcome === false) qb = qb.where(sql<boolean>`not (v.status in ('scheduled', 'confirmed') and v.scheduled_end < now())`);
    if (query.cursor) {
      const operator = sql.raw(query.direction === 'asc' ? '>' : '<');
      qb = qb.where(sql<boolean>`(v.scheduled_start, v.id) ${operator} (${query.cursor.v}::timestamptz, ${query.cursor.id}::uuid)`);
    }
    const rows = await qb.orderBy('v.scheduledStart', query.direction).orderBy('v.id', query.direction).limit(query.limit + 1).execute();
    const page = rows.slice(0, query.limit);
    const data = await this.toDtos(tx, ctx, page);
    const last = page[page.length - 1];
    return { data, page: { limit: query.limit, nextCursor: rows.length > query.limit && last ? encodeCursor(last.cursorValue, last.id) : null } };
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<ViewingDto> {
    const row = await this.baseQuery(tx).where('v.id', '=', id).executeTakeFirst();
    if (!row || !canOnViewing(ctx, 'viewing.view', accessOf(row))) throw Problems.notFound();
    return (await this.toDtos(tx, ctx, [row]))[0]!;
  }

  // ----------------------------------------------------------------- booking

  async book(tx: Tx, ctx: TenantContext, body: BookViewingBody): Promise<ViewingDto> {
    const errors: FieldError[] = [];
    const listing = await this.liveListing(tx, body.listingId, errors);
    const lead = body.leadId ? await this.visibleLead(tx, ctx, body.leadId, errors) : null;
    const deal = body.dealId ? await this.openDeal(tx, ctx, body.dealId, body.listingId, errors) : null;
    const agentId = body.agentMembershipId ?? ctx.membershipId;
    const start = new Date(body.scheduledStart);
    const end = new Date(body.scheduledEnd);
    checkTimes(start, end, errors);
    const viewingType = body.viewingType ?? 'in_person';
    const attendeeIds = body.attendeeContactIds ?? (lead ? [lead.contactId] : []);
    if (viewingType !== 'open_house' && attendeeIds.length === 0) {
      errors.push({ field: 'attendeeContactIds', code: 'required', message: 'Add at least one attendee (an open house needs none).' });
    }
    await this.checkAttendees(tx, ctx, attendeeIds, errors);
    if (errors.length > 0 || !listing) throw Problems.validation(errors);

    const access: ViewingAccessRow = {
      agentMembershipId: agentId,
      listingOfficeId: listing.officeId,
      listingAgentId: listing.agentMembershipId,
      leadAssignedTo: lead?.assignedTo ?? null,
      dealOwnerId: deal?.ownerMembershipId ?? null,
    };
    await this.checkBookingRights(tx, ctx, access, agentId, 'agentMembershipId');
    await this.checkAgentFree(tx, agentId, start, end, null);

    const inserted = await tx
      .insertInto('viewings')
      .values({
        companyId: ctx.companyId,
        listingId: listing.id,
        unitId: listing.unitId,
        leadId: lead?.id ?? null,
        dealId: deal?.id ?? null,
        agentMembershipId: agentId,
        viewingType,
        scheduledStart: start,
        scheduledEnd: end,
        timezone: listing.timezone,
        status: body.confirmed ? 'confirmed' : 'scheduled',
        meetingPoint: emptyToNull(body.meetingPoint),
        createdBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.insertAttendees(tx, ctx, inserted.id, attendeeIds);

    // Effects (readiness report §4.1): a new lead is contacted; a deal reaches the viewing stage.
    if (lead) await this.leads.markContactedByViewing(tx, ctx, lead.id, listing.reference);
    if (deal) await this.advanceDeal(tx, deal);

    await recordSystemActivity(tx, ctx, {
      activityType: 'system',
      subject: `Viewing booked: ${listing.reference}, ${formatLocal(start, listing.timezone)}`,
      links: timelineLinks(listing.id, lead?.id ?? null, attendeeIds),
    });
    await this.audit.record(tx, ctx, {
      action: 'viewing.booked',
      entityType: 'viewing',
      entityId: inserted.id,
      metadata: {
        listingId: listing.id,
        agentMembershipId: agentId,
        leadId: lead?.id ?? null,
        dealId: deal?.id ?? null,
        viewingType,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        attendeeContactIds: attendeeIds,
        confirmed: body.confirmed === true,
      },
    });
    await this.emit(tx, ctx, 'viewing.booked', inserted.id, {
      listingId: listing.id,
      agentMembershipId: agentId,
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      timezone: listing.timezone,
      attendeeContactIds: attendeeIds,
      status: body.confirmed ? 'confirmed' : 'scheduled',
    });
    return this.get(tx, ctx, inserted.id);
  }

  async confirm(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<ViewingDto> {
    const current = await this.lockLive(tx, ctx, id, expectedVersion);
    if (current.status === 'confirmed') return this.get(tx, ctx, id);
    await tx.updateTable('viewings').set({ status: 'confirmed' }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'viewing.confirmed', entityType: 'viewing', entityId: id, changes: { status: { old: current.status, new: 'confirmed' } } });
    await this.emit(tx, ctx, 'viewing.confirmed', id, { scheduledStart: current.scheduledStart.toISOString(), timezone: current.timezone });
    return this.get(tx, ctx, id);
  }

  /** The old viewing is kept as rescheduled and points at a new one with the same attendees. */
  async reschedule(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: RescheduleViewingBody): Promise<ViewingDto> {
    const current = await this.lockLive(tx, ctx, id, expectedVersion);
    const errors: FieldError[] = [];
    const start = new Date(body.scheduledStart);
    const end = new Date(body.scheduledEnd);
    checkTimes(start, end, errors);
    const listing = await this.liveListing(tx, current.listingId, errors, 'scheduledStart');
    if (errors.length > 0 || !listing) throw Problems.validation(errors);
    const agentId = body.agentMembershipId ?? current.agentMembershipId;
    if (agentId !== current.agentMembershipId) {
      await this.checkBookingRights(tx, ctx, { ...accessOf(current), agentMembershipId: agentId }, agentId, 'agentMembershipId');
    }
    await this.checkAgentFree(tx, agentId, start, end, id);
    const attendees = await tx.selectFrom('viewingAttendees').select('contactId').where('viewingId', '=', id).execute();
    const newId = (await sql<{ id: string }>`select app.uuid_v7() as id`.execute(tx)).rows[0]!.id;
    // The link to the replacement is checked at commit (migration 0031), so the old viewing leaves the
    // agent's live slots before the new one takes its place.
    await tx.updateTable('viewings').set({ status: 'rescheduled', rescheduledToId: newId }).where('id', '=', id).execute();
    await tx
      .insertInto('viewings')
      .values({
        id: newId,
        companyId: ctx.companyId,
        listingId: current.listingId,
        unitId: current.unitId,
        leadId: current.leadId,
        dealId: current.dealId,
        agentMembershipId: agentId,
        viewingType: current.viewingType,
        scheduledStart: start,
        scheduledEnd: end,
        timezone: current.timezone,
        status: 'scheduled',
        meetingPoint: current.meetingPoint,
        createdBy: ctx.membershipId,
      })
      .execute();
    await this.insertAttendees(tx, ctx, newId, attendees.map((row) => row.contactId));
    await recordSystemActivity(tx, ctx, {
      activityType: 'system',
      subject: `Viewing rescheduled: ${listing.reference}, ${formatLocal(start, current.timezone)}`,
      body: body.reason ?? null,
      links: timelineLinks(current.listingId, current.leadId, attendees.map((row) => row.contactId)),
    });
    await this.audit.record(tx, ctx, {
      action: 'viewing.rescheduled',
      entityType: 'viewing',
      entityId: id,
      changes: { status: { old: current.status, new: 'rescheduled' } },
      metadata: {
        rescheduledToId: newId,
        reason: body.reason ?? null,
        from: { start: current.scheduledStart.toISOString(), end: current.scheduledEnd.toISOString(), agentMembershipId: current.agentMembershipId },
        to: { start: start.toISOString(), end: end.toISOString(), agentMembershipId: agentId },
      },
    });
    await this.emit(tx, ctx, 'viewing.rescheduled', id, {
      rescheduledToId: newId,
      agentMembershipId: agentId,
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      timezone: current.timezone,
      attendeeContactIds: attendees.map((row) => row.contactId),
    });
    return this.get(tx, ctx, newId);
  }

  async cancel(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<ViewingDto> {
    const current = await this.lockLive(tx, ctx, id, expectedVersion);
    await tx.updateTable('viewings').set({ status: 'cancelled', cancelledReason: reason }).where('id', '=', id).execute();
    const attendees = await this.attendeeIds(tx, id);
    await recordSystemActivity(tx, ctx, {
      activityType: 'system',
      subject: `Viewing cancelled: ${await this.listingReference(tx, current.listingId)}, ${formatLocal(current.scheduledStart, current.timezone)}`,
      body: reason,
      links: timelineLinks(current.listingId, current.leadId, attendees),
    });
    await this.audit.record(tx, ctx, { action: 'viewing.cancelled', entityType: 'viewing', entityId: id, changes: { status: { old: current.status, new: 'cancelled' } }, metadata: { reason } });
    await this.emit(tx, ctx, 'viewing.cancelled', id, { scheduledStart: current.scheduledStart.toISOString(), timezone: current.timezone, attendeeContactIds: attendees });
    return this.get(tx, ctx, id);
  }

  /** Outcome and feedback are final once recorded (P6-D3); corrections are timeline notes. */
  async recordOutcome(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: RecordOutcomeBody): Promise<ViewingDto> {
    const current = await this.lockLive(tx, ctx, id, expectedVersion);
    if (current.scheduledStart.getTime() > Date.now()) {
      throw Problems.validation([{ field: 'outcome', code: 'not-started', message: 'Record the outcome once the viewing has started.' }]);
    }
    const attendees = await this.attendeeIds(tx, id);
    const errors: FieldError[] = [];
    for (const [index, entry] of (body.attendance ?? []).entries()) {
      if (!attendees.includes(entry.contactId)) {
        errors.push({ field: `attendance[${index}].contactId`, code: 'not-attendee', message: 'This person is not an attendee of the viewing.' });
      }
    }
    const feedback = emptyToNull(body.feedback);
    if (body.shareFeedback && feedback === null) {
      errors.push({ field: 'shareFeedback', code: 'no-feedback', message: 'There is no feedback to share.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    const absent = new Set((body.attendance ?? []).filter((entry) => entry.attendance === 'absent').map((entry) => entry.contactId));
    for (const contactId of attendees) {
      await tx
        .updateTable('viewingAttendees')
        .set({ attendance: absent.has(contactId) ? 'absent' : 'attended' })
        .where('viewingId', '=', id)
        .where('contactId', '=', contactId)
        .execute();
    }
    await tx
      .updateTable('viewings')
      .set({ status: 'completed', outcome: body.outcome, feedback, sellerFeedbackShared: body.shareFeedback === true })
      .where('id', '=', id)
      .execute();
    await recordSystemActivity(tx, ctx, {
      activityType: 'system',
      subject: `Viewing completed: ${await this.listingReference(tx, current.listingId)}, outcome ${body.outcome.replaceAll('_', ' ')}`,
      links: timelineLinks(current.listingId, current.leadId, attendees),
    });
    await this.audit.record(tx, ctx, {
      action: 'viewing.completed',
      entityType: 'viewing',
      entityId: id,
      changes: { status: { old: current.status, new: 'completed' }, outcome: { old: null, new: body.outcome } },
      metadata: { feedback, absentContactIds: [...absent], feedbackShared: body.shareFeedback === true },
    });
    await this.emit(tx, ctx, 'viewing.completed', id, { outcome: body.outcome, feedbackShared: body.shareFeedback === true });
    if (body.shareFeedback) await this.emit(tx, ctx, 'viewing.feedback_shared', id, { shared: true });
    return this.get(tx, ctx, id);
  }

  async noShow(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, note: string | null): Promise<ViewingDto> {
    const current = await this.lockLive(tx, ctx, id, expectedVersion);
    if (current.scheduledStart.getTime() > Date.now()) {
      throw Problems.businessRule('A no-show is recorded once the viewing time has come.');
    }
    await tx.updateTable('viewingAttendees').set({ attendance: 'absent' }).where('viewingId', '=', id).execute();
    await tx.updateTable('viewings').set({ status: 'no_show' }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'viewing.no_show', entityType: 'viewing', entityId: id, changes: { status: { old: current.status, new: 'no_show' } }, metadata: { note } });
    await this.emit(tx, ctx, 'viewing.no_show', id, {});
    return this.get(tx, ctx, id);
  }

  /** The only change a finished viewing allows (migration 0030): whether the landlord sees the feedback. */
  async setFeedbackSharing(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, shared: boolean): Promise<ViewingDto> {
    const current = await this.lockManaged(tx, ctx, id, expectedVersion);
    if (current.status !== 'completed') throw Problems.businessRule('Feedback is shared once the viewing is completed.');
    if (shared && current.feedback === null) throw Problems.businessRule('This viewing has no feedback to share.');
    if (current.sellerFeedbackShared === shared) return this.get(tx, ctx, id);
    await tx.updateTable('viewings').set({ sellerFeedbackShared: shared }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'viewing.feedback_shared', entityType: 'viewing', entityId: id, changes: { feedbackShared: { old: current.sellerFeedbackShared, new: shared } } });
    await this.emit(tx, ctx, 'viewing.feedback_shared', id, { shared });
    return this.get(tx, ctx, id);
  }

  /** Key check-out for a live viewing: to its agent or to one of its attendees (key.issue on the property). */
  async checkOutKeys(tx: Tx, ctx: TenantContext, id: string, body: ViewingKeyCheckOutBody): Promise<KeySetDto> {
    const current = await this.lockManaged(tx, ctx, id, null);
    if (!(LIVE as readonly string[]).includes(current.status)) throw Problems.businessRule('Keys are checked out for a scheduled or confirmed viewing.');
    const keySet = await tx
      .selectFrom('keySets as k')
      .innerJoin('units as u', (join) => join.on('u.id', '=', current.unitId))
      .select(['k.id', 'k.version', 'k.propertyId', 'k.unitId', 'u.propertyId as viewingPropertyId'])
      .where('k.id', '=', body.keySetId)
      .executeTakeFirst();
    if (!keySet || keySet.propertyId !== keySet.viewingPropertyId || (keySet.unitId !== null && keySet.unitId !== current.unitId)) {
      throw Problems.validation([{ field: 'keySetId', code: 'not-for-viewing', message: 'Choose a key set for this property and unit.' }]);
    }
    if (body.contactId !== undefined && !(await this.attendeeIds(tx, id)).includes(body.contactId)) {
      throw Problems.validation([{ field: 'contactId', code: 'not-attendee', message: 'Keys go to the agent or to an attendee of the viewing.' }]);
    }
    const dueBackAt = body.dueBackAt ?? new Date(current.scheduledEnd.getTime() + 60 * 60_000).toISOString();
    return this.keys.checkOut(
      tx,
      ctx,
      keySet.id,
      keySet.version,
      body.contactId !== undefined
        ? { holderContactId: body.contactId, dueBackAt, note: 'For a viewing' }
        : { holderMembershipId: current.agentMembershipId, dueBackAt, note: 'For a viewing' },
      id,
    );
  }

  // ----------------------------------------------------------------- helpers

  private baseQuery(tx: Tx) {
    return tx
      .selectFrom('viewings as v')
      .innerJoin('listings as l', 'l.id', 'v.listingId')
      .innerJoin('units as u', 'u.id', 'v.unitId')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .innerJoin('companyMemberships as am', 'am.id', 'v.agentMembershipId')
      .innerJoin('users as au', 'au.id', 'am.userId')
      .leftJoin('leads as ld', 'ld.id', 'v.leadId')
      .leftJoin('deals as d', 'd.id', 'v.dealId')
      .leftJoin('companyMemberships as cm', 'cm.id', 'v.createdBy')
      .leftJoin('users as cu', 'cu.id', 'cm.userId')
      .selectAll('v')
      .select([
        'l.reference as listingReference',
        'l.title as listingTitle',
        'l.listingType',
        'l.officeId as listingOfficeId',
        'l.agentMembershipId as listingAgentId',
        'u.unitLabel',
        'p.id as propertyId',
        sql<string>`coalesce(p.name, p.reference)`.as('propertyName'),
        'au.displayName as agentName',
        'ld.reference as leadReference',
        'ld.assignedTo as leadAssignedTo',
        'd.reference as dealReference',
        'd.ownerMembershipId as dealOwnerId',
        'cu.displayName as createdByName',
        sql<string | null>`(select r.id from viewings r where r.rescheduled_to_id = v.id limit 1)`.as('rescheduledFromId'),
      ]);
  }

  private async toDtos(tx: Tx, ctx: TenantContext, rows: Row[]): Promise<ViewingDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const attendees = await tx
      .selectFrom('viewingAttendees as a')
      .innerJoin('contacts as c', 'c.id', 'a.contactId')
      .select(['a.viewingId', 'a.contactId', 'c.displayName', 'a.attendance'])
      .where('a.viewingId', 'in', ids)
      .orderBy('c.displayName')
      .execute();
    const live = rows.filter((row) => (LIVE as readonly string[]).includes(row.status));
    const conflicts =
      live.length === 0
        ? []
        : await tx
            .selectFrom('viewings as o')
            .innerJoin('viewings as v', (join) => join.on('v.id', 'in', live.map((row) => row.id)).onRef('o.unitId', '=', 'v.unitId').onRef('o.id', '<>', 'v.id'))
            .innerJoin('companyMemberships as om', 'om.id', 'o.agentMembershipId')
            .innerJoin('users as ou', 'ou.id', 'om.userId')
            .select(['v.id as viewingId', 'o.id', 'o.scheduledStart', 'o.scheduledEnd', 'o.agentMembershipId', 'ou.displayName as agentName'])
            .where('o.status', 'in', [...LIVE])
            .where(sql<boolean>`tstzrange(o.scheduled_start, o.scheduled_end) && tstzrange(v.scheduled_start, v.scheduled_end)`)
            .execute();
    const now = Date.now();
    return rows.map((row) => {
      const isLive = (LIVE as readonly string[]).includes(row.status);
      return {
        id: row.id,
        listing: { id: row.listingId, reference: row.listingReference, title: row.listingTitle, listingType: row.listingType },
        place: { propertyId: row.propertyId, propertyName: row.propertyName, unitId: row.unitId, unitLabel: row.unitLabel },
        agent: { id: row.agentMembershipId, name: row.agentName },
        lead: row.leadId !== null ? { id: row.leadId, reference: row.leadReference ?? '' } : null,
        deal: row.dealId !== null ? { id: row.dealId, reference: row.dealReference ?? '' } : null,
        viewingType: row.viewingType,
        status: row.status,
        scheduledStart: row.scheduledStart.toISOString(),
        scheduledEnd: row.scheduledEnd.toISOString(),
        timezone: row.timezone,
        meetingPoint: row.meetingPoint,
        attendees: attendees
          .filter((a) => a.viewingId === row.id)
          .map((a) => ({ contact: { id: a.contactId, name: a.displayName }, attendance: a.attendance })),
        outcome: row.outcome,
        feedback: row.feedback,
        feedbackShared: row.sellerFeedbackShared,
        cancelledReason: row.cancelledReason,
        rescheduledToId: row.rescheduledToId,
        rescheduledFromId: row.rescheduledFromId,
        needsOutcome: isLive && row.scheduledEnd.getTime() < now,
        unitConflicts: conflicts
          .filter((c) => c.viewingId === row.id)
          .map(
            (c): ViewingConflictDto => ({
              id: c.id,
              scheduledStart: c.scheduledStart.toISOString(),
              scheduledEnd: c.scheduledEnd.toISOString(),
              agent: { id: c.agentMembershipId, name: c.agentName },
            }),
          ),
        canManage: canOnViewing(ctx, 'viewing.manage', accessOf(row)),
        createdBy: row.createdBy !== null ? { id: row.createdBy, name: row.createdByName ?? '' } : null,
        createdAt: row.createdAt.toISOString(),
        version: row.version,
      };
    });
  }

  /** A viewing the member can manage, locked, at the expected version. */
  private async lockManaged(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number | null) {
    const row = await this.baseQuery(tx).where('v.id', '=', id).forUpdate('v').executeTakeFirst();
    if (!row || !canOnViewing(ctx, 'viewing.view', accessOf(row))) throw Problems.notFound();
    if (!canOnViewing(ctx, 'viewing.manage', accessOf(row))) throw Problems.forbidden('Your role does not allow managing this viewing.');
    if (expectedVersion !== null && row.version !== expectedVersion) throw Problems.preconditionFailed();
    return row;
  }

  private async lockLive(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number) {
    const row = await this.lockManaged(tx, ctx, id, expectedVersion);
    if (!(LIVE as readonly string[]).includes(row.status)) {
      throw Problems.businessRule(`This viewing is ${row.status.replace('_', '-')} and cannot change. Book a new one instead.`);
    }
    return row;
  }

  private async liveListing(tx: Tx, listingId: string, errors: FieldError[], field = 'listingId') {
    const listing = await tx
      .selectFrom('listings as l')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .select(['l.id', 'l.reference', 'l.status', 'l.archivedAt', 'l.unitId', 'l.officeId', 'l.agentMembershipId', 'u.availability', 'p.timezone'])
      .where('l.id', '=', listingId)
      .executeTakeFirst();
    if (!listing) {
      errors.push({ field, code: 'not-found', message: 'Choose a listing of this company.' });
      return null;
    }
    if (!LIVE_LISTING.includes(listing.status) || listing.archivedAt !== null) {
      errors.push({ field, code: 'listing-not-live', message: 'Viewings are booked on live listings (available, reserved or under contract).' });
    }
    if (listing.availability === 'under_maintenance') {
      errors.push({ field, code: 'unit-under-maintenance', message: 'The unit is under maintenance.' });
    }
    return listing;
  }

  private async visibleLead(tx: Tx, ctx: TenantContext, leadId: string, errors: FieldError[]) {
    const lead = await this.leads.accessRow(tx, leadId);
    if (!lead || !canOnLead(ctx, 'lead.view', lead)) {
      errors.push({ field: 'leadId', code: 'not-found', message: 'Choose a lead you can see.' });
      return null;
    }
    if (lead.archivedAt !== null) {
      errors.push({ field: 'leadId', code: 'archived', message: 'This lead is archived.' });
      return null;
    }
    return lead;
  }

  /** An open deal the member can see (deal.view scope: own deals, office deals, or all), for the same listing. */
  private async openDeal(tx: Tx, ctx: TenantContext, dealId: string, listingId: string, errors: FieldError[]) {
    const deal = await tx
      .selectFrom('deals')
      .select(['id', 'reference', 'status', 'listingId', 'officeId', 'ownerMembershipId', 'dealType', 'stageClass'])
      .where('id', '=', dealId)
      .executeTakeFirst();
    const scope = ctx.permissions.get('deal.view')?.scope;
    const visible =
      deal !== undefined &&
      (scope === 'all' ||
        (scope === 'office' && deal.officeId !== null && ctx.officeIds.includes(deal.officeId)) ||
        (scope === 'own' && deal.ownerMembershipId === ctx.membershipId));
    if (!deal || !visible) {
      errors.push({ field: 'dealId', code: 'not-found', message: 'Choose a deal you can see.' });
      return null;
    }
    if (deal.status !== 'open') errors.push({ field: 'dealId', code: 'deal-closed', message: 'This deal is closed.' });
    if (deal.listingId !== null && deal.listingId !== listingId) {
      errors.push({ field: 'dealId', code: 'deal-listing-mismatch', message: 'This deal is for another listing.' });
    }
    return deal;
  }

  /** Attendees: contacts the member can see, not archived. */
  private async checkAttendees(tx: Tx, ctx: TenantContext, contactIds: string[], errors: FieldError[]): Promise<void> {
    for (const [index, contactId] of contactIds.entries()) {
      const contact = await this.contacts.loadRow(tx, contactId);
      if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) {
        errors.push({ field: `attendeeContactIds[${index}]`, code: 'not-found', message: 'Choose contacts you can see.' });
      } else if (contact.archivedAt !== null || contact.isAnonymised) {
        errors.push({ field: `attendeeContactIds[${index}]`, code: 'archived', message: 'This contact is archived.' });
      }
    }
  }

  /**
   * The booker's viewing.manage scope must cover what is booked: with own
   * scope, their listing, a lead assigned to them or a deal they own (who
   * conducts it does not count). Booking for another agent is a manager action
   * (office or company scope); that agent must be active staff with
   * viewing.manage, in one of an office manager's offices.
   */
  private async checkBookingRights(tx: Tx, ctx: TenantContext, access: ViewingAccessRow, agentId: string, field: string): Promise<void> {
    if (!canOnViewing(ctx, 'viewing.manage', { ...access, agentMembershipId: '' })) {
      throw Problems.forbidden('Your role does not allow booking viewings for this listing.');
    }
    if (agentId === ctx.membershipId) return;
    const scope = ctx.permissions.get('viewing.manage')?.scope;
    if (scope !== 'all' && scope !== 'office') {
      throw Problems.validation([{ field, code: 'not-allowed', message: 'You can only book viewings you conduct yourself.' }]);
    }
    const grant = await memberGrant(tx, agentId, 'viewing.manage');
    if (!grant || grant.scope === null || (scope === 'office' && !grant.officeIds.some((office) => ctx.officeIds.includes(office)))) {
      throw Problems.validation([{ field, code: 'not-assignable', message: 'Choose an active agent in your team.' }]);
    }
  }

  /** The database refuses overlapping live viewings for one agent; checked first to answer clearly. */
  private async checkAgentFree(tx: Tx, agentId: string, start: Date, end: Date, ignoreId: string | null): Promise<void> {
    let qb = tx
      .selectFrom('viewings')
      .select('id')
      .where('agentMembershipId', '=', agentId)
      .where('status', 'in', [...LIVE])
      .where(sql<boolean>`tstzrange(scheduled_start, scheduled_end) && tstzrange(${start}::timestamptz, ${end}::timestamptz)`);
    if (ignoreId) qb = qb.where('id', '<>', ignoreId);
    const clash = await qb.executeTakeFirst();
    if (clash) {
      throw Problems.conflict('The agent already has a viewing at that time. Choose another time or agent.', { type: 'viewing', id: clash.id });
    }
  }

  private async insertAttendees(tx: Tx, ctx: TenantContext, viewingId: string, contactIds: string[]): Promise<void> {
    if (contactIds.length === 0) return;
    await tx
      .insertInto('viewingAttendees')
      .values(contactIds.map((contactId) => ({ companyId: ctx.companyId, viewingId, contactId })))
      .execute();
  }

  /** A deal before the viewing stage moves to its pipeline's viewing stage (stage history by the database). */
  private async advanceDeal(tx: Tx, deal: { id: string; dealType: string; stageClass: string }): Promise<void> {
    if (!STAGES_BEFORE_VIEWING.includes(deal.stageClass)) return;
    const stage = await tx
      .selectFrom('pipelineStages')
      .select('id')
      .where('dealType', '=', deal.dealType)
      .where('stageClass', '=', 'viewing')
      .where('isActive', '=', true)
      .orderBy(sql`company_id is null`)
      .orderBy('sortOrder')
      .executeTakeFirst();
    if (!stage) return;
    await sql`select set_config('app.stage_note', 'Viewing booked', true)`.execute(tx);
    await tx.updateTable('deals').set({ stageId: stage.id }).where('id', '=', deal.id).execute();
  }

  private async attendeeIds(tx: Tx, viewingId: string): Promise<string[]> {
    return (await tx.selectFrom('viewingAttendees').select('contactId').where('viewingId', '=', viewingId).execute()).map((row) => row.contactId);
  }

  private async listingReference(tx: Tx, listingId: string): Promise<string> {
    return (await tx.selectFrom('listings').select('reference').where('id', '=', listingId).executeTakeFirstOrThrow()).reference;
  }

  /** Outbox events for the reminders and notifications delivered in Phase 12 (P6-D14). */
  private async emit(tx: Tx, ctx: TenantContext, eventType: string, viewingId: string, payload: Record<string, unknown>): Promise<void> {
    await this.audit.emit(tx, ctx, { eventType, aggregateType: 'viewing', aggregateId: viewingId, payload: { viewingId, ...payload } });
  }
}

function accessOf(row: {
  agentMembershipId: string;
  listingOfficeId: string;
  listingAgentId: string;
  leadAssignedTo: string | null;
  dealOwnerId: string | null;
}): ViewingAccessRow {
  return {
    agentMembershipId: row.agentMembershipId,
    listingOfficeId: row.listingOfficeId,
    listingAgentId: row.listingAgentId,
    leadAssignedTo: row.leadAssignedTo,
    dealOwnerId: row.dealOwnerId,
  };
}

/** New times: from now on, the end after the start, at most 8 hours. */
function checkTimes(start: Date, end: Date, errors: FieldError[]): void {
  if (start.getTime() < Date.now() - PAST_TOLERANCE_MS) errors.push({ field: 'scheduledStart', code: 'in-past', message: 'Choose a time from now on.' });
  if (end.getTime() <= start.getTime()) errors.push({ field: 'scheduledEnd', code: 'before-start', message: 'The end must be after the start.' });
  else if (end.getTime() - start.getTime() > MAX_DURATION_MS) errors.push({ field: 'scheduledEnd', code: 'too-long', message: 'A viewing lasts at most 8 hours.' });
}

function timelineLinks(listingId: string, leadId: string | null, contactIds: string[]) {
  return [
    { entityType: 'listing' as const, entityId: listingId },
    ...(leadId ? [{ entityType: 'lead' as const, entityId: leadId }] : []),
    ...contactIds.map((contactId) => ({ entityType: 'contact' as const, entityId: contactId })),
  ];
}

/** Date and time in the property's time zone, with the zone name (readiness report §4.1). */
function formatLocal(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant);
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
