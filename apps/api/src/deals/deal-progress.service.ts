import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { todayIn } from '../common/dates.js';
import { toMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { ListingsService } from '../listings/listings.service.js';
import { releaseAcceptedOffer } from '../offers/offer-effects.js';
import { ownersVerified } from '../properties/owner-identity.js';
import { nextReference } from '../properties/properties.service.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { addDays, sideContacts } from './deal-effects.js';
import { asPipelineAction, moveDealToStage, type StageClass } from './deal-stage.js';
import { checkMoney, type DealRow, dealTimeline, isRealDate, lockDeal, stageOfClass } from './deals.service.js';
import type { CompleteBody, ExchangeBody, LoseDealBody } from './deals.dto.js';

interface Place {
  timezone: string;
  propertyId: string;
}

interface OwnershipPlan {
  ending: Array<{ id: string; ownerContactId: string }>;
  unitId: string | null;
  buyers: Array<{ contactId: string; sharePercent: string }>;
}

/**
 * Exchange, completion and losing a deal (Phase 6 milestone S3; journey steps
 * 10–11; readiness report §4.3, §5; P6-D5 to P6-D8). Each action changes the
 * sales record, the deal stage and the listing status in one transaction;
 * the database checks that they agree at commit (migrations 0032, 0033).
 */
@Injectable()
export class DealProgressService {
  constructor(
    private readonly listings: ListingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Contracts exchanged (sale deals at "offer accepted", deal.update): the
   * sales record is made from the accepted offer, the deal moves to contract
   * and the listing goes under contract. Every buyer's identity must be
   * verified where the jurisdiction requires it (P6-D6).
   */
  async exchange(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: ExchangeBody): Promise<string> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.update');
    if (deal.dealType !== 'sale') throw Problems.businessRule('Letting deals stop at "terms agreed" until leases are available (Phase 7).');
    if (deal.stageClass !== 'offer_accepted') throw Problems.businessRule('Contracts are exchanged once an offer is accepted.');
    const offer = await tx.selectFrom('offers').selectAll().where('dealId', '=', id).where('status', '=', 'accepted').executeTakeFirstOrThrow();
    const place = await this.place(tx, deal);
    const today = todayIn(place.timezone);
    const errors: FieldError[] = [];
    if (!isRealDate(body.contractSignedOn)) errors.push({ field: 'contractSignedOn', code: 'invalid', message: 'Use a real date such as 2026-11-14.' });
    else if (body.contractSignedOn > today) errors.push({ field: 'contractSignedOn', code: 'future', message: 'Record the exchange once contracts are signed.' });
    if (body.completionDueOn !== undefined) {
      if (!isRealDate(body.completionDueOn)) errors.push({ field: 'completionDueOn', code: 'invalid', message: 'Use a real date such as 2027-01-31.' });
      else if (body.completionDueOn < body.contractSignedOn) errors.push({ field: 'completionDueOn', code: 'before-contract', message: 'Completion is due on or after the exchange.' });
    }
    if (body.agencyFee) await checkMoney(tx, body.agencyFee, deal.currencyCode, 'agencyFee', errors);
    const { rows } = await sql<{ required: boolean }>`select app.deal_identity_required(${ctx.companyId}::uuid, ${id}::uuid) as required`.execute(tx);
    if (rows[0]?.required) {
      const buyers = await sideContacts(tx, ctx.companyId, id, 'buyer');
      const verified = await ownersVerified(tx, buyers);
      for (const contactId of buyers) {
        if (verified.get(contactId) !== true) {
          errors.push({ field: `buyerIdentity.${contactId}`, code: 'unverified', message: "A buyer's identity is not verified. Sign off their identity check before exchanging contracts." });
        }
      }
    }
    if (errors.length > 0) throw Problems.validation(errors);

    const reference = await nextReference(tx, ctx, 'sale');
    const sale = await tx
      .insertInto('salesTransactions')
      .values({
        companyId: ctx.companyId,
        reference,
        dealId: id,
        listingId: offer.listingId,
        unitId: deal.unitId!,
        acceptedOfferId: offer.id,
        currencyCode: offer.currencyCode,
        agreedPrice: offer.amount,
        agencyFee: body.agencyFee?.amount ?? deal.expectedFee,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('salesTransactions')
      .set({ status: 'exchanged', contractSignedOn: body.contractSignedOn, completionDueOn: body.completionDueOn ?? null })
      .where('id', '=', sale.id)
      .execute();
    await asPipelineAction(tx);
    await moveDealToStage(tx, deal, 'contract', 'Contracts exchanged');
    await this.listings.pipelineStatus(tx, ctx, offer.listingId, 'under_contract', 'Contracts exchanged');
    await dealTimeline(tx, ctx, deal, `Contracts exchanged: ${reference}`, null);
    await this.audit.record(tx, ctx, {
      action: 'sale.recorded',
      entityType: 'sale',
      entityId: sale.id,
      metadata: { dealId: id, listingId: offer.listingId, acceptedOfferId: offer.id, agreedPrice: offer.amount, currency: offer.currencyCode },
    });
    await this.audit.record(tx, ctx, {
      action: 'sale.exchanged',
      entityType: 'sale',
      entityId: sale.id,
      changes: { status: { old: 'pending', new: 'exchanged' } },
      metadata: { dealId: id, contractSignedOn: body.contractSignedOn, completionDueOn: body.completionDueOn ?? null },
    });
    await this.audit.record(tx, ctx, { action: 'deal.stage_changed', entityType: 'deal', entityId: id, metadata: { fromStageClass: 'offer_accepted', toStageClass: 'contract', saleId: sale.id } });
    await this.audit.emit(tx, ctx, { eventType: 'sale.exchanged', aggregateType: 'sale', aggregateId: sale.id, payload: { saleId: sale.id, dealId: id, listingId: offer.listingId } });
    return id;
  }

  /**
   * Completion (sale deals at contract, deal.close): required milestones must
   * be done (P6-D7); the sale is completed, the deal won and the listing sold;
   * by default the ownership passes to the buyers on the completion day (P6-D8).
   */
  async complete(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: CompleteBody): Promise<string> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.close');
    if (deal.dealType !== 'sale') throw Problems.businessRule('Letting deals stop at "terms agreed" until leases are available (Phase 7).');
    if (deal.stageClass !== 'contract') throw Problems.businessRule('A sale completes once contracts are exchanged.');
    const sale = await tx.selectFrom('salesTransactions').selectAll().where('dealId', '=', id).forUpdate().executeTakeFirstOrThrow();
    const place = await this.place(tx, deal);
    const today = todayIn(place.timezone);
    const errors: FieldError[] = [];
    if (!isRealDate(body.completedOn)) errors.push({ field: 'completedOn', code: 'invalid', message: 'Use a real date such as 2027-01-31.' });
    else if (body.completedOn > today) errors.push({ field: 'completedOn', code: 'future', message: 'Record the completion once it has happened.' });
    else if (sale.contractSignedOn !== null && body.completedOn < sale.contractSignedOn) {
      errors.push({ field: 'completedOn', code: 'before-contract', message: 'Completion is on or after the exchange.' });
    }
    const open = await tx.selectFrom('dealMilestones').select(['code', 'name']).where('dealId', '=', id).where('isRequired', '=', true).where('completedAt', 'is', null).orderBy('sortOrder').execute();
    for (const milestone of open) {
      errors.push({ field: `milestones.${milestone.code}`, code: 'incomplete', message: `${milestone.name} is not done yet.` });
    }
    const transfer = body.transferOwnership ?? true;
    const plan = transfer && errors.length === 0 ? await this.ownershipPlan(tx, deal, place, body.completedOn, errors) : null;
    if (errors.length > 0) throw Problems.validation(errors);

    await tx
      .updateTable('salesTransactions')
      .set({ status: 'completed', completedOn: body.completedOn, titleTransferRef: body.titleTransferRef ?? sale.titleTransferRef })
      .where('id', '=', sale.id)
      .execute();
    await asPipelineAction(tx);
    await this.close(tx, deal, 'closed_won', 'Sale completed', {});
    await this.listings.pipelineStatus(tx, ctx, sale.listingId, 'sold', 'Sale completed');
    if (plan) await this.transferOwnership(tx, ctx, deal, place, sale, body.completedOn, plan);
    const minor = await tx.selectFrom('currencies').select('minorUnits').where('code', '=', sale.currencyCode).executeTakeFirstOrThrow();
    const price = toMoney(sale.agreedPrice, sale.currencyCode, minor.minorUnits);
    await dealTimeline(tx, ctx, deal, `Sale completed: ${sale.reference}, ${price.currency} ${price.amount}`, null);
    await this.audit.record(tx, ctx, {
      action: 'sale.completed',
      entityType: 'sale',
      entityId: sale.id,
      changes: { status: { old: 'exchanged', new: 'completed' } },
      metadata: { dealId: id, completedOn: body.completedOn, ownershipTransferred: plan !== null },
    });
    await this.audit.record(tx, ctx, { action: 'deal.won', entityType: 'deal', entityId: id, metadata: { saleId: sale.id, fromStageClass: 'contract' } });
    await this.audit.emit(tx, ctx, { eventType: 'sale.completed', aggregateType: 'sale', aggregateId: sale.id, payload: { saleId: sale.id, dealId: id, listingId: sale.listingId } });
    await this.audit.emit(tx, ctx, { eventType: 'deal.won', aggregateType: 'deal', aggregateId: id, payload: { dealId: id, saleId: sale.id } });
    return id;
  }

  /**
   * Losing a deal (deal.close) from any open stage, with a reason code. An
   * accepted offer is withdrawn and the listing returns to available; an
   * exchanged sale falls through (the notes, or the reason, are kept on it);
   * open offers on the deal are withdrawn. Closed deals never reopen.
   */
  async lose(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: LoseDealBody): Promise<string> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.close');
    const reason = await checkPicklistCode(tx, 'lost_reason', body.lostReasonCode, deal.countryCode, 'lostReasonCode');
    if (reason) throw Problems.validation([reason]);
    const label = await tx.selectFrom('picklistValues').select('label').where('listKey', '=', 'lost_reason').where('code', '=', body.lostReasonCode).orderBy(sql`company_id is null`).executeTakeFirst();
    const notes = body.notes ?? null;
    const fromClass = deal.stageClass as StageClass;

    await asPipelineAction(tx);
    const sale = await tx.selectFrom('salesTransactions').select(['id', 'status', 'listingId']).where('dealId', '=', id).forUpdate().executeTakeFirst();
    if (sale?.status === 'exchanged') {
      await tx.updateTable('salesTransactions').set({ status: 'fallen_through', fallenThroughReason: notes ?? label?.label ?? body.lostReasonCode }).where('id', '=', sale.id).execute();
      await this.audit.record(tx, ctx, { action: 'sale.fallen_through', entityType: 'sale', entityId: sale.id, changes: { status: { old: 'exchanged', new: 'fallen_through' } }, metadata: { dealId: id, lostReasonCode: body.lostReasonCode } });
      await this.audit.emit(tx, ctx, { eventType: 'sale.fallen_through', aggregateType: 'sale', aggregateId: sale.id, payload: { saleId: sale.id, dealId: id } });
    }
    const accepted = await tx.selectFrom('offers').select(['id', 'dealId', 'listingId']).where('dealId', '=', id).where('status', '=', 'accepted').executeTakeFirst();
    if (accepted) await releaseAcceptedOffer(tx, ctx, this.audit, accepted, null, 'deal-lost');
    const pending = await tx.updateTable('offers').set({ status: 'withdrawn', respondedAt: new Date() }).where('dealId', '=', id).where('status', '=', 'submitted').returning(['id', 'listingId']).execute();
    for (const offer of pending) {
      await this.audit.record(tx, ctx, { action: 'offer.withdrawn', entityType: 'offer', entityId: offer.id, changes: { status: { old: 'submitted', new: 'withdrawn' } }, metadata: { dealId: id, wasAccepted: false, cause: 'deal-lost' } });
      await this.audit.emit(tx, ctx, { eventType: 'offer.withdrawn', aggregateType: 'offer', aggregateId: offer.id, payload: { offerId: offer.id, dealId: id, listingId: offer.listingId, wasAccepted: false } });
    }
    await this.close(tx, deal, 'closed_lost', `Deal lost: ${label?.label ?? body.lostReasonCode}`, { lostReasonCode: body.lostReasonCode, lostNotes: notes });
    if (accepted) {
      await this.listings.pipelineStatus(tx, ctx, accepted.listingId, 'available', sale?.status === 'exchanged' ? 'Sale fell through' : 'Deal lost');
    }
    await dealTimeline(tx, ctx, deal, `Deal ${deal.reference} lost: ${label?.label ?? body.lostReasonCode}`, notes);
    await this.audit.record(tx, ctx, {
      action: 'deal.lost',
      entityType: 'deal',
      entityId: id,
      metadata: { lostReasonCode: body.lostReasonCode, fromStageClass: fromClass, acceptedOfferId: accepted?.id ?? null, saleId: sale?.status === 'exchanged' ? sale.id : null, offersWithdrawn: pending.length },
    });
    await this.audit.emit(tx, ctx, { eventType: 'deal.lost', aggregateType: 'deal', aggregateId: id, payload: { dealId: id, lostReasonCode: body.lostReasonCode } });
    return id;
  }

  // ----------------------------------------------------------------- helpers

  /** Closes the deal: closed stage, close time and (for a loss) the reason, in one update; the note goes to the stage history. */
  private async close(tx: Tx, deal: DealRow, stageClass: 'closed_won' | 'closed_lost', note: string, extra: { lostReasonCode?: string; lostNotes?: string | null }): Promise<void> {
    const stage = await stageOfClass(tx, deal.dealType, stageClass);
    if (!stage) throw Problems.businessRule('No active closing stage is set up for this kind of deal.');
    await sql`select set_config('app.stage_note', ${note}, true)`.execute(tx);
    await tx
      .updateTable('deals')
      .set({ stageId: stage.id, closedAt: sql<Date>`now()`, ...(extra.lostReasonCode ? { lostReasonCode: extra.lostReasonCode, lostNotes: extra.lostNotes ?? null } : {}) })
      .where('id', '=', deal.id)
      .execute();
  }

  private async place(tx: Tx, deal: DealRow): Promise<Place> {
    const row = await tx
      .selectFrom('units as u')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .select(['p.timezone', 'p.id as propertyId'])
      .where('u.id', '=', deal.unitId!)
      .executeTakeFirstOrThrow();
    return row;
  }

  /**
   * P6-D8: who owns the unit before and after. The legal-owner records that
   * cover the unit on the completion day end the day before; the buyers
   * (primary contact and buyer parties) become owners in equal shares from
   * the completion day, for the same unit or whole property the ended records
   * covered. A whole-property record over several units cannot be split
   * here: record that change on the property's Ownership tab instead.
   */
  private async ownershipPlan(tx: Tx, deal: DealRow, place: Place, completedOn: string, errors: FieldError[]): Promise<OwnershipPlan | null> {
    const current = await tx
      .selectFrom('propertyOwnerships')
      .select(['id', 'ownerContactId', 'unitId', 'effectiveFrom'])
      .where('propertyId', '=', place.propertyId)
      .where('ownershipType', '=', 'legal_owner')
      .where((eb) => eb.or([eb('unitId', 'is', null), eb('unitId', '=', deal.unitId!)]))
      .where('effectiveFrom', '<=', completedOn)
      .where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>=', completedOn)]))
      .orderBy('effectiveFrom')
      .orderBy('id')
      .forUpdate()
      .execute();
    const units = await tx.selectFrom('units').select('id').where('propertyId', '=', place.propertyId).where('archivedAt', 'is', null).execute();
    if (current.some((row) => row.unitId === null) && units.length > 1) {
      errors.push({ field: 'transferOwnership', code: 'ownership-shared', message: 'The owners hold the whole property, which has several units. Record the change on the Ownership tab, then complete without the transfer.' });
      return null;
    }
    if (current.some((row) => row.effectiveFrom >= completedOn)) {
      errors.push({ field: 'transferOwnership', code: 'ownership-starts-on-completion', message: 'An ownership record starts on the completion day. Check the Ownership tab.' });
      return null;
    }
    const buyerIds = await sideContacts(tx, deal.companyId, deal.id, 'buyer');
    const contacts = await tx.selectFrom('contacts').select(['id', 'isAnonymised', 'mergedIntoContactId', 'archivedAt']).where('id', 'in', buyerIds).execute();
    for (const contact of contacts) {
      if (contact.isAnonymised || contact.mergedIntoContactId !== null || contact.archivedAt !== null) {
        errors.push({ field: `buyers.${contact.id}`, code: 'not-active', message: 'A buyer is archived, merged or erased and cannot be recorded as an owner.' });
      }
    }
    if (errors.length > 0) return null;
    const unitId = current.length > 0 ? (current.every((row) => row.unitId === null) ? null : deal.unitId) : units.length > 1 ? deal.unitId : null;
    return { ending: current.map((row) => ({ id: row.id, ownerContactId: row.ownerContactId })), unitId, buyers: equalShares(buyerIds) };
  }

  private async transferOwnership(tx: Tx, ctx: TenantContext, deal: DealRow, place: Place, sale: { id: string; reference: string }, completedOn: string, plan: OwnershipPlan): Promise<void> {
    const lastDay = addDays(completedOn, -1);
    const reason = `Sold: ${sale.reference}`;
    for (const record of plan.ending) {
      await tx
        .updateTable('propertyOwnerships')
        .set({ effectiveTo: lastDay, endedBy: ctx.membershipId, endedAt: sql<Date>`now()`, endReason: reason })
        .where('id', '=', record.id)
        .execute();
      await this.audit.record(tx, ctx, {
        action: 'property.ownership_ended',
        entityType: 'property',
        entityId: place.propertyId,
        changes: { effectiveTo: { old: null, new: lastDay } },
        metadata: { ownershipId: record.id, dealId: deal.id, saleId: sale.id },
      });
    }
    for (const buyer of plan.buyers) {
      const inserted = await tx
        .insertInto('propertyOwnerships')
        .values({ companyId: ctx.companyId, propertyId: place.propertyId, unitId: plan.unitId, ownerContactId: buyer.contactId, sharePercent: buyer.sharePercent, ownershipType: 'legal_owner', effectiveFrom: completedOn, createdBy: ctx.membershipId })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, {
        action: 'property.ownership_added',
        entityType: 'property',
        entityId: place.propertyId,
        metadata: { ownershipId: inserted.id, unitId: plan.unitId, ownerContactId: buyer.contactId, sharePercent: Number(buyer.sharePercent), ownershipType: 'legal_owner', effectiveFrom: completedOn, dealId: deal.id, saleId: sale.id },
      });
    }
    await this.audit.emit(tx, ctx, { eventType: 'property.ownership_changed', aggregateType: 'property', aggregateId: place.propertyId, payload: { propertyId: place.propertyId, change: 'transferred', saleId: sale.id } });
  }
}

/** Equal shares adding up to exactly 100 % at 4 decimal places; the first buyer takes the remainder. */
export function equalShares(contactIds: readonly string[]): Array<{ contactId: string; sharePercent: string }> {
  const total = 1_000_000;
  const each = Math.floor(total / contactIds.length);
  return contactIds.map((contactId, index) => {
    const share = index === 0 ? total - each * (contactIds.length - 1) : each;
    return { contactId, sharePercent: (share / 10_000).toFixed(4) };
  });
}
