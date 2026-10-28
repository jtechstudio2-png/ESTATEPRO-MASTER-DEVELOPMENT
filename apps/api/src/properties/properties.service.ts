import { Inject, Injectable } from '@nestjs/common';
import { type ExpressionBuilder, type Selectable, sql } from 'kysely';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import {
  keysetCondition,
  type Page,
  type ParsedFilters,
  type ParsedListQuery,
  sortValueSql,
  toPage,
} from '../common/list-query.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import {
  assertDistanceSort,
  assertUsablePolygon,
  distanceSql,
  hasLocationFilter,
  configureSearchTransaction,
  locationConditions,
  type LocationFilter,
} from '../location/location-filter.js';
import { mapResult, requireViewport } from '../location/map-results.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import type { Addresses, DB } from '../database/schema.js';
import { type GeocodeSource, type NormalisedAddress, toAddressDto, validateAddress } from '../reference/address.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { listingScopeSql } from '../listings/listing-access.js';
import type {
  CreatePropertyBody,
  LandAreaInput,
  PropertyDto,
  PropertyHistoryEntryDto,
  PropertyMapDto,
  PropertySummaryCountsDto,
  PropertySummaryDto,
  UpdatePropertyBody,
} from './dto.js';
import { assertPropertyAccess, canUseOffice, propertyScopeSql } from './property-access.js';

registerConstraintMessages({
  properties_company_id_reference_key: 'This property reference is already in use.',
});

/** Square metres per input unit; "plot" has no fixed size and is stored as entered only. */
const SQM_PER_UNIT: Record<string, number | null> = { sqm: 1, sqft: 0.09290304, acre: 4046.8564224, hectare: 10_000, plot: null };
export const OPEN_LISTING_STATUSES = ['draft', 'available', 'reserved', 'under_contract'] as const;
export const LIVE_LEASE_STATUSES = ['pending_signature', 'active', 'periodic', 'notice_given'] as const;

