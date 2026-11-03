import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { keysetCondition, type Page, type ParsedListQuery, type RangeValue, sortValueSql, toPage } from '../common/list-query.js';
import { decimalPlaces, toMoney, toScaled } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { listingScopeSql } from '../listings/listing-access.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { contactScopeSql, scopeFor } from './contact-access.js';
import { assertEditable, ContactsService } from './contacts.service.js';
import {
  featuresMatchedSql,
  LISTING_JOINS,
  MATCH_RULES,
  matchConditions,
  propertyTypeMatchedSql,
  withinMaxBedroomsSql,
} from './requirement-matching.js';
import {
  type CreateRequirementBody,
  type ExcludeListingBody,
  MAX_AREAS,
  type RequirementAreaDto,
  type RequirementAreaInput,
  type RequirementDto,
  type RequirementExclusionDto,
  type RequirementMatchesDto,
  type UpdateRequirementBody,
} from './requirements.dto.js';

export type RequirementSortField = 'updatedAt' | 'createdAt';

/** Lists show at most this many matches per requirement ("100+"); the matches endpoint gives the exact total. */
export const MATCH_COUNT_CAP = 100;

const MAX_RADIUS_METRES = 50_000;
const MAX_POLYGON_POINTS = 100;
const MAX_POLYGON_AREA_KM2 = 25_000;

interface RequirementColumns {
  status: string;
  currencyCode: string;
  minPrice: string | null;
  maxPrice: string | null;
  rentFrequency: string | null;
  minBedrooms: number | null;
  maxBedrooms: number | null;
  propertyTypeIds: string[];
  locations: RequirementAreaDto[];
  mustHaveFeatures: string[];
  moveBy: string | null;
  financingStatus: string | null;
  notes: string | null;
}

/**
 * Buyer and tenant requirements and their listing matches (CRM-03; wireframes
 * B-1 and B-2; decision D4). Reading needs contact.view on the contact (with
 * decision D1); writing needs contact.update in its narrower scope; matches
 * also need listing.view and only include listings within its scope.
 */
