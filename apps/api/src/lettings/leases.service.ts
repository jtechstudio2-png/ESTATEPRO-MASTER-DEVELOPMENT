import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { todayIn } from '../common/dates.js';
import { keysetCondition, type Page, type ParsedListQuery, type RangeValue, sortValueSql, toPage } from '../common/list-query.js';
import { type MoneyInput, toMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import { actingMembership, type TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { asPipelineAction, moveDealToStage } from '../deals/deal-stage.js';
import { dealTimeline, lockDeal } from '../deals/deals.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { ListingsService } from '../listings/listings.service.js';
import { nextReference } from '../properties/properties.service.js';
import { checkCurrencyAmount, isRealDate } from './agreements.service.js';
import { addDays } from './charges.service.js';
import { chargeLeadDays, postLeaseRent } from './rent-schedule.js';
import type {
  ActivateLeaseBody,
  CreateLeaseBody,
  LeaseDto,
  LeaseFromDealBody,
  LeasePartyInput,
  LeaseSummaryDto,
  UpdateLeaseBody,
  UpdateLeasePartyBody,
} from './lettings.dto.js';
import { OPEN_LEASE_STATUSES } from './lettings.dto.js';
import { canOnLease, leaseAccess, leaseScopeSql, leaseWithin } from './lettings-access.js';

registerConstraintMessages({
  leases_company_id_unit_id_daterange_excl: 'Another live lease covers this unit for some of these dates.',
  lease_parties_pkey: 'This contact already has this role on the lease.',
  lease_parties_one_primary_tenant_idx: 'A lease has one primary tenant.',
  leases_one_per_deal_idx: 'This deal already has a lease.',
});

export type LeaseSortField = 'updatedAt' | 'startDate' | 'endDate';

/** Statuses the exclusion constraint of migration 0008 treats as occupying the unit. */
const OCCUPYING = ['pending_signature', 'active', 'periodic', 'notice_given'];
const EDITABLE = ['draft', 'pending_signature'];
const TENANT_ROLES = ['tenant', 'co_tenant'];
/** Company setting (P7-D5): activation needs the signed lease; on unless the company turns it off. */
export const REQUIRE_SIGNED_LEASE_KEY = 'lettings.require_signed_lease';

interface LeaseTerms {
  unitId: string;
  managementAgreementId: string | null;
  listingId: string | null;
  leaseType: string;
  startDate: string;
  endDate: string | null;
  rent: MoneyInput;
  deposit: MoneyInput | null;
  rentDueDay: number | null;
  breakClauseDate: string | null;
  nextRentReviewDate: string | null;
  governingLocaleCode: string | null;
}

/**
 * Leases (LET-01, LET-07 in part; wireframes LS-1 to LS-5; readiness §5.1;
 * P7-D4, P7-D5). A lease is drawn up as a draft (directly, or from a letting
 * deal at "terms agreed"), sent for signature, and activated with the signed
 * copy; its rent listing then becomes rented. Terms and parties are fixed once
 * active (migration 0036). Notice, ending, closing and renewal are milestone
 * L4. The database enforces the life cycle; this service checks first to
 * answer with field-level codes, and adds scope, the timeline, audit and
 * outbox events.
 */
@Injectable()
export class LeasesService {
  constructor(
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    private readonly listings: ListingsService,
  ) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, query: ParsedListQuery<LeaseSortField>): Promise<Page<LeaseSummaryDto>> {
    const f = query.filters;
    const column = `l.${query.sort.field}`;
    let qb = summaryQuery(tx)
      .select(sortValueSql(column, query.sort.kind).as('cursorValue'))
      .where(leaseScopeSql(ctx.permissions.get('lease.view')?.scope, ctx));
    const statuses = Array.isArray(f['status']) ? f['status'] : [...OPEN_LEASE_STATUSES];
    qb = qb.where('l.status', 'in', statuses);
    for (const [filter, col] of [
      ['unitId', 'l.unitId'],
      ['propertyId', 'u.propertyId'],
      ['officeId', 'p.officeId'],
      ['managementAgreementId', 'l.managementAgreementId'],
      ['leaseType', 'l.leaseType'],
    ] as const) {
      const values = f[filter];
      if (Array.isArray(values)) qb = qb.where(col, 'in', values);
    }
    const contact = f['contactId'];
    if (Array.isArray(contact)) {
      qb = qb.where((eb) => eb.exists(eb.selectFrom('leaseParties as lp').select('lp.leaseId').whereRef('lp.leaseId', '=', 'l.id').where('lp.contactId', 'in', contact)));
    }
    const end = f['endDate'] as RangeValue | undefined;
    if (end?.gte) qb = qb.where('l.endDate', '>=', end.gte);
    if (end?.lte) qb = qb.where('l.endDate', '<=', end.lte);
    if (query.q !== null) {
      const q = query.q.replace(/[\\%_]/g, (c) => `\\${c}`);
      qb = qb.where((eb) =>
        eb.or([
          eb('l.reference', 'ilike', `${q}%`),
          eb('u.unitLabel', 'ilike', `%${q}%`),
          eb('p.name', 'ilike', `%${q}%`),
          eb.exists(
            eb.selectFrom('leaseParties as sp').innerJoin('contacts as sc', 'sc.id', 'sp.contactId').select('sp.leaseId').whereRef('sp.leaseId', '=', 'l.id').where('sp.partyRole', 'in', TENANT_ROLES).where('sc.displayName', 'ilike', `%${q}%`),
          ),
        ]),
      );
    }
    if (query.cursor) qb = qb.where(keysetCondition(column, 'l.id', query.sort, query.cursor));
    const rows = await qb.orderBy(sql.ref(column), query.sort.direction).orderBy('l.id', query.sort.direction).limit(query.limit + 1).execute();
    const minor = await minorUnits(tx, rows.map((row) => row.currencyCode));
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => toSummary(row, minor));
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<LeaseDto> {
    const access = await leaseAccess(tx, id);
    if (!access || !canOnLease(ctx, 'lease.view', access)) throw Problems.notFound();
    const row = await summaryQuery(tx)
      .leftJoin('managementAgreements as ma', 'ma.id', 'l.managementAgreementId')
      .leftJoin('listings as li', 'li.id', 'l.listingId')
      .leftJoin('deals as dl', 'dl.id', 'l.dealId')
      .leftJoin('leases as pl', 'pl.id', 'l.previousLeaseId')
      .leftJoin('documents as doc', 'doc.id', 'l.documentId')
      .select([
        'l.jurisdictionCode', 'l.usage', 'l.rentDueDay', 'l.advancePeriods', 'l.prorateFirstPeriod', 'l.depositAmount', 'l.noticePeriodDays',
        'l.breakClauseDate', 'l.breakNoticeDays', 'l.nextRentReviewDate', 'l.governingLocaleCode', 'l.moveInDate', 'l.signedAt', 'l.endedReason',
        'l.managementAgreementId', 'ma.reference as agreementReference', 'l.listingId', 'li.reference as listingReference', 'l.dealId', 'dl.reference as dealReference',
        'l.previousLeaseId', 'pl.reference as previousReference', 'l.documentId', 'doc.title as documentTitle', 'l.createdAt', 'l.version',
        'l.rentScheduleFrom',
        sql<string>`app.rent_in_force(l.company_id, l.id, greatest(l.start_date, (now() at time zone p.timezone)::date))::text`.as('currentRentAmount'),
        sql<boolean>`not exists (select 1 from jurisdiction_settings js where js.jurisdiction_code = l.jurisdiction_code)`.as('rulesNotReviewed'),
      ])
      .where('l.id', '=', id)
      .executeTakeFirstOrThrow();
    const parties = await tx
      .selectFrom('leaseParties as lp')
      .innerJoin('contacts as c', 'c.id', 'lp.contactId')
      .select(['lp.contactId', 'c.displayName', 'lp.partyRole', 'lp.isPrimary', 'lp.liabilityShare', 'lp.portalAccess'])
      .where('lp.leaseId', '=', id)
      .orderBy('lp.isPrimary', 'desc')
      .orderBy(sql`array_position(array['tenant','co_tenant','occupant','guarantor','landlord','landlord_agent'], lp.party_role)`)
      .orderBy('c.displayName')
      .execute();
    const minor = await minorUnits(tx, [row.currencyCode]);
    const units = minor.get(row.currencyCode) ?? 2;
    const ref = (refId: string | null, name: string | null) => (refId ? { id: refId, name: name ?? '' } : null);
    return {
      ...toSummary(row, minor),
      jurisdictionCode: row.jurisdictionCode,
      usage: row.usage,
      rentDueDay: row.rentDueDay,
      advancePeriods: row.advancePeriods,
      prorateFirstPeriod: row.prorateFirstPeriod,
      deposit: row.depositAmount === null ? null : toMoney(row.depositAmount, row.currencyCode, units),
      noticePeriodDays: row.noticePeriodDays,
      breakClauseDate: row.breakClauseDate,
      breakNoticeDays: row.breakNoticeDays,
      nextRentReviewDate: row.nextRentReviewDate,
      governingLocaleCode: row.governingLocaleCode,
      moveInDate: row.moveInDate,
      signedAt: row.signedAt?.toISOString() ?? null,
      endedReason: row.endedReason,
      managementAgreement: ref(row.managementAgreementId, row.agreementReference),
      listing: ref(row.listingId, row.listingReference),
      deal: ref(row.dealId, row.dealReference),
      previousLease: ref(row.previousLeaseId, row.previousReference),
      document: ref(row.documentId, row.documentTitle),
      parties: parties.map((p) => ({
        contact: { id: p.contactId, name: p.displayName },
        partyRole: p.partyRole,
        isPrimary: p.isPrimary,
        liabilityShare: p.liabilityShare === null ? null : Number(p.liabilityShare),
        portalAccess: p.portalAccess,
      })),
      rulesNotReviewed: row.rulesNotReviewed,
      rentScheduleFrom: row.rentScheduleFrom,
      currentRent: toMoney(row.currentRentAmount, row.currencyCode, units),
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  // ----------------------------------------------------------------- drawing up

  async create(tx: Tx, ctx: TenantContext, body: CreateLeaseBody): Promise<LeaseDto> {
    const unit = await this.unitFor(tx, ctx, body.unitId);
    const terms = termsOf(body, body.unitId, body.listingId ?? null, body.rent);
    const errors: FieldError[] = [];
    await this.checkTerms(tx, terms, unit.propertyId, errors, null);
    const parties = await this.checkParties(tx, body.parties, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    const id = await this.insert(tx, ctx, unit, terms, body, null);
    await this.addParties(tx, ctx, id, unit, parties);
    await this.recordCreated(tx, ctx, id, null);
    return this.get(tx, ctx, id);
  }

  /**
   * P7-D4: a letting deal at "terms agreed" is drawn up into a draft lease for
   * its unit, with the accepted offer's rent and the deal's tenants; the deal
   * moves to "lease signing" and its listing under contract. The deal is won
   * once the lease is active (POST /deals/{id}/complete, L1-D2).
   */
  async fromDeal(tx: Tx, ctx: TenantContext, dealId: string, expectedVersion: number, body: LeaseFromDealBody): Promise<LeaseDto> {
    const deal = await lockDeal(tx, ctx, dealId, expectedVersion, 'deal.update');
    if (deal.dealType !== 'letting') throw Problems.businessRule('Only letting deals become leases.');
    if (deal.stageClass !== 'offer_accepted' && deal.stageClass !== 'contract') throw Problems.businessRule('A letting deal becomes a lease once terms are agreed (an offer is accepted).');
    if (!ctx.permissions.has('lease.create')) throw Problems.forbidden('Your role does not allow drawing up leases.');
    const existing = await tx.selectFrom('leases').select('reference').where('dealId', '=', dealId).where('status', '<>', 'cancelled').executeTakeFirst();
    if (existing) throw Problems.businessRule(`This deal already has lease ${existing.reference}.`);
    const offer = await tx.selectFrom('offers').select(['listingId', 'amount', 'currencyCode', 'rentFrequency']).where('dealId', '=', dealId).where('status', '=', 'accepted').executeTakeFirst();
    if (!offer || !deal.unitId) throw Problems.businessRule('The deal has no accepted offer for a unit.');
    if (!offer.rentFrequency) throw Problems.businessRule('The accepted offer does not say how often the rent is paid.');
    const unit = await this.unitFor(tx, ctx, deal.unitId);
    const rent = { amount: offer.amount, currency: offer.currencyCode };
    const terms = termsOf(body, deal.unitId, offer.listingId, rent);
    const errors: FieldError[] = [];
    await this.checkTerms(tx, terms, unit.propertyId, errors, dealId);
    const dealParties = await tx.selectFrom('dealParties').select(['contactId', 'partyRole']).where('dealId', '=', dealId).execute();
    const inputs: LeasePartyInput[] = [
      { contactId: deal.primaryContactId, partyRole: 'tenant', isPrimary: true },
      ...dealParties
        .filter((p) => p.contactId !== deal.primaryContactId && ['tenant', 'guarantor', 'landlord'].includes(p.partyRole))
        .map((p) => ({ contactId: p.contactId, partyRole: (p.partyRole === 'tenant' ? 'co_tenant' : p.partyRole) as LeasePartyInput['partyRole'] })),
      ...(body.extraParties ?? []),
    ];
    const parties = await this.checkParties(tx, inputs, errors);
    if (errors.length > 0) throw Problems.validation(errors);

    const id = await this.insert(tx, ctx, unit, terms, { ...body, rentFrequency: offer.rentFrequency }, dealId);
    await this.addParties(tx, ctx, id, unit, parties);
    await asPipelineAction(tx);
    if (deal.stageClass === 'offer_accepted') await moveDealToStage(tx, deal, 'contract', 'Lease drawn up');
    await this.listings.pipelineStatus(tx, ctx, offer.listingId, 'under_contract', 'Lease drawn up');
    const reference = (await tx.selectFrom('leases').select('reference').where('id', '=', id).executeTakeFirstOrThrow()).reference;
    await dealTimeline(tx, ctx, deal, `Lease drawn up: ${reference}`, null);
    await this.recordCreated(tx, ctx, id, dealId);
    if (deal.stageClass === 'offer_accepted') {
      await this.audit.record(tx, ctx, { action: 'deal.stage_changed', entityType: 'deal', entityId: dealId, metadata: { fromStageClass: 'offer_accepted', toStageClass: 'contract', leaseId: id } });
    }
    return this.get(tx, ctx, id);
  }

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateLeaseBody): Promise<LeaseDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (!EDITABLE.includes(current.status)) throw Problems.businessRule('Active leases change through rent reviews, renewals or notice.');
    if (current.dealId && body.listingId !== undefined && body.listingId !== current.listingId) {
      throw Problems.validation([{ field: 'listingId', code: 'from-deal', message: 'A lease drawn up from a deal keeps the deal\'s listing.' }]);
    }
    const rent = body.rent ?? { amount: current.rentAmount, currency: current.currencyCode };
    const terms: LeaseTerms = {
      unitId: current.unitId,
      managementAgreementId: body.managementAgreementId !== undefined ? body.managementAgreementId : current.managementAgreementId,
      listingId: body.listingId !== undefined ? body.listingId : current.listingId,
      leaseType: body.leaseType ?? current.leaseType,
      startDate: body.startDate ?? current.startDate,
      endDate: body.endDate !== undefined ? body.endDate : current.endDate,
      rent,
      deposit: body.deposit !== undefined ? body.deposit : current.depositAmount === null ? null : { amount: current.depositAmount, currency: current.currencyCode },
      rentDueDay: body.rentDueDay !== undefined ? body.rentDueDay : current.rentDueDay,
      breakClauseDate: body.breakClauseDate !== undefined ? body.breakClauseDate : current.breakClauseDate,
      nextRentReviewDate: body.nextRentReviewDate !== undefined ? body.nextRentReviewDate : current.nextRentReviewDate,
      governingLocaleCode: body.governingLocaleCode !== undefined ? body.governingLocaleCode : current.governingLocaleCode,
    };
    const errors: FieldError[] = [];
    await this.checkTerms(tx, terms, current.propertyId, errors, current.dealId, id);
    if (current.dealId && body.rent && (body.rent.amount !== current.rentAmount || body.rent.currency !== current.currencyCode)) {
      errors.push({ field: 'rent', code: 'from-deal', message: 'The rent of a lease drawn up from a deal is the accepted offer. Record a new offer on the deal to change it.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    const values = {
      managementAgreementId: terms.managementAgreementId,
      listingId: terms.listingId,
      leaseType: terms.leaseType,
      usage: body.usage ?? current.usage,
      startDate: terms.startDate,
      endDate: terms.endDate,
      currencyCode: rent.currency,
      rentAmount: rent.amount,
      rentFrequency: body.rentFrequency ?? current.rentFrequency,
      rentDueDay: terms.rentDueDay,
      advancePeriods: body.advancePeriods ?? current.advancePeriods,
      prorateFirstPeriod: body.prorateFirstPeriod ?? current.prorateFirstPeriod,
      depositAmount: terms.deposit?.amount ?? null,
      noticePeriodDays: body.noticePeriodDays !== undefined ? body.noticePeriodDays : current.noticePeriodDays,
      breakClauseDate: terms.breakClauseDate,
      breakNoticeDays: body.breakNoticeDays !== undefined ? body.breakNoticeDays : current.breakNoticeDays,
      nextRentReviewDate: terms.nextRentReviewDate,
      governingLocaleCode: terms.governingLocaleCode,
    };
    const changes = diffForAudit(pick(current, Object.keys(values)), normalise(values));
    if (!changes) return this.get(tx, ctx, id);
    await tx.updateTable('leases').set({ ...values, version: sql`version + 1` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'lease.updated', entityType: 'lease', entityId: id, changes });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- parties

  async addParty(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: LeasePartyInput): Promise<LeaseDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (!EDITABLE.includes(current.status)) throw Problems.businessRule('The parties of an active lease are fixed. A change of tenant is a new lease or a renewal.');
    const errors: FieldError[] = [];
    const [party] = await this.checkParties(tx, [body], errors, false);
    if (party && TENANT_ROLES.includes(party.partyRole) && party.isPrimary) {
      const primary = await tx.selectFrom('leaseParties').select('contactId').where('leaseId', '=', id).where('isPrimary', '=', true).where('partyRole', 'in', TENANT_ROLES).executeTakeFirst();
      if (primary) errors.push({ field: 'isPrimary', code: 'primary-exists', message: 'The lease already has a primary tenant.' });
    }
    if (errors.length > 0 || !party) throw Problems.validation(errors);
    await tx.insertInto('leaseParties').values({ companyId: ctx.companyId, leaseId: id, ...partyValues(party) }).execute();
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, { action: 'lease.party_added', entityType: 'lease', entityId: id, metadata: { contactId: party.contactId, partyRole: party.partyRole, isPrimary: party.isPrimary ?? false } });
    return this.get(tx, ctx, id);
  }

  async updateParty(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, contactId: string, role: string, body: UpdateLeasePartyBody): Promise<LeaseDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'lease.update');
    const party = await tx.selectFrom('leaseParties').selectAll().where('leaseId', '=', id).where('contactId', '=', contactId).where('partyRole', '=', role).executeTakeFirst();
    if (!party) throw Problems.notFound();
    const live = !EDITABLE.includes(current.status);
    if (live && (body.liabilityShare !== undefined || body.isPrimary !== undefined)) {
      throw Problems.businessRule('Only portal access changes once the lease is active.');
    }
    if (current.status === 'closed' || current.status === 'cancelled') throw Problems.businessRule('This lease is finished and does not change.');
    if (body.isPrimary === true && !TENANT_ROLES.includes(role)) throw Problems.validation([{ field: 'isPrimary', code: 'not-tenant', message: 'The primary party is a tenant.' }]);
    const values = {
      liabilityShare: body.liabilityShare !== undefined ? (body.liabilityShare === null ? null : String(body.liabilityShare)) : party.liabilityShare,
      portalAccess: body.portalAccess ?? party.portalAccess,
      isPrimary: body.isPrimary ?? party.isPrimary,
    };
    const changes = diffForAudit({ liabilityShare: party.liabilityShare === null ? null : Number(party.liabilityShare), portalAccess: party.portalAccess, isPrimary: party.isPrimary }, { liabilityShare: values.liabilityShare === null ? null : Number(values.liabilityShare), portalAccess: values.portalAccess, isPrimary: values.isPrimary });
    if (!changes) return this.get(tx, ctx, id);
    if (values.isPrimary && !party.isPrimary) {
      await tx.updateTable('leaseParties').set({ isPrimary: false }).where('leaseId', '=', id).where('partyRole', 'in', TENANT_ROLES).where('isPrimary', '=', true).execute();
    }
    await tx.updateTable('leaseParties').set(values).where('leaseId', '=', id).where('contactId', '=', contactId).where('partyRole', '=', role).execute();
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, { action: 'lease.party_updated', entityType: 'lease', entityId: id, changes, metadata: { contactId, partyRole: role } });
    return this.get(tx, ctx, id);
  }

  async removeParty(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, contactId: string, role: string): Promise<LeaseDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (!EDITABLE.includes(current.status)) throw Problems.businessRule('The parties of an active lease are fixed.');
    const party = await tx.selectFrom('leaseParties').select(['isPrimary']).where('leaseId', '=', id).where('contactId', '=', contactId).where('partyRole', '=', role).executeTakeFirst();
    if (!party) throw Problems.notFound();
    if (party.isPrimary) throw Problems.businessRule('Make another tenant the primary tenant before removing this one.');
    await tx.deleteFrom('leaseParties').where('leaseId', '=', id).where('contactId', '=', contactId).where('partyRole', '=', role).execute();
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, { action: 'lease.party_removed', entityType: 'lease', entityId: id, metadata: { contactId, partyRole: role } });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- life cycle

  /** Draft → pending signature: the unit is then held for these dates (migration 0008's exclusion). */
  async sendForSignature(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<LeaseDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (current.status !== 'draft') throw Problems.businessRule('Only a draft lease is sent for signature.');
    await this.assertReady(tx, current);
    await tx.updateTable('leases').set({ status: 'pending_signature', version: sql`version + 1` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'lease.sent_for_signature', entityType: 'lease', entityId: id, changes: { status: { old: 'draft', new: 'pending_signature' } } });
    await this.audit.emit(tx, ctx, { eventType: 'lease.sent_for_signature', aggregateType: 'lease', aggregateId: id, payload: { leaseId: id } });
    return this.get(tx, ctx, id);
  }

  /** Pending signature → draft, to change terms agreed after sending. */
  async returnToDraft(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<LeaseDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (current.status !== 'pending_signature') throw Problems.businessRule('Only a lease awaiting signature goes back to draft.');
    await tx.updateTable('leases').set({ status: 'draft', version: sql`version + 1` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'lease.returned_to_draft', entityType: 'lease', entityId: id, changes: { status: { old: 'pending_signature', new: 'draft' } } });
    return this.get(tx, ctx, id);
  }

  /**
   * Pending signature → active (lease.activate; P7-D5): with the signed copy
   * scanned clean (unless the company turned the rule off), under an active
   * agreement if one is named. The rent listing becomes rented (P7-D4) and a
   * deal's "lease signed" milestone is completed.
   */
  async activate(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: ActivateLeaseBody): Promise<LeaseDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'lease.activate');
    if (current.status !== 'pending_signature') throw Problems.businessRule('A lease is activated once it has been sent for signature.');
    const today = todayIn(current.timezone);
    const errors: FieldError[] = [];
    if (!isRealDate(body.signedOn)) errors.push({ field: 'signedOn', code: 'invalid', message: 'Use a real date such as 2026-11-28.' });
    else if (body.signedOn > today) errors.push({ field: 'signedOn', code: 'future', message: 'Record the signature once it has happened.' });
    const moveIn = body.moveInDate ?? current.startDate;
    if (body.moveInDate !== undefined && !isRealDate(body.moveInDate)) errors.push({ field: 'moveInDate', code: 'invalid', message: 'Use a real date such as 2026-12-01.' });
    const required = await requireSignedLease(tx);
    if (required && !body.documentId) errors.push({ field: 'documentId', code: 'required', message: 'Upload the signed lease, then activate.' });
    if (errors.length > 0) throw Problems.validation(errors);
    if (body.documentId) await this.documents.assertUsable(tx, body.documentId, 'lease', id, 'documentId');
    await this.assertReady(tx, current);
    if (current.managementAgreementId) {
      const agreement = await tx.selectFrom('managementAgreements').select(['status', 'reference']).where('id', '=', current.managementAgreementId).executeTakeFirstOrThrow();
      if (agreement.status !== 'active') throw Problems.businessRule(`Management agreement ${agreement.reference} is ${agreement.status}. Activate it first.`);
    }

    await tx
      .updateTable('leases')
      .set({
        status: 'active',
        signedAt: sql<Date>`(${body.signedOn}::date)::timestamp at time zone ${current.timezone}`,
        documentId: body.documentId ?? null,
        moveInDate: moveIn,
        rentScheduleFrom: current.startDate,
        version: sql`version + 1`,
      })
      .where('id', '=', id)
      .execute();
    // The rent schedule starts with the lease (L2, P7-D6): the first period and the advance periods are charged at signing,
    // and, once the company has a lead time, whatever else is due by then (a lease activated after its start date).
    const lead = await chargeLeadDays(tx);
    const advanceCharges = await postLeaseRent(tx, ctx, this.audit, id, lead === null ? addDays(current.startDate, -1) : addDays(today, lead));
    if (current.listingId) await this.rentListing(tx, ctx, current.listingId, current.reference);
    if (current.dealId) {
      const completed = await tx
        .updateTable('dealMilestones')
        .set({ completedAt: sql<Date>`now()`, completedBy: actingMembership(ctx) })
        .where('dealId', '=', current.dealId)
        .where('code', '=', 'lease_signed')
        .where('completedAt', 'is', null)
        .returning('id')
        .execute();
      const deal = await tx.selectFrom('deals').select(['id', 'primaryContactId', 'listingId', 'leadId']).where('id', '=', current.dealId).executeTakeFirstOrThrow();
      await dealTimeline(tx, ctx, deal, `Lease ${current.reference} signed and active`, null);
      if (completed.length > 0) {
        await this.audit.record(tx, ctx, { action: 'deal.milestone_completed', entityType: 'deal', entityId: current.dealId, metadata: { milestoneId: completed[0]!.id, code: 'lease_signed', leaseId: id } });
      }
    }
    await this.audit.record(tx, ctx, {
      action: 'lease.activated',
      entityType: 'lease',
      entityId: id,
      changes: { status: { old: 'pending_signature', new: 'active' } },
      metadata: { signedOn: body.signedOn, documentId: body.documentId ?? null, moveInDate: moveIn, signedDocumentRequired: required, rentScheduleFrom: current.startDate, chargesPosted: advanceCharges },
    });
    await this.audit.emit(tx, ctx, { eventType: 'lease.activated', aggregateType: 'lease', aggregateId: id, payload: { leaseId: id, unitId: current.unitId, listingId: current.listingId, dealId: current.dealId } });
    return this.get(tx, ctx, id);
  }

  /** Draft or pending signature → cancelled, with the reason (kept on the lease). */
  async cancel(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<LeaseDto> {
    const current = await this.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (!EDITABLE.includes(current.status)) throw Problems.businessRule('Only a lease that is not yet active can be cancelled. An active lease ends with notice.');
    await tx.updateTable('leases').set({ status: 'cancelled', endedReason: reason, version: sql`version + 1` }).where('id', '=', id).execute();
    if (current.dealId) {
      const deal = await tx.selectFrom('deals').select(['id', 'primaryContactId', 'listingId', 'leadId']).where('id', '=', current.dealId).executeTakeFirstOrThrow();
      await dealTimeline(tx, ctx, deal, `Lease ${current.reference} cancelled`, reason);
    }
    await this.audit.record(tx, ctx, { action: 'lease.cancelled', entityType: 'lease', entityId: id, changes: { status: { old: current.status, new: 'cancelled' } } });
    await this.audit.emit(tx, ctx, { eventType: 'lease.cancelled', aggregateType: 'lease', aggregateId: id, payload: { leaseId: id, dealId: current.dealId } });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- helpers

  private async lock(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, permission: string) {
    const access = await leaseAccess(tx, id);
    if (!access || !canOnLease(ctx, 'lease.view', access)) throw Problems.notFound();
    if (!canOnLease(ctx, permission, access)) {
      throw Problems.forbidden(permission === 'lease.activate' ? 'Activating leases is for the company owner and property managers.' : 'Your role does not allow changes to this lease.');
    }
    const row = await tx
      .selectFrom('leases as l')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .selectAll('l')
      .select(['u.propertyId', 'p.timezone'])
      .where('l.id', '=', id)
      .forUpdate('l')
      .executeTakeFirstOrThrow();
    if (row.version !== expectedVersion) throw Problems.preconditionFailed();
    return row;
  }

  private async unitFor(tx: Tx, ctx: TenantContext, unitId: string) {
    const unit = await tx
      .selectFrom('units as u')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .select(['u.id', 'u.propertyId', 'u.archivedAt', 'p.officeId', 'p.jurisdictionCode', 'p.archivedAt as propertyArchivedAt'])
      .where('u.id', '=', unitId)
      .executeTakeFirst();
    // A new lease is the member's own; an "own" scope (agents) lets units of the member's offices.
    const scope = ctx.permissions.get('lease.create')?.scope;
    const covered = unit !== undefined && (scope === 'own' ? ctx.officeIds.includes(unit.officeId) : leaseWithin(scope, ctx, { officeId: unit.officeId, createdBy: null, dealOwnerId: null, dealAgentIds: [] }));
    if (!unit || !covered) {
      throw Problems.validation([{ field: 'unitId', code: 'not-found', message: 'This unit does not exist or you cannot let it.' }]);
    }
    if (unit.archivedAt !== null || unit.propertyArchivedAt !== null) throw Problems.businessRule('This unit or its property is archived.');
    return unit;
  }

  private async checkTerms(tx: Tx, terms: LeaseTerms, propertyId: string, errors: FieldError[], dealId: string | null, leaseId: string | null = null): Promise<void> {
    if (!isRealDate(terms.startDate)) errors.push({ field: 'startDate', code: 'invalid', message: 'Use a real date such as 2026-12-01.' });
    if (terms.leaseType === 'fixed_term' && !terms.endDate) errors.push({ field: 'endDate', code: 'required', message: 'A fixed-term lease has an end date.' });
    if (terms.endDate) {
      if (!isRealDate(terms.endDate)) errors.push({ field: 'endDate', code: 'invalid', message: 'Use a real date such as 2027-11-30.' });
      else if (terms.endDate < terms.startDate) errors.push({ field: 'endDate', code: 'before-start', message: 'The end date is on or after the start date.' });
    }
    for (const [field, value] of [['breakClauseDate', terms.breakClauseDate], ['nextRentReviewDate', terms.nextRentReviewDate]] as const) {
      if (value && !isRealDate(value)) errors.push({ field, code: 'invalid', message: 'Use a real date.' });
      else if (value && value < terms.startDate) errors.push({ field, code: 'before-start', message: 'This date is on or after the start date.' });
    }
    await checkCurrencyAmount(tx, terms.rent, terms.rent.currency, 'rent', errors, true);
    if (terms.deposit) await checkCurrencyAmount(tx, terms.deposit, terms.rent.currency, 'deposit', errors);
    if (terms.governingLocaleCode) {
      const locale = await tx.selectFrom('locales').select('code').where('code', '=', terms.governingLocaleCode).where('isActive', '=', true).executeTakeFirst();
      if (!locale) errors.push({ field: 'governingLocaleCode', code: 'unknown-locale', message: 'Unknown language.' });
    }
    if (terms.managementAgreementId) {
      const agreement = await tx.selectFrom('managementAgreements').select(['propertyId', 'unitId', 'status', 'currencyCode']).where('id', '=', terms.managementAgreementId).executeTakeFirst();
      if (!agreement || agreement.propertyId !== propertyId || (agreement.unitId !== null && agreement.unitId !== terms.unitId)) {
        errors.push({ field: 'managementAgreementId', code: 'not-covering', message: 'This agreement does not cover the unit.' });
      } else if (agreement.status === 'ended') {
        errors.push({ field: 'managementAgreementId', code: 'ended', message: 'This agreement has ended.' });
      } else if (agreement.currencyCode !== terms.rent.currency) {
        errors.push({ field: 'rent.currency', code: 'currency-mismatch', message: `The agreement is in ${agreement.currencyCode}.` });
      }
    }
    if (terms.listingId) {
      const listing = await tx.selectFrom('listings').select(['unitId', 'listingType', 'status', 'currencyCode']).where('id', '=', terms.listingId).executeTakeFirst();
      if (!listing || listing.unitId !== terms.unitId || listing.listingType !== 'rent') {
        errors.push({ field: 'listingId', code: 'not-found', message: 'This is not a rent listing of the unit.' });
      } else if (!['available', 'reserved', 'under_contract'].includes(listing.status)) {
        errors.push({ field: 'listingId', code: 'closed', message: 'This listing is closed.' });
      } else if (dealId === null) {
        const accepted = await tx.selectFrom('offers').select('dealId').where('listingId', '=', terms.listingId).where('status', '=', 'accepted').executeTakeFirst();
        if (accepted) errors.push({ field: 'listingId', code: 'offer-accepted', message: 'This listing has an accepted offer. Draw the lease up from its deal.' });
      }
    }
    // The overlap check needs a valid range: a start date, and no end date before it.
    if (isRealDate(terms.startDate) && (terms.endDate === null || (isRealDate(terms.endDate) && terms.endDate >= terms.startDate))) {
      const overlap = await this.overlapping(tx, terms.unitId, terms.startDate, terms.endDate, leaseId);
      if (overlap) errors.push({ field: 'startDate', code: 'unit-let', message: `Lease ${overlap.reference} covers this unit from ${overlap.startDate}${overlap.endDate ? ` to ${overlap.endDate}` : ''}.` });
    }
  }

  private async overlapping(tx: Tx, unitId: string, start: string, end: string | null, exceptId: string | null) {
    let qb = tx
      .selectFrom('leases')
      .select(['reference', 'startDate', 'endDate'])
      .where('unitId', '=', unitId)
      .where('status', 'in', OCCUPYING)
      .where(sql<boolean>`daterange(start_date, coalesce(end_date, 'infinity'::date), '[]') && daterange(${start}::date, coalesce(${end}::date, 'infinity'::date), '[]')`);
    if (exceptId) qb = qb.where('id', '<>', exceptId);
    return qb.executeTakeFirst();
  }

  private async checkParties(tx: Tx, inputs: LeasePartyInput[], errors: FieldError[], requireTenant = true): Promise<LeasePartyInput[]> {
    const seen = new Set<string>();
    inputs.forEach((party, index) => {
      const key = `${party.contactId}:${party.partyRole}`;
      if (seen.has(key)) errors.push({ field: `parties.${index}`, code: 'duplicate', message: 'This contact already has this role.' });
      seen.add(key);
      if (party.isPrimary && !TENANT_ROLES.includes(party.partyRole)) errors.push({ field: `parties.${index}.isPrimary`, code: 'not-tenant', message: 'The primary party is a tenant.' });
      if (party.liabilityShare !== undefined && !TENANT_ROLES.includes(party.partyRole)) errors.push({ field: `parties.${index}.liabilityShare`, code: 'not-tenant', message: 'Shares of the rent are for tenants.' });
    });
    if (requireTenant) {
      const primaries = inputs.filter((p) => p.isPrimary && TENANT_ROLES.includes(p.partyRole));
      if (primaries.length !== 1) errors.push({ field: 'parties', code: 'primary-tenant', message: 'Name exactly one primary tenant.' });
    }
    const ids = [...new Set(inputs.map((p) => p.contactId))];
    if (ids.length > 0) {
      const contacts = await tx.selectFrom('contacts').select(['id', 'isAnonymised', 'mergedIntoContactId', 'archivedAt']).where('id', 'in', ids).execute();
      inputs.forEach((party, index) => {
        const contact = contacts.find((c) => c.id === party.contactId);
        if (!contact) errors.push({ field: `parties.${index}.contactId`, code: 'not-found', message: 'This contact does not exist.' });
        else if (contact.isAnonymised || contact.mergedIntoContactId !== null || contact.archivedAt !== null) {
          errors.push({ field: `parties.${index}.contactId`, code: 'not-active', message: 'This contact is archived, merged or erased.' });
        }
      });
    }
    return inputs;
  }

  private async insert(
    tx: Tx,
    ctx: TenantContext,
    unit: { id: string; jurisdictionCode: string },
    terms: LeaseTerms,
    body: LeaseFromDealBody & { rentFrequency: string; usage?: string },
    dealId: string | null,
  ): Promise<string> {
    const reference = await nextReference(tx, ctx, 'lease');
    const row = await tx
      .insertInto('leases')
      .values({
        companyId: ctx.companyId,
        reference,
        unitId: unit.id,
        managementAgreementId: terms.managementAgreementId,
        listingId: terms.listingId,
        dealId,
        jurisdictionCode: unit.jurisdictionCode,
        leaseType: terms.leaseType,
        usage: body.usage ?? 'residential',
        startDate: terms.startDate,
        endDate: terms.endDate,
        currencyCode: terms.rent.currency,
        rentAmount: terms.rent.amount,
        rentFrequency: body.rentFrequency,
        rentDueDay: terms.rentDueDay,
        advancePeriods: body.advancePeriods ?? 1,
        prorateFirstPeriod: body.prorateFirstPeriod ?? true,
        depositAmount: terms.deposit?.amount ?? null,
        noticePeriodDays: body.noticePeriodDays ?? null,
        breakClauseDate: terms.breakClauseDate,
        breakNoticeDays: body.breakNoticeDays ?? null,
        nextRentReviewDate: terms.nextRentReviewDate,
        governingLocaleCode: terms.governingLocaleCode,
        createdBy: actingMembership(ctx),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** The given parties; without a landlord party, the unit's current legal owners become landlords. */
  private async addParties(tx: Tx, ctx: TenantContext, leaseId: string, unit: { id: string; propertyId: string }, parties: LeasePartyInput[]): Promise<void> {
    const all = [...parties];
    if (!all.some((p) => p.partyRole === 'landlord')) {
      const owners = await tx
        .selectFrom('propertyOwnerships')
        .select('ownerContactId')
        .distinct()
        .where('propertyId', '=', unit.propertyId)
        .where('ownershipType', '=', 'legal_owner')
        .where((eb) => eb.or([eb('unitId', 'is', null), eb('unitId', '=', unit.id)]))
        .where('effectiveFrom', '<=', sql<string>`current_date`)
        .where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>=', sql<string>`current_date`)]))
        .execute();
      for (const owner of owners) if (!all.some((p) => p.contactId === owner.ownerContactId && p.partyRole === 'landlord')) all.push({ contactId: owner.ownerContactId, partyRole: 'landlord', portalAccess: true });
    }
    if (all.length > 0) await tx.insertInto('leaseParties').values(all.map((party) => ({ companyId: ctx.companyId, leaseId, ...partyValues(party) }))).execute();
  }

  /** A lease is ready for signature or activation: a primary tenant, a landlord, and the unit free for its dates. */
  private async assertReady(tx: Tx, lease: { id: string; unitId: string; startDate: string; endDate: string | null }): Promise<void> {
    const parties = await tx.selectFrom('leaseParties').select(['partyRole', 'isPrimary']).where('leaseId', '=', lease.id).execute();
    const errors: FieldError[] = [];
    if (!parties.some((p) => p.isPrimary && TENANT_ROLES.includes(p.partyRole))) errors.push({ field: 'parties', code: 'primary-tenant', message: 'Add the primary tenant.' });
    if (!parties.some((p) => p.partyRole === 'landlord')) errors.push({ field: 'parties', code: 'landlord', message: 'Add the landlord (the unit has no recorded owner).' });
    if (errors.length > 0) throw Problems.validation(errors);
    const overlap = await this.overlapping(tx, lease.unitId, lease.startDate, lease.endDate, lease.id);
    if (overlap) throw Problems.businessRule(`Lease ${overlap.reference} already covers this unit for some of these dates.`);
  }

  /** The rent listing closes as rented (P7-D4), through the pipeline (under contract first if needed). */
  private async rentListing(tx: Tx, ctx: TenantContext, listingId: string, leaseReference: string): Promise<void> {
    const listing = await tx.selectFrom('listings').select('status').where('id', '=', listingId).executeTakeFirstOrThrow();
    if (listing.status === 'rented') return;
    if (listing.status === 'available' || listing.status === 'reserved') await this.listings.pipelineStatus(tx, ctx, listingId, 'under_contract', `Lease ${leaseReference} signed`);
    await this.listings.pipelineStatus(tx, ctx, listingId, 'rented', `Lease ${leaseReference} active`);
  }

  private async recordCreated(tx: Tx, ctx: TenantContext, id: string, dealId: string | null): Promise<void> {
    const lease = await tx.selectFrom('leases').select(['reference', 'unitId', 'listingId', 'managementAgreementId']).where('id', '=', id).executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, { action: 'lease.created', entityType: 'lease', entityId: id, metadata: { reference: lease.reference, unitId: lease.unitId, listingId: lease.listingId, managementAgreementId: lease.managementAgreementId, dealId } });
    await this.audit.emit(tx, ctx, { eventType: 'lease.created', aggregateType: 'lease', aggregateId: id, payload: { leaseId: id, unitId: lease.unitId, dealId } });
  }

  private async touch(tx: Tx, id: string): Promise<void> {
    await tx.updateTable('leases').set({ version: sql`version + 1` }).where('id', '=', id).execute();
  }
}

// ----------------------------------------------------------------------------- shared

function termsOf(body: LeaseFromDealBody, unitId: string, listingId: string | null, rent: MoneyInput): LeaseTerms {
  return {
    unitId,
    managementAgreementId: body.managementAgreementId ?? null,
    listingId,
    leaseType: body.leaseType,
    startDate: body.startDate,
    endDate: body.endDate ?? null,
    rent,
    deposit: body.deposit ?? null,
    rentDueDay: body.rentDueDay ?? null,
    breakClauseDate: body.breakClauseDate ?? null,
    nextRentReviewDate: body.nextRentReviewDate ?? null,
    governingLocaleCode: body.governingLocaleCode ?? null,
  };
}

function partyValues(party: LeasePartyInput) {
  return {
    contactId: party.contactId,
    partyRole: party.partyRole,
    isPrimary: party.isPrimary ?? false,
    liabilityShare: party.liabilityShare !== undefined ? String(party.liabilityShare) : null,
    portalAccess: party.portalAccess ?? true,
  };
}

/** P7-D5: on unless the company stored `false`. */
async function requireSignedLease(tx: Tx): Promise<boolean> {
  const row = await tx.selectFrom('companySettings').select('value').where('officeId', 'is', null).where('key', '=', REQUIRE_SIGNED_LEASE_KEY).executeTakeFirst();
  return row?.value !== false;
}

function summaryQuery(tx: Tx) {
  return tx
    .selectFrom('leases as l')
    .innerJoin('units as u', 'u.id', 'l.unitId')
    .innerJoin('properties as p', 'p.id', 'u.propertyId')
    .leftJoin('leaseParties as pt', (join) => join.onRef('pt.leaseId', '=', 'l.id').on('pt.isPrimary', '=', true).on('pt.partyRole', 'in', TENANT_ROLES))
    .leftJoin('contacts as tc', 'tc.id', 'pt.contactId')
    .select([
      'l.id', 'l.reference', 'l.status', 'l.unitId', 'u.unitLabel', 'u.propertyId', 'p.name as propertyName', 'pt.contactId as tenantId', 'tc.displayName as tenantName',
      'l.rentAmount', 'l.currencyCode', 'l.rentFrequency', 'l.leaseType', 'l.startDate', 'l.endDate', 'l.renewalStatus', 'l.updatedAt',
    ]);
}

type SummaryRow = Awaited<ReturnType<ReturnType<typeof summaryQuery>['executeTakeFirstOrThrow']>>;

function toSummary(row: SummaryRow, minor: Map<string, number>): LeaseSummaryDto {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    unit: { id: row.unitId, name: row.unitLabel },
    property: { id: row.propertyId, name: row.propertyName ?? '' },
    primaryTenant: row.tenantId ? { id: row.tenantId, name: row.tenantName ?? '' } : null,
    rent: toMoney(row.rentAmount, row.currencyCode, minor.get(row.currencyCode) ?? 2),
    rentFrequency: row.rentFrequency,
    leaseType: row.leaseType,
    startDate: row.startDate,
    endDate: row.endDate,
    renewalStatus: row.renewalStatus,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function minorUnits(tx: Tx, codes: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const rows = await tx.selectFrom('currencies').select(['code', 'minorUnits']).where('code', 'in', unique).execute();
  return new Map(rows.map((row) => [row.code, row.minorUnits]));
}

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return normalise(Object.fromEntries(keys.map((key) => [key, row[key]])));
}

/** Numbers as the database returns them (numeric strings at 4 places), for audit comparisons. */
function normalise(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, (key === 'rentAmount' || key === 'depositAmount') && typeof value === 'string' ? Number(value).toFixed(4) : value]),
  );
}
