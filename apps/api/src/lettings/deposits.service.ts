import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { todayIn } from '../common/dates.js';
import { toMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import { actingMembership, type TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { DocumentsService } from '../documents/documents.service.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { checkCurrencyAmount, isRealDate } from './agreements.service.js';
import type { DeductionBody, DeductionDecisionBody, DeductionDto, DepositBody, DepositDto, LeaseDepositDto, ProtectionBody, ProtectionRuleDto, ReturnDepositBody } from './deposits.dto.js';
import { canOnLease, leaseAccess } from './lettings-access.js';
import { minorUnits, periodLocked } from './receipts.service.js';
import { scaled, unscaled } from './rent-math.js';

/** Lease statuses a deposit is registered on (signed or awaiting signature, not finished). */
const REGISTERABLE = ['pending_signature', 'active', 'periodic', 'notice_given'];
/** Lease statuses that raise charges (migration 0037). */
const LIVE = ['active', 'periodic', 'notice_given'];
const FINAL = ['returned', 'partially_returned', 'forfeited'];
const OPEN_DEDUCTIONS = ['proposed', 'disputed'];
const SETTLED_DEDUCTIONS = ['agreed', 'adjudicated'];
const DECIDED: Record<string, string> = { agree: 'agreed', dispute: 'disputed', adjudicate: 'adjudicated', withdraw: 'withdrawn' };

interface LeaseRow {
  id: string;
  reference: string;
  status: string;
  currencyCode: string;
  jurisdictionCode: string;
  startDate: string;
  depositAmount: string | null;
  managementAgreementId: string | null;
  countryCode: string;
  timezone: string;
}

/**
 * Deposits (LET-06; wireframe DP-1; readiness §5.5; P7-D3, P7-D11). A
 * deposit is registered for the amount the lease names. Where the agency
 * collects the rent, a deposit charge is raised and the receipt that pays it
 * in full makes the deposit held (migration 0039); otherwise a person records
 * the day it was received. Protection records the scheme and reference; the
 * deadline follows from a reviewed jurisdiction value, or is entered by a
 * person where none exists, and is never invented. At the end of the tenancy
 * deductions are proposed with evidence, agreed, disputed and adjudicated;
 * the return is the deposit less the settled deductions. The payment of the
 * return is made outside EstatePro until payouts (Phase 9). The database
 * enforces the same rules; this service answers first with field codes and
 * adds scope, audit and outbox events.
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  // ----------------------------------------------------------------- reading

  async forLease(tx: Tx, ctx: TenantContext, leaseId: string): Promise<LeaseDepositDto> {
    const lease = await this.leaseFor(tx, ctx, leaseId, 'deposit.view');
    const minor = (await minorUnits(tx, [lease.currencyCode])).get(lease.currencyCode) ?? 2;
    const deposit = await tx.selectFrom('deposits').select('id').where('leaseId', '=', leaseId).executeTakeFirst();
    return {
      deposit: deposit ? await this.dto(tx, deposit.id) : null,
      agreed: lease.depositAmount !== null && scaled(lease.depositAmount) > 0n ? toMoney(lease.depositAmount, lease.currencyCode, minor) : null,
      protectionRule: await protectionRule(tx, lease.jurisdictionCode, todayIn(lease.timezone)),
    };
  }

  // ----------------------------------------------------------------- registering (PUT)

  async save(tx: Tx, ctx: TenantContext, leaseId: string, expectedVersion: number | null, body: DepositBody): Promise<LeaseDepositDto> {
    const lease = await this.leaseFor(tx, ctx, leaseId, 'deposit.manage', true);
    const current = await tx.selectFrom('deposits').selectAll().where('leaseId', '=', leaseId).forUpdate().executeTakeFirst();
    if (current && expectedVersion === null) throw Problems.businessRule('This lease already has a deposit. Send its version in If-Match to change it.');
    if (current && current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (!current && !REGISTERABLE.includes(lease.status)) throw Problems.businessRule('A deposit is registered on a lease awaiting signature or running.');
    if (current && FINAL.includes(current.status)) throw Problems.businessRule('This deposit has been returned and no longer changes.');
    if (!lease.depositAmount || scaled(lease.depositAmount) <= 0n) throw Problems.businessRule("The lease names no deposit. A deposit is part of the lease's terms, set before it is signed.");
    const today = todayIn(lease.timezone);
    const rule = await protectionRule(tx, lease.jurisdictionCode, today);
    const collected = await collects(tx, lease);
    const errors: FieldError[] = [];
    const early = !current || current.status === 'expected' || current.status === 'held';
    const holdingChanges = body.holderType !== current?.holderType || (body.holdingAccountId !== undefined && body.holdingAccountId !== current?.holdingAccountId);
    if (current && !early && (holdingChanges || (body.schemeName !== undefined && body.schemeName !== current.schemeName))) {
      errors.push({ field: 'holderType', code: 'protected', message: 'How the deposit is held is fixed once it is protected or being returned.' });
    }
    const holdingAccountId = body.holdingAccountId !== undefined ? body.holdingAccountId : (current?.holdingAccountId ?? null);
    if (body.holderType === 'agent' && !holdingAccountId) errors.push({ field: 'holdingAccountId', code: 'required', message: "Choose the agency's account that holds the deposit." });
    if (holdingAccountId) {
      const account = await tx.selectFrom('bankAccounts').select(['currencyCode', 'isActive']).where('id', '=', holdingAccountId).executeTakeFirst();
      if (!account || !account.isActive) errors.push({ field: 'holdingAccountId', code: 'not-found', message: 'Choose an active bank account of the company.' });
      else if (account.currencyCode !== lease.currencyCode) errors.push({ field: 'holdingAccountId', code: 'currency-mismatch', message: `The deposit is in ${lease.currencyCode}.` });
    }
    if (body.protectionDeadline !== undefined && body.protectionDeadline !== null) {
      if (rule.reviewed) errors.push({ field: 'protectionDeadline', code: 'set-by-rule', message: `The deadline follows from the reviewed rule (${rule.days} days from receipt).` });
      else if (!isRealDate(body.protectionDeadline)) errors.push({ field: 'protectionDeadline', code: 'invalid', message: 'Use a real date such as 2027-01-15.' });
      else if (current?.protectedAt) errors.push({ field: 'protectionDeadline', code: 'protected', message: 'The deposit is protected already.' });
    }
    if (body.returnDueBy && !isRealDate(body.returnDueBy)) errors.push({ field: 'returnDueBy', code: 'invalid', message: 'Use a real date such as 2027-02-15.' });
    if (body.receivedOn !== undefined) {
      if (collected) errors.push({ field: 'receivedOn', code: 'collected', message: 'The agency collects this deposit: the receipt that pays the deposit charge records when it was received.' });
      else if (current && current.status !== 'expected') errors.push({ field: 'receivedOn', code: 'received', message: 'The deposit was recorded as received already.' });
      else if (!isRealDate(body.receivedOn)) errors.push({ field: 'receivedOn', code: 'invalid', message: 'Use a real date such as 2026-12-01.' });
      else if (body.receivedOn > today) errors.push({ field: 'receivedOn', code: 'future', message: 'Record the deposit once it has been received.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);

    const deadline = body.protectionDeadline !== undefined && !rule.reviewed
      ? { protectionDeadline: body.protectionDeadline, protectionDeadlineSource: body.protectionDeadline === null ? null : 'entered' }
      : {};
    const values = {
      holderType: body.holderType,
      holdingAccountId,
      schemeName: body.schemeName !== undefined ? body.schemeName : (current?.schemeName ?? null),
      returnDueBy: body.returnDueBy !== undefined ? body.returnDueBy : (current?.returnDueBy ?? null),
      ...deadline,
    };
    let depositId: string;
    if (!current) {
      const inserted = await tx
        .insertInto('deposits')
        .values({
          companyId: ctx.companyId,
          leaseId,
          currencyCode: lease.currencyCode,
          amount: lease.depositAmount,
          ...values,
          ...(body.receivedOn ? { status: 'held', receivedOn: body.receivedOn } : {}),
          createdBy: actingMembership(ctx),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      depositId = inserted.id;
      await this.audit.record(tx, ctx, {
        action: 'deposit.registered',
        entityType: 'deposit',
        entityId: depositId,
        metadata: { leaseId, amount: lease.depositAmount, currency: lease.currencyCode, holderType: body.holderType, holdingAccountId, collected, receivedOn: body.receivedOn ?? null },
      });
      await this.audit.emit(tx, ctx, { eventType: 'deposit.registered', aggregateType: 'deposit', aggregateId: depositId, payload: { depositId, leaseId } });
      if (collected && LIVE.includes(lease.status)) await postDepositCharge(tx, ctx, this.audit, leaseId);
    } else {
      depositId = current.id;
      const before = { holderType: current.holderType, holdingAccountId: current.holdingAccountId, schemeName: current.schemeName, returnDueBy: current.returnDueBy, protectionDeadline: current.protectionDeadline };
      const after = { ...before, ...values, ...(body.receivedOn ? { receivedOn: body.receivedOn } : {}) };
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      for (const key of Object.keys(after) as (keyof typeof after)[]) {
        const old = key === 'receivedOn' ? current.receivedOn : before[key as keyof typeof before];
        if (old !== after[key]) changes[key] = { old, new: after[key] };
      }
      if (Object.keys(changes).length === 0) return this.forLease(tx, ctx, leaseId);
      await tx
        .updateTable('deposits')
        .set({ ...values, ...(body.receivedOn ? { status: 'held', receivedOn: body.receivedOn } : {}) })
        .where('id', '=', depositId)
        .execute();
      await this.audit.record(tx, ctx, { action: body.receivedOn ? 'deposit.received' : 'deposit.updated', entityType: 'deposit', entityId: depositId, changes, metadata: { leaseId } });
    }
    if (body.receivedOn) {
      await this.audit.emit(tx, ctx, { eventType: 'deposit.received', aggregateType: 'deposit', aggregateId: depositId, payload: { depositId, leaseId, receivedOn: body.receivedOn } });
    }
    return this.forLease(tx, ctx, leaseId);
  }

  // ----------------------------------------------------------------- protection

  async protect(tx: Tx, ctx: TenantContext, depositId: string, expectedVersion: number, body: ProtectionBody): Promise<DepositDto> {
    const { deposit, lease } = await this.lockDeposit(tx, ctx, depositId, expectedVersion);
    if (deposit.status === 'expected') throw Problems.businessRule('The deposit has not been received yet. It is protected once held.');
    if (deposit.protectedAt !== null) throw Problems.businessRule('The deposit is protected already.');
    if (deposit.status !== 'held') throw Problems.businessRule('Only a held deposit is protected.');
    const today = todayIn(lease.timezone);
    const errors: FieldError[] = [];
    if (!isRealDate(body.protectedOn)) errors.push({ field: 'protectedOn', code: 'invalid', message: 'Use a real date such as 2026-12-15.' });
    else if (body.protectedOn > today) errors.push({ field: 'protectedOn', code: 'future', message: 'Record the protection once it is done.' });
    else if (deposit.receivedOn && body.protectedOn < deposit.receivedOn) errors.push({ field: 'protectedOn', code: 'before-receipt', message: 'A deposit is protected on or after the day it was received.' });
    if (errors.length > 0) throw Problems.validation(errors);
    await tx
      .updateTable('deposits')
      .set({
        status: 'protected',
        schemeName: body.schemeName,
        schemeReference: body.schemeReference,
        protectedAt: sql<Date>`(${body.protectedOn}::date)::timestamp at time zone ${lease.timezone}`,
      })
      .where('id', '=', depositId)
      .execute();
    const late = deposit.protectionDeadline !== null && body.protectedOn > deposit.protectionDeadline;
    await this.audit.record(tx, ctx, {
      action: 'deposit.protected',
      entityType: 'deposit',
      entityId: depositId,
      changes: { status: { old: 'held', new: 'protected' } },
      metadata: { leaseId: lease.id, schemeName: body.schemeName, schemeReference: body.schemeReference, protectedOn: body.protectedOn, deadline: deposit.protectionDeadline, late },
    });
    await this.audit.emit(tx, ctx, { eventType: 'deposit.protected', aggregateType: 'deposit', aggregateId: depositId, payload: { depositId, leaseId: lease.id, late } });
    return this.dto(tx, depositId);
  }

  // ----------------------------------------------------------------- deductions

  async addDeduction(tx: Tx, ctx: TenantContext, depositId: string, expectedVersion: number, body: DeductionBody): Promise<DepositDto> {
    const { deposit, lease } = await this.lockDeposit(tx, ctx, depositId, expectedVersion);
    if (!['notice_given', 'ended'].includes(lease.status)) throw Problems.businessRule('Deductions are proposed at the end of the tenancy: once notice is given or the lease has ended.');
    if (!['held', 'protected', 'return_pending', 'disputed'].includes(deposit.status)) {
      throw Problems.businessRule(deposit.status === 'expected' ? 'The deposit has not been received.' : 'This deposit has been returned.');
    }
    const errors: FieldError[] = [];
    await checkCurrencyAmount(tx, body.amount, deposit.currencyCode, 'amount', errors, true);
    const reason = await checkPicklistCode(tx, 'deposit_deduction_reason', body.reasonCode, lease.countryCode, 'reasonCode');
    if (reason) errors.push(reason);
    if (errors.length === 0) {
      const claimed = await tx.selectFrom('depositDeductions').select(sql<string>`coalesce(sum(amount), 0)::text`.as('total')).where('depositId', '=', depositId).where('status', '<>', 'withdrawn').executeTakeFirstOrThrow();
      if (scaled(claimed.total) + scaled(body.amount.amount) > scaled(deposit.amount)) {
        errors.push({ field: 'amount.amount', code: 'above-deposit', message: `Deductions would exceed the deposit: ${unscaled(scaled(deposit.amount) - scaled(claimed.total))} is left to claim.` });
      }
    }
    if (errors.length > 0) throw Problems.validation(errors);
    if (body.evidenceDocumentId) await this.assertEvidence(tx, lease.id, body.evidenceDocumentId);
    const inserted = await tx
      .insertInto('depositDeductions')
      .values({
        companyId: ctx.companyId,
        depositId,
        reasonCode: body.reasonCode,
        description: body.description,
        amount: body.amount.amount,
        evidenceDocumentId: body.evidenceDocumentId ?? null,
        createdBy: actingMembership(ctx),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.touch(tx, depositId);
    await this.audit.record(tx, ctx, {
      action: 'deposit.deduction_proposed',
      entityType: 'deposit',
      entityId: depositId,
      metadata: { leaseId: lease.id, deductionId: inserted.id, reasonCode: body.reasonCode, amount: body.amount.amount, evidenceDocumentId: body.evidenceDocumentId ?? null },
    });
    await this.audit.emit(tx, ctx, { eventType: 'deposit.deduction_proposed', aggregateType: 'deposit', aggregateId: depositId, payload: { depositId, leaseId: lease.id, deductionId: inserted.id } });
    return this.dto(tx, depositId);
  }

  async decideDeduction(tx: Tx, ctx: TenantContext, depositId: string, deductionId: string, expectedVersion: number, body: DeductionDecisionBody): Promise<DepositDto> {
    const { deposit, lease } = await this.lockDeposit(tx, ctx, depositId, null);
    const deduction = await tx.selectFrom('depositDeductions').selectAll().where('id', '=', deductionId).where('depositId', '=', depositId).forUpdate().executeTakeFirst();
    if (!deduction) throw Problems.notFound();
    if (deduction.version !== expectedVersion) throw Problems.preconditionFailed();
    if (FINAL.includes(deposit.status)) throw Problems.businessRule('This deposit has been returned.');
    const allowed: Record<string, string[]> = { proposed: ['agree', 'dispute', 'withdraw', 'attach_evidence'], disputed: ['agree', 'adjudicate', 'withdraw'] };
    if (!(allowed[deduction.status] ?? []).includes(body.action)) throw Problems.businessRule(`A ${deduction.status} deduction cannot be ${body.action === 'attach_evidence' ? 'given new evidence' : `${body.action}d`}.`);
    const errors: FieldError[] = [];
    if (body.action === 'adjudicate') {
      if (!body.settledAmount) errors.push({ field: 'settledAmount', code: 'required', message: 'Give the amount decided.' });
      else {
        await checkCurrencyAmount(tx, body.settledAmount, deposit.currencyCode, 'settledAmount', errors);
        if (errors.length === 0 && (scaled(body.settledAmount.amount) < 0n || scaled(body.settledAmount.amount) > scaled(deduction.amount))) {
          errors.push({ field: 'settledAmount.amount', code: 'above-claim', message: 'The amount decided is between zero and the amount claimed.' });
        }
      }
    } else if (body.settledAmount) {
      errors.push({ field: 'settledAmount', code: 'not-allowed', message: 'An amount is given only when adjudicating.' });
    }
    if (body.action === 'attach_evidence' && !body.evidenceDocumentId) errors.push({ field: 'evidenceDocumentId', code: 'required', message: 'Choose the document.' });
    if (body.action !== 'attach_evidence' && body.evidenceDocumentId) errors.push({ field: 'evidenceDocumentId', code: 'not-allowed', message: 'Evidence is attached on its own.' });
    if (errors.length > 0) throw Problems.validation(errors);

    const decided = { decidedAt: sql<Date>`now()`, decidedBy: actingMembership(ctx) };
    if (body.action === 'attach_evidence') {
      await this.assertEvidence(tx, lease.id, body.evidenceDocumentId!);
      await tx.updateTable('depositDeductions').set({ evidenceDocumentId: body.evidenceDocumentId! }).where('id', '=', deductionId).execute();
    } else {
      const status = DECIDED[body.action]!;
      const settledAmount = body.action === 'agree' ? deduction.amount : body.action === 'adjudicate' ? body.settledAmount!.amount : null;
      await tx
        .updateTable('depositDeductions')
        .set({ status, settledAmount, ...(body.action === 'dispute' ? {} : decided) })
        .where('id', '=', deductionId)
        .execute();
    }
    await this.syncDisputed(tx, depositId, lease.status);
    await this.touch(tx, depositId);
    await this.audit.record(tx, ctx, {
      action: `deposit.deduction_${body.action === 'attach_evidence' ? 'evidence_attached' : DECIDED[body.action]}`,
      entityType: 'deposit',
      entityId: depositId,
      metadata: { leaseId: lease.id, deductionId, amount: deduction.amount, settledAmount: body.action === 'agree' ? deduction.amount : (body.settledAmount?.amount ?? null), evidenceDocumentId: body.evidenceDocumentId ?? null },
    });
    if (body.action !== 'attach_evidence') {
      await this.audit.emit(tx, ctx, { eventType: `deposit.deduction_${DECIDED[body.action]}`, aggregateType: 'deposit', aggregateId: depositId, payload: { depositId, leaseId: lease.id, deductionId } });
    }
    return this.dto(tx, depositId);
  }

  // ----------------------------------------------------------------- return

  async returnDeposit(tx: Tx, ctx: TenantContext, depositId: string, expectedVersion: number, body: ReturnDepositBody): Promise<DepositDto> {
    const { deposit, lease } = await this.lockDeposit(tx, ctx, depositId, expectedVersion);
    if (lease.status !== 'ended') throw Problems.businessRule('The deposit is returned once the lease has ended.');
    if (FINAL.includes(deposit.status)) throw Problems.businessRule('This deposit has been returned.');
    if (deposit.status === 'expected') throw Problems.businessRule('The deposit was never received: there is nothing to return.');
    if (deposit.status === 'disputed') throw Problems.businessRule('A deduction is disputed. Settle it (agree, adjudicate or withdraw) first.');
    const deductions = await tx.selectFrom('depositDeductions').select(['status', 'settledAmount']).where('depositId', '=', depositId).execute();
    if (deductions.some((d) => OPEN_DEDUCTIONS.includes(d.status))) throw Problems.businessRule('A deduction is still proposed. Agree or withdraw it first.');
    const today = todayIn(lease.timezone);
    const errors: FieldError[] = [];
    if (!isRealDate(body.returnedOn)) errors.push({ field: 'returnedOn', code: 'invalid', message: 'Use a real date such as 2027-01-10.' });
    else if (body.returnedOn > today) errors.push({ field: 'returnedOn', code: 'future', message: 'Record the return once it is made.' });
    else if (deposit.receivedOn && body.returnedOn < deposit.receivedOn) errors.push({ field: 'returnedOn', code: 'before-receipt', message: 'The return is on or after the day the deposit was received.' });
    else if (await periodLocked(tx, body.returnedOn)) errors.push({ field: 'returnedOn', code: 'period-locked', message: 'This date is in a locked financial period.' });
    if (errors.length > 0) throw Problems.validation(errors);
    const settled = deductions.filter((d) => SETTLED_DEDUCTIONS.includes(d.status)).reduce((sum, d) => sum + scaled(d.settledAmount ?? '0'), 0n);
    const returned = scaled(deposit.amount) - settled;
    const status = returned === scaled(deposit.amount) ? 'returned' : returned === 0n ? 'forfeited' : 'partially_returned';
    await tx
      .updateTable('deposits')
      .set({ status, returnedAmount: unscaled(returned), returnedAt: sql<Date>`(${body.returnedOn}::date)::timestamp at time zone ${lease.timezone}` })
      .where('id', '=', depositId)
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'deposit.returned',
      entityType: 'deposit',
      entityId: depositId,
      changes: { status: { old: deposit.status, new: status } },
      metadata: { leaseId: lease.id, amount: deposit.amount, deducted: unscaled(settled), returned: unscaled(returned), returnedOn: body.returnedOn, currency: deposit.currencyCode },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'deposit.returned',
      aggregateType: 'deposit',
      aggregateId: depositId,
      payload: { depositId, leaseId: lease.id, status, returned: unscaled(returned), deducted: unscaled(settled), currency: deposit.currencyCode },
    });
    return this.dto(tx, depositId);
  }

  // ----------------------------------------------------------------- used by the lease life cycle

  /** At the end of the tenancy a held or protected deposit awaits its return. */
  async onLeaseEnded(tx: Tx, ctx: TenantContext, leaseId: string): Promise<void> {
    const moved = await tx
      .updateTable('deposits')
      .set({ status: 'return_pending' })
      .where('leaseId', '=', leaseId)
      .where('status', 'in', ['held', 'protected'])
      .returning(['id', 'status'])
      .execute();
    for (const deposit of moved) {
      await this.audit.record(tx, ctx, { action: 'deposit.return_pending', entityType: 'deposit', entityId: deposit.id, metadata: { leaseId } });
    }
  }

  /**
   * At activation: a renewal takes over the held deposit of the lease it
   * renews; otherwise a registered deposit the agency collects gets its charge.
   */
  async onLeaseActivated(tx: Tx, ctx: TenantContext, leaseId: string, previousLeaseId: string | null): Promise<void> {
    const own = await tx.selectFrom('deposits').select(['id', 'status']).where('leaseId', '=', leaseId).executeTakeFirst();
    if (!own && previousLeaseId) {
      const previous = await tx.selectFrom('deposits').select(['id', 'status']).where('leaseId', '=', previousLeaseId).where('status', 'in', ['held', 'protected']).forUpdate().executeTakeFirst();
      if (previous) {
        await tx.updateTable('deposits').set({ leaseId }).where('id', '=', previous.id).execute();
        await this.audit.record(tx, ctx, { action: 'deposit.carried_over', entityType: 'deposit', entityId: previous.id, changes: { leaseId: { old: previousLeaseId, new: leaseId } }, metadata: { status: previous.status } });
        await this.audit.emit(tx, ctx, { eventType: 'deposit.carried_over', aggregateType: 'deposit', aggregateId: previous.id, payload: { depositId: previous.id, fromLeaseId: previousLeaseId, toLeaseId: leaseId } });
      }
      return;
    }
    if (own?.status === 'expected') {
      const lease = await loadLease(tx, leaseId);
      if (await collects(tx, lease)) await postDepositCharge(tx, ctx, this.audit, leaseId);
    }
  }

  // ----------------------------------------------------------------- helpers

  private async leaseFor(tx: Tx, ctx: TenantContext, leaseId: string, permission: 'deposit.view' | 'deposit.manage', lock = false): Promise<LeaseRow> {
    const access = await leaseAccess(tx, leaseId);
    if (!access || !canOnLease(ctx, 'lease.view', access) || !canOnLease(ctx, 'deposit.view', access)) throw Problems.notFound();
    if (permission === 'deposit.manage' && !canOnLease(ctx, 'deposit.manage', access)) throw Problems.forbidden('Your role does not allow changes to deposits.');
    return loadLease(tx, leaseId, lock);
  }

  private async lockDeposit(tx: Tx, ctx: TenantContext, depositId: string, expectedVersion: number | null) {
    const row = await tx.selectFrom('deposits').select('leaseId').where('id', '=', depositId).executeTakeFirst();
    if (!row) throw Problems.notFound();
    const lease = await this.leaseFor(tx, ctx, row.leaseId, 'deposit.manage', true);
    const deposit = await tx.selectFrom('deposits').selectAll().where('id', '=', depositId).forUpdate().executeTakeFirstOrThrow();
    if (expectedVersion !== null && deposit.version !== expectedVersion) throw Problems.preconditionFailed();
    return { deposit, lease };
  }

  /** Evidence is a clean document of the lease or of one of its inspections. */
  private async assertEvidence(tx: Tx, leaseId: string, documentId: string): Promise<void> {
    const link = await tx
      .selectFrom('documentLinks as k')
      .select(['k.entityType', 'k.entityId'])
      .where('k.documentId', '=', documentId)
      .where((eb) =>
        eb.or([
          eb.and([eb('k.entityType', '=', 'lease'), eb('k.entityId', '=', leaseId)]),
          eb.and([eb('k.entityType', '=', 'inspection'), eb('k.entityId', 'in', eb.selectFrom('inspections').select('id').where('leaseId', '=', leaseId))]),
        ]),
      )
      .executeTakeFirst();
    if (!link) throw Problems.validation([{ field: 'evidenceDocumentId', code: 'not-found', message: 'Upload the evidence to the lease or one of its inspections first.' }]);
    await this.documents.assertClean(tx, documentId, link.entityType as 'lease' | 'inspection', link.entityId, 'evidenceDocumentId');
  }

  /** A deposit is disputed while a deduction is; otherwise it is back where it was. */
  private async syncDisputed(tx: Tx, depositId: string, leaseStatus: string): Promise<void> {
    const deposit = await tx.selectFrom('deposits').select(['status', 'protectedAt']).where('id', '=', depositId).executeTakeFirstOrThrow();
    const disputed = await tx.selectFrom('depositDeductions').select('id').where('depositId', '=', depositId).where('status', '=', 'disputed').executeTakeFirst();
    let next: string | null = null;
    if (disputed && deposit.status !== 'disputed') next = 'disputed';
    if (!disputed && deposit.status === 'disputed') next = leaseStatus === 'ended' ? 'return_pending' : deposit.protectedAt ? 'protected' : 'held';
    if (next) await tx.updateTable('deposits').set({ status: next }).where('id', '=', depositId).execute();
  }

  private async touch(tx: Tx, depositId: string): Promise<void> {
    await tx.updateTable('deposits').set({ version: sql`version + 1` }).where('id', '=', depositId).execute();
  }

  async dto(tx: Tx, depositId: string): Promise<DepositDto> {
    const row = await tx
      .selectFrom('deposits as d')
      .innerJoin('leases as l', 'l.id', 'd.leaseId')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .innerJoin('properties as p', 'p.id', 'u.propertyId')
      .leftJoin('bankAccounts as b', 'b.id', 'd.holdingAccountId')
      .leftJoin('payments as pay', 'pay.id', 'd.receivedPaymentId')
      .selectAll('d')
      .select([
        'l.reference as leaseReference', 'l.managementAgreementId', 'p.timezone', 'b.name as accountName', 'pay.reference as paymentReference',
        sql<string | null>`(select sum(c.amount + c.tax_amount + c.adjusted_amount - c.allocated_amount)::text from rent_charges c
                              where c.company_id = d.company_id and c.lease_id = d.lease_id and c.charge_type = 'deposit' and c.status = 'posted')`.as('chargeOutstanding'),
      ])
      .where('d.id', '=', depositId)
      .executeTakeFirstOrThrow();
    const minor = (await minorUnits(tx, [row.currencyCode])).get(row.currencyCode) ?? 2;
    const money = (value: string) => toMoney(value, row.currencyCode, minor);
    const deductions = await tx
      .selectFrom('depositDeductions as x')
      .leftJoin('documents as doc', 'doc.id', 'x.evidenceDocumentId')
      .leftJoin('companyMemberships as cm', 'cm.id', 'x.createdBy')
      .leftJoin('users as cu', 'cu.id', 'cm.userId')
      .leftJoin('companyMemberships as dm', 'dm.id', 'x.decidedBy')
      .leftJoin('users as du', 'du.id', 'dm.userId')
      .selectAll('x')
      .select(['doc.title as documentTitle', 'cu.displayName as createdByName', 'du.displayName as decidedByName'])
      .where('x.depositId', '=', depositId)
      .orderBy('x.createdAt')
      .orderBy('x.id')
      .execute();
    const settled = deductions.filter((d) => SETTLED_DEDUCTIONS.includes(d.status)).reduce((sum, d) => sum + scaled(d.settledAmount ?? '0'), 0n);
    const today = todayIn(row.timezone);
    const collected = await collects(tx, { managementAgreementId: row.managementAgreementId });
    return {
      id: row.id,
      lease: { id: row.leaseId, name: row.leaseReference },
      status: row.status,
      amount: money(row.amount),
      holderType: row.holderType,
      holdingAccount: row.holdingAccountId ? { id: row.holdingAccountId, name: row.accountName ?? '' } : null,
      collected,
      chargeOutstanding: row.chargeOutstanding === null ? null : money(row.chargeOutstanding),
      receivedOn: row.receivedOn,
      receivedPayment: row.receivedPaymentId ? { id: row.receivedPaymentId, name: row.paymentReference ?? '' } : null,
      schemeName: row.schemeName,
      schemeReference: row.schemeReference,
      protectionDeadline: row.protectionDeadline,
      protectionDeadlineSource: row.protectionDeadlineSource,
      protectionOverdue: row.status === 'held' && row.protectionDeadline !== null && row.protectionDeadline < today,
      protectedAt: row.protectedAt?.toISOString() ?? null,
      returnDueBy: row.returnDueBy,
      deductions: deductions.map((d): DeductionDto => ({
        id: d.id,
        reasonCode: d.reasonCode,
        description: d.description,
        amount: money(d.amount),
        settledAmount: d.settledAmount === null ? null : money(d.settledAmount),
        status: d.status,
        evidenceDocument: d.evidenceDocumentId ? { id: d.evidenceDocumentId, name: d.documentTitle ?? '' } : null,
        createdBy: d.createdBy ? { id: d.createdBy, name: d.createdByName ?? '' } : null,
        createdAt: d.createdAt.toISOString(),
        decidedBy: d.decidedBy ? { id: d.decidedBy, name: d.decidedByName ?? '' } : null,
        decidedAt: d.decidedAt?.toISOString() ?? null,
        version: d.version,
      })),
      settledDeductions: money(unscaled(settled)),
      toReturn: money(unscaled(scaled(row.amount) - settled)),
      returnedAmount: money(row.returnedAmount),
      returnedAt: row.returnedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }
}

// ----------------------------------------------------------------------------- shared

async function loadLease(tx: Tx, leaseId: string, lock = false): Promise<LeaseRow> {
  let qb = tx
    .selectFrom('leases as l')
    .innerJoin('units as u', 'u.id', 'l.unitId')
    .innerJoin('properties as p', 'p.id', 'u.propertyId')
    .innerJoin('offices as o', 'o.id', 'p.officeId')
    .select(['l.id', 'l.reference', 'l.status', 'l.currencyCode', 'l.jurisdictionCode', 'l.startDate', 'l.depositAmount', 'l.managementAgreementId', 'o.countryCode', 'p.timezone'])
    .where('l.id', '=', leaseId);
  if (lock) qb = qb.forUpdate('l');
  return qb.executeTakeFirstOrThrow();
}

/** The agency collects the lease's money unless an agreement says let only (readiness §5.1). */
async function collects(tx: Tx, lease: { managementAgreementId: string | null }): Promise<boolean> {
  if (!lease.managementAgreementId) return true;
  const agreement = await tx.selectFrom('managementAgreements').select('serviceLevel').where('id', '=', lease.managementAgreementId).executeTakeFirstOrThrow();
  return agreement.serviceLevel !== 'let_only';
}

/**
 * Raises the deposit charge of a live lease whose deposit the agency collects
 * (once), due on the start date, or today if that date's period is locked.
 * Charges are not raised under a draft or suspended agreement (migration 0037):
 * the charge then waits for activation or the next registration change.
 */
export async function postDepositCharge(tx: Tx, ctx: TenantContext, audit: AuditService, leaseId: string): Promise<boolean> {
  const lease = await loadLease(tx, leaseId);
  if (!LIVE.includes(lease.status)) return false;
  if (lease.managementAgreementId) {
    const agreement = await tx.selectFrom('managementAgreements').select('status').where('id', '=', lease.managementAgreementId).executeTakeFirstOrThrow();
    if (agreement.status !== 'active') return false;
  }
  const deposit = await tx.selectFrom('deposits').select(['id', 'amount', 'currencyCode', 'status']).where('leaseId', '=', leaseId).executeTakeFirst();
  if (!deposit || deposit.status !== 'expected') return false;
  const existing = await tx.selectFrom('rentCharges').select('id').where('leaseId', '=', leaseId).where('chargeType', '=', 'deposit').where('status', 'in', ['scheduled', 'posted']).executeTakeFirst();
  if (existing) return false;
  const dueDate = (await periodLocked(tx, lease.startDate)) ? todayIn(lease.timezone) : lease.startDate;
  const inserted = await tx
    .insertInto('rentCharges')
    .values({
      companyId: ctx.companyId,
      leaseId,
      chargeType: 'deposit',
      description: 'Deposit',
      dueDate,
      currencyCode: deposit.currencyCode,
      amount: deposit.amount,
      status: 'posted',
      source: 'automation',
      createdBy: actingMembership(ctx),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await audit.record(tx, ctx, {
    action: 'rent_charge.posted',
    entityType: 'rent_charge',
    entityId: inserted.id,
    metadata: { leaseId, chargeType: 'deposit', dueDate, amount: deposit.amount, taxAmount: '0', currency: deposit.currencyCode, source: 'automation', depositId: deposit.id },
  });
  await audit.emit(tx, ctx, {
    eventType: 'rent_charge.posted',
    aggregateType: 'rent_charge',
    aggregateId: inserted.id,
    payload: { rentChargeId: inserted.id, leaseId, chargeType: 'deposit', dueDate, amount: deposit.amount, taxAmount: '0', currency: deposit.currencyCode },
  });
  return true;
}

/** The jurisdiction's reviewed protection rule, if any (P7-D3: never invented). */
export async function protectionRule(tx: Tx, jurisdictionCode: string, onDate: string): Promise<ProtectionRuleDto> {
  const { rows } = await sql<{ days: unknown; required: unknown; source: string | null; requiredReviewed: boolean }>`
    select app.jurisdiction_rule(${jurisdictionCode}, 'deposit_protection_deadline_days', ${onDate}::date) as days,
           app.jurisdiction_rule(${jurisdictionCode}, 'deposit_protection_required', ${onDate}::date) as required,
           (select s.source_reference from jurisdictions j join jurisdiction_settings s
               on s.key = 'deposit_protection_deadline_days' and s.jurisdiction_code in (j.code, j.parent_code)
              and s.effective_from <= ${onDate}::date and (s.effective_to is null or s.effective_to > ${onDate}::date)
             where j.code = ${jurisdictionCode}
             order by (s.jurisdiction_code = j.code) desc, s.effective_from desc limit 1) as source,
           exists (select 1 from jurisdictions j join jurisdiction_settings s
               on s.key = 'deposit_protection_required' and s.jurisdiction_code in (j.code, j.parent_code)
              and s.effective_from <= ${onDate}::date and (s.effective_to is null or s.effective_to > ${onDate}::date)
             where j.code = ${jurisdictionCode}) as "requiredReviewed"`.execute(tx);
  const row = rows[0]!;
  const days = typeof row.days === 'number' ? row.days : null;
  return { reviewed: days !== null, days, required: row.requiredReviewed ? row.required === true : null, source: days !== null ? row.source : null };
}
