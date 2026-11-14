import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { type Cursor, encodeCursor, type Page } from '../common/list-query.js';
import { decimalPlaces, toMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { recordSystemActivity } from '../crm/system-activity.js';
import type { Tx } from '../database/database.module.js';
import { onOfferAccepted } from '../deals/deal-effects.js';
import { asPipelineAction, moveDealToStage } from '../deals/deal-stage.js';
import { ListingsService } from '../listings/listings.service.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { canOnDeal, type DealAccessRow, dealScopeSql } from '../deals/deal-access.js';
import { releaseAcceptedOffer } from './offer-effects.js';
import type { CounterOfferBody, OfferDto, RecordOfferBody } from './offers.dto.js';

registerConstraintMessages({
  offers_one_accepted_idx: 'Another offer on this listing is already accepted. Withdraw it before accepting this one.',
});

/** Deal stages before negotiation: recording an offer moves the deal on (readiness report §4.3). */
const STAGES_BEFORE_NEGOTIATION = ['lead', 'qualification', 'viewing'];
const BUYER_ROLES = ['buyer', 'tenant'];
const SELLER_ROLES = ['seller', 'landlord'];

export interface OfferListQuery {
  limit: number;
  cursor: Cursor | null;
  direction: 'asc' | 'desc';
  dealId: string | null;
  listingId: string | null;
  contactId: string | null;
  statuses: string[] | null;
}

type Row = Awaited<ReturnType<ReturnType<OffersService['baseQuery']>['executeTakeFirstOrThrow']>>;
type DealRow = Awaited<ReturnType<OffersService['loadDeal']>>;

/**
 * Offers (Phase 6 milestone S2; SAL-03, journey steps 8–9; readiness report
 * §4.2, P6-D4, P6-D5). Offers are recorded on open deals with a listing, as
 * an immutable chain: a change of terms is a counter-offer. Accepting
 * (offer.accept: company owner and sales managers) moves the deal to "offer
 * accepted" and reserves the listing; withdrawing an accepted offer reverses
 * both. The database enforces the chain, the statuses, one accepted offer per
 * listing and the agreement between offers, deal stage and listing status
 * (migrations 0007, 0030, 0032); this service checks first to answer with
 * field-level codes, and adds scope, the timeline, audit and outbox events.
 */
@Injectable()
export class OffersService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly listings: ListingsService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, query: OfferListQuery): Promise<Page<OfferDto>> {
    let qb = this.baseQuery(tx)
      .select(sql<string>`o.submitted_at::text`.as('cursorValue'))
      .where(dealScopeSql(ctx.permissions.get('offer.view')?.scope, ctx));
    if (query.dealId) qb = qb.where('o.dealId', '=', query.dealId);
    if (query.listingId) qb = qb.where('o.listingId', '=', query.listingId);
    if (query.contactId) qb = qb.where('o.offeredByContactId', '=', query.contactId);
    if (query.statuses) qb = qb.where('o.status', 'in', query.statuses);
    if (query.cursor) {
      const operator = sql.raw(query.direction === 'asc' ? '>' : '<');
      qb = qb.where(sql<boolean>`(o.submitted_at, o.id) ${operator} (${query.cursor.v}::timestamptz, ${query.cursor.id}::uuid)`);
    }
    const rows = await qb.orderBy('o.submittedAt', query.direction).orderBy('o.id', query.direction).limit(query.limit + 1).execute();
    const page = rows.slice(0, query.limit);
    const data = await this.toDtos(tx, ctx, page);
    const last = page[page.length - 1];
    return { data, page: { limit: query.limit, nextCursor: rows.length > query.limit && last ? encodeCursor(last.cursorValue, last.id) : null } };
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<OfferDto> {
    const row = await this.baseQuery(tx).where('o.id', '=', id).executeTakeFirst();
    if (!row || !canOnDeal(ctx, 'offer.view', await this.dealAccess(tx, row))) throw Problems.notFound();
    return (await this.toDtos(tx, ctx, [row]))[0]!;
  }

  // ----------------------------------------------------------------- writing

