import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { keysetCondition, type Page, type ParsedListQuery, sortValueSql, toPage } from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { checkPicklistCode } from '../reference/picklists.js';
import type { CreateUnitBody, FloorAreaInput, UnitAvailabilityBody, UnitDto, UpdateUnitBody } from './dto.js';
import { PropertiesService, isCalendarDate, nextReference, sameValue, toSquareMetres } from './properties.service.js';
import { assertPropertyAccess } from './property-access.js';

registerConstraintMessages({
  units_company_id_property_id_unit_label_key: 'Another unit of this property already has this label.',
  units_one_whole_property_idx: 'This property already has a "whole property" unit.',
  units_company_id_reference_key: 'This unit reference is already in use.',
});

export type UnitSortField = 'unitLabel' | 'createdAt' | 'updatedAt';

interface PropertyForUnits {
  id: string;
  officeId: string;
  createdBy: string | null;
  archivedAt: Date | null;
  countryCode: string;
}

@Injectable()
export class UnitsService {
  constructor(
    private readonly audit: AuditService,
    private readonly properties: PropertiesService,
  ) {}

  async list(tx: Tx, ctx: TenantContext, propertyId: string, query: ParsedListQuery<UnitSortField>): Promise<Page<UnitDto>> {
    const property = await this.loadProperty(tx, propertyId);
    await assertPropertyAccess(tx, ctx, property, 'property.view');

    const sortColumn = `u.${query.sort.field}`;
    let qb = this.unitQuery(tx)
      .select(sortValueSql(sortColumn, query.sort.kind).as('cursorValue'))
      .where('u.propertyId', '=', propertyId);
    const archived = query.filters['archived'] ?? 'false';
    if (archived === 'false') qb = qb.where('u.archivedAt', 'is', null);
    if (archived === 'true') qb = qb.where('u.archivedAt', 'is not', null);
    if (Array.isArray(query.filters['availability'])) qb = qb.where('u.availability', 'in', query.filters['availability']);
    if (query.q !== null) {
      const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      qb = qb.where((eb) => eb.or([eb('u.unitLabel', 'ilike', pattern), eb('u.reference', 'ilike', pattern)]));
    }
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'u.id', query.sort, query.cursor));
    const rows = await qb
      .orderBy(sql.ref(sortColumn), query.sort.direction)
      .orderBy('u.id', query.sort.direction)
      .limit(query.limit + 1)
      .execute();
    const features = await this.featuresFor(tx, rows.map((row) => row.id));
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => toUnitDto(row, features.get(row.id) ?? []));
  }

  async get(tx: Tx, ctx: TenantContext, unitId: string): Promise<UnitDto> {
    const row = await this.unitQuery(tx).where('u.id', '=', unitId).executeTakeFirst();
    if (!row) throw Problems.notFound();
    const property = await this.loadProperty(tx, row.propertyId);
    await assertPropertyAccess(tx, ctx, property, 'property.view');
    const features = await this.featuresFor(tx, [unitId]);
    return toUnitDto(row, features.get(unitId) ?? []);
  }

  async create(tx: Tx, ctx: TenantContext, propertyId: string, body: CreateUnitBody): Promise<UnitDto> {
    const property = await this.loadProperty(tx, propertyId, true);
    await assertPropertyAccess(tx, ctx, property, 'property.update');
    if (property.archivedAt !== null) throw Problems.businessRule('Units cannot be added to an archived property.');

    const errors = await this.checkUnitFields(tx, body, property.countryCode);
    if (errors.length > 0) throw Problems.validation(errors);

    const reference = await nextReference(tx, ctx, 'unit');
    const unit = await tx
      .insertInto('units')
      .values({
        companyId: ctx.companyId,
        propertyId,
        reference,
        unitLabel: body.unitLabel,
        isWholeProperty: body.isWholeProperty ?? false,
        unitTypeId: body.unitTypeId ?? null,
        floorLabel: body.floorLabel ?? null,
        bedrooms: body.bedrooms ?? null,
        bathrooms: body.bathrooms ?? null,
        receptionRooms: body.receptionRooms ?? null,
        ...floorAreaColumns(body.floorArea ?? null),
        parkingSpaces: body.parkingSpaces ?? null,
        furnishingCode: body.furnishingCode ?? null,
        energyRating: body.energyRating ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.replaceFeatures(tx, ctx, unit.id, body.featureCodes ?? []);
    await this.audit.record(tx, ctx, { action: 'unit.created', entityType: 'unit', entityId: unit.id, metadata: { reference, propertyId } });
    await this.audit.emit(tx, ctx, { eventType: 'unit.created', aggregateType: 'unit', aggregateId: unit.id, payload: { unitId: unit.id, propertyId } });
    return this.get(tx, ctx, unit.id);
  }

  async update(tx: Tx, ctx: TenantContext, unitId: string, expectedVersion: number, body: UpdateUnitBody): Promise<UnitDto> {
    const current = await tx.selectFrom('units').selectAll().where('id', '=', unitId).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    const property = await this.loadProperty(tx, current.propertyId);
    await assertPropertyAccess(tx, ctx, property, 'property.update');
    if (current.archivedAt !== null) throw Problems.businessRule('Archived units cannot be edited. Restore the unit first.');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();

    const errors = await this.checkUnitFields(tx, body, property.countryCode);
    if (errors.length > 0) throw Problems.validation(errors);

    const patch: Record<string, unknown> = {};
    for (const field of [
      'unitLabel',
      'unitTypeId',
      'floorLabel',
      'bedrooms',
      'bathrooms',
      'receptionRooms',
      'parkingSpaces',
      'furnishingCode',
      'energyRating',
    ] as const) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (body.floorArea !== undefined) Object.assign(patch, floorAreaColumns(body.floorArea));
    const effective = Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => !sameValue((current as Record<string, unknown>)[key], value)),
    );

    const featuresBefore = (await this.featuresFor(tx, [unitId])).get(unitId) ?? [];
    const featuresAfter = body.featureCodes === undefined || body.featureCodes === null ? featuresBefore : [...body.featureCodes].sort();
    const featuresChanged = JSON.stringify(featuresAfter) !== JSON.stringify(featuresBefore);
    if (Object.keys(effective).length === 0 && !featuresChanged) return this.get(tx, ctx, unitId);

    // Feature-only edits still touch the row so the version (ETag) changes.
    const updated = await tx
      .updateTable('units')
      .set(Object.keys(effective).length > 0 ? effective : { updatedAt: sql<Date>`now()` })
      .where('id', '=', unitId)
      .returningAll()
      .executeTakeFirstOrThrow();

    const changes: Record<string, { old: unknown; new: unknown }> = { ...(diffForAudit(current, updated) ?? {}) };
    if (featuresChanged) {
      await this.replaceFeatures(tx, ctx, unitId, featuresAfter);
      changes['featureCodes'] = { old: featuresBefore, new: featuresAfter };
    }
    await this.audit.record(tx, ctx, {
      action: 'unit.updated',
      entityType: 'unit',
      entityId: unitId,
      changes: Object.keys(changes).length > 0 ? changes : null,
    });
    await this.audit.emit(tx, ctx, { eventType: 'unit.updated', aggregateType: 'unit', aggregateId: unitId, payload: { unitId, propertyId: current.propertyId } });
    return this.get(tx, ctx, unitId);
  }

  /** Operational availability; "under_maintenance" blocks new lettings without changing listing status. */
  async setAvailability(tx: Tx, ctx: TenantContext, unitId: string, expectedVersion: number, body: UnitAvailabilityBody): Promise<UnitDto> {
    const current = await tx.selectFrom('units').selectAll().where('id', '=', unitId).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    const property = await this.loadProperty(tx, current.propertyId);
    await assertPropertyAccess(tx, ctx, property, 'property.update');
    if (current.archivedAt !== null) throw Problems.businessRule('Archived units cannot be edited. Restore the unit first.');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();

    const restricted = body.availability !== 'available';
    const until = restricted ? (body.until ?? null) : null;
    if (until !== null && !isCalendarDate(until)) throw Problems.validation([{ field: 'until', code: 'invalid', message: 'This is not a valid date.' }]);
    const next = { availability: body.availability, availabilityNote: restricted ? (body.note ?? null) : null, availabilityUntil: until };
    const changes = diffForAudit(current, next);
    if (changes === null) return this.get(tx, ctx, unitId);

    await tx.updateTable('units').set(next).where('id', '=', unitId).execute();
    await this.audit.record(tx, ctx, { action: 'unit.availability_changed', entityType: 'unit', entityId: unitId, changes });
    await this.audit.emit(tx, ctx, {
      eventType: 'unit.availability_changed',
      aggregateType: 'unit',
      aggregateId: unitId,
      payload: { unitId, propertyId: current.propertyId, from: current.availability, to: body.availability },
    });
    return this.get(tx, ctx, unitId);
  }

  async archive(tx: Tx, ctx: TenantContext, unitId: string, expectedVersion: number, reason: string): Promise<UnitDto> {
    const current = await tx.selectFrom('units').selectAll().where('id', '=', unitId).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    const property = await this.loadProperty(tx, current.propertyId);
    await assertPropertyAccess(tx, ctx, property, 'property.archive');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt !== null) throw Problems.businessRule('This unit is already archived.');
    const blockers = await this.properties.archiveBlockers(tx, { unitId });
    if (blockers) throw Problems.businessRule(blockers);

    await tx.updateTable('units').set({ archivedAt: new Date() }).where('id', '=', unitId).execute();
    await this.audit.record(tx, ctx, { action: 'unit.archived', entityType: 'unit', entityId: unitId, metadata: { reason } });
    await this.audit.emit(tx, ctx, { eventType: 'unit.archived', aggregateType: 'unit', aggregateId: unitId, payload: { unitId, reason } });
    return this.get(tx, ctx, unitId);
  }

  async restore(tx: Tx, ctx: TenantContext, unitId: string, expectedVersion: number): Promise<UnitDto> {
    const current = await tx.selectFrom('units').selectAll().where('id', '=', unitId).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    const property = await this.loadProperty(tx, current.propertyId);
    await assertPropertyAccess(tx, ctx, property, 'property.archive');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt === null) throw Problems.businessRule('This unit is not archived.');
    if (property.archivedAt !== null) throw Problems.businessRule('Restore the property before restoring its units.');

    await tx.updateTable('units').set({ archivedAt: null }).where('id', '=', unitId).execute();
    await this.audit.record(tx, ctx, { action: 'unit.restored', entityType: 'unit', entityId: unitId });
    await this.audit.emit(tx, ctx, { eventType: 'unit.restored', aggregateType: 'unit', aggregateId: unitId, payload: { unitId } });
    return this.get(tx, ctx, unitId);
  }

  private async checkUnitFields(tx: Tx, body: CreateUnitBody | UpdateUnitBody, countryCode: string): Promise<FieldError[]> {
    const errors: FieldError[] = [];
    if (body.unitTypeId !== undefined && body.unitTypeId !== null) {
      errors.push(...(await this.properties.checkPropertyType(tx, body.unitTypeId, countryCode, 'unitTypeId', 'unit')));
    }
    if (body.bathrooms !== undefined && body.bathrooms !== null && !Number.isInteger(body.bathrooms * 2)) {
      errors.push({ field: 'bathrooms', code: 'step', message: 'Use whole or half bathrooms (e.g. 1.5).' });
    }
    if (body.furnishingCode !== undefined && body.furnishingCode !== null) {
      const error = await checkPicklistCode(tx, 'furnishing', body.furnishingCode, countryCode, 'furnishingCode');
      if (error) errors.push(error);
    }
    for (const [index, code] of (body.featureCodes ?? []).entries()) {
      const error = await checkPicklistCode(tx, 'feature', code, countryCode, `featureCodes.${index}`);
      if (error) errors.push(error);
    }
    return errors;
  }

  private async replaceFeatures(tx: Tx, ctx: TenantContext, unitId: string, codes: readonly string[]): Promise<void> {
    await tx.deleteFrom('unitFeatures').where('unitId', '=', unitId).execute();
    if (codes.length === 0) return;
    await tx
      .insertInto('unitFeatures')
      .values(codes.map((featureCode) => ({ companyId: ctx.companyId, unitId, featureCode })))
      .execute();
  }

  private async featuresFor(tx: Tx, unitIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (unitIds.length === 0) return result;
    const rows = await tx
      .selectFrom('unitFeatures')
      .select(['unitId', 'featureCode'])
      .where('unitId', 'in', unitIds)
      .orderBy('featureCode')
      .execute();
    for (const row of rows) result.set(row.unitId, [...(result.get(row.unitId) ?? []), row.featureCode]);
    return result;
  }

  private async loadProperty(tx: Tx, propertyId: string, lock = false): Promise<PropertyForUnits> {
    let query = tx
      .selectFrom('properties as p')
      .innerJoin('addresses as a', 'a.id', 'p.addressId')
      .select(['p.id', 'p.officeId', 'p.createdBy', 'p.archivedAt', 'a.countryCode'])
      .where('p.id', '=', propertyId);
    if (lock) query = query.forUpdate('p');
    const property = await query.executeTakeFirst();
    if (!property) throw Problems.notFound();
    return property;
  }

  private unitQuery(tx: Tx) {
    return tx
      .selectFrom('units as u')
      .leftJoin('propertyTypes as t', 't.id', 'u.unitTypeId')
      .selectAll('u')
      .select(['t.code as unitTypeCode', 't.name as unitTypeName']);
  }
}

