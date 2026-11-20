import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { keysetCondition, type Page, type ParsedListQuery, type RangeValue, sortValueSql, toPage } from '../common/list-query.js';
import { decimalPlaces, type MoneyInput, toMoney } from '../common/money.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { contactWithinScope, scopeFor } from '../contacts/contact-access.js';
import { ContactsService } from '../contacts/contacts.service.js';
import { memberGrant } from '../crm/lead-access.js';
import { LeadsService } from '../crm/leads.service.js';
import { recordSystemActivity } from '../crm/system-activity.js';
import type { Tx } from '../database/database.module.js';
import { listingScopeSql } from '../listings/listing-access.js';
import { ownersVerified } from '../properties/owner-identity.js';
import { nextReference } from '../properties/properties.service.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { canOnDeal, type DealAccessRow, dealScopeSql, grantCoversDeal, managesDeal } from './deal-access.js';
import { IDENTITY_MILESTONES, startBuyerIdentityChecks, syncIdentityMilestones } from './deal-effects.js';
import { type StageClass, stageMoveAllowed } from './deal-stage.js';
import {
  type ConvertLeadBody,
  type CreateDealBody,
  type DealAgentInput,
  type DealDto,
  type DealPartyBody,
  type DealStageDto,
  type DealSummaryDto,
  type ForecastDto,
  MANUAL_STAGE_CLASSES,
  type MoveStageBody,
  type PipelineDto,
  type PipelineTotalDto,
  type ReassignDealBody,
  type UpdateDealBody,
  type UpdateMilestoneBody,
} from './deals.dto.js';

registerConstraintMessages({
  deals_one_per_lead_idx: 'This lead has already been converted to a deal.',
  deal_parties_pkey: 'This contact already has this role on the deal.',
});

export type DealSortField = 'updatedAt' | 'createdAt' | 'stageEnteredAt';
const LIVE_LISTING = ['available', 'reserved', 'under_contract'];
const BUYER_ROLE = { sale: 'buyer', letting: 'tenant' } as const;
/** Stages after acceptance: milestones are worked and parties checked here. */
const AFTER_ACCEPTANCE = ['offer_accepted', 'contract'];

export type DealRow = NonNullable<Awaited<ReturnType<typeof loadDeal>>>;

/** The deal with its agents, for access checks; null when it does not exist. */
export async function loadDeal(tx: Tx, id: string, lock = false) {
  let query = tx
    .selectFrom('deals as d')
    .innerJoin('offices as of', 'of.id', 'd.officeId')
    .selectAll('d')
    .select(['of.countryCode'])
    .where('d.id', '=', id);
  if (lock) query = query.forUpdate('d');
  const deal = await query.executeTakeFirst();
  if (!deal) return null;
  const agents = await tx.selectFrom('dealAgents').select('membershipId').where('dealId', '=', id).execute();
  return { ...deal, agentIds: agents.map((row) => row.membershipId) };
}

/**
 * The deal locked for an action: 404 outside deal.view scope, 403 without the
 * permission, 412 on a stale version, and closed deals refused (S-D7).
 */
export async function lockDeal(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number | null, permission: string, options: { allowClosed?: boolean; manager?: string } = {}) {
  const deal = await loadDeal(tx, id, true);
  if (!deal || !canOnDeal(ctx, 'deal.view', deal)) throw Problems.notFound();
  if (!canOnDeal(ctx, permission, deal)) throw Problems.forbidden(permission === 'deal.close' ? 'Closing deals is for the company owner and sales managers.' : 'Your role does not allow this action on this deal.');
  if (options.manager && !managesDeal(ctx, deal)) throw Problems.forbidden(options.manager);
  if (expectedVersion !== null && deal.version !== expectedVersion) throw Problems.preconditionFailed();
  if (!options.allowClosed && (deal.status !== 'open' || deal.archivedAt !== null)) throw Problems.businessRule('This deal is closed. Closed deals do not change.');
  return deal;
}

/** The first active stage of a class in the deal's pipeline (the company's own stages first). */
export async function stageOfClass(tx: Tx, dealType: string, stageClass: StageClass) {
  return tx
    .selectFrom('pipelineStages')
    .select(['id', 'code', 'name', 'stageClass', 'sortOrder'])
    .where('dealType', '=', dealType)
    .where('stageClass', '=', stageClass)
    .where('isActive', '=', true)
    .orderBy(sql`company_id is null`)
    .orderBy('sortOrder')
    .executeTakeFirst();
}

/** Money in the deal's currency, at most its decimal places. */
export async function checkMoney(tx: Tx, money: MoneyInput, currencyCode: string, field: string, errors: FieldError[], allowZero = true): Promise<void> {
  if (money.currency !== currencyCode) {
    errors.push({ field: `${field}.currency`, code: 'currency-mismatch', message: `Amounts on this deal are in ${currencyCode}.` });
    return;
  }
  const currency = await tx.selectFrom('currencies').select('minorUnits').where('code', '=', currencyCode).executeTakeFirstOrThrow();
  if (decimalPlaces(money.amount) > currency.minorUnits) {
    errors.push({ field: `${field}.amount`, code: 'precision', message: `${currencyCode} has ${currency.minorUnits} decimal places.` });
  }
  if (!allowZero && Number(money.amount) <= 0) errors.push({ field: `${field}.amount`, code: 'positive', message: 'The amount must be more than zero.' });
}

/** System entry on the timeline of the deal, its contact, listing and lead (free text stays here, never in audit). */
export async function dealTimeline(tx: Tx, ctx: TenantContext, deal: { id: string; primaryContactId: string; listingId: string | null; leadId: string | null }, subject: string, body: string | null): Promise<void> {
  await recordSystemActivity(tx, ctx, {
    activityType: 'system',
    subject,
    body,
    links: [
      { entityType: 'deal', entityId: deal.id },
      { entityType: 'contact', entityId: deal.primaryContactId },
      ...(deal.listingId ? [{ entityType: 'listing' as const, entityId: deal.listingId }] : []),
      ...(deal.leadId ? [{ entityType: 'lead' as const, entityId: deal.leadId }] : []),
    ],
  });
}

export function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

interface NewDeal {
  dealType: 'sale' | 'letting';
  primaryContactId: string;
  listingId: string | null;
  officeId: string | null;
  ownerMembershipId: string | null;
  expectedValue: MoneyInput | null;
  expectedFee: MoneyInput | null;
  expectedCloseDate: string | null;
  probabilityOverride: number | null;
  sourceCode: string | null;
  leadId: string | null;
  stageClass: StageClass;
}

/**
 * Deals (Phase 6 milestone S3; SAL-01, SAL-05 to SAL-07; readiness report
 * §4.3, §4.4). A deal moves through its pipeline by actions only: by hand
 * among the stages before negotiation, by offers to "offer accepted", by
 * exchange and completion (DealProgressService) or by losing it. The
 * database enforces the life cycle, the contract and completion rules, the
 * splits and the histories (migrations 0030, 0032, 0033); this service
 * checks first to answer with field-level codes, and adds scope, the
 * timeline, audit and outbox events.
 */
/** Listing statuses after which an open deal on the listing can no longer complete (S6, S3-R3). */
export const CLOSED_LISTING_STATUSES = ['sold', 'rented', 'withdrawn', 'expired'] as const;