  async record(tx: Tx, ctx: TenantContext, body: RecordOfferBody): Promise<OfferDto> {
    const deal = await this.loadDeal(tx, body.dealId);
    if (!deal || !canOnDeal(ctx, 'offer.view', deal)) {
      throw Problems.validation([{ field: 'dealId', code: 'not-found', message: 'Choose a deal you can see.' }]);
    }
    if (!canOnDeal(ctx, 'offer.manage', deal)) throw Problems.forbidden('Your role does not allow recording offers on this deal.');
    const direction = body.direction ?? 'from_buyer';
    const errors: FieldError[] = [];
    this.checkDealOpen(deal, errors);
    await this.checkTerms(tx, deal, body, errors);
    await this.checkOfferor(tx, ctx, deal, body.offeredByContactId, direction, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    const id = await this.insertOffer(tx, ctx, deal, body, direction, null);
    if (STAGES_BEFORE_NEGOTIATION.includes(deal.stageClass)) await moveDealToStage(tx, deal, 'negotiation', 'Offer recorded');
    await this.afterNewOffer(tx, ctx, deal, id, body.offeredByContactId, direction, null);
    return this.get(tx, ctx, id);
  }

  /** A change of terms is a counter-offer from the other side; the answered offer becomes "countered". */
  async counter(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: CounterOfferBody): Promise<OfferDto> {
    const { offer, deal } = await this.lockOffer(tx, ctx, id, expectedVersion, 'offer.manage');
    if (offer.status !== 'submitted') throw Problems.businessRule(`This offer is ${offer.status}; only an open offer can be countered.`);
    const direction = offer.direction === 'from_buyer' ? 'from_seller' : 'from_buyer';
    const errors: FieldError[] = [];
    this.checkDealOpen(deal, errors);
    await this.checkTerms(tx, deal, body, errors);
    await this.checkOfferor(tx, ctx, deal, body.offeredByContactId, direction, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    const counterId = await this.insertOffer(tx, ctx, deal, body, direction, offer.id);
    await tx.updateTable('offers').set({ status: 'countered', respondedAt: new Date() }).where('id', '=', offer.id).execute();
    await this.audit.record(tx, ctx, { action: 'offer.countered', entityType: 'offer', entityId: offer.id, changes: { status: { old: 'submitted', new: 'countered' } }, metadata: { counterOfferId: counterId } });
    await this.emit(tx, ctx, 'offer.countered', offer, { counterOfferId: counterId });
    await this.afterNewOffer(tx, ctx, deal, counterId, body.offeredByContactId, direction, offer.id);
    return this.get(tx, ctx, counterId);
  }

  /** P6-D4: only offer.accept (company owner, sales managers); other open offers stay recorded and flagged. */
  async accept(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<OfferDto> {
    const { offer, deal } = await this.lockOffer(tx, ctx, id, expectedVersion, 'offer.accept');
    if (offer.status !== 'submitted') throw Problems.businessRule(`This offer is ${offer.status}; only an open offer can be accepted.`);
    const errors: FieldError[] = [];
    this.checkDealOpen(deal, errors);
    const listing = await tx.selectFrom('listings').select(['status', 'reference']).where('id', '=', offer.listingId).executeTakeFirstOrThrow();
    if (!['available', 'reserved'].includes(listing.status)) {
      errors.push({ field: 'listing', code: 'listing-not-available', message: 'The listing must be available or reserved to accept an offer.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    const other = await tx.selectFrom('offers').select('id').where('listingId', '=', offer.listingId).where('status', '=', 'accepted').executeTakeFirst();
    if (other) throw Problems.conflict('Another offer on this listing is already accepted. Withdraw it before accepting this one.', { type: 'offer', id: other.id });

    await asPipelineAction(tx);
    await tx.updateTable('offers').set({ status: 'accepted', respondedAt: new Date() }).where('id', '=', offer.id).execute();
    await moveDealToStage(tx, deal, 'offer_accepted', 'Offer accepted');
    await this.listings.pipelineStatus(tx, ctx, offer.listingId, 'reserved', 'Offer accepted');
    // S3 (§4.2 note, P6-D6, P6-D7): milestones copied, buyer identity checks started.
    await onOfferAccepted(tx, ctx, this.audit, deal);
    await this.timeline(tx, ctx, deal, offer.offeredByContactId, `Offer accepted: ${listing.reference}, ${await this.amountLabel(tx, offer)}`, null);
    await this.audit.record(tx, ctx, { action: 'offer.accepted', entityType: 'offer', entityId: offer.id, changes: { status: { old: 'submitted', new: 'accepted' } }, metadata: { dealId: deal.id, listingId: offer.listingId } });
    await this.emit(tx, ctx, 'offer.accepted', offer, {});
    return this.get(tx, ctx, offer.id);
  }

  async reject(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string | null): Promise<OfferDto> {
    const { offer, deal } = await this.lockOffer(tx, ctx, id, expectedVersion, 'offer.manage');
    if (offer.status !== 'submitted') throw Problems.businessRule(`This offer is ${offer.status}; only an open offer can be rejected.`);
    await tx.updateTable('offers').set({ status: 'rejected', respondedAt: new Date() }).where('id', '=', offer.id).execute();
    await this.timeline(tx, ctx, deal, offer.offeredByContactId, `Offer rejected: ${await this.amountLabel(tx, offer)}`, reason);
    await this.audit.record(tx, ctx, { action: 'offer.rejected', entityType: 'offer', entityId: offer.id, changes: { status: { old: 'submitted', new: 'rejected' } }, metadata: { dealId: deal.id } });
    await this.emit(tx, ctx, 'offer.rejected', offer, {});
    return this.get(tx, ctx, offer.id);
  }

  /** An open offer is withdrawn by its maker; an accepted one is withdrawn with a reason, reversing the acceptance (§4.3, P6-D5). */
  async withdraw(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string | null): Promise<OfferDto> {
    const { offer, deal } = await this.lockOffer(tx, ctx, id, expectedVersion, 'offer.manage');
    if (offer.status === 'accepted') {
      if (!reason) throw Problems.validation([{ field: 'reason', code: 'required', message: 'Say why the accepted offer is withdrawn.' }]);
      await releaseAcceptedOffer(tx, ctx, this.audit, offer, 'Accepted offer withdrawn');
      await this.listings.pipelineStatus(tx, ctx, offer.listingId, 'available', 'Accepted offer withdrawn');
      await this.timeline(tx, ctx, deal, offer.offeredByContactId, `Accepted offer withdrawn: ${await this.amountLabel(tx, offer)}`, reason);
      return this.get(tx, ctx, offer.id);
    }
    if (offer.status !== 'submitted') throw Problems.businessRule(`This offer is ${offer.status} and cannot be withdrawn.`);
    await tx.updateTable('offers').set({ status: 'withdrawn', respondedAt: new Date() }).where('id', '=', offer.id).execute();
    await this.timeline(tx, ctx, deal, offer.offeredByContactId, `Offer withdrawn: ${await this.amountLabel(tx, offer)}`, reason);
    await this.audit.record(tx, ctx, { action: 'offer.withdrawn', entityType: 'offer', entityId: offer.id, changes: { status: { old: 'submitted', new: 'withdrawn' } }, metadata: { dealId: deal.id, wasAccepted: false } });
    await this.emit(tx, ctx, 'offer.withdrawn', offer, { wasAccepted: false });
    return this.get(tx, ctx, offer.id);
  }

  // ----------------------------------------------------------------- helpers

  private baseQuery(tx: Tx) {
    return tx
      .selectFrom('offers as o')
      .innerJoin('deals as d', 'd.id', 'o.dealId')
      .innerJoin('listings as l', 'l.id', 'o.listingId')
      .innerJoin('contacts as c', 'c.id', 'o.offeredByContactId')
      .innerJoin('currencies as cur', 'cur.code', 'o.currencyCode')
      .innerJoin('companyMemberships as rm', 'rm.id', 'o.recordedBy')
      .innerJoin('users as ru', 'ru.id', 'rm.userId')
      .selectAll('o')
      .select([
        'd.reference as dealReference',
        'd.officeId as dealOfficeId',
        'd.ownerMembershipId as dealOwnerId',
        'l.reference as listingReference',
        'l.title as listingTitle',
        'l.status as listingStatus',
        'c.displayName as offeredByName',
        'cur.minorUnits',
        'ru.displayName as recordedByName',
      ]);
  }

  private async toDtos(tx: Tx, ctx: TenantContext, rows: Row[]): Promise<OfferDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const counters = await tx.selectFrom('offers').select(['id', 'parentOfferId']).where('parentOfferId', 'in', ids).orderBy('submittedAt').execute();
    const listingIds = [...new Set(rows.map((row) => row.listingId))];
    const accepted = await tx.selectFrom('offers').select(['id', 'listingId']).where('listingId', 'in', listingIds).where('status', '=', 'accepted').execute();
    const agents = await this.agentsOf(tx, [...new Set(rows.map((row) => row.dealId))]);
    return rows.map((row) => {
      const access: DealAccessRow = { officeId: row.dealOfficeId, ownerMembershipId: row.dealOwnerId, agentIds: agents.get(row.dealId) ?? [] };
      const open = row.status === 'submitted';
      return {
        id: row.id,
        deal: { id: row.dealId, reference: row.dealReference },
        listing: { id: row.listingId, reference: row.listingReference, title: row.listingTitle, status: row.listingStatus },
        offeredBy: { id: row.offeredByContactId, name: row.offeredByName },
        direction: row.direction,
        amount: toMoney(row.amount, row.currencyCode, row.minorUnits),
        rentFrequency: row.rentFrequency,
        conditions: row.conditions,
        financingCode: row.financingCode,
        status: row.status,
        submittedAt: row.submittedAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        respondedAt: row.respondedAt?.toISOString() ?? null,
        parentOfferId: row.parentOfferId,
        counterOfferIds: counters.filter((c) => c.parentOfferId === row.id).map((c) => c.id),
        otherOfferAccepted: accepted.some((a) => a.listingId === row.listingId && a.id !== row.id),
        recordedBy: { id: row.recordedBy, name: row.recordedByName },
        canManage: (open || row.status === 'accepted') && canOnDeal(ctx, 'offer.manage', access),
        canAccept: open && canOnDeal(ctx, 'offer.accept', access),
        version: row.version,
      };
    });
  }

  private async agentsOf(tx: Tx, dealIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (dealIds.length === 0) return result;
    const rows = await tx.selectFrom('dealAgents').select(['dealId', 'membershipId']).where('dealId', 'in', dealIds).execute();
    for (const row of rows) result.set(row.dealId, [...(result.get(row.dealId) ?? []), row.membershipId]);
    return result;
  }

  private async dealAccess(tx: Tx, row: { dealId: string; dealOfficeId: string; dealOwnerId: string }): Promise<DealAccessRow> {
    return { officeId: row.dealOfficeId, ownerMembershipId: row.dealOwnerId, agentIds: (await this.agentsOf(tx, [row.dealId])).get(row.dealId) ?? [] };
  }

  private async loadDeal(tx: Tx, dealId: string) {
    const deal = await tx
      .selectFrom('deals as d')
      .innerJoin('offices as of', 'of.id', 'd.officeId')
      .select(['d.id', 'd.reference', 'd.dealType', 'd.stageClass', 'd.status', 'd.archivedAt', 'd.listingId', 'd.unitId', 'd.leadId', 'd.primaryContactId', 'd.currencyCode', 'd.officeId', 'd.ownerMembershipId', 'of.countryCode'])
      .where('d.id', '=', dealId)
      .executeTakeFirst();
    if (!deal) return null;
    return { ...deal, agentIds: (await this.agentsOf(tx, [deal.id])).get(deal.id) ?? [] };
  }

  /** The offer locked for an action, with its deal, after scope (404 / 403) and version checks. */
  private async lockOffer(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, permission: 'offer.manage' | 'offer.accept') {
    const offer = await tx.selectFrom('offers').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    const deal = offer ? await this.loadDeal(tx, offer.dealId) : null;
    if (!offer || !deal || !canOnDeal(ctx, 'offer.view', deal)) throw Problems.notFound();
    if (!canOnDeal(ctx, permission, deal)) {
      throw Problems.forbidden(permission === 'offer.accept' ? 'Accepting offers is for the company owner and sales managers.' : 'Your role does not allow this action on this offer.');
    }
    if (offer.version !== expectedVersion) throw Problems.preconditionFailed();
    return { offer, deal };
  }

  private checkDealOpen(deal: NonNullable<DealRow>, errors: FieldError[]): void {
    if (deal.status !== 'open' || deal.archivedAt !== null) errors.push({ field: 'dealId', code: 'deal-closed', message: 'This deal is closed.' });
    if (deal.listingId === null) errors.push({ field: 'dealId', code: 'deal-without-listing', message: 'Link the deal to a listing before recording offers.' });
  }

  /** Amount in the deal's currency (minor units), rent frequency for lettings only, financing from the picklist, expiry in the future. */
  private async checkTerms(tx: Tx, deal: NonNullable<DealRow>, body: RecordOfferBody | CounterOfferBody, errors: FieldError[]): Promise<void> {
    if (body.amount.currency !== deal.currencyCode) {
      errors.push({ field: 'amount.currency', code: 'currency-mismatch', message: `Offers on this deal are in ${deal.currencyCode}.` });
    } else {
      const currency = await tx.selectFrom('currencies').select('minorUnits').where('code', '=', deal.currencyCode).executeTakeFirstOrThrow();
      if (decimalPlaces(body.amount.amount) > currency.minorUnits) {
        errors.push({ field: 'amount.amount', code: 'precision', message: `${deal.currencyCode} has ${currency.minorUnits} decimal places.` });
      }
      if (Number(body.amount.amount) <= 0) errors.push({ field: 'amount.amount', code: 'positive', message: 'The amount must be more than zero.' });
    }
    if (deal.dealType === 'letting' && !body.rentFrequency) {
      errors.push({ field: 'rentFrequency', code: 'required', message: 'Say how often the rent is paid.' });
    }
    if (deal.dealType === 'sale' && body.rentFrequency) {
      errors.push({ field: 'rentFrequency', code: 'not-applicable', message: 'A sale offer has no rent frequency.' });
    }
    if (body.financingCode) {
      const error = await checkPicklistCode(tx, 'financing', body.financingCode, deal.countryCode, 'financingCode');
      if (error) errors.push(error);
    }
    if (body.expiresAt && new Date(body.expiresAt).getTime() <= Date.now()) {
      errors.push({ field: 'expiresAt', code: 'in-past', message: 'The expiry time must be in the future.' });
    }
  }

  /**
   * The offeror is on the right side of the deal: buyer side = the deal's
   * primary contact or a buyer or tenant party; seller side = a seller or
   * landlord party or a current owner of the unit. Being on the deal is what
   * links the contact to the member's deal; any other contact is refused
   * (not-found when the member cannot see it).
   */
  private async checkOfferor(tx: Tx, ctx: TenantContext, deal: NonNullable<DealRow>, contactId: string, direction: string, errors: FieldError[]): Promise<void> {
    const contact = await this.contacts.loadRow(tx, contactId);
    const roles = contact ? (await tx.selectFrom('dealParties').select('partyRole').where('dealId', '=', deal.id).where('contactId', '=', contactId).execute()).map((row) => row.partyRole) : [];
    const owners =
      contact && deal.unitId
        ? (await sql<{ ownerContactId: string }>`select owner_contact_id from app.unit_current_owners(${deal.unitId}::uuid)`.execute(tx)).rows.map((row) => row.ownerContactId)
        : [];
    const buyerSide = deal.primaryContactId === contactId || roles.some((role) => BUYER_ROLES.includes(role));
    const sellerSide = roles.some((role) => SELLER_ROLES.includes(role)) || owners.includes(contactId);
    const onDeal = buyerSide || sellerSide || roles.length > 0;
    if (!contact || (!onDeal && !(await this.contacts.canRead(tx, ctx, contact)))) {
      errors.push({ field: 'offeredByContactId', code: 'not-found', message: 'Choose a contact you can see.' });
      return;
    }
    if (direction === 'from_buyer' ? !buyerSide : !sellerSide) {
      errors.push({
        field: 'offeredByContactId',
        code: direction === 'from_buyer' ? 'not-buyer-side' : 'not-seller-side',
        message: direction === 'from_buyer' ? 'The offer comes from the deal\'s buyer or tenant.' : 'The offer comes from the seller or landlord (a party of the deal or a current owner).',
      });
    }
  }

  private async insertOffer(tx: Tx, ctx: TenantContext, deal: NonNullable<DealRow>, body: RecordOfferBody | CounterOfferBody, direction: string, parentId: string | null): Promise<string> {
    const inserted = await tx
      .insertInto('offers')
      .values({
        companyId: ctx.companyId,
        dealId: deal.id,
        listingId: deal.listingId!,
        offeredByContactId: body.offeredByContactId,
        direction,
        parentOfferId: parentId,
        currencyCode: deal.currencyCode,
        amount: body.amount.amount,
        rentFrequency: body.rentFrequency ?? null,
        conditions: body.conditions === undefined || body.conditions === '' ? null : body.conditions,
        financingCode: body.financingCode ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        recordedBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  private async afterNewOffer(tx: Tx, ctx: TenantContext, deal: NonNullable<DealRow>, id: string, contactId: string, direction: string, parentId: string | null): Promise<void> {
    const offer = await tx.selectFrom('offers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const listing = await tx.selectFrom('listings').select('reference').where('id', '=', offer.listingId).executeTakeFirstOrThrow();
    await this.timeline(tx, ctx, deal, contactId, `${parentId ? 'Counter-offer' : 'Offer'} recorded: ${listing.reference}, ${await this.amountLabel(tx, offer)}`, null);
    await this.audit.record(tx, ctx, {
      action: 'offer.submitted',
      entityType: 'offer',
      entityId: id,
      metadata: { dealId: deal.id, listingId: offer.listingId, direction, parentOfferId: parentId, amount: offer.amount, currency: offer.currencyCode, expiresAt: offer.expiresAt?.toISOString() ?? null },
    });
    await this.emit(tx, ctx, 'offer.submitted', offer, { direction, parentOfferId: parentId, expiresAt: offer.expiresAt?.toISOString() ?? null });
  }

  /** System entries on the timeline of the listing, the offeror and the deal's lead; free text (a reason) is kept here, never in audit. */
  private async timeline(tx: Tx, ctx: TenantContext, deal: NonNullable<DealRow>, contactId: string, subject: string, body: string | null): Promise<void> {
    await recordSystemActivity(tx, ctx, {
      activityType: 'system',
      subject,
      body,
      links: [
        { entityType: 'listing', entityId: deal.listingId! },
        { entityType: 'contact', entityId: contactId },
        ...(deal.leadId ? [{ entityType: 'lead' as const, entityId: deal.leadId }] : []),
      ],
    });
  }

  private async amountLabel(tx: Tx, offer: { amount: string; currencyCode: string; rentFrequency: string | null }): Promise<string> {
    const currency = await tx.selectFrom('currencies').select('minorUnits').where('code', '=', offer.currencyCode).executeTakeFirstOrThrow();
    const money = toMoney(offer.amount, offer.currencyCode, currency.minorUnits);
    return `${money.currency} ${money.amount}${offer.rentFrequency ? ` ${offer.rentFrequency.replace('_', '-')}` : ''}`;
  }

  private async emit(tx: Tx, ctx: TenantContext, eventType: string, offer: { id: string; dealId: string; listingId: string }, payload: Record<string, unknown>): Promise<void> {
    await this.audit.emit(tx, ctx, { eventType, aggregateType: 'offer', aggregateId: offer.id, payload: { offerId: offer.id, dealId: offer.dealId, listingId: offer.listingId, ...payload } });
  }
}

/**
 * Worker job offer.expire: open offers past their expiry time become expired
 * (readiness report §4.2). The deal and listing are unchanged: an open offer
 * does not move them.
 */
export async function expireOffers(tx: Tx, ctx: TenantContext, audit: AuditService, now: Date = new Date()): Promise<number> {
  const due = await tx
    .updateTable('offers')
    .set({ status: 'expired', respondedAt: now })
    .where('status', '=', 'submitted')
    .where('expiresAt', '<=', now)
    .returning(['id', 'dealId', 'listingId', 'expiresAt'])
    .execute();
  for (const offer of due) {
    await audit.record(tx, ctx, { action: 'offer.expired', entityType: 'offer', entityId: offer.id, changes: { status: { old: 'submitted', new: 'expired' } }, metadata: { dealId: offer.dealId, expiresAt: offer.expiresAt?.toISOString() ?? null } });
    await audit.emit(tx, ctx, { eventType: 'offer.expired', aggregateType: 'offer', aggregateId: offer.id, payload: { offerId: offer.id, dealId: offer.dealId, listingId: offer.listingId } });
  }
  return due.length;
}
