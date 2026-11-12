import { Injectable } from '@nestjs/common';
import { type RawBuilder, sql } from 'kysely';

import { Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import { contactScopeSql, scopeFor } from '../contacts/contact-access.js';
import { hasMatchSql } from '../contacts/requirement-matching.js';
import { CrmSettingsService } from '../crm/crm-settings.service.js';
import { leadScopeSql } from '../crm/lead-access.js';
import type { Tx } from '../database/database.module.js';
import type { AdminDashboardDto, CrmDashboardDto, DashboardScopeDto, LeadStatusCountsDto, MyDayDto, ResponseRowDto } from './dto.js';

export interface DashboardQuery {
  officeId: string | null;
  days: number;
  timezone: string | null;
}

interface Window {
  timezone: string;
  from: Date;
  now: Date;
  tomorrow: Date;
  weekEnd: Date;
  today: string;
}

/**
 * Dashboards (CA-14; wireframes D-A, D-C, D-M). Every number is computed in
 * the viewer's own scope, so a count never reveals records outside it, and
 * every number corresponds to a list filter the viewer can open. Figures the
 * product cannot know yet are null with the reason in the API description,
 * never zero.
 */
@Injectable()
export class DashboardsService {
  constructor(private readonly settings: CrmSettingsService) {}

  // ------------------------------------------------------------------- CRM (D-C)

  async crm(tx: Tx, ctx: TenantContext, query: DashboardQuery): Promise<CrmDashboardDto> {
    const leadScope = scopeFor(ctx, 'lead.view')!;
    await this.checkOffice(tx, ctx, query.officeId, leadScope);
    const window = await this.window(tx, ctx, query);
    const target = (await this.settings.get(tx)).leadResponseMinutes;
    const leadFilter = sql<boolean>`${leadScopeSql(leadScope, ctx, 'l')} and l.archived_at is null
      ${query.officeId ? sql`and l.office_id = ${query.officeId}::uuid` : sql``}`;
    const inWindow = sql<boolean>`l.received_at >= ${window.from}`;

    const waiting = await sql<{ id: string; reference: string; contactName: string; sourceCode: string; assignedTo: string | null; assignedToName: string | null; receivedAt: Date; total: string }>`
      select l.id, l.reference, c.display_name as contact_name, l.source_code, l.assigned_to, u.display_name as assigned_to_name, l.received_at,
             count(*) over () as total
        from leads l
        join contacts c on c.id = l.contact_id
        left join company_memberships m on m.id = l.assigned_to
        left join users u on u.id = m.user_id
       where ${leadFilter} and l.status = 'new' and l.first_response_at is null
       order by l.received_at, l.id
       limit 10`.execute(tx);

    const statusRows = await sql<{ status: string; n: string }>`
      select l.status, count(*) as n from leads l where ${leadFilter} and ${inWindow} group by l.status`.execute(tx);

    // Both breakdowns come from one pass over the period's leads: the
    // qualified flag is a hash join against the qualified transitions once,
    // not a lookup per lead, and grouping sets share the scan.
    const agentsVisible = leadScope !== 'own';
    const breakdown = await sql<ResponseAggregate & { byAgent: number; assignedTo: string | null; name: string | null; sourceCode: string | null }>`
      with w as materialized (
        select l.assigned_to, l.source_code, l.received_at, l.first_response_at, (q.lead_id is not null) as was_qualified
          from leads l
          left join (select distinct h.lead_id from lead_status_history h
                      where h.company_id = ${ctx.companyId}::uuid and h.to_status = 'qualified') q on q.lead_id = l.id
         where ${leadFilter} and ${inWindow}
      )
      select grouping(l.assigned_to) = 0 as by_agent, l.assigned_to, u.display_name as name, l.source_code,
             ${this.responseAggregates(target)}
        from w l
        left join company_memberships m on m.id = l.assigned_to
        left join users u on u.id = m.user_id
       group by grouping sets ((l.assigned_to, u.display_name), (l.source_code))
       order by count(*) desc`.execute(tx);
    const agentRows = agentsVisible
      ? breakdown.rows
          .filter((row) => row.byAgent && row.assignedTo !== null)
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.assignedTo!.localeCompare(b.assignedTo!))
          .map((row) => ({ ...row, assignedTo: row.assignedTo!, name: row.name ?? '' }))
      : null;
    const sourceRows = {
      rows: breakdown.rows
        .filter((row) => !row.byAgent)
        .map((row) => ({ ...row, sourceCode: row.sourceCode! }))
        .sort((a, b) => Number(b.leads) - Number(a.leads) || a.sourceCode.localeCompare(b.sourceCode)),
    };

    return {
      scope: scopeDto(query, window),
      responseTargetMinutes: target,
      newNotContacted: {
        total: waiting.rows.length > 0 ? Number(waiting.rows[0]!.total) : 0,
        items: waiting.rows.map((row) => ({
          id: row.id,
          reference: row.reference,
          contactName: row.contactName,
          sourceCode: row.sourceCode,
          assignedTo: row.assignedTo !== null ? { id: row.assignedTo, name: row.assignedToName ?? '' } : null,
          receivedAt: row.receivedAt.toISOString(),
          overdue: target === null ? null : window.now.getTime() > row.receivedAt.getTime() + target * 60_000,
        })),
      },
      followUps: await this.followUpCounts(tx, ctx, query.officeId, window),
      leadsByStatus: statusCounts(statusRows.rows),
      responseTimes: agentRows ? agentRows.map((row) => ({ assignee: { id: row.assignedTo, name: row.name }, ...responseRow(row, target) })) : null,
      leadsBySource: sourceRows.rows.map((row) => ({ sourceCode: row.sourceCode, ...responseRow(row, target) })),
      requirements: await this.requirementCounts(tx, ctx, query.officeId),
    };
  }

  // ----------------------------------------------------------------- admin (D-A)

  async admin(tx: Tx, ctx: TenantContext, query: DashboardQuery): Promise<AdminDashboardDto> {
    await this.checkOffice(tx, ctx, query.officeId, 'all');
    const window = await this.window(tx, { ...ctx }, { ...query, days: 7 });
    const target = (await this.settings.get(tx)).leadResponseMinutes;
    const office = (alias: string) => (query.officeId ? sql`and ${sql.ref(`${alias}.officeId`)} = ${query.officeId}::uuid` : sql``);

    const { rows: [counts] } = await sql<{
      pendingInvitations: string;
      expiredInvitations: string;
      licencesExpiring: string;
      withoutOwner: string;
      documentsExpiring: string;
      checksExpiring: string;
      withdrawals: string;
      reveals: string;
      exports: string;
      failedImports: string;
      activeUsers: string;
      seats: number | null;
      storageUsed: string | null;
      storageLimit: string | null;
      supportGrants: string;
    }>`
      select
        (select count(*) from invitations i where i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) as pending_invitations,
        (select count(*) from invitations i where i.accepted_at is null and i.revoked_at is null and i.expires_at <= now()) as expired_invitations,
        (select count(*) from agent_profiles a join company_memberships m on m.id = a.membership_id
          where m.status = 'active' and a.licence_expires_on between current_date and current_date + 60) as licences_expiring,
        (select count(*) from contacts c where c.owner_membership_id is null and c.merged_into_contact_id is null and c.archived_at is null ${office('c')}) as without_owner,
        (select count(*) from identity_documents d join contacts c on c.id = d.contact_id
          where d.archived_at is null and d.expires_on between current_date and current_date + 30 and c.merged_into_contact_id is null ${office('c')}) as documents_expiring,
        (select count(*) from kyc_checks k join contacts c on c.id = k.contact_id
          where k.status = 'verified' and k.expires_on between current_date and current_date + 30 ${office('c')}) as checks_expiring,
        (select count(*) from consents s join contacts c on c.id = s.contact_id
          where s.status = 'withdrawn' and s.purpose = 'marketing' and s.captured_at >= now() - interval '7 days' ${office('c')}) as withdrawals,
        (select count(*) from audit_logs g where g.action = 'contact.sensitive_revealed' and g.occurred_at >= now() - interval '7 days') as reveals,
        (select count(*) from audit_logs g where g.action in ('contact.exported', 'lead.exported') and g.occurred_at >= now() - interval '7 days') as exports,
        (select count(*) from import_jobs j where j.status = 'failed' and j.created_at >= now() - interval '30 days') as failed_imports,
        (select count(*) from company_memberships m where m.status = 'active' and m.membership_type = 'staff') as active_users,
        (select s.seats from subscriptions s where s.status in ('trialing', 'active', 'past_due') order by s.created_at desc limit 1) as seats,
        (select su.bytes_used from storage_usage su) as storage_used,
        (select e.limit_value from subscriptions s
           join plan_entitlements e on e.plan_code = s.plan_code and e.feature_key = 'storage.bytes' and e.is_enabled
          where s.status in ('trialing', 'active', 'past_due') order by s.created_at desc limit 1) as storage_limit,
        (select count(*) from support_access_grants g where g.status in ('requested', 'approved') and (g.expires_at is null or g.expires_at > now())) as support_grants`.execute(tx);

    // Duplicate groups: the same phone or email on more than one active contact, or the same identity number.
    const { rows: [duplicates] } = await sql<{ n: string }>`
      select (
        (select count(*) from (
           select m.normalised from contact_methods m join contacts c on c.id = m.contact_id
            where c.merged_into_contact_id is null and c.archived_at is null and not c.is_anonymised
              and m.method_type in ('email', 'mobile', 'phone', 'whatsapp') ${office('c')}
            group by m.normalised having count(distinct m.contact_id) > 1) g)
        +
        (select count(*) from (
           select d.number_hash from identity_documents d join contacts c on c.id = d.contact_id
            where d.archived_at is null and c.merged_into_contact_id is null and c.archived_at is null ${office('c')}
            group by d.number_hash having count(distinct d.contact_id) > 1) g)) as n`.execute(tx);

    const flow = await sql<{ officeId: string | null; officeName: string | null; newLeads: string; unassigned: string; pastTarget: string | null }>`
      select l.office_id, o.name as office_name,
             count(*) filter (where l.received_at >= ${window.from}) as new_leads,
             count(*) filter (where l.assigned_to is null and l.status = 'new') as unassigned,
             ${target === null ? sql`null` : sql`count(*) filter (where l.first_response_at is null and l.status = 'new' and l.received_at + make_interval(mins => ${target}) < now())`} as past_target
        from leads l left join offices o on o.id = l.office_id
       where l.archived_at is null and (l.received_at >= ${window.from} or (l.status = 'new' and l.first_response_at is null)) ${office('l')}
       group by l.office_id, o.name
       order by o.name nulls last`.execute(tx);

    const exports = await tx
      .selectFrom('exportJobs as e')
      .innerJoin('companyMemberships as m', 'm.id', 'e.requestedBy')
      .innerJoin('users as u', 'u.id', 'm.userId')
      .select(['e.id', 'e.exportType', 'e.status', 'e.rowCount', 'e.requestedBy', 'u.displayName', 'e.createdAt'])
      .orderBy('e.createdAt', 'desc')
      .orderBy('e.id', 'desc')
      .limit(5)
      .execute();

    const n = (value: string | null | undefined) => Number(value ?? 0);
    const unassignedOld = await sql<{ n: string }>`
      select count(*) as n from leads l where l.archived_at is null and l.assigned_to is null and l.status = 'new'
         and l.received_at < now() - interval '1 hour' ${office('l')}`.execute(tx);
    const pastTarget = flow.rows.reduce((sum, row) => sum + n(row.pastTarget), 0);
    // Data-subject requests (gap G3): company-wide, for members who may see the register.
    const privacy =
      scopeFor(ctx, 'privacy.view') === null
        ? null
        : (
            await sql<{ open: string; overdue: string }>`
              select count(*) as open, count(*) filter (where coalesce(extended_due_on, due_on) < current_date) as overdue
                from data_subject_requests where closed_at is null`.execute(tx)
          ).rows[0];
    const attention = [
      ...(privacy ? [{ code: 'privacy_requests_overdue', count: n(privacy.overdue), message: 'Data-subject requests past their due date', link: '/api/v1/privacy-requests?filter[view]=overdue' }] : []),
      { code: 'unassigned_leads', count: n(unassignedOld.rows[0]?.n), message: 'New leads unassigned for more than an hour', link: '/api/v1/leads?filter[assignedTo]=unassigned' },
      ...(target !== null ? [{ code: 'response_overdue', count: pastTarget, message: 'New leads past the response target', link: '/api/v1/leads?filter[attention]=response_overdue' }] : []),
      { code: 'expired_invitations', count: n(counts!.expiredInvitations), message: 'Invitations expired before they were accepted', link: null },
      { code: 'identity_checks_expiring', count: n(counts!.checksExpiring) + n(counts!.documentsExpiring), message: 'Identity checks or documents expiring within 30 days', link: '/api/v1/kyc-checks?filter[expiring]=true' },
      { code: 'failed_imports', count: n(counts!.failedImports), message: 'Imports failed in the last 30 days', link: null },
      { code: 'agent_licences', count: n(counts!.licencesExpiring), message: 'Agent licences expiring within 60 days', link: null },
    ]
      .filter((item): item is { code: string; count: number; message: string; link: string | null } => item.count > 0)
      .slice(0, 5);

    return {
      scope: scopeDto(query, window),
      needsAttention: attention,
      usersAndAccess: {
        pendingInvitations: n(counts!.pendingInvitations),
        expiredInvitations: n(counts!.expiredInvitations),
        usersWithoutRequiredMfa: null,
        agentLicencesExpiring: n(counts!.licencesExpiring),
      },
      leadFlow: {
        days: 7,
        responseTargetMinutes: target,
        offices: flow.rows.map((row) => ({
          office: row.officeId !== null ? { id: row.officeId, name: row.officeName ?? '' } : null,
          newLeads: n(row.newLeads),
          unassigned: n(row.unassigned),
          noResponsePastTarget: target === null ? null : n(row.pastTarget),
        })),
      },
      dataQuality: {
        possibleDuplicateGroups: n(duplicates!.n),
        contactsWithoutOwner: n(counts!.withoutOwner),
        identityDocumentsExpiring: n(counts!.documentsExpiring),
        identityChecksExpiring: n(counts!.checksExpiring),
      },
      privacy: {
        dataSubjectRequestsOpen: privacy ? n(privacy.open) : null,
        dataSubjectRequestsOverdue: privacy ? n(privacy.overdue) : null,
        marketingWithdrawals: n(counts!.withdrawals),
        sensitiveReveals: n(counts!.reveals),
        exports: n(counts!.exports),
      },
      importsExports: {
        recentExports: exports.map((row) => ({
          id: row.id,
          exportType: row.exportType,
          status: row.status,
          rowCount: row.rowCount,
          requestedBy: { id: row.requestedBy, name: row.displayName },
          createdAt: row.createdAt.toISOString(),
        })),
        failedImports: n(counts!.failedImports),
      },
      account: {
        users: { used: n(counts!.activeUsers), limit: counts!.seats },
        storage: { used: n(counts!.storageUsed), limit: counts!.storageLimit === null ? null : n(counts!.storageLimit) },
        supportAccessGrantsOpen: n(counts!.supportGrants),
      },
    };
  }

  // --------------------------------------------------------------- my day (D-M)

  async myDay(tx: Tx, ctx: TenantContext, query: DashboardQuery): Promise<MyDayDto> {
    const window = await this.window(tx, ctx, query);
    const target = (await this.settings.get(tx)).leadResponseMinutes;
    const tasks = await sql<{ id: string; title: string; dueAt: Date; entityType: string | null; entityId: string | null; about: string | null; version: number }>`
      select t.id, t.title, t.due_at, t.entity_type, t.entity_id, t.version,
             case t.entity_type
               when 'contact' then (select c.display_name from contacts c where c.id = t.entity_id)
               when 'lead' then (select l.reference || ' · ' || c.display_name from leads l join contacts c on c.id = l.contact_id where l.id = t.entity_id)
             end as about
        from tasks t
       where t.assigned_to = ${ctx.membershipId}::uuid and t.status = 'open' and t.due_at < ${window.tomorrow}
       order by t.due_at, t.id
       limit 200`.execute(tx);
    const leads = await sql<{ id: string; reference: string; contactName: string; receivedAt: Date; leadType: string }>`
      select l.id, l.reference, c.display_name as contact_name, l.received_at, l.lead_type
        from leads l join contacts c on c.id = l.contact_id
       where l.assigned_to = ${ctx.membershipId}::uuid and l.status = 'new' and l.archived_at is null
       order by l.received_at, l.id
       limit 100`.execute(tx);
    const { rows: [summary] } = await sql<{ later: string; overdue: string; newLeads: string; pastTarget: string | null }>`
      select
        (select count(*) from tasks t where t.assigned_to = ${ctx.membershipId}::uuid and t.status = 'open'
            and t.due_at >= ${window.tomorrow} and t.due_at < ${window.weekEnd}) as later,
        (select count(*) from tasks t where t.assigned_to = ${ctx.membershipId}::uuid and t.status = 'open' and t.due_at < now()) as overdue,
        (select count(*) from leads l where l.assigned_to = ${ctx.membershipId}::uuid and l.status = 'new' and l.archived_at is null) as new_leads,
        ${target === null ? sql`null` : sql`(select count(*) from leads l where l.assigned_to = ${ctx.membershipId}::uuid and l.archived_at is null
            and l.first_response_at is null and l.status in ('new', 'contacted', 'qualified') and l.received_at + make_interval(mins => ${target}) < now())`} as past_target`.execute(tx);
    const statusRows = await sql<{ status: string; n: string }>`
      select l.status, count(*) as n from leads l where l.assigned_to = ${ctx.membershipId}::uuid and l.archived_at is null group by l.status`.execute(tx);

    const now = window.now.getTime();
    const items = [
      ...tasks.rows.map((row) => ({
        kind: 'follow_up',
        id: row.id,
        at: row.dueAt.toISOString(),
        title: row.title,
        about: row.about,
        aboutType: row.entityType,
        aboutId: row.entityId,
        overdue: row.dueAt.getTime() < now,
        version: row.version,
      })),
      ...leads.rows.map((row) => ({
        kind: 'new_lead',
        id: row.id,
        at: row.receivedAt.toISOString(),
        title: `New ${row.leadType} lead`,
        about: `${row.reference} · ${row.contactName}`,
        aboutType: 'lead',
        aboutId: row.id,
        overdue: target !== null && now > row.receivedAt.getTime() + target * 60_000,
        version: null,
      })),
    ].sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    return {
      timezone: window.timezone,
      date: window.today,
      today: items,
      laterThisWeek: Number(summary!.later),
      waitingOnMe: {
        newLeadsAssigned: Number(summary!.newLeads),
        overdueFollowUps: Number(summary!.overdue),
        leadsPastTarget: summary!.pastTarget === null ? null : Number(summary!.pastTarget),
      },
      myLeadsByStatus: statusCounts(statusRows.rows),
    };
  }

  // ----------------------------------------------------------------- helpers

  /** Follow-ups: managers see their team's (lead.assign scope), everyone else their own. */
  private async followUpCounts(tx: Tx, ctx: TenantContext, officeId: string | null, window: Window) {
    const assignScope = scopeFor(ctx, 'lead.assign');
    let who: RawBuilder<boolean>;
    if (assignScope === 'all') who = officeId ? memberInOffices([officeId]) : sql<boolean>`true`;
    else if (assignScope === 'office') who = memberInOffices(officeId ? [officeId] : [...ctx.officeIds]);
    else who = sql<boolean>`t.assigned_to = ${ctx.membershipId}::uuid`;
    const { rows: [row] } = await sql<{ overdue: string; today: string; week: string }>`
      select count(*) filter (where t.due_at < now()) as overdue,
             count(*) filter (where t.due_at >= now() and t.due_at < ${window.tomorrow}) as today,
             count(*) filter (where t.due_at >= now() and t.due_at < ${window.weekEnd}) as week
        from tasks t where t.status = 'open' and ${who}`.execute(tx);
    return { overdue: Number(row!.overdue), today: Number(row!.today), thisWeek: Number(row!.week), view: assignScope === null ? 'mine' : 'team' };
  }

  /** Active requirements of contacts in scope; "no match" needs listing.view (only listings the viewer may see count). */
  /**
   * Active requirements of contacts in scope. "No match" reads the status the
   * worker refreshes every 15 minutes (a live count over a whole register is
   * too slow); requirements changed since the last check are "pending".
   */
  private async requirementCounts(tx: Tx, ctx: TenantContext, officeId: string | null) {
    const contactScope = scopeFor(ctx, 'contact.view');
    if (contactScope === null) return null;
    const listingVisible = scopeFor(ctx, 'listing.view') !== null;
    const { rows: [row] } = await sql<{ buy: string; rent: string; noMatch: string; pending: string; checkedAt: Date | null }>`
      select count(*) filter (where r.requirement_type = 'buy') as buy,
             count(*) filter (where r.requirement_type = 'rent') as rent,
             count(*) filter (where m.has_match = false and m.checked_at >= r.updated_at) as no_match,
             count(*) filter (where m.requirement_id is null or m.checked_at < r.updated_at) as pending,
             min(m.checked_at) as checked_at
        from requirements r
        join contacts c on c.id = r.contact_id
        left join requirement_match_status m on m.company_id = r.company_id and m.requirement_id = r.id
       where r.status = 'active' and c.archived_at is null and c.merged_into_contact_id is null
         and ${contactScopeSql(contactScope, ctx, 'c', 'read')}
         ${officeId ? sql`and c.office_id = ${officeId}::uuid` : sql``}`.execute(tx);
    return {
      buy: Number(row!.buy),
      rent: Number(row!.rent),
      noMatch: listingVisible ? Number(row!.noMatch) : null,
      noMatchPending: listingVisible ? Number(row!.pending) : null,
      noMatchCheckedAt: listingVisible ? (row!.checkedAt?.toISOString() ?? null) : null,
    };
  }

  private responseAggregates(target: number | null) {
    return sql`count(*) as leads,
      percentile_cont(0.5) within group (order by extract(epoch from (l.first_response_at - l.received_at)) / 60)
        filter (where l.first_response_at is not null) as median_minutes,
      ${target === null ? sql`null` : sql`count(*) filter (where l.first_response_at <= l.received_at + make_interval(mins => ${target}))`} as within_target,
      count(*) filter (where l.was_qualified) as qualified`;
  }

  /** The office filter must be an office of the company within the viewer's scope. */
  private async checkOffice(tx: Tx, ctx: TenantContext, officeId: string | null, scope: PermissionScope): Promise<void> {
    if (officeId === null) return;
    const office = await tx.selectFrom('offices').select('id').where('id', '=', officeId).executeTakeFirst();
    if (!office || (scope !== 'all' && !ctx.officeIds.includes(officeId))) {
      throw Problems.validation([{ field: 'officeId', code: 'out-of-scope', message: 'Choose one of your offices.' }]);
    }
  }

  /** Period and day boundaries in the requested time zone (default: the member's first office, else the company's). */
  private async window(tx: Tx, ctx: TenantContext, query: DashboardQuery): Promise<Window> {
    let timezone = query.timezone;
    if (timezone === null) {
      const office = ctx.officeIds[0] ? await tx.selectFrom('offices').select('timezone').where('id', '=', ctx.officeIds[0]).executeTakeFirst() : undefined;
      timezone = office?.timezone ?? (await tx.selectFrom('companies').select('defaultTimezone').where('id', '=', ctx.companyId).executeTakeFirstOrThrow()).defaultTimezone;
    }
    const { rows: [row] } = await sql<{ now: Date; from: Date; tomorrow: Date; weekEnd: Date; today: string }>`
      select now() as now,
             now() - make_interval(days => ${query.days}) as "from",
             (date_trunc('day', now() at time zone ${timezone}) + interval '1 day') at time zone ${timezone} as tomorrow,
             (date_trunc('week', now() at time zone ${timezone}) + interval '7 days') at time zone ${timezone} as week_end,
             (now() at time zone ${timezone})::date::text as today`.execute(tx);
    return { timezone, from: row!.from, now: row!.now, tomorrow: row!.tomorrow, weekEnd: row!.weekEnd, today: row!.today };
  }
}

