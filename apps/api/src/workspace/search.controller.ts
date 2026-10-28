import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';

import { Tenant } from '../auth/decorators.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb, type Tx } from '../database/database.module.js';
import { listingScopeSql } from '../listings/listing-access.js';
import { propertyScopeSql } from '../properties/property-access.js';

class SearchHitDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ description: 'Main line (name, label or title)' }) title!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Context line (address, property, status)' }) context!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'For units: the property' }) propertyId!: string | null;
}

class SearchGroupDto {
  @ApiProperty({ type: [SearchHitDto] }) hits!: SearchHitDto[];
  @ApiProperty({ description: 'More matches exist than shown' }) hasMore!: boolean;
}

class SearchResultDto {
  @ApiProperty({ type: SearchGroupDto, nullable: true, description: 'null without property.view' }) properties!: SearchGroupDto | null;
  @ApiProperty({ type: SearchGroupDto, nullable: true }) units!: SearchGroupDto | null;
  @ApiProperty({ type: SearchGroupDto, nullable: true, description: 'null without listing.view' }) listings!: SearchGroupDto | null;
}

const PER_GROUP = 5;

/**
 * Global search over properties, units and listings (M6 API gap A-6). Each
 * group uses the caller's scope, so results and "more" flags never reveal
 * records they cannot open. Exact reference matches come first, then prefix
 * matches, then the most recently updated.
 */
@ApiTags('Session')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class SearchController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get('search')
  @ApiQuery({ name: 'q', required: true, description: 'Reference, name, address or title (2–100 characters)' })
  @ApiOkResponse({ type: SearchResultDto })
  async search(@Tenant() ctx: TenantContext, @Query('q') q: unknown): Promise<SearchResultDto> {
    const text = typeof q === 'string' ? q.trim() : '';
    if (text.length < 2 || text.length > 100) {
      throw Problems.validation([{ field: 'q', code: 'length', message: 'Search text must be 2 to 100 characters.' }]);
    }
    const contains = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const prefix = `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rank = (column: string) =>
      sql<number>`case when lower(${sql.ref(column)}) = lower(${text}) then 0 when ${sql.ref(column)} ilike ${prefix} then 1 else 2 end`;
    const property = ctx.permissions.get('property.view');
    const listing = ctx.permissions.get('listing.view');

    return this.tenantDb.run(ctx, async (tx: Tx) => {
      const properties = property
        ? await tx
            .selectFrom('properties as p')
            .innerJoin('addresses as a', 'a.id', 'p.addressId')
            .select(['p.id', 'p.reference', 'p.name', 'a.formatted'])
            .where(propertyScopeSql(property.scope, ctx, 'p'))
            .where('p.archivedAt', 'is', null)
            .where((eb) => eb.or([eb('p.reference', 'ilike', contains), eb('p.name', 'ilike', contains), eb('a.formatted', 'ilike', contains)]))
            .orderBy(rank('p.reference'))
            .orderBy('p.updatedAt', 'desc')
            .limit(PER_GROUP + 1)
            .execute()
        : null;
      const units = property
        ? await tx
            .selectFrom('units as u')
            .innerJoin('properties as p', 'p.id', 'u.propertyId')
            .select(['u.id', 'u.reference', 'u.unitLabel', 'u.availability', 'p.id as propertyId', 'p.name as propertyName', 'p.reference as propertyReference'])
            .where(propertyScopeSql(property.scope, ctx, 'p'))
            .where('u.archivedAt', 'is', null)
            .where((eb) => eb.or([eb('u.reference', 'ilike', contains), eb('u.unitLabel', 'ilike', contains)]))
            .orderBy(rank('u.reference'))
            .orderBy('u.updatedAt', 'desc')
            .limit(PER_GROUP + 1)
            .execute()
        : null;
      const listings = listing
        ? await tx
            .selectFrom('listings as l')
            .select(['l.id', 'l.reference', 'l.title', 'l.status', 'l.listingType'])
            .where(listingScopeSql(listing.scope, ctx, 'l'))
            .where('l.archivedAt', 'is', null)
            .where((eb) => eb.or([eb('l.reference', 'ilike', contains), eb('l.title', 'ilike', contains)]))
            .orderBy(rank('l.reference'))
            .orderBy('l.updatedAt', 'desc')
            .limit(PER_GROUP + 1)
            .execute()
        : null;
      const group = <R>(rows: R[] | null, map: (row: R) => SearchHitDto): SearchGroupDto | null =>
        rows === null ? null : { hits: rows.slice(0, PER_GROUP).map(map), hasMore: rows.length > PER_GROUP };
      return {
        properties: group(properties, (row) => ({ id: row.id, reference: row.reference, title: row.name ?? row.reference, context: row.formatted, propertyId: null })),
        units: group(units, (row) => ({
          id: row.id,
          reference: row.reference,
          title: row.unitLabel,
          context: `${row.propertyName ?? row.propertyReference} · ${row.availability}`,
          propertyId: row.propertyId,
        })),
        listings: group(listings, (row) => ({ id: row.id, reference: row.reference, title: row.title, context: `${row.listingType} · ${row.status}`, propertyId: null })),
      };
    });
  }
}
