import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { contactWithinScope, scopeFor } from '../contacts/contact-access.js';
import { ContactsService } from '../contacts/contacts.service.js';
import type { Tx } from '../database/database.module.js';
import { listingScopeSql } from '../listings/listing-access.js';
import { propertyCovered } from '../properties/property-access.js';
import { checkPicklistCode } from '../reference/picklists.js';
import {
  type ActivityDetailDto,
  type ActivityDto,
  type EditActivityBody,
  EDIT_WINDOW_HOURS,
  type LogActivityBody,
} from './activities.dto.js';
import { canOnLead } from './lead-access.js';
import { LeadsService } from './leads.service.js';
import type { ActivityLink } from './system-activity.js';

/** Logged contact that counts as answering a lead (sets leads.first_response_at). */
const RESPONSE_TYPES = ['call', 'email', 'sms', 'whatsapp'];

interface TimelineQuery {
  limit: number;
  cursor: { t: string; n: string } | null;
  types: string[] | null;
  includeArchived: boolean;
}

/**
 * The activity timeline (CRM-04; wireframes A-1, A-2; decision D5). An
 * activity is visible to members who can read a contact or lead it is linked
 * to. Logging needs write access to what it is about. Authors may edit their
 * own entries for 24 hours (earlier versions are kept); after that entries can
 * only be archived. System entries never change. Phase 5 records
 * communications; it does not send them.
 */