function floorAreaColumns(area: FloorAreaInput | null) {
  if (area === null) return { floorAreaSqm: null, floorAreaInput: null, floorAreaInputUnit: null };
  return { floorAreaSqm: toSquareMetres(area.value, area.unit), floorAreaInput: area.value, floorAreaInputUnit: area.unit };
}

function toUnitDto(
  row: Awaited<ReturnType<ReturnType<UnitsService['unitQuery']>['executeTakeFirstOrThrow']>>,
  featureCodes: string[],
): UnitDto {
  return {
    id: row.id,
    reference: row.reference,
    propertyId: row.propertyId,
    unitLabel: row.unitLabel,
    unitType: row.unitTypeId !== null && row.unitTypeCode !== null && row.unitTypeName !== null
      ? { id: row.unitTypeId, code: row.unitTypeCode, name: row.unitTypeName }
      : null,
    isWholeProperty: row.isWholeProperty,
    floorLabel: row.floorLabel,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms === null ? null : Number(row.bathrooms),
    receptionRooms: row.receptionRooms,
    floorArea:
      row.floorAreaInput === null || row.floorAreaInputUnit === null
        ? null
        : { sqm: row.floorAreaSqm === null ? null : Number(row.floorAreaSqm), value: Number(row.floorAreaInput), unit: row.floorAreaInputUnit },
    parkingSpaces: row.parkingSpaces,
    furnishingCode: row.furnishingCode,
    energyRating: row.energyRating,
    availability: row.availability,
    availabilityNote: row.availabilityNote,
    availabilityUntil: row.availabilityUntil,
    featureCodes,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
