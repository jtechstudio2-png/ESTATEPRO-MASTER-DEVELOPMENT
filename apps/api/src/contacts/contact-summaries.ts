import { type RawBuilder, sql } from 'kysely';

import type { TenantContext } from '../common/request-context.js';
import { leadScopeSql, scopeOf } from '../crm/lead-access.js';
import type { Tx } from '../database/database.module.js';
import { listingScopeSql } from '../listings/listing-access.js';
import { propertyScopeSql } from '../properties/property-access.js';

/**
 * Per-row summaries for the contact and requirement registers (wireframes
 * SE-1, B-1 and LL-1; Phase 5 milestone C6). Each is computed for the rows of
 * one page only, and each is limited to what the viewer may see: a summary
 * never reveals a follow-up, lead, listing or property outside the viewer's
 * own scope, so a count or date cannot be used to infer hidden records.
 */

export interface NextFollowUpSummary {
  dueAt: string;
  overdue: boolean;
}

export interface ListingSummary {
  /** Listings not closed (draft, available, reserved, under contract) the viewer may see. */
  active: number;
  /** Of those, published. */
  published: number;
  /** The most recently updated one, for the list cell. */
  latest: { id: string; reference: string; status: string; isPublished: boolean } | null;
}

export interface LeadRef {
  id: string;
  reference: string;
  status: string;
}

/**
 * Follow-ups a member may see (the rules of TasksService.canSee in SQL): their
 * own, ones they created, and, for managers with `lead.assign`, those of the
 * people they manage (all, or in their offices).
 */
export function visibleTaskSql(ctx: TenantContext, alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  const own = sql<boolean>`(${column('assignedTo')} = ${ctx.membershipId}::uuid or ${column('createdBy')} = ${ctx.membershipId}::uuid)`;
  const manager = scopeOf(ctx, 'lead.assign');
  if (manager === 'all') return sql<boolean>`true`;
  if (manager === 'office' && ctx.officeIds.length > 0) {
    return sql<boolean>`(${own} or exists (select 1 from membership_offices mo
                                              where mo.company_id = ${column('companyId')} and mo.membership_id = ${column('assignedTo')}
                                                and mo.office_id = any(${[...ctx.officeIds]}::uuid[])))`;
  }
  return own;
}

/**
 * The next open follow-up about each contact, directly or through one of its
 * leads the viewer may open, among follow-ups the viewer may see.
 */
export async function nextFollowUps(tx: Tx, ctx: TenantContext, contactIds: string[]): Promise<Map<string, NextFollowUpSummary>> {
  const result = new Map<string, NextFollowUpSummary>();
  if (contactIds.length === 0) return result;
  const leadScope = scopeOf(ctx, 'lead.view');
  const { rows } = await sql<{ contactId: string; dueAt: Date }>`
    select distinct on (x.contact_id) x.contact_id, x.due_at
      from (
        select t.entity_id as contact_id, t.due_at
          from tasks t
         where t.entity_type = 'contact' and t.entity_id = any(${contactIds}::uuid[])
           and t.status = 'open' and t.due_at is not null and ${visibleTaskSql(ctx, 't')}
        union all
        select l.contact_id, t.due_at
          from leads l
          join tasks t on t.company_id = l.company_id and t.entity_type = 'lead' and t.entity_id = l.id
         where l.contact_id = any(${contactIds}::uuid[]) and l.archived_at is null and ${leadScopeSql(leadScope, ctx, 'l')}
           and t.status = 'open' and t.due_at is not null and ${visibleTaskSql(ctx, 't')}
      ) x
     order by x.contact_id, x.due_at`.execute(tx);
  const now = Date.now();
  for (const row of rows) result.set(row.contactId, { dueAt: row.dueAt.toISOString(), overdue: row.dueAt.getTime() < now });
  return result;
}

/**
 * Sellers (SE-1): the listings on units the contact currently owns or we
 * manage for them (the #12 landlord resolver, judged in each property's time
 * zone), counted only among listings the viewer may see.
 */
export async function sellerListings(tx: Tx, ctx: TenantContext, contactIds: string[]): Promise<Map<string, ListingSummary> | null> {
  const scope = scopeOf(ctx, 'listing.view');
  if (scope === null) return null;
  const result = new Map<string, ListingSummary>();
  if (contactIds.length === 0) return result;
  const { rows } = await sql<{ contactId: string; id: string; reference: string; status: string; isPublished: boolean; active: string; published: string }>`
    select x.contact_id, x.id, x.reference, x.status, x.is_published, x.active, x.published
      from (
        select c.id as contact_id, li.id, li.reference, li.status, li.is_published,
               count(*) over (partition by c.id) as active,
               count(*) filter (where li.is_published) over (partition by c.id) as published,
               row_number() over (partition by c.id order by li.updated_at desc, li.id) as position
          from unnest(${contactIds}::uuid[]) as c(id)
          cross join lateral app.landlord_unit_access(c.id) a
          join listings li on li.unit_id = a.unit_id
         where li.archived_at is null
           and li.status in ('draft', 'available', 'reserved', 'under_contract')
           and ${listingScopeSql(scope, ctx, 'li')}
      ) x
     where x.position = 1`.execute(tx);
  for (const row of rows) {
    result.set(row.contactId, {
      active: Number(row.active),
      published: Number(row.published),
      latest: { id: row.id, reference: row.reference, status: row.status, isPublished: row.isPublished },
    });
  }
  return result;
}

/** Sellers (SE-1): the latest open sell or valuation lead of each contact, among leads the viewer may see. */
export async function valuationLeads(tx: Tx, ctx: TenantContext, contactIds: string[]): Promise<Map<string, LeadRef> | null> {
  const scope = scopeOf(ctx, 'lead.view');
  if (scope === null) return null;
  const result = new Map<string, LeadRef>();
  if (contactIds.length === 0) return result;
  const { rows } = await sql<{ contactId: string; id: string; reference: string; status: string }>`
    select distinct on (l.contact_id) l.contact_id, l.id, l.reference, l.status
      from leads l
     where l.contact_id = any(${contactIds}::uuid[]) and l.archived_at is null
       and l.lead_type in ('sell', 'valuation') and l.status in ('new', 'contacted', 'qualified')
       and ${leadScopeSql(scope, ctx, 'l')}
     order by l.contact_id, l.received_at desc, l.id`.execute(tx);
  for (const row of rows) result.set(row.contactId, { id: row.id, reference: row.reference, status: row.status });
  return result;
}

/** Landlords (LL-1): how many properties the contact currently owns or we manage for them, among those the viewer may see. */
export async function landlordProperties(tx: Tx, ctx: TenantContext, contactIds: string[]): Promise<Map<string, number> | null> {
  const scope = scopeOf(ctx, 'property.view');
  if (scope === null) return null;
  const result = new Map<string, number>();
  if (contactIds.length === 0) return result;
  const { rows } = await sql<{ contactId: string; properties: string }>`
    select c.id as contact_id, count(distinct a.property_id) as properties
      from unnest(${contactIds}::uuid[]) as c(id)
      cross join lateral app.landlord_unit_access(c.id) a
      join properties p on p.id = a.property_id
     where ${propertyScopeSql(scope, ctx, 'p')}
     group by c.id`.execute(tx);
  for (const row of rows) result.set(row.contactId, Number(row.properties));
  return result;
}