// --------------------------------------------------------------------- helpers

interface ResponseAggregate {
  leads: string;
  medianMinutes: number | null;
  withinTarget: string | null;
  qualified: string;
}

function memberInOffices(officeIds: string[]): RawBuilder<boolean> {
  if (officeIds.length === 0) return sql<boolean>`false`;
  return sql<boolean>`exists (select 1 from membership_offices mo where mo.membership_id = t.assigned_to and mo.office_id = any(${officeIds}::uuid[]))`;
}

function responseRow(row: ResponseAggregate, target: number | null): ResponseRowDto {
  const leads = Number(row.leads);
  const within = target === null || row.withinTarget === null ? null : Number(row.withinTarget);
  return {
    leads,
    medianFirstResponseMinutes: row.medianMinutes === null ? null : Math.round(Number(row.medianMinutes)),
    withinTarget: within,
    withinTargetPercent: within === null || leads === 0 ? null : Math.round((within / leads) * 1000) / 10,
    qualified: Number(row.qualified),
  };
}

function statusCounts(rows: Array<{ status: string; n: string }>): LeadStatusCountsDto {
  const count = (status: string) => Number(rows.find((row) => row.status === status)?.n ?? 0);
  return { new: count('new'), contacted: count('contacted'), qualified: count('qualified'), unqualified: count('unqualified'), lost: count('lost') };
}

function scopeDto(query: DashboardQuery, window: Window): DashboardScopeDto {
  return {
    officeId: query.officeId,
    timezone: window.timezone,
    from: window.from.toISOString(),
    to: window.now.toISOString(),
    generatedAt: window.now.toISOString(),
  };
}

/**
 * Refreshes requirement_match_status for every active requirement of the
 * company (worker job requirement.match_refresh). Uses the decision D4 rules
 * against all of the company's published listings.
 */
export async function refreshRequirementMatches(tx: Tx, ctx: TenantContext): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    with fresh as (
      insert into requirement_match_status (company_id, requirement_id, has_match, checked_at)
      select r.company_id, r.id, ${hasMatchSql(ctx, 'all')}, now()
        from requirements r where r.status = 'active'
      on conflict (company_id, requirement_id) do update set has_match = excluded.has_match, checked_at = excluded.checked_at
      returning 1
    ), stale as (
      delete from requirement_match_status m using requirements r
       where r.company_id = m.company_id and r.id = m.requirement_id and r.status <> 'active'
    )
    select count(*) as n from fresh`.execute(tx);
  return Number(rows[0]!.n);
}
