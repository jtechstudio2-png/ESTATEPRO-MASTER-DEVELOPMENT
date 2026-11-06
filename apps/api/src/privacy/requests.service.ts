import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { keysetCondition, type Page, type ParsedListQuery, sortValueSql, toPage } from '../common/list-query.js';
import { type FieldError, ProblemError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { scopeFor } from '../contacts/contact-access.js';
import { SensitiveDataService } from '../crypto/sensitive-data.service.js';
import type { Tx } from '../database/database.module.js';
import { ExportsService } from '../exports/exports.service.js';
import { isCalendarDate, nextReference } from '../properties/properties.service.js';
import { buildAccessReport } from './access-report.js';
import { LedgerError } from './erasure-ledger.js';
import { ErasureError, erasureBlockers, type ErasureService } from './erasure.service.js';
import {
  type AddEvidenceBody,
  type AssignableMemberDto,
  type AssignPrivacyRequestBody,
  type ChangePrivacyRequestStatusBody,
  type CreatePrivacyRequestBody,
  type ExtendPrivacyRequestBody,
  MAX_EXTENSION_DAYS,
  OPEN_REQUEST_STATUSES,
  type PrivacyRequestDto,
  type PrivacyRequestSummaryDto,
  type RequestStatus,
  RESPONSE_DAYS,
  type SETTABLE_STATUSES,
  type VerifyIdentityBody,
} from './requests.dto.js';

export const PRIVACY_ERASURE = Symbol('PRIVACY_ERASURE');
export type RequestSortField = 'dueOn' | 'createdAt';
type Settable = (typeof SETTABLE_STATUSES)[number];

/** Which statuses each status can move to (the database enforces the same rule). */
const NEXT: Record<RequestStatus, Settable[]> = {
  received: ['verifying', 'in_progress', 'refused', 'withdrawn'],
  verifying: ['in_progress', 'refused', 'withdrawn'],
  in_progress: ['completed', 'refused', 'withdrawn'],
  completed: [],
  refused: [],
  withdrawn: [],
};
const CLOSED: RequestStatus[] = ['completed', 'refused', 'withdrawn'];

/**
 * The data-subject request register (gap G3). Members with privacy.view see
 * the company's requests; privacy.manage logs and progresses them; carrying
 * out an erasure or producing an access report needs privacy.fulfil and a
 * recent second factor. Every change is recorded in the request's history and
 * in the audit log; history and evidence are append-only.
 */
@Injectable()
export class PrivacyRequestsService {
  constructor(
    private readonly audit: AuditService,
    private readonly exports: ExportsService,
    private readonly sensitive: SensitiveDataService,
    @Inject(PRIVACY_ERASURE) private readonly erasure: () => ErasureService,
  ) {}

  // ------------------------------------------------------------------ reading

  async list(tx: Tx, ctx: TenantContext, query: ParsedListQuery<RequestSortField>): Promise<Page<PrivacyRequestSummaryDto>> {
    const f = query.filters;
    const dueSql = sql<string>`coalesce(r.extended_due_on, r.due_on)`;
    let qb = this.summaryQuery(tx).select(
      query.sort.field === 'dueOn' ? sql<string>`${dueSql}::text`.as('cursorValue') : sortValueSql('r.createdAt', 'timestamp').as('cursorValue'),
    );
    const view = Array.isArray(f['view']) ? f['view'][0] : 'open';
    if (view === 'open') qb = qb.where('r.closedAt', 'is', null);
    if (view === 'overdue') qb = qb.where('r.closedAt', 'is', null).where(sql<boolean>`${dueSql} < current_date`);
    if (view === 'closed') qb = qb.where('r.closedAt', 'is not', null);
    if (Array.isArray(f['requestType'])) qb = qb.where('r.requestType', 'in', f['requestType']);
    if (Array.isArray(f['status'])) qb = qb.where('r.status', 'in', f['status']);
    if (Array.isArray(f['contactId'])) qb = qb.where('r.contactId', 'in', f['contactId']);
    const assigned = Array.isArray(f['assignedTo']) ? f['assignedTo'][0] : undefined;
    if (assigned === 'me') qb = qb.where('r.assignedTo', '=', ctx.membershipId);
    else if (assigned === 'none') qb = qb.where('r.assignedTo', 'is', null);
    if (query.cursor) {
      qb = qb.where(
        query.sort.field === 'dueOn'
          ? sql<boolean>`(${dueSql}, r.id) ${sql.raw(query.sort.direction === 'asc' ? '>' : '<')} (${query.cursor.v}::date, ${query.cursor.id}::uuid)`
          : keysetCondition('r.createdAt', 'r.id', query.sort, query.cursor),
      );
    }
    const order = query.sort.direction;
    const rows = await (query.sort.field === 'dueOn' ? qb.orderBy(dueSql, order) : qb.orderBy('r.createdAt', order)).orderBy('r.id', order).limit(query.limit + 1).execute();
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => this.toSummary(row));
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<PrivacyRequestDto> {
    const row = await this.summaryQuery(tx)
      .leftJoin('companyMemberships as vm', 'vm.id', 'r.identityVerifiedBy')
      .leftJoin('users as vu', 'vu.id', 'vm.userId')
      .leftJoin('companyMemberships as km', 'km.id', 'r.closedBy')
      .leftJoin('users as ku', 'ku.id', 'km.userId')
      .innerJoin('companyMemberships as cm', 'cm.id', 'r.createdBy')
      .innerJoin('users as cu', 'cu.id', 'cm.userId')
      .leftJoin('exportJobs as e', 'e.id', 'r.accessExportId')
      .select([
        'r.dueOn as originalDueOn', 'r.extensionReason', 'r.identityVerifiedAt', 'r.identityVerifiedBy', 'vu.displayName as verifiedByName', 'r.identityMethod',
        'r.outcomeNote', 'r.closedBy', 'ku.displayName as closedByName', 'r.createdBy', 'cu.displayName as createdByName', 'r.createdAt',
        'r.erasureLedgerEntryId', 'r.accessExportId', 'e.status as exportStatus', 'e.expiresAt as exportExpiresAt', 'e.requestedBy as exportRequestedBy',
      ])
      .where('r.id', '=', id)
      .executeTakeFirst();
    if (!row) throw Problems.notFound();
    const evidence = await tx
      .selectFrom('dataSubjectRequestEvidence as v')
      .innerJoin('companyMemberships as m', 'm.id', 'v.recordedBy')
      .innerJoin('users as u', 'u.id', 'm.userId')
      .select(['v.id', 'v.kind', 'v.summary', 'v.receivedOn', 'v.recordedBy', 'u.displayName', 'v.recordedAt'])
      .where('v.requestId', '=', id)
      .orderBy('v.recordedAt')
      .orderBy('v.id')
      .execute();
    const history = await tx
      .selectFrom('dataSubjectRequestEvents as h')
      .leftJoin('companyMemberships as m', 'm.id', 'h.actor')
      .leftJoin('users as u', 'u.id', 'm.userId')
      .select(['h.id', 'h.eventType', 'h.fromStatus', 'h.toStatus', 'h.detail', 'h.actor', 'u.displayName', 'h.occurredAt'])
      .where('h.requestId', '=', id)
      .orderBy('h.occurredAt')
      .orderBy('h.id')
      .execute();
    const status = row.status as RequestStatus;
    const canManage = scopeFor(ctx, 'privacy.manage') !== null;
    const open = !CLOSED.includes(status);
    const blockers = open && row.requestType === 'erasure' ? await erasureBlockers(tx, row.contactId) : [];
    const verified = row.identityVerifiedAt !== null;
    const nextStatuses = canManage
      ? NEXT[status].filter((next) => (next === 'in_progress' ? verified : next === 'completed' ? row.requestType === 'access' : true))
      : [];
    return {
      ...this.toSummary(row),
      originalDueOn: row.originalDueOn,
      extensionReason: row.extensionReason,
      identityVerifiedAt: row.identityVerifiedAt?.toISOString() ?? null,
      identityVerifiedBy: row.identityVerifiedBy ? { id: row.identityVerifiedBy, name: row.verifiedByName ?? '' } : null,
      identityMethod: row.identityMethod,
      outcomeNote: row.outcomeNote,
      closedBy: row.closedBy ? { id: row.closedBy, name: row.closedByName ?? '' } : null,
      createdBy: { id: row.createdBy, name: row.createdByName },
      createdAt: row.createdAt.toISOString(),
      erasureLedgerEntryId: row.erasureLedgerEntryId,
      accessReport: row.accessExportId
        ? {
            exportId: row.accessExportId,
            status: row.exportStatus === 'completed' ? 'completed' : 'expired',
            expiresAt: row.exportExpiresAt?.toISOString() ?? null,
            canDownload: row.exportStatus === 'completed' && row.exportRequestedBy === ctx.membershipId,
          }
        : null,
      erasureBlockers: blockers,
      evidence: evidence.map((item) => ({
        id: item.id,
        kind: item.kind as PrivacyRequestDto['evidence'][number]['kind'],
        summary: item.summary,
        receivedOn: item.receivedOn,
        recordedBy: { id: item.recordedBy, name: item.displayName },
        recordedAt: item.recordedAt.toISOString(),
      })),
      history: history.map((event) => ({
        id: event.id,
        eventType: event.eventType as PrivacyRequestDto['history'][number]['eventType'],
        fromStatus: event.fromStatus as RequestStatus | null,
        toStatus: event.toStatus as RequestStatus | null,
        detail: event.detail as Record<string, unknown>,
        actor: event.actor ? { id: event.actor, name: event.displayName ?? '' } : null,
        occurredAt: event.occurredAt.toISOString(),
      })),
      nextStatuses,
      canManage,
      canFulfil:
        scopeFor(ctx, 'privacy.fulfil') !== null && status === 'in_progress' && (row.requestType === 'access' || blockers.length === 0),
    };
  }

  /** Members who can be given requests (they hold privacy.manage). */
  async assignable(tx: Tx): Promise<AssignableMemberDto[]> {
    const { rows } = await sql<AssignableMemberDto>`
      select m.id, u.display_name as name from company_memberships m
        join users u on u.id = m.user_id
       where m.status = 'active' and m.membership_type = 'staff'
         and exists (select 1 from role_permissions rp where rp.role_id = m.role_id and rp.permission_key = 'privacy.manage')
       order by u.display_name, m.id`.execute(tx);
    return rows;
  }

  /** Open and overdue requests (admin dashboard, D-A). */
  async counts(tx: Tx): Promise<{ open: number; overdue: number }> {
    const { rows } = await sql<{ open: number; overdue: number }>`
      select count(*)::int as open, count(*) filter (where coalesce(extended_due_on, due_on) < current_date)::int as overdue
        from data_subject_requests where closed_at is null`.execute(tx);
    return rows[0] ?? { open: 0, overdue: 0 };
  }

  // ------------------------------------------------------------------ changes

  async create(tx: Tx, ctx: TenantContext, body: CreatePrivacyRequestBody): Promise<PrivacyRequestDto> {
    const errors: FieldError[] = [];
    const today = new Date().toISOString().slice(0, 10);
    if (!isCalendarDate(body.receivedOn)) errors.push({ field: 'receivedOn', code: 'invalid', message: 'Enter a real date.' });
    else if (body.receivedOn > today) errors.push({ field: 'receivedOn', code: 'future', message: 'The date the request reached us cannot be in the future.' });
    const contact = await tx.selectFrom('contacts').select(['id', 'contactType', 'isAnonymised', 'mergedIntoContactId']).where('id', '=', body.contactId).executeTakeFirst();
    if (!contact) errors.push({ field: 'contactId', code: 'not-found', message: 'Choose a contact of this company.' });
    else if (contact.mergedIntoContactId !== null) errors.push({ field: 'contactId', code: 'merged', message: 'This contact was merged; log the request on the contact it was merged into.' });
    else if (body.requestType === 'erasure' && contact.isAnonymised) errors.push({ field: 'contactId', code: 'already-erased', message: 'This person has already been erased.' });
    else if (body.requestType === 'erasure' && contact.contactType !== 'person') {
      errors.push({ field: 'contactId', code: 'not-a-person', message: 'Erasure applies to people; an organisation is archived instead.' });
    }
    if (body.assignedTo) await this.checkAssignee(tx, body.assignedTo, errors);
    if (errors.length > 0) throw Problems.validation(errors);

    const due = addDays(body.receivedOn, RESPONSE_DAYS);
    const reference = await nextReference(tx, ctx, 'privacy_request');
    const inserted = await tx
      .insertInto('dataSubjectRequests')
      .values({
        companyId: ctx.companyId,
        reference,
        contactId: body.contactId,
        requestType: body.requestType,
        channel: body.channel,
        receivedOn: body.receivedOn,
        dueOn: due,
        assignedTo: body.assignedTo ?? null,
        createdBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.event(tx, ctx, inserted.id, 'created', null, 'received', { requestType: body.requestType, channel: body.channel, dueOn: due, assignedTo: body.assignedTo ?? null });
    if (body.summary) {
      await tx.insertInto('dataSubjectRequestEvidence').values({ companyId: ctx.companyId, requestId: inserted.id, kind: 'request', summary: body.summary, receivedOn: body.receivedOn, recordedBy: ctx.membershipId }).execute();
    }
    await this.audit.record(tx, ctx, {
      action: 'privacy.request_created',
      entityType: 'privacy_request',
      entityId: inserted.id,
      metadata: { reference, contactId: body.contactId, requestType: body.requestType, channel: body.channel, receivedOn: body.receivedOn, dueOn: due },
    });
    return this.get(tx, ctx, inserted.id);
  }

  async assign(tx: Tx, ctx: TenantContext, id: string, version: number, body: AssignPrivacyRequestBody): Promise<PrivacyRequestDto> {
    const current = await this.lockOpen(tx, id, version);
    const errors: FieldError[] = [];
    if (body.assignedTo) await this.checkAssignee(tx, body.assignedTo, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    if (current.assignedTo === body.assignedTo) return this.get(tx, ctx, id);
    await tx.updateTable('dataSubjectRequests').set({ assignedTo: body.assignedTo }).where('id', '=', id).execute();
    await this.event(tx, ctx, id, 'assigned', null, null, { from: current.assignedTo, to: body.assignedTo });
    await this.audit.record(tx, ctx, { action: 'privacy.request_assigned', entityType: 'privacy_request', entityId: id, changes: { assignedTo: { old: current.assignedTo, new: body.assignedTo } } });
    return this.get(tx, ctx, id);
  }

  async verifyIdentity(tx: Tx, ctx: TenantContext, id: string, version: number, body: VerifyIdentityBody): Promise<PrivacyRequestDto> {
    const current = await this.lockOpen(tx, id, version);
    if (current.identityVerifiedAt !== null) throw Problems.businessRule("The requester's identity has already been verified.");
    await tx
      .updateTable('dataSubjectRequests')
      .set({ identityVerifiedAt: sql<Date>`now()`, identityVerifiedBy: ctx.membershipId, identityMethod: body.method })
      .where('id', '=', id)
      .execute();
    if (body.note) {
      await tx.insertInto('dataSubjectRequestEvidence').values({ companyId: ctx.companyId, requestId: id, kind: 'identity', summary: body.note, receivedOn: sql<string>`current_date`, recordedBy: ctx.membershipId }).execute();
    }
    await this.event(tx, ctx, id, 'identity_verified', null, null, { method: body.method });
    await this.audit.record(tx, ctx, { action: 'privacy.identity_verified', entityType: 'privacy_request', entityId: id, metadata: { method: body.method } });
    return this.get(tx, ctx, id);
  }

  async changeStatus(tx: Tx, ctx: TenantContext, id: string, version: number, body: ChangePrivacyRequestStatusBody): Promise<PrivacyRequestDto> {
    const current = await this.lockOpen(tx, id, version);
    const from = current.status as RequestStatus;
    const errors: FieldError[] = [];
    if (!NEXT[from].includes(body.status)) errors.push({ field: 'status', code: 'not-allowed', message: `A ${from.replace('_', ' ')} request cannot move to ${body.status.replace('_', ' ')}.` });
    else if (body.status === 'in_progress' && current.identityVerifiedAt === null) {
      errors.push({ field: 'status', code: 'identity-not-verified', message: "Verify the requester's identity before starting work." });
    } else if (body.status === 'completed' && current.requestType === 'erasure') {
      errors.push({ field: 'status', code: 'erasure-not-carried-out', message: 'An erasure request is completed by carrying out the erasure.' });
    }
    if ((body.status === 'refused' || body.status === 'withdrawn') && !body.note) {
      errors.push({ field: 'note', code: 'required', message: body.status === 'refused' ? 'Give the reason for refusing (told to the requester).' : 'Record how the requester withdrew.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    const closing = CLOSED.includes(body.status);
    await tx
      .updateTable('dataSubjectRequests')
      .set({
        status: body.status,
        ...(body.note ? { outcomeNote: body.note } : {}),
        ...(closing ? { closedAt: sql<Date>`now()`, closedBy: ctx.membershipId } : {}),
      })
      .where('id', '=', id)
      .execute();
    await this.event(tx, ctx, id, 'status_changed', from, body.status, {});
    await this.audit.record(tx, ctx, {
      action: closing ? 'privacy.request_closed' : 'privacy.request_status_changed',
      entityType: 'privacy_request',
      entityId: id,
      changes: { status: { old: from, new: body.status } },
    });
    return this.get(tx, ctx, id);
  }

  async extend(tx: Tx, ctx: TenantContext, id: string, version: number, body: ExtendPrivacyRequestBody): Promise<PrivacyRequestDto> {
    const current = await this.lockOpen(tx, id, version);
    const errors: FieldError[] = [];
    if (current.extendedDueOn !== null) errors.push({ field: 'extendedDueOn', code: 'already-extended', message: 'The due date has already been extended once.' });
    else if (!isCalendarDate(body.extendedDueOn)) errors.push({ field: 'extendedDueOn', code: 'invalid', message: 'Enter a real date.' });
    else if (body.extendedDueOn <= current.dueOn || body.extendedDueOn > addDays(current.dueOn, MAX_EXTENSION_DAYS)) {
      errors.push({ field: 'extendedDueOn', code: 'out-of-range', message: `Choose a date after ${current.dueOn} and no more than ${MAX_EXTENSION_DAYS} days after it.` });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    await tx.updateTable('dataSubjectRequests').set({ extendedDueOn: body.extendedDueOn, extensionReason: body.reason }).where('id', '=', id).execute();
    await this.event(tx, ctx, id, 'due_extended', null, null, { from: current.dueOn, to: body.extendedDueOn });
    await this.audit.record(tx, ctx, { action: 'privacy.request_extended', entityType: 'privacy_request', entityId: id, changes: { dueOn: { old: current.dueOn, new: body.extendedDueOn } } });
    return this.get(tx, ctx, id);
  }

  async addEvidence(tx: Tx, ctx: TenantContext, id: string, body: AddEvidenceBody): Promise<PrivacyRequestDto> {
    const request = await tx.selectFrom('dataSubjectRequests').select(['id', 'receivedOn']).where('id', '=', id).executeTakeFirst();
    if (!request) throw Problems.notFound();
    const today = new Date().toISOString().slice(0, 10);
    if (!isCalendarDate(body.receivedOn) || body.receivedOn > today) {
      throw Problems.validation([{ field: 'receivedOn', code: 'invalid', message: 'Enter a real date, not in the future.' }]);
    }
    const inserted = await tx
      .insertInto('dataSubjectRequestEvidence')
      .values({ companyId: ctx.companyId, requestId: id, kind: body.kind, summary: body.summary, receivedOn: body.receivedOn, recordedBy: ctx.membershipId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.event(tx, ctx, id, 'evidence_added', null, null, { evidenceId: inserted.id, kind: body.kind });
    await this.audit.record(tx, ctx, { action: 'privacy.evidence_added', entityType: 'privacy_request', entityId: id, metadata: { evidenceId: inserted.id, kind: body.kind } });
    return this.get(tx, ctx, id);
  }

  /** Produces the access report (protected values included) as a 24-hour export for this member. */
  async generateAccessReport(tx: Tx, ctx: TenantContext, id: string, version: number): Promise<PrivacyRequestDto> {
    const current = await this.lockOpen(tx, id, version);
    if (current.requestType !== 'access') throw Problems.businessRule('Access reports are produced for access requests.');
    if (current.status !== 'in_progress') throw Problems.businessRule('Start work on the request (identity verified) before producing the report.');
    const { report, rowCount, protectedFields } = await buildAccessReport(tx, ctx, this.sensitive, current.contactId, { reference: current.reference, receivedOn: current.receivedOn });
    const job = await this.exports.storeFile(tx, ctx, {
      exportType: 'subject_access',
      format: 'json',
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8'),
      rowCount,
      parameters: { requestId: id, reference: current.reference },
    });
    await tx.updateTable('dataSubjectRequests').set({ accessExportId: job.id }).where('id', '=', id).execute();
    await this.event(tx, ctx, id, 'access_report_generated', null, null, { exportId: job.id, rows: rowCount });
    await this.audit.record(tx, ctx, {
      action: 'privacy.access_report_generated',
      entityType: 'contact',
      entityId: current.contactId,
      metadata: { requestId: id, reference: current.reference, exportId: job.id, rows: rowCount, protectedFieldsIncluded: protectedFields },
    });
    return this.get(tx, ctx, id);
  }

  /** Carries out the erasure (E6) and completes the request in the same transaction. */
  async carryOutErasure(tx: Tx, ctx: TenantContext, id: string, version: number): Promise<PrivacyRequestDto> {
    const current = await this.lockOpen(tx, id, version);
    if (current.requestType !== 'erasure') throw Problems.businessRule('Only an erasure request can be carried out as an erasure.');
    if (current.status !== 'in_progress') throw Problems.businessRule('Start work on the request (identity verified) before erasing.');
    const blockers = await erasureBlockers(tx, current.contactId);
    if (blockers.length > 0) throw blockedProblem(blockers);
    let erasure: ErasureService;
    try {
      erasure = this.erasure();
    } catch (error) {
      if (error instanceof LedgerError) {
        throw new ProblemError(503, 'erasure-ledger-unavailable', 'Erasure ledger unavailable', 'Erasure is not available: the erasure ledger is not configured. Nothing was erased.');
      }
      throw error;
    }
    let result;
    try {
      result = await erasure.eraseContactIn(tx, ctx, current.contactId, { requestReference: current.reference, requestedBy: `member ${ctx.membershipId}` });
    } catch (error) {
      if (error instanceof ErasureError && error.code === 'blocked') throw blockedProblem(error.blockers);
      if (error instanceof ErasureError) throw Problems.businessRule(error.message);
      if (error instanceof ProblemError) throw error;
      throw new ProblemError(503, 'erasure-ledger-unavailable', 'Erasure ledger unavailable', 'The erasure could not be recorded in the erasure ledger. Nothing was erased; try again shortly.');
    }
    if (result.ledgerEntryId === null) throw Problems.businessRule('This person has already been erased.');
    await tx
      .updateTable('dataSubjectRequests')
      .set({ status: 'completed', erasureLedgerEntryId: result.ledgerEntryId, closedAt: sql<Date>`now()`, closedBy: ctx.membershipId })
      .where('id', '=', id)
      .execute();
    await this.event(tx, ctx, id, 'erasure_carried_out', 'in_progress', 'completed', { ledgerEntryId: result.ledgerEntryId, counts: result.counts });
    await this.audit.record(tx, ctx, {
      action: 'privacy.request_closed',
      entityType: 'privacy_request',
      entityId: id,
      changes: { status: { old: 'in_progress', new: 'completed' } },
      metadata: { ledgerEntryId: result.ledgerEntryId },
    });
    return this.get(tx, ctx, id);
  }

  // ------------------------------------------------------------------ helpers

  private summaryQuery(tx: Tx) {
    return tx
      .selectFrom('dataSubjectRequests as r')
      .innerJoin('contacts as c', (join) => join.onRef('c.companyId', '=', 'r.companyId').onRef('c.id', '=', 'r.contactId'))
      .leftJoin('companyMemberships as am', 'am.id', 'r.assignedTo')
      .leftJoin('users as au', 'au.id', 'am.userId')
      .select([
        'r.id', 'r.reference', 'r.requestType', 'r.status', 'r.channel', 'r.contactId', 'c.displayName as contactName', 'c.reference as contactReference',
        'r.receivedOn', 'r.assignedTo', 'au.displayName as assigneeName', 'r.closedAt', 'r.version',
        sql<string>`coalesce(r.extended_due_on, r.due_on)::text`.as('effectiveDueOn'),
        sql<number>`(coalesce(r.extended_due_on, r.due_on) - current_date)`.as('daysLeft'),
        sql<boolean>`r.identity_verified_at is not null`.as('identityVerified'),
      ]);
  }

  private toSummary(row: {
    id: string; reference: string; requestType: string; status: string; channel: string; contactId: string; contactName: string; contactReference: string | null;
    receivedOn: string; assignedTo: string | null; assigneeName: string | null; closedAt: Date | null; version: number; effectiveDueOn: string; daysLeft: number; identityVerified: boolean;
  }): PrivacyRequestSummaryDto {
    const open = row.closedAt === null;
    return {
      id: row.id,
      reference: row.reference,
      requestType: row.requestType as PrivacyRequestSummaryDto['requestType'],
      status: row.status as RequestStatus,
      channel: row.channel,
      contact: { id: row.contactId, name: row.contactName, reference: row.contactReference },
      receivedOn: row.receivedOn,
      dueOn: row.effectiveDueOn,
      overdue: open && Number(row.daysLeft) < 0,
      daysLeft: open ? Number(row.daysLeft) : null,
      assignedTo: row.assignedTo ? { id: row.assignedTo, name: row.assigneeName ?? '' } : null,
      identityVerified: row.identityVerified,
      closedAt: row.closedAt?.toISOString() ?? null,
      version: row.version,
    };
  }

  private async lockOpen(tx: Tx, id: string, version: number) {
    const row = await tx.selectFrom('dataSubjectRequests').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw Problems.notFound();
    if (row.version !== version) throw Problems.preconditionFailed();
    if (row.closedAt !== null) throw Problems.businessRule('This request is closed.');
    return row;
  }

  private async checkAssignee(tx: Tx, membershipId: string, errors: FieldError[]): Promise<void> {
    const members = await this.assignable(tx);
    if (!members.some((member) => member.id === membershipId)) {
      errors.push({ field: 'assignedTo', code: 'not-assignable', message: 'Choose a member who can manage privacy requests.' });
    }
  }

  private async event(tx: Tx, ctx: TenantContext, requestId: string, eventType: string, fromStatus: string | null, toStatus: string | null, detail: Record<string, unknown>): Promise<void> {
    await tx
      .insertInto('dataSubjectRequestEvents')
      .values({ companyId: ctx.companyId, requestId, eventType, fromStatus, toStatus, detail: JSON.stringify(detail), actor: ctx.system ? null : ctx.membershipId })
      .execute();
  }
}

/** One error per blocker code (organisation, contact_payment_accounts, lease_parties, …) so screens can explain each. */
function blockedProblem(blockers: string[]): ProblemError {
  return Problems.validation(
    blockers.map((code) => ({
      field: 'contact',
      code: `erasure-blocked:${code}`,
      message: code === 'organisation' ? 'Erasure applies to people; an organisation is archived instead.' : `Records the law requires us to keep refer to this person (${code.replace(/_/g, ' ')}).`,
    })),
  );
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export const OPEN_STATUSES = OPEN_REQUEST_STATUSES;
