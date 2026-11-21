import { sql } from 'kysely';

import type { AuditService } from '../audit/audit.service.js';
import { todayIn } from '../common/dates.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { OWNER_CHECK_TYPE } from '../properties/owner-identity.js';

/**
 * Milestones that complete themselves (P6-D7): due diligence on a side of the
 * deal is done when every contact on that side has a verified identity.
 */
export const IDENTITY_MILESTONES: Readonly<Record<string, 'buyer' | 'seller'>> = { buyer_kyc: 'buyer', seller_kyc: 'seller' };
const IDENTITY_CODES = Object.keys(IDENTITY_MILESTONES);
const AUTOMATIC_NOTE = {
  buyer: "Completed automatically: every buyer's identity is verified.",
  seller: "Completed automatically: every seller's identity is verified.",
} as const;

interface AcceptedDeal {
  id: string;
  dealType: string;
  unitId: string | null;
}

/**
 * What accepting an offer starts (readiness §4.2 note, P6-D6, P6-D7): the
 * milestones are copied from the most specific templates, identity checks
 * are opened for buyers who are not yet verified (sales where the
 * jurisdiction requires it), and identity milestones that are already met
 * complete straight away. Accepting again after a withdrawal keeps the
 * milestones already on the deal.
 */
export async function onOfferAccepted(tx: Tx, ctx: TenantContext, audit: AuditService, deal: AcceptedDeal): Promise<void> {
  await copyMilestones(tx, ctx, deal);
  await startBuyerIdentityChecks(tx, ctx, audit, deal.id);
  await syncIdentityMilestones(tx, ctx, audit, [deal.id]);
}

/**
 * Copies the milestone templates onto the deal: for each code the company's
 * own template wins over the platform's, and a template for the property's
 * jurisdiction (or its parent) over one for any jurisdiction. Due dates count
 * from today in the property's time zone.
 */
export async function copyMilestones(tx: Tx, ctx: TenantContext, deal: AcceptedDeal): Promise<number> {
  const place = deal.unitId
    ? await tx
        .selectFrom('units as u')
        .innerJoin('properties as p', 'p.id', 'u.propertyId')
        .innerJoin('jurisdictions as j', 'j.code', 'p.jurisdictionCode')
        .select(['p.timezone', 'j.code', 'j.parentCode'])
        .where('u.id', '=', deal.unitId)
        .executeTakeFirst()
    : undefined;
  const today = todayIn(place?.timezone ?? 'UTC');
  const jurisdictions = [place?.code, place?.parentCode].filter((code): code is string => typeof code === 'string');
  const { rows } = await sql<{ id: string; code: string; name: string; sortOrder: number; isRequired: boolean; dueOffsetDays: number | null }>`
    select distinct on (t.code) t.id, t.code, t.name, t.sort_order, t.is_required, t.due_offset_days
      from milestone_templates t
     where t.deal_type = ${deal.dealType} and t.is_active
       and (t.company_id = ${ctx.companyId}::uuid or t.company_id is null)
       and (t.jurisdiction_code is null or t.jurisdiction_code = any(${jurisdictions}::text[]))
     order by t.code, (t.company_id is null), (t.jurisdiction_code is null), (t.jurisdiction_code = ${place?.code ?? ''}) desc`.execute(tx);
  if (rows.length === 0) return 0;
  const inserted = await tx
    .insertInto('dealMilestones')
    .values(
      rows.map((row) => ({
        companyId: ctx.companyId,
        dealId: deal.id,
        milestoneTemplateId: row.id,
        code: row.code,
        name: row.name,
        sortOrder: row.sortOrder,
        isRequired: row.isRequired,
        dueDate: row.dueOffsetDays === null ? null : addDays(today, row.dueOffsetDays),
      })),
    )
    .onConflict((oc) => oc.columns(['companyId', 'dealId', 'code']).doNothing())
    .returning('id')
    .execute();
  return inserted.length;
}

/**
 * Opens a pending identity check, linked to the deal, for each buyer whose
 * identity is not verified and who has no identity check in progress.
 * Applies to sales where the jurisdiction rule sales_kyc_required is on.
 */
