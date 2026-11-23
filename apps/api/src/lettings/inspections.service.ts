import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { keysetCondition, type Page, type ParsedListQuery, type RangeValue, sortValueSql, toPage } from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import { actingMembership, type TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { DocumentsService } from '../documents/documents.service.js';
import { nextReference } from '../properties/properties.service.js';
import type {
  CancelInspectionBody,
  CompleteInspectionBody,
  InspectionDto,
  InspectionItemDto,
  InspectionItemsBody,
  InspectionPhotoBody,
  InspectionSummaryDto,
  ScheduleInspectionBody,
  TenantAcknowledgementBody,
  UpdateInspectionBody,
} from './inspections.dto.js';
import { canOnInspection, canOnLease, type InspectionAccessRow, inspectionAccess, inspectionScopeSql, leaseAccess } from './lettings-access.js';

export type InspectionSortField = 'scheduledAt' | 'completedAt';

const OPEN = ['scheduled', 'in_progress'];
const PHOTO_TYPES = ['image/jpeg', 'image/png'];

/**
 * Inspections (LET-09; wireframes IN-1 to IN-3; readiness §5.7; W7-S1).
 * An inspection is scheduled for a property or unit (move-in and move-out
 * inspections for a lease), started, recorded item by item with photos, and
 * completed with the overall condition; the tenant's acknowledgement is added
 * afterwards. Items come from the unit's last completed inspection when one
 * exists; otherwise the screen offers the company's default areas (settings).
 * A move-out inspection shows each item's move-in condition. An inspection in
 * progress is changed by its inspector only (or a member who sees every
 * inspection). Photos are documents of the inspection (scanned) linked to an
 * item; the inspection is completed once every photo has passed the scan. The
 * database enforces the life cycle (migration 0039); this service checks first
 * to answer with field codes, and adds scope, audit and outbox events.
 */
@Injectable()
export class InspectionsService {
  constructor(
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, query: ParsedListQuery<InspectionSortField>): Promise<Page<InspectionSummaryDto>> {
    const f = query.filters;
    const column = `i.${query.sort.field}`;
    let qb = summaryQuery(tx)
      .select(sortValueSql(column, query.sort.kind).as('cursorValue'))
      .where(inspectionScopeSql(ctx.permissions.get('inspection.view')?.scope, ctx));
    if (query.sort.field === 'completedAt') qb = qb.where('i.completedAt', 'is not', null);
    for (const [filter, col] of [
      ['status', 'i.status'],
      ['inspectionType', 'i.inspectionType'],
      ['propertyId', 'i.propertyId'],
      ['unitId', 'i.unitId'],
      ['leaseId', 'i.leaseId'],
      ['inspectorId', 'i.inspectorMembershipId'],
      ['officeId', 'p.officeId'],
    ] as const) {
      const values = f[filter];
      if (Array.isArray(values)) qb = qb.where(col, 'in', values);
    }
    const scheduled = f['scheduledAt'] as RangeValue | undefined;
    if (scheduled?.gte) qb = qb.where(sql<boolean>`i.scheduled_at >= (${scheduled.gte}::date)::timestamp at time zone p.timezone`);
    if (scheduled?.lte) qb = qb.where(sql<boolean>`i.scheduled_at < (${scheduled.lte}::date + 1)::timestamp at time zone p.timezone`);
    if (query.cursor) qb = qb.where(keysetCondition(column, 'i.id', query.sort, query.cursor));
    const rows = await qb.orderBy(sql.ref(column), query.sort.direction).orderBy('i.id', query.sort.direction).limit(query.limit + 1).execute();
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, toSummary);
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<InspectionDto> {
    const access = await inspectionAccess(tx, id);
    if (!access || !canOnInspection(ctx, 'inspection.view', access)) throw Problems.notFound();
    const row = await summaryQuery(tx)
      .leftJoin('documents as rd', 'rd.id', 'i.reportDocumentId')
      .leftJoin('companyMemberships as cm', 'cm.id', 'i.createdBy')
      .leftJoin('users as cu', 'cu.id', 'cm.userId')
      .select(['i.startedAt', 'i.summary', 'i.tenantSignedAt', 'i.reportDocumentId', 'rd.title as reportTitle', 'i.cancelledReason', 'i.createdBy', 'cu.displayName as createdByName', 'i.createdAt', 'i.version'])
      .where('i.id', '=', id)
      .executeTakeFirstOrThrow();
    const items = await tx.selectFrom('inspectionItems').selectAll().where('inspectionId', '=', id).orderBy('sortOrder').orderBy('id').execute();
    const photos = items.length === 0
      ? []
      : await tx
          .selectFrom('inspectionItemDocuments as x')
          .innerJoin('documents as d', 'd.id', 'x.documentId')
          .innerJoin('documentVersions as v', 'v.id', 'd.currentVersionId')
          .select(['x.inspectionItemId', 'x.documentId', 'd.title', 'x.caption', 'v.scanStatus'])
          .where('x.inspectionItemId', 'in', items.map((item) => item.id))
          .orderBy('x.createdAt')
          .execute();
    // A move-out inspection is read against the lease's completed move-in inspection.
    const moveIn = row.inspectionType === 'move_out' && row.leaseId
      ? await tx.selectFrom('inspections').select(['id', 'reference']).where('leaseId', '=', row.leaseId).where('inspectionType', '=', 'move_in').where('status', '=', 'completed').executeTakeFirst()
      : undefined;
    const before = moveIn ? await tx.selectFrom('inspectionItems').select(['area', 'item', 'conditionCode', 'cleanliness']).where('inspectionId', '=', moveIn.id).execute() : [];
    const key = (area: string, item: string) => `${area.toLocaleLowerCase()}\u0000${item.toLocaleLowerCase()}`;
    const beforeByKey = new Map(before.map((b) => [key(b.area, b.item), b]));
    return {
      ...toSummary(row),
      startedAt: row.startedAt?.toISOString() ?? null,
      summary: row.summary,
      tenantSignedAt: row.tenantSignedAt?.toISOString() ?? null,
      reportDocument: row.reportDocumentId ? { id: row.reportDocumentId, name: row.reportTitle ?? '' } : null,
      cancelledReason: row.cancelledReason,
      moveIn: moveIn ? { id: moveIn.id, name: moveIn.reference } : null,
      items: items.map((item): InspectionItemDto => {
        const previous = beforeByKey.get(key(item.area, item.item));
        return {
          id: item.id,
          area: item.area,
          item: item.item,
          conditionCode: item.conditionCode,
          cleanliness: item.cleanliness,
          notes: item.notes,
          actionRequired: item.actionRequired,
          sortOrder: item.sortOrder,
          moveInCondition: previous?.conditionCode ?? null,
          moveInCleanliness: previous?.cleanliness ?? null,
          photos: photos
            .filter((photo) => photo.inspectionItemId === item.id)
            .map((photo) => ({ document: { id: photo.documentId, name: photo.title }, caption: photo.caption, scanStatus: photo.scanStatus })),
        };
      }),
      pendingPhotos: photos.filter((photo) => photo.scanStatus === 'pending').length,
      canEdit: OPEN.includes(row.status) && canOnInspection(ctx, 'inspection.manage', access) && this.isInspectorOrAll(ctx, row),
      createdBy: row.createdBy ? { id: row.createdBy, name: row.createdByName ?? '' } : null,
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  // ----------------------------------------------------------------- scheduling

  async schedule(tx: Tx, ctx: TenantContext, body: ScheduleInspectionBody): Promise<InspectionDto> {
    const errors: FieldError[] = [];
    const property = await tx.selectFrom('properties').select(['id', 'officeId', 'archivedAt']).where('id', '=', body.propertyId).executeTakeFirst();
    const lease = body.leaseId ? await leaseAccess(tx, body.leaseId) : null;
    const row: InspectionAccessRow = { officeId: property?.officeId ?? '', inspectorId: body.inspectorMembershipId ?? null, createdBy: ctx.membershipId, lease: lease ?? null };
    const scope = ctx.permissions.get('inspection.manage')?.scope;
    // A member schedules for properties of their offices (or all, with an all scope), and only leases they can see.
    const covered = property !== undefined && (scope === 'all' || ctx.officeIds.includes(property.officeId)) && canOnInspection(ctx, 'inspection.manage', row);
    if (!property || !covered) throw Problems.validation([{ field: 'propertyId', code: 'not-found', message: 'This property does not exist or you cannot inspect it.' }]);
    if (property.archivedAt !== null) errors.push({ field: 'propertyId', code: 'archived', message: 'This property is archived.' });
    if (body.unitId) {
      const unit = await tx.selectFrom('units').select(['propertyId', 'archivedAt']).where('id', '=', body.unitId).executeTakeFirst();
      if (!unit || unit.propertyId !== body.propertyId) errors.push({ field: 'unitId', code: 'not-found', message: 'This unit is not in the property.' });
    }
    if (body.inspectionType === 'move_in' || body.inspectionType === 'move_out') {
      if (!body.leaseId) errors.push({ field: 'leaseId', code: 'required', message: 'A move-in or move-out inspection is of a lease.' });
    }
    if (body.leaseId) {
      if (!lease || !canOnLease(ctx, 'lease.view', lease)) errors.push({ field: 'leaseId', code: 'not-found', message: 'This lease does not exist or you cannot see it.' });
      else {
        const leaseRow = await tx.selectFrom('leases').select(['unitId', 'status']).where('id', '=', body.leaseId).executeTakeFirstOrThrow();
        if (!body.unitId || leaseRow.unitId !== body.unitId) errors.push({ field: 'leaseId', code: 'other-unit', message: 'The lease is of another unit.' });
        else if (['draft', 'cancelled', 'closed'].includes(leaseRow.status)) errors.push({ field: 'leaseId', code: 'lease-status', message: 'This lease is not signed or is finished.' });
        else if (body.inspectionType === 'move_out' && leaseRow.status === 'pending_signature') errors.push({ field: 'leaseId', code: 'lease-status', message: 'A move-out inspection follows a lease that has started.' });
        if (body.inspectionType === 'move_in' || body.inspectionType === 'move_out') {
          const existing = await tx.selectFrom('inspections').select('reference').where('leaseId', '=', body.leaseId).where('inspectionType', '=', body.inspectionType).where('status', '<>', 'cancelled').executeTakeFirst();
          if (existing) errors.push({ field: 'inspectionType', code: 'duplicate', message: `Inspection ${existing.reference} is this lease's ${body.inspectionType === 'move_in' ? 'move-in' : 'move-out'} inspection.` });
        }
      }
    }
    if (body.inspectorMembershipId) await checkInspector(tx, body.inspectorMembershipId, 'inspectorMembershipId', errors);
    if (errors.length > 0) throw Problems.validation(errors);

    const reference = await nextReference(tx, ctx, 'inspection');
    const inserted = await tx
      .insertInto('inspections')
      .values({
        companyId: ctx.companyId,
        reference,
        propertyId: body.propertyId,
        unitId: body.unitId ?? null,
        leaseId: body.leaseId ?? null,
        inspectionType: body.inspectionType,
        scheduledAt: new Date(body.scheduledAt),
        inspectorMembershipId: body.inspectorMembershipId ?? null,
        createdBy: actingMembership(ctx),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Areas and items of the unit's last completed inspection (IN-2); conditions are recorded afresh.
    let copied = 0;
    if (body.unitId) {
      const last = await tx.selectFrom('inspections').select('id').where('unitId', '=', body.unitId).where('status', '=', 'completed').orderBy('completedAt', 'desc').limit(1).executeTakeFirst();
      if (last) {
        const result = await sql`insert into inspection_items (company_id, inspection_id, area, item, sort_order)
          select company_id, ${inserted.id}::uuid, area, item, sort_order from inspection_items where inspection_id = ${last.id}::uuid`.execute(tx);
        copied = Number(result.numAffectedRows ?? 0);
      }
    }
    await this.audit.record(tx, ctx, {
      action: 'inspection.scheduled',
      entityType: 'inspection',
      entityId: inserted.id,
      metadata: { reference, inspectionType: body.inspectionType, propertyId: body.propertyId, unitId: body.unitId ?? null, leaseId: body.leaseId ?? null, scheduledAt: body.scheduledAt, inspectorMembershipId: body.inspectorMembershipId ?? null, itemsCopied: copied },
    });
    await this.audit.emit(tx, ctx, { eventType: 'inspection.scheduled', aggregateType: 'inspection', aggregateId: inserted.id, payload: { inspectionId: inserted.id, leaseId: body.leaseId ?? null, inspectorMembershipId: body.inspectorMembershipId ?? null } });
    return this.get(tx, ctx, inserted.id);
  }

  // ----------------------------------------------------------------- recording

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateInspectionBody): Promise<InspectionDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion);
    const errors: FieldError[] = [];
    const values: Record<string, unknown> = {};
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (body.scheduledAt !== undefined || body.inspectorMembershipId !== undefined) {
      if (current.status !== 'scheduled') errors.push({ field: body.scheduledAt !== undefined ? 'scheduledAt' : 'inspectorMembershipId', code: 'started', message: 'The time and the inspector change while the inspection is scheduled.' });
    }
    if (body.inspectorMembershipId) await checkInspector(tx, body.inspectorMembershipId, 'inspectorMembershipId', errors);
    if (errors.length > 0) throw Problems.validation(errors);
    if (body.scheduledAt !== undefined && new Date(body.scheduledAt).getTime() !== current.scheduledAt?.getTime()) {
      values['scheduledAt'] = new Date(body.scheduledAt);
      changes['scheduledAt'] = { old: current.scheduledAt?.toISOString() ?? null, new: new Date(body.scheduledAt).toISOString() };
    }
    if (body.inspectorMembershipId !== undefined && body.inspectorMembershipId !== current.inspectorMembershipId) {
      values['inspectorMembershipId'] = body.inspectorMembershipId;
      changes['inspectorMembershipId'] = { old: current.inspectorMembershipId, new: body.inspectorMembershipId };
    }
    if (body.overallCondition !== undefined && body.overallCondition !== current.overallCondition) {
      values['overallCondition'] = body.overallCondition;
      changes['overallCondition'] = { old: current.overallCondition, new: body.overallCondition };
    }
    const summary = body.summary === '' ? null : body.summary;
    if (summary !== undefined && summary !== current.summary) {
      values['summary'] = summary;
      changes['summary'] = { old: current.summary === null ? null : '[text]', new: summary === null ? null : '[text]' };
    }
    if (body.action === 'start') {
      if (current.status !== 'scheduled') throw Problems.businessRule('Only a scheduled inspection is started.');
      values['status'] = 'in_progress';
      values['startedAt'] = sql<Date>`now()`;
      changes['status'] = { old: 'scheduled', new: 'in_progress' };
      if (!current.inspectorMembershipId && !values['inspectorMembershipId']) {
        values['inspectorMembershipId'] = actingMembership(ctx);
        changes['inspectorMembershipId'] = { old: null, new: actingMembership(ctx) };
      }
    }
    if (Object.keys(values).length === 0) return this.get(tx, ctx, id);
    await tx.updateTable('inspections').set(values).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: body.action === 'start' ? 'inspection.started' : 'inspection.updated', entityType: 'inspection', entityId: id, changes });
    if (changes['inspectorMembershipId']?.new) {
      await this.audit.emit(tx, ctx, { eventType: 'inspection.assigned', aggregateType: 'inspection', aggregateId: id, payload: { inspectionId: id, inspectorMembershipId: changes['inspectorMembershipId'].new } });
    }
    return this.get(tx, ctx, id);
  }

  async saveItems(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: InspectionItemsBody): Promise<InspectionDto> {
    await this.lock(tx, ctx, id, expectedVersion);
    const existing = await tx.selectFrom('inspectionItems').select('id').where('inspectionId', '=', id).execute();
    const known = new Set(existing.map((item) => item.id));
    const errors: FieldError[] = [];
    const seen = new Set<string>();
    body.items.forEach((item, index) => {
      if (item.id && !known.has(item.id)) errors.push({ field: `items.${index}.id`, code: 'not-found', message: 'This item is not on the inspection.' });
      const key = `${item.area.toLocaleLowerCase()}\u0000${item.item.toLocaleLowerCase()}`;
      if (seen.has(key)) errors.push({ field: `items.${index}.item`, code: 'duplicate', message: 'This area already has this item.' });
      seen.add(key);
    });
    const ids = body.items.map((item) => item.id).filter((itemId): itemId is string => itemId !== undefined);
    if (new Set(ids).size !== ids.length) errors.push({ field: 'items', code: 'duplicate-id', message: 'Each item appears once.' });
    if (errors.length > 0) throw Problems.validation(errors);
    const removed = [...known].filter((itemId) => !ids.includes(itemId));
    if (removed.length > 0) await tx.deleteFrom('inspectionItems').where('id', 'in', removed).execute();
    let added = 0;
    for (const [index, item] of body.items.entries()) {
      const values = {
        area: item.area,
        item: item.item,
        conditionCode: item.conditionCode ?? null,
        cleanliness: item.cleanliness ?? null,
        notes: item.notes === '' ? null : (item.notes ?? null),
        actionRequired: item.actionRequired ?? false,
        sortOrder: index,
      };
      if (item.id) await tx.updateTable('inspectionItems').set(values).where('id', '=', item.id).execute();
      else {
        await tx.insertInto('inspectionItems').values({ companyId: ctx.companyId, inspectionId: id, ...values }).execute();
        added += 1;
      }
    }
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, { action: 'inspection.items_saved', entityType: 'inspection', entityId: id, metadata: { items: body.items.length, added, removed: removed.length } });
    return this.get(tx, ctx, id);
  }

  async addPhoto(tx: Tx, ctx: TenantContext, id: string, itemId: string, expectedVersion: number, body: InspectionPhotoBody): Promise<InspectionDto> {
    await this.lock(tx, ctx, id, expectedVersion);
    const item = await tx.selectFrom('inspectionItems').select('id').where('id', '=', itemId).where('inspectionId', '=', id).executeTakeFirst();
    if (!item) throw Problems.notFound();
    const document = await tx
      .selectFrom('documents as d')
      .innerJoin('documentVersions as v', 'v.id', 'd.currentVersionId')
      .select(['v.mimeType', 'v.scanStatus'])
      .where('d.id', '=', body.documentId)
      .where((eb) => eb.exists(eb.selectFrom('documentLinks as k').select('k.documentId').whereRef('k.documentId', '=', 'd.id').where('k.entityType', '=', 'inspection').where('k.entityId', '=', id)))
      .executeTakeFirst();
    const errors: FieldError[] = [];
    if (!document) errors.push({ field: 'documentId', code: 'not-found', message: 'Upload the photo to this inspection first.' });
    else if (!PHOTO_TYPES.includes(document.mimeType)) errors.push({ field: 'documentId', code: 'not-photo', message: 'A photo is a JPEG or PNG image.' });
    else if (document.scanStatus === 'infected' || document.scanStatus === 'failed') errors.push({ field: 'documentId', code: 'scan-failed', message: 'The photo did not pass the security scan. Upload it again.' });
    if (errors.length > 0) throw Problems.validation(errors);
    const linked = await tx.selectFrom('inspectionItemDocuments').select('documentId').where('inspectionItemId', '=', itemId).where('documentId', '=', body.documentId).executeTakeFirst();
    if (linked) return this.get(tx, ctx, id);
    await tx.insertInto('inspectionItemDocuments').values({ companyId: ctx.companyId, inspectionItemId: itemId, documentId: body.documentId, caption: body.caption ?? null, createdBy: actingMembership(ctx) }).execute();
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, { action: 'inspection.photo_added', entityType: 'inspection', entityId: id, metadata: { itemId, documentId: body.documentId } });
    return this.get(tx, ctx, id);
  }

  async removePhoto(tx: Tx, ctx: TenantContext, id: string, itemId: string, documentId: string, expectedVersion: number): Promise<InspectionDto> {
    await this.lock(tx, ctx, id, expectedVersion);
    const removed = await tx
      .deleteFrom('inspectionItemDocuments')
      .where('inspectionItemId', '=', itemId)
      .where('documentId', '=', documentId)
      .where('inspectionItemId', 'in', tx.selectFrom('inspectionItems').select('id').where('inspectionId', '=', id))
      .returning('documentId')
      .executeTakeFirst();
    if (!removed) throw Problems.notFound();
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, { action: 'inspection.photo_removed', entityType: 'inspection', entityId: id, metadata: { itemId, documentId } });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- finishing

  async complete(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: CompleteInspectionBody): Promise<InspectionDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion);
    if (current.status !== 'in_progress') throw Problems.businessRule('Start the inspection, then complete it.');
    const items = await tx.selectFrom('inspectionItems').select(['id', 'conditionCode']).where('inspectionId', '=', id).orderBy('sortOrder').execute();
    const errors: FieldError[] = [];
    if (current.overallCondition === null) errors.push({ field: 'overallCondition', code: 'required', message: 'Record the overall condition.' });
    if (items.length === 0) errors.push({ field: 'items', code: 'required', message: 'Record at least one item.' });
    items.forEach((item, index) => {
      if (item.conditionCode === null) errors.push({ field: `items.${index}.conditionCode`, code: 'required', message: 'Record the condition of every item.' });
    });
    if (errors.length > 0) throw Problems.validation(errors);
    const scans = items.length === 0
      ? []
      : await tx
          .selectFrom('inspectionItemDocuments as x')
          .innerJoin('documents as d', 'd.id', 'x.documentId')
          .innerJoin('documentVersions as v', 'v.id', 'd.currentVersionId')
          .select('v.scanStatus')
          .where('x.inspectionItemId', 'in', items.map((item) => item.id))
          .execute();
    if (scans.some((scan) => scan.scanStatus === 'pending')) throw Problems.businessRule('Some photos are still being checked. Finish once every photo has passed the scan.');
    if (scans.some((scan) => scan.scanStatus !== 'clean')) throw Problems.businessRule('A photo did not pass the security scan. Remove it or upload it again.');
    if (body.reportDocumentId) await this.documents.assertClean(tx, body.reportDocumentId, 'inspection', id, 'reportDocumentId');
    await tx
      .updateTable('inspections')
      .set({ status: 'completed', completedAt: sql<Date>`now()`, reportDocumentId: body.reportDocumentId ?? current.reportDocumentId })
      .where('id', '=', id)
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'inspection.completed',
      entityType: 'inspection',
      entityId: id,
      changes: { status: { old: 'in_progress', new: 'completed' } },
      metadata: { overallCondition: current.overallCondition, items: items.length, photos: scans.length, reportDocumentId: body.reportDocumentId ?? null },
    });
    await this.audit.emit(tx, ctx, { eventType: 'inspection.completed', aggregateType: 'inspection', aggregateId: id, payload: { inspectionId: id, leaseId: current.leaseId, inspectionType: current.inspectionType } });
    return this.get(tx, ctx, id);
  }

  async acknowledge(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: TenantAcknowledgementBody): Promise<InspectionDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, true);
    if (current.status !== 'completed') throw Problems.businessRule('The tenant acknowledges a completed inspection.');
    if (current.tenantSignedAt !== null) throw Problems.businessRule("The tenant's acknowledgement is recorded already.");
    if (!current.leaseId) throw Problems.businessRule('This inspection is not of a lease.');
    const at = new Date(body.acknowledgedAt);
    const errors: FieldError[] = [];
    if (at.getTime() > Date.now() + 5 * 60_000) errors.push({ field: 'acknowledgedAt', code: 'future', message: 'Record the acknowledgement once it is given.' });
    else if (current.completedAt && at.getTime() < current.completedAt.getTime()) errors.push({ field: 'acknowledgedAt', code: 'before-completion', message: 'The tenant acknowledges the inspection after it is completed.' });
    if (errors.length > 0) throw Problems.validation(errors);
    await tx.updateTable('inspections').set({ tenantSignedAt: at }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'inspection.tenant_acknowledged', entityType: 'inspection', entityId: id, metadata: { acknowledgedAt: at.toISOString() } });
    await this.audit.emit(tx, ctx, { eventType: 'inspection.tenant_acknowledged', aggregateType: 'inspection', aggregateId: id, payload: { inspectionId: id, leaseId: current.leaseId } });
    return this.get(tx, ctx, id);
  }

  async cancel(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: CancelInspectionBody): Promise<InspectionDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion);
    await tx.updateTable('inspections').set({ status: 'cancelled', cancelledReason: body.reason }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'inspection.cancelled', entityType: 'inspection', entityId: id, changes: { status: { old: current.status, new: 'cancelled' } } });
    await this.audit.emit(tx, ctx, { eventType: 'inspection.cancelled', aggregateType: 'inspection', aggregateId: id, payload: { inspectionId: id, leaseId: current.leaseId } });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- helpers

  /**
   * The inspection locked for a change: inspection.manage in scope, the
   * version, and (unless `completed`) still open; in progress, its inspector
   * only, or a member who sees every inspection.
   */
  private async lock(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, completed = false) {
    const access = await inspectionAccess(tx, id);
    if (!access || !canOnInspection(ctx, 'inspection.view', access)) throw Problems.notFound();
    if (!canOnInspection(ctx, 'inspection.manage', access)) throw Problems.forbidden('Your role does not allow changes to this inspection.');
    const row = await tx.selectFrom('inspections').selectAll().where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
    if (row.version !== expectedVersion) throw Problems.preconditionFailed();
    if (!completed && !OPEN.includes(row.status)) throw Problems.businessRule(`This inspection is ${row.status === 'completed' ? 'completed' : 'cancelled'} and no longer changes.`);
    if (!completed && !this.isInspectorOrAll(ctx, row)) throw Problems.businessRule('Another inspector is carrying out this inspection. It is read only for you.');
    return row;
  }

  private isInspectorOrAll(ctx: TenantContext, row: { status: string; inspectorMembershipId: string | null }): boolean {
    return row.status !== 'in_progress' || row.inspectorMembershipId === null || row.inspectorMembershipId === ctx.membershipId || ctx.permissions.get('inspection.manage')?.scope === 'all';
  }

  private async touch(tx: Tx, id: string): Promise<void> {
    await tx.updateTable('inspections').set({ version: sql`version + 1` }).where('id', '=', id).execute();
  }
}

