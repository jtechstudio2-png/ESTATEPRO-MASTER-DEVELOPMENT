import { Injectable } from '@nestjs/common';
import { type Selectable, sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { keysetCondition, keysetEntryCondition, type Page, type ParsedListQuery, sortValueSql, toEntryPage, toPage } from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import type { KeySets } from '../database/schema.js';
import { assertPropertyRecordAccess, propertyCovered, propertyScopeSql } from '../properties/property-access.js';
import type { CheckOutBody, CreateKeySetBody, KeyMovementDto, KeySetDto, UpdateKeySetBody } from './dto.js';

registerConstraintMessages({
  key_sets_label_idx: 'This key tag number is already in use by another active key set.',
});

type KeySetRow = Selectable<KeySets>;
export type KeySetSortField = 'label' | 'updatedAt' | 'dueBackAt';
type Movement = 'check_out' | 'check_in' | 'lost' | 'found';

/** Allowed movements by current status (ADR-006 L-D10, report §8.4). */
const TRANSITIONS: Record<Movement, { from: readonly string[]; to: string; verb: string }> = {
  check_out: { from: ['in_office'], to: 'checked_out', verb: 'checked out' },
  check_in: { from: ['checked_out', 'with_owner'], to: 'in_office', verb: 'checked in' },
  lost: { from: ['in_office', 'checked_out'], to: 'lost', verb: 'reported lost' },
  found: { from: ['lost'], to: 'in_office', verb: 'marked found' },
};
const AUDIT_ACTION: Record<Movement, string> = {
  check_out: 'key_set.checked_out',
  check_in: 'key_set.checked_in',
  lost: 'key_set.lost',
  found: 'key_set.found',
};
const STATUS_LABEL: Record<string, string> = {
  in_office: 'in the office',
  checked_out: 'checked out',
  with_owner: 'with the owner',
  lost: 'lost',
  retired: 'retired',
};

/**
 * Key register (PRP-07). Key sets belong to a property (optionally a unit);
 * the current holder lives on the key set and every movement is appended to
 * key_movements. Permissions: key.view, key.issue (movements), key.manage.
 */
@Injectable()
export class KeysService {
  constructor(private readonly audit: AuditService) {}

  async list(tx: Tx, ctx: TenantContext, query: ParsedListQuery<KeySetSortField>, propertyId: string | null): Promise<Page<KeySetDto>> {
    if (propertyId !== null) await assertPropertyRecordAccess(tx, ctx, propertyId, 'key.view');
    const view = ctx.permissions.get('key.view');
    const sortColumn = `k.${query.sort.field}`;
    let qb = this.keySetQuery(tx)
      .select(sortValueSql(sortColumn, query.sort.kind).as('cursorValue'))
      .where(propertyScopeSql(view?.scope ?? 'linked', ctx, 'p'));
    if (propertyId !== null) qb = qb.where('k.propertyId', '=', propertyId);
    const { filters } = query;
    if (Array.isArray(filters['status'])) qb = qb.where('k.status', 'in', filters['status']);
    else qb = qb.where('k.status', '<>', 'retired');
    if (Array.isArray(filters['propertyId'])) qb = qb.where('k.propertyId', 'in', filters['propertyId']);
    if (Array.isArray(filters['unitId'])) qb = qb.where('k.unitId', 'in', filters['unitId']);
    if (Array.isArray(filters['officeId'])) qb = qb.where('p.officeId', 'in', filters['officeId']);
    if (Array.isArray(filters['holderMembershipId'])) qb = qb.where('k.holderMembershipId', 'in', filters['holderMembershipId']);
    if (filters['overdue'] === true) qb = qb.where('k.status', '=', 'checked_out').where('k.dueBackAt', '<', sql<Date>`now()`);
    if (filters['overdue'] === false) qb = qb.where((eb) => eb.or([eb('k.dueBackAt', 'is', null), eb('k.dueBackAt', '>=', sql<Date>`now()`)]));
    if (query.sort.field === 'dueBackAt') qb = qb.where('k.dueBackAt', 'is not', null);
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'k.id', query.sort, query.cursor));
    const rows = await qb
      .orderBy(sql.ref(sortColumn), query.sort.direction)
      .orderBy('k.id', query.sort.direction)
      .limit(query.limit + 1)
      .execute();
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, toKeySetDto);
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<KeySetDto> {
    await this.visibleKeySet(tx, ctx, id);
    return this.load(tx, id);
  }

  async create(tx: Tx, ctx: TenantContext, propertyId: string, body: CreateKeySetBody): Promise<KeySetDto> {
    await assertPropertyRecordAccess(tx, ctx, propertyId, 'key.view', 'key.manage');
    const property = await tx.selectFrom('properties').select(['archivedAt']).where('id', '=', propertyId).executeTakeFirstOrThrow();
    if (property.archivedAt !== null) throw Problems.businessRule('Keys cannot be registered for an archived property.');
    const errors = await this.checkUnit(tx, propertyId, body.unitId ?? null);
    if (errors.length > 0) throw Problems.validation(errors);
    const inserted = await tx
      .insertInto('keySets')
      .values({
        companyId: ctx.companyId,
        propertyId,
        unitId: body.unitId ?? null,
        label: body.label,
        description: body.description ?? null,
        status: body.status ?? 'in_office',
        createdBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'key_set.created',
      entityType: 'key_set',
      entityId: inserted.id,
      metadata: { propertyId, unitId: body.unitId ?? null, label: body.label, status: body.status ?? 'in_office' },
    });
    return this.load(tx, inserted.id);
  }

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateKeySetBody): Promise<KeySetDto> {
    const current = await this.lockForAction(tx, ctx, id, 'key.manage', expectedVersion);
    if (current.status === 'retired') throw Problems.businessRule('A retired key set cannot be edited.');
    const unitId = body.unitId === undefined ? current.unitId : body.unitId;
    const errors = await this.checkUnit(tx, current.propertyId, unitId);
    if (errors.length > 0) throw Problems.validation(errors);
    const patch: { label?: string; description?: string | null; unitId?: string | null } = {};
    if (body.label !== undefined && body.label !== current.label) patch.label = body.label;
    if (body.description !== undefined && body.description !== current.description) patch.description = body.description;
    if (unitId !== current.unitId) patch.unitId = unitId;
    if (Object.keys(patch).length === 0) return this.load(tx, id);
    await tx.updateTable('keySets').set(patch).where('id', '=', id).execute();
    const changes = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, { old: (current as Record<string, unknown>)[key] ?? null, new: value }]),
    );
    await this.audit.record(tx, ctx, { action: 'key_set.updated', entityType: 'key_set', entityId: id, changes });
    return this.load(tx, id);
  }

  async checkOut(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: CheckOutBody): Promise<KeySetDto> {
    const current = await this.lockForAction(tx, ctx, id, 'key.issue', expectedVersion);
    this.assertTransition(current, 'check_out');
    const errors: FieldError[] = [];
    if ((body.holderMembershipId === undefined) === (body.holderContactId === undefined)) {
      errors.push({ field: 'holderMembershipId', code: 'one-holder', message: 'Give either a staff member or a contact as the holder.' });
    }
    if (body.holderMembershipId !== undefined) {
      const member = await tx
        .selectFrom('companyMemberships')
        .select('id')
        .where('id', '=', body.holderMembershipId)
        .where('status', '=', 'active')
        .where('membershipType', '=', 'staff')
        .executeTakeFirst();
      if (!member) errors.push({ field: 'holderMembershipId', code: 'not-found', message: 'This person is not an active member of staff.' });
    }
    if (body.holderContactId !== undefined) {
      const contact = await tx
        .selectFrom('contacts')
        .select('id')
        .where('id', '=', body.holderContactId)
        .where('archivedAt', 'is', null)
        .executeTakeFirst();
      if (!contact) errors.push({ field: 'holderContactId', code: 'not-found', message: 'This contact does not exist or is archived.' });
    }
    const dueBackAt = body.dueBackAt === undefined ? null : new Date(body.dueBackAt);
    if (dueBackAt !== null && dueBackAt.getTime() <= Date.now()) {
      errors.push({ field: 'dueBackAt', code: 'past', message: 'The due-back time must be in the future.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);

    const now = new Date();
    await tx
      .updateTable('keySets')
      .set({
        status: 'checked_out',
        checkedOutAt: now,
        dueBackAt,
        holderMembershipId: body.holderMembershipId ?? null,
        holderContactId: body.holderContactId ?? null,
      })
      .where('id', '=', id)
      .execute();
    await this.recordMovement(tx, ctx, current, 'check_out', {
      holderMembershipId: body.holderMembershipId ?? null,
      holderContactId: body.holderContactId ?? null,
      dueBackAt,
      note: body.note ?? null,
      occurredAt: now,
    });
    return this.load(tx, id);
  }

  async move(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, movement: Exclude<Movement, 'check_out'>, note: string | null): Promise<KeySetDto> {
    const current = await this.lockForAction(tx, ctx, id, 'key.issue', expectedVersion);
    this.assertTransition(current, movement);
    const now = new Date();
    await tx
      .updateTable('keySets')
      .set({ status: TRANSITIONS[movement].to, checkedOutAt: null, dueBackAt: null, holderMembershipId: null, holderContactId: null })
      .where('id', '=', id)
      .execute();
    // A key lost while checked out records who had it.
    await this.recordMovement(tx, ctx, current, movement, {
      holderMembershipId: movement === 'lost' ? current.holderMembershipId : null,
      holderContactId: movement === 'lost' ? current.holderContactId : null,
      dueBackAt: null,
      note,
      occurredAt: now,
    });
    return this.load(tx, id);
  }

  async retire(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<KeySetDto> {
    const current = await this.lockForAction(tx, ctx, id, 'key.manage', expectedVersion);
    if (current.status === 'checked_out') throw Problems.businessRule('Check the keys in before retiring the set.');
    if (current.status === 'retired') throw Problems.businessRule('This key set is already retired.');
    await tx.updateTable('keySets').set({ status: 'retired', retiredAt: new Date() }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, {
      action: 'key_set.retired',
      entityType: 'key_set',
      entityId: id,
      changes: { status: { old: current.status, new: 'retired' } },
      metadata: { reason },
    });
    return this.load(tx, id);
  }

  async movements(tx: Tx, ctx: TenantContext, id: string, query: ParsedListQuery<'occurredAt'>): Promise<Page<KeyMovementDto>> {
    await this.visibleKeySet(tx, ctx, id);
    let qb = tx
      .selectFrom('keyMovements as km')
      .leftJoin('companyMemberships as hm', 'hm.id', 'km.holderMembershipId')
      .leftJoin('users as hu', 'hu.id', 'hm.userId')
      .leftJoin('contacts as hc', 'hc.id', 'km.holderContactId')
      .innerJoin('companyMemberships as rm', 'rm.id', 'km.recordedBy')
      .innerJoin('users as ru', 'ru.id', 'rm.userId')
      .select([
        'km.id',
        'km.movement',
        'km.holderMembershipId',
        'hu.displayName as holderMemberName',
        'km.holderContactId',
        'hc.displayName as holderContactName',
        'km.dueBackAt',
        'km.note',
        'km.occurredAt',
        'km.recordedBy',
        'ru.displayName as recorderName',
        sortValueSql('km.occurredAt', 'timestamp').as('cursorValue'),
        sql<string>`km.entry_no::text`.as('entryNoText'),
      ])
      .where('km.keySetId', '=', id);
    if (query.cursor) qb = qb.where(keysetEntryCondition('km.occurredAt', 'km.entryNo', query.sort, query.cursor));
    const rows = await qb
      .orderBy('km.occurredAt', query.sort.direction)
      .orderBy('km.entryNo', query.sort.direction)
      .limit(query.limit + 1)
      .execute();
    return toEntryPage(rows, query.limit, (row) => row.cursorValue, (row) => row.entryNoText, (row) => ({
      id: row.id,
      movement: row.movement,
      holder: holderOf(row.holderMembershipId, row.holderMemberName, row.holderContactId, row.holderContactName),
      dueBackAt: row.dueBackAt?.toISOString() ?? null,
      note: row.note,
      occurredAt: row.occurredAt.toISOString(),
      recordedBy: { type: 'member' as const, id: row.recordedBy, displayName: row.recorderName },
    }));
  }

  // --------------------------------------------------------------------------- helpers

  private async visibleKeySet(tx: Tx, ctx: TenantContext, id: string, forUpdate = false): Promise<KeySetRow> {
    let qb = tx.selectFrom('keySets').selectAll().where('id', '=', id);
    if (forUpdate) qb = qb.forUpdate();
    const row = await qb.executeTakeFirst();
    if (!row || !(await propertyCovered(tx, ctx, row.propertyId, 'key.view'))) throw Problems.notFound();
    return row;
  }

  private async lockForAction(tx: Tx, ctx: TenantContext, id: string, permission: string, expectedVersion: number): Promise<KeySetRow> {
    const row = await this.visibleKeySet(tx, ctx, id, true);
    if (!(await propertyCovered(tx, ctx, row.propertyId, permission))) {
      throw Problems.forbidden('Your role does not allow this action for these keys.');
    }
    if (row.version !== expectedVersion) throw Problems.preconditionFailed();
    return row;
  }

  private assertTransition(row: KeySetRow, movement: Movement): void {
    const rule = TRANSITIONS[movement];
    if (!rule.from.includes(row.status)) {
      throw Problems.businessRule(`Keys that are ${STATUS_LABEL[row.status] ?? row.status} cannot be ${rule.verb}.`);
    }
  }

  private async checkUnit(tx: Tx, propertyId: string, unitId: string | null): Promise<FieldError[]> {
    if (unitId === null) return [];
    const unit = await tx.selectFrom('units').select('id').where('id', '=', unitId).where('propertyId', '=', propertyId).executeTakeFirst();
    return unit ? [] : [{ field: 'unitId', code: 'not-found', message: 'This unit does not belong to the property.' }];
  }

  private async recordMovement(
    tx: Tx,
    ctx: TenantContext,
    keySet: KeySetRow,
    movement: Movement,
    details: { holderMembershipId: string | null; holderContactId: string | null; dueBackAt: Date | null; note: string | null; occurredAt: Date },
  ): Promise<void> {
    await tx
      .insertInto('keyMovements')
      .values({ companyId: ctx.companyId, keySetId: keySet.id, movement, recordedBy: ctx.membershipId, ...details })
      .execute();
    await this.audit.record(tx, ctx, {
      action: AUDIT_ACTION[movement],
      entityType: 'key_set',
      entityId: keySet.id,
      changes: { status: { old: keySet.status, new: TRANSITIONS[movement].to } },
      metadata: {
        propertyId: keySet.propertyId,
        holderMembershipId: details.holderMembershipId,
        holderContactId: details.holderContactId,
        dueBackAt: details.dueBackAt?.toISOString() ?? null,
      },
    });
  }

  private keySetQuery(tx: Tx) {
    return tx
      .selectFrom('keySets as k')
      .innerJoin('properties as p', 'p.id', 'k.propertyId')
      .leftJoin('companyMemberships as hm', 'hm.id', 'k.holderMembershipId')
      .leftJoin('users as hu', 'hu.id', 'hm.userId')
      .leftJoin('contacts as hc', 'hc.id', 'k.holderContactId')
      .leftJoin('units as u', 'u.id', 'k.unitId')
      .selectAll('k')
      .select([
        'p.reference as propertyReference',
        'p.name as propertyName',
        'p.timezone as propertyTimezone',
        'u.unitLabel',
        'hu.displayName as holderMemberName',
        'hc.displayName as holderContactName',
        sql<boolean>`k.status = 'checked_out' and k.due_back_at < now()`.as('isOverdue'),
      ]);
  }

  private async load(tx: Tx, id: string): Promise<KeySetDto> {
    return toKeySetDto(await this.keySetQuery(tx).where('k.id', '=', id).executeTakeFirstOrThrow());
  }
}

function holderOf(memberId: string | null, memberName: string | null, contactId: string | null, contactName: string | null) {
  if (memberId !== null) return { type: 'member' as const, id: memberId, displayName: memberName ?? '' };
  if (contactId !== null) return { type: 'contact' as const, id: contactId, displayName: contactName ?? '' };
  return null;
}

function toKeySetDto(
  row: KeySetRow & {
    propertyReference: string;
    propertyName: string | null;
    propertyTimezone: string;
    unitLabel: string | null;
    holderMemberName: string | null;
    holderContactName: string | null;
    isOverdue: boolean | null;
  },
): KeySetDto {
  return {
    id: row.id,
    property: { id: row.propertyId, reference: row.propertyReference, name: row.propertyName, timezone: row.propertyTimezone },
    unitId: row.unitId,
    unitLabel: row.unitLabel,
    label: row.label,
    description: row.description,
    status: row.status,
    holder: holderOf(row.holderMembershipId, row.holderMemberName, row.holderContactId, row.holderContactName),
    checkedOutAt: row.checkedOutAt?.toISOString() ?? null,
    dueBackAt: row.dueBackAt?.toISOString() ?? null,
    isOverdue: row.isOverdue === true,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
