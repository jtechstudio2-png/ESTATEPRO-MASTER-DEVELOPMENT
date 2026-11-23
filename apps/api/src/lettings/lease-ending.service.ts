import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { todayIn } from '../common/dates.js';
import { toMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import { actingMembership, type TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { isRealDate } from './agreements.service.js';
import { addDays } from './charges.service.js';
import { DepositsService } from './deposits.service.js';
import type { CloseCheckDto, CloseConditionDto, EndLeaseBody, NoticeBody, NoticeResultDto, RenewalDecisionBody, RenewalLeaseBody } from './ending.dto.js';
import { canOnLease, leaseAccess } from './lettings-access.js';
import type { CreateLeaseBody, LeaseDto, LeasePartyInput } from './lettings.dto.js';
import { LeasesService } from './leases.service.js';
import { minorUnits } from './receipts.service.js';
import { scaled } from './rent-math.js';
import { postLeaseRent } from './rent-schedule.js';

const SETTLED_DEPOSIT = ['returned', 'partially_returned', 'forfeited'];
const DECISION_STATUS = { renew: 'renewing', not_renewing: 'not_renewing', later: 'pending_decision' } as const;

/**
 * Notice, ending, closing and renewal of a lease (LET-07; wireframes LS-6,
 * LS-7; readiness §5.6, §12.5). Notice moves the end date (the lease's notice
 * days give the default; nothing is enforced as law, P7-D3). A lease ends on
 * or after its end date: the rent up to that date is charged first, and a
 * held deposit then awaits its return. It closes once nothing is owed, no
 * receipt is unsettled and the deposit is settled. A renewal is a new draft
 * lease following this one (previous_lease_id); when it is activated this
 * lease is marked renewed and the renewal takes over its held deposit. The
 * database enforces the life cycle (migrations 0036, 0039); this service
 * checks first to answer with field codes, and adds scope, audit and outbox
 * events.
 */
@Injectable()
export class LeaseEndingService {
  constructor(
    private readonly audit: AuditService,
    private readonly leases: LeasesService,
    private readonly deposits: DepositsService,
  ) {}

  // ----------------------------------------------------------------- notice

  async notice(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: NoticeBody): Promise<NoticeResultDto> {
    const current = await this.leases.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (current.status === 'notice_given') throw Problems.businessRule('Notice has been given on this lease already.');
    if (current.status !== 'active' && current.status !== 'periodic') throw Problems.businessRule('Notice is given on an active or periodic lease.');
    if (current.renewalStatus === 'renewed') throw Problems.businessRule('This lease has been renewed. Give notice on the renewal.');
    const renewal = await renewalOf(tx, id);
    if (renewal) throw Problems.businessRule(`Renewal ${renewal.reference} is drawn up. Cancel it before recording notice.`);
    const today = todayIn(current.timezone);
    const errors: FieldError[] = [];
    if (!isRealDate(body.givenOn)) errors.push({ field: 'givenOn', code: 'invalid', message: 'Use a real date such as 2026-12-10.' });
    else if (body.givenOn > today) errors.push({ field: 'givenOn', code: 'future', message: 'Record notice once it has been given.' });
    const endsOn = body.endsOn ?? (current.noticePeriodDays !== null && isRealDate(body.givenOn) ? addDays(body.givenOn, current.noticePeriodDays) : null);
    if (endsOn === null) errors.push({ field: 'endsOn', code: 'required', message: 'The lease names no notice period: give the day the tenancy ends.' });
    else if (!isRealDate(endsOn)) errors.push({ field: 'endsOn', code: 'invalid', message: 'Use a real date such as 2027-02-28.' });
    else if (isRealDate(body.givenOn) && endsOn < body.givenOn) errors.push({ field: 'endsOn', code: 'before-notice', message: 'The tenancy ends on or after the day notice is given.' });
    else if (endsOn < current.startDate) errors.push({ field: 'endsOn', code: 'before-start', message: 'The tenancy ends on or after its start date.' });
    else if (current.endDate !== null && current.status === 'active' && endsOn > current.endDate) {
      errors.push({ field: 'endsOn', code: 'after-term', message: `The fixed term ends on ${current.endDate}. Notice cannot extend it; renew the lease instead.` });
    }
    if (errors.length > 0 || endsOn === null) throw Problems.validation(errors);

    await tx
      .updateTable('leases')
      .set({
        status: 'notice_given',
        noticeGivenOn: body.givenOn,
        noticeGivenBy: body.givenBy,
        endDate: endsOn,
        endedReason: body.reason ?? current.endedReason,
        renewalStatus: 'not_renewing',
      })
      .where('id', '=', id)
      .execute();
    await this.closeReminders(tx, ctx, id, 'cancelled', 'Notice was given on the lease');
    const noticeDays = daysBetween(body.givenOn, endsOn);
    const minor = (await minorUnits(tx, [current.currencyCode])).get(current.currencyCode) ?? 2;
    const after = await tx
      .selectFrom('rentCharges')
      .select(['id', 'description', 'periodStart', 'periodEnd', 'dueDate', 'currencyCode', sql<string>`(total_amount + adjusted_amount)::text`.as('total')])
      .where('leaseId', '=', id)
      .where('status', 'in', ['scheduled', 'posted'])
      .where((eb) => eb.or([eb('periodEnd', '>', endsOn), eb.and([eb('periodEnd', 'is', null), eb('dueDate', '>', endsOn)])]))
      .orderBy('dueDate')
      .orderBy('id')
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'lease.notice_given',
      entityType: 'lease',
      entityId: id,
      changes: { status: { old: current.status, new: 'notice_given' }, endDate: { old: current.endDate, new: endsOn } },
      metadata: { givenBy: body.givenBy, givenOn: body.givenOn, endsOn, noticeDays, agreedNoticeDays: current.noticePeriodDays, chargesAfterEnd: after.length },
    });
    await this.audit.emit(tx, ctx, { eventType: 'lease.notice_given', aggregateType: 'lease', aggregateId: id, payload: { leaseId: id, givenBy: body.givenBy, givenOn: body.givenOn, endsOn } });
    return {
      lease: await this.leases.get(tx, ctx, id),
      noticeDays,
      agreedNoticeDays: current.noticePeriodDays,
      chargesAfterEnd: after.map((charge) => ({
        id: charge.id,
        description: charge.description,
        periodStart: charge.periodStart,
        periodEnd: charge.periodEnd,
        dueDate: charge.dueDate,
        total: toMoney(charge.total, charge.currencyCode, minor),
      })),
    };
  }

  // ----------------------------------------------------------------- ending

  async end(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: EndLeaseBody): Promise<LeaseDto> {
    const current = await this.leases.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (!['active', 'periodic', 'notice_given'].includes(current.status)) throw Problems.businessRule('Only a running lease ends.');
    if (current.endDate === null) throw Problems.businessRule('This lease has no end date. Record notice first.');
    const today = todayIn(current.timezone);
    if (current.endDate > today) throw Problems.businessRule(`The lease runs until ${current.endDate}. It ends from that day; record notice to end it earlier.`);
    const renewed = current.renewalStatus === 'renewed';
    const errors: FieldError[] = [];
    if (body.moveOutDate === undefined) {
      if (!renewed) errors.push({ field: 'moveOutDate', code: 'required', message: 'Give the day the tenant moved out.' });
    } else if (!isRealDate(body.moveOutDate)) errors.push({ field: 'moveOutDate', code: 'invalid', message: 'Use a real date such as 2027-02-28.' });
    else if (body.moveOutDate > today) errors.push({ field: 'moveOutDate', code: 'future', message: 'Record the move-out once it has happened.' });
    else if (body.moveOutDate < current.startDate) errors.push({ field: 'moveOutDate', code: 'before-start', message: 'The move-out is on or after the start date.' });
    if (errors.length > 0) throw Problems.validation(errors);

    // The rent up to the end date is charged before the lease stops being scheduled.
    const charged = current.rentScheduleFrom !== null ? await postLeaseRent(tx, ctx, this.audit, id, current.endDate) : 0;
    await tx
      .updateTable('leases')
      .set({ status: 'ended', moveOutDate: body.moveOutDate ?? null, endedReason: body.reason ?? current.endedReason })
      .where('id', '=', id)
      .execute();
    await this.deposits.onLeaseEnded(tx, ctx, id);
    await this.closeReminders(tx, ctx, id, 'cancelled', 'The lease has ended');
    await this.audit.record(tx, ctx, {
      action: 'lease.ended',
      entityType: 'lease',
      entityId: id,
      changes: { status: { old: current.status, new: 'ended' } },
      metadata: { endDate: current.endDate, moveOutDate: body.moveOutDate ?? null, renewed, chargesPosted: charged },
    });
    await this.audit.emit(tx, ctx, { eventType: 'lease.ended', aggregateType: 'lease', aggregateId: id, payload: { leaseId: id, unitId: current.unitId, endDate: current.endDate, moveOutDate: body.moveOutDate ?? null, renewed } });
    return this.leases.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- closing

  async closeCheck(tx: Tx, ctx: TenantContext, id: string): Promise<CloseCheckDto> {
    const access = await leaseAccess(tx, id);
    if (!access || !canOnLease(ctx, 'lease.view', access)) throw Problems.notFound();
    return this.check(tx, id);
  }

  async close(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<LeaseDto> {
    const current = await this.leases.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (current.status !== 'ended') throw Problems.businessRule('A lease closes once it has ended.');
    const check = await this.check(tx, id);
    if (!check.canClose) {
      const unmet = check.conditions.filter((c) => c.required && !c.met).map((c) => CLOSE_WORDS[c.code]);
      throw Problems.businessRule(`The lease cannot close yet: ${unmet.join('; ')}.`);
    }
    await tx.updateTable('leases').set({ status: 'closed' }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, {
      action: 'lease.closed',
      entityType: 'lease',
      entityId: id,
      changes: { status: { old: 'ended', new: 'closed' } },
      metadata: { moveOutInspection: check.conditions.find((c) => c.code === 'move_out_inspection')?.status ?? null },
    });
    await this.audit.emit(tx, ctx, { eventType: 'lease.closed', aggregateType: 'lease', aggregateId: id, payload: { leaseId: id, unitId: current.unitId, listingId: current.listingId } });
    return this.leases.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- renewal

  async renewalDecision(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: RenewalDecisionBody): Promise<LeaseDto> {
    const current = await this.leases.lock(tx, ctx, id, expectedVersion, 'lease.update');
    assertRenewable(current);
    if (current.renewalStatus === 'renewed') throw Problems.businessRule('This lease has been renewed.');
    const renewal = await renewalOf(tx, id);
    if (body.decision === 'not_renewing' && renewal) throw Problems.businessRule(`Renewal ${renewal.reference} is drawn up. Cancel it first.`);
    const next = DECISION_STATUS[body.decision];
    if (next === current.renewalStatus) return this.leases.get(tx, ctx, id);
    await tx.updateTable('leases').set({ renewalStatus: next }).where('id', '=', id).execute();
    if (body.decision !== 'later') await this.closeReminders(tx, ctx, id, 'done', null);
    await this.audit.record(tx, ctx, { action: 'lease.renewal_decided', entityType: 'lease', entityId: id, changes: { renewalStatus: { old: current.renewalStatus, new: next } }, metadata: { decision: body.decision } });
    await this.audit.emit(tx, ctx, { eventType: 'lease.renewal_decided', aggregateType: 'lease', aggregateId: id, payload: { leaseId: id, decision: body.decision } });
    return this.leases.get(tx, ctx, id);
  }

  /** Draws up the renewal: a draft lease of the same unit and parties, starting the day after this one ends. */
  async renewal(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: RenewalLeaseBody): Promise<LeaseDto> {
    const current = await this.leases.lock(tx, ctx, id, expectedVersion, 'lease.update');
    if (!ctx.permissions.has('lease.create')) throw Problems.forbidden('Your role does not allow drawing up leases.');
    assertRenewable(current);
    if (current.renewalStatus === 'renewed') throw Problems.businessRule('This lease has been renewed.');
    if (current.renewalStatus === 'not_renewing') throw Problems.businessRule('The decision is not to renew. Record a decision to renew first.');
    const existing = await renewalOf(tx, id);
    if (existing) throw Problems.businessRule(`Renewal ${existing.reference} is drawn up already.`);
    const endDate = current.endDate!;
    const leaseType = body.leaseType ?? (current.leaseType as CreateLeaseBody['leaseType']);
    if (leaseType === 'fixed_term' && !body.endDate) throw Problems.validation([{ field: 'endDate', code: 'required', message: 'A fixed-term renewal has an end date.' }]);
    const rentInForce = (await sql<{ rent: string }>`select app.rent_in_force(${ctx.companyId}::uuid, ${id}::uuid, ${endDate}::date)::text as rent`.execute(tx)).rows[0]!.rent;
    const minor = (await minorUnits(tx, [current.currencyCode])).get(current.currencyCode) ?? 2;
    const parties = await tx
      .selectFrom('leaseParties')
      .select(['contactId', 'partyRole', 'isPrimary', 'liabilityShare', 'portalAccess'])
      .where('leaseId', '=', id)
      .execute();
    const agreement = current.managementAgreementId
      ? await tx.selectFrom('managementAgreements').select(['id', 'status']).where('id', '=', current.managementAgreementId).executeTakeFirstOrThrow()
      : null;
    const terms: CreateLeaseBody = {
      unitId: current.unitId,
      ...(agreement && agreement.status !== 'ended' ? { managementAgreementId: agreement.id } : {}),
      leaseType,
      usage: current.usage as CreateLeaseBody['usage'],
      startDate: addDays(endDate, 1),
      ...(body.endDate ? { endDate: body.endDate } : {}),
      rent: body.rent ?? { amount: toMoney(rentInForce, current.currencyCode, minor).amount, currency: current.currencyCode },
      rentFrequency: body.rentFrequency ?? (current.rentFrequency as CreateLeaseBody['rentFrequency']),
      ...(body.rentDueDay !== undefined ? { rentDueDay: body.rentDueDay } : current.rentDueDay !== null ? { rentDueDay: current.rentDueDay } : {}),
      advancePeriods: current.advancePeriods,
      prorateFirstPeriod: current.prorateFirstPeriod,
      ...(current.depositAmount !== null && scaled(current.depositAmount) > 0n ? { deposit: { amount: toMoney(current.depositAmount, current.currencyCode, minor).amount, currency: current.currencyCode } } : {}),
      ...(body.noticePeriodDays !== undefined ? { noticePeriodDays: body.noticePeriodDays } : current.noticePeriodDays !== null ? { noticePeriodDays: current.noticePeriodDays } : {}),
      ...(body.nextRentReviewDate ? { nextRentReviewDate: body.nextRentReviewDate } : {}),
      ...(current.governingLocaleCode ? { governingLocaleCode: current.governingLocaleCode } : {}),
      parties: parties.map((p): LeasePartyInput => ({
        contactId: p.contactId,
        partyRole: p.partyRole as LeasePartyInput['partyRole'],
        isPrimary: p.isPrimary,
        ...(p.liabilityShare !== null ? { liabilityShare: Number(p.liabilityShare) } : {}),
        portalAccess: p.portalAccess,
      })),
    };
    const renewal = await this.leases.create(tx, ctx, terms, id);
    if (current.renewalStatus !== 'renewing') await tx.updateTable('leases').set({ renewalStatus: 'renewing' }).where('id', '=', id).execute();
    else await tx.updateTable('leases').set({ version: sql`version + 1` }).where('id', '=', id).execute();
    await this.closeReminders(tx, ctx, id, 'done', null);
    await this.audit.record(tx, ctx, {
      action: 'lease.renewal_drawn_up',
      entityType: 'lease',
      entityId: id,
      changes: current.renewalStatus !== 'renewing' ? { renewalStatus: { old: current.renewalStatus, new: 'renewing' } } : null,
      metadata: { renewalLeaseId: renewal.id, startDate: terms.startDate, endDate: body.endDate ?? null, rent: terms.rent.amount },
    });
    return renewal;
  }

  // ----------------------------------------------------------------- helpers

  private async check(tx: Tx, id: string): Promise<CloseCheckDto> {
    const lease = await tx.selectFrom('leases').select(['currencyCode', 'status']).where('id', '=', id).executeTakeFirstOrThrow();
    const minor = (await minorUnits(tx, [lease.currencyCode])).get(lease.currencyCode) ?? 2;
    const balance = await tx
      .selectFrom('rentCharges')
      .select(sql<string>`coalesce(sum(amount + tax_amount + adjusted_amount - allocated_amount), 0)::text`.as('owed'))
      .where('leaseId', '=', id)
      .where('status', '=', 'posted')
      .executeTakeFirstOrThrow();
    const receipts = await tx
      .selectFrom('payments')
      .select(sql<string>`coalesce(sum(case when status = 'pending' then amount when status = 'cleared' then amount - allocated_amount else 0 end), 0)::text`.as('open'))
      .where('leaseId', '=', id)
      .executeTakeFirstOrThrow();
    const deposit = await tx.selectFrom('deposits').select('status').where('leaseId', '=', id).executeTakeFirst();
    const inspection = await tx
      .selectFrom('inspections')
      .select('status')
      .where('leaseId', '=', id)
      .where('inspectionType', '=', 'move_out')
      .where('status', '<>', 'cancelled')
      .executeTakeFirst();
    const conditions: CloseConditionDto[] = [
      { code: 'balance', met: scaled(balance.owed) === 0n, required: true, amount: toMoney(balance.owed, lease.currencyCode, minor), status: null },
      { code: 'receipts', met: scaled(receipts.open) === 0n, required: true, amount: toMoney(receipts.open, lease.currencyCode, minor), status: null },
      { code: 'deposit', met: !deposit || SETTLED_DEPOSIT.includes(deposit.status), required: true, amount: null, status: deposit?.status ?? null },
      { code: 'move_out_inspection', met: inspection?.status === 'completed', required: false, amount: null, status: inspection?.status ?? null },
    ];
    return { canClose: lease.status === 'ended' && conditions.every((c) => c.met || !c.required), conditions };
  }

  /** Renewal reminders (tasks written by the renewal job) are closed by a decision, notice or the end of the lease. */
  private async closeReminders(tx: Tx, ctx: TenantContext, leaseId: string, status: 'done' | 'cancelled', reason: string | null): Promise<void> {
    const actor = actingMembership(ctx);
    const closed = await tx
      .updateTable('tasks')
      .set(
        status === 'done'
          ? { status, completedAt: sql<Date>`now()`, completedBy: actor }
          : { status, cancelledAt: sql<Date>`now()`, cancelledBy: actor, cancelReason: reason },
      )
      .where('entityType', '=', 'lease')
      .where('entityId', '=', leaseId)
      .where('taskType', '=', 'renewal')
      .where('source', '=', 'automation')
      .where('status', '=', 'open')
      .returning('id')
      .execute();
    if (closed.length > 0) {
      await this.audit.recordMany(
        tx,
        ctx,
        closed.map((task) => ({ action: status === 'done' ? 'task.completed' : 'task.cancelled', entityType: 'task', entityId: task.id, metadata: { about: { entityType: 'lease', entityId: leaseId } } })),
      );
    }
  }
}

const CLOSE_WORDS: Record<string, string> = {
  balance: 'money is still owed on the lease',
  receipts: 'a receipt for the lease is pending or not fully allocated',
  deposit: 'the deposit has not been returned',
  move_out_inspection: 'the move-out inspection is not completed',
};

/** Renewal applies to a running fixed-term lease (LS-7). */
function assertRenewable(lease: { status: string; leaseType: string; endDate: string | null }): void {
  if (lease.status !== 'active' || lease.leaseType !== 'fixed_term' || lease.endDate === null) {
    throw Problems.businessRule('Renewal applies to an active fixed-term lease.');
  }
}

async function renewalOf(tx: Tx, leaseId: string) {
  return tx.selectFrom('leases').select(['id', 'reference']).where('previousLeaseId', '=', leaseId).where('status', '<>', 'cancelled').executeTakeFirst();
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
