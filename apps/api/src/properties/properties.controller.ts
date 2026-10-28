import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Scope, Tenant } from '../auth/decorators.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { EstateProRequest, PermissionScope, TenantContext } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { TenantDb } from '../database/database.module.js';
import { LocationQueryDocs } from '../location/location-docs.js';
import { LOCATION_FILTERS, parseLocationFilter } from '../location/location-filter.js';
import { RateLimiter } from '../location/rate-limiter.js';
import {
  ArchiveBody,
  CreatePropertyBody,
  CreateUnitBody,
  PropertyDto,
  PropertyMapDto,
  PropertyPageDto,
  UnitAvailabilityBody,
  UnitDto,
  UnitPageDto,
  UpdatePropertyBody,
  UpdateUnitBody,
} from './dto.js';
import { PropertiesService, type PropertySortField } from './properties.service.js';
import { type UnitSortField, UnitsService } from './units.service.js';

const PROPERTY_SORT = {
  allowed: { reference: 'text', createdAt: 'timestamp', updatedAt: 'timestamp', distance: 'numeric' },
  default: { field: 'updatedAt', direction: 'desc' },
} as const satisfies SortSpec<PropertySortField>;

const PROPERTY_FILTERS: FilterSpec = {
  officeId: { type: 'uuid', multi: true },
  propertyTypeId: { type: 'uuid', multi: true },
  countryCode: { type: 'code', pattern: /^[A-Z]{2}$/, multi: true },
  isManaged: { type: 'boolean' },
  archived: { type: 'archived' },
  ...LOCATION_FILTERS,
};

/** Malformed ids are answered like unknown ids (404), never as validation errors. */
const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