// ----------------------------------------------------------------------------- shared

async function checkInspector(tx: Tx, membershipId: string, field: string, errors: FieldError[]): Promise<void> {
  const member = await tx.selectFrom('companyMemberships').select(['status', 'membershipType']).where('id', '=', membershipId).executeTakeFirst();
  if (!member || member.status !== 'active' || member.membershipType !== 'staff') errors.push({ field, code: 'not-found', message: 'Choose an active member of staff.' });
}

function summaryQuery(tx: Tx) {
  return tx
    .selectFrom('inspections as i')
    .innerJoin('properties as p', 'p.id', 'i.propertyId')
    .leftJoin('units as u', 'u.id', 'i.unitId')
    .leftJoin('leases as l', 'l.id', 'i.leaseId')
    .leftJoin('companyMemberships as im', 'im.id', 'i.inspectorMembershipId')
    .leftJoin('users as iu', 'iu.id', 'im.userId')
    .select([
      'i.id', 'i.reference', 'i.inspectionType', 'i.status', 'i.propertyId', 'p.name as propertyName', 'i.unitId', 'u.unitLabel', 'i.leaseId', 'l.reference as leaseReference',
      'i.scheduledAt', 'i.completedAt', 'i.inspectorMembershipId', 'iu.displayName as inspectorName', 'i.overallCondition', 'i.updatedAt',
    ]);
}

type SummaryRow = Awaited<ReturnType<ReturnType<typeof summaryQuery>['executeTakeFirstOrThrow']>>;

function toSummary(row: SummaryRow): InspectionSummaryDto {
  return {
    id: row.id,
    reference: row.reference,
    inspectionType: row.inspectionType,
    status: row.status,
    property: { id: row.propertyId, name: row.propertyName ?? '' },
    unit: row.unitId ? { id: row.unitId, name: row.unitLabel ?? '' } : null,
    lease: row.leaseId ? { id: row.leaseId, name: row.leaseReference ?? '' } : null,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    inspector: row.inspectorMembershipId ? { id: row.inspectorMembershipId, name: row.inspectorName ?? '' } : null,
    overallCondition: row.overallCondition,
    updatedAt: row.updatedAt.toISOString(),
  };
}