@Injectable()
export class RequirementsService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- reading

  /** Requirements register (B-1): requirements of contacts the member may see. */
  async register(tx: Tx, ctx: TenantContext, scope: PermissionScope, query: ParsedListQuery<RequirementSortField>): Promise<Page<RequirementDto>> {
    const f = query.filters;
    const sortColumn = `r.${query.sort.field}`;
    let qb = this.baseQuery(tx)
      .select(sortValueSql(sortColumn, query.sort.kind).as('cursorValue'))
      .where('c.archivedAt', 'is', null)
      .where('c.mergedIntoContactId', 'is', null)
      .where(contactScopeSql(scope, ctx, 'c', 'read'))
      .where('r.status', 'in', Array.isArray(f['status']) ? f['status'] : ['active']);
    if (Array.isArray(f['requirementType'])) qb = qb.where('r.requirementType', 'in', f['requirementType']);
    if (Array.isArray(f['currencyCode'])) qb = qb.where('r.currencyCode', 'in', f['currencyCode']);
    if (Array.isArray(f['financingStatus'])) qb = qb.where('r.financingStatus', 'in', f['financingStatus']);
    if (Array.isArray(f['contactId'])) qb = qb.where('r.contactId', 'in', f['contactId']);
    const budget = f['budget'] as RangeValue | undefined;
    if (budget?.gte !== undefined) qb = qb.where(sql<boolean>`(r.max_price is null or r.max_price >= ${budget.gte}::numeric)`);
    if (budget?.lte !== undefined) qb = qb.where(sql<boolean>`(r.min_price is null or r.min_price <= ${budget.lte}::numeric)`);
    const moveBy = f['moveBy'] as RangeValue | undefined;
    if (moveBy?.gte !== undefined) qb = qb.where('r.moveBy', '>=', moveBy.gte);
    if (moveBy?.lte !== undefined) qb = qb.where('r.moveBy', '<=', moveBy.lte);
    if (Array.isArray(f['locality'])) {
      const localities = f['locality'].map((value) => value.toLowerCase());
      qb = qb.where(sql<boolean>`exists (select 1 from jsonb_array_elements(r.locations) e
        where e ->> 'kind' = 'locality' and lower(e ->> 'locality') = any(${localities}::text[]))`);
    }
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'r.id', query.sort, query.cursor));
    const rows = await qb
      .orderBy(sql.ref(sortColumn), query.sort.direction)
      .orderBy('r.id', query.sort.direction)
      .limit(query.limit + 1)
      .execute();
    const counts = await this.matchCounts(tx, ctx, rows.slice(0, query.limit).map((row) => row.id));
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => toRequirementDto(row, counts));
  }

  async listForContact(tx: Tx, ctx: TenantContext, contactId: string): Promise<RequirementDto[]> {
    await this.readableContact(tx, ctx, contactId);
    const rows = await this.baseQuery(tx).where('r.contactId', '=', contactId).orderBy('r.createdAt', 'desc').orderBy('r.id', 'desc').execute();
    const counts = await this.matchCounts(tx, ctx, rows.map((row) => row.id));
    return rows.map((row) => toRequirementDto(row, counts));
  }

  async get(tx: Tx, ctx: TenantContext, contactId: string, requirementId: string): Promise<RequirementDto> {
    await this.readableContact(tx, ctx, contactId);
    const row = await this.loadRequirement(tx, contactId, requirementId);
    const counts = await this.matchCounts(tx, ctx, [row.id]);
    return toRequirementDto(row, counts);
  }

  /** Published listings matching one requirement, best first (B-2). */
  async matches(tx: Tx, ctx: TenantContext, contactId: string, requirementId: string, limit: number): Promise<RequirementMatchesDto> {
    await this.readableContact(tx, ctx, contactId);
    const listingScope = scopeFor(ctx, 'listing.view');
    if (listingScope === null) throw Problems.forbidden('Seeing matching listings needs permission to view listings.');
    await this.loadRequirement(tx, contactId, requirementId);
    const { rows } = await sql<{
      listingId: string;
      reference: string;
      title: string;
      listingType: string;
      price: string;
      currencyCode: string;
      minorUnits: number;
      rentFrequency: string | null;
      bedrooms: number | null;
      locality: string | null;
      publishedAt: Date | null;
      wanted: string[];
      featuresMatched: string[];
      propertyTypeMatched: boolean | null;
      withinMaxBedrooms: boolean | null;
      total: string;
    }>`
      select m.*, (cardinality(m.features_matched) + (m.property_type_matched is true)::int + (m.within_max_bedrooms is true)::int) as score,
             count(*) over () as total
        from (select l.id as listing_id, l.reference, l.title, l.listing_type, l.price, l.currency_code, cur.minor_units,
                     l.rent_frequency, u.bedrooms, a.locality, l.published_at, r.must_have_features as wanted,
                     ${featuresMatchedSql} as features_matched, ${propertyTypeMatchedSql} as property_type_matched,
                     ${withinMaxBedroomsSql} as within_max_bedrooms
                from requirements r
                join listings l on true
                ${LISTING_JOINS}
                join currencies cur on cur.code = l.currency_code
               where r.id = ${requirementId}::uuid and ${matchConditions(ctx, listingScope)}) m
       order by score desc, m.published_at desc nulls last, m.listing_id
       limit ${limit}`.execute(tx);
    return {
      data: rows.map((row) => {
        const matched = row.featuresMatched;
        return {
          listingId: row.listingId,
          reference: row.reference,
          title: row.title,
          listingType: row.listingType,
          price: toMoney(row.price, row.currencyCode, row.minorUnits),
          rentFrequency: row.rentFrequency,
          bedrooms: row.bedrooms,
          locality: row.locality,
          publishedAt: row.publishedAt?.toISOString() ?? null,
          score: matched.length + (row.propertyTypeMatched === true ? 1 : 0) + (row.withinMaxBedrooms === true ? 1 : 0),
          breakdown: {
            featuresMatched: matched,
            featuresMissing: row.wanted.filter((code) => !matched.includes(code)),
            propertyTypeMatched: row.propertyTypeMatched,
            withinMaxBedrooms: row.withinMaxBedrooms,
          },
        };
      }),
      total: rows.length > 0 ? Number(rows[0]!.total) : 0,
      rules: [...MATCH_RULES],
    };
  }

  async exclusions(tx: Tx, ctx: TenantContext, contactId: string, requirementId: string): Promise<RequirementExclusionDto[]> {
    await this.readableContact(tx, ctx, contactId);
    await this.loadRequirement(tx, contactId, requirementId);
    const rows = await tx
      .selectFrom('requirementExclusions as x')
      .innerJoin('listings as l', 'l.id', 'x.listingId')
      .leftJoin('companyMemberships as m', 'm.id', 'x.excludedBy')
      .leftJoin('users as u', 'u.id', 'm.userId')
      .select(['x.listingId', 'l.reference', 'l.title', 'x.reason', 'x.excludedBy', 'u.displayName as excludedByName', 'x.excludedAt'])
      .where('x.requirementId', '=', requirementId)
      .orderBy('x.excludedAt', 'desc')
      .execute();
    return rows.map((row) => ({
      listingId: row.listingId,
      listingReference: row.reference,
      listingTitle: row.title,
      reason: row.reason,
      excludedBy: row.excludedBy !== null ? { id: row.excludedBy, name: row.excludedByName ?? '' } : null,
      excludedAt: row.excludedAt.toISOString(),
    }));
  }

  // ----------------------------------------------------------------- writing

  async create(tx: Tx, ctx: TenantContext, contactId: string, body: CreateRequirementBody): Promise<RequirementDto> {
    const contact = await this.editableContact(tx, ctx, contactId);
    const columns = await this.validate(tx, ctx, contact.officeId, body.requirementType, {
      status: body.status ?? 'active',
      currencyCode: body.currencyCode,
      minPrice: body.minPrice ?? null,
      maxPrice: body.maxPrice ?? null,
      rentFrequency: body.rentFrequency ?? null,
      minBedrooms: body.minBedrooms ?? null,
      maxBedrooms: body.maxBedrooms ?? null,
      propertyTypeIds: body.propertyTypeIds ?? [],
      locations: (body.areas ?? []).map(toStoredArea),
      mustHaveFeatures: body.mustHaveFeatures ?? [],
      moveBy: body.moveBy ?? null,
      financingStatus: body.financingStatus ?? null,
      notes: emptyToNull(body.notes),
    });
    const inserted = await tx
      .insertInto('requirements')
      .values({
        companyId: ctx.companyId,
        contactId,
        requirementType: body.requirementType,
        ...columns,
        locations: JSON.stringify(columns.locations),
        createdBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'requirement.created',
      entityType: 'requirement',
      entityId: inserted.id,
      metadata: { contactId, requirementType: body.requirementType, status: columns.status, currencyCode: columns.currencyCode, areas: columns.locations.length },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'requirement.created',
      aggregateType: 'requirement',
      aggregateId: inserted.id,
      payload: { requirementId: inserted.id, contactId },
    });
    return this.get(tx, ctx, contactId, inserted.id);
  }

  async update(tx: Tx, ctx: TenantContext, contactId: string, requirementId: string, expectedVersion: number, body: UpdateRequirementBody): Promise<RequirementDto> {
    const contact = await this.editableContact(tx, ctx, contactId);
    const current = await tx
      .selectFrom('requirements')
      .selectAll()
      .where('id', '=', requirementId)
      .where('contactId', '=', contactId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw Problems.notFound();
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    const before: RequirementColumns = {
      status: current.status,
      currencyCode: current.currencyCode,
      minPrice: current.minPrice,
      maxPrice: current.maxPrice,
      rentFrequency: current.rentFrequency,
      minBedrooms: current.minBedrooms,
      maxBedrooms: current.maxBedrooms,
      propertyTypeIds: current.propertyTypeIds,
      locations: current.locations as unknown as RequirementAreaDto[],
      mustHaveFeatures: current.mustHaveFeatures,
      moveBy: current.moveBy,
      financingStatus: current.financingStatus,
      notes: current.notes,
    };
    const pick = <K extends keyof RequirementColumns>(key: K, value: RequirementColumns[K] | undefined): RequirementColumns[K] =>
      value === undefined ? before[key] : value;
    const next = await this.validate(tx, ctx, contact.officeId, current.requirementType, {
      status: pick('status', body.status),
      currencyCode: pick('currencyCode', body.currencyCode),
      minPrice: pick('minPrice', body.minPrice),
      maxPrice: pick('maxPrice', body.maxPrice),
      rentFrequency: pick('rentFrequency', body.rentFrequency),
      minBedrooms: pick('minBedrooms', body.minBedrooms),
      maxBedrooms: pick('maxBedrooms', body.maxBedrooms),
      propertyTypeIds: pick('propertyTypeIds', body.propertyTypeIds),
      locations: body.areas === undefined ? before.locations : body.areas.map(toStoredArea),
      mustHaveFeatures: pick('mustHaveFeatures', body.mustHaveFeatures),
      moveBy: pick('moveBy', body.moveBy),
      financingStatus: pick('financingStatus', body.financingStatus),
      notes: body.notes === undefined ? before.notes : emptyToNull(body.notes),
    });
    const changes = diffForAudit(normaliseForAudit(before), normaliseForAudit(next)) ?? {};
    if (Object.keys(changes).length === 0) return this.get(tx, ctx, contactId, requirementId);
    await tx
      .updateTable('requirements')
      .set({ ...next, locations: JSON.stringify(next.locations) })
      .where('id', '=', requirementId)
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'requirement.updated',
      entityType: 'requirement',
      entityId: requirementId,
      metadata: { contactId, changes },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'requirement.updated',
      aggregateType: 'requirement',
      aggregateId: requirementId,
      payload: { requirementId, contactId, fields: Object.keys(changes) },
    });
    return this.get(tx, ctx, contactId, requirementId);
  }

  /** Marks a listing "not suitable" for a requirement; it no longer appears as a match. */
  async exclude(tx: Tx, ctx: TenantContext, contactId: string, requirementId: string, body: ExcludeListingBody): Promise<RequirementExclusionDto[]> {
    await this.editableContact(tx, ctx, contactId);
    await this.loadRequirement(tx, contactId, requirementId);
    const listingScope = scopeFor(ctx, 'listing.view');
    const listing = await tx.selectFrom('listings').select(['id', 'officeId', 'agentMembershipId']).where('id', '=', body.listingId).executeTakeFirst();
    const visible =
      listing !== undefined &&
      listingScope !== null &&
      (await tx.selectFrom('listings as l').select('l.id').where('l.id', '=', listing.id).where(listingScopeSql(listingScope, ctx, 'l')).executeTakeFirst()) !== undefined;
    if (!visible) {
      throw Problems.validation([{ field: 'listingId', code: 'not-found', message: 'Choose a listing you can see.' }]);
    }
    const inserted = await tx
      .insertInto('requirementExclusions')
      .values({ companyId: ctx.companyId, requirementId, listingId: body.listingId, reason: body.reason, excludedBy: ctx.membershipId })
      .onConflict((oc) => oc.columns(['companyId', 'requirementId', 'listingId']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) throw Problems.conflict('This listing is already marked not suitable for this requirement.');
    await this.audit.record(tx, ctx, {
      action: 'requirement.listing_excluded',
      entityType: 'requirement',
      entityId: requirementId,
      metadata: { contactId, listingId: body.listingId, reason: body.reason },
    });
    return this.exclusions(tx, ctx, contactId, requirementId);
  }

  /** Lets a listing appear as a match again. */
  async restoreListing(tx: Tx, ctx: TenantContext, contactId: string, requirementId: string, listingId: string): Promise<RequirementExclusionDto[]> {
    await this.editableContact(tx, ctx, contactId);
    await this.loadRequirement(tx, contactId, requirementId);
    const removed = await tx
      .deleteFrom('requirementExclusions')
      .where('requirementId', '=', requirementId)
      .where('listingId', '=', listingId)
      .returning(['reason'])
      .executeTakeFirst();
    if (!removed) throw Problems.notFound();
    await this.audit.record(tx, ctx, {
      action: 'requirement.listing_restored',
      entityType: 'requirement',
      entityId: requirementId,
      metadata: { contactId, listingId, previousReason: removed.reason },
    });
    return this.exclusions(tx, ctx, contactId, requirementId);
  }

  // ----------------------------------------------------------------- helpers

  private baseQuery(tx: Tx) {
    return requirementQuery(tx);
  }

  private async loadRequirement(tx: Tx, contactId: string, requirementId: string) {
    const row = await this.baseQuery(tx).where('r.id', '=', requirementId).where('r.contactId', '=', contactId).executeTakeFirst();
    if (!row) throw Problems.notFound();
    return row;
  }

  private async readableContact(tx: Tx, ctx: TenantContext, contactId: string) {
    const contact = await this.contacts.loadRow(tx, contactId);
    if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) throw Problems.notFound();
    return contact;
  }

  private async editableContact(tx: Tx, ctx: TenantContext, contactId: string) {
    const contact = await tx.selectFrom('contacts').selectAll().where('id', '=', contactId).forUpdate().executeTakeFirst();
    if (!contact) throw Problems.notFound();
    await this.contacts.assertWrite(tx, ctx, contact, 'contact.update');
    assertEditable(contact);
    return contact;
  }

  /**
   * Match counts for requirements on one page; null without listing.view.
   * Counting stops above MATCH_COUNT_CAP ("100+"), so a page of broad
   * requirements costs no more than a page of narrow ones.
   */
  private async matchCounts(tx: Tx, ctx: TenantContext, ids: string[]): Promise<Map<string, number> | null> {
    const listingScope = scopeFor(ctx, 'listing.view');
    if (listingScope === null) return null;
    const counts = new Map<string, number>();
    if (ids.length === 0) return counts;
    const { rows } = await sql<{ id: string; n: string }>`
      select r.id, count(l.id) as n
        from requirements r
        left join lateral (select l.id from listings l ${LISTING_JOINS} where ${matchConditions(ctx, listingScope)}
                            limit ${MATCH_COUNT_CAP + 1}) l on true
       where r.id = any(${ids}::uuid[]) and r.status = 'active'
       group by r.id`.execute(tx);
    for (const row of rows) counts.set(row.id, Number(row.n));
    return counts;
  }

  /** Validates a complete requirement; returns the columns to store. */
  private async validate(tx: Tx, ctx: TenantContext, officeId: string | null, type: string, input: RequirementColumns): Promise<RequirementColumns> {
    const errors: FieldError[] = [];
    const currency = await tx.selectFrom('currencies').select('minorUnits').where('code', '=', input.currencyCode).where('isActive', '=', true).executeTakeFirst();
    if (!currency) errors.push({ field: 'currencyCode', code: 'unknown-code', message: 'Choose a supported currency.' });
    for (const field of ['minPrice', 'maxPrice'] as const) {
      const value = input[field];
      if (value !== null && currency && decimalPlaces(value) > currency.minorUnits) {
        errors.push({ field, code: 'precision', message: `Use at most ${currency.minorUnits} decimal places for ${input.currencyCode}.` });
      }
    }
    if (input.minPrice !== null && input.maxPrice !== null && toScaled(input.maxPrice) < toScaled(input.minPrice)) {
      errors.push({ field: 'maxPrice', code: 'range', message: 'The maximum price cannot be below the minimum.' });
    }
    if (type === 'buy' && input.rentFrequency !== null) {
      errors.push({ field: 'rentFrequency', code: 'not-applicable', message: 'A rent period applies only to rent requirements.' });
    }
    if (type === 'rent' && input.rentFrequency === null && (input.minPrice !== null || input.maxPrice !== null)) {
      errors.push({ field: 'rentFrequency', code: 'required', message: 'Say which period the rent budget is for (for example monthly).' });
    }
    if (input.minBedrooms !== null && input.maxBedrooms !== null && input.maxBedrooms < input.minBedrooms) {
      errors.push({ field: 'maxBedrooms', code: 'range', message: 'The maximum bedrooms cannot be below the minimum.' });
    }
    if (input.propertyTypeIds.length > 0) {
      // Row-level security shows platform types and the company's own types only.
      const found = await tx.selectFrom('propertyTypes').select('id').where('id', 'in', input.propertyTypeIds).where('isActive', '=', true).execute();
      if (found.length !== input.propertyTypeIds.length) {
        errors.push({ field: 'propertyTypeIds', code: 'unknown-id', message: 'Choose property types from the list.' });
      }
    }
    if (input.mustHaveFeatures.length > 0) {
      const country = await this.countryFor(tx, ctx, officeId);
      for (const [index, code] of input.mustHaveFeatures.entries()) {
        const error = await checkPicklistCode(tx, 'feature', code, country, `mustHaveFeatures[${index}]`);
        if (error) errors.push(error);
      }
    }
    if (input.moveBy !== null && !isRealDate(input.moveBy)) errors.push({ field: 'moveBy', code: 'invalid', message: 'Enter a real date.' });
    await this.checkAreas(tx, input.locations, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    return input;
  }

  private async checkAreas(tx: Tx, areas: RequirementAreaDto[], errors: FieldError[]): Promise<void> {
    if (areas.length > MAX_AREAS) errors.push({ field: 'areas', code: 'too-many', message: `Add at most ${MAX_AREAS} areas.` });
    for (const [index, area] of areas.entries()) {
      const field = (name: string) => `areas[${index}].${name}`;
      if (area.kind === 'locality') {
        if (!area.locality) errors.push({ field: field('locality'), code: 'required', message: 'Enter the area name.' });
        continue;
      }
      if (area.kind === 'radius') {
        const { latitude, longitude, radiusMetres } = area;
        if (latitude == null || longitude == null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
          errors.push({ field: field('latitude'), code: 'invalid-coordinates', message: 'Place the centre on the map.' });
        }
        if (radiusMetres == null || radiusMetres < 1 || radiusMetres > MAX_RADIUS_METRES) {
          errors.push({ field: field('radiusMetres'), code: 'range', message: `Use a radius from 1 to ${MAX_RADIUS_METRES} metres.` });
        }
        continue;
      }
      const points = area.points ?? [];
      const wellFormed = points.every(
        (point) => Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === 'number' && Number.isFinite(n)) && Math.abs(point[0]!) <= 180 && Math.abs(point[1]!) <= 90,
      );
      const corners = points.length > 0 && JSON.stringify(points[0]) === JSON.stringify(points[points.length - 1]) ? points.length - 1 : points.length;
      if (!wellFormed || corners < 3 || corners > MAX_POLYGON_POINTS) {
        errors.push({ field: field('points'), code: 'invalid-polygon', message: `Draw a shape with 3 to ${MAX_POLYGON_POINTS} points ([longitude, latitude]).` });
        continue;
      }
      const geojson = JSON.stringify({ type: 'Polygon', coordinates: [points] });
      const { rows } = await sql<{ valid: boolean; areaKm2: number }>`
        select ST_IsValid(g) as valid, ST_Area(g::geography) / 1e6 as "areaKm2"
          from (select ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326) as g) s`.execute(tx);
      if (!rows[0]!.valid) errors.push({ field: field('points'), code: 'invalid-polygon', message: 'The shape crosses itself. Redraw it.' });
      else if (rows[0]!.areaKm2 > MAX_POLYGON_AREA_KM2) {
        errors.push({ field: field('points'), code: 'area-too-large', message: `Draw a smaller shape (at most ${MAX_POLYGON_AREA_KM2} km²).` });
      }
    }
  }

  private async countryFor(tx: Tx, ctx: TenantContext, officeId: string | null): Promise<string> {
    const row = officeId
      ? await tx.selectFrom('offices').select('countryCode').where('id', '=', officeId).executeTakeFirst()
      : await tx.selectFrom('companies').select('headquartersCountryCode as countryCode').where('id', '=', ctx.companyId).executeTakeFirst();
    return row?.countryCode ?? '';
  }
}

