import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { keysetCondition, type Page, type ParsedListQuery, type RangeValue, sortValueSql, toPage } from '../common/list-query.js';
import { type FieldError, ProblemError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { maskPhone } from '../contacts/identifiers.js';
import type { Tx } from '../database/database.module.js';
import { listingScopeSql } from '../listings/listing-access.js';
import { nextReference } from '../properties/properties.service.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { CrmSettingsService } from './crm-settings.service.js';
import {
  assertLeadPermission,
  assignerCovers,
  canOnLead,
  grantCoversLead,
  type LeadAccessRow,
  leadScopeSql,
  memberGrant,
  scopeOf,
} from './lead-access.js';
import {
  type AssignLeadBody,
  type ChangeLeadStatusBody,
  type CreateLeadBody,
  type LeadDto,
  type LeadSummaryDto,
  type UpdateLeadBody,
} from './leads.dto.js';
import { recordSystemActivity } from './system-activity.js';

export type LeadSortField = 'receivedAt' | 'updatedAt';

/** Allowed status changes; the database enforces the same table (migration 0024). */
const NEXT_STATUSES: Record<string, string[]> = {
  new: ['contacted', 'qualified', 'unqualified', 'lost'],
  contacted: ['qualified', 'unqualified', 'lost'],
  qualified: ['unqualified', 'lost'],
  unqualified: ['contacted', 'qualified'],
  lost: ['contacted'],
  converted: [],
};
/** Leaving these statuses reopens a lead: a manager action (wireframe L-4). */
const CLOSED_STATUSES = ['unqualified', 'lost'];

const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  unqualified: 'Unqualified',
  converted: 'Converted',
  lost: 'Lost',
};

