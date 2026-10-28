import { Injectable } from '@nestjs/common';
import { type Selectable, sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { keysetCondition, type Page, type ParsedListQuery, sortValueSql, toPage } from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import type { PropertyNotes } from '../database/schema.js';
import { assertPropertyRecordAccess, propertyCovered } from '../properties/property-access.js';
import type { CreateNoteBody, NoteDto, NoteRevisionPageDto, UpdateNoteBody } from './dto.js';

/** Pinned notes shown at the top of a property (service rule, ADR-006). */
export const MAX_PINNED_NOTES = 5;
const REDACTED = '[Redacted]';

type NoteRow = Selectable<PropertyNotes>;
export type NoteSortField = 'createdAt' | 'updatedAt';

/**
 * Property notes (PRP-07, ADR-006 L-D6 to L-D9).
 *   view    property_note.view, scoped by property
 *   create  property_note.create: add internal notes; edit, pin and archive your own
 *   manage  property_note.manage: anyone's notes, external visibility, redaction
 * Earlier text goes to property_note_revisions; audit rows carry lengths and
 * revision numbers, never the text (L-D7).
 */
@Injectable()
export class NotesService {
  constructor(private readonly audit: AuditService) {}

  async list(tx: Tx, ctx: TenantContext, propertyId: string, query: ParsedListQuery<NoteSortField>): Promise<Page<NoteDto>> {
    await assertPropertyRecordAccess(tx, ctx, propertyId, 'property_note.view');
    const sortColumn = `n.${query.sort.field}`;
    let qb = this.noteQuery(tx)
      .select(sortValueSql(sortColumn, query.sort.kind).as('cursorValue'))
      .where('n.propertyId', '=', propertyId);
    const { filters } = query;
    const archived = filters['archived'] ?? 'false';
    if (archived === 'false') qb = qb.where('n.archivedAt', 'is', null);
    if (archived === 'true') qb = qb.where('n.archivedAt', 'is not', null);
    if (Array.isArray(filters['unitId'])) qb = qb.where('n.unitId', 'in', filters['unitId']);
    if (Array.isArray(filters['category'])) qb = qb.where('n.category', 'in', filters['category']);
    if (Array.isArray(filters['visibility'])) qb = qb.where('n.visibility', 'in', filters['visibility']);
    if (Array.isArray(filters['authorId'])) qb = qb.where('n.createdBy', 'in', filters['authorId']);
    if (typeof filters['pinned'] === 'boolean') qb = qb.where('n.isPinned', '=', filters['pinned']);
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'n.id', query.sort, query.cursor));
    const rows = await qb
      .orderBy(sql.ref(sortColumn), query.sort.direction)
      .orderBy('n.id', query.sort.direction)
      .limit(query.limit + 1)
      .execute();
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, toNoteDto);
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<NoteDto> {
    const note = await this.visibleNote(tx, ctx, id);
    return this.load(tx, note.id);
  }

  async create(tx: Tx, ctx: TenantContext, propertyId: string, body: CreateNoteBody): Promise<NoteDto> {
    await assertPropertyRecordAccess(tx, ctx, propertyId, 'property_note.view', 'property_note.create');
    const property = await this.lockProperty(tx, propertyId);
    const visibility = body.visibility ?? 'internal';
    if (visibility !== 'internal') await this.assertCanManage(tx, ctx, propertyId, 'Only managers and admins can share notes with landlords or tenants.');
    const errors = await this.checkPlacement(tx, propertyId, body.unitId ?? null, visibility);
    if (errors.length > 0) throw Problems.validation(errors);
    if (property.archivedAt !== null) throw Problems.businessRule('Notes cannot be added to an archived property. Restore the property first.');
    if (body.isPinned) await this.assertPinRoom(tx, propertyId);

    const inserted = await tx
      .insertInto('propertyNotes')
      .values({
        companyId: ctx.companyId,
        propertyId,
        unitId: body.unitId ?? null,
        body: body.body,
        category: body.category ?? 'general',
        visibility,
        isPinned: body.isPinned ?? false,
        pinnedAt: body.isPinned ? new Date() : null,
        createdBy: ctx.membershipId,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'property_note.created',
      entityType: 'property_note',
      entityId: inserted.id,
      metadata: {
        propertyId,
        unitId: body.unitId ?? null,
        category: body.category ?? 'general',
        visibility,
        isPinned: body.isPinned ?? false,
        bodyLength: body.body.length,
      },
    });
    return this.load(tx, inserted.id);
  }

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateNoteBody): Promise<NoteDto> {
    const current = await this.visibleNote(tx, ctx, id, true);
    await this.assertCanChange(tx, ctx, current);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.redactedAt !== null) throw Problems.businessRule('A redacted note cannot be edited. Add a new note instead.');
    if (current.archivedAt !== null) throw Problems.businessRule('Archived notes cannot be edited. Restore the note first.');

    const visibility = body.visibility ?? current.visibility;
    const unitId = body.unitId === undefined ? current.unitId : body.unitId;
    if (visibility !== current.visibility) {
      await this.assertCanManage(tx, ctx, current.propertyId, 'Only managers and admins can change who can see a note outside the company.');
    }
    const errors = await this.checkPlacement(tx, current.propertyId, unitId, visibility);
    if (errors.length > 0) throw Problems.validation(errors);

    const patch: { body?: string; category?: string; visibility?: string; unitId?: string | null; isPinned?: boolean; pinnedAt?: Date | null } = {};
    if (body.body !== undefined && body.body !== current.body) patch.body = body.body;
    if (body.category !== undefined && body.category !== current.category) patch.category = body.category;
    if (visibility !== current.visibility) patch.visibility = visibility;
    if (unitId !== current.unitId) patch.unitId = unitId;
    if (body.isPinned !== undefined && body.isPinned !== current.isPinned) {
      if (body.isPinned) {
        await this.lockProperty(tx, current.propertyId);
        await this.assertPinRoom(tx, current.propertyId);
      }
      patch.isPinned = body.isPinned;
      patch.pinnedAt = body.isPinned ? new Date() : null;
    }
    if (Object.keys(patch).length === 0) return this.load(tx, id);

    let revision: number | null = null;
    if (patch.body !== undefined) revision = await this.keepRevision(tx, ctx, current);
    await tx
      .updateTable('propertyNotes')
      .set({ ...patch, updatedBy: ctx.membershipId })
      .where('id', '=', id)
      .execute();

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (patch.body !== undefined) changes['bodyLength'] = { old: current.body.length, new: patch.body.length };
    if (patch.category !== undefined) changes['category'] = { old: current.category, new: patch.category };
    if (patch.unitId !== undefined) changes['unitId'] = { old: current.unitId, new: patch.unitId };
    if (patch.isPinned !== undefined) changes['isPinned'] = { old: current.isPinned, new: patch.isPinned };
    if (Object.keys(changes).length > 0) {
      await this.audit.record(tx, ctx, {
        action: 'property_note.updated',
        entityType: 'property_note',
        entityId: id,
        changes,
        metadata: { propertyId: current.propertyId, ...(revision !== null ? { revision } : {}) },
      });
    }
    if (patch.visibility !== undefined) {
      await this.audit.record(tx, ctx, {
        action: 'property_note.visibility_changed',
        entityType: 'property_note',
        entityId: id,
        changes: { visibility: { old: current.visibility, new: patch.visibility } },
        metadata: { propertyId: current.propertyId },
      });
    }
    return this.load(tx, id);
  }

  async archive(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<NoteDto> {
    const current = await this.visibleNote(tx, ctx, id, true);
    await this.assertCanChange(tx, ctx, current);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt !== null) throw Problems.businessRule('This note is already archived.');
    await tx
      .updateTable('propertyNotes')
      .set({ archivedAt: new Date(), archivedBy: ctx.membershipId, archivedReason: reason, isPinned: false, pinnedAt: null })
      .where('id', '=', id)
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'property_note.archived',
      entityType: 'property_note',
      entityId: id,
      metadata: { propertyId: current.propertyId, reason },
    });
    return this.load(tx, id);
  }

  async restore(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<NoteDto> {
    const current = await this.visibleNote(tx, ctx, id, true);
    await this.assertCanChange(tx, ctx, current);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt === null) throw Problems.businessRule('This note is not archived.');
    await tx
      .updateTable('propertyNotes')
      .set({ archivedAt: null, archivedBy: null, archivedReason: null })
      .where('id', '=', id)
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'property_note.restored',
      entityType: 'property_note',
      entityId: id,
      metadata: { propertyId: current.propertyId },
    });
    return this.load(tx, id);
  }

  /** Erasure: the text of the note and of every revision is replaced (Manage Notes only). */
  async redact(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<NoteDto> {
    const current = await this.visibleNote(tx, ctx, id, true);
    await this.assertCanManage(tx, ctx, current.propertyId, 'Only managers and admins can redact notes.');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.redactedAt !== null) throw Problems.businessRule('This note is already redacted.');
    await sql`select app.redact_property_note(${id}::uuid, ${ctx.membershipId}::uuid)`.execute(tx);
    await this.audit.record(tx, ctx, {
      action: 'property_note.redacted',
      entityType: 'property_note',
      entityId: id,
      metadata: { propertyId: current.propertyId, reason },
    });
    return this.load(tx, id);
  }

  /** Earlier text, newest first: the author and Manage Notes holders only. */
  async revisions(tx: Tx, ctx: TenantContext, id: string, limit: number, before: number | null): Promise<NoteRevisionPageDto> {
    const note = await this.visibleNote(tx, ctx, id);
    if (note.createdBy !== ctx.membershipId && !(await propertyCovered(tx, ctx, note.propertyId, 'property_note.manage'))) {
      throw Problems.forbidden('Only the author and managers can see the history of a note.');
    }
    let qb = tx
      .selectFrom('propertyNoteRevisions as r')
      .leftJoin('companyMemberships as m', 'm.id', 'r.writtenBy')
      .leftJoin('users as u', 'u.id', 'm.userId')
      .select(['r.revision', 'r.body', 'r.writtenBy', 'u.displayName as writerName', 'r.writtenAt', 'r.supersededAt', 'r.redactedAt'])
      .where('r.noteId', '=', id);
    if (before !== null) qb = qb.where('r.revision', '<', before);
    const rows = await qb.orderBy('r.revision', 'desc').limit(limit + 1).execute();
    const page = rows.slice(0, limit);
    return {
      data: page.map((row) => ({
        revision: row.revision,
        body: row.body,
        writtenBy: row.writtenBy === null ? null : { membershipId: row.writtenBy, displayName: row.writerName ?? '' },
        writtenAt: row.writtenAt.toISOString(),
        supersededAt: row.supersededAt.toISOString(),
        redactedAt: row.redactedAt?.toISOString() ?? null,
      })),
      nextBefore: rows.length > limit ? page[page.length - 1]!.revision : null,
    };
  }

  // --------------------------------------------------------------------------- helpers

  /** The note if the member may see it (its property is within their notes scope); 404 otherwise. */
  private async visibleNote(tx: Tx, ctx: TenantContext, id: string, forUpdate = false): Promise<NoteRow> {
    let qb = tx.selectFrom('propertyNotes').selectAll().where('id', '=', id);
    if (forUpdate) qb = qb.forUpdate();
    const note = await qb.executeTakeFirst();
    if (!note || !(await propertyCovered(tx, ctx, note.propertyId, 'property_note.view'))) throw Problems.notFound();
    return note;
  }

  /** Authors change their own notes with Create Notes; anything else needs Manage Notes. */
  private async assertCanChange(tx: Tx, ctx: TenantContext, note: NoteRow): Promise<void> {
    if (await propertyCovered(tx, ctx, note.propertyId, 'property_note.manage')) return;
    if (note.createdBy === ctx.membershipId && (await propertyCovered(tx, ctx, note.propertyId, 'property_note.create'))) return;
    throw Problems.forbidden('You can change only your own notes.');
  }

  private async assertCanManage(tx: Tx, ctx: TenantContext, propertyId: string, message: string): Promise<void> {
    if (!(await propertyCovered(tx, ctx, propertyId, 'property_note.manage'))) throw Problems.forbidden(message);
  }

  private async checkPlacement(tx: Tx, propertyId: string, unitId: string | null, visibility: string): Promise<FieldError[]> {
    if (unitId !== null) {
      const unit = await tx.selectFrom('units').select('id').where('id', '=', unitId).where('propertyId', '=', propertyId).executeTakeFirst();
      if (!unit) return [{ field: 'unitId', code: 'not-found', message: 'This unit does not belong to the property.' }];
    }
    if (visibility === 'tenant' && unitId === null) {
      return [{ field: 'unitId', code: 'required', message: 'Choose the unit: a note for tenants is shown only to the tenants of that unit.' }];
    }
    return [];
  }

  /** Serialises pinning per property so the limit holds under concurrent requests. */
  private async lockProperty(tx: Tx, propertyId: string) {
    return tx.selectFrom('properties').select(['id', 'archivedAt']).where('id', '=', propertyId).forUpdate().executeTakeFirstOrThrow();
  }

  private async assertPinRoom(tx: Tx, propertyId: string): Promise<void> {
    const pinned = await tx
      .selectFrom('propertyNotes')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('propertyId', '=', propertyId)
      .where('isPinned', '=', true)
      .where('archivedAt', 'is', null)
      .executeTakeFirstOrThrow();
    if (pinned.count >= MAX_PINNED_NOTES) {
      throw Problems.businessRule(`A property can have at most ${MAX_PINNED_NOTES} pinned notes. Unpin one first.`);
    }
  }

  /** Stores the text being replaced, with who wrote it and when. Returns its revision number. */
  private async keepRevision(tx: Tx, ctx: TenantContext, current: NoteRow): Promise<number> {
    const previous = await tx
      .selectFrom('propertyNoteRevisions')
      .select(['supersededBy', 'supersededAt'])
      .where('noteId', '=', current.id)
      .orderBy('revision', 'desc')
      .limit(1)
      .executeTakeFirst();
    await tx
      .insertInto('propertyNoteRevisions')
      .values({
        companyId: ctx.companyId,
        noteId: current.id,
        revision: current.version,
        body: current.body,
        writtenBy: previous ? previous.supersededBy : current.createdBy,
        writtenAt: previous ? previous.supersededAt : current.createdAt,
        supersededBy: ctx.membershipId,
      })
      .execute();
    return current.version;
  }

  private noteQuery(tx: Tx) {
    return tx
      .selectFrom('propertyNotes as n')
      .leftJoin('companyMemberships as am', 'am.id', 'n.createdBy')
      .leftJoin('users as au', 'au.id', 'am.userId')
      .leftJoin('companyMemberships as um', 'um.id', 'n.updatedBy')
      .leftJoin('users as uu', 'uu.id', 'um.userId')
      .selectAll('n')
      .select((eb) => [
        'au.displayName as authorName',
        'uu.displayName as updaterName',
        eb
          .selectFrom('propertyNoteRevisions as r')
          .select(sql<number>`count(*)::int`.as('n'))
          .whereRef('r.noteId', '=', 'n.id')
          .as('revisionCount'),
      ]);
  }

  private async load(tx: Tx, id: string): Promise<NoteDto> {
    return toNoteDto(await this.noteQuery(tx).where('n.id', '=', id).executeTakeFirstOrThrow());
  }
}

function toNoteDto(row: NoteRow & { authorName: string | null; updaterName: string | null; revisionCount: number | null }): NoteDto {
  return {
    id: row.id,
    propertyId: row.propertyId,
    unitId: row.unitId,
    body: row.redactedAt !== null ? REDACTED : row.body,
    category: row.category,
    visibility: row.visibility,
    isPinned: row.isPinned,
    pinnedAt: row.pinnedAt?.toISOString() ?? null,
    source: row.source,
    author: row.createdBy === null ? null : { membershipId: row.createdBy, displayName: row.authorName ?? '' },
    updatedBy: row.updatedBy === null ? null : { membershipId: row.updatedBy, displayName: row.updaterName ?? '' },
    revisionCount: row.revisionCount ?? 0,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    archivedReason: row.archivedReason,
    redactedAt: row.redactedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
