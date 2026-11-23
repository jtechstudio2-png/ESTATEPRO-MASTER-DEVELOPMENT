import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { toMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { checkCurrencyAmount, isRealDate } from './agreements.service.js';
import { canOnLease, leaseAccess } from './lettings-access.js';
import type { RentReviewDto, ScheduleReviewBody, UpdateReviewBody } from './rent.dto.js';

registerConstraintMessages({
  rent_reviews_one_open_idx: 'This lease already has an open rent review. Finish or cancel it first.',
});

const OPEN = ['scheduled', 'proposed', 'agreed', 'disputed'];
const REVIEWABLE = ['pending_signature', 'active', 'periodic', 'notice_given'];
const LIVE = ['active', 'periodic', 'notice_given'];
const TRANSITIONS: Record<string, readonly string[]> = {
  propose: ['scheduled', 'proposed', 'disputed'],
  agree: ['scheduled', 'proposed', 'disputed'],
  dispute: ['proposed'],
  cancel: ['scheduled', 'proposed', 'agreed', 'disputed'],
  edit: ['scheduled', 'proposed', 'disputed'],
};

/**
 * Rent reviews (LET-08; wireframe RR-1; readiness §5.6): scheduled → proposed
 * → agreed → applied, with disputes and cancellation on the way. An applied
 * review sets the rent of every period from its effective date (charges
 * already raised never change, migration 0037). The proposal and the "review
 * due" notice go to the outbox; delivery comes with Phase 12. Viewing needs
 * lease.view, acting lease.update, on the lease.
 */
@Injectable()
export class RentReviewsService {
  constructor(private readonly audit: AuditService) {}

  async list(tx: Tx, ctx: TenantContext, leaseId: string): Promise<RentReviewDto[]> {
    const lease = await this.lease(tx, ctx, leaseId, false);
    const rows = await reviewQuery(tx).where('r.leaseId', '=', leaseId).orderBy('r.reviewDate', 'desc').orderBy('r.id', 'desc').execute();
    return rows.map((row) => toReview(row, lease.minor));
  }

  async schedule(tx: Tx, ctx: TenantContext, leaseId: string, body: ScheduleReviewBody): Promise<RentReviewDto> {
    const lease = await this.lease(tx, ctx, leaseId, true);
    if (!REVIEWABLE.includes(lease.status)) throw Problems.businessRule('Rent reviews are scheduled for a signed or live lease.');
    const errors: FieldError[] = [];
    if (!isRealDate(body.reviewDate)) errors.push({ field: 'reviewDate', code: 'invalid', message: 'Use a real date such as 2027-01-01.' });
    else if (body.reviewDate < lease.startDate) errors.push({ field: 'reviewDate', code: 'before-start', message: `The lease starts on ${lease.startDate}.` });
    if (errors.length > 0) throw Problems.validation(errors);
    const open = await tx.selectFrom('rentReviews').select('id').where('leaseId', '=', leaseId).where('status', 'in', OPEN).executeTakeFirst();
    if (open) throw Problems.conflict('This lease already has an open rent review. Finish or cancel it first.');
    const inserted = await tx
      .insertInto('rentReviews')
      .values({
        companyId: ctx.companyId,
        leaseId,
        reviewDate: body.reviewDate,
        method: body.method,
        oldAmount: sql<string>`app.rent_in_force(${ctx.companyId}::uuid, ${leaseId}::uuid, ${body.reviewDate}::date)`,
        notes: body.notes?.trim() || null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, { action: 'rent_review.scheduled', entityType: 'rent_review', entityId: inserted.id, metadata: { leaseId, reviewDate: body.reviewDate, method: body.method } });
    await this.audit.emit(tx, ctx, { eventType: 'rent_review.scheduled', aggregateType: 'rent_review', aggregateId: inserted.id, payload: { rentReviewId: inserted.id, leaseId, reviewDate: body.reviewDate } });
    return this.get(tx, inserted.id, lease.minor);
  }

  async update(tx: Tx, ctx: TenantContext, leaseId: string, reviewId: string, expectedVersion: number, body: UpdateReviewBody): Promise<RentReviewDto> {
    const lease = await this.lease(tx, ctx, leaseId, true);
    const review = await this.lockReview(tx, leaseId, reviewId, expectedVersion);
    if (!TRANSITIONS[body.action]!.includes(review.status)) throw Problems.businessRule(`A ${review.status} review cannot be ${pastTense(body.action)}.`);
    const errors: FieldError[] = [];
    const set: Record<string, unknown> = {};
    let next = review.status;
    if (body.action === 'edit') {
      if (body.reviewDate !== undefined) {
        if (!isRealDate(body.reviewDate)) errors.push({ field: 'reviewDate', code: 'invalid', message: 'Use a real date such as 2027-01-01.' });
        else if (body.reviewDate < lease.startDate) errors.push({ field: 'reviewDate', code: 'before-start', message: `The lease starts on ${lease.startDate}.` });
        else set['reviewDate'] = body.reviewDate;
      }
      if (body.method !== undefined) set['method'] = body.method;
      if (body.notes !== undefined) set['notes'] = body.notes?.trim() || null;
      if (body.reviewDate === undefined && body.method === undefined && body.notes === undefined) errors.push({ field: 'action', code: 'nothing', message: 'Give the review date, method or notes to change.' });
    } else if (body.action === 'propose') {
      if (!body.proposed) errors.push({ field: 'proposed', code: 'required', message: 'Give the proposed rent.' });
      else await checkCurrencyAmount(tx, body.proposed, lease.currencyCode, 'proposed', errors, true);
      set['proposedAmount'] = body.proposed?.amount;
      next = 'proposed';
    } else if (body.action === 'agree') {
      if (!body.agreed) errors.push({ field: 'agreed', code: 'required', message: 'Give the agreed rent.' });
      else await checkCurrencyAmount(tx, body.agreed, lease.currencyCode, 'agreed', errors, true);
      if (!body.effectiveFrom) errors.push({ field: 'effectiveFrom', code: 'required', message: 'Give the date the new rent applies from.' });
      else if (!isRealDate(body.effectiveFrom)) errors.push({ field: 'effectiveFrom', code: 'invalid', message: 'Use a real date such as 2027-01-01.' });
      else if (body.effectiveFrom < lease.startDate) errors.push({ field: 'effectiveFrom', code: 'before-start', message: `The lease starts on ${lease.startDate}.` });
      else {
        const charged = await lastChargedFrom(tx, leaseId, body.effectiveFrom);
        if (charged) errors.push({ field: 'effectiveFrom', code: 'already-charged', message: `Rent is already charged for the period from ${charged}. Choose a later date, or adjust those charges.` });
      }
      set['agreedAmount'] = body.agreed?.amount;
      set['effectiveFrom'] = body.effectiveFrom;
      next = 'agreed';
    } else if (body.action === 'dispute') {
      next = 'disputed';
    } else {
      next = 'cancelled';
    }
    if (body.action !== 'edit' && body.notes !== undefined) set['notes'] = body.notes?.trim() || null;
    if (errors.length > 0) throw Problems.validation(errors);
    await tx.updateTable('rentReviews').set({ ...set, status: next }).where('id', '=', reviewId).execute();

    const action = body.action === 'edit' ? 'rent_review.updated' : `rent_review.${pastTense(body.action)}`;
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (next !== review.status) changes['status'] = { old: review.status, new: next };
    if (set['reviewDate'] !== undefined) changes['reviewDate'] = { old: review.reviewDate, new: set['reviewDate'] };
    if (set['method'] !== undefined) changes['method'] = { old: review.method, new: set['method'] };
    if (set['proposedAmount'] !== undefined) changes['proposedAmount'] = { old: review.proposedAmount, new: set['proposedAmount'] };
    if (set['agreedAmount'] !== undefined) changes['agreedAmount'] = { old: review.agreedAmount, new: set['agreedAmount'] };
    if (set['effectiveFrom'] !== undefined) changes['effectiveFrom'] = { old: review.effectiveFrom, new: set['effectiveFrom'] };
    await this.audit.record(tx, ctx, { action, entityType: 'rent_review', entityId: reviewId, changes: Object.keys(changes).length > 0 ? changes : null, metadata: { leaseId } });
    if (next !== review.status) {
      // A proposal is the notice of the new rent to the tenant; delivery comes with Phase 12.
      await this.audit.emit(tx, ctx, {
        eventType: action,
        aggregateType: 'rent_review',
        aggregateId: reviewId,
        payload: { rentReviewId: reviewId, leaseId, status: next, proposedAmount: set['proposedAmount'] ?? null, agreedAmount: set['agreedAmount'] ?? null, effectiveFrom: set['effectiveFrom'] ?? null, currency: lease.currencyCode },
      });
    }
    return this.get(tx, reviewId, lease.minor);
  }

  /** Agreed → applied: the agreed rent is charged from the effective date. */
  async apply(tx: Tx, ctx: TenantContext, leaseId: string, reviewId: string, expectedVersion: number): Promise<RentReviewDto> {
    const lease = await this.lease(tx, ctx, leaseId, true);
    const review = await this.lockReview(tx, leaseId, reviewId, expectedVersion);
    if (review.status !== 'agreed' || !review.effectiveFrom || !review.agreedAmount) throw Problems.businessRule('A review is applied once the new rent and its date are agreed.');
    if (!LIVE.includes(lease.status)) throw Problems.businessRule('A review is applied to an active, periodic or notice-given lease.');
    const charged = await lastChargedFrom(tx, leaseId, review.effectiveFrom);
    if (charged) throw Problems.businessRule(`Rent is already charged for the period from ${charged}. Cancel this review and agree a later date, or adjust those charges.`);
    await tx.updateTable('rentReviews').set({ status: 'applied' }).where('id', '=', reviewId).execute();
    await this.audit.record(tx, ctx, {
      action: 'rent_review.applied',
      entityType: 'rent_review',
      entityId: reviewId,
      changes: { status: { old: 'agreed', new: 'applied' }, rent: { old: review.oldAmount, new: review.agreedAmount } },
      metadata: { leaseId, effectiveFrom: review.effectiveFrom, currency: lease.currencyCode },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'rent_review.applied',
      aggregateType: 'rent_review',
      aggregateId: reviewId,
      payload: { rentReviewId: reviewId, leaseId, agreedAmount: review.agreedAmount, effectiveFrom: review.effectiveFrom, currency: lease.currencyCode },
    });
    return this.get(tx, reviewId, lease.minor);
  }

  private async lease(tx: Tx, ctx: TenantContext, leaseId: string, change: boolean) {
    const access = await leaseAccess(tx, leaseId);
    if (!access || !canOnLease(ctx, 'lease.view', access)) throw Problems.notFound();
    if (change && !canOnLease(ctx, 'lease.update', access)) throw Problems.forbidden('Your role does not allow changes to this lease.');
    let qb = tx.selectFrom('leases as l').innerJoin('currencies as cu', 'cu.code', 'l.currencyCode').select(['l.id', 'l.status', 'l.startDate', 'l.currencyCode', 'cu.minorUnits']).where('l.id', '=', leaseId);
    if (change) qb = qb.forUpdate('l');
    const row = await qb.executeTakeFirstOrThrow();
    return { ...row, minor: row.minorUnits };
  }

  private async lockReview(tx: Tx, leaseId: string, reviewId: string, expectedVersion: number) {
    const review = await tx
      .selectFrom('rentReviews')
      .select(['id', 'status', 'reviewDate', 'method', sql<string>`old_amount::text`.as('oldAmount'), sql<string | null>`proposed_amount::text`.as('proposedAmount'), sql<string | null>`agreed_amount::text`.as('agreedAmount'), 'effectiveFrom', 'version'])
      .where('id', '=', reviewId)
      .where('leaseId', '=', leaseId)
      .forUpdate()
      .executeTakeFirst();
    if (!review) throw Problems.notFound();
    if (review.version !== expectedVersion) throw Problems.preconditionFailed();
    return review;
  }

  private async get(tx: Tx, reviewId: string, minor: number): Promise<RentReviewDto> {
    return toReview(await reviewQuery(tx).where('r.id', '=', reviewId).executeTakeFirstOrThrow(), minor);
  }
}

/** The first rent period already charged on or after a date (scheduled or posted), if any. */
async function lastChargedFrom(tx: Tx, leaseId: string, from: string): Promise<string | null> {
  const row = await tx
    .selectFrom('rentCharges')
    .select('periodStart')
    .where('leaseId', '=', leaseId)
    .where('chargeType', '=', 'rent')
    .where('status', 'in', ['scheduled', 'posted'])
    .where('periodStart', '>=', from)
    .orderBy('periodStart')
    .limit(1)
    .executeTakeFirst();
  return row?.periodStart ?? null;
}

function reviewQuery(tx: Tx) {
  return tx
    .selectFrom('rentReviews as r')
    .innerJoin('leases as l', 'l.id', 'r.leaseId')
    .select(['r.id', 'r.leaseId', 'r.reviewDate', 'r.method', 'r.oldAmount', 'r.proposedAmount', 'r.agreedAmount', 'r.effectiveFrom', 'r.status', 'r.notes', 'r.dueNotifiedAt', 'r.createdAt', 'r.version', 'l.currencyCode']);
}

type ReviewRow = Awaited<ReturnType<ReturnType<typeof reviewQuery>['executeTakeFirstOrThrow']>>;

function toReview(row: ReviewRow, minor: number): RentReviewDto {
  return {
    id: row.id,
    leaseId: row.leaseId,
    reviewDate: row.reviewDate,
    method: row.method,
    current: toMoney(row.oldAmount, row.currencyCode, minor),
    proposed: row.proposedAmount ? toMoney(row.proposedAmount, row.currencyCode, minor) : null,
    agreed: row.agreedAmount ? toMoney(row.agreedAmount, row.currencyCode, minor) : null,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    notes: row.notes,
    dueNotifiedAt: row.dueNotifiedAt ? row.dueNotifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}

function pastTense(action: string): string {
  return { propose: 'proposed', agree: 'agreed', dispute: 'disputed', cancel: 'cancelled', edit: 'edited' }[action] ?? action;
}
