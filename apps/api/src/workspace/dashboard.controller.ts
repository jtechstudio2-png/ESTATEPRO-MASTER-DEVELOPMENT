import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { ATTENTION_KINDS, ListingsService } from '../listings/listings.service.js';
import { propertyScopeSql } from '../properties/property-access.js';

class ListingAttentionDto {
  @ApiProperty({ description: 'Drafts failing a media, mandate or unit check of publishing' }) notReady!: number;
  @ApiProperty() photos!: number;
  @ApiProperty() floorPlan!: number;
  @ApiProperty() mandateExpiring!: number;
  @ApiProperty() coverAlt!: number;
  @ApiProperty() priceStale!: number;
}

class MaintenanceUnitDto {
  @ApiProperty({ format: 'uuid' }) unitId!: string;
  @ApiProperty() unitLabel!: string;
  @ApiProperty({ format: 'uuid' }) propertyId!: string;
  @ApiProperty() propertyName!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) until!: string | null;
}

class MaintenancePanelDto {
  @ApiProperty() count!: number;
  @ApiProperty({ type: [MaintenanceUnitDto], description: 'Up to 10, most recently changed first' }) units!: MaintenanceUnitDto[];
}

class KeysPanelDto {
  @ApiProperty() overdue!: number;
  @ApiProperty() out!: number;
  @ApiProperty() lost!: number;
}

class LocationsPanelDto {
  @ApiProperty({ description: 'Properties without a location' }) missing!: number;
  @ApiProperty({ description: 'Properties whose address changed after the pin was confirmed' }) stale!: number;
}

class RejectedMediaDto {
  @ApiProperty({ format: 'uuid' }) mediaId!: string;
  @ApiProperty({ format: 'uuid' }) propertyId!: string;
  @ApiProperty() propertyName!: string;
  @ApiProperty({ type: String, nullable: true }) fileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ format: 'date-time' }) at!: string;
}

class MediaPanelDto {
  @ApiProperty({ description: 'Rejected or failed uploads in the last 7 days' }) rejected!: number;
  @ApiProperty({ type: [RejectedMediaDto], description: 'Up to 10, newest first' }) recent!: RejectedMediaDto[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANEL_ROWS = 10;

function officeFilter(filter: Record<string, unknown> | undefined): string[] | null {
  const value = filter?.['officeId'];
  if (value === undefined) return null;
  const ids = typeof value === 'string' ? value.split(',').map((id) => id.trim().toLowerCase()) : [];
  if (ids.length === 0 || ids.length > 50 || !ids.every((id) => UUID.test(id))) {
    throw Problems.validation([{ field: 'filter[officeId]', code: 'invalid', message: 'Use comma-separated office ids.' }]);
  }
  return ids;
}

/**
 * Property dashboard panels (Phase 3 06 §3, limited to Phase 4 data; M6 API
 * gap A-5). One endpoint per panel so panels load and fail independently.
 * Every count uses the caller's scope and has a list filter that returns the
 * same records.
 */
@ApiTags('Dashboards')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/dashboards/property')
export class PropertyDashboardController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly listings: ListingsService,
  ) {}

  @Get('listings')
  @RequirePermission('listing.view')
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiOkResponse({ type: ListingAttentionDto, description: `Counts match GET /listings?filter[attention]=${ATTENTION_KINDS.join('|')}` })
  async listingAttention(@Tenant() ctx: TenantContext, @Query('filter') filter: Record<string, unknown> | undefined): Promise<ListingAttentionDto> {
    const offices = officeFilter(filter);
    const counts = await this.tenantDb.run(ctx, (tx) => this.listings.attentionCounts(tx, ctx, ctx.permissions.get('listing.view')!.scope, offices));
    return {
      notReady: counts['not-ready'],
      photos: counts['photos'],
      floorPlan: counts['floor-plan'],
      mandateExpiring: counts['mandate-expiring'],
      coverAlt: counts['cover-alt'],
      priceStale: counts['price-stale'],
    };
  }