@Injectable()
export class DealsService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly leads: LeadsService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, query: ParsedListQuery<DealSortField>): Promise<Page<DealSummaryDto>> {
    const f = query.filters;
    const sortColumn = `d.${query.sort.field}`;
    let qb = this.summaryQuery(tx)
      .select(sortValueSql(sortColumn, query.sort.kind).as('cursorValue'))
      .where('d.archivedAt', 'is', null)
      .where(dealScopeSql(scopeFor(ctx, 'deal.view'), ctx));
    const statuses = Array.isArray(f['status']) ? f['status'] : ['open'];
    qb = qb.where('d.status', 'in', statuses);
    for (const [filter, column] of [
      ['dealType', 'd.dealType'],
      ['stageId', 'd.stageId'],
      ['stageClass', 'd.stageClass'],
      ['officeId', 'd.officeId'],
      ['listingId', 'd.listingId'],
      ['leadId', 'd.leadId'],
    ] as const) {
      const values = f[filter];
      if (Array.isArray(values)) qb = qb.where(column, 'in', values);
    }
    const owners = f['ownerMembershipId'];
    if (Array.isArray(owners)) qb = qb.where('d.ownerMembershipId', 'in', owners.map((value) => (value === 'me' ? ctx.membershipId : value.toLowerCase())));
    const contact = f['contactId'];
    if (Array.isArray(contact)) {
      qb = qb.where((eb) =>
        eb.or([
          eb('d.primaryContactId', 'in', contact),
          eb.exists(eb.selectFrom('dealParties as p').select('p.dealId').whereRef('p.dealId', '=', 'd.id').where('p.contactId', 'in', contact)),
        ]),
      );
    }
    const attention = f['attention'];
    if (Array.isArray(attention) && attention.includes('stalled')) {
      qb = qb.where(sql<boolean>`s.stall_after_days is not null and d.stage_entered_at < now() - make_interval(days => s.stall_after_days)`);
    }
    // Open deals left behind when their listing closed (another buyer's sale, a withdrawal): S3-R3.
    if (Array.isArray(attention) && attention.includes('listing_closed')) qb = qb.where('l.status', 'in', [...CLOSED_LISTING_STATUSES]);
    const close = f['expectedCloseDate'] as RangeValue | undefined;
    if (close?.gte) qb = qb.where('d.expectedCloseDate', '>=', close.gte);
    if (close?.lte) qb = qb.where('d.expectedCloseDate', '<=', close.lte);
    if (query.q !== null) {
      const q = escapeLike(query.q);
      qb = qb.where((eb) => eb.or([eb('d.reference', 'ilike', `${q}%`), eb('c.displayName', 'ilike', `%${q}%`)]));
    }
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'd.id', query.sort, query.cursor));
    const rows = await qb.orderBy(sql.ref(sortColumn), query.sort.direction).orderBy('d.id', query.sort.direction).limit(query.limit + 1).execute();
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => toSummary(row));
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<DealDto> {
    const row = await this.summaryQuery(tx)
      .leftJoin('leads as ld', 'ld.id', 'd.leadId')
      .select(['d.expectedFee', 'd.probabilityOverride', 'd.sourceCode', 'd.lostReasonCode', 'd.lostNotes', 'd.leadId', 'd.unitId', 'd.createdAt', 'd.version', 'ld.reference as leadReference', 'd.officeId', 'd.ownerMembershipId', 'd.primaryContactId'])
      .where('d.id', '=', id)
      .executeTakeFirst();
    if (!row) throw Problems.notFound();
    const agentRows = await tx
      .selectFrom('dealAgents as a')
      .innerJoin('companyMemberships as m', 'm.id', 'a.membershipId')
      .innerJoin('users as u', 'u.id', 'm.userId')
      .select(['a.membershipId', 'u.displayName', 'a.agentRole', 'a.splitPercent'])
      .where('a.dealId', '=', id)
      .orderBy('a.splitPercent', 'desc')
      .orderBy('a.membershipId')
      .execute();
    const access: DealAccessRow = { officeId: row.officeId, ownerMembershipId: row.ownerMembershipId, agentIds: agentRows.map((a) => a.membershipId) };
    if (!canOnDeal(ctx, 'deal.view', access)) throw Problems.notFound();

    const [parties, milestones, history, assignments, accepted, sale, minor] = await Promise.all([
      tx
        .selectFrom('dealParties as p')
        .innerJoin('contacts as c', 'c.id', 'p.contactId')
        .select(['p.contactId', 'c.displayName', 'p.partyRole', 'p.isPrimary', 'c.officeId', 'c.ownerMembershipId'])
        .where('p.dealId', '=', id)
        .orderBy('p.isPrimary', 'desc')
        .orderBy('p.partyRole')
        .orderBy('c.displayName')
        .execute(),
      tx
        .selectFrom('dealMilestones as m')
        .leftJoin('companyMemberships as cm', 'cm.id', 'm.completedBy')
        .leftJoin('users as cu', 'cu.id', 'cm.userId')
        .select(['m.id', 'm.code', 'm.name', 'm.sortOrder', 'm.isRequired', 'm.dueDate', 'm.completedAt', 'm.completedBy', 'cu.displayName as completedByName', 'm.notes', sql<boolean>`m.completed_at is null and m.due_date < current_date`.as('overdue')])
        .where('m.dealId', '=', id)
        .orderBy('m.sortOrder')
        .orderBy('m.code')
        .execute(),
      tx
        .selectFrom('dealStageHistory as h')
        .innerJoin('pipelineStages as ts', 'ts.id', 'h.toStageId')
        .leftJoin('pipelineStages as fs', 'fs.id', 'h.fromStageId')
        .leftJoin('companyMemberships as hm', 'hm.id', 'h.changedBy')
        .leftJoin('users as hu', 'hu.id', 'hm.userId')
        .select([
          'h.changedAt', 'h.changedBy', 'hu.displayName as changedByName', 'h.note',
          'ts.id as toId', 'ts.code as toCode', 'ts.name as toName', 'ts.stageClass as toClass', 'ts.sortOrder as toOrder',
          'fs.id as fromId', 'fs.code as fromCode', 'fs.name as fromName', 'fs.stageClass as fromClass', 'fs.sortOrder as fromOrder',
        ])
        .where('h.dealId', '=', id)
        .orderBy('h.changedAt')
        .orderBy('h.entryNo')
        .execute(),
      tx
        .selectFrom('dealAssignments as a')
        .innerJoin('companyMemberships as tm', 'tm.id', 'a.toMembershipId')
        .innerJoin('users as tu', 'tu.id', 'tm.userId')
        .leftJoin('companyMemberships as fm', 'fm.id', 'a.fromMembershipId')
        .leftJoin('users as fu', 'fu.id', 'fm.userId')
        .leftJoin('companyMemberships as bm', 'bm.id', 'a.assignedBy')
        .leftJoin('users as bu', 'bu.id', 'bm.userId')
        .select(['a.fromMembershipId', 'fu.displayName as fromName', 'a.toMembershipId', 'tu.displayName as toName', 'a.assignedBy', 'bu.displayName as assignedByName', 'a.assignedAt', 'a.note'])
        .where('a.dealId', '=', id)
        .orderBy('a.assignedAt')
        .orderBy('a.entryNo')
        .execute(),
      tx
        .selectFrom('offers as o')
        .innerJoin('contacts as c', 'c.id', 'o.offeredByContactId')
        .select(['o.id', 'o.amount', 'o.currencyCode', 'o.rentFrequency', 'o.offeredByContactId', 'c.displayName'])
        .where('o.dealId', '=', id)
        .where('o.status', '=', 'accepted')
        .executeTakeFirst(),
      tx.selectFrom('salesTransactions').selectAll().where('dealId', '=', id).executeTakeFirst(),
      tx.selectFrom('currencies').select('minorUnits').where('code', '=', row.currencyCode).executeTakeFirstOrThrow(),
    ]);

    // Identity is shown for contacts within the member's kyc.view scope only (as on the Ownership tab).
    const kycScope = scopeFor(ctx, 'kyc.view');
    const checkable = parties.filter((p) => kycScope !== null && contactWithinScope(kycScope, ctx, { officeId: p.officeId, ownerMembershipId: p.ownerMembershipId }));
    const verified = await ownersVerified(tx, checkable.map((p) => p.contactId));
    const buyerIds = new Set([row.primaryContactId, ...parties.filter((p) => p.partyRole === 'buyer' || p.partyRole === 'tenant').map((p) => p.contactId)]);
    const { rows: identityRows } = await sql<{ required: boolean }>`select app.deal_identity_required(${ctx.companyId}::uuid, ${id}::uuid) as required`.execute(tx);
    const open = row.status === 'open';
    const stageClass = row.stageClass as StageClass;
    const nextStages = open && canOnDeal(ctx, 'deal.update', access) ? await this.manualTargets(tx, row.dealType, row.stageId, stageClass) : [];

    return {
      ...toSummary(row),
      expectedFee: row.expectedFee === null ? null : toMoney(row.expectedFee, row.currencyCode, minor.minorUnits),
      probabilityOverride: row.probabilityOverride === null ? null : Number(row.probabilityOverride),
      sourceCode: row.sourceCode,
      lostReasonCode: row.lostReasonCode,
      lostNotes: row.lostNotes,
      lead: row.leadId !== null ? { id: row.leadId, name: row.leadReference ?? '' } : null,
      parties: parties.map((p) => ({
        contact: { id: p.contactId, name: p.displayName },
        partyRole: p.partyRole,
        isPrimary: p.isPrimary,
        identityVerified: verified.has(p.contactId) ? verified.get(p.contactId)! : null,
      })),
      agents: agentRows.map((a) => ({ member: { id: a.membershipId, name: a.displayName }, agentRole: a.agentRole, splitPercent: Number(a.splitPercent) })),
      milestones: milestones.map((m) => ({
        id: m.id,
        code: m.code,
        name: m.name,
        sortOrder: m.sortOrder,
        isRequired: m.isRequired,
        automatic: Object.hasOwn(IDENTITY_MILESTONES, m.code),
        dueDate: m.dueDate,
        overdue: m.overdue,
        completedAt: m.completedAt?.toISOString() ?? null,
        completedBy: m.completedBy !== null ? { id: m.completedBy, name: m.completedByName ?? '' } : null,
        notes: m.notes,
      })),
      stageHistory: history.map((h) => ({
        fromStage: h.fromId !== null ? { id: h.fromId, code: h.fromCode!, name: h.fromName!, stageClass: h.fromClass!, sortOrder: h.fromOrder! } : null,
        toStage: { id: h.toId, code: h.toCode, name: h.toName, stageClass: h.toClass, sortOrder: h.toOrder },
        changedAt: h.changedAt.toISOString(),
        changedBy: h.changedBy !== null ? { id: h.changedBy, name: h.changedByName ?? '' } : null,
        note: h.note,
      })),
      assignments: assignments.map((a) => ({
        from: a.fromMembershipId !== null ? { id: a.fromMembershipId, name: a.fromName ?? '' } : null,
        to: { id: a.toMembershipId, name: a.toName },
        assignedBy: a.assignedBy !== null ? { id: a.assignedBy, name: a.assignedByName ?? '' } : null,
        assignedAt: a.assignedAt.toISOString(),
        note: a.note,
      })),
      acceptedOffer: accepted
        ? { id: accepted.id, amount: toMoney(accepted.amount, accepted.currencyCode, minor.minorUnits), rentFrequency: accepted.rentFrequency, offeredBy: { id: accepted.offeredByContactId, name: accepted.displayName } }
        : null,
      sale: sale
        ? {
            id: sale.id,
            reference: sale.reference,
            status: sale.status,
            agreedPrice: toMoney(sale.agreedPrice, sale.currencyCode, minor.minorUnits),
            agencyFee: sale.agencyFee === null ? null : toMoney(sale.agencyFee, sale.currencyCode, minor.minorUnits),
            contractSignedOn: sale.contractSignedOn,
            completionDueOn: sale.completionDueOn,
            completedOn: sale.completedOn,
            titleTransferRef: sale.titleTransferRef,
            fallenThroughReason: sale.fallenThroughReason,
          }
        : null,
      identity: {
        required: identityRows[0]?.required ?? false,
        unverifiedBuyerIds: [...buyerIds].filter((contactId) => verified.get(contactId) === false).sort(),
      },
      access: {
        canEdit: open && canOnDeal(ctx, 'deal.update', access),
        nextStages,
        canReassign: open && managesDeal(ctx, access),
        canExchange: open && row.dealType === 'sale' && stageClass === 'offer_accepted' && canOnDeal(ctx, 'deal.update', access),
        canComplete: open && row.dealType === 'sale' && stageClass === 'contract' && canOnDeal(ctx, 'deal.close', access),
        canLose: open && canOnDeal(ctx, 'deal.close', access),
      },
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  /** Pipeline board columns (SAL-06): every active stage before closing, with counts, stalled counts and totals per currency. */
  async pipeline(tx: Tx, ctx: TenantContext, filters: { dealType: string; officeIds: string[] | null; ownerIds: string[] | null }): Promise<PipelineDto> {
    const stages = await tx
      .selectFrom('pipelineStages')
      .select(['id', 'code', 'name', 'stageClass', 'sortOrder'])
      .where('dealType', '=', filters.dealType)
      .where('isActive', '=', true)
      .where('stageClass', 'not in', ['closed_won', 'closed_lost'])
      .orderBy('sortOrder')
      .orderBy(sql`company_id is null`)
      .execute();
    let qb = tx
      .selectFrom('deals as d')
      .innerJoin('pipelineStages as s', 's.id', 'd.stageId')
      .select([
        'd.stageId',
        'd.currencyCode',
        sql<string>`count(*)::text`.as('count'),
        sql<string>`count(*) filter (where s.stall_after_days is not null and d.stage_entered_at < now() - make_interval(days => s.stall_after_days))::text`.as('stalled'),
        sql<string>`coalesce(sum(d.expected_value), 0)::text`.as('expected'),
        sql<string>`coalesce(sum(d.expected_value * coalesce(d.probability_override, s.default_probability) / 100), 0)::text`.as('weighted'),
      ])
      .where('d.dealType', '=', filters.dealType)
      .where('d.status', '=', 'open')
      .where('d.archivedAt', 'is', null)
      .where(dealScopeSql(scopeFor(ctx, 'deal.view'), ctx));
    if (filters.officeIds) qb = qb.where('d.officeId', 'in', filters.officeIds);
    if (filters.ownerIds) qb = qb.where('d.ownerMembershipId', 'in', filters.ownerIds);
    const rows = await qb.groupBy(['d.stageId', 'd.currencyCode']).orderBy('d.currencyCode').execute();
    const minor = await this.minorUnits(tx, rows.map((row) => row.currencyCode));
    return {
      dealType: filters.dealType,
      columns: stages.map((stage) => {
        const own = rows.filter((row) => row.stageId === stage.id);
        return {
          stage,
          count: own.reduce((sum, row) => sum + Number(row.count), 0),
          stalledCount: own.reduce((sum, row) => sum + Number(row.stalled), 0),
          totals: own.map((row) => total(row.currencyCode, row.count, row.expected, row.weighted, minor)),
        };
      }),
    };
  }

  /** Forecast (SAL-07): expected value × probability of open deals by expected close month, per currency. */
  async forecast(tx: Tx, ctx: TenantContext, filters: { dealType: string; from: string; months: number; officeIds: string[] | null; ownerIds: string[] | null }): Promise<ForecastDto> {
    const first = `${filters.from}-01`;
    let qb = tx
      .selectFrom('deals as d')
      .innerJoin('pipelineStages as s', 's.id', 'd.stageId')
      .select([
        sql<string>`case when d.expected_close_date is null then 'undated' when d.expected_close_date < ${first}::date then 'overdue' else to_char(d.expected_close_date, 'YYYY-MM') end`.as('bucket'),
        'd.currencyCode',
        sql<string>`count(*)::text`.as('count'),
        sql<string>`coalesce(sum(d.expected_value), 0)::text`.as('expected'),
        sql<string>`coalesce(sum(d.expected_value * coalesce(d.probability_override, s.default_probability) / 100), 0)::text`.as('weighted'),
      ])
      .where('d.dealType', '=', filters.dealType)
      .where('d.status', '=', 'open')
      .where('d.archivedAt', 'is', null)
      .where((eb) => eb.or([eb('d.expectedCloseDate', 'is', null), eb('d.expectedCloseDate', '<', sql<string>`(${first}::date + make_interval(months => ${filters.months}))::date`)]))
      .where(dealScopeSql(scopeFor(ctx, 'deal.view'), ctx));
    if (filters.officeIds) qb = qb.where('d.officeId', 'in', filters.officeIds);
    if (filters.ownerIds) qb = qb.where('d.ownerMembershipId', 'in', filters.ownerIds);
    const rows = await qb.groupBy(['bucket', 'd.currencyCode']).orderBy('d.currencyCode').execute();
    const minor = await this.minorUnits(tx, rows.map((row) => row.currencyCode));
    const bucket = (key: string) => rows.filter((row) => row.bucket === key).map((row) => total(row.currencyCode, row.count, row.expected, row.weighted, minor));
    const months: string[] = [];
    const [year, month] = filters.from.split('-').map(Number) as [number, number];
    for (let i = 0; i < filters.months; i += 1) {
      const date = new Date(Date.UTC(year, month - 1 + i, 1));
      months.push(date.toISOString().slice(0, 7));
    }
    return { dealType: filters.dealType, months: months.map((m) => ({ month: m, totals: bucket(m) })), overdue: bucket('overdue'), undated: bucket('undated') };
  }

  // ----------------------------------------------------------------- creating

  async create(tx: Tx, ctx: TenantContext, body: CreateDealBody): Promise<DealDto> {
    const id = await this.insertDeal(tx, ctx, {
      dealType: body.dealType,
      primaryContactId: body.primaryContactId,
      listingId: body.listingId ?? null,
      officeId: body.officeId ?? null,
      ownerMembershipId: body.ownerMembershipId ?? null,
      expectedValue: body.expectedValue ?? null,
      expectedFee: body.expectedFee ?? null,
      expectedCloseDate: body.expectedCloseDate ?? null,
      probabilityOverride: body.probabilityOverride ?? null,
      sourceCode: body.sourceCode ?? null,
      leadId: null,
      stageClass: 'lead',
    });
    return this.get(tx, ctx, id);
  }

  /**
   * Lead conversion (§4.4, P6-D11): a buy or rent lead becomes one deal in the
   * same step, keeping its history; the lead points at the deal. The deal
   * starts at qualification, or at viewing when a viewing is booked, and the
   * lead's live viewings of the deal's listing join the deal.
   */
  async convertLead(tx: Tx, ctx: TenantContext, leadId: string, expectedVersion: number, body: ConvertLeadBody): Promise<DealDto> {
    if (scopeFor(ctx, 'deal.create') === null) throw Problems.forbidden('Converting a lead needs permission to create deals.');
    const lead = await this.leads.lockLead(tx, ctx, leadId, expectedVersion, 'lead.update');
    const dealType = lead.leadType === 'buy' ? 'sale' : lead.leadType === 'rent' ? 'letting' : null;
    if (dealType === null) {
      throw Problems.validation([{ field: 'leadType', code: 'not-convertible', message: 'Only buy and rent leads become deals. Sell, let, valuation and management leads lead to an instruction.' }]);
    }
    if (!['new', 'contacted', 'qualified'].includes(lead.status)) throw Problems.businessRule(`A ${lead.status} lead cannot be converted. Reopen it first.`);
    const viewings = await tx
      .selectFrom('viewings')
      .select(['id', 'listingId'])
      .where('leadId', '=', leadId)
      .where('status', 'in', ['scheduled', 'confirmed'])
      .where('dealId', 'is', null)
      .execute();
    const listingId = body.listingId ?? lead.listingId;
    const dealId = await this.insertDeal(tx, ctx, {
      dealType,
      primaryContactId: lead.contactId,
      listingId,
      officeId: lead.officeId,
      ownerMembershipId: body.ownerMembershipId ?? lead.assignedTo ?? null,
      expectedValue: body.expectedValue ?? null,
      expectedFee: null,
      expectedCloseDate: body.expectedCloseDate ?? null,
      probabilityOverride: null,
      sourceCode: lead.sourceCode,
      leadId,
      stageClass: viewings.length > 0 ? 'viewing' : 'qualification',
    });
    const deal = await tx.selectFrom('deals').select(['reference']).where('id', '=', dealId).executeTakeFirstOrThrow();
    const joining = viewings.filter((v) => listingId === null || v.listingId === listingId).map((v) => v.id);
    if (joining.length > 0) await tx.updateTable('viewings').set({ dealId }).where('id', 'in', joining).execute();

    const note = `Converted to deal ${deal.reference}`;
    await tx.updateTable('leads').set({ status: 'converted', convertedDealId: dealId }).where('id', '=', leadId).execute();
    await tx.insertInto('leadStatusHistory').values({ companyId: ctx.companyId, leadId, fromStatus: lead.status, toStatus: 'converted', changedBy: ctx.membershipId, note }).execute();
    await recordSystemActivity(tx, ctx, {
      activityType: 'status_change',
      subject: `${lead.reference}: ${lead.status.charAt(0).toUpperCase()}${lead.status.slice(1)} → Converted`,
      body: note,
      links: [
        { entityType: 'lead', entityId: leadId },
        { entityType: 'contact', entityId: lead.contactId },
        { entityType: 'deal', entityId: dealId },
      ],
    });
    await this.audit.record(tx, ctx, {
      action: 'lead.converted',
      entityType: 'lead',
      entityId: leadId,
      changes: { status: { old: lead.status, new: 'converted' } },
      metadata: { dealId, viewingIds: joining },
    });
    await this.audit.emit(tx, ctx, { eventType: 'lead.converted', aggregateType: 'lead', aggregateId: leadId, payload: { leadId, dealId } });
    return this.get(tx, ctx, dealId);
  }

  // ----------------------------------------------------------------- editing

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateDealBody): Promise<DealDto> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.update');
    const errors: FieldError[] = [];
    const next: { listingId?: string | null; unitId?: string | null; expectedValue?: string | null; expectedFee?: string | null; expectedCloseDate?: string | null; probabilityOverride?: string | null } = {};
    if (body.listingId !== undefined && body.listingId !== deal.listingId) {
      const offers = await tx.selectFrom('offers').select('id').where('dealId', '=', id).executeTakeFirst();
      if (offers) errors.push({ field: 'listingId', code: 'has-offers', message: 'Offers are recorded on this deal: its listing no longer changes. Start a new deal for another property.' });
      else if (body.listingId === null) {
        next.listingId = null;
        next.unitId = null;
      } else {
        const listing = await this.usableListing(tx, ctx, body.listingId, deal.dealType, errors);
        if (listing && listing.currencyCode !== deal.currencyCode) {
          errors.push({ field: 'listingId', code: 'currency-mismatch', message: `This deal is in ${deal.currencyCode}; the listing is in ${listing.currencyCode}.` });
        } else if (listing) {
          next.listingId = listing.id;
          next.unitId = listing.unitId;
        }
      }
    }
    for (const key of ['expectedValue', 'expectedFee'] as const) {
      const money = body[key];
      if (money === undefined) continue;
      if (money !== null) await checkMoney(tx, money, deal.currencyCode, key, errors);
      next[key] = money === null ? null : money.amount;
    }
    if (body.expectedCloseDate !== undefined) {
      if (body.expectedCloseDate !== null && !isRealDate(body.expectedCloseDate)) errors.push({ field: 'expectedCloseDate', code: 'invalid', message: 'Use a real date such as 2027-03-31.' });
      next.expectedCloseDate = body.expectedCloseDate;
    }
    if (body.probabilityOverride !== undefined) next.probabilityOverride = body.probabilityOverride === null ? null : String(body.probabilityOverride);
    if (errors.length > 0) throw Problems.validation(errors);

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      const before = deal[key] === null ? null : key === 'expectedValue' || key === 'expectedFee' || key === 'probabilityOverride' ? Number(deal[key]) : deal[key];
      const after = next[key] === null || next[key] === undefined ? null : key === 'expectedValue' || key === 'expectedFee' || key === 'probabilityOverride' ? Number(next[key]) : next[key];
      if (before !== after) changes[key] = { old: deal[key], new: next[key] };
    }
    if (Object.keys(changes).length === 0) return this.get(tx, ctx, id);
    await tx.updateTable('deals').set(next).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'deal.updated', entityType: 'deal', entityId: id, changes });
    await this.audit.emit(tx, ctx, { eventType: 'deal.updated', aggregateType: 'deal', aggregateId: id, payload: { dealId: id, fields: Object.keys(changes) } });
    return this.get(tx, ctx, id);
  }

  /** Moves the deal by hand among the stages before negotiation, as the life cycle allows (§4.3); the note goes to the stage history. */
  async moveStage(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: MoveStageBody): Promise<DealDto> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.update');
    const target = await tx.selectFrom('pipelineStages').select(['id', 'dealType', 'stageClass', 'isActive', 'name']).where('id', '=', body.stageId).executeTakeFirst();
    if (!target || target.dealType !== deal.dealType || !target.isActive) {
      throw Problems.validation([{ field: 'stageId', code: 'not-found', message: "Choose an active stage of this deal's pipeline." }]);
    }
    if (target.id === deal.stageId) return this.get(tx, ctx, id);
    if (!(MANUAL_STAGE_CLASSES as readonly string[]).includes(target.stageClass)) {
      throw Problems.validation([{ field: 'stageId', code: 'action-stage', message: `${target.name} is reached by its action (accepting an offer, exchanging contracts, completing or losing the deal), not by moving the deal.` }]);
    }
    if (!stageMoveAllowed(deal.stageClass as StageClass, target.stageClass as StageClass)) {
      throw Problems.validation([{ field: 'stageId', code: 'stage-change', message: `A deal cannot move from ${deal.stageClass.replace('_', ' ')} to ${target.stageClass.replace('_', ' ')}.` }]);
    }
    await sql`select set_config('app.stage_note', ${body.note ?? ''}, true)`.execute(tx);
    await tx.updateTable('deals').set({ stageId: target.id }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, {
      action: 'deal.stage_changed',
      entityType: 'deal',
      entityId: id,
      changes: { stageId: { old: deal.stageId, new: target.id } },
      metadata: { fromStageClass: deal.stageClass, toStageClass: target.stageClass },
    });
    await this.audit.emit(tx, ctx, { eventType: 'deal.stage_changed', aggregateType: 'deal', aggregateId: id, payload: { dealId: id, fromStageId: deal.stageId, toStageId: target.id } });
    return this.get(tx, ctx, id);
  }

  /** SAL-05: a manager hands the deal to another agent; the database records who had it, who has it now and the note. */
  async reassign(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: ReassignDealBody): Promise<DealDto> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.update', { manager: 'Reassigning deals is a manager action.' });
    if (body.ownerMembershipId === deal.ownerMembershipId) return this.get(tx, ctx, id);
    const errors: FieldError[] = [];
    await this.checkWorker(tx, ctx, body.ownerMembershipId, deal, 'ownerMembershipId', errors);
    if (errors.length > 0) throw Problems.validation(errors);
    await sql`select set_config('app.assignment_note', ${body.note ?? ''}, true)`.execute(tx);
    await tx.updateTable('deals').set({ ownerMembershipId: body.ownerMembershipId }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'deal.reassigned', entityType: 'deal', entityId: id, changes: { ownerMembershipId: { old: deal.ownerMembershipId, new: body.ownerMembershipId } } });
    await this.audit.emit(tx, ctx, { eventType: 'deal.reassigned', aggregateType: 'deal', aggregateId: id, payload: { dealId: id, fromMembershipId: deal.ownerMembershipId, toMembershipId: body.ownerMembershipId } });
    return this.get(tx, ctx, id);
  }

  /** Agents credited on the deal and their splits (SAL-05); the whole list is replaced; splits add up to 100 %. */
  async setAgents(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, agents: DealAgentInput[]): Promise<DealDto> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.update', { manager: 'Setting agents and splits is a manager action.' });
    const errors: FieldError[] = [];
    const seen = new Set<string>();
    for (const [index, agent] of agents.entries()) {
      const key = `${agent.membershipId}:${agent.agentRole}`;
      if (seen.has(key)) errors.push({ field: `agents[${index}]`, code: 'duplicate', message: 'This agent already has this role on the deal.' });
      seen.add(key);
      await this.checkWorker(tx, ctx, agent.membershipId, deal, `agents[${index}].membershipId`, errors);
    }
    const total = agents.reduce((sum, agent) => sum + Math.round(agent.splitPercent * 10_000), 0);
    if (agents.length > 0 && total !== 1_000_000) {
      errors.push({ field: 'agents', code: 'splits-total', message: `The splits add up to ${total / 10_000} %, not 100 %.` });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    await tx.deleteFrom('dealAgents').where('dealId', '=', id).execute();
    if (agents.length > 0) {
      await tx
        .insertInto('dealAgents')
        .values(agents.map((agent) => ({ companyId: ctx.companyId, dealId: id, membershipId: agent.membershipId, agentRole: agent.agentRole, splitPercent: String(agent.splitPercent) })))
        .execute();
    }
    // The version moves so screens holding the old list reload it.
    await tx.updateTable('deals').set({ updatedAt: sql<Date>`now()` }).where('id', '=', id).execute();
    const summary = agents.map((agent) => ({ membershipId: agent.membershipId, agentRole: agent.agentRole, splitPercent: agent.splitPercent }));
    await this.audit.record(tx, ctx, { action: 'deal.agents_changed', entityType: 'deal', entityId: id, metadata: { agents: summary } });
    await this.audit.emit(tx, ctx, { eventType: 'deal.agents_changed', aggregateType: 'deal', aggregateId: id, payload: { dealId: id, agents: summary } });
    return this.get(tx, ctx, id);
  }

  async addParty(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: DealPartyBody): Promise<DealDto> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.update');
    const errors: FieldError[] = [];
    await this.activeContact(tx, ctx, body.contactId, 'contactId', errors);
    if (errors.length > 0) throw Problems.validation(errors);
    const existing = await tx.selectFrom('dealParties').select('contactId').where('dealId', '=', id).where('contactId', '=', body.contactId).where('partyRole', '=', body.partyRole).executeTakeFirst();
    if (existing) throw Problems.conflict('This contact already has this role on the deal.', { type: 'deal-party', id: body.contactId });
    await tx.insertInto('dealParties').values({ companyId: ctx.companyId, dealId: id, contactId: body.contactId, partyRole: body.partyRole, isPrimary: false }).execute();
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, { action: 'deal.party_added', entityType: 'deal', entityId: id, metadata: { contactId: body.contactId, partyRole: body.partyRole } });
    await this.audit.emit(tx, ctx, { eventType: 'deal.party_added', aggregateType: 'deal', aggregateId: id, payload: { dealId: id, contactId: body.contactId, partyRole: body.partyRole } });
    // After acceptance a new buyer needs an identity check; a verified newcomer may complete a side.
    if (AFTER_ACCEPTANCE.includes(deal.stageClass)) {
      await startBuyerIdentityChecks(tx, ctx, this.audit, id);
      await syncIdentityMilestones(tx, ctx, this.audit, [id]);
    }
    return this.get(tx, ctx, id);
  }

  async removeParty(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: DealPartyBody): Promise<DealDto> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.update');
    const party = await tx.selectFrom('dealParties').select(['contactId', 'isPrimary']).where('dealId', '=', id).where('contactId', '=', body.contactId).where('partyRole', '=', body.partyRole).executeTakeFirst();
    if (!party) throw Problems.notFound('This contact does not have this role on the deal.');
    if (party.isPrimary || body.contactId === deal.primaryContactId) {
      throw Problems.validation([{ field: 'contactId', code: 'primary-contact', message: "The deal's primary contact stays on the deal." }]);
    }
    await tx.deleteFrom('dealParties').where('dealId', '=', id).where('contactId', '=', body.contactId).where('partyRole', '=', body.partyRole).execute();
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, { action: 'deal.party_removed', entityType: 'deal', entityId: id, metadata: { contactId: body.contactId, partyRole: body.partyRole } });
    await this.audit.emit(tx, ctx, { eventType: 'deal.party_removed', aggregateType: 'deal', aggregateId: id, payload: { dealId: id, contactId: body.contactId, partyRole: body.partyRole } });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- milestones (SAL-04)

  async updateMilestone(tx: Tx, ctx: TenantContext, id: string, milestoneId: string, expectedVersion: number, body: UpdateMilestoneBody): Promise<DealDto> {
    await lockDeal(tx, ctx, id, expectedVersion, 'deal.update');
    const milestone = await this.openMilestone(tx, id, milestoneId);
    const next: { dueDate?: string | null; notes?: string | null } = {};
    if (body.dueDate !== undefined) {
      if (body.dueDate !== null && !isRealDate(body.dueDate)) throw Problems.validation([{ field: 'dueDate', code: 'invalid', message: 'Use a real date such as 2026-12-15.' }]);
      next.dueDate = body.dueDate;
    }
    if (body.notes !== undefined) next.notes = body.notes === '' ? null : body.notes;
    if (Object.keys(next).length === 0) return this.get(tx, ctx, id);
    await tx.updateTable('dealMilestones').set(next).where('id', '=', milestoneId).execute();
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, {
      action: 'deal.milestone_updated',
      entityType: 'deal',
      entityId: id,
      changes: next.dueDate !== undefined ? { dueDate: { old: milestone.dueDate, new: next.dueDate } } : null,
      metadata: { milestoneId, code: milestone.code, notesChanged: next.notes !== undefined },
    });
    return this.get(tx, ctx, id);
  }

  async completeMilestone(tx: Tx, ctx: TenantContext, id: string, milestoneId: string, expectedVersion: number, notes: string | null): Promise<DealDto> {
    const deal = await lockDeal(tx, ctx, id, expectedVersion, 'deal.update');
    const milestone = await this.openMilestone(tx, id, milestoneId);
    if (!AFTER_ACCEPTANCE.includes(deal.stageClass)) throw Problems.businessRule('Milestones are worked once an offer is accepted.');
    if (Object.hasOwn(IDENTITY_MILESTONES, milestone.code)) {
      throw Problems.validation([{ field: 'milestoneId', code: 'automatic', message: 'This milestone completes itself when the identities are verified (P6-D7). Sign off the identity checks instead.' }]);
    }
    await tx
      .updateTable('dealMilestones')
      .set({ completedAt: sql<Date>`now()`, completedBy: ctx.membershipId, ...(notes ? { notes } : {}) })
      .where('id', '=', milestoneId)
      .execute();
    await this.touch(tx, id);
    await this.audit.record(tx, ctx, { action: 'deal.milestone_completed', entityType: 'deal', entityId: id, metadata: { milestoneId, code: milestone.code, automatic: false } });
    await this.audit.emit(tx, ctx, { eventType: 'deal.milestone_completed', aggregateType: 'deal', aggregateId: id, payload: { dealId: id, milestoneId, code: milestone.code, automatic: false } });
    return this.get(tx, ctx, id);
  }

  // ----------------------------------------------------------------- helpers

  private async insertDeal(tx: Tx, ctx: TenantContext, input: NewDeal): Promise<string> {
    const createScope = scopeFor(ctx, 'deal.create');
    if (createScope === null) throw Problems.forbidden('Your role does not allow creating deals.');
    const errors: FieldError[] = [];
    await this.activeContact(tx, ctx, input.primaryContactId, input.leadId ? 'contactId' : 'primaryContactId', errors);
    const listing = input.listingId ? await this.usableListing(tx, ctx, input.listingId, input.dealType, errors) : null;
    const officeId = input.officeId ?? listing?.officeId ?? ctx.officeIds[0] ?? null;
    const office = officeId ? await tx.selectFrom('offices').select(['id', 'countryCode', 'currencyCode']).where('id', '=', officeId).executeTakeFirst() : undefined;
    if (!office) errors.push({ field: 'officeId', code: 'not-found', message: 'Choose an office for the deal.' });
    else if (createScope === 'office' && !ctx.officeIds.includes(office.id)) errors.push({ field: 'officeId', code: 'out-of-scope', message: 'Choose an office you work in.' });
    const ownerId = input.ownerMembershipId ?? ctx.membershipId;
    const currencyCode = listing?.currencyCode ?? office?.currencyCode ?? '';
    if (office) {
      const access = { officeId: office.id, ownerMembershipId: ownerId, agentIds: [] };
      if (ownerId !== ctx.membershipId) {
        if (createScope !== 'all' && createScope !== 'office') {
          errors.push({ field: 'ownerMembershipId', code: 'not-allowed', message: 'You can only create deals you are responsible for.' });
        } else await this.checkWorker(tx, ctx, ownerId, access, 'ownerMembershipId', errors, createScope);
      }
    }
    for (const key of ['expectedValue', 'expectedFee'] as const) {
      const money = input[key];
      if (money) await checkMoney(tx, money, currencyCode, key, errors);
    }
    if (input.expectedCloseDate !== null && !isRealDate(input.expectedCloseDate)) errors.push({ field: 'expectedCloseDate', code: 'invalid', message: 'Use a real date such as 2027-03-31.' });
    if (input.sourceCode && office && !input.leadId) {
      const error = await checkPicklistCode(tx, 'lead_source', input.sourceCode, office.countryCode, 'sourceCode');
      if (error) errors.push(error);
    }
    const stage = await stageOfClass(tx, input.dealType, input.stageClass);
    if (!stage) errors.push({ field: 'dealType', code: 'no-pipeline', message: 'No active pipeline stage is set up for this kind of deal.' });
    if (errors.length > 0 || !office || !stage) throw Problems.validation(errors);

    const expectedValue = input.expectedValue?.amount ?? (listing ? await this.listingValue(tx, listing) : null);
    const reference = await nextReference(tx, ctx, 'deal');
    const inserted = await tx
      .insertInto('deals')
      .values({
        companyId: ctx.companyId,
        reference,
        dealType: input.dealType,
        stageId: stage.id,
        stageClass: stage.stageClass,
        listingId: listing?.id ?? null,
        unitId: listing?.unitId ?? null,
        leadId: input.leadId,
        primaryContactId: input.primaryContactId,
        officeId: office.id,
        ownerMembershipId: ownerId,
        currencyCode,
        expectedValue,
        expectedFee: input.expectedFee?.amount ?? null,
        probabilityOverride: input.probabilityOverride === null ? null : String(input.probabilityOverride),
        expectedCloseDate: input.expectedCloseDate,
        sourceCode: input.sourceCode,
        createdBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx.insertInto('dealParties').values({ companyId: ctx.companyId, dealId: inserted.id, contactId: input.primaryContactId, partyRole: BUYER_ROLE[input.dealType], isPrimary: true }).execute();
    await dealTimeline(tx, ctx, { id: inserted.id, primaryContactId: input.primaryContactId, listingId: listing?.id ?? null, leadId: input.leadId }, `Deal ${reference} created${listing ? `: ${listing.reference}` : ''}`, null);
    await this.audit.record(tx, ctx, {
      action: 'deal.created',
      entityType: 'deal',
      entityId: inserted.id,
      metadata: { dealType: input.dealType, listingId: listing?.id ?? null, leadId: input.leadId, officeId: office.id, ownerMembershipId: ownerId, stageClass: stage.stageClass, sourceCode: input.sourceCode },
    });
    await this.audit.emit(tx, ctx, { eventType: 'deal.created', aggregateType: 'deal', aggregateId: inserted.id, payload: { dealId: inserted.id, dealType: input.dealType, listingId: listing?.id ?? null, leadId: input.leadId } });
    return inserted.id;
  }

  /** A live listing the member can see, of the deal's kind (sale listings for sales, rent listings for lettings). */
  private async usableListing(tx: Tx, ctx: TenantContext, listingId: string, dealType: string, errors: FieldError[]) {
    const scope = scopeFor(ctx, 'listing.view');
    const listing =
      scope === null
        ? undefined
        : await tx
            .selectFrom('listings as l')
            .select(['l.id', 'l.reference', 'l.unitId', 'l.officeId', 'l.listingType', 'l.status', 'l.currencyCode', 'l.price', 'l.rentFrequency', 'l.archivedAt'])
            .where('l.id', '=', listingId)
            .where(listingScopeSql(scope, ctx, 'l'))
            .executeTakeFirst();
    if (!listing) {
      errors.push({ field: 'listingId', code: 'not-found', message: 'Choose a listing you can see.' });
      return null;
    }
    if ((dealType === 'sale') !== (listing.listingType === 'sale')) {
      errors.push({ field: 'listingId', code: 'type-mismatch', message: dealType === 'sale' ? 'A sale deal needs a sale listing.' : 'A letting deal needs a rental listing.' });
      return null;
    }
    if (!LIVE_LISTING.includes(listing.status) || listing.archivedAt !== null) {
      errors.push({ field: 'listingId', code: 'listing-not-live', message: 'Choose a listing that is on the market.' });
      return null;
    }
    return listing;
  }

  /** Expected value from the listing: the price, or the rent per year. */
  private async listingValue(tx: Tx, listing: { price: string; rentFrequency: string | null }): Promise<string> {
    if (listing.rentFrequency === null) return listing.price;
    const { rows } = await sql<{ value: string }>`select app.rent_per_period(${listing.price}::numeric, ${listing.rentFrequency}, 'annual')::text as value`.execute(tx);
    return rows[0]?.value ?? listing.price;
  }

  /** The contact exists, the member can see it, and it is active (not archived, merged or erased). */
  private async activeContact(tx: Tx, ctx: TenantContext, contactId: string, field: string, errors: FieldError[]): Promise<void> {
    const contact = await this.contacts.loadRow(tx, contactId);
    if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) {
      errors.push({ field, code: 'not-found', message: 'Choose a contact you can see.' });
      return;
    }
    if (contact.mergedIntoContactId !== null || contact.archivedAt !== null || contact.isAnonymised) {
      errors.push({ field, code: 'not-active', message: 'This contact is archived, merged or erased. Choose an active contact.' });
    }
  }

  /**
   * Someone who will own or work on the deal: active staff whose deal.view
   * covers it, and (for someone else) within the manager's own reach: company
   * scope covers everyone, office scope members of the manager's offices.
   */
  private async checkWorker(tx: Tx, ctx: TenantContext, membershipId: string, deal: { officeId: string }, field: string, errors: FieldError[], managerScope = scopeFor(ctx, 'deal.update')): Promise<void> {
    const grant = await memberGrant(tx, membershipId, 'deal.view');
    if (!grant || grant.scope === null) {
      errors.push({ field, code: 'not-assignable', message: 'Choose an active team member who works with deals.' });
      return;
    }
    if (membershipId !== ctx.membershipId && managerScope === 'office' && !grant.officeIds.some((office) => ctx.officeIds.includes(office))) {
      errors.push({ field, code: 'not-allowed', message: `${grant.name} does not work in one of your offices.` });
      return;
    }
    if (!grantCoversDeal(grant, deal, true)) errors.push({ field, code: 'out-of-scope', message: `${grant.name} does not work in this deal's office.` });
  }

  private async openMilestone(tx: Tx, dealId: string, milestoneId: string) {
    const milestone = await tx.selectFrom('dealMilestones').selectAll().where('id', '=', milestoneId).where('dealId', '=', dealId).forUpdate().executeTakeFirst();
    if (!milestone) throw Problems.notFound('This milestone is not on this deal.');
    if (milestone.completedAt !== null) throw Problems.businessRule('This milestone is complete. Completed milestones do not change.');
    return milestone;
  }

  /** Stages the deal can be moved to by hand now (§4.3). */
  private async manualTargets(tx: Tx, dealType: string, currentStageId: string, current: StageClass): Promise<DealStageDto[]> {
    const stages = await tx
      .selectFrom('pipelineStages')
      .select(['id', 'code', 'name', 'stageClass', 'sortOrder'])
      .where('dealType', '=', dealType)
      .where('isActive', '=', true)
      .where('stageClass', 'in', [...MANUAL_STAGE_CLASSES])
      .where('id', '<>', currentStageId)
      .orderBy('sortOrder')
      .orderBy(sql`company_id is null`)
      .execute();
    return stages.filter((stage) => stageMoveAllowed(current, stage.stageClass as StageClass));
  }

  private async touch(tx: Tx, dealId: string): Promise<void> {
    await tx.updateTable('deals').set({ updatedAt: sql<Date>`now()` }).where('id', '=', dealId).execute();
  }

  private async minorUnits(tx: Tx, codes: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return new Map();
    const rows = await tx.selectFrom('currencies').select(['code', 'minorUnits']).where('code', 'in', unique).execute();
    return new Map(rows.map((row) => [row.code, row.minorUnits]));
  }

  private summaryQuery(tx: Tx) {
    return tx
      .selectFrom('deals as d')
      .innerJoin('pipelineStages as s', 's.id', 'd.stageId')
      .innerJoin('contacts as c', 'c.id', 'd.primaryContactId')
      .innerJoin('offices as of', 'of.id', 'd.officeId')
      .innerJoin('companyMemberships as om', 'om.id', 'd.ownerMembershipId')
      .innerJoin('users as ou', 'ou.id', 'om.userId')
      .innerJoin('currencies as cur', 'cur.code', 'd.currencyCode')
      .leftJoin('listings as l', 'l.id', 'd.listingId')
      .select([
        'd.id',
        'd.reference',
        'd.dealType',
        'd.stageId',
        's.code as stageCode',
        's.name as stageName',
        'd.stageClass',
        's.sortOrder as stageSortOrder',
        'd.status',
        'd.listingId',
        'l.reference as listingReference',
        'l.title as listingTitle',
        'l.status as listingStatus',
        'd.primaryContactId as contactId',
        'c.displayName as contactName',
        'd.officeId as officeRef',
        'of.name as officeName',
        'd.ownerMembershipId as ownerRef',
        'ou.displayName as ownerName',
        'd.currencyCode',
        'cur.minorUnits',
        'd.expectedValue',
        sql<string>`coalesce(d.probability_override, s.default_probability)::text`.as('probability'),
        'd.expectedCloseDate',
        'd.stageEnteredAt',
        sql<boolean>`d.status = 'open' and s.stall_after_days is not null and d.stage_entered_at < now() - make_interval(days => s.stall_after_days)`.as('stalled'),
        'd.closedAt',
        'd.updatedAt',
      ]);
  }
}