@ApiTags('Properties')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class PropertiesController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly properties: PropertiesService,
    private readonly units: UnitsService,
    private readonly idempotency: IdempotencyService,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('properties')
  @RequirePermission('property.view')
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['reference', '-reference', 'createdAt', '-createdAt', 'updatedAt', '-updatedAt', 'distance', '-distance'] })
  @ApiQuery({ name: 'q', required: false, description: 'Reference, name or address contains' })
  @ApiQuery({ name: 'filter[officeId]', required: false, description: 'Comma-separated office ids' })
  @ApiQuery({ name: 'filter[propertyTypeId]', required: false, description: 'Comma-separated type ids' })
  @ApiQuery({ name: 'filter[countryCode]', required: false, description: 'Comma-separated ISO country codes' })
  @ApiQuery({ name: 'filter[isManaged]', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'true', 'all'] })
  @LocationQueryDocs()
  @ApiOkResponse({ type: PropertyPageDto })
  async list(@Tenant() ctx: TenantContext, @Scope() scope: PermissionScope, @Query() query: ListQueryInput): Promise<PropertyPageDto> {
    const parsed = parseListQuery<PropertySortField>(query, PROPERTY_SORT, PROPERTY_FILTERS);
    const location = parseLocationFilter(parsed.filters);
    return this.tenantDb.run(ctx, (tx) => this.properties.list(tx, ctx, scope, parsed, location));
  }

  @Get('properties/map')
  @RequirePermission('property.view')
  @ApiQuery({ name: 'filter[bbox]', required: true, description: 'Map viewport: west,south,east,north' })
  @ApiQuery({ name: 'q', required: false })
  @LocationQueryDocs()
  @ApiOkResponse({ type: PropertyMapDto })
  async map(@Tenant() ctx: TenantContext, @Scope() scope: PermissionScope, @Query() query: ListQueryInput): Promise<PropertyMapDto> {
    this.limiter.take(`map:${ctx.membershipId}`, this.config.MAP_RATE_LIMIT_PER_MINUTE);
    const parsed = parseListQuery<PropertySortField>(query, PROPERTY_SORT, PROPERTY_FILTERS);
    const location = parseLocationFilter(parsed.filters);
    return this.tenantDb.run(ctx, (tx) => this.properties.map(tx, ctx, scope, parsed.filters, parsed.q, location));
  }

  @Post('properties')
  @RequirePermission('property.create')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: PropertyDto })
  async create(
    @Tenant() ctx: TenantContext,
    @Scope() scope: PermissionScope,
    @Body() body: CreatePropertyBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PropertyDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.properties.create(tx, ctx, scope, body),
      })),
    );
    res.status(result.status).location(`/api/v1/properties/${result.body.id}`);
    setVersionEtag(res, result.body.version);
    return result.body;
  }

  @Get('properties/:propertyId')
  @RequirePermission('property.view')
  @ApiOkResponse({ type: PropertyDto })
  async get(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PropertyDto> {
    const property = await this.tenantDb.run(ctx, (tx) => this.properties.get(tx, ctx, id));
    setVersionEtag(res, property.version);
    return property;
  }

  @Patch('properties/:propertyId')
  @RequirePermission('property.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PropertyDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) id: string,
    @Body() body: UpdatePropertyBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PropertyDto> {
    const expected = requireIfMatch(ifMatch);
    const property = await this.tenantDb.run(ctx, (tx) => this.properties.update(tx, ctx, id, expected, body));
    setVersionEtag(res, property.version);
    return property;
  }

  @Post('properties/:propertyId/archive')
  @RequirePermission('property.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PropertyDto })
  async archive(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) id: string,
    @Body() body: ArchiveBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PropertyDto> {
    const expected = requireIfMatch(ifMatch);
    const property = await this.tenantDb.run(ctx, (tx) => this.properties.archive(tx, ctx, id, expected, body.reason));
    res.status(200);
    setVersionEtag(res, property.version);
    return property;
  }

  @Post('properties/:propertyId/restore')
  @RequirePermission('property.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PropertyDto })
  async restore(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PropertyDto> {
    const expected = requireIfMatch(ifMatch);
    const property = await this.tenantDb.run(ctx, (tx) => this.properties.restore(tx, ctx, id, expected));
    res.status(200);
    setVersionEtag(res, property.version);
    return property;
  }

  // --------------------------------------------------------------------------- units

  @Get('properties/:propertyId/units')
  @RequirePermission('property.view')
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['unitLabel', '-unitLabel', 'createdAt', '-createdAt', 'updatedAt', '-updatedAt'] })
  @ApiQuery({ name: 'filter[availability]', required: false, description: 'Comma-separated availability values' })
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'true', 'all'] })
  @ApiOkResponse({ type: UnitPageDto })
  async listUnits(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) propertyId: string,
    @Query() query: ListQueryInput,
  ): Promise<UnitPageDto> {
    const parsed = parseListQuery<UnitSortField>(
      query,
      { allowed: { unitLabel: 'text', createdAt: 'timestamp', updatedAt: 'timestamp' }, default: { field: 'unitLabel', direction: 'asc' } },
      {
        availability: { type: 'enum', values: ['available', 'under_maintenance', 'owner_occupied', 'unavailable'], multi: true },
        archived: { type: 'archived' },
      },
    );
    return this.tenantDb.run(ctx, (tx) => this.units.list(tx, ctx, propertyId, parsed));
  }

  @Post('properties/:propertyId/units')
  @RequirePermission('property.update')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: UnitDto })
  async createUnit(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) propertyId: string,
    @Body() body: CreateUnitBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.units.create(tx, ctx, propertyId, body),
      })),
    );
    res.status(result.status).location(`/api/v1/units/${result.body.id}`);
    setVersionEtag(res, result.body.version);
    return result.body;
  }

  @Get('units/:unitId')
  @RequirePermission('property.view')
  @ApiOkResponse({ type: UnitDto })
  async getUnit(
    @Tenant() ctx: TenantContext,
    @Param('unitId', UUID_PARAM) unitId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const unit = await this.tenantDb.run(ctx, (tx) => this.units.get(tx, ctx, unitId));
    setVersionEtag(res, unit.version);
    return unit;
  }

  @Patch('units/:unitId')
  @RequirePermission('property.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: UnitDto })
  async updateUnit(
    @Tenant() ctx: TenantContext,
    @Param('unitId', UUID_PARAM) unitId: string,
    @Body() body: UpdateUnitBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const expected = requireIfMatch(ifMatch);
    const unit = await this.tenantDb.run(ctx, (tx) => this.units.update(tx, ctx, unitId, expected, body));
    setVersionEtag(res, unit.version);
    return unit;
  }

  @Post('units/:unitId/availability')
  @RequirePermission('property.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: UnitDto })
  async setUnitAvailability(
    @Tenant() ctx: TenantContext,
    @Param('unitId', UUID_PARAM) unitId: string,
    @Body() body: UnitAvailabilityBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const expected = requireIfMatch(ifMatch);
    const unit = await this.tenantDb.run(ctx, (tx) => this.units.setAvailability(tx, ctx, unitId, expected, body));
    res.status(200);
    setVersionEtag(res, unit.version);
    return unit;
  }

  @Post('units/:unitId/archive')
  @RequirePermission('property.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: UnitDto })
  async archiveUnit(
    @Tenant() ctx: TenantContext,
    @Param('unitId', UUID_PARAM) unitId: string,
    @Body() body: ArchiveBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const expected = requireIfMatch(ifMatch);
    const unit = await this.tenantDb.run(ctx, (tx) => this.units.archive(tx, ctx, unitId, expected, body.reason));
    res.status(200);
    setVersionEtag(res, unit.version);
    return unit;
  }

  @Post('units/:unitId/restore')
  @RequirePermission('property.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: UnitDto })
  async restoreUnit(
    @Tenant() ctx: TenantContext,
    @Param('unitId', UUID_PARAM) unitId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UnitDto> {
    const expected = requireIfMatch(ifMatch);
    const unit = await this.tenantDb.run(ctx, (tx) => this.units.restore(tx, ctx, unitId, expected));
    res.status(200);
    setVersionEtag(res, unit.version);
    return unit;
  }
}