  @Get('maintenance')
  @RequirePermission('property.view')
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiOkResponse({ type: MaintenancePanelDto })
  async maintenance(@Tenant() ctx: TenantContext, @Query('filter') filter: Record<string, unknown> | undefined): Promise<MaintenancePanelDto> {
    const offices = officeFilter(filter);
    return this.tenantDb.run(ctx, async (tx) => {
      let qb = tx
        .selectFrom('units as u')
        .innerJoin('properties as p', 'p.id', 'u.propertyId')
        .where(propertyScopeSql(ctx.permissions.get('property.view')!.scope, ctx, 'p'))
        .where('u.availability', '=', 'under_maintenance')
        .where('u.archivedAt', 'is', null)
        .where('p.archivedAt', 'is', null);
      if (offices !== null) qb = qb.where('p.officeId', 'in', offices);
      const count = await qb.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
      const units = await qb
        .select(['u.id as unitId', 'u.unitLabel', 'p.id as propertyId', 'p.name', 'p.reference', 'u.availabilityNote', 'u.availabilityUntil'])
        .orderBy('u.updatedAt', 'desc')
        .limit(PANEL_ROWS)
        .execute();
      return {
        count: count.n,
        units: units.map((row) => ({
          unitId: row.unitId,
          unitLabel: row.unitLabel,
          propertyId: row.propertyId,
          propertyName: row.name ?? row.reference,
          note: row.availabilityNote,
          until: row.availabilityUntil,
        })),
      };
    });
  }

  @Get('keys')
  @RequirePermission('key.view')
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiOkResponse({ type: KeysPanelDto, description: 'Counts match GET /key-sets?filter[overdue]=true, filter[status]=checked_out and filter[status]=lost' })
  async keys(@Tenant() ctx: TenantContext, @Query('filter') filter: Record<string, unknown> | undefined): Promise<KeysPanelDto> {
    const offices = officeFilter(filter);
    return this.tenantDb.run(ctx, async (tx) => {
      let qb = tx
        .selectFrom('keySets as k')
        .innerJoin('properties as p', 'p.id', 'k.propertyId')
        .where(propertyScopeSql(ctx.permissions.get('key.view')!.scope, ctx, 'p'));
      if (offices !== null) qb = qb.where('p.officeId', 'in', offices);
      return qb
        .select([
          sql<number>`count(*) filter (where k.status = 'checked_out' and k.due_back_at < now())::int`.as('overdue'),
          sql<number>`count(*) filter (where k.status = 'checked_out')::int`.as('out'),
          sql<number>`count(*) filter (where k.status = 'lost')::int`.as('lost'),
        ])
        .executeTakeFirstOrThrow();
    });
  }

  @Get('locations')
  @RequirePermission('property.view')
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiOkResponse({ type: LocationsPanelDto, description: 'Counts match GET /properties?filter[hasLocation]=false and filter[locationStale]=true' })
  async locations(@Tenant() ctx: TenantContext, @Query('filter') filter: Record<string, unknown> | undefined): Promise<LocationsPanelDto> {
    const offices = officeFilter(filter);
    return this.tenantDb.run(ctx, async (tx) => {
      let qb = tx
        .selectFrom('properties as p')
        .innerJoin('addresses as a', 'a.id', 'p.addressId')
        .where(propertyScopeSql(ctx.permissions.get('property.view')!.scope, ctx, 'p'))
        .where('p.archivedAt', 'is', null);
      if (offices !== null) qb = qb.where('p.officeId', 'in', offices);
      return qb
        .select([
          sql<number>`count(*) filter (where a.location is null)::int`.as('missing'),
          sql<number>`count(*) filter (where a.location_stale)::int`.as('stale'),
        ])
        .executeTakeFirstOrThrow();
    });
  }

  @Get('media')
  @RequirePermission('property.view')
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiOkResponse({ type: MediaPanelDto })
  async media(@Tenant() ctx: TenantContext, @Query('filter') filter: Record<string, unknown> | undefined): Promise<MediaPanelDto> {
    const offices = officeFilter(filter);
    return this.tenantDb.run(ctx, async (tx) => {
      let qb = tx
        .selectFrom('propertyMedia as m')
        .innerJoin('properties as p', 'p.id', 'm.propertyId')
        .where(propertyScopeSql(ctx.permissions.get('property.view')!.scope, ctx, 'p'))
        .where('m.processingStatus', 'in', ['rejected', 'failed'])
        .where('m.updatedAt', '>=', sql<Date>`now() - interval '7 days'`);
      if (offices !== null) qb = qb.where('p.officeId', 'in', offices);
      const count = await qb.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
      const rows = await qb
        .select(['m.id', 'p.id as propertyId', 'p.name', 'p.reference', 'm.originalFilename', 'm.rejectionReason', 'm.updatedAt'])
        .orderBy('m.updatedAt', 'desc')
        .limit(PANEL_ROWS)
        .execute();
      return {
        rejected: count.n,
        recent: rows.map((row) => ({
          mediaId: row.id,
          propertyId: row.propertyId,
          propertyName: row.name ?? row.reference,
          fileName: row.originalFilename,
          reason: row.rejectionReason,
          at: row.updatedAt.toISOString(),
        })),
      };
    });
  }
}