// --------------------------------------------------------------------- helpers

interface SummaryRow {
  id: string;
  reference: string;
  dealType: string;
  stageId: string;
  stageCode: string;
  stageName: string;
  stageClass: string;
  stageSortOrder: number;
  status: string;
  listingId: string | null;
  listingReference: string | null;
  listingTitle: string | null;
  listingStatus: string | null;
  contactId: string;
  contactName: string;
  officeRef: string;
  officeName: string;
  ownerRef: string;
  ownerName: string;
  currencyCode: string;
  minorUnits: number;
  expectedValue: string | null;
  probability: string;
  expectedCloseDate: string | null;
  stageEnteredAt: Date;
  stalled: boolean;
  closedAt: Date | null;
  updatedAt: Date;
}

function toSummary(row: SummaryRow): DealSummaryDto {
  const open = row.status === 'open';
  return {
    id: row.id,
    reference: row.reference,
    dealType: row.dealType,
    stage: { id: row.stageId, code: row.stageCode, name: row.stageName, stageClass: row.stageClass, sortOrder: row.stageSortOrder },
    status: row.status,
    listing: row.listingId !== null ? { id: row.listingId, reference: row.listingReference ?? '', title: row.listingTitle ?? '', status: row.listingStatus ?? '' } : null,
    primaryContact: { id: row.contactId, name: row.contactName },
    office: { id: row.officeRef, name: row.officeName },
    owner: { id: row.ownerRef, name: row.ownerName },
    expectedValue: row.expectedValue === null ? null : toMoney(row.expectedValue, row.currencyCode, row.minorUnits),
    weightedValue: row.expectedValue === null || !open ? null : toMoney(weigh(row.expectedValue, row.probability), row.currencyCode, row.minorUnits),
    probability: Number(row.probability),
    expectedCloseDate: row.expectedCloseDate,
    stageEnteredAt: row.stageEnteredAt.toISOString(),
    stalled: row.stalled,
    closedAt: row.closedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** value × percent / 100 on decimal strings, at the database scale (4 places), half-up. */
export function weigh(value: string, percent: string): string {
  const scaled = (text: string) => {
    const [whole = '0', fraction = ''] = text.split('.');
    return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
  };
  const product = scaled(value) * scaled(percent); // 10^8 scale, then / 100 for the percent
  const result = (product + 500_000n) / 1_000_000n; // back to 10^4 scale, half-up
  const text = result.toString().padStart(5, '0');
  return `${text.slice(0, -4)}.${text.slice(-4)}`;
}

function total(currency: string, count: string, expected: string, weighted: string, minor: Map<string, number>): PipelineTotalDto {
  const units = minor.get(currency) ?? 2;
  return { currency, count: Number(count), expectedValue: toMoney(expected, currency, units), weightedValue: toMoney(roundScale(weighted), currency, units) };
}

/** A database numeric with more than 4 decimal places, rounded half-up to 4 (toMoney reads at most 4). */
function roundScale(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length <= 4) return value;
  const scaled = BigInt(whole) * 10_000n + BigInt(fraction.slice(0, 4)) + (Number(fraction[4]) >= 5 ? 1n : 0n);
  const text = scaled.toString().padStart(5, '0');
  return `${text.slice(0, -4)}.${text.slice(-4)}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