export type PropertySortField = 'reference' | 'createdAt' | 'updatedAt' | 'distance';

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
  constructor(
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(
    tx: Tx,
    ctx: TenantContext,
    scope: PermissionScope,
    query: ParsedListQuery<PropertySortField>,
    location: LocationFilter,
  ): Promise<Page<PropertySummaryDto>> {
    assertDistanceSort(query.sort.field, location);
    await this.prepareLocationSearch(tx, location);
    const sortExpression = query.sort.field === 'distance' ? distanceSql(location, 'a') : sql.ref(`p.${query.sort.field}`);
    let qb = this.filteredQuery(tx, ctx, scope, query.filters, query.q, location)
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
        'a.latitude',
        'a.longitude',
        'a.geocodeSource',
        'a.locationStale',
        'p.isManaged',
        'p.archivedAt',
        'p.updatedAt',
        unitCountSubquery(eb),
        sortValueSql(sortExpression, query.sort.kind).as('cursorValue'),
        (location.near ? distanceSql(location, 'a') : sql<string | null>`null`).as('distanceMeters'),
      ]);
    if (query.cursor) qb = qb.where(keysetCondition(sortExpression, 'p.id', query.sort, query.cursor));

    const rows = await qb
      .orderBy(sortExpression, query.sort.direction)
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
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      geocodeSource: row.geocodeSource,
      locationStale: row.locationStale,
      distanceMeters: row.distanceMeters === null ? null : Number(row.distanceMeters),
      unitCount: row.unitCount ?? 0,
      isManaged: row.isManaged,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** Map view (ADR-006 L-D4): points in the viewport, or clusters above 500. */
  async map(tx: Tx, ctx: TenantContext, scope: PermissionScope, filters: ParsedFilters, q: string | null, location: LocationFilter): Promise<PropertyMapDto> {
    const bbox = requireViewport(location);
    await this.prepareLocationSearch(tx, location);
    const located = this.filteredQuery(tx, ctx, scope, filters, q, location).where('a.location', 'is not', null);
    const points = located
      .select(['p.id', 'p.reference', 'p.name', 'pt.code as propertyTypeCode', 'p.isManaged', 'a.latitude', 'a.longitude'])
      .orderBy('p.id');
    return mapResult(tx, points, located.select(['a.latitude', 'a.longitude']), bbox, (row) => ({
      id: row.id,
      reference: row.reference,
      name: row.name,
      propertyTypeCode: row.propertyTypeCode,
      isManaged: row.isManaged,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    }));
  }

  private async prepareLocationSearch(tx: Tx, location: LocationFilter): Promise<void> {
    if (!hasLocationFilter(location)) return;
    await configureSearchTransaction(tx, this.config.SEARCH_STATEMENT_TIMEOUT_MS);
    await assertUsablePolygon(tx, location);
  }

  /** Scope, list filters, text search and location conditions shared by the list and the map. */
  private filteredQuery(
    tx: Tx,
    ctx: TenantContext,
    scope: PermissionScope,
    filters: ParsedFilters,
    q: string | null,
    location: LocationFilter,
  ) {
    let qb = tx
      .selectFrom('properties as p')
      .innerJoin('addresses as a', 'a.id', 'p.addressId')
      .innerJoin('offices as o', 'o.id', 'p.officeId')
      .innerJoin('propertyTypes as pt', 'pt.id', 'p.propertyTypeId')
      .where(propertyScopeSql(scope, ctx, 'p'));
    const archived = filters['archived'] ?? 'false';
    if (archived === 'false') qb = qb.where('p.archivedAt', 'is', null);
    if (archived === 'true') qb = qb.where('p.archivedAt', 'is not', null);
    if (Array.isArray(filters['officeId'])) qb = qb.where('p.officeId', 'in', filters['officeId']);
    if (Array.isArray(filters['propertyTypeId'])) qb = qb.where('p.propertyTypeId', 'in', filters['propertyTypeId']);
    if (Array.isArray(filters['countryCode'])) qb = qb.where('a.countryCode', 'in', filters['countryCode']);
    if (typeof filters['isManaged'] === 'boolean') qb = qb.where('p.isManaged', '=', filters['isManaged']);
    if (typeof filters['locationStale'] === 'boolean') qb = qb.where('a.locationStale', '=', filters['locationStale']);
    if (q !== null) {
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      qb = qb.where((eb) => eb.or([eb('p.reference', 'ilike', pattern), eb('p.name', 'ilike', pattern), eb('a.formatted', 'ilike', pattern)]));
    }
    for (const condition of locationConditions(location, 'a')) qb = qb.where(condition);
    return qb;
  }

  /** Counts for the property's tabs (M6 API gap A-8); sections the member cannot see are null. */
  async summary(tx: Tx, ctx: TenantContext, id: string): Promise<PropertySummaryCountsDto> {
    await this.get(tx, ctx, id);
    const can = (permission: string) => ctx.permissions.has(permission);
    const units = await tx
      .selectFrom('units')
      .select([
        sql<number>`count(*)::int`.as('total'),
        sql<number>`count(*) filter (where availability = 'available')::int`.as('available'),
        sql<number>`count(*) filter (where availability = 'under_maintenance')::int`.as('underMaintenance'),
        sql<number>`count(*) filter (where availability = 'unavailable')::int`.as('unavailable'),
      ])
      .where('propertyId', '=', id)
      .where('archivedAt', 'is', null)
      .executeTakeFirstOrThrow();
    const media = await tx
      .selectFrom('propertyMedia')
      .select([
        sql<number>`count(*) filter (where media_type = 'photo' and processing_status = 'ready')::int`.as('photos'),
        sql<number>`count(*) filter (where media_type in ('floor_plan', 'site_plan', 'brochure') and processing_status = 'ready')::int`.as('plans'),
        sql<number>`count(*) filter (where media_type in ('video', 'virtual_tour'))::int`.as('links'),
        sql<number>`count(*) filter (where processing_status = 'pending')::int`.as('processing'),
        sql<number>`count(*) filter (where processing_status in ('rejected', 'failed'))::int`.as('rejected'),
      ])
      .where('propertyId', '=', id)
      .where('archivedAt', 'is', null)
      .executeTakeFirstOrThrow();
    const listings = can('listing.view')
      ? await tx
          .selectFrom('listings as l')
          .innerJoin('units as u', 'u.id', 'l.unitId')
          .select([
            sql<number>`count(*) filter (where l.status in ('available', 'reserved', 'under_contract'))::int`.as('live'),
            sql<number>`count(*) filter (where l.status = 'draft')::int`.as('draft'),
          ])
          .where('u.propertyId', '=', id)
          .where('l.archivedAt', 'is', null)
          .where(listingScopeSql(ctx.permissions.get('listing.view')!.scope, ctx, 'l'))
          .executeTakeFirstOrThrow()
      : null;
    const notes = can('property_note.view')
      ? await tx
          .selectFrom('propertyNotes')
          .select([sql<number>`count(*)::int`.as('total'), sql<number>`count(*) filter (where is_pinned)::int`.as('pinned')])
          .where('propertyId', '=', id)
          .where('archivedAt', 'is', null)
          .executeTakeFirstOrThrow()
      : null;
    const keys = can('key.view')
      ? await tx
          .selectFrom('keySets')
          .select([
            sql<number>`count(*) filter (where status <> 'retired')::int`.as('active'),
            sql<number>`count(*) filter (where status = 'checked_out')::int`.as('out'),
            sql<number>`count(*) filter (where status = 'checked_out' and due_back_at < now())::int`.as('overdue'),
          ])
          .where('propertyId', '=', id)
          .executeTakeFirstOrThrow()
      : null;
    return { units, media, listings, notes, keys };
  }

  /**
   * Audit entries for the property and its units, media, notes, key sets and
   * listings (A-4). Each kind appears only with its view permission. Entries
   * hold metadata only: note text is never in the audit log (ADR-006 L-D7).
   */
  async history(tx: Tx, ctx: TenantContext, id: string, query: ParsedListQuery<'occurredAt'>): Promise<Page<PropertyHistoryEntryDto>> {
    await this.get(tx, ctx, id);
    const can = (permission: string) => ctx.permissions.has(permission);
    const related = sql<boolean>`(
         (a.entity_type = 'property' and a.entity_id = ${id}::uuid)
      or (a.entity_type = 'unit' and a.entity_id in (select u.id from units u where u.property_id = ${id}::uuid))
      or (a.entity_type = 'media' and a.entity_id in (select m.id from property_media m where m.property_id = ${id}::uuid))
      ${can('property_note.view') ? sql`or (a.entity_type = 'property_note' and a.entity_id in (select n.id from property_notes n where n.property_id = ${id}::uuid))` : sql``}
      ${can('key.view') ? sql`or (a.entity_type = 'key_set' and a.entity_id in (select k.id from key_sets k where k.property_id = ${id}::uuid))` : sql``}
      ${
        can('listing.view')
          ? sql`or (a.entity_type = 'listing' and a.entity_id in (select l.id from listings l join units u on u.id = l.unit_id
               where u.property_id = ${id}::uuid and ${listingScopeSql(ctx.permissions.get('listing.view')!.scope, ctx, 'l')}))`
          : sql``
      })`;
    let qb = tx
      .selectFrom('auditLogs as a')
      .leftJoin('companyMemberships as m', 'm.id', 'a.actorMembershipId')
      .leftJoin('users as us', 'us.id', 'm.userId')
      .select(['a.id', 'a.occurredAt', 'a.action', 'a.entityType', 'a.entityId', 'a.actorType', 'a.actorMembershipId', 'us.displayName', 'a.changes', 'a.metadata'])
      .select(sortValueSql('a.occurredAt', 'timestamp').as('cursorValue'))
      .where(related);
    const types = query.filters['entityType'];
    if (Array.isArray(types)) qb = qb.where('a.entityType', 'in', types);
    if (query.cursor) qb = qb.where(keysetCondition('a.occurredAt', 'a.id', query.sort, query.cursor));
    const rows = await qb.orderBy('a.occurredAt', query.sort.direction).orderBy('a.id', query.sort.direction).limit(query.limit + 1).execute();
    return toPage(rows, query.limit, (r) => r.cursorValue, (r) => r.id, (r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      action: r.action,
      entityType: r.entityType ?? 'property',
      entityId: r.entityId,
      actorType: r.actorType,
      actorMembershipId: r.actorMembershipId,
      actorName: r.displayName,
      changes: (r.changes ?? null) as Record<string, unknown> | null,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
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
    for (const field of ['name', 'tenureExpiresOn', 'titleReference', 'yearBuilt', 'floorsCount', 'isManaged'] as const) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    if (body.landArea !== undefined) Object.assign(patch, landAreaColumns(body.landArea));
    const effective = Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => !sameValue((current as Record<string, unknown>)[key], value)),
    );
    const nextAddress = newAddress ? addressUpdateColumns(currentAddress, newAddress) : null;
    const addressDiff = nextAddress ? diffForAudit(addressSnapshot(currentAddress), addressSnapshot(nextAddress)) : null;
    if (Object.keys(effective).length === 0 && addressDiff === null) return this.get(tx, ctx, id);

    if (nextAddress !== null && addressDiff !== null) {
      await tx.updateTable('addresses').set(nextAddress).where('id', '=', current.addressId).execute();
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
    if (addressDiff?.['latitude'] !== undefined || addressDiff?.['longitude'] !== undefined) {
      await this.audit.record(tx, ctx, {
        action: 'property.location_changed',
        entityType: 'property',
        entityId: id,
        changes: {
          location: {
            old: pointOf(currentAddress.latitude, currentAddress.longitude),
            new: pointOf(nextAddress!.latitude, nextAddress!.longitude),
          },
        },
        metadata: { geocodeSource: nextAddress!.geocodeSource, geocodeAccuracy: nextAddress!.geocodeAccuracy },
      });
    }
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
        'a.geocodeSource',
        'a.geocodeAccuracy',
        'a.geocodedAt',
        'a.locationStale',
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

type AddressRow = Selectable<Addresses>;
type AddressColumns = ReturnType<typeof addressColumns>;

/** Plain-object view of an address for audit diffs: coordinates as numbers, no timestamps. */
function addressSnapshot(address: AddressRow | AddressColumns): Record<string, unknown> {
  const localComponents = typeof address.localComponents === 'string' ? (JSON.parse(address.localComponents) as unknown) : address.localComponents;
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
    localComponents,
    formatted: address.formatted,
    latitude: address.latitude === null ? null : Number(address.latitude),
    longitude: address.longitude === null ? null : Number(address.longitude),
    geocodeSource: address.geocodeSource,
    geocodeAccuracy: address.geocodeAccuracy,
    locationStale: address.locationStale,
  };
}

function pointOf(latitude: string | number | null, longitude: string | number | null) {
  return latitude === null || longitude === null ? null : { latitude: Number(latitude), longitude: Number(longitude) };
}

const LOCATING_FIELDS = [
  'countryCode', 'addressLine1', 'addressLine2', 'addressLine3', 'dependentLocality',
  'locality', 'adminArea2', 'adminArea1', 'postalCode', 'localComponents',
] as const;

/**
 * Columns for an address edit (ADR-006 L-D2). Coordinates that were not sent
 * are kept, never cleared silently; when the address text changes under a
 * kept point, the point is flagged for checking.
 */
function addressUpdateColumns(current: AddressRow, next: NormalisedAddress): AddressColumns {
  const columns = addressColumns(next);
  if (next.location.kind !== 'keep') {
    const sameConfirmedPoint =
      next.location.kind === 'set' &&
      current.latitude !== null &&
      Number(current.latitude) === next.location.latitude &&
      Number(current.longitude) === next.location.longitude &&
      current.geocodeSource === next.location.source &&
      current.geocodeAccuracy === next.location.accuracy;
    return sameConfirmedPoint ? { ...columns, geocodedAt: current.geocodedAt } : columns;
  }
  const before = addressSnapshot(current);
  const after = addressSnapshot(columns);
  const textChanged = LOCATING_FIELDS.some((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
  return {
    ...columns,
    latitude: current.latitude === null ? null : Number(current.latitude),
    longitude: current.longitude === null ? null : Number(current.longitude),
    geocodeSource: current.geocodeSource as GeocodeSource | null,
    geocodeAccuracy: current.geocodeAccuracy,
    geocodedAt: current.geocodedAt,
    locationStale: current.latitude !== null && (current.locationStale || textChanged),
  };
}

function addressColumns(address: NormalisedAddress) {
  const point = address.location.kind === 'set' ? address.location : null;
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
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
    geocodeSource: point?.source ?? null,
    geocodeAccuracy: point?.accuracy ?? null,
    geocodedAt: point ? new Date() : null,
    locationStale: false,
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
    customFields: (row.customFields ?? {}) as Record<string, unknown>,
    unitCount: row.unitCount ?? 0,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    archivedReason: row.archivedReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