// --------------------------------------------------------------------- helpers

/** Stored form of an area: only the fields of its kind; a polygon ring is closed. */
function toStoredArea(area: RequirementAreaInput): RequirementAreaDto {
  const label = area.label ?? null;
  switch (area.kind) {
    case 'locality':
      return { kind: 'locality', locality: area.locality ?? null, adminArea1: area.adminArea1 ?? null, label };
    case 'radius':
      return { kind: 'radius', latitude: area.latitude ?? null, longitude: area.longitude ?? null, radiusMetres: area.radiusMetres ?? null, label };
    default: {
      const points = area.points ?? [];
      const closed =
        points.length > 0 && JSON.stringify(points[0]) !== JSON.stringify(points[points.length - 1]) ? [...points, points[0]!] : points;
      return { kind: 'polygon', points: closed, label };
    }
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Amounts compared by value ("900000" equals "900000.0000"); lists by content. */
function normaliseForAudit(columns: RequirementColumns): Record<string, unknown> {
  return {
    ...columns,
    minPrice: columns.minPrice === null ? null : toScaled(columns.minPrice).toString(),
    maxPrice: columns.maxPrice === null ? null : toScaled(columns.maxPrice).toString(),
    propertyTypeIds: [...columns.propertyTypeIds].sort(),
    mustHaveFeatures: [...columns.mustHaveFeatures].sort(),
  };
}

function requirementQuery(tx: Tx) {
  return tx
    .selectFrom('requirements as r')
    .innerJoin('contacts as c', 'c.id', 'r.contactId')
    .innerJoin('currencies as cur', 'cur.code', 'r.currencyCode')
    .selectAll('r')
    .select(['c.displayName as contactName', 'cur.minorUnits']);
}

type RequirementRow = Awaited<ReturnType<ReturnType<typeof requirementQuery>['executeTakeFirstOrThrow']>>;

function toRequirementDto(row: RequirementRow, counts: Map<string, number> | null): RequirementDto {
  const money = (amount: string | null) => (amount === null ? null : toMoney(amount, row.currencyCode, row.minorUnits));
  return {
    id: row.id,
    contact: { id: row.contactId, name: row.contactName },
    requirementType: row.requirementType,
    status: row.status,
    currencyCode: row.currencyCode,
    minPrice: money(row.minPrice),
    maxPrice: money(row.maxPrice),
    rentFrequency: row.rentFrequency,
    minBedrooms: row.minBedrooms,
    maxBedrooms: row.maxBedrooms,
    propertyTypeIds: row.propertyTypeIds,
    areas: row.locations as unknown as RequirementAreaDto[],
    mustHaveFeatures: row.mustHaveFeatures,
    moveBy: row.moveBy,
    financingStatus: row.financingStatus,
    notes: row.notes,
    matchCount: counts === null ? null : row.status === 'active' ? Math.min(counts.get(row.id) ?? 0, MATCH_COUNT_CAP) : 0,
    matchCountCapped: counts !== null && row.status === 'active' && (counts.get(row.id) ?? 0) > MATCH_COUNT_CAP,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}
