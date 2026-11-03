import { type RawBuilder, sql } from 'kysely';

import type { PermissionScope, TenantContext } from '../common/request-context.js';
import { listingScopeSql } from '../listings/listing-access.js';

/**
 * Requirement matching (CRM-03, wireframe B-2), as approved in decision D4.
 *
 * A published listing matches a requirement when all of these hold:
 *   type       buy → sale listing, rent → rent listing
 *   currency   same currency (amounts are never converted between currencies)
 *   price      within the budget; rents are compared per the budget's period
 *   bedrooms   at least the minimum
 *   area       inside one of the requirement's areas (no areas: anywhere)
 * and nobody marked it "not suitable" for this requirement (gap G2).
 *
 * Matches are then ranked: one point per wanted feature the unit has, one for
 * a wanted property type, one for bedrooms within the maximum. Only listings
 * the member may view are considered, and only the company's own listings
 * (row-level security).
 *
 * The SQL refers to a requirement alias `r`, so the same rules serve one
 * requirement's matches and the match counts of a whole register page.
 */
export const MATCH_RULES = [
  'Published listings only',
  'Buy matches sale listings; rent matches rent listings',
  'Same currency as the requirement',
  'Price within the budget (rent compared per the budget period)',
  'Bedrooms at least the minimum',
  'Inside one of the requirement areas (no areas: anywhere)',
  'Listings marked not suitable are left out',
  'Ranked by wanted features, wanted property type and bedrooms within the maximum',
] as const;

/** Joins needed by the conditions: listings l, units u, properties p, addresses a. */
export const LISTING_JOINS = sql`
  join units u on u.company_id = l.company_id and u.id = l.unit_id
  join properties p on p.company_id = l.company_id and p.id = u.property_id
  left join addresses a on a.company_id = p.company_id and a.id = p.address_id`;

export function matchConditions(ctx: TenantContext, listingScope: PermissionScope): RawBuilder<boolean> {
  return sql<boolean>`l.company_id = r.company_id
    and l.is_published and l.archived_at is null
    and l.listing_type = case r.requirement_type when 'buy' then 'sale' else 'rent' end
    and l.currency_code = r.currency_code
    and l.comparable_price_floor between r.comparable_min_floor and r.comparable_max_floor
    and (r.comparable_min_price is null or l.comparable_price >= r.comparable_min_price)
    and (r.comparable_max_price is null or l.comparable_price <= r.comparable_max_price)
    and (r.min_bedrooms is null or u.bedrooms >= r.min_bedrooms)
    and app.requirement_area_covers(r.locations, a.locality, a.admin_area_1, a.location)
    and not exists (select 1 from requirement_exclusions x
                     where x.company_id = r.company_id and x.requirement_id = r.id and x.listing_id = l.id)
    and ${listingScopeSql(listingScope, ctx, 'l')}`;
}

/** Wanted features the unit has. */
export const featuresMatchedSql = sql<string[]>`coalesce((select array_agg(f.feature_code order by f.feature_code) from unit_features f
  where f.company_id = l.company_id and f.unit_id = l.unit_id and f.feature_code = any(r.must_have_features)), '{}')`;

export const propertyTypeMatchedSql = sql<boolean | null>`case when cardinality(r.property_type_ids) = 0 then null
  else (p.property_type_id = any(r.property_type_ids) or coalesce(u.unit_type_id = any(r.property_type_ids), false)) end`;

export const withinMaxBedroomsSql = sql<boolean | null>`case when r.max_bedrooms is null then null
  else coalesce(u.bedrooms <= r.max_bedrooms, false) end`;