/**
 * Leads (CRM-06; wireframes L-1 to L-4; decisions D3, D6, D7). Every status
 * change and assignment writes append-only history with who and when, and
 * status changes appear on the activity timeline as system entries.
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly settings: CrmSettingsService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, query: ParsedListQuery<LeadSortField>): Promise<Page<LeadSummaryDto>> {
    const f = query.filters;
    const target = (await this.settings.get(tx)).leadResponseMinutes;
    const sortColumn = `l.${query.sort.field}`;
    let qb = this.summaryQuery(tx)
      .select(sortValueSql(sortColumn, query.sort.kind).as('cursorValue'))
      .where(leadScopeSql(scopeOf(ctx, 'lead.view'), ctx, 'l'));
    const archived = f['archived'] ?? 'false';
    if (archived === 'false') qb = qb.where('l.archivedAt', 'is', null);
    if (archived === 'true') qb = qb.where('l.archivedAt', 'is not', null);
    for (const [filter, column] of [
      ['status', 'l.status'],
      ['leadType', 'l.leadType'],
      ['sourceCode', 'l.sourceCode'],
      ['officeId', 'l.officeId'],
      ['contactId', 'l.contactId'],
      ['listingId', 'l.listingId'],
    ] as const) {
      const values = f[filter];
      if (Array.isArray(values)) qb = qb.where(column, 'in', values);
    }
    const assigned = f['assignedTo'];
    if (Array.isArray(assigned)) {
      const ids = assigned.filter((value) => value !== 'me' && value !== 'unassigned');
      if (assigned.includes('unassigned') && scopeOf(ctx, 'lead.assign') === null) {
        throw Problems.forbidden('Seeing unassigned leads needs permission to assign leads.');
      }
      if (assigned.includes('me')) ids.push(ctx.membershipId);
      qb = qb.where((eb) =>
        eb.or([
          ...(ids.length > 0 ? [eb('l.assignedTo', 'in', ids)] : []),
          ...(assigned.includes('unassigned') ? [eb('l.assignedTo', 'is', null)] : []),
        ]),
      );
    }
    const received = f['receivedAt'] as RangeValue | undefined;
    if (received?.gte) qb = qb.where('l.receivedAt', '>=', new Date(received.gte));
    if (received?.lte) qb = qb.where('l.receivedAt', '<=', new Date(received.lte));
    const attention = f['attention'];
    if (Array.isArray(attention)) {
      if (attention.includes('response_overdue')) {
        if (target === null) {
          throw Problems.validation([
            { field: 'filter[attention]', code: 'no-response-target', message: 'No response target is set. Set one in CRM settings first.' },
          ]);
        }
        qb = qb.where('l.firstResponseAt', 'is', null).where(sql<boolean>`l.received_at + make_interval(mins => ${target}) < now()`);
      }
      if (attention.includes('no_next_action')) {
        qb = qb.where('l.status', 'in', ['new', 'contacted', 'qualified']).where('l.nextActionAt', 'is', null);
      }
    }
    if (query.q !== null) {
      const q = query.q;
      qb = qb.where((eb) =>
        eb.or([eb('l.reference', 'ilike', `${escapeLike(q)}%`), eb('c.displayName', 'ilike', `%${escapeLike(q)}%`)]),
      );
    }
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'l.id', query.sort, query.cursor));
    const rows = await qb.orderBy(sql.ref(sortColumn), query.sort.direction).orderBy('l.id', query.sort.direction).limit(query.limit + 1).execute();
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => toSummary(row, target));
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<LeadDto> {
    const row = await this.summaryQuery(tx)
      .select(['l.campaign', 'l.requirementId', 'l.message', 'l.lostReasonCode', 'l.archivedReason', 'l.scoreBreakdown', 'l.createdAt', 'l.version'])
      .where('l.id', '=', id)
      .executeTakeFirst();
    if (!row || !canOnLead(ctx, 'lead.view', row)) throw Problems.notFound();
    const target = (await this.settings.get(tx)).leadResponseMinutes;
    const [history, assignments] = await Promise.all([
      tx
        .selectFrom('leadStatusHistory as h')
        .leftJoin('companyMemberships as m', 'm.id', 'h.changedBy')
        .leftJoin('users as u', 'u.id', 'm.userId')
        .select(['h.fromStatus', 'h.toStatus', 'h.changedAt', 'h.changedBy', 'u.displayName as changedByName', 'h.note'])
        .where('h.leadId', '=', id)
        .orderBy('h.changedAt')
        .orderBy('h.entryNo')
        .execute(),
      tx
        .selectFrom('leadAssignments as a')
        .innerJoin('companyMemberships as tm', 'tm.id', 'a.assignedTo')
        .innerJoin('users as tu', 'tu.id', 'tm.userId')
        .leftJoin('companyMemberships as bm', 'bm.id', 'a.assignedBy')
        .leftJoin('users as bu', 'bu.id', 'bm.userId')
        .select(['a.assignedTo', 'tu.displayName as assignedToName', 'a.assignedBy', 'bu.displayName as assignedByName', 'a.assignedAt', 'a.note'])
        .where('a.leadId', '=', id)
        .orderBy('a.assignedAt')
        .orderBy('a.entryNo')
        .execute(),
    ]);
    const canEdit = canOnLead(ctx, 'lead.update', row) && row.archivedAt === null;
    const canAssign = canOnLead(ctx, 'lead.assign', row) && row.archivedAt === null;
    return {
      ...toSummary(row, target),
      campaign: row.campaign,
      requirementId: row.requirementId,
      message: row.message,
      lostReasonCode: row.lostReasonCode,
      archivedReason: row.archivedReason,
      scoreBreakdown: row.score === null ? [] : scoreRules(row.scoreBreakdown),
      statusHistory: history.map((h) => ({
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        changedAt: h.changedAt.toISOString(),
        changedBy: h.changedBy !== null ? { id: h.changedBy, name: h.changedByName ?? '' } : null,
        note: h.note,
      })),
      assignments: assignments.map((a) => ({
        assignedTo: { id: a.assignedTo, name: a.assignedToName },
        assignedBy: a.assignedBy !== null ? { id: a.assignedBy, name: a.assignedByName ?? '' } : null,
        assignedAt: a.assignedAt.toISOString(),
        note: a.note,
      })),
      access: {
        canEdit,
        canAssign,
        canReopen: canAssign && CLOSED_STATUSES.includes(row.status),
        // Reopening a closed lead is a manager action.
        nextStatuses: canEdit && (!CLOSED_STATUSES.includes(row.status) || canAssign) ? (NEXT_STATUSES[row.status] ?? []) : [],
      },
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  // ----------------------------------------------------------------- writing

  async create(tx: Tx, ctx: TenantContext, body: CreateLeadBody): Promise<LeadDto> {
    if (((body.contactId ?? null) === null) === ((body.contact ?? null) === null)) {
      throw Problems.validation([{ field: 'contactId', code: 'one-of', message: 'Choose an existing contact or enter a new one (not both).' }]);
    }
    const contact = await this.resolveContact(tx, ctx, body);
    const errors: FieldError[] = [];
    const listing = body.listingId ? await this.visibleListing(tx, ctx, body.listingId, errors) : null;
    if (body.requirementId) await this.checkRequirement(tx, contact.id, body.requirementId, errors);
    const officeId = await this.resolveOffice(tx, ctx, body.officeId ?? listing?.officeId ?? contact.officeId ?? ctx.officeIds[0] ?? null, 'lead.create', errors);
    await this.checkSource(tx, ctx, officeId, body.sourceCode, errors);
    const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
    if (receivedAt.getTime() > Date.now() + 60_000) errors.push({ field: 'receivedAt', code: 'in-future', message: 'An enquiry cannot arrive in the future.' });
    const officeRejected = errors.some((error) => error.field === 'officeId');
    // An explicit null leaves the lead in the Unassigned inbox: a manager choice that needs an office.
    const leaveUnassigned = body.assignedTo === null;
    if (leaveUnassigned && scopeOf(ctx, 'lead.assign') === null) {
      errors.push({ field: 'assignedTo', code: 'not-allowed', message: 'Only managers can leave a lead unassigned.' });
    } else if (leaveUnassigned && officeId === null && !officeRejected) {
      errors.push({ field: 'officeId', code: 'required', message: 'Choose the office whose inbox receives the lead.' });
    }
    const assignee =
      officeRejected || leaveUnassigned ? null : await this.resolveAssignee(tx, ctx, body.assignedTo ?? ctx.membershipId, { officeId, assignedTo: null }, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    // The creator must be able to see the lead they create.
    if (!canOnLead(ctx, 'lead.view', { officeId, assignedTo: assignee?.membershipId ?? null })) {
      throw Problems.validation([{ field: 'assignedTo', code: 'out-of-scope', message: 'Assign the lead to yourself or choose an office you work in.' }]);
    }

    const reference = await nextReference(tx, ctx, 'lead');
    const inserted = await tx
      .insertInto('leads')
      .values({
        companyId: ctx.companyId,
        reference,
        contactId: contact.id,
        leadType: body.leadType,
        sourceCode: body.sourceCode,
        sourceDetail: emptyToNull(body.sourceDetail),
        campaign: emptyToNull(body.campaign),
        listingId: listing?.id ?? null,
        requirementId: body.requirementId ?? null,
        officeId,
        assignedTo: assignee?.membershipId ?? null,
        receivedAt,
        message: emptyToNull(body.message),
        createdBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx.insertInto('leadStatusHistory').values({ companyId: ctx.companyId, leadId: inserted.id, fromStatus: null, toStatus: 'new', changedBy: ctx.membershipId }).execute();
    if (assignee) {
      await tx.insertInto('leadAssignments').values({ companyId: ctx.companyId, leadId: inserted.id, assignedTo: assignee.membershipId, assignedBy: ctx.membershipId }).execute();
    }
    await this.audit.record(tx, ctx, {
      action: 'lead.created',
      entityType: 'lead',
      entityId: inserted.id,
      metadata: {
        reference,
        contactId: contact.id,
        contactCreated: contact.created,
        leadType: body.leadType,
        sourceCode: body.sourceCode,
        listingId: listing?.id ?? null,
        officeId,
        assignedTo: assignee?.membershipId ?? null,
      },
    });
    await this.audit.emit(tx, ctx, { eventType: 'lead.created', aggregateType: 'lead', aggregateId: inserted.id, payload: { leadId: inserted.id, contactId: contact.id } });
    if (assignee && assignee.membershipId !== ctx.membershipId) {
      await this.audit.emit(tx, ctx, { eventType: 'lead.assigned', aggregateType: 'lead', aggregateId: inserted.id, payload: { leadId: inserted.id, assignedTo: assignee.membershipId } });
    }
    return this.get(tx, ctx, inserted.id);
  }

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateLeadBody): Promise<LeadDto> {
    const current = await this.lockLead(tx, ctx, id, expectedVersion, 'lead.update');
    const errors: FieldError[] = [];
    const next = {
      leadType: body.leadType ?? current.leadType,
      sourceCode: body.sourceCode ?? current.sourceCode,
      sourceDetail: body.sourceDetail === undefined ? current.sourceDetail : emptyToNull(body.sourceDetail),
      campaign: body.campaign === undefined ? current.campaign : emptyToNull(body.campaign),
      listingId: body.listingId === undefined ? current.listingId : body.listingId,
      requirementId: body.requirementId === undefined ? current.requirementId : body.requirementId,
      officeId: body.officeId ?? current.officeId,
    };
    if (next.officeId !== current.officeId) {
      await this.resolveOffice(tx, ctx, next.officeId, 'lead.update', errors);
      if (!canOnLead(ctx, 'lead.update', { officeId: next.officeId, assignedTo: current.assignedTo })) {
        errors.push({ field: 'officeId', code: 'out-of-scope', message: 'Choose an office you work in.' });
      }
    }
    if (next.listingId !== current.listingId && next.listingId !== null) await this.visibleListing(tx, ctx, next.listingId, errors);
    if (next.requirementId !== current.requirementId && next.requirementId !== null) await this.checkRequirement(tx, current.contactId, next.requirementId, errors);
    if (next.sourceCode !== current.sourceCode) await this.checkSource(tx, ctx, next.officeId, next.sourceCode, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (next[key] !== current[key]) changes[key] = { old: current[key], new: next[key] };
    }
    if (Object.keys(changes).length === 0) return this.get(tx, ctx, id);
    await tx.updateTable('leads').set(next).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'lead.updated', entityType: 'lead', entityId: id, changes });
    return this.get(tx, ctx, id);
  }

  async changeStatus(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: ChangeLeadStatusBody): Promise<LeadDto> {
    const current = await this.lockLead(tx, ctx, id, expectedVersion, 'lead.update');
    const allowed = NEXT_STATUSES[current.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw Problems.businessRule(
        allowed.length > 0
          ? `A ${current.status} lead can move to: ${allowed.join(', ')}.`
          : `A ${current.status} lead cannot change status.`,
      );
    }
    const reopening = CLOSED_STATUSES.includes(current.status);
    if (reopening && !canOnLead(ctx, 'lead.assign', current)) {
      throw Problems.forbidden('Reopening an unqualified or lost lead is a manager action.');
    }
    const errors: FieldError[] = [];
    if (body.status === 'lost') {
      if (!body.lostReasonCode) errors.push({ field: 'lostReasonCode', code: 'required', message: 'Choose why the lead was lost.' });
      else {
        const error = await checkPicklistCode(tx, 'lost_reason', body.lostReasonCode, await this.countryOf(tx, ctx, current.officeId), 'lostReasonCode');
        if (error) errors.push(error);
      }
    } else if (body.lostReasonCode) {
      errors.push({ field: 'lostReasonCode', code: 'not-applicable', message: 'A lost reason applies only when marking a lead lost.' });
    }
    if ((body.status === 'unqualified' || reopening) && !body.note) {
      errors.push({ field: 'note', code: 'required', message: body.status === 'unqualified' ? 'Say why the lead is unqualified.' : 'Say why the lead is reopened.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);

    await tx.updateTable('leads').set({ status: body.status, lostReasonCode: body.status === 'lost' ? body.lostReasonCode! : null }).where('id', '=', id).execute();
    await tx
      .insertInto('leadStatusHistory')
      .values({ companyId: ctx.companyId, leadId: id, fromStatus: current.status, toStatus: body.status, changedBy: ctx.membershipId, note: body.note ?? null })
      .execute();
    await recordSystemActivity(tx, ctx, {
      activityType: 'status_change',
      subject: `${current.reference}: ${STATUS_LABELS[current.status]} → ${STATUS_LABELS[body.status]}`,
      body: body.note ?? null,
      links: [
        { entityType: 'lead', entityId: id },
        { entityType: 'contact', entityId: current.contactId },
      ],
    });
    await this.audit.record(tx, ctx, {
      action: 'lead.status_changed',
      entityType: 'lead',
      entityId: id,
      changes: { status: { old: current.status, new: body.status } },
      metadata: { lostReasonCode: body.lostReasonCode ?? null, reopened: reopening },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'lead.status_changed',
      aggregateType: 'lead',
      aggregateId: id,
      payload: { leadId: id, fromStatus: current.status, toStatus: body.status },
    });
    return this.get(tx, ctx, id);
  }

  /**
   * A viewing booked from a new lead moves it to contacted (readiness report
   * §4.1, S1). The caller has checked that the member can see the lead; other
   * statuses are left as they are.
   */
  async markContactedByViewing(tx: Tx, ctx: TenantContext, id: string, listingReference: string): Promise<boolean> {
    const current = await tx.selectFrom('leads').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current || current.status !== 'new' || current.archivedAt !== null) return false;
    const note = `Viewing booked for ${listingReference}`;
    await tx.updateTable('leads').set({ status: 'contacted' }).where('id', '=', id).execute();
    await tx.insertInto('leadStatusHistory').values({ companyId: ctx.companyId, leadId: id, fromStatus: 'new', toStatus: 'contacted', changedBy: ctx.membershipId, note }).execute();
    await recordSystemActivity(tx, ctx, {
      activityType: 'status_change',
      subject: `${current.reference}: ${STATUS_LABELS['new']} → ${STATUS_LABELS['contacted']}`,
      body: note,
      links: [
        { entityType: 'lead', entityId: id },
        { entityType: 'contact', entityId: current.contactId },
      ],
    });
    await this.audit.record(tx, ctx, { action: 'lead.status_changed', entityType: 'lead', entityId: id, changes: { status: { old: 'new', new: 'contacted' } }, metadata: { by: 'viewing' } });
    await this.audit.emit(tx, ctx, { eventType: 'lead.status_changed', aggregateType: 'lead', aggregateId: id, payload: { leadId: id, fromStatus: 'new', toStatus: 'contacted' } });
    return true;
  }

  async assign(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: AssignLeadBody): Promise<LeadDto> {
    const current = await this.lockLead(tx, ctx, id, expectedVersion, 'lead.assign');
    if (current.assignedTo === body.assignedTo) return this.get(tx, ctx, id);
    const errors: FieldError[] = [];
    const assignee = await this.resolveAssignee(tx, ctx, body.assignedTo, current, errors);
    if (errors.length > 0 || !assignee) throw Problems.validation(errors);
    await tx.updateTable('leads').set({ assignedTo: assignee.membershipId }).where('id', '=', id).execute();
    await tx
      .insertInto('leadAssignments')
      .values({ companyId: ctx.companyId, leadId: id, assignedTo: assignee.membershipId, assignedBy: ctx.membershipId, note: body.note ?? null })
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'lead.assigned',
      entityType: 'lead',
      entityId: id,
      changes: { assignedTo: { old: current.assignedTo, new: assignee.membershipId } },
    });
    await this.audit.emit(tx, ctx, { eventType: 'lead.assigned', aggregateType: 'lead', aggregateId: id, payload: { leadId: id, assignedTo: assignee.membershipId } });
    return this.get(tx, ctx, id);
  }

  async archive(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<LeadDto> {
    const current = await this.lockLead(tx, ctx, id, expectedVersion, 'lead.update');
    const openTasks = await tx.selectFrom('tasks').select('id').where('entityType', '=', 'lead').where('entityId', '=', id).where('status', '=', 'open').executeTakeFirst();
    if (openTasks) throw Problems.businessRule('This lead has open follow-ups. Complete or cancel them first.');
    await tx.updateTable('leads').set({ archivedAt: sql<Date>`now()`, archivedBy: ctx.membershipId, archivedReason: reason }).where('id', '=', current.id).execute();
    await this.audit.record(tx, ctx, { action: 'lead.archived', entityType: 'lead', entityId: id, metadata: { reason } });
    return this.get(tx, ctx, id);
  }

  async restore(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<LeadDto> {
    const current = await this.lockLead(tx, ctx, id, expectedVersion, 'lead.update', { archived: true });
    await tx.updateTable('leads').set({ archivedAt: null, archivedBy: null, archivedReason: null }).where('id', '=', current.id).execute();
    await this.audit.record(tx, ctx, { action: 'lead.restored', entityType: 'lead', entityId: id });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- helpers

  /** The lead locked for a change, after scope and version checks. */
  async lockLead(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number | null, permission: string, options: { archived?: boolean } = {}) {
    const current = await tx.selectFrom('leads').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    assertLeadPermission(ctx, current, permission);
    if (expectedVersion !== null && current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (options.archived) {
      if (current.archivedAt === null) throw Problems.businessRule('This lead is not archived.');
    } else if (current.archivedAt !== null) {
      throw Problems.businessRule('Archived leads cannot be changed. Restore the lead first.');
    }
    return current;
  }

  /** Lead row for access checks by other services (activities, follow-ups). */
  async accessRow(tx: Tx, id: string) {
    return tx.selectFrom('leads').select(['id', 'reference', 'contactId', 'officeId', 'assignedTo', 'archivedAt', 'receivedAt', 'firstResponseAt']).where('id', '=', id).executeTakeFirst();
  }

  private summaryQuery(tx: Tx) {
    return tx
      .selectFrom('leads as l')
      .innerJoin('contacts as c', 'c.id', 'l.contactId')
      .leftJoin('listings as li', 'li.id', 'l.listingId')
      .leftJoin('offices as o', 'o.id', 'l.officeId')
      .leftJoin('companyMemberships as am', 'am.id', 'l.assignedTo')
      .leftJoin('users as au', 'au.id', 'am.userId')
      .select([
        'l.id',
        'l.reference',
        'l.contactId',
        'c.displayName as contactName',
        'c.primaryPhoneE164',
        'l.leadType',
        'l.status',
        'l.sourceCode',
        'l.sourceDetail',
        'l.listingId',
        'li.reference as listingReference',
        'li.title as listingTitle',
        'l.officeId',
        'o.name as officeName',
        'l.assignedTo',
        'au.displayName as assignedToName',
        sql<string | null>`left(split_part(l.message, E'\n', 1), 120)`.as('messagePreview'),
        'l.receivedAt',
        'l.firstResponseAt',
        'l.nextActionAt',
        'l.score',
        'l.archivedAt',
        'l.updatedAt',
      ]);
  }

  private async resolveContact(tx: Tx, ctx: TenantContext, body: CreateLeadBody): Promise<{ id: string; officeId: string | null; created: boolean }> {
    if (body.contactId) {
      const contact = await this.contacts.loadRow(tx, body.contactId);
      if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) {
        throw Problems.validation([{ field: 'contactId', code: 'not-found', message: 'Choose a contact you can see.' }]);
      }
      if (contact.mergedIntoContactId !== null || contact.archivedAt !== null || contact.isAnonymised) {
        throw Problems.validation([{ field: 'contactId', code: 'not-active', message: 'This contact is archived or merged. Choose an active contact.' }]);
      }
      return { id: contact.id, officeId: contact.officeId, created: false };
    }
    const scope = scopeOf(ctx, 'contact.create');
    if (scope === null) throw Problems.forbidden('Creating a contact needs permission to create contacts.');
    try {
      const created = await this.contacts.create(tx, ctx, scope, body.contact!);
      return { id: created.id, officeId: created.office?.id ?? null, created: true };
    } catch (error) {
      // Field errors of the inline contact are reported under "contact.".
      if (error instanceof ProblemError && error.extras.errors) {
        throw Problems.validation(error.extras.errors.map((e) => ({ ...e, field: `contact.${e.field}` })));
      }
      throw error;
    }
  }

  private async visibleListing(tx: Tx, ctx: TenantContext, listingId: string, errors: FieldError[]) {
    const scope = scopeOf(ctx, 'listing.view');
    const listing =
      scope === null
        ? undefined
        : await tx.selectFrom('listings as l').select(['l.id', 'l.officeId']).where('l.id', '=', listingId).where(listingScopeSql(scope, ctx, 'l')).executeTakeFirst();
    if (!listing) errors.push({ field: 'listingId', code: 'not-found', message: 'Choose a listing you can see.' });
    return listing ?? null;
  }

  private async checkRequirement(tx: Tx, contactId: string, requirementId: string, errors: FieldError[]): Promise<void> {
    const found = await tx.selectFrom('requirements').select('id').where('id', '=', requirementId).where('contactId', '=', contactId).executeTakeFirst();
    if (!found) errors.push({ field: 'requirementId', code: 'not-found', message: 'Choose one of this contact’s requirements.' });
  }

  private async checkSource(tx: Tx, ctx: TenantContext, officeId: string | null, sourceCode: string, errors: FieldError[]): Promise<void> {
    const error = await checkPicklistCode(tx, 'lead_source', sourceCode, await this.countryOf(tx, ctx, officeId), 'sourceCode');
    if (error) errors.push(error);
  }

  /** The office must exist; with office scope it must be one of the member's offices. */
  private async resolveOffice(tx: Tx, ctx: TenantContext, officeId: string | null, permission: string, errors: FieldError[]): Promise<string | null> {
    if (officeId === null) return null;
    const office = await tx.selectFrom('offices').select('id').where('id', '=', officeId).executeTakeFirst();
    const scope = scopeOf(ctx, permission);
    if (!office || (scope !== 'all' && !ctx.officeIds.includes(officeId))) {
      errors.push({ field: 'officeId', code: 'out-of-scope', message: 'Choose an office you work in.' });
      return null;
    }
    return officeId;
  }

  /**
   * Yourself, or (decision D6) someone in your lead.assign scope who can see
   * the lead once it is theirs.
   */
  private async resolveAssignee(tx: Tx, ctx: TenantContext, membershipId: string, lead: LeadAccessRow, errors: FieldError[]) {
    const grant = await memberGrant(tx, membershipId, 'lead.view');
    if (!grant || grant.scope === null) {
      errors.push({ field: 'assignedTo', code: 'not-assignable', message: 'Choose an active team member who works with leads.' });
      return null;
    }
    if (membershipId !== ctx.membershipId && (scopeOf(ctx, 'lead.assign') === null || !assignerCovers(ctx, grant))) {
      errors.push({ field: 'assignedTo', code: 'not-allowed', message: 'You can only assign leads to yourself.' });
      return null;
    }
    if (!grantCoversLead(grant, { officeId: lead.officeId, assignedTo: membershipId })) {
      errors.push({ field: 'assignedTo', code: 'out-of-scope', message: `${grant.name} does not work in this lead’s office.` });
      return null;
    }
    return grant;
  }

  private async countryOf(tx: Tx, ctx: TenantContext, officeId: string | null): Promise<string> {
    const row = officeId
      ? await tx.selectFrom('offices').select('countryCode').where('id', '=', officeId).executeTakeFirst()
      : await tx.selectFrom('companies').select('headquartersCountryCode as countryCode').where('id', '=', ctx.companyId).executeTakeFirst();
    return row?.countryCode ?? '';
  }
}

// --------------------------------------------------------------------- helpers

type SummaryRow = {
  id: string;
  reference: string;
  contactId: string;
  contactName: string;
  primaryPhoneE164: string | null;
  leadType: string;
  status: string;
  sourceCode: string;
  sourceDetail: string | null;
  listingId: string | null;
  listingReference: string | null;
  listingTitle: string | null;
  officeId: string | null;
  officeName: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  messagePreview: string | null;
  receivedAt: Date;
  firstResponseAt: Date | null;
  nextActionAt: Date | null;
  score: number | null;
  archivedAt: Date | null;
  updatedAt: Date;
};

function toSummary(row: SummaryRow, targetMinutes: number | null): LeadSummaryDto {
  let response: LeadSummaryDto['response'] = null;
  if (targetMinutes !== null) {
    const due = new Date(row.receivedAt.getTime() + targetMinutes * 60_000);
    response = {
      dueAt: due.toISOString(),
      overdue: row.firstResponseAt === null && Date.now() > due.getTime(),
      late: row.firstResponseAt !== null && row.firstResponseAt.getTime() > due.getTime(),
    };
  }
  return {
    id: row.id,
    reference: row.reference,
    contact: { id: row.contactId, name: row.contactName, primaryPhoneMasked: maskPhone(row.primaryPhoneE164) },
    leadType: row.leadType,
    status: row.status,
    sourceCode: row.sourceCode,
    sourceDetail: row.sourceDetail,
    listing: row.listingId !== null ? { id: row.listingId, reference: row.listingReference ?? '', title: row.listingTitle ?? '' } : null,
    office: row.officeId !== null ? { id: row.officeId, name: row.officeName ?? '' } : null,
    assignedTo: row.assignedTo !== null ? { id: row.assignedTo, name: row.assignedToName ?? '' } : null,
    messagePreview: row.messagePreview === '' ? null : row.messagePreview,
    receivedAt: row.receivedAt.toISOString(),
    firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
    nextActionAt: row.nextActionAt?.toISOString() ?? null,
    response,
    score: row.score,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Score breakdown stored as { rule: points } (CRM-07); largest contribution first (jsonb keeps no key order). */
function scoreRules(breakdown: unknown): Array<{ rule: string; points: number }> {
  if (typeof breakdown !== 'object' || breakdown === null) return [];
  return Object.entries(breakdown as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([rule, points]) => ({ rule, points }))
    .sort((a, b) => b.points - a.points || a.rule.localeCompare(b.rule));
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

