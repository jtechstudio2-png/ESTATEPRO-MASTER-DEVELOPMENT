import { Injectable } from '@nestjs/common';
import { type ExpressionBuilder, sql } from 'kysely';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import {
  keysetCondition,
  type ParsedListQuery,
  type Page,
  sortValueSql,
  toPage,
} from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import type { DB } from '../database/schema.js';
import { type NormalisedAddress, toAddressDto, validateAddress } from '../reference/address.js';
import { checkPicklistCode } from '../reference/picklists.js';
import type { CreatePropertyBody, LandAreaInput, PropertyDto, PropertySummaryDto, UpdatePropertyBody } from './dto.js';
import { assertPropertyAccess, canUseOffice, propertyScopeSql } from './property-access.js';

registerConstraintMessages({
  properties_company_id_reference_key: 'This property reference is already in use.',
});

/** Square metres per input unit; "plot" has no fixed size and is stored as entered only. */
const SQM_PER_UNIT: Record<string, number | null> = { sqm: 1, sqft: 0.09290304, acre: 4046.8564224, hectare: 10_000, plot: null };
export const OPEN_LISTING_STATUSES = ['draft', 'available', 'reserved', 'under_contract'] as const;
export const LIVE_LEASE_STATUSES = ['pending_signature', 'active', 'periodic', 'notice_given'] as const;

export type PropertySortField = 'reference' | 'createdAt' | 'updatedAt';

