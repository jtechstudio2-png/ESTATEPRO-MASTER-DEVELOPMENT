import { type RawBuilder, sql } from 'kysely';

import type { PermissionScope, TenantContext } from '../../src/common/request-context.js';
import { listingScopeSql } from '../../src/listings/listing-access.js';

/**
 * The "has a match" test as it stood before #42 (C4 version of hasMatchSql),
 * kept only as the reference for the equivalence tests: the address-first
 * rewrite must give exactly the same answer for every requirement.
 */
export function legacyHasMatchSql(ctx: TenantContext, listingScope: PermissionScope): RawBuilder<boolean> {
  const listing = sql`l.company_id = r.company_id and l.is_published and l.archived_at is null
    and l.listing_type = case r.requirement_type when 'buy' then 'sale' else 'rent' end
    and l.currency_code = r.currency_code
    and l.comparable_price_floor between r.comparable_min_floor and r.comparable_max_floor
    and (r.comparable_min_price is null or l.comparable_price >= r.comparable_min_price)
    and (r.comparable_max_price is null or l.comparable_price <= r.comparable_max_price)
    and (r.min_bedrooms is null or u.bedrooms >= r.min_bedrooms)
    and not exists (select 1 from requirement_exclusions x
                     where x.company_id = r.company_id and x.requirement_id = r.id and x.listing_id = l.id)
    and ${listingScopeSql(listingScope, ctx, 'l')}`;
  const fromAddress = sql`join properties p on p.company_id = a.company_id and p.address_id = a.id
    join units u on u.company_id = p.company_id and u.property_id = p.id
    join listings l on l.company_id = u.company_id and l.unit_id = u.id`;
  const exact = sql`app.requirement_area_covers(r.locations, a.locality, a.admin_area_1, a.location)`;
  return sql<boolean>`(
    (r.area_anywhere and exists (select 1 from listings l join units u on u.company_id = l.company_id and u.id = l.unit_id where ${listing}))
    or (cardinality(r.area_localities) > 0 and exists (
          select 1 from (select * from addresses a0
                           where a0.company_id = r.company_id and a0.locality_key = any(r.area_localities) offset 0) a ${fromAddress}
           where ${listing} and ${exact}))
    or (r.area_west is not null and exists (
          select 1 from (select * from addresses a0
                           where a0.company_id = r.company_id and a0.latitude_f between r.area_south and r.area_north
                             and a0.longitude_f between r.area_west and r.area_east offset 0) a ${fromAddress}
           where ${listing} and ${exact})))`;
}
