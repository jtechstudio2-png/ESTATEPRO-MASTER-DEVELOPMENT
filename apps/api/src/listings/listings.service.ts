import { Injectable } from '@nestjs/common';
import { type Selectable, sql } from 'kysely';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { todayIn } from '../common/dates.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { keysetCondition, type Page, type ParsedListQuery, sortValueSql, toPage } from '../common/list-query.js';
import { decimalPlaces, type MoneyInput, toMoney, toScaled } from '../common/money.js';
import { type FieldError, ProblemError, Problems } from '../common/problem.js';
import { actingMembership, type PermissionScope, type TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import type { Listings } from '../database/schema.js';
import { isCalendarDate, nextReference } from '../properties/properties.service.js';
import { propertyScopeSql } from '../properties/property-access.js';
import { checkPicklistCode } from '../reference/picklists.js';
import type {
  AssignAgentBody,
  CreateListingBody,
  FeeTermsDto,
  FeeTermsInput,
  HistoryEntryDto,
  ListingDto,
  ListingStatus,
  ListingSummaryDto,
  PriceHistoryEntryDto,
  StatusHistoryEntryDto,
  TranslationBody,
  UpdateListingBody,
} from './dto.js';
import {
  assertListingAccess,
  canPlaceListingInOffice,
  canReassign,
  hasListingPermission,
  listingScopeSql,
} from './listing-access.js';
import {
  advanceWithinCap,
  decimalSetting,
  depositWithinCap,
  isLive,
  isTerminal,
  OPEN_STATUSES,
  reasonRequired,
  reductionExceeds,
  transitionError,
} from './listing-rules.js';
import { ListingSettingsService } from './listing-settings.service.js';

registerConstraintMessages({
  listings_one_open_per_unit_idx: 'This unit already has an open listing of this type.',
  listings_company_id_reference_key: 'This listing reference is already in use.',
});

export type ListingSortField = 'reference' | 'createdAt' | 'updatedAt' | 'price';
type ListingRow = Selectable<Listings>;

/** Commercial terms of a listing after a create or edit, validated as a whole. */
interface Terms {
  listingType: string;
  currencyCode: string;
  price: string;
  priceQualifierCode: string | null;
  rentFrequency: string | null;
  advanceRentPeriods: number | null;
  depositAmount: string | null;
  serviceChargeAmount: string | null;
  serviceChargeFrequency: string | null;
  minTermMonths: number | null;
  availableFrom: string | null;
  mandateTypeCode: string | null;
  mandateSignedOn: string | null;
  mandateExpiresOn: string | null;
  feeTerms: StoredFeeTerms | null;
}

/** Agency fee as stored in listings.fee_terms; a fixed amount is in the listing currency. */
interface StoredFeeTerms {
  basis: 'percentage' | 'fixed';
  rate?: string;
  amount?: string;
  taxInclusive: boolean;
}

interface Placement {
  officeId: string;
  jurisdictionCode: string;
  timezone: string;
  countryCode: string;
}

const RENT_ONLY_FIELDS = ['rentFrequency', 'advanceRentPeriods', 'depositAmount', 'serviceChargeAmount', 'serviceChargeFrequency', 'minTermMonths'] as const;
const MONEY_FIELDS = ['price', 'depositAmount', 'serviceChargeAmount'] as const;
/** Request/response names of the money columns. */
const API_FIELD: Record<string, string> = { price: 'price', depositAmount: 'deposit', serviceChargeAmount: 'serviceCharge' };

@Injectable()
export class ListingsService {
  constructor(
    private readonly audit: AuditService,
    private readonly settings: ListingSettingsService,
  ) {}

  // --------------------------------------------------------------------------- reads

  /**
   * Two steps so large companies stay fast (100,000 listings, p95 < 1 s):
   * the page of ids is chosen from listings alone (filters, scope, sort,
   * keyset), then details are joined for that page only.
   */
  async list(tx: Tx, ctx: TenantContext, scope: PermissionScope, query: ParsedListQuery<ListingSortField>): Promise<Page<ListingSummaryDto>> {
    const sortColumn = `l.${query.sort.field}`;
    let qb = tx
      .selectFrom('listings as l')
      .select(['l.id', sortValueSql(sortColumn, query.sort.kind).as('cursorValue')])
      .where(listingScopeSql(scope, ctx, 'l'));

    const { filters } = query;
    const archived = filters['archived'] ?? 'false';
    if (archived === 'false') qb = qb.where('l.archivedAt', 'is', null);
    if (archived === 'true') qb = qb.where('l.archivedAt', 'is not', null);
    const multi = (key: string): string[] | null => {
      const value = filters[key];
      return Array.isArray(value) ? value : null;
    };
    const listingType = multi('listingType');
    if (listingType) qb = qb.where('l.listingType', 'in', listingType);
    const status = multi('status');
    if (status) qb = qb.where('l.status', 'in', status);
    const officeIds = multi('officeId');
    if (officeIds) qb = qb.where('l.officeId', 'in', officeIds);
    const agentIds = multi('agentMembershipId');
    if (agentIds) qb = qb.where('l.agentMembershipId', 'in', agentIds);
    const unitIds = multi('unitId');
    if (unitIds) qb = qb.where('l.unitId', 'in', unitIds);
    if (typeof filters['isPublished'] === 'boolean') qb = qb.where('l.isPublished', '=', filters['isPublished']);

    const propertyIds = multi('propertyId');
    const bedrooms = filters['bedrooms'] as { gte?: string; lte?: string } | undefined;
    if (propertyIds || bedrooms) {
      qb = qb.where('l.unitId', 'in', (eb) => {
        let units = eb.selectFrom('units as u').select('u.id');
        if (propertyIds) units = units.where('u.propertyId', 'in', propertyIds);
        if (bedrooms?.gte !== undefined) units = units.where('u.bedrooms', '>=', Number(bedrooms.gte));
        if (bedrooms?.lte !== undefined) units = units.where('u.bedrooms', '<=', Number(bedrooms.lte));
        return units;
      });
    }

    const currency = multi('currencyCode');
    if (currency) qb = qb.where('l.currencyCode', 'in', currency);
    const price = filters['price'] as { gte?: string; lte?: string } | undefined;
    if (price) {
      if (!currency || currency.length !== 1) {
        throw Problems.validation([{ field: 'filter[price]', code: 'currency-required', message: 'Filter by one currency to filter by price.' }]);
      }
      if (price.gte !== undefined) qb = qb.where('l.price', '>=', price.gte);
      if (price.lte !== undefined) qb = qb.where('l.price', '<=', price.lte);
    }
    const availableFrom = filters['availableFrom'] as { gte?: string; lte?: string } | undefined;
    if (availableFrom?.gte !== undefined) qb = qb.where('l.availableFrom', '>=', availableFrom.gte);
    if (availableFrom?.lte !== undefined) qb = qb.where('l.availableFrom', '<=', availableFrom.lte);
    const mandateExpiresOn = filters['mandateExpiresOn'] as { gte?: string; lte?: string } | undefined;
    if (mandateExpiresOn?.gte !== undefined) qb = qb.where('l.mandateExpiresOn', '>=', mandateExpiresOn.gte);
    if (mandateExpiresOn?.lte !== undefined) qb = qb.where('l.mandateExpiresOn', '<=', mandateExpiresOn.lte);

    if (query.q !== null) {
      // Each branch can use its trigram index; OR across tables could not.
      const contains = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      qb = qb.where('l.id', 'in', (eb) =>
        eb
          .selectFrom('listings as s')
          .select('s.id')
          .where((w) => w.or([w('s.reference', 'ilike', contains), w('s.title', 'ilike', contains)]))
          .union(eb.selectFrom('listingTranslations as lt').select('lt.listingId as id').where('lt.title', 'ilike', contains)),
      );
    }
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'l.id', query.sort, query.cursor));

    const ids = await qb
      .orderBy(sql.ref(sortColumn), query.sort.direction)
      .orderBy('l.id', query.sort.direction)
      .limit(query.limit + 1)
      .execute();
    if (ids.length === 0) return { data: [], page: { limit: query.limit, nextCursor: null } };

    const details = await this.summaryQuery(tx)
      .where('l.id', 'in', ids.map((row) => row.id))
      .execute();
    const byId = new Map(details.map((row) => [row.id, row]));
    const rows = ids.map((row) => ({ ...byId.get(row.id)!, cursorValue: row.cursorValue }));
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => toSummaryDto(row));
  }

  /** Property and unit sub-lists: the parent must be visible to the caller. */
  async assertPropertyVisible(tx: Tx, ctx: TenantContext, target: { propertyId: string } | { unitId: string }): Promise<void> {
    const view = ctx.permissions.get('property.view');
    if (!view) throw Problems.notFound();
    let qb = tx.selectFrom('properties as p').select('p.id').where(propertyScopeSql(view.scope, ctx, 'p'));
    qb = 'propertyId' in target
      ? qb.where('p.id', '=', target.propertyId)
      : qb.where('p.id', '=', (eb) => eb.selectFrom('units').select('propertyId').where('id', '=', target.unitId));
    if (!(await qb.executeTakeFirst())) throw Problems.notFound();
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<ListingDto> {
    const row = await this.summaryQuery(tx).selectAll('l').where('l.id', '=', id).executeTakeFirst();
    if (!row || !hasListingPermission(ctx, row, 'listing.view')) throw Problems.notFound();
    const translations = await tx
      .selectFrom('listingTranslations')
      .select(['localeCode', 'title', 'description', 'source', 'updatedAt'])
      .where('listingId', '=', id)
      .orderBy('localeCode')
      .execute();
    const money = (amount: string | null) => (amount === null ? null : toMoney(amount, row.currencyCode, row.minorUnits));
    return {
      ...toSummaryDto(row),
      priceQualifierCode: row.priceQualifierCode,
      advanceRentPeriods: row.advanceRentPeriods,
      deposit: money(row.depositAmount),
      serviceCharge: money(row.serviceChargeAmount),
      serviceChargeFrequency: row.serviceChargeFrequency,
      minTermMonths: row.minTermMonths,
      availableFrom: row.availableFrom,
      mandateTypeCode: row.mandateTypeCode,
      mandateSignedOn: row.mandateSignedOn,
      mandateExpiresOn: row.mandateExpiresOn,
      // Agency fee terms are commercial: only staff who may edit the listing see them.
      feeTerms: hasListingPermission(ctx, row, 'listing.update') ? feeTermsDto(storedFeeTerms(row.feeTerms), row.currencyCode, row.minorUnits) : null,
      defaultLocaleCode: row.defaultLocaleCode,
      description: row.description,
      translations: translations.map((t) => ({ ...t, updatedAt: t.updatedAt.toISOString() })),
      media: await this.mediaSummary(tx, id),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  async statusHistory(tx: Tx, ctx: TenantContext, id: string, query: ParsedListQuery<'changedAt'>): Promise<Page<StatusHistoryEntryDto>> {
    await this.assertVisible(tx, ctx, id);
    let qb = tx
      .selectFrom('listingStatusHistory as h')
      .select(['h.id', 'h.fromStatus', 'h.toStatus', 'h.changedAt', 'h.changedBy', 'h.reason'])
      .select(sortValueSql('h.changedAt', 'timestamp').as('cursorValue'))
      .where('h.listingId', '=', id);
    if (query.cursor) qb = qb.where(keysetCondition('h.changedAt', 'h.id', query.sort, query.cursor));
    const rows = await qb.orderBy('h.changedAt', query.sort.direction).orderBy('h.id', query.sort.direction).limit(query.limit + 1).execute();
    return toPage(rows, query.limit, (r) => r.cursorValue, (r) => r.id, (r) => ({
      id: r.id,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      changedAt: r.changedAt.toISOString(),
      changedByMembershipId: r.changedBy,
      reason: r.reason,
    }));
  }

  async priceHistory(tx: Tx, ctx: TenantContext, id: string, query: ParsedListQuery<'changedAt'>): Promise<Page<PriceHistoryEntryDto>> {
    await this.assertVisible(tx, ctx, id);
    let qb = tx
      .selectFrom('listingPriceHistory as h')
      .innerJoin('currencies as cur', 'cur.code', 'h.currencyCode')
      .select(['h.id', 'h.oldPrice', 'h.newPrice', 'h.currencyCode', 'cur.minorUnits', 'h.changedAt', 'h.changedBy', 'h.approvedBy', 'h.reason'])
      .select(sortValueSql('h.changedAt', 'timestamp').as('cursorValue'))
      .where('h.listingId', '=', id);
    if (query.cursor) qb = qb.where(keysetCondition('h.changedAt', 'h.id', query.sort, query.cursor));
    const rows = await qb.orderBy('h.changedAt', query.sort.direction).orderBy('h.id', query.sort.direction).limit(query.limit + 1).execute();
    return toPage(rows, query.limit, (r) => r.cursorValue, (r) => r.id, (r) => ({
      id: r.id,
      oldPrice: r.oldPrice === null ? null : toMoney(r.oldPrice, r.currencyCode, r.minorUnits),
      newPrice: toMoney(r.newPrice, r.currencyCode, r.minorUnits),
      changedAt: r.changedAt.toISOString(),
      changedByMembershipId: r.changedBy,
      approvedByMembershipId: r.approvedBy,
      reason: r.reason,
    }));
  }

  /** The listing's own audit trail (version history), newest first. */
  async history(tx: Tx, ctx: TenantContext, id: string, query: ParsedListQuery<'occurredAt'>): Promise<Page<HistoryEntryDto>> {
    const listing = await this.assertVisible(tx, ctx, id);
    const showFees = hasListingPermission(ctx, listing, 'listing.update');
    let qb = tx
      .selectFrom('auditLogs as a')
      .leftJoin('companyMemberships as m', 'm.id', 'a.actorMembershipId')
      .leftJoin('users as us', 'us.id', 'm.userId')
      .select(['a.id', 'a.occurredAt', 'a.action', 'a.actorMembershipId', 'us.displayName', 'a.changes', 'a.metadata'])
      .select(sortValueSql('a.occurredAt', 'timestamp').as('cursorValue'))
      .where('a.entityType', '=', 'listing')
      .where('a.entityId', '=', id);
    if (query.cursor) qb = qb.where(keysetCondition('a.occurredAt', 'a.id', query.sort, query.cursor));
    const rows = await qb.orderBy('a.occurredAt', query.sort.direction).orderBy('a.id', query.sort.direction).limit(query.limit + 1).execute();
    return toPage(rows, query.limit, (r) => r.cursorValue, (r) => r.id, (r) => {
      const changes = (r.changes ?? null) as Record<string, unknown> | null;
      if (changes && !showFees && 'feeTerms' in changes) changes['feeTerms'] = { old: '(hidden)', new: '(hidden)' };
      return {
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        action: r.action,
        actorMembershipId: r.actorMembershipId,
        actorName: r.displayName,
        changes,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
      };
    });
  }

  // --------------------------------------------------------------------------- create, relist

  async create(tx: Tx, ctx: TenantContext, scope: PermissionScope, body: CreateListingBody): Promise<ListingDto> {
    const unit = await this.loadUnitForListing(tx, ctx, body.unitId);
    const officeId = body.officeId ?? unit.propertyOfficeId;
    const office = await this.loadOffice(tx, officeId);
    if (!office) throw Problems.validation([{ field: 'officeId', code: 'not-found', message: 'This office does not exist or is archived.' }]);
    if (!canPlaceListingInOffice(ctx, scope, office.id)) throw Problems.forbidden('You can only create listings in your own offices.');

    const agentMembershipId = body.agentMembershipId ?? ctx.membershipId;
    if (scope === 'own' && agentMembershipId !== ctx.membershipId) {
      throw Problems.forbidden('You can only create listings assigned to yourself.');
    }

    const terms: Terms = {
      listingType: body.listingType,
      currencyCode: body.price.currency,
      price: body.price.amount,
      priceQualifierCode: body.priceQualifierCode ?? null,
      rentFrequency: body.rentFrequency ?? null,
      advanceRentPeriods: body.advanceRentPeriods ?? null,
      depositAmount: body.deposit?.amount ?? null,
      serviceChargeAmount: body.serviceCharge?.amount ?? null,
      serviceChargeFrequency: body.serviceChargeFrequency ?? null,
      minTermMonths: body.minTermMonths ?? null,
      availableFrom: body.availableFrom ?? null,
      mandateTypeCode: body.mandateTypeCode ?? null,
      mandateSignedOn: body.mandateSignedOn ?? null,
      mandateExpiresOn: body.mandateExpiresOn ?? null,
      feeTerms: normaliseFeeTerms(body.feeTerms ?? null),
    };
    const placement: Placement = { officeId: office.id, jurisdictionCode: unit.jurisdictionCode, timezone: unit.timezone, countryCode: unit.countryCode };
    const errors = currencyMismatches(terms.currencyCode, { deposit: body.deposit, serviceCharge: body.serviceCharge, 'feeTerms.amount': body.feeTerms?.amount });
    errors.push(...(await this.checkTerms(tx, terms, placement, new Set(Object.keys(terms)))));
    const localeCode = body.defaultLocaleCode ?? office.localeCode;
    if (!(await this.localeActive(tx, localeCode))) {
      errors.push({ field: 'defaultLocaleCode', code: 'unsupported', message: 'This language is not supported.' });
    }
    const agentError = await this.agentError(tx, agentMembershipId, office.id);
    if (agentError) errors.push(agentError);
    if (errors.length > 0) throw Problems.validation(errors);

    return this.insertListing(tx, ctx, {
      unitId: unit.id,
      terms,
      officeId: office.id,
      agentMembershipId,
      defaultLocaleCode: localeCode,
      title: body.title,
      description: body.description ?? null,
    });
  }

  async relist(tx: Tx, ctx: TenantContext, scope: PermissionScope, sourceId: string, requestedAgent: string | undefined): Promise<ListingDto> {
    const source = await tx.selectFrom('listings').selectAll().where('id', '=', sourceId).executeTakeFirst();
    if (!source || !hasListingPermission(ctx, source, 'listing.view')) throw Problems.notFound();
    if (!isTerminal(source.status)) throw Problems.businessRule('Only closed listings (sold, rented, withdrawn or expired) can be relisted.');
    if (!canPlaceListingInOffice(ctx, scope, source.officeId)) throw Problems.forbidden('You can only create listings in your own offices.');

    const agentMembershipId = scope === 'own' ? ctx.membershipId : (requestedAgent ?? source.agentMembershipId);
    if (scope === 'own' && requestedAgent !== undefined && requestedAgent !== ctx.membershipId) {
      throw Problems.forbidden('You can only create listings assigned to yourself.');
    }
    const unit = await this.loadUnitForListing(tx, ctx, source.unitId);
    const office = await this.loadOffice(tx, source.officeId);
    if (!office) throw Problems.businessRule('The listing’s office is archived. Create a new listing in an active office instead.');

    const terms: Terms = {
      listingType: source.listingType,
      currencyCode: source.currencyCode,
      price: source.price,
      priceQualifierCode: source.priceQualifierCode,
      rentFrequency: source.rentFrequency,
      advanceRentPeriods: source.advanceRentPeriods,
      depositAmount: source.depositAmount,
      serviceChargeAmount: source.serviceChargeAmount,
      serviceChargeFrequency: source.serviceChargeFrequency,
      minTermMonths: source.minTermMonths,
      // A new campaign needs its own dates and mandate.
      availableFrom: null,
      mandateTypeCode: source.mandateTypeCode,
      mandateSignedOn: null,
      mandateExpiresOn: null,
      feeTerms: storedFeeTerms(source.feeTerms),
    };
    const placement: Placement = { officeId: office.id, jurisdictionCode: unit.jurisdictionCode, timezone: unit.timezone, countryCode: unit.countryCode };
    const errors = await this.checkTerms(tx, terms, placement, new Set(Object.keys(terms)));
    const agentError = await this.agentError(tx, agentMembershipId, office.id);
    if (agentError) errors.push(agentError);
    if (errors.length > 0) throw Problems.validation(errors);

    const created = await this.insertListing(tx, ctx, {
      unitId: source.unitId,
      terms,
      officeId: office.id,
      agentMembershipId,
      defaultLocaleCode: source.defaultLocaleCode,
      title: source.title,
      description: source.description,
      relistedFrom: { id: source.id, reference: source.reference },
    });
    const translations = await tx.selectFrom('listingTranslations').selectAll().where('listingId', '=', source.id).execute();
    if (translations.length > 0) {
      await tx
        .insertInto('listingTranslations')
        .values(translations.map((t) => ({
          companyId: ctx.companyId,
          listingId: created.id,
          localeCode: t.localeCode,
          title: t.title,
          description: t.description,
          source: t.source,
          approvedBy: t.approvedBy,
          approvedAt: t.approvedAt,
        })))
        .execute();
    }
    // The new campaign starts with the same gallery (ADR-005 M-D5), minus archived media.
    const gallery = await tx
      .selectFrom('listingMedia as lm')
      .innerJoin('propertyMedia as m', 'm.id', 'lm.mediaId')
      .select(['lm.mediaId', 'lm.sortOrder', 'lm.isCover'])
      .where('lm.listingId', '=', source.id)
      .where('m.archivedAt', 'is', null)
      .where('m.processingStatus', '=', 'ready')
      .orderBy('lm.sortOrder')
      .execute();
    if (gallery.length > 0) {
      await tx
        .insertInto('listingMedia')
        .values(gallery.map((item) => ({ companyId: ctx.companyId, listingId: created.id, mediaId: item.mediaId, sortOrder: item.sortOrder, isCover: item.isCover, addedBy: actingMembership(ctx) })))
        .execute();
    }
    await this.audit.record(tx, ctx, {
      action: 'listing.relisted',
      entityType: 'listing',
      entityId: source.id,
      metadata: { newListingId: created.id, newReference: created.reference },
    });
    return this.get(tx, ctx, created.id);
  }

  // --------------------------------------------------------------------------- edit

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateListingBody): Promise<ListingDto> {
    const current = await this.lockListing(tx, id);
    assertListingAccess(ctx, current, 'listing.update');
    assertEditable(current);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();

    const errors: FieldError[] = [];
    for (const field of ['price', 'title', 'officeId'] as const) {
      if (body[field] === null) errors.push({ field, code: 'required', message: 'This field cannot be cleared.' });
    }
    if (body.rentFrequency === null && current.listingType === 'rent') {
      errors.push({ field: 'rentFrequency', code: 'required', message: 'Rentals need a rent frequency.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);

    const provided = (key: keyof UpdateListingBody) => body[key] !== undefined;
    const touched = new Set(
      Object.keys(body)
        .filter((key) => provided(key as keyof UpdateListingBody))
        .map((key) => (key === 'deposit' ? 'depositAmount' : key === 'serviceCharge' ? 'serviceChargeAmount' : key)),
    );
    const currencyCode = body.price?.currency ?? current.currencyCode;
    if (currencyCode !== current.currencyCode) {
      if (current.status !== 'draft') throw Problems.businessRule('The currency can only be changed while the listing is a draft.');
      // Amounts already entered are in the old currency: they must be re-entered.
      for (const [field, column, stored] of [
        ['deposit', 'deposit', current.depositAmount],
        ['serviceCharge', 'serviceCharge', current.serviceChargeAmount],
      ] as const) {
        if (stored !== null && !provided(column)) errors.push({ field, code: 'currency-mismatch', message: 'Re-enter this amount in the new currency.' });
      }
      const fee = storedFeeTerms(current.feeTerms);
      if (fee?.amount !== undefined && !provided('feeTerms')) {
        errors.push({ field: 'feeTerms', code: 'currency-mismatch', message: 'Re-enter the fee in the new currency.' });
      }
    }
    errors.push(...currencyMismatches(currencyCode, { deposit: body.deposit, serviceCharge: body.serviceCharge, 'feeTerms.amount': body.feeTerms?.amount }));

    let officeId = current.officeId;
    if (body.officeId !== undefined && body.officeId !== current.officeId) {
      const office = await this.loadOffice(tx, body.officeId);
      const scope = ctx.permissions.get('listing.update')!.scope;
      if (!office) throw Problems.validation([{ field: 'officeId', code: 'not-found', message: 'This office does not exist or is archived.' }]);
      if (!canPlaceListingInOffice(ctx, scope, office.id)) throw Problems.forbidden('You can only move listings to your own offices.');
      officeId = office.id;
      const agentError = await this.agentError(tx, current.agentMembershipId, officeId);
      if (agentError) throw Problems.validation([{ ...agentError, field: 'officeId', message: 'The listing’s agent does not work in that office. Reassign the listing first.' }]);
    }

    const pick = <K extends keyof Terms>(key: K, currentValue: Terms[K]): Terms[K] =>
      (body as Record<string, unknown>)[key] !== undefined ? ((body as Record<string, unknown>)[key] as Terms[K]) : currentValue;
    const amount = (input: MoneyInput | null | undefined, stored: string | null) => (input === undefined ? stored : (input?.amount ?? null));
    const terms: Terms = {
      listingType: current.listingType,
      currencyCode,
      price: body.price?.amount ?? current.price,
      priceQualifierCode: pick('priceQualifierCode', current.priceQualifierCode),
      rentFrequency: pick('rentFrequency', current.rentFrequency),
      advanceRentPeriods: pick('advanceRentPeriods', current.advanceRentPeriods),
      depositAmount: amount(body.deposit, current.depositAmount),
      serviceChargeAmount: amount(body.serviceCharge, current.serviceChargeAmount),
      serviceChargeFrequency: pick('serviceChargeFrequency', current.serviceChargeFrequency),
      minTermMonths: pick('minTermMonths', current.minTermMonths),
      availableFrom: pick('availableFrom', current.availableFrom),
      mandateTypeCode: pick('mandateTypeCode', current.mandateTypeCode),
      mandateSignedOn: pick('mandateSignedOn', current.mandateSignedOn),
      mandateExpiresOn: pick('mandateExpiresOn', current.mandateExpiresOn),
      feeTerms: body.feeTerms !== undefined ? normaliseFeeTerms(body.feeTerms) : storedFeeTerms(current.feeTerms),
    };
    const unit = await this.placementOf(tx, current.unitId);
    errors.push(...(await this.checkTerms(tx, terms, { ...unit, officeId }, touched)));
    if (errors.length > 0) throw Problems.validation(errors);

    // Significant price reductions on live listings need approval (decision D2).
    const currencyChanged = terms.currencyCode !== current.currencyCode;
    const priceChanged = toScaled(terms.price) !== toScaled(current.price) || currencyChanged;
    const reduced = terms.currencyCode === current.currencyCode && toScaled(terms.price) < toScaled(current.price);
    let approvedBy: string | null = null;
    if (reduced && isLive(current.status)) {
      if (body.priceChangeReason === undefined) {
        throw Problems.validation([{ field: 'priceChangeReason', code: 'required', message: 'Give a reason for reducing the price of a live listing.' }]);
      }
      const { priceReductionApprovalPercent } = await this.settings.get(tx);
      if (priceReductionApprovalPercent !== null && reductionExceeds(current.price, terms.price, priceReductionApprovalPercent)) {
        if (!hasListingPermission(ctx, current, 'listing.approve_price')) {
          throw new ProblemError(
            403,
            'approval-required',
            'Approval required',
            `Reductions of more than ${priceReductionApprovalPercent}% need a manager’s approval. Ask a manager to make this change.`,
          );
        }
        approvedBy = ctx.membershipId;
      }
    }

    const patch: Record<string, unknown> = {};
    const set = (key: string, next: unknown, before: unknown, equal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) => {
      if (!equal(next, before)) patch[key] = next;
    };
    const sameMoney = (a: unknown, b: unknown) =>
      typeof a === 'string' && typeof b === 'string' ? toScaled(a) === toScaled(b) : (a ?? null) === (b ?? null);
    set('officeId', officeId, current.officeId);
    set('currencyCode', terms.currencyCode, current.currencyCode);
    for (const key of MONEY_FIELDS) set(key, terms[key], current[key], sameMoney);
    for (const key of ['priceQualifierCode', 'rentFrequency', 'advanceRentPeriods', 'serviceChargeFrequency', 'minTermMonths', 'availableFrom', 'mandateTypeCode', 'mandateSignedOn', 'mandateExpiresOn'] as const) {
      set(key, terms[key], current[key]);
    }
    set('feeTerms', terms.feeTerms ?? {}, current.feeTerms ?? {}, (a, b) => canonicalJson(a) === canonicalJson(b));
    if (body.title !== undefined) set('title', body.title, current.title);
    if (body.description !== undefined) set('description', body.description, current.description);
    if (Object.keys(patch).length === 0) return this.get(tx, ctx, id);
    if ('feeTerms' in patch) patch['feeTerms'] = JSON.stringify(patch['feeTerms']);

    const updated = await tx.updateTable('listings').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    if (priceChanged) {
      await tx
        .insertInto('listingPriceHistory')
        .values({
          companyId: ctx.companyId,
          listingId: id,
          // The history row has one currency: after a currency change the old price is not comparable.
          oldPrice: currencyChanged ? null : current.price,
          newPrice: updated.price,
          currencyCode: updated.currencyCode,
          changedBy: ctx.membershipId,
          approvedBy,
          reason: body.priceChangeReason ?? (currencyChanged ? `Currency changed from ${current.currencyCode} to ${updated.currencyCode}` : null),
        })
        .execute();
    }
    await this.audit.record(tx, ctx, {
      action: 'listing.updated',
      entityType: 'listing',
      entityId: id,
      changes: diffForAudit(current, updated),
      metadata: approvedBy ? { priceReductionApprovedBy: approvedBy } : {},
    });
    await this.audit.emit(tx, ctx, {
      eventType: priceChanged ? 'listing.price_changed' : 'listing.updated',
      aggregateType: 'listing',
      aggregateId: id,
      payload: { listingId: id, ...(priceChanged ? { oldPrice: current.price, newPrice: updated.price, currencyCode: updated.currencyCode } : {}) },
    });
    return this.get(tx, ctx, id);
  }

  // --------------------------------------------------------------------------- publishing and status

  async publish(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<ListingDto> {
    const current = await this.lockListing(tx, id);
    assertListingAccess(ctx, current, 'listing.publish');
    if (current.archivedAt !== null) throw Problems.businessRule('Archived listings cannot be published.');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.isPublished) throw Problems.businessRule('This listing is already published.');
    if (current.status !== 'draft' && !isLive(current.status)) {
      throw Problems.businessRule('Closed listings cannot be published. Relist the unit to market it again.');
    }

    const blockers = await this.publishBlockers(tx, current);
    if (blockers.length > 0) {
      throw new ProblemError(422, 'publish-blocked', 'Listing cannot be published', 'Resolve the items below, then publish again.', { errors: blockers });
    }

    const now = new Date();
    const fromDraft = current.status === 'draft';
    await tx
      .updateTable('listings')
      .set({ status: fromDraft ? 'available' : current.status, isPublished: true, publishedAt: now, listedAt: current.listedAt ?? now })
      .where('id', '=', id)
      .execute();
    if (fromDraft) await this.recordStatus(tx, ctx, id, 'draft', 'available', null);
    await this.audit.record(tx, ctx, { action: 'listing.published', entityType: 'listing', entityId: id, metadata: { status: fromDraft ? 'available' : current.status } });
    await this.audit.emit(tx, ctx, { eventType: 'listing.publication_changed', aggregateType: 'listing', aggregateId: id, payload: { listingId: id, isPublished: true } });
    return this.get(tx, ctx, id);
  }

  async unpublish(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<ListingDto> {
    const current = await this.lockListing(tx, id);
    assertListingAccess(ctx, current, 'listing.publish');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (!current.isPublished) throw Problems.businessRule('This listing is not published.');
    await tx.updateTable('listings').set({ isPublished: false }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'listing.unpublished', entityType: 'listing', entityId: id });
    await this.audit.emit(tx, ctx, { eventType: 'listing.publication_changed', aggregateType: 'listing', aggregateId: id, payload: { listingId: id, isPublished: false } });
    return this.get(tx, ctx, id);
  }

  async changeStatus(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, to: ListingStatus, reason: string | undefined): Promise<ListingDto> {
    const current = await this.lockListing(tx, id);
    assertListingAccess(ctx, current, 'listing.publish');
    if (current.archivedAt !== null) throw Problems.businessRule('Archived listings cannot change status.');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    const from = current.status as ListingStatus;

    const invalid = transitionError(current.listingType, from, to);
    if (invalid) throw Problems.businessRule(invalid);
    if (reasonRequired(from, to) && reason === undefined) {
      throw Problems.validation([{ field: 'reason', code: 'required', message: 'Give a reason for this change.' }]);
    }

    const unit = await tx
      .selectFrom('units as u')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .select(['u.availability', 'p.timezone'])
      .where('u.id', '=', current.unitId)
      .executeTakeFirstOrThrow();
    if (to === 'expired' && (current.mandateExpiresOn === null || current.mandateExpiresOn >= todayIn(unit.timezone))) {
      throw Problems.businessRule('A listing expires only after its mandate has ended.');
    }
    // "Under maintenance" blocks new lettings (Phase 1 PRP-05).
    if (current.listingType === 'rent' && unit.availability === 'under_maintenance' && ['reserved', 'under_contract', 'rented'].includes(to)) {
      throw Problems.businessRule('The unit is under maintenance. New lettings are blocked until it is available again.');
    }

    const closing = isTerminal(to);
    await tx
      .updateTable('listings')
      .set({ status: to, ...(closing ? { isPublished: false, closedAt: new Date() } : {}) })
      .where('id', '=', id)
      .execute();
    await this.recordStatus(tx, ctx, id, from, to, reason ?? null);
    return this.get(tx, ctx, id);
  }

  async assign(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: AssignAgentBody): Promise<ListingDto> {
    const current = await this.lockListing(tx, id);
    if (!hasListingPermission(ctx, current, 'listing.view')) throw Problems.notFound();
    if (!canReassign(ctx, current)) throw Problems.forbidden('Only managers and administrators can reassign listings.');
    assertEditable(current);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (body.agentMembershipId === current.agentMembershipId) return this.get(tx, ctx, id);
    const agentError = await this.agentError(tx, body.agentMembershipId, current.officeId);
    if (agentError) throw Problems.validation([agentError]);

    await tx.updateTable('listings').set({ agentMembershipId: body.agentMembershipId }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, {
      action: 'listing.agent_assigned',
      entityType: 'listing',
      entityId: id,
      changes: { agentMembershipId: { old: current.agentMembershipId, new: body.agentMembershipId } },
      metadata: body.reason ? { reason: body.reason } : {},
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'listing.agent_assigned',
      aggregateType: 'listing',
      aggregateId: id,
      payload: { listingId: id, fromMembershipId: current.agentMembershipId, toMembershipId: body.agentMembershipId },
    });
    return this.get(tx, ctx, id);
  }

  // --------------------------------------------------------------------------- archive

  async archive(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<ListingDto> {
    const current = await this.lockListing(tx, id);
    assertListingAccess(ctx, current, 'listing.archive');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt !== null) throw Problems.businessRule('This listing is already archived.');
    if (isLive(current.status)) throw Problems.businessRule('Live listings cannot be archived. Withdraw the listing first.');
    await tx.updateTable('listings').set({ archivedAt: new Date() }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'listing.archived', entityType: 'listing', entityId: id, metadata: { reason } });
    await this.audit.emit(tx, ctx, { eventType: 'listing.archived', aggregateType: 'listing', aggregateId: id, payload: { listingId: id, reason } });
    return this.get(tx, ctx, id);
  }

  async restore(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<ListingDto> {
    const current = await this.lockListing(tx, id);
    assertListingAccess(ctx, current, 'listing.archive');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt === null) throw Problems.businessRule('This listing is not archived.');
    const unit = await tx
      .selectFrom('units as u')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .select(['u.archivedAt as unitArchivedAt', 'p.archivedAt as propertyArchivedAt'])
      .where('u.id', '=', current.unitId)
      .executeTakeFirstOrThrow();
    if (unit.unitArchivedAt !== null || unit.propertyArchivedAt !== null) {
      throw Problems.businessRule('Restore the unit and property before restoring this listing.');
    }
    if (current.status === 'draft') await this.assertNoOpenListing(tx, current.unitId, current.listingType);
    await tx.updateTable('listings').set({ archivedAt: null }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'listing.restored', entityType: 'listing', entityId: id });
    await this.audit.emit(tx, ctx, { eventType: 'listing.restored', aggregateType: 'listing', aggregateId: id, payload: { listingId: id } });
    return this.get(tx, ctx, id);
  }

  // --------------------------------------------------------------------------- translations

  async saveTranslation(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, localeCode: string, body: TranslationBody): Promise<ListingDto> {
    const current = await this.lockListing(tx, id);
    assertListingAccess(ctx, current, 'listing.update');
    assertEditable(current);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (localeCode === current.defaultLocaleCode) {
      throw Problems.businessRule('This is the listing’s default language. Edit the title and description on the listing itself.');
    }
    if (!(await this.localeActive(tx, localeCode))) throw Problems.notFound('This language is not supported.');

    const before = await tx
      .selectFrom('listingTranslations')
      .select(['title', 'description', 'source'])
      .where('listingId', '=', id)
      .where('localeCode', '=', localeCode)
      .executeTakeFirst();
    const description = body.description ?? null;
    if (before && before.title === body.title && before.description === description && before.source === 'manual') return this.get(tx, ctx, id);

    await tx
      .insertInto('listingTranslations')
      .values({ companyId: ctx.companyId, listingId: id, localeCode, title: body.title, description, source: 'manual' })
      .onConflict((oc) =>
        oc.columns(['companyId', 'listingId', 'localeCode']).doUpdateSet({
          title: body.title,
          description,
          source: 'manual',
          approvedBy: null,
          approvedAt: null,
          updatedAt: sql<Date>`now()`,
        }),
      )
      .execute();
    // Translations are part of the listing: its version (ETag) changes too.
    await tx.updateTable('listings').set({ updatedAt: sql<Date>`now()` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, {
      action: 'listing.translation_saved',
      entityType: 'listing',
      entityId: id,
      changes: diffForAudit(before ?? {}, { title: body.title, description, source: 'manual' }),
      metadata: { localeCode },
    });
    await this.audit.emit(tx, ctx, { eventType: 'listing.updated', aggregateType: 'listing', aggregateId: id, payload: { listingId: id, localeCode } });
    return this.get(tx, ctx, id);
  }

  async removeTranslation(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, localeCode: string): Promise<ListingDto> {
    const current = await this.lockListing(tx, id);
    assertListingAccess(ctx, current, 'listing.update');
    assertEditable(current);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    const removed = await tx
      .deleteFrom('listingTranslations')
      .where('listingId', '=', id)
      .where('localeCode', '=', localeCode)
      .returning(['title', 'description'])
      .executeTakeFirst();
    if (!removed) throw Problems.notFound('This listing has no translation in that language.');
    await tx.updateTable('listings').set({ updatedAt: sql<Date>`now()` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, {
      action: 'listing.translation_removed',
      entityType: 'listing',
      entityId: id,
      changes: diffForAudit(removed, { title: null, description: null }),
      metadata: { localeCode },
    });
    await this.audit.emit(tx, ctx, { eventType: 'listing.updated', aggregateType: 'listing', aggregateId: id, payload: { listingId: id, localeCode } });
    return this.get(tx, ctx, id);
  }

  // --------------------------------------------------------------------------- background (worker)

  /**
   * Expires live listings whose mandate ended before today in the property's
   * time zone (D3: terminal, unpublished). Runs as the system; idempotent.
   */
  async expireDue(tx: Tx, ctx: TenantContext): Promise<string[]> {
    const due = await tx
      .selectFrom('listings as l')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .select(['l.id', 'l.status', 'l.mandateExpiresOn', 'p.timezone'])
      .where('l.status', 'in', ['available', 'reserved', 'under_contract'])
      .where('l.archivedAt', 'is', null)
      .where('l.mandateExpiresOn', 'is not', null)
      // Coarse filter; the exact local-date comparison is below.
      .where('l.mandateExpiresOn', '<', sql<string>`(now() at time zone 'UTC')::date + 1`)
      .orderBy('l.id')
      .forUpdate('l')
      .execute();
    const expired: string[] = [];
    for (const listing of due) {
      if (listing.mandateExpiresOn! >= todayIn(listing.timezone)) continue;
      await tx.updateTable('listings').set({ status: 'expired', isPublished: false, closedAt: new Date() }).where('id', '=', listing.id).execute();
      await this.recordStatus(tx, ctx, listing.id, listing.status as ListingStatus, 'expired', 'Mandate expired');
      expired.push(listing.id);
    }
    return expired;
  }

  // --------------------------------------------------------------------------- helpers

  private async mediaSummary(tx: Tx, listingId: string) {
    const row = await tx
      .selectFrom('listingMedia as lm')
      .innerJoin('propertyMedia as m', 'm.id', 'lm.mediaId')
      .select([
        sql<number>`count(*) filter (where m.media_type = 'photo')::int`.as('photoCount'),
        sql<number>`count(*) filter (where m.media_type = 'floor_plan')::int`.as('floorPlanCount'),
        sql<string | null>`(array_agg(lm.media_id) filter (where lm.is_cover))[1]`.as('coverMediaId'),
      ])
      .where('lm.listingId', '=', listingId)
      .where('m.archivedAt', 'is', null)
      .executeTakeFirstOrThrow();
    return { photoCount: row.photoCount, floorPlanCount: row.floorPlanCount, coverMediaId: row.coverMediaId };
  }

  private async insertListing(
    tx: Tx,
    ctx: TenantContext,
    input: {
      unitId: string;
      terms: Terms;
      officeId: string;
      agentMembershipId: string;
      defaultLocaleCode: string;
      title: string;
      description: string | null;
      relistedFrom?: { id: string; reference: string };
    },
  ): Promise<ListingDto> {
    await this.assertNoOpenListing(tx, input.unitId, input.terms.listingType);
    const reference = await nextReference(tx, ctx, 'listing');
    const { feeTerms, ...terms } = input.terms;
    const inserted = await tx
      .insertInto('listings')
      .values({
        companyId: ctx.companyId,
        reference,
        unitId: input.unitId,
        ...terms,
        feeTerms: JSON.stringify(feeTerms ?? {}),
        agentMembershipId: input.agentMembershipId,
        officeId: input.officeId,
        defaultLocaleCode: input.defaultLocaleCode,
        title: input.title,
        description: input.description,
        createdBy: ctx.membershipId,
      })
      .returning(['id', 'price', 'currencyCode'])
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('listingPriceHistory')
      .values({ companyId: ctx.companyId, listingId: inserted.id, oldPrice: null, newPrice: inserted.price, currencyCode: inserted.currencyCode, changedBy: ctx.membershipId })
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'listing.created',
      entityType: 'listing',
      entityId: inserted.id,
      metadata: { reference, listingType: input.terms.listingType, unitId: input.unitId, ...(input.relistedFrom ? { relistedFrom: input.relistedFrom } : {}) },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'listing.created',
      aggregateType: 'listing',
      aggregateId: inserted.id,
      payload: { listingId: inserted.id, reference, unitId: input.unitId, listingType: input.terms.listingType },
    });
    await this.recordStatus(tx, ctx, inserted.id, null, 'draft', null);
    return this.get(tx, ctx, inserted.id);
  }

  private async recordStatus(tx: Tx, ctx: TenantContext, id: string, from: ListingStatus | null, to: ListingStatus, reason: string | null): Promise<void> {
    await tx
      .insertInto('listingStatusHistory')
      .values({ companyId: ctx.companyId, listingId: id, fromStatus: from, toStatus: to, changedBy: actingMembership(ctx), reason })
      .execute();
    if (from !== null) {
      await this.audit.record(tx, ctx, {
        action: 'listing.status_changed',
        entityType: 'listing',
        entityId: id,
        changes: { status: { old: from, new: to } },
        metadata: reason ? { reason } : {},
      });
    }
    await this.audit.emit(tx, ctx, { eventType: 'listing.status_changed', aggregateType: 'listing', aggregateId: id, payload: { listingId: id, from, to, reason } });
  }

  private async lockListing(tx: Tx, id: string): Promise<ListingRow> {
    const row = await tx.selectFrom('listings').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw Problems.notFound();
    return row;
  }

  private async assertVisible(tx: Tx, ctx: TenantContext, id: string) {
    const row = await tx.selectFrom('listings').select(['officeId', 'agentMembershipId']).where('id', '=', id).executeTakeFirst();
    if (!row || !hasListingPermission(ctx, row, 'listing.view')) throw Problems.notFound();
    return row;
  }

  private async assertNoOpenListing(tx: Tx, unitId: string, listingType: string): Promise<void> {
    const open = await tx
      .selectFrom('listings')
      .select(['id', 'reference'])
      .where('unitId', '=', unitId)
      .where('listingType', '=', listingType)
      .where('status', 'in', [...OPEN_STATUSES])
      .where('archivedAt', 'is', null)
      .executeTakeFirst();
    if (open) {
      throw Problems.conflict(`This unit already has an open ${listingType === 'sale' ? 'sales' : 'rental'} listing (${open.reference}).`, {
        type: 'listing',
        id: open.id,
      });
    }
  }

  /** The unit a new listing is for: it must exist, be visible through the property and be active. */
  private async loadUnitForListing(tx: Tx, ctx: TenantContext, unitId: string) {
    const view = ctx.permissions.get('property.view');
    const unit = await tx
      .selectFrom('units as u')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .innerJoin('addresses as a', 'a.id', 'p.addressId')
      .select(['u.id', 'u.archivedAt', 'p.archivedAt as propertyArchivedAt', 'p.officeId as propertyOfficeId', 'p.jurisdictionCode', 'p.timezone', 'a.countryCode'])
      .where('u.id', '=', unitId)
      .where(propertyScopeSql(view?.scope ?? 'linked', ctx, 'p'))
      .executeTakeFirst();
    if (!unit) throw Problems.validation([{ field: 'unitId', code: 'not-found', message: 'This unit does not exist or you cannot see it.' }]);
    if (unit.archivedAt !== null || unit.propertyArchivedAt !== null) throw Problems.businessRule('Archived units cannot be listed. Restore the unit first.');
    return unit;
  }

  private async placementOf(tx: Tx, unitId: string): Promise<Omit<Placement, 'officeId'>> {
    return tx
      .selectFrom('units as u')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .innerJoin('addresses as a', 'a.id', 'p.addressId')
      .select(['p.jurisdictionCode', 'p.timezone', 'a.countryCode'])
      .where('u.id', '=', unitId)
      .executeTakeFirstOrThrow();
  }

  private async loadOffice(tx: Tx, id: string) {
    return tx
      .selectFrom('offices')
      .select(['id', 'currencyCode', 'localeCode'])
      .where('id', '=', id)
      .where('archivedAt', 'is', null)
      .executeTakeFirst();
  }

  private async localeActive(tx: Tx, code: string): Promise<boolean> {
    return (await tx.selectFrom('locales').select('code').where('code', '=', code).where('isActive', '=', true).executeTakeFirst()) !== undefined;
  }

  /**
   * An agent must be an active staff member who may edit listings in the
   * office: company-wide, or through an office assignment.
   */
  private async agentError(tx: Tx, membershipId: string, officeId: string): Promise<FieldError | null> {
    const member = await tx
      .selectFrom('companyMemberships as m')
      .leftJoin('rolePermissions as rp', (join) => join.onRef('rp.roleId', '=', 'm.roleId').on('rp.permissionKey', '=', 'listing.update'))
      .select(['m.status', 'm.membershipType', 'rp.scope'])
      .select((eb) =>
        eb
          .exists(eb.selectFrom('membershipOffices as mo').select('mo.officeId').whereRef('mo.membershipId', '=', 'm.id').where('mo.officeId', '=', officeId))
          .as('inOffice'),
      )
      .where('m.id', '=', membershipId)
      .executeTakeFirst();
    const eligible =
      member !== undefined &&
      member.status === 'active' &&
      member.membershipType === 'staff' &&
      member.scope !== null &&
      (member.scope === 'all' || ((member.scope === 'office' || member.scope === 'own') && member.inOffice === true));
    return eligible
      ? null
      : { field: 'agentMembershipId', code: 'not-eligible', message: 'Choose an active staff member who works on listings in this office.' };
  }

  /** Validates the commercial terms as a whole; picklist codes are checked only when supplied. */
  private async checkTerms(tx: Tx, terms: Terms, placement: Placement, touched: Set<string>): Promise<FieldError[]> {
    const errors: FieldError[] = [];
    const currency = await tx.selectFrom('currencies').select(['minorUnits']).where('code', '=', terms.currencyCode).where('isActive', '=', true).executeTakeFirst();
    if (!currency) {
      errors.push({ field: 'price.currency', code: 'unsupported', message: 'This currency is not supported.' });
    } else {
      for (const field of MONEY_FIELDS) {
        const value = terms[field];
        if (value !== null && touched.has(field) && decimalPlaces(value) > currency.minorUnits) {
          errors.push({ field: `${API_FIELD[field]}.amount`, code: 'precision', message: `Use at most ${currency.minorUnits} decimal places for ${terms.currencyCode}.` });
        }
      }
      if (terms.feeTerms?.amount !== undefined && touched.has('feeTerms') && decimalPlaces(terms.feeTerms.amount) > currency.minorUnits) {
        errors.push({ field: 'feeTerms.amount.amount', code: 'precision', message: `Use at most ${currency.minorUnits} decimal places for ${terms.currencyCode}.` });
      }
    }

    if (terms.priceQualifierCode !== null && touched.has('priceQualifierCode')) {
      const error = await checkPicklistCode(tx, 'price_qualifier', terms.priceQualifierCode, placement.countryCode, 'priceQualifierCode');
      if (error) errors.push(error);
    }
    if (terms.mandateTypeCode !== null && touched.has('mandateTypeCode')) {
      const error = await checkPicklistCode(tx, 'mandate_type', terms.mandateTypeCode, placement.countryCode, 'mandateTypeCode');
      if (error) errors.push(error);
    }
    for (const field of ['availableFrom', 'mandateSignedOn', 'mandateExpiresOn'] as const) {
      const value = terms[field];
      if (value !== null && touched.has(field) && !isCalendarDate(value)) errors.push({ field, code: 'invalid', message: 'This is not a valid date.' });
    }
    const datesValid = errors.every((error) => error.code !== 'invalid');
    if (datesValid && terms.mandateSignedOn !== null && terms.mandateExpiresOn !== null && terms.mandateExpiresOn < terms.mandateSignedOn) {
      errors.push({ field: 'mandateExpiresOn', code: 'range', message: 'The mandate cannot expire before it is signed.' });
    }

    if (terms.listingType === 'sale') {
      for (const field of RENT_ONLY_FIELDS) {
        if (terms[field] !== null) errors.push({ field: API_FIELD[field] ?? field, code: 'not-applicable', message: 'This applies to rentals only.' });
      }
      return errors;
    }

    if (terms.rentFrequency === null) errors.push({ field: 'rentFrequency', code: 'required', message: 'Rentals need a rent frequency.' });
    if ((terms.serviceChargeAmount === null) !== (terms.serviceChargeFrequency === null)) {
      errors.push({ field: 'serviceChargeFrequency', code: 'pair', message: 'Give the service charge amount and how often it is paid together.' });
    }
    if (errors.length > 0 || terms.rentFrequency === null) return errors;

    // Country caps come from jurisdiction settings (or company overrides), not code.
    const onDate = todayIn(placement.timezone);
    if (terms.advanceRentPeriods !== null && (touched.has('advanceRentPeriods') || touched.has('rentFrequency'))) {
      const cap = decimalSetting(await this.settings.effectiveRule(tx, 'advance_rent_max_months', placement.officeId, placement.jurisdictionCode, onDate));
      if (cap !== null && !advanceWithinCap(terms.advanceRentPeriods, terms.rentFrequency, cap)) {
        errors.push({ field: 'advanceRentPeriods', code: 'limit', message: `Advance rent is limited to ${Number(cap)} months here.` });
      }
    }
    if (terms.depositAmount !== null && (touched.has('depositAmount') || touched.has('price'))) {
      const multiple = decimalSetting(await this.settings.effectiveRule(tx, 'deposit_max_rent_multiple', placement.officeId, placement.jurisdictionCode, onDate));
      if (multiple !== null && !depositWithinCap(terms.depositAmount, terms.price, multiple)) {
        errors.push({ field: 'deposit', code: 'limit', message: `The deposit is limited to ${Number(multiple)} times the periodic rent here.` });
      }
    }
    return errors;
  }

  /** The publishing checklist; each failing item is returned as a field error. */
  private async publishBlockers(tx: Tx, listing: ListingRow): Promise<FieldError[]> {
    const blockers: FieldError[] = [];
    const unit = await tx
      .selectFrom('units as u')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .innerJoin('propertyTypes as pt', 'pt.id', 'p.propertyTypeId')
      .select(['u.id', 'u.propertyId', 'u.availability', 'u.archivedAt', 'p.archivedAt as propertyArchivedAt', 'p.timezone', 'p.jurisdictionCode', 'pt.usageClass'])
      .where('u.id', '=', listing.unitId)
      .executeTakeFirstOrThrow();
    const today = todayIn(unit.timezone);

    if (unit.archivedAt !== null || unit.propertyArchivedAt !== null) {
      blockers.push({ field: 'unitId', code: 'archived', message: 'The unit or property is archived.' });
    }
    if (unit.availability === 'unavailable') {
      blockers.push({ field: 'unit.availability', code: 'unavailable', message: 'The unit is marked unavailable.' });
    }
    if (listing.mandateExpiresOn !== null && listing.mandateExpiresOn < today) {
      blockers.push({ field: 'mandateExpiresOn', code: 'expired', message: 'The mandate has expired. Renew it before publishing.' });
    }
    const settings = await this.settings.get(tx);
    const media = await this.mediaSummary(tx, listing.id);
    if (settings.minPhotosToPublish !== null && media.photoCount < settings.minPhotosToPublish) {
      blockers.push({ field: 'media', code: 'photos', message: `At least ${settings.minPhotosToPublish} photos are required before publishing.` });
    }
    if (settings.requireFloorPlanToPublish && media.floorPlanCount === 0) {
      blockers.push({ field: 'media', code: 'floor-plan', message: 'A floor plan is required before publishing.' });
    }
    if (settings.requireSellerKyc) {
      // Seller identity comes from ownership records (Phase 5); until then the setting blocks publishing.
      blockers.push({
        field: 'sellerKyc',
        code: 'unverified',
        message: 'Your company requires verified seller KYC before publishing, and no verified seller is recorded for this unit.',
      });
    }

    const jurisdiction = await tx.selectFrom('jurisdictions').select('parentCode').where('code', '=', unit.jurisdictionCode).executeTakeFirst();
    const jurisdictions = [unit.jurisdictionCode, ...(jurisdiction?.parentCode ? [jurisdiction.parentCode] : [])];
    const rules = await tx
      .selectFrom('requiredDocumentRules')
      .select(['documentTypeCode', 'conditions'])
      .where('appliesTo', '=', 'listing')
      .where('blockingStage', '=', 'available')
      .where('isActive', '=', true)
      .where((eb) => eb.or([eb('jurisdictionCode', 'is', null), eb('jurisdictionCode', 'in', jurisdictions)]))
      .execute();
    for (const rule of rules) {
      if (!ruleApplies(rule.conditions, { listing_type: listing.listingType, usage: unit.usageClass })) continue;
      const document = await tx
        .selectFrom('documents as d')
        .innerJoin('documentLinks as dl', 'dl.documentId', 'd.id')
        .select('d.id')
        .where('d.documentTypeCode', '=', rule.documentTypeCode)
        .where('d.archivedAt', 'is', null)
        .where((eb) => eb.or([eb('d.expiresOn', 'is', null), eb('d.expiresOn', '>=', today)]))
        .where((eb) =>
          eb.or([
            eb.and([eb('dl.entityType', '=', 'listing'), eb('dl.entityId', '=', listing.id)]),
            eb.and([eb('dl.entityType', '=', 'unit'), eb('dl.entityId', '=', unit.id)]),
            eb.and([eb('dl.entityType', '=', 'property'), eb('dl.entityId', '=', unit.propertyId)]),
          ]),
        )
        .executeTakeFirst();
      if (!document) {
        blockers.push({ field: 'documents', code: 'missing', message: `A current "${rule.documentTypeCode}" document is required before publishing.` });
      }
    }
    return blockers;
  }

  private summaryQuery(tx: Tx) {
    return tx
      .selectFrom('listings as l')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .innerJoin('addresses as a', 'a.id', 'p.addressId')
      .innerJoin('offices as o', 'o.id', 'l.officeId')
      .innerJoin('companyMemberships as m', 'm.id', 'l.agentMembershipId')
      .innerJoin('users as us', 'us.id', 'm.userId')
      .innerJoin('currencies as cur', 'cur.code', 'l.currencyCode')
      .select([
        'l.id',
        'l.reference',
        'l.listingType',
        'l.status',
        'l.isPublished',
        'l.price',
        'l.currencyCode',
        'cur.minorUnits',
        'l.rentFrequency',
        'l.title',
        'l.unitId',
        'u.reference as unitReference',
        'u.unitLabel',
        'u.bedrooms',
        'u.availability',
        'p.id as propertyId',
        'p.reference as propertyReference',
        'p.name as propertyName',
        'a.formatted',
        'l.officeId',
        'o.code as officeCode',
        'o.name as officeName',
        'l.agentMembershipId',
        'us.displayName as agentName',
        'l.listedAt',
        'l.archivedAt',
        'l.updatedAt',
      ]);
  }
}

function assertEditable(row: { archivedAt: Date | null; status: string }): void {
  if (row.archivedAt !== null) throw Problems.businessRule('Archived listings cannot be edited. Restore the listing first.');
  if (isTerminal(row.status)) throw Problems.businessRule('Closed listings cannot be edited. Relist the unit to start a new campaign.');
}

/**
 * Whether a required-document rule's conditions match. Known condition keys
 * are compared; an unknown key makes the rule apply (fail closed).
 */
export function ruleApplies(conditions: unknown, facts: Record<string, string>): boolean {
  if (typeof conditions !== 'object' || conditions === null || Array.isArray(conditions)) return true;
  return Object.entries(conditions as Record<string, unknown>).every(([key, expected]) => {
    if (!(key in facts)) return true;
    return Array.isArray(expected) ? expected.includes(facts[key]) : expected === facts[key];
  });
}

/** JSON with object keys sorted, so jsonb values (which reorder keys) compare reliably. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

function normaliseFeeTerms(input: FeeTermsInput | null): StoredFeeTerms | null {
  if (input === null) return null;
  return input.basis === 'percentage'
    ? { basis: 'percentage', rate: input.rate!, taxInclusive: input.taxInclusive }
    : { basis: 'fixed', amount: input.amount!.amount, taxInclusive: input.taxInclusive };
}

function storedFeeTerms(value: unknown): StoredFeeTerms | null {
  if (typeof value !== 'object' || value === null || !('basis' in value)) return null;
  return value as StoredFeeTerms;
}

function feeTermsDto(terms: StoredFeeTerms | null, currency: string, minorUnits: number): FeeTermsDto | null {
  if (terms === null) return null;
  return terms.amount !== undefined
    ? { basis: terms.basis, amount: toMoney(terms.amount, currency, minorUnits), taxInclusive: terms.taxInclusive }
    : { basis: terms.basis, rate: terms.rate!, taxInclusive: terms.taxInclusive };
}

/** Every amount on a listing is in the listing currency. */
function currencyMismatches(currency: string, amounts: Record<string, MoneyInput | null | undefined>): FieldError[] {
  return Object.entries(amounts)
    .filter(([, money]) => money !== null && money !== undefined && money.currency !== currency)
    .map(([field]) => ({ field: `${field}.currency`, code: 'currency-mismatch', message: `Use the listing currency (${currency}).` }));
}

interface SummaryRow {
  id: string;
  reference: string;
  listingType: string;
  status: string;
  isPublished: boolean;
  price: string;
  currencyCode: string;
  minorUnits: number;
  rentFrequency: string | null;
  title: string;
  unitId: string;
  unitReference: string;
  unitLabel: string;
  bedrooms: number | null;
  availability: string;
  propertyId: string;
  propertyReference: string;
  propertyName: string | null;
  formatted: string | null;
  officeId: string;
  officeCode: string;
  officeName: string;
  agentMembershipId: string;
  agentName: string;
  listedAt: Date | null;
  archivedAt: Date | null;
  updatedAt: Date;
}

function toSummaryDto(row: SummaryRow): ListingSummaryDto {
  return {
    id: row.id,
    reference: row.reference,
    listingType: row.listingType,
    status: row.status,
    isPublished: row.isPublished,
    price: toMoney(row.price, row.currencyCode, row.minorUnits),
    rentFrequency: row.rentFrequency,
    title: row.title,
    unit: { id: row.unitId, reference: row.unitReference, unitLabel: row.unitLabel, bedrooms: row.bedrooms, availability: row.availability },
    property: { id: row.propertyId, reference: row.propertyReference, name: row.propertyName, formattedAddress: row.formatted },
    office: { id: row.officeId, code: row.officeCode, name: row.officeName },
    agent: { membershipId: row.agentMembershipId, displayName: row.agentName },
    listedAt: row.listedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