export function toSquareMetres(value: number, unit: string): number | null {
  const factor = SQM_PER_UNIT[unit];
  return factor === null || factor === undefined ? null : Math.round(value * factor * 100) / 100;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface ResolvedPlacement {
  jurisdictionCode: string;
  timezone: string;
}

@Injectable()
export class PropertiesService {
  constructor(private readonly audit: AuditService) {}

  async list(tx: Tx, ctx: TenantContext, scope: PermissionScope, query: ParsedListQuery<PropertySortField>): Promise<Page<PropertySummaryDto>> {
    const sortColumn = `p.${query.sort.field}`;
    let qb = this.summaryQuery(tx)
      .select(sortValueSql(sortColumn, query.sort.kind).as('cursorValue'))
      .where(propertyScopeSql(scope, ctx, 'p'));

    const { filters } = query;
    const archived = filters['archived'] ?? 'false';
    if (archived === 'false') qb = qb.where('p.archivedAt', 'is', null);
    if (archived === 'true') qb = qb.where('p.archivedAt', 'is not', null);
    if (Array.isArray(filters['officeId'])) qb = qb.where('p.officeId', 'in', filters['officeId']);
    if (Array.isArray(filters['propertyTypeId'])) qb = qb.where('p.propertyTypeId', 'in', filters['propertyTypeId']);
    if (Array.isArray(filters['countryCode'])) qb = qb.where('a.countryCode', 'in', filters['countryCode']);
    if (typeof filters['isManaged'] === 'boolean') qb = qb.where('p.isManaged', '=', filters['isManaged']);
    if (query.q !== null) {
      const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      qb = qb.where((eb) =>
        eb.or([eb('p.reference', 'ilike', pattern), eb('p.name', 'ilike', pattern), eb('a.formatted', 'ilike', pattern)]),
      );
    }
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'p.id', query.sort, query.cursor));

    const rows = await qb
      .orderBy(sql.ref(sortColumn), query.sort.direction)
      .orderBy('p.id', query.sort.direction)
      .limit(query.limit + 1)
      .execute();

    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => ({
      id: row.id,
      reference: row.reference,
      name: row.name,
      propertyType: { id: row.propertyTypeId, code: row.propertyTypeCode, name: row.propertyTypeName },
      office: { id: row.officeId, code: row.officeCode, name: row.officeName },
      countryCode: row.countryCode,
      locality: row.locality,
      formattedAddress: row.formatted,
      unitCount: row.unitCount ?? 0,
      isManaged: row.isManaged,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<PropertyDto> {
    const row = await this.detailQuery(tx).where('p.id', '=', id).executeTakeFirst();
    if (!row) throw Problems.notFound();
    const view = ctx.permissions.get('property.view');
    const visible = await tx
      .selectFrom('properties as p')
      .select('p.id')
      .where('p.id', '=', id)
      .where(propertyScopeSql(view?.scope ?? 'linked', ctx, 'p'))
      .executeTakeFirst();
    if (!visible) throw Problems.notFound();
    return toPropertyDto(row);
  }

  async create(tx: Tx, ctx: TenantContext, scope: PermissionScope, body: CreatePropertyBody): Promise<PropertyDto> {
    const errors: FieldError[] = [];
    const office = await this.loadOffice(tx, body.officeId);
    if (!office) {
      errors.push({ field: 'officeId', code: 'not-found', message: 'This office does not exist or is archived.' });
    } else if (!canUseOffice(ctx, scope, office.id)) {
      throw Problems.forbidden('You can only add properties to your own offices.');
    }

    const { errors: addressErrors, address } = await validateAddress(tx, body.address);
    errors.push(...addressErrors);

    if (office && address) {
      errors.push(...(await this.checkPropertyType(tx, body.propertyTypeId, address.countryCode, 'propertyTypeId')));
      const placement = await this.resolvePlacement(tx, office, address.countryCode, body.jurisdictionCode, body.timezone, errors);
      errors.push(...(await this.checkDetails(tx, body, address.countryCode)));
      if (errors.length > 0) throw Problems.validation(errors);

      const reference = await nextReference(tx, ctx, 'property');
      const addressId = await insertAddress(tx, ctx, address);
      const land = landAreaColumns(body.landArea ?? null);
      const inserted = await tx
        .insertInto('properties')
        .values({
          companyId: ctx.companyId,
          reference,
          name: body.name ?? null,
          propertyTypeId: body.propertyTypeId,
          officeId: office.id,
          addressId,
          jurisdictionCode: placement!.jurisdictionCode,
          timezone: placement!.timezone,
          tenureCode: body.tenureCode ?? null,
          tenureExpiresOn: body.tenureExpiresOn ?? null,
          titleReference: body.titleReference ?? null,
          yearBuilt: body.yearBuilt ?? null,
          floorsCount: body.floorsCount ?? null,
          ...land,
          isManaged: body.isManaged ?? false,
          internalNotes: body.internalNotes ?? null,
          createdBy: ctx.membershipId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      if (body.createWholePropertyUnit) {
        const unitReference = await nextReference(tx, ctx, 'unit');
        const unit = await tx
          .insertInto('units')
          .values({
            companyId: ctx.companyId,
            propertyId: inserted.id,
            reference: unitReference,
            unitLabel: 'Whole property',
            isWholeProperty: true,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await this.audit.record(tx, ctx, { action: 'unit.created', entityType: 'unit', entityId: unit.id, metadata: { reference: unitReference } });
      }

      await this.audit.record(tx, ctx, { action: 'property.created', entityType: 'property', entityId: inserted.id, metadata: { reference } });
      await this.audit.emit(tx, ctx, {
        eventType: 'property.created',
        aggregateType: 'property',
        aggregateId: inserted.id,
        payload: { propertyId: inserted.id, reference, officeId: office.id },
      });
      return this.get(tx, ctx, inserted.id);
    }
    throw Problems.validation(errors);
  }

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdatePropertyBody): Promise<PropertyDto> {
    const current = await tx.selectFrom('properties').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    await assertPropertyAccess(tx, ctx, current, 'property.update');
    if (current.archivedAt !== null) throw Problems.businessRule('Archived properties cannot be edited. Restore the property first.');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();

    const errors: FieldError[] = [];
    const currentAddress = await tx.selectFrom('addresses').selectAll().where('id', '=', current.addressId).executeTakeFirstOrThrow();

    let newAddress: NormalisedAddress | null = null;
    if (body.address !== undefined && body.address !== null) {
      const validated = await validateAddress(tx, body.address);
      errors.push(...validated.errors);
      newAddress = validated.address;
    }
    const countryCode = newAddress?.countryCode ?? currentAddress.countryCode;

    let officeId = current.officeId;
    if (body.officeId !== undefined && body.officeId !== null && body.officeId !== current.officeId) {
      const office = await this.loadOffice(tx, body.officeId);
      const scope = ctx.permissions.get('property.update')?.scope ?? 'own';
      if (!office) errors.push({ field: 'officeId', code: 'not-found', message: 'This office does not exist or is archived.' });
      else if (!canUseOffice(ctx, scope, office.id)) throw Problems.forbidden('You can only move properties to your own offices.');
      else officeId = office.id;
    }

    const propertyTypeId = body.propertyTypeId ?? current.propertyTypeId;
    if (body.propertyTypeId !== undefined || newAddress !== null) {
      errors.push(...(await this.checkPropertyType(tx, propertyTypeId, countryCode, 'propertyTypeId')));
    }

    let jurisdictionCode = current.jurisdictionCode;
    let timezone = current.timezone;
    if (newAddress !== null && newAddress.countryCode !== currentAddress.countryCode) {
      // Country changed: jurisdiction and time zone must be re-derived or supplied.
      const office = await this.loadOffice(tx, officeId);
      if (!office) {
        errors.push({ field: 'officeId', code: 'archived', message: 'The property’s office is archived. Choose an active office.' });
      } else {
        const placement = await this.resolvePlacement(tx, office, countryCode, body.jurisdictionCode, body.timezone, errors);
        if (placement) ({ jurisdictionCode, timezone } = placement);
      }
    } else {
      if (body.jurisdictionCode !== undefined && body.jurisdictionCode !== null) {
        const ok = await this.jurisdictionInCountry(tx, body.jurisdictionCode, countryCode);
        if (ok) jurisdictionCode = body.jurisdictionCode;
        else errors.push({ field: 'jurisdictionCode', code: 'country-mismatch', message: 'This jurisdiction does not belong to the property’s country.' });
      }
      if (body.timezone !== undefined && body.timezone !== null) {
        if (isValidTimezone(body.timezone)) timezone = body.timezone;
        else errors.push({ field: 'timezone', code: 'invalid', message: 'Use an IANA time zone such as Africa/Accra.' });
      }
    }

    const tenureCode = body.tenureCode === undefined ? current.tenureCode : body.tenureCode;
    errors.push(...(await this.checkDetails(tx, { ...body, tenureCode }, countryCode)));
    if (errors.length > 0) throw Problems.validation(errors);

    const patch: Record<string, unknown> = { officeId, propertyTypeId, jurisdictionCode, timezone, tenureCode };
    for (const field of ['name', 'tenureExpiresOn', 'titleReference', 'yearBuilt', 'floorsCount', 'isManaged', 'internalNotes'] as const) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (body.landArea !== undefined) Object.assign(patch, landAreaColumns(body.landArea));
    const effective = Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => !sameValue((current as Record<string, unknown>)[key], value)),
    );
    const addressDiff = newAddress ? diffForAudit(addressSnapshot(toAddressDto(currentAddress)), addressSnapshot(newAddress)) : null;
    if (Object.keys(effective).length === 0 && addressDiff === null) return this.get(tx, ctx, id);

    if (newAddress !== null && addressDiff !== null) {
      await tx.updateTable('addresses').set(addressColumns(newAddress)).where('id', '=', current.addressId).execute();
    }
    // An address-only edit still touches the property so its version (ETag) changes.
    const updated = await tx
      .updateTable('properties')
      .set(Object.keys(effective).length > 0 ? effective : { updatedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const changes = {
      ...(diffForAudit(current, updated) ?? {}),
      ...Object.fromEntries(Object.entries(addressDiff ?? {}).map(([key, value]) => [`address.${key}`, value])),
    };
    await this.audit.record(tx, ctx, {
      action: 'property.updated',
      entityType: 'property',
      entityId: id,
      changes: Object.keys(changes).length > 0 ? changes : null,
    });
    await this.audit.emit(tx, ctx, { eventType: 'property.updated', aggregateType: 'property', aggregateId: id, payload: { propertyId: id } });
    return this.get(tx, ctx, id);
  }

  async archive(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<PropertyDto> {
    const current = await tx.selectFrom('properties').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    await assertPropertyAccess(tx, ctx, current, 'property.archive');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt !== null) throw Problems.businessRule('This property is already archived.');

    const blockers = await this.archiveBlockers(tx, { propertyId: id });
    if (blockers) throw Problems.businessRule(blockers);

    const archivedAt = new Date();
    await tx.updateTable('properties').set({ archivedAt, archivedReason: reason }).where('id', '=', id).execute();
    await tx.updateTable('units').set({ archivedAt }).where('propertyId', '=', id).where('archivedAt', 'is', null).execute();
    await this.audit.record(tx, ctx, { action: 'property.archived', entityType: 'property', entityId: id, metadata: { reason } });
    await this.audit.emit(tx, ctx, { eventType: 'property.archived', aggregateType: 'property', aggregateId: id, payload: { propertyId: id, reason } });
    return this.get(tx, ctx, id);
  }

  async restore(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<PropertyDto> {
    const current = await tx.selectFrom('properties').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    await assertPropertyAccess(tx, ctx, current, 'property.archive');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt === null) throw Problems.businessRule('This property is not archived.');
    const office = await this.loadOffice(tx, current.officeId);
    if (!office) throw Problems.businessRule('The property’s office is archived. Move the property to an active office first.');

    // Units archived together with the property share its archive timestamp.
    await tx.updateTable('units').set({ archivedAt: null }).where('propertyId', '=', id).where('archivedAt', '=', current.archivedAt).execute();
    await tx.updateTable('properties').set({ archivedAt: null, archivedReason: null }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'property.restored', entityType: 'property', entityId: id });
    await this.audit.emit(tx, ctx, { eventType: 'property.restored', aggregateType: 'property', aggregateId: id, payload: { propertyId: id } });
    return this.get(tx, ctx, id);
  }

  /** Why a property or unit cannot be archived, or null. */
  async archiveBlockers(tx: Tx, target: { propertyId: string } | { unitId: string }): Promise<string | null> {
    const unitFilter = 'unitId' in target
      ? sql<boolean>`u.id = ${target.unitId}::uuid`
      : sql<boolean>`u.property_id = ${target.propertyId}::uuid`;
    const openListings = await tx
      .selectFrom('listings as l')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where(unitFilter)
      .where('l.status', 'in', [...OPEN_LISTING_STATUSES])
      .where('l.archivedAt', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(openListings.count) > 0) {
      return 'There are open listings. Withdraw or close them before archiving.';
    }
    const liveLeases = await tx
      .selectFrom('leases as le')
      .innerJoin('units as u', 'u.id', 'le.unitId')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where(unitFilter)
      .where('le.status', 'in', [...LIVE_LEASE_STATUSES])
      .executeTakeFirstOrThrow();
    if (Number(liveLeases.count) > 0) {
      return 'There are live leases. End them before archiving.';
    }
    return null;
  }

  private async loadOffice(tx: Tx, id: string) {
    return tx
      .selectFrom('offices')
      .select(['id', 'countryCode', 'jurisdictionCode', 'timezone'])
      .where('id', '=', id)
      .where('archivedAt', 'is', null)
      .executeTakeFirst();
  }

  async checkPropertyType(tx: Tx, propertyTypeId: string, countryCode: string, field: string, target: 'property' | 'unit' = 'property'): Promise<FieldError[]> {
    const type = await tx
      .selectFrom('propertyTypes')
      .select(['id', 'appliesTo', 'countryCode', 'isActive'])
      .where('id', '=', propertyTypeId)
      .executeTakeFirst();
    if (!type || !type.isActive) return [{ field, code: 'not-found', message: 'This property type does not exist or is inactive.' }];
    if (type.appliesTo !== 'both' && type.appliesTo !== target) {
      return [{ field, code: 'not-applicable', message: `This type cannot be used for a ${target}.` }];
    }
    if (type.countryCode !== null && type.countryCode !== countryCode) {
      return [{ field, code: 'country-mismatch', message: 'This property type is not used in the property’s country.' }];
    }
    return [];
  }

  private async resolvePlacement(
    tx: Tx,
    office: { countryCode: string; jurisdictionCode: string; timezone: string },
    countryCode: string,
    requestedJurisdiction: string | undefined,
    requestedTimezone: string | undefined,
    errors: FieldError[],
  ): Promise<ResolvedPlacement | null> {
    let jurisdictionCode: string | null = null;
    if (requestedJurisdiction !== undefined && requestedJurisdiction !== null) {
      if (await this.jurisdictionInCountry(tx, requestedJurisdiction, countryCode)) jurisdictionCode = requestedJurisdiction;
      else errors.push({ field: 'jurisdictionCode', code: 'country-mismatch', message: 'This jurisdiction does not belong to the property’s country.' });
    } else if (office.countryCode === countryCode) {
      jurisdictionCode = office.jurisdictionCode;
    } else {
      const jurisdictions = await tx
        .selectFrom('jurisdictions')
        .select(['code', 'parentCode'])
        .where('countryCode', '=', countryCode)
        .where('isActive', '=', true)
        .execute();
      if (jurisdictions.some((j) => j.parentCode !== null)) {
        errors.push({ field: 'jurisdictionCode', code: 'required', message: 'Choose the legal jurisdiction for this property.' });
      } else {
        jurisdictionCode = jurisdictions.find((j) => j.code === countryCode)?.code ?? null;
      }
    }

    let timezone: string | null = null;
    if (requestedTimezone !== undefined && requestedTimezone !== null) {
      if (isValidTimezone(requestedTimezone)) timezone = requestedTimezone;
      else errors.push({ field: 'timezone', code: 'invalid', message: 'Use an IANA time zone such as Africa/Accra.' });
    } else if (office.countryCode === countryCode) {
      timezone = office.timezone;
    } else {
      const country = await tx.selectFrom('countries').select('defaultTimezone').where('code', '=', countryCode).executeTakeFirst();
      timezone = country?.defaultTimezone ?? null;
    }
    return jurisdictionCode !== null && timezone !== null ? { jurisdictionCode, timezone } : null;
  }

  private async jurisdictionInCountry(tx: Tx, code: string, countryCode: string): Promise<boolean> {
    const found = await tx
      .selectFrom('jurisdictions')
      .select('code')
      .where('code', '=', code)
      .where('countryCode', '=', countryCode)
      .where('isActive', '=', true)
      .executeTakeFirst();
    return found !== undefined;
  }

  private async checkDetails(
    tx: Tx,
    body: { tenureCode?: string | null; yearBuilt?: number | null; tenureExpiresOn?: string | null },
    countryCode: string,
  ): Promise<FieldError[]> {
    const errors: FieldError[] = [];
    if (body.tenureCode !== undefined && body.tenureCode !== null) {
      const error = await checkPicklistCode(tx, 'tenure', body.tenureCode, countryCode, 'tenureCode');
      if (error) errors.push(error);
    }
    if (body.yearBuilt !== undefined && body.yearBuilt !== null && body.yearBuilt > new Date().getUTCFullYear() + 5) {
      errors.push({ field: 'yearBuilt', code: 'range', message: 'The year built is too far in the future.' });
    }
    if (body.tenureExpiresOn !== undefined && body.tenureExpiresOn !== null && !isCalendarDate(body.tenureExpiresOn)) {
      errors.push({ field: 'tenureExpiresOn', code: 'invalid', message: 'This is not a valid date.' });
    }
    return errors;
  }

  private summaryQuery(tx: Tx) {
    return tx
      .selectFrom('properties as p')
      .innerJoin('addresses as a', 'a.id', 'p.addressId')
      .innerJoin('offices as o', 'o.id', 'p.officeId')
      .innerJoin('propertyTypes as pt', 'pt.id', 'p.propertyTypeId')
      .select((eb) => [
        'p.id',
        'p.reference',
        'p.name',
        'p.propertyTypeId',
        'pt.code as propertyTypeCode',
        'pt.name as propertyTypeName',
        'p.officeId',
        'o.code as officeCode',
        'o.name as officeName',
        'a.countryCode',
        'a.locality',
        'a.formatted',
        'p.isManaged',
        'p.archivedAt',
        'p.updatedAt',
        unitCountSubquery(eb),
      ]);
  }

  private detailQuery(tx: Tx) {
    return tx
      .selectFrom('properties as p')
      .innerJoin('addresses as a', 'a.id', 'p.addressId')
      .innerJoin('offices as o', 'o.id', 'p.officeId')
      .innerJoin('propertyTypes as pt', 'pt.id', 'p.propertyTypeId')
      .selectAll('p')
      .select((eb) => [
        'pt.code as propertyTypeCode',
        'pt.name as propertyTypeName',
        'o.code as officeCode',
        'o.name as officeName',
        'a.countryCode',
        'a.addressLine1',
        'a.addressLine2',
        'a.addressLine3',
        'a.dependentLocality',
        'a.locality',
        'a.adminArea2',
        'a.adminArea1',
        'a.postalCode',
        'a.localComponents',
        'a.formatted',
        'a.latitude',
        'a.longitude',
        unitCountSubquery(eb),
      ]);
  }
}

function unitCountSubquery(eb: ExpressionBuilder<DB & { p: DB['properties'] }, 'p'>) {
  return eb
    .selectFrom('units as u')
    .select(sql<number>`count(*)::int`.as('n'))
    .whereRef('u.propertyId', '=', 'p.id')
    .where('u.archivedAt', 'is', null)
    .as('unitCount');
}

export async function nextReference(tx: Tx, ctx: TenantContext, key: string): Promise<string> {
  const { rows } = await sql<{ reference: string }>`select app.next_reference(${ctx.companyId}::uuid, ${key}) as reference`.execute(tx);
  const reference = rows[0]?.reference;
  if (reference === undefined) throw Problems.internal();
  return reference;
}

/** True for a real 'YYYY-MM-DD' date (Date.parse would roll 2026-02-30 over to March). */
export function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Database numerics arrive as strings; compare them with request numbers by value. */
export function sameValue(stored: unknown, requested: unknown): boolean {
  if (typeof requested === 'number' && typeof stored === 'string') return Number(stored) === requested;
  return JSON.stringify(stored ?? null) === JSON.stringify(requested ?? null);
}

/** Plain-object view of an address for audit diffs (coordinates already numbers). */
function addressSnapshot(address: Omit<NormalisedAddress, 'formatted'> & { formatted: string | null }): Record<string, unknown> {
  return { ...address };
}

function addressColumns(address: NormalisedAddress) {
  return {
    countryCode: address.countryCode,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    addressLine3: address.addressLine3,
    dependentLocality: address.dependentLocality,
    locality: address.locality,
    adminArea2: address.adminArea2,
    adminArea1: address.adminArea1,
    postalCode: address.postalCode,
    localComponents: JSON.stringify(address.localComponents),
    formatted: address.formatted,
    latitude: address.latitude,
    longitude: address.longitude,
  };
}

async function insertAddress(tx: Tx, ctx: TenantContext, address: NormalisedAddress): Promise<string> {
  const row = await tx
    .insertInto('addresses')
    .values({ companyId: ctx.companyId, ...addressColumns(address) })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

function landAreaColumns(landArea: LandAreaInput | null) {
  if (landArea === null) return { landAreaSqm: null, landAreaInput: null, landAreaInputUnit: null };
  return {
    landAreaSqm: toSquareMetres(landArea.value, landArea.unit),
    landAreaInput: landArea.value,
    landAreaInputUnit: landArea.unit,
  };
}

function toPropertyDto(row: Awaited<ReturnType<ReturnType<PropertiesService['detailQuery']>['executeTakeFirstOrThrow']>>): PropertyDto {
  return {
    id: row.id,
    reference: row.reference,
    name: row.name,
    propertyType: { id: row.propertyTypeId, code: row.propertyTypeCode, name: row.propertyTypeName },
    office: { id: row.officeId, code: row.officeCode, name: row.officeName },
    jurisdictionCode: row.jurisdictionCode,
    timezone: row.timezone,
    address: toAddressDto(row),
    tenureCode: row.tenureCode,
    tenureExpiresOn: row.tenureExpiresOn,
    titleReference: row.titleReference,
    yearBuilt: row.yearBuilt,
    floorsCount: row.floorsCount,
    landArea:
      row.landAreaInput === null || row.landAreaInputUnit === null
        ? null
        : {
            sqm: row.landAreaSqm === null ? null : Number(row.landAreaSqm),
            value: Number(row.landAreaInput),
            unit: row.landAreaInputUnit,
          },
    isManaged: row.isManaged,
    internalNotes: row.internalNotes,
    customFields: (row.customFields ?? {}) as Record<string, unknown>,
    unitCount: row.unitCount ?? 0,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    archivedReason: row.archivedReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