export async function startBuyerIdentityChecks(tx: Tx, ctx: TenantContext, audit: AuditService, dealId: string): Promise<string[]> {
  const { rows } = await sql<{ contactId: string; checkType: string }>`
    select c.id as contact_id,
           case c.contact_type when 'organisation' then ${OWNER_CHECK_TYPE.organisation} else ${OWNER_CHECK_TYPE.person} end as check_type
      from app.deal_buyer_contacts(${ctx.companyId}::uuid, ${dealId}::uuid) as b(contact_id)
      join contacts c on c.id = b.contact_id
     where app.deal_identity_required(${ctx.companyId}::uuid, ${dealId}::uuid)
       and not c.is_anonymised and c.merged_into_contact_id is null
       and not app.contact_identity_verified(${ctx.companyId}::uuid, c.id)
       and not exists (
         select 1 from kyc_checks k
          where k.company_id = c.company_id and k.contact_id = c.id and k.status in ('pending', 'in_review')
            and k.check_type = case c.contact_type when 'organisation' then ${OWNER_CHECK_TYPE.organisation} else ${OWNER_CHECK_TYPE.person} end)
     order by c.id`.execute(tx);
  const created: string[] = [];
  for (const row of rows) {
    const check = await tx
      .insertInto('kycChecks')
      .values({ companyId: ctx.companyId, contactId: row.contactId, dealId, checkType: row.checkType, status: 'pending', recordedBy: ctx.membershipId })
      .returning('id')
      .executeTakeFirstOrThrow();
    created.push(check.id);
    await audit.record(tx, ctx, {
      action: 'kyc.check_recorded',
      entityType: 'contact',
      entityId: row.contactId,
      metadata: { kycCheckId: check.id, checkType: row.checkType, status: 'pending', dealId, startedBy: 'offer.accepted' },
    });
  }
  return created;
}

/** Contacts on one side of a deal: buyers (primary contact, buyer or tenant parties) or sellers (seller or landlord parties, current owners). */
export async function sideContacts(tx: Tx, companyId: string, dealId: string, side: 'buyer' | 'seller'): Promise<string[]> {
  const { rows } =
    side === 'buyer'
      ? await sql<{ contactId: string }>`select b as contact_id from app.deal_buyer_contacts(${companyId}::uuid, ${dealId}::uuid) b`.execute(tx)
      : await sql<{ contactId: string }>`
          select p.contact_id from deal_parties p where p.deal_id = ${dealId}::uuid and p.party_role in ('seller', 'landlord')
          union
          select o.owner_contact_id from deals d cross join lateral app.unit_current_owners(d.unit_id) o
           where d.id = ${dealId}::uuid and d.unit_id is not null`.execute(tx);
  return rows.map((row) => row.contactId).sort();
}

/**
 * Completes identity milestones whose side is fully verified (P6-D7), on the
 * given open deals. A completed milestone stays complete (S-D5); the contract
 * rule (P6-D6) checks every buyer again at exchange.
 */
export async function syncIdentityMilestones(tx: Tx, ctx: TenantContext, audit: AuditService, dealIds: readonly string[]): Promise<number> {
  if (dealIds.length === 0 || ctx.system) return 0;
  const open = await tx
    .selectFrom('dealMilestones as m')
    .innerJoin('deals as d', 'd.id', 'm.dealId')
    .select(['m.id', 'm.dealId', 'm.code'])
    .where('m.dealId', 'in', [...dealIds])
    .where('m.code', 'in', IDENTITY_CODES)
    .where('m.completedAt', 'is', null)
    .where('d.status', '=', 'open')
    .orderBy('m.dealId')
    .orderBy('m.sortOrder')
    .execute();
  let completed = 0;
  for (const milestone of open) {
    const side = IDENTITY_MILESTONES[milestone.code]!;
    const contacts = await sideContacts(tx, ctx.companyId, milestone.dealId, side);
    if (contacts.length === 0) continue;
    const { rows } = await sql<{ verified: boolean }>`
      select bool_and(app.contact_identity_verified(${ctx.companyId}::uuid, c)) as verified from unnest(${contacts}::uuid[]) c`.execute(tx);
    if (rows[0]?.verified !== true) continue;
    await tx
      .updateTable('dealMilestones')
      .set({ completedAt: sql<Date>`now()`, completedBy: ctx.membershipId, notes: AUTOMATIC_NOTE[side] })
      .where('id', '=', milestone.id)
      .execute();
    await audit.record(tx, ctx, {
      action: 'deal.milestone_completed',
      entityType: 'deal',
      entityId: milestone.dealId,
      metadata: { milestoneId: milestone.id, code: milestone.code, automatic: true },
    });
    await audit.emit(tx, ctx, {
      eventType: 'deal.milestone_completed',
      aggregateType: 'deal',
      aggregateId: milestone.dealId,
      payload: { dealId: milestone.dealId, milestoneId: milestone.id, code: milestone.code, automatic: true },
    });
    completed += 1;
  }
  return completed;
}

/** Open deals with an identity milestone still open where the contact is on a side (after a KYC sign-off). */
export async function dealsAwaitingIdentity(tx: Tx, companyId: string, contactId: string): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    select d.id from deals d
     where d.company_id = ${companyId}::uuid and d.status = 'open'
       and exists (select 1 from deal_milestones m where m.deal_id = d.id and m.code = any(${IDENTITY_CODES}::text[]) and m.completed_at is null)
       and (d.primary_contact_id = ${contactId}::uuid
            or exists (select 1 from deal_parties p where p.deal_id = d.id and p.contact_id = ${contactId}::uuid)
            or (d.unit_id is not null and exists (select 1 from app.unit_current_owners(d.unit_id) o where o.owner_contact_id = ${contactId}::uuid)))
     order by d.id`.execute(tx);
  return rows.map((row) => row.id);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
