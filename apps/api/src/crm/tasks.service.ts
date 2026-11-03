import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { type Cursor, encodeCursor, type Page, type RangeValue } from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { ContactsService } from '../contacts/contacts.service.js';
import type { Tx } from '../database/database.module.js';
import { assignerCovers, canOnLead, grantCoversLead, memberGrant, type MemberGrant, scopeOf } from './lead-access.js';
import { LeadsService } from './leads.service.js';
import type { CreateTaskBody, TaskDto, UpdateTaskBody } from './tasks.dto.js';

export interface TaskListQuery {
  view: 'mine' | 'team';
  limit: number;
  cursor: Cursor | null;
  direction: 'asc' | 'desc';
  statuses: string[];
  overdue: boolean | null;
  reminderDue: boolean | null;
  due: RangeValue | null;
  priorities: string[] | null;
  assignedTo: string[] | null;
  about: { entityType: string; entityId: string } | null;
}

/** Due times may be a few minutes in the past (clock drift, a form left open). */
const PAST_TOLERANCE_MS = 5 * 60_000;

/**
 * Follow-ups (CRM-05; wireframes F-1, F-2; decision D6). Everyone schedules
 * follow-ups for themselves on records they can work on; giving one to
 * someone else, and the team list, are manager actions (lead.assign) within
 * the manager's scope. Open follow-ups on a lead set its next action time.
 * Reminders are in-app in Phase 5: the list reports which reminders are due.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, query: TaskListQuery): Promise<Page<TaskDto>> {
    const dueSort = sql<string>`coalesce(t.due_at, 'infinity'::timestamptz)`;
    let qb = this.baseQuery(tx).select(sql<string>`coalesce(t.due_at, 'infinity'::timestamptz)::text`.as('cursorValue'));
    if (query.view === 'mine') {
      qb = qb.where('t.assignedTo', '=', ctx.membershipId);
    } else {
      const scope = scopeOf(ctx, 'lead.assign');
      if (scope === null) throw Problems.forbidden('The team list is for managers (permission to assign leads).');
      if (scope !== 'all') qb = qb.where(this.teamCondition(ctx));
      if (query.assignedTo) qb = qb.where('t.assignedTo', 'in', query.assignedTo);
    }
    qb = qb.where('t.status', 'in', query.statuses);
    if (query.overdue === true) qb = qb.where('t.status', '=', 'open').where('t.dueAt', '<', sql<Date>`now()`);
    if (query.reminderDue === true) qb = qb.where('t.status', '=', 'open').where('t.remindAt', '<=', sql<Date>`now()`);
    if (query.due?.gte) qb = qb.where('t.dueAt', '>=', new Date(query.due.gte));
    if (query.due?.lte) qb = qb.where('t.dueAt', '<=', new Date(query.due.lte));
    if (query.priorities) qb = qb.where('t.priority', 'in', query.priorities);
    if (query.about) qb = qb.where('t.entityType', '=', query.about.entityType).where('t.entityId', '=', query.about.entityId);
    if (query.cursor) {
      const operator = sql.raw(query.direction === 'asc' ? '>' : '<');
      qb = qb.where(sql<boolean>`(${dueSort}, t.id) ${operator} (${query.cursor.v}::timestamptz, ${query.cursor.id}::uuid)`);
    }
    const rows = await qb.orderBy(dueSort, query.direction).orderBy('t.id', query.direction).limit(query.limit + 1).execute();
    const page = rows.slice(0, query.limit);
    const data = await Promise.all(page.map((row) => this.toDto(tx, ctx, row)));
    const last = page[page.length - 1];
    return { data, page: { limit: query.limit, nextCursor: rows.length > query.limit && last ? encodeCursor(last.cursorValue, last.id) : null } };
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<TaskDto> {
    const row = await this.baseQuery(tx).where('t.id', '=', id).executeTakeFirst();
    if (!row || !(await this.canSee(tx, ctx, row))) throw Problems.notFound();
    return this.toDto(tx, ctx, row);
  }

  // ----------------------------------------------------------------- writing

  async create(tx: Tx, ctx: TenantContext, body: CreateTaskBody): Promise<TaskDto> {
    const errors: FieldError[] = [];
    const about = body.about ? await this.checkAbout(tx, ctx, body.about.entityType, body.about.entityId, errors) : null;
    const dueAt = new Date(body.dueAt);
    const remindAt = body.remindAt ? new Date(body.remindAt) : null;
    checkTimes(dueAt, remindAt, { dueChanged: true, remindChanged: true }, errors);
    const assignedTo = body.assignedTo ?? ctx.membershipId;
    if (assignedTo !== ctx.membershipId) await this.checkAssignee(tx, ctx, assignedTo, about, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    const inserted = await tx
      .insertInto('tasks')
      .values({
        companyId: ctx.companyId,
        title: body.title,
        description: emptyToNull(body.description),
        taskType: body.taskType ?? 'follow_up',
        priority: body.priority ?? 'normal',
        dueAt,
        remindAt,
        assignedTo,
        entityType: about?.entityType ?? null,
        entityId: about?.entityId ?? null,
        createdBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.syncNextAction(tx, about);
    await this.audit.record(tx, ctx, {
      action: 'task.created',
      entityType: 'task',
      entityId: inserted.id,
      metadata: { assignedTo, about: about ?? null, dueAt: dueAt.toISOString(), taskType: body.taskType ?? 'follow_up' },
    });
    if (assignedTo !== ctx.membershipId) {
      await this.audit.emit(tx, ctx, { eventType: 'task.assigned', aggregateType: 'task', aggregateId: inserted.id, payload: { taskId: inserted.id, assignedTo } });
    }
    return this.get(tx, ctx, inserted.id);
  }

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateTaskBody): Promise<TaskDto> {
    const current = await this.lockOpen(tx, ctx, id, expectedVersion);
    const errors: FieldError[] = [];
    const next = {
      title: body.title ?? current.title,
      description: body.description === undefined ? current.description : emptyToNull(body.description),
      taskType: body.taskType ?? current.taskType,
      priority: body.priority ?? current.priority,
      dueAt: body.dueAt ? new Date(body.dueAt) : current.dueAt,
      remindAt: body.remindAt === undefined ? current.remindAt : body.remindAt === null ? null : new Date(body.remindAt),
    };
    const rescheduled = next.dueAt?.getTime() !== current.dueAt?.getTime();
    const reminderChanged = next.remindAt?.getTime() !== current.remindAt?.getTime();
    checkTimes(next.dueAt, next.remindAt, { dueChanged: rescheduled, remindChanged: reminderChanged }, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      const before = current[key] instanceof Date ? current[key].toISOString() : current[key];
      const after = next[key] instanceof Date ? next[key].toISOString() : next[key];
      if (before !== after) changes[key] = { old: before, new: after };
    }
    if (Object.keys(changes).length === 0) return this.get(tx, ctx, id);
    await tx.updateTable('tasks').set(next).where('id', '=', id).execute();
    await this.syncNextAction(tx, aboutOf(current));
    await this.audit.record(tx, ctx, { action: 'task.updated', entityType: 'task', entityId: id, changes });
    return this.get(tx, ctx, id);
  }

  /** Decision D6: giving a follow-up to someone else is a manager action. */
  async reassign(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, assignedTo: string): Promise<TaskDto> {
    const current = await this.lockOpen(tx, ctx, id, expectedVersion);
    if (scopeOf(ctx, 'lead.assign') === null) throw Problems.forbidden('Reassigning follow-ups is a manager action.');
    if (current.assignedTo === assignedTo) return this.get(tx, ctx, id);
    const errors: FieldError[] = [];
    await this.checkAssignee(tx, ctx, assignedTo, aboutOf(current), errors);
    if (errors.length > 0) throw Problems.validation(errors);
    await tx.updateTable('tasks').set({ assignedTo }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'task.reassigned', entityType: 'task', entityId: id, changes: { assignedTo: { old: current.assignedTo, new: assignedTo } } });
    await this.audit.emit(tx, ctx, { eventType: 'task.assigned', aggregateType: 'task', aggregateId: id, payload: { taskId: id, assignedTo } });
    return this.get(tx, ctx, id);
  }

  async complete(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<TaskDto> {
    const current = await this.lockOpen(tx, ctx, id, expectedVersion);
    await tx.updateTable('tasks').set({ status: 'done', completedAt: sql<Date>`now()`, completedBy: ctx.membershipId }).where('id', '=', id).execute();
    await this.syncNextAction(tx, aboutOf(current));
    await this.audit.record(tx, ctx, { action: 'task.completed', entityType: 'task', entityId: id, metadata: { about: aboutOf(current) } });
    return this.get(tx, ctx, id);
  }

  async cancel(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<TaskDto> {
    const current = await this.lockOpen(tx, ctx, id, expectedVersion);
    await tx.updateTable('tasks').set({ status: 'cancelled', cancelledAt: sql<Date>`now()`, cancelledBy: ctx.membershipId, cancelReason: reason }).where('id', '=', id).execute();
    await this.syncNextAction(tx, aboutOf(current));
    await this.audit.record(tx, ctx, { action: 'task.cancelled', entityType: 'task', entityId: id, metadata: { reason, about: aboutOf(current) } });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- helpers

  private baseQuery(tx: Tx) {
    return tx
      .selectFrom('tasks as t')
      .innerJoin('companyMemberships as am', 'am.id', 't.assignedTo')
      .innerJoin('users as au', 'au.id', 'am.userId')
      .leftJoin('companyMemberships as cm', 'cm.id', 't.createdBy')
      .leftJoin('users as cu', 'cu.id', 'cm.userId')
      .leftJoin('companyMemberships as dm', 'dm.id', 't.completedBy')
      .leftJoin('users as du', 'du.id', 'dm.userId')
      .selectAll('t')
      .select([
        'au.displayName as assignedToName',
        'cu.displayName as createdByName',
        'du.displayName as completedByName',
        sql<string | null>`case t.entity_type
          when 'contact' then (select c.display_name from contacts c where c.id = t.entity_id)
          when 'lead' then (select l.reference || ' · ' || c.display_name from leads l join contacts c on c.id = l.contact_id where l.id = t.entity_id)
        end`.as('aboutLabel'),
      ]);
  }

  /** Office-scope managers see follow-ups of people in their offices. */
  private teamCondition(ctx: TenantContext) {
    return sql<boolean>`exists (select 1 from membership_offices mo where mo.membership_id = t.assigned_to
                                  and mo.office_id = any(${[...ctx.officeIds]}::uuid[]))`;
  }

  private async canSee(tx: Tx, ctx: TenantContext, row: { assignedTo: string; createdBy: string | null }): Promise<boolean> {
    if (row.assignedTo === ctx.membershipId || row.createdBy === ctx.membershipId) return true;
    return this.managerCovers(tx, ctx, row.assignedTo);
  }

  private async managerCovers(tx: Tx, ctx: TenantContext, assignee: string): Promise<boolean> {
    if (scopeOf(ctx, 'lead.assign') === null) return false;
    const grant = await memberGrant(tx, assignee, 'lead.view');
    const offices = grant?.officeIds ?? (await tx.selectFrom('membershipOffices').select('officeId').where('membershipId', '=', assignee).execute()).map((row) => row.officeId);
    return assignerCovers(ctx, { membershipId: assignee, name: '', scope: grant?.scope ?? null, officeIds: offices });
  }

  /** Open follow-up locked for a change: the assignee, its creator, or a manager over the assignee. */
  private async lockOpen(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number) {
    const current = await tx.selectFrom('tasks').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current || !(await this.canSee(tx, ctx, current))) throw Problems.notFound();
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.status !== 'open') throw Problems.businessRule('This follow-up is closed. Schedule a new one instead.');
    return current;
  }

  private async toDto(tx: Tx, ctx: TenantContext, row: Awaited<ReturnType<ReturnType<TasksService['baseQuery']>['executeTakeFirstOrThrow']>>): Promise<TaskDto> {
    const open = row.status === 'open';
    const now = Date.now();
    const canEdit = open && (row.assignedTo === ctx.membershipId || row.createdBy === ctx.membershipId || (await this.managerCovers(tx, ctx, row.assignedTo)));
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      taskType: row.taskType,
      priority: row.priority,
      status: row.status,
      dueAt: row.dueAt?.toISOString() ?? null,
      remindAt: row.remindAt?.toISOString() ?? null,
      overdue: open && row.dueAt !== null && row.dueAt.getTime() < now,
      reminderDue: open && row.remindAt !== null && row.remindAt.getTime() <= now,
      assignedTo: { id: row.assignedTo, name: row.assignedToName },
      about: row.entityType !== null && row.entityId !== null ? { entityType: row.entityType, entityId: row.entityId, label: row.aboutLabel ?? '' } : null,
      createdBy: row.createdBy !== null ? { id: row.createdBy, name: row.createdByName ?? '' } : null,
      completedAt: row.completedAt?.toISOString() ?? null,
      completedBy: row.completedBy !== null ? { id: row.completedBy, name: row.completedByName ?? '' } : null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      canEdit,
      canReassign: open && scopeOf(ctx, 'lead.assign') !== null && (row.assignedTo === ctx.membershipId || (await this.managerCovers(tx, ctx, row.assignedTo))),
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  /** The record a follow-up is about must be one the member can work with. */
  private async checkAbout(tx: Tx, ctx: TenantContext, entityType: string, entityId: string, errors: FieldError[]) {
    if (entityType === 'contact') {
      const contact = await this.contacts.loadRow(tx, entityId);
      if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) {
        errors.push({ field: 'about.entityId', code: 'not-found', message: 'Choose a contact you can see.' });
        return null;
      }
      return { entityType, entityId, officeId: contact.officeId, assignedTo: null };
    }
    const lead = await this.leads.accessRow(tx, entityId);
    if (!lead || !canOnLead(ctx, 'lead.view', lead)) {
      errors.push({ field: 'about.entityId', code: 'not-found', message: 'Choose a lead you can see.' });
      return null;
    }
    if (lead.archivedAt !== null) {
      errors.push({ field: 'about.entityId', code: 'archived', message: 'This lead is archived.' });
      return null;
    }
    return { entityType, entityId, officeId: lead.officeId, assignedTo: lead.assignedTo };
  }

  /**
   * Decision D6: someone else only with lead.assign, within the manager's
   * scope; they must be able to open what the follow-up is about.
   */
  private async checkAssignee(
    tx: Tx,
    ctx: TenantContext,
    membershipId: string,
    about: { entityType: string; entityId: string; officeId?: string | null; assignedTo?: string | null } | null,
    errors: FieldError[],
  ): Promise<void> {
    if (scopeOf(ctx, 'lead.assign') === null) {
      errors.push({ field: 'assignedTo', code: 'not-allowed', message: 'You can only schedule follow-ups for yourself.' });
      return;
    }
    const grant: MemberGrant | null = await memberGrant(tx, membershipId, about?.entityType === 'lead' ? 'lead.view' : 'contact.view');
    if (!grant || grant.scope === null || !assignerCovers(ctx, grant)) {
      errors.push({ field: 'assignedTo', code: 'not-assignable', message: 'Choose an active team member in your team.' });
      return;
    }
    if (about?.entityType === 'lead') {
      const lead = await this.leads.accessRow(tx, about.entityId);
      if (!lead || !grantCoversLead(grant, lead)) {
        errors.push({ field: 'assignedTo', code: 'out-of-scope', message: `${grant.name} cannot open this lead. Assign the lead to them first.` });
      }
    }
  }

  /** leads.next_action_at follows the earliest open follow-up on the lead (wireframe L-2). */
  private async syncNextAction(tx: Tx, about: { entityType: string; entityId: string } | null): Promise<void> {
    if (about?.entityType !== 'lead') return;
    await sql`
      update leads l set next_action_at = n.due
        from (select min(due_at) as due from tasks where entity_type = 'lead' and entity_id = ${about.entityId}::uuid and status = 'open') n
       where l.id = ${about.entityId}::uuid and l.next_action_at is distinct from n.due`.execute(tx);
  }
}

function aboutOf(row: { entityType: string | null; entityId: string | null }) {
  return row.entityType !== null && row.entityId !== null ? { entityType: row.entityType, entityId: row.entityId } : null;
}

/** New times must not be in the past; a reminder never comes after the due time. */
function checkTimes(dueAt: Date | null, remindAt: Date | null, changed: { dueChanged: boolean; remindChanged: boolean }, errors: FieldError[]): void {
  const now = Date.now();
  if (dueAt && changed.dueChanged && dueAt.getTime() < now - PAST_TOLERANCE_MS) {
    errors.push({ field: 'dueAt', code: 'in-past', message: 'Choose a time from now on.' });
  }
  if (remindAt && changed.remindChanged && remindAt.getTime() < now - PAST_TOLERANCE_MS) {
    errors.push({ field: 'remindAt', code: 'in-past', message: 'Choose a reminder time from now on.' });
  }
  if (remindAt && dueAt && (changed.dueChanged || changed.remindChanged) && remindAt > dueAt) {
    errors.push({ field: 'remindAt', code: 'after-due', message: 'The reminder must come before the due time.' });
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