@Injectable()
export class ActivitiesService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- reading

  async contactTimeline(tx: Tx, ctx: TenantContext, contactId: string, query: TimelineQuery) {
    const contact = await this.contacts.loadRow(tx, contactId);
    if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) throw Problems.notFound();
    return this.timeline(tx, ctx, 'contact', contactId, query);
  }

  async leadTimeline(tx: Tx, ctx: TenantContext, leadId: string, query: TimelineQuery) {
    const lead = await this.leads.accessRow(tx, leadId);
    if (!lead || !canOnLead(ctx, 'lead.view', lead)) throw Problems.notFound();
    return this.timeline(tx, ctx, 'lead', leadId, query);
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<ActivityDetailDto> {
    const links = await this.readableLinks(tx, ctx, id);
    const [row] = await this.load(tx, [id]);
    const revisions = await tx
      .selectFrom('activityRevisions as r')
      .leftJoin('companyMemberships as m', 'm.id', 'r.editedBy')
      .leftJoin('users as u', 'u.id', 'm.userId')
      .select(['r.revisionNo', 'r.subject', 'r.body', 'r.outcomeCode', 'r.direction', 'r.occurredAt', 'r.durationSeconds', 'r.editedBy', 'u.displayName as editedByName', 'r.editedAt'])
      .where('r.activityId', '=', id)
      .orderBy('r.revisionNo')
      .execute();
    return {
      ...(await this.toDto(tx, ctx, row!, links)),
      revisions: revisions.map((r) => ({
        revisionNo: r.revisionNo,
        subject: r.subject,
        body: r.body,
        outcomeCode: r.outcomeCode,
        direction: r.direction,
        occurredAt: r.occurredAt.toISOString(),
        durationSeconds: r.durationSeconds,
        editedBy: r.editedBy !== null ? { id: r.editedBy, name: r.editedByName ?? '' } : null,
        editedAt: r.editedAt.toISOString(),
      })),
    };
  }

  // ----------------------------------------------------------------- writing

  async log(tx: Tx, ctx: TenantContext, body: LogActivityBody): Promise<ActivityDetailDto> {
    const errors: FieldError[] = [];
    const direction = body.activityType === 'note' ? 'internal' : body.direction;
    if (body.activityType === 'note' && body.direction !== undefined && body.direction !== 'internal') {
      errors.push({ field: 'direction', code: 'not-applicable', message: 'Notes have no direction.' });
    }
    if (body.activityType !== 'note' && (direction === undefined || direction === 'internal')) {
      errors.push({ field: 'direction', code: 'required', message: 'Say whether it was inbound or outbound.' });
    }
    if (body.activityType === 'note' && !body.body) errors.push({ field: 'body', code: 'required', message: 'Write the note.' });
    if (body.durationSeconds != null && !['call', 'meeting'].includes(body.activityType)) {
      errors.push({ field: 'durationSeconds', code: 'not-applicable', message: 'Only calls and meetings have a duration.' });
    }
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) errors.push({ field: 'occurredAt', code: 'in-future', message: 'Log activities that have happened.' });
    if (body.outcomeCode) await this.checkOutcome(tx, ctx, body.outcomeCode, errors);
    const performedBy = body.performedBy ?? ctx.membershipId;
    if (performedBy !== ctx.membershipId) {
      const member = await tx
        .selectFrom('companyMemberships')
        .select('id')
        .where('id', '=', performedBy)
        .where('status', '=', 'active')
        .where('membershipType', '=', 'staff')
        .executeTakeFirst();
      if (!member) errors.push({ field: 'performedBy', code: 'not-found', message: 'Choose an active team member.' });
    }
    const links = await this.checkLinks(tx, ctx, body.links, errors);
    if (errors.length > 0) throw Problems.validation(errors);

    const activity = await tx
      .insertInto('activities')
      .values({
        companyId: ctx.companyId,
        activityType: body.activityType,
        direction: direction ?? 'internal',
        subject: emptyToNull(body.subject),
        body: emptyToNull(body.body),
        occurredAt,
        durationSeconds: body.durationSeconds ?? null,
        outcomeCode: body.outcomeCode ?? null,
        performedBy,
        createdBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('activityLinks')
      .values(links.map((link) => ({ companyId: ctx.companyId, activityId: activity.id, entityType: link.entityType, entityId: link.entityId })))
      .execute();

    // The first outbound contact or meeting answers a lead (response target, D3).
    const leadIds = links.filter((link) => link.entityType === 'lead').map((link) => link.entityId);
    const answers = body.activityType === 'meeting' || (RESPONSE_TYPES.includes(body.activityType) && direction === 'outbound');
    const answered: string[] = [];
    if (answers && leadIds.length > 0) {
      const updated = await tx
        .updateTable('leads')
        .set({ firstResponseAt: occurredAt })
        .where('id', 'in', leadIds)
        .where('firstResponseAt', 'is', null)
        .where('receivedAt', '<=', occurredAt)
        .returning('id')
        .execute();
      answered.push(...updated.map((row) => row.id));
    }
    await this.audit.record(tx, ctx, {
      action: 'activity.logged',
      entityType: 'activity',
      entityId: activity.id,
      metadata: { activityType: body.activityType, direction: direction ?? 'internal', links, performedBy, firstResponseFor: answered },
    });
    return this.get(tx, ctx, activity.id);
  }

  /** Author-only edit within the window (D5); the previous content is kept as a revision. */
  async edit(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: EditActivityBody): Promise<ActivityDetailDto> {
    await this.readableLinks(tx, ctx, id);
    const current = await tx.selectFrom('activities').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.isSystem === true) throw Problems.businessRule('System entries cannot be edited.');
    if (current.createdBy !== ctx.membershipId) throw Problems.forbidden('Only the person who logged an activity can edit it.');
    if (current.archivedAt !== null) throw Problems.businessRule('Archived activities cannot be edited.');
    if (Date.now() > editableUntil(current.createdAt).getTime()) {
      throw Problems.businessRule(`Activities can be edited for ${EDIT_WINDOW_HOURS} hours after logging. Archive it with a reason and log a correction instead.`);
    }
    const errors: FieldError[] = [];
    const next = {
      subject: body.subject === undefined ? current.subject : emptyToNull(body.subject),
      body: body.body === undefined ? current.body : emptyToNull(body.body),
      outcomeCode: body.outcomeCode === undefined ? current.outcomeCode : body.outcomeCode,
      direction: body.direction ?? current.direction,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : current.occurredAt,
      durationSeconds: body.durationSeconds === undefined ? current.durationSeconds : body.durationSeconds,
    };
    if (current.activityType === 'note' && next.direction !== 'internal') errors.push({ field: 'direction', code: 'not-applicable', message: 'Notes have no direction.' });
    if (current.activityType !== 'note' && next.direction === 'internal') errors.push({ field: 'direction', code: 'required', message: 'Say whether it was inbound or outbound.' });
    if (current.activityType === 'note' && !next.body) errors.push({ field: 'body', code: 'required', message: 'Write the note.' });
    if (next.durationSeconds !== null && !['call', 'meeting'].includes(current.activityType)) {
      errors.push({ field: 'durationSeconds', code: 'not-applicable', message: 'Only calls and meetings have a duration.' });
    }
    if (next.occurredAt.getTime() > Date.now() + 5 * 60_000) errors.push({ field: 'occurredAt', code: 'in-future', message: 'Log activities that have happened.' });
    if (body.outcomeCode && body.outcomeCode !== current.outcomeCode) await this.checkOutcome(tx, ctx, body.outcomeCode, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((key) =>
      key === 'occurredAt' ? next.occurredAt.getTime() !== current.occurredAt.getTime() : next[key] !== current[key],
    );
    if (changed.length === 0) return this.get(tx, ctx, id);

    const previous = await tx.selectFrom('activityRevisions').select(sql<number>`coalesce(max(revision_no), 0)`.as('n')).where('activityId', '=', id).executeTakeFirstOrThrow();
    await tx
      .insertInto('activityRevisions')
      .values({
        companyId: ctx.companyId,
        activityId: id,
        revisionNo: Number(previous.n) + 1,
        subject: current.subject,
        body: current.body,
        outcomeCode: current.outcomeCode,
        direction: current.direction,
        occurredAt: current.occurredAt,
        durationSeconds: current.durationSeconds,
        editedBy: ctx.membershipId,
      })
      .execute();
    await tx.updateTable('activities').set(next).where('id', '=', id).execute();
    // Content is personal data: the audit entry names the fields, the revision keeps the text.
    await this.audit.record(tx, ctx, { action: 'activity.edited', entityType: 'activity', entityId: id, metadata: { fields: changed, revisionNo: Number(previous.n) + 1 } });
    return this.get(tx, ctx, id);
  }

  /** Archive with a reason: the author, or a manager over a linked record. */
  async archive(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<ActivityDetailDto> {
    const links = await this.readableLinks(tx, ctx, id);
    const current = await tx.selectFrom('activities').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.isSystem === true) throw Problems.businessRule('System entries cannot be archived.');
    if (current.archivedAt !== null) throw Problems.businessRule('This activity is already archived.');
    if (!(await this.mayArchive(tx, ctx, current.createdBy, links))) throw Problems.forbidden('Only the author or a manager can archive this activity.');
    await tx.updateTable('activities').set({ archivedAt: sql<Date>`now()`, archivedBy: ctx.membershipId, archivedReason: reason }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'activity.archived', entityType: 'activity', entityId: id, metadata: { reason } });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- helpers

  private async timeline(tx: Tx, ctx: TenantContext, entityType: 'contact' | 'lead', entityId: string, query: TimelineQuery) {
    let qb = tx
      .selectFrom('activities as a')
      .select(['a.id', sql<string>`a.occurred_at::text`.as('t'), sql<string>`a.entry_no::text`.as('n')])
      .where(
        'a.id',
        'in',
        tx.selectFrom('activityLinks').select('activityId').where('entityType', '=', entityType).where('entityId', '=', entityId),
      );
    if (!query.includeArchived) qb = qb.where('a.archivedAt', 'is', null);
    if (query.types) qb = qb.where('a.activityType', 'in', query.types);
    if (query.cursor) qb = qb.where(sql<boolean>`(a.occurred_at, a.entry_no) < (${query.cursor.t}::timestamptz, ${query.cursor.n}::bigint)`);
    const keys = await qb.orderBy('a.occurredAt', 'desc').orderBy('a.entryNo', 'desc').limit(query.limit + 1).execute();
    const page = keys.slice(0, query.limit);
    const rows = await this.load(tx, page.map((key) => key.id));
    const links = await this.linksFor(tx, page.map((key) => key.id));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const data: ActivityDto[] = [];
    for (const key of page) data.push(await this.toDto(tx, ctx, byId.get(key.id)!, links.get(key.id) ?? []));
    const last = page[page.length - 1];
    return {
      data,
      page: {
        limit: query.limit,
        nextCursor: keys.length > query.limit && last ? Buffer.from(JSON.stringify({ t: last.t, n: last.n })).toString('base64url') : null,
      },
    };
  }

  private load(tx: Tx, ids: string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return tx
      .selectFrom('activities as a')
      .leftJoin('companyMemberships as pm', 'pm.id', 'a.performedBy')
      .leftJoin('users as pu', 'pu.id', 'pm.userId')
      .leftJoin('companyMemberships as cm', 'cm.id', 'a.createdBy')
      .leftJoin('users as cu', 'cu.id', 'cm.userId')
      .selectAll('a')
      .select(['pu.displayName as performedByName', 'cu.displayName as createdByName'])
      .where('a.id', 'in', ids)
      .execute();
  }

  /** Links of the activity, after checking the member can read one of its contacts or leads (else 404). */
  private async readableLinks(tx: Tx, ctx: TenantContext, id: string) {
    const links = (await this.linksFor(tx, [id])).get(id) ?? [];
    for (const link of links) {
      if (link.entityType === 'contact') {
        const contact = await this.contacts.loadRow(tx, link.entityId);
        if (contact && (await this.contacts.canRead(tx, ctx, contact))) return links;
      } else if (link.entityType === 'lead') {
        const lead = await this.leads.accessRow(tx, link.entityId);
        if (lead && canOnLead(ctx, 'lead.view', lead)) return links;
      }
    }
    throw Problems.notFound();
  }

  private async linksFor(tx: Tx, ids: string[]) {
    const result = new Map<string, Array<{ entityType: string; entityId: string; label: string }>>();
    if (ids.length === 0) return result;
    const { rows } = await sql<{ activityId: string; entityType: string; entityId: string; label: string | null }>`
      select k.activity_id, k.entity_type, k.entity_id,
             case k.entity_type
               when 'contact'  then (select c.display_name from contacts c where c.id = k.entity_id)
               when 'lead'     then (select l.reference from leads l where l.id = k.entity_id)
               when 'listing'  then (select li.reference from listings li where li.id = k.entity_id)
               when 'property' then (select coalesce(p.name, p.reference) from properties p where p.id = k.entity_id)
             end as label
        from activity_links k
       where k.activity_id = any(${ids}::uuid[])
       order by k.entity_type, k.entity_id`.execute(tx);
    for (const row of rows) {
      const list = result.get(row.activityId) ?? [];
      list.push({ entityType: row.entityType, entityId: row.entityId, label: row.label ?? '' });
      result.set(row.activityId, list);
    }
    return result;
  }

  private async toDto(
    tx: Tx,
    ctx: TenantContext,
    row: Awaited<ReturnType<ActivitiesService['load']>>[number],
    links: Array<{ entityType: string; entityId: string; label: string }>,
  ): Promise<ActivityDto> {
    const until = editableUntil(row.createdAt);
    const open = !row.isSystem && row.archivedAt === null;
    return {
      id: row.id,
      activityType: row.activityType,
      direction: row.direction,
      subject: row.subject,
      body: row.body,
      occurredAt: row.occurredAt.toISOString(),
      durationSeconds: row.durationSeconds,
      outcomeCode: row.outcomeCode,
      performedBy: row.performedBy !== null ? { id: row.performedBy, name: row.performedByName ?? '' } : null,
      createdBy: row.createdBy !== null ? { id: row.createdBy, name: row.createdByName ?? '' } : null,
      links,
      isSystem: row.isSystem === true,
      editedAt: row.editedAt?.toISOString() ?? null,
      editableUntil: open ? until.toISOString() : null,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      archivedReason: row.archivedReason,
      canEdit: open && row.createdBy === ctx.membershipId && Date.now() <= until.getTime(),
      canArchive: open && (await this.mayArchive(tx, ctx, row.createdBy, links)),
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  private async mayArchive(tx: Tx, ctx: TenantContext, createdBy: string | null, links: Array<{ entityType: string; entityId: string }>): Promise<boolean> {
    if (createdBy === ctx.membershipId) return true;
    for (const link of links) {
      if (link.entityType === 'lead') {
        const lead = await this.leads.accessRow(tx, link.entityId);
        if (lead && canOnLead(ctx, 'lead.assign', lead)) return true;
      } else if (link.entityType === 'contact') {
        const scope = scopeFor(ctx, 'contact.archive');
        const contact = scope === null ? undefined : await this.contacts.loadRow(tx, link.entityId);
        if (contact && scope !== null && contactWithinScope(scope, ctx, contact)) return true;
      }
    }
    return false;
  }

  /**
   * Every link must exist and be visible. Contacts and leads need write
   * access: lead.update on a lead; contact.update on a contact, or a linked
   * lead of that contact the member may update (an agent logging a call on
   * their lead). A lead also links its contact, so the contact's timeline
   * shows it.
   */
  private async checkLinks(tx: Tx, ctx: TenantContext, input: LogActivityBody['links'], errors: FieldError[]): Promise<ActivityLink[]> {
    const unique = new Map(input.map((link) => [`${link.entityType}:${link.entityId}`, link]));
    const links = [...unique.values()];
    const writableLeadContacts = new Set<string>();
    const result: ActivityLink[] = [];
    for (const [index, link] of links.entries()) {
      if (link.entityType !== 'lead') continue;
      const lead = await this.leads.accessRow(tx, link.entityId);
      if (!lead || !canOnLead(ctx, 'lead.view', lead)) {
        errors.push({ field: `links[${index}].entityId`, code: 'not-found', message: 'Choose a lead you can see.' });
      } else if (!canOnLead(ctx, 'lead.update', lead)) {
        errors.push({ field: `links[${index}].entityId`, code: 'forbidden', message: 'You cannot log activities on this lead.' });
      } else if (lead.archivedAt !== null) {
        errors.push({ field: `links[${index}].entityId`, code: 'archived', message: 'This lead is archived.' });
      } else {
        writableLeadContacts.add(lead.contactId);
        result.push({ entityType: 'lead', entityId: lead.id });
      }
    }
    const listingScope = scopeFor(ctx, 'listing.view');
    for (const [index, link] of links.entries()) {
      const field = `links[${index}].entityId`;
      if (link.entityType === 'contact') {
        const contact = await this.contacts.loadRow(tx, link.entityId);
        if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) {
          errors.push({ field, code: 'not-found', message: 'Choose a contact you can see.' });
          continue;
        }
        const writeScope = scopeFor(ctx, 'contact.update');
        if (!writableLeadContacts.has(contact.id) && (writeScope === null || !contactWithinScope(writeScope, ctx, contact))) {
          errors.push({ field, code: 'forbidden', message: 'You cannot log activities on this contact. Log it on your lead instead.' });
        } else if (contact.mergedIntoContactId !== null || contact.isAnonymised) {
          errors.push({ field, code: 'not-active', message: 'This contact was merged or anonymised.' });
        }
      } else if (link.entityType === 'listing') {
        const listing =
          listingScope === null
            ? undefined
            : await tx.selectFrom('listings as l').select('l.id').where('l.id', '=', link.entityId).where(listingScopeSql(listingScope, ctx, 'l')).executeTakeFirst();
        if (!listing) errors.push({ field, code: 'not-found', message: 'Choose a listing you can see.' });
      } else if (link.entityType === 'property') {
        if (!(await propertyCovered(tx, ctx, link.entityId, 'property.view'))) errors.push({ field, code: 'not-found', message: 'Choose a property you can see.' });
      }
      if (link.entityType !== 'lead') result.push({ entityType: link.entityType, entityId: link.entityId });
    }
    for (const contactId of writableLeadContacts) {
      if (!result.some((link) => link.entityType === 'contact' && link.entityId === contactId)) result.push({ entityType: 'contact', entityId: contactId });
    }
    if (!result.some((link) => link.entityType === 'contact' || link.entityType === 'lead')) {
      errors.push({ field: 'links', code: 'required', message: 'Link the activity to a contact or a lead.' });
    }
    return result;
  }

  private async checkOutcome(tx: Tx, ctx: TenantContext, code: string, errors: FieldError[]): Promise<void> {
    const country = await tx.selectFrom('companies').select('headquartersCountryCode').where('id', '=', ctx.companyId).executeTakeFirst();
    const error = await checkPicklistCode(tx, 'activity_outcome', code, country?.headquartersCountryCode ?? '', 'outcomeCode');
    if (error) errors.push(error);
  }
}

function editableUntil(createdAt: Date): Date {
  return new Date(createdAt.getTime() + EDIT_WINDOW_HOURS * 3_600_000);
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

export type { TimelineQuery };
