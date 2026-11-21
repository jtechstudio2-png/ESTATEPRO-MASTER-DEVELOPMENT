import { Injectable } from '@nestjs/common';
import { type RawBuilder, sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { toMoney } from '../common/money.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { scopeFor } from '../contacts/contact-access.js';
import { ContactsService } from '../contacts/contacts.service.js';
import type { Tx } from '../database/database.module.js';
import { dealScopeSql } from '../deals/deal-access.js';
import { propertyScopeSql } from '../properties/property-access.js';
import { viewingScopeSql } from '../viewings/viewing-access.js';
import {
  LANDLORD_NOT_SHOWN,
  type LandlordDealDto,
  type LandlordListingDto,
  type LandlordListingViewDto,
  type LandlordOfferDto,
  type LandlordPreviewDto,
  type LandlordViewingDto,
} from './landlord.dto.js';

interface Sections {
  offers: boolean;
  deals: boolean;
  viewings: boolean;
}

/** For the staff preview: what the staff member may see themselves (their own scopes), or null for the landlord's own view. */
type StaffLimit = TenantContext | null;

interface AccessRow {
  listingId: string;
  since: string;
  timezone: string;
  reference: string;
  title: string;
  listingType: string;
  status: string;
  propertyName: string | null;
  unitLabel: string;
  propertyId: string;
}

const LINKED_PERMISSIONS = { offers: 'offer.view', deals: 'deal.view', viewings: 'viewing.view' } as const;

/**
 * Landlord visibility (Phase 6 milestone S4; issue #5; readiness report §6;
 * P6-D10). Reduced, read-only views of the offers, deal progress and viewings
 * on a landlord's own listings, built for landlords (never the staff
 * responses with fields hidden). Which listings, and from when, comes from
 * the database (app.landlord_listing_access, over the C4 resolver), so the
 * landlord portal (Phase 7) and the staff preview (LL-1) read the same thing.
 */
@Injectable()
export class LandlordViewsService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- the landlord's own views

  async myListings(tx: Tx, ctx: TenantContext): Promise<LandlordListingDto[]> {
    const contactId = this.portalLandlord(ctx, 'listing.view');
    const sections = this.linkedSections(ctx);
    const rows = await this.access(tx, contactId, null);
    return Promise.all(rows.map((row) => this.summary(tx, row, sections, null)));
  }

  async myListing(tx: Tx, ctx: TenantContext, listingId: string): Promise<LandlordListingViewDto> {
    const contactId = this.portalLandlord(ctx, 'listing.view');
    const view = await this.view(tx, contactId, listingId, this.linkedSections(ctx), null);
    if (!view) throw Problems.notFound();
    return view;
  }

  // ----------------------------------------------------------------- the staff preview (LL-1)

  /**
   * "What this landlord could see" for one listing: the landlord's view, limited
   * to what the staff member may see themselves (contact, property and each
   * section by their own scope). Read-only and audited.
   */
  async preview(tx: Tx, ctx: TenantContext, contactId: string, listingId: string): Promise<LandlordPreviewDto> {
    const contact = await this.contacts.loadRow(tx, contactId);
    if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) throw Problems.notFound();
    if (scopeFor(ctx, 'property.view') === null) throw Problems.forbidden('The preview needs permission to view properties.');
    const sections = {
      offers: scopeFor(ctx, 'offer.view') !== null,
      deals: scopeFor(ctx, 'deal.view') !== null,
      viewings: scopeFor(ctx, 'viewing.view') !== null,
    };
    const view = await this.view(tx, contactId, listingId, sections, ctx);
    if (!view) throw Problems.notFound();
    await this.audit.record(tx, ctx, {
      action: 'contact.portal_preview',
      entityType: 'contact',
      entityId: contactId,
      metadata: {
        portal: 'landlord',
        listingId,
        offers: view.offers?.length ?? null,
        deals: view.deals?.length ?? null,
        viewings: view.viewings?.length ?? null,
      },
    });
    const limited = (['property.view', 'offer.view', 'deal.view', 'viewing.view'] as const).some((key) => scopeFor(ctx, key) !== 'all');
    return { ...view, contactId, limitedToYourAccess: limited };
  }

  // ----------------------------------------------------------------- building

  private async view(tx: Tx, contactId: string, listingId: string, sections: Sections, staff: StaffLimit): Promise<LandlordListingViewDto | null> {
    const row = (await this.access(tx, contactId, staff, listingId))[0];
    if (!row) return null;
    const [listing, offers, deals, viewings] = await Promise.all([
      this.summary(tx, row, sections, staff),
      sections.offers ? this.offers(tx, row, staff) : Promise.resolve(null),
      sections.deals ? this.deals(tx, row, staff) : Promise.resolve(null),
      sections.viewings ? this.viewings(tx, row, staff) : Promise.resolve(null),
    ]);
    return { listing, offers, deals, viewings, notShown: [...LANDLORD_NOT_SHOWN] };
  }

  private async access(tx: Tx, contactId: string, staff: StaffLimit, listingId?: string): Promise<AccessRow[]> {
    const propertyScope = staff ? scopeFor(staff, 'property.view') : null;
    const { rows } = await sql<AccessRow>`
      select a.listing_id, a.since::text as since, a.timezone, l.reference, l.title, l.listing_type, l.status,
             p.name as property_name, u.unit_label, p.id as property_id
        from app.landlord_listing_access(${contactId}::uuid) a
        join listings l on l.id = a.listing_id
        join units u on u.id = a.unit_id
        join properties p on p.id = a.property_id
       where ${listingId ? sql`a.listing_id = ${listingId}::uuid` : sql`true`}
         and ${staff && propertyScope ? propertyScopeSql(propertyScope, staff, 'p') : sql`true`}
       order by l.reference, l.id`.execute(tx);
    return rows;
  }

  private async summary(tx: Tx, row: AccessRow, sections: Sections, staff: StaffLimit): Promise<LandlordListingDto> {
    const { rows } = await sql<{ openOffers: number; upcomingViewings: number; openDeals: number }>`
      select
        (select count(*)::int from offers o join deals d on d.id = o.deal_id
          where ${this.offerWhere(row, staff)} and o.status = 'submitted') as open_offers,
        (select count(*)::int from viewings v join listings l on l.id = v.listing_id
           left join leads ld on ld.id = v.lead_id left join deals d on d.id = v.deal_id
          where ${this.viewingWhere(row, staff)} and v.status in ('scheduled', 'confirmed') and v.scheduled_end >= now()) as upcoming_viewings,
        (select count(*)::int from deals d where ${this.dealWhere(row, staff)} and d.status = 'open') as open_deals`.execute(tx);
    const counts = rows[0]!;
    return {
      id: row.listingId,
      reference: row.reference,
      title: row.title,
      listingType: row.listingType,
      status: row.status,
      propertyName: row.propertyName,
      unitLabel: row.unitLabel,
      timezone: row.timezone,
      visibleSince: row.since,
      openOffers: sections.offers ? counts.openOffers : null,
      upcomingViewings: sections.viewings ? counts.upcomingViewings : null,
      openDeals: sections.deals ? counts.openDeals : null,
    };
  }

  private async offers(tx: Tx, row: AccessRow, staff: StaffLimit): Promise<LandlordOfferDto[]> {
    const { rows } = await sql<{
      id: string;
      direction: string;
      offeredByName: string;
      amount: string;
      currencyCode: string;
      minorUnits: number;
      rentFrequency: string | null;
      conditions: string | null;
      financingCode: string | null;
      status: string;
      submittedAt: Date;
      expiresAt: Date | null;
      respondedAt: Date | null;
      parentOfferId: string | null;
    }>`
      select o.id, o.direction, c.display_name as offered_by_name, o.amount::text as amount, o.currency_code, cur.minor_units,
             o.rent_frequency, o.conditions, o.financing_code, o.status, o.submitted_at, o.expires_at, o.responded_at, o.parent_offer_id
        from offers o
        join deals d on d.id = o.deal_id
        join contacts c on c.id = o.offered_by_contact_id
        join currencies cur on cur.code = o.currency_code
       where ${this.offerWhere(row, staff)}
       order by o.submitted_at desc, o.entry_no desc
       limit 500`.execute(tx);
    return rows.map((o) => ({
      id: o.id,
      direction: o.direction,
      offeredByName: o.offeredByName,
      amount: toMoney(o.amount, o.currencyCode, o.minorUnits),
      rentFrequency: o.rentFrequency,
      conditions: o.conditions,
      financingCode: o.financingCode,
      status: o.status,
      submittedAt: o.submittedAt.toISOString(),
      expiresAt: o.expiresAt?.toISOString() ?? null,
      respondedAt: o.respondedAt?.toISOString() ?? null,
      parentOfferId: o.parentOfferId,
    }));
  }

  private async deals(tx: Tx, row: AccessRow, staff: StaffLimit): Promise<LandlordDealDto[]> {
    const { rows } = await sql<{ id: string; stageName: string; stageClass: string; status: string }>`
      select d.id, s.name as stage_name, d.stage_class, d.status
        from deals d join pipeline_stages s on s.id = d.stage_id
       where ${this.dealWhere(row, staff)}
       order by d.created_at desc, d.id desc
       limit 100`.execute(tx);
    if (rows.length === 0) return [];
    const milestones = await tx
      .selectFrom('dealMilestones')
      .select(['dealId', 'name', 'completedAt', 'dueDate'])
      .where('dealId', 'in', rows.map((d) => d.id))
      .orderBy('sortOrder')
      .orderBy('code')
      .execute();
    return rows.map((d) => ({
      id: d.id,
      stageName: d.stageName,
      stageClass: d.stageClass,
      status: d.status,
      milestones: milestones.filter((m) => m.dealId === d.id).map((m) => ({ name: m.name, done: m.completedAt !== null, dueDate: m.dueDate })),
    }));
  }

  private async viewings(tx: Tx, row: AccessRow, staff: StaffLimit): Promise<LandlordViewingDto[]> {
    const { rows } = await sql<{
      id: string;
      scheduledStart: Date;
      scheduledEnd: Date;
      timezone: string;
      viewingType: string;
      status: string;
      outcome: string | null;
      feedback: string | null;
      sellerFeedbackShared: boolean;
    }>`
      select v.id, v.scheduled_start, v.scheduled_end, v.timezone, v.viewing_type, v.status, v.outcome, v.feedback, v.seller_feedback_shared
        from viewings v
        join listings l on l.id = v.listing_id
        left join leads ld on ld.id = v.lead_id
        left join deals d on d.id = v.deal_id
       where ${this.viewingWhere(row, staff)}
       order by v.scheduled_start desc, v.id desc
       limit 500`.execute(tx);
    return rows.map((v) => ({
      id: v.id,
      scheduledStart: v.scheduledStart.toISOString(),
      scheduledEnd: v.scheduledEnd.toISOString(),
      timezone: v.timezone,
      viewingType: v.viewingType,
      status: v.status,
      outcome: v.status === 'completed' ? v.outcome : null,
      feedback: v.status === 'completed' && v.sellerFeedbackShared ? v.feedback : null,
    }));
  }

  // ----------------------------------------------------------------- conditions

  /** Offers on the listing from the landlord's start (property time zone); for the preview, within the staff member's offer scope. */
  private offerWhere(row: AccessRow, staff: StaffLimit): RawBuilder<boolean> {
    return sql<boolean>`o.listing_id = ${row.listingId}::uuid
      and (o.submitted_at at time zone ${row.timezone})::date >= ${row.since}::date
      and ${staff ? dealScopeSql(scopeFor(staff, 'offer.view'), staff, 'd') : sql`true`}`;
  }

  /** Viewings of the listing from the landlord's start, without superseded (rescheduled) ones. */
  private viewingWhere(row: AccessRow, staff: StaffLimit): RawBuilder<boolean> {
    return sql<boolean>`v.listing_id = ${row.listingId}::uuid and v.status <> 'rescheduled'
      and (v.scheduled_start at time zone ${row.timezone})::date >= ${row.since}::date
      and ${staff ? viewingScopeSql(scopeFor(staff, 'viewing.view'), staff) : sql`true`}`;
  }

  /** Deals on the listing that began on or after the landlord's start. */
  private dealWhere(row: AccessRow, staff: StaffLimit): RawBuilder<boolean> {
    return sql<boolean>`d.listing_id = ${row.listingId}::uuid
      and (d.created_at at time zone ${row.timezone})::date >= ${row.since}::date
      and ${staff ? dealScopeSql(scopeFor(staff, 'deal.view'), staff, 'd') : sql`true`}`;
  }

  // ----------------------------------------------------------------- portal access

  /** The landlord's own views are for landlord portal accounts: a portal membership linked to a contact, with the linked scope. */
  private portalLandlord(ctx: TenantContext, permission: string): string {
    if (ctx.membershipType !== 'portal' || ctx.contactId === null || scopeFor(ctx, permission) !== 'linked') {
      throw Problems.forbidden('These views are for landlord portal accounts. Staff use the landlord preview on the contact.');
    }
    return ctx.contactId;
  }

  private linkedSections(ctx: TenantContext): Sections {
    const linked = (key: keyof typeof LINKED_PERMISSIONS) => scopeFor(ctx, LINKED_PERMISSIONS[key]) === 'linked';
    return { offers: linked('offers'), deals: linked('deals'), viewings: linked('viewings') };
  }
}
