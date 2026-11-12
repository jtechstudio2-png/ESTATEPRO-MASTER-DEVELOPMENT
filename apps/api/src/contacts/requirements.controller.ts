import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Scope, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import {
  CreateRequirementBody,
  ExcludeListingBody,
  FINANCING_STATUSES,
  REQUIREMENT_STATUSES,
  REQUIREMENT_TYPES,
  RequirementDto,
  RequirementExclusionDto,
  RequirementMatchesDto,
  RequirementPageDto,
  UpdateRequirementBody,
} from './requirements.dto.js';
import { type RequirementSortField, RequirementsService } from './requirements.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLACE_NAME = /^[\p{L}\p{M}\p{N} .'’()&/-]{1,120}$/u;

const REQUIREMENT_SORT = {
  allowed: { updatedAt: 'timestamp', createdAt: 'timestamp' },
  default: { field: 'updatedAt', direction: 'desc' },
} as const satisfies SortSpec<RequirementSortField>;

const REQUIREMENT_FILTERS: FilterSpec = {
  requirementType: { type: 'enum', values: REQUIREMENT_TYPES, multi: true },
  status: { type: 'enum', values: REQUIREMENT_STATUSES, multi: true },
  currencyCode: { type: 'code', pattern: /^[A-Z]{3}$/, multi: true },
  financingStatus: { type: 'enum', values: FINANCING_STATUSES, multi: true },
  contactId: { type: 'uuid', multi: true },
  budget: { type: 'range', pattern: /^\d{1,15}(\.\d{1,4})?$/ },
  moveBy: { type: 'range', pattern: DATE },
  locality: { type: 'code', pattern: PLACE_NAME, multi: true },
};

/** Requirements register: the Buyers and Tenants views by what people want (wireframe B-1). */
@ApiTags('Contacts: requirements')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/requirements')
export class RequirementsRegisterController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly requirements: RequirementsService,
  ) {}

  @Get()
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Requirements of contacts you can see (active by default), with match counts' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['updatedAt', '-updatedAt', 'createdAt', '-createdAt'] })
  @ApiQuery({ name: 'filter[requirementType]', required: false, description: 'buy, rent' })
  @ApiQuery({ name: 'filter[status]', required: false, description: `Default active. ${REQUIREMENT_STATUSES.join(', ')}` })
  @ApiQuery({ name: 'filter[currencyCode]', required: false })
  @ApiQuery({ name: 'filter[financingStatus]', required: false })
  @ApiQuery({ name: 'filter[contactId]', required: false })
  @ApiQuery({ name: 'filter[budget][gte]', required: false, description: 'Budget overlaps this range' })
  @ApiQuery({ name: 'filter[budget][lte]', required: false })
  @ApiQuery({ name: 'filter[moveBy][gte]', required: false })
  @ApiQuery({ name: 'filter[moveBy][lte]', required: false })
  @ApiQuery({ name: 'filter[locality]', required: false, description: 'Requirements naming one of these areas' })
  @ApiOkResponse({ type: RequirementPageDto })
  async register(@Tenant() ctx: TenantContext, @Scope() scope: PermissionScope, @Query() query: ListQueryInput): Promise<RequirementPageDto> {
    const parsed = parseListQuery<RequirementSortField>(query, REQUIREMENT_SORT, REQUIREMENT_FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.requirements.register(tx, ctx, scope, parsed));
  }
}

/** One contact's requirements, their matches and "not suitable" listings (wireframe B-2). */
@ApiTags('Contacts: requirements')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/contacts/:contactId/requirements')
export class ContactRequirementsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly requirements: RequirementsService,
  ) {}

  @Get()
  @RequirePermission('contact.view')
  @ApiOkResponse({ type: [RequirementDto] })
  async list(@Tenant() ctx: TenantContext, @Param('contactId', UUID_PARAM) contactId: string): Promise<RequirementDto[]> {
    return this.tenantDb.run(ctx, (tx) => this.requirements.listForContact(tx, ctx, contactId));
  }

  @Post()
  @RequirePermission('contact.update')
  @ApiOperation({ summary: 'Record what a buyer or tenant is looking for' })
  @ApiCreatedResponse({ type: RequirementDto })
  async create(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Body() body: CreateRequirementBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RequirementDto> {
    const requirement = await this.tenantDb.run(ctx, (tx) => this.requirements.create(tx, ctx, contactId, body));
    res.location(`/api/v1/contacts/${contactId}/requirements/${requirement.id}`);
    setVersionEtag(res, requirement.version);
    return requirement;
  }

  @Get(':requirementId')
  @RequirePermission('contact.view')
  @ApiOkResponse({ type: RequirementDto })
  async get(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('requirementId', UUID_PARAM) requirementId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RequirementDto> {
    const requirement = await this.tenantDb.run(ctx, (tx) => this.requirements.get(tx, ctx, contactId, requirementId));
    setVersionEtag(res, requirement.version);
    return requirement;
  }

  @Patch(':requirementId')
  @RequirePermission('contact.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: RequirementDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('requirementId', UUID_PARAM) requirementId: string,
    @Body() body: UpdateRequirementBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RequirementDto> {
    const version = requireIfMatch(ifMatch);
    const requirement = await this.tenantDb.run(ctx, (tx) => this.requirements.update(tx, ctx, contactId, requirementId, version, body));
    setVersionEtag(res, requirement.version);
    return requirement;
  }

  @Get(':requirementId/matches')
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Published listings matching the requirement, best first (decision D4); needs listing.view' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
  @ApiOkResponse({ type: RequirementMatchesDto })
  async matches(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('requirementId', UUID_PARAM) requirementId: string,
    @Query('limit') limitParam: string | undefined,
  ): Promise<RequirementMatchesDto> {
    const limit = limitParam === undefined ? 20 : /^\d{1,3}$/.test(limitParam) ? Number(limitParam) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw Problems.validation([{ field: 'limit', code: 'range', message: 'Use a whole number from 1 to 100.' }]);
    }
    return this.tenantDb.run(ctx, (tx) => this.requirements.matches(tx, ctx, contactId, requirementId, limit));
  }

  @Get(':requirementId/exclusions')
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Listings marked not suitable for this requirement' })
  @ApiOkResponse({ type: [RequirementExclusionDto] })
  async exclusions(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('requirementId', UUID_PARAM) requirementId: string,
  ): Promise<RequirementExclusionDto[]> {
    return this.tenantDb.run(ctx, (tx) => this.requirements.exclusions(tx, ctx, contactId, requirementId));
  }

  @Post(':requirementId/exclusions')
  @RequirePermission('contact.update')
  @ApiOperation({ summary: 'Mark a listing not suitable, with a reason; it stops appearing as a match' })
  @ApiCreatedResponse({ type: [RequirementExclusionDto] })
  async exclude(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('requirementId', UUID_PARAM) requirementId: string,
    @Body() body: ExcludeListingBody,
  ): Promise<RequirementExclusionDto[]> {
    return this.tenantDb.run(ctx, (tx) => this.requirements.exclude(tx, ctx, contactId, requirementId, body));
  }

  @Delete(':requirementId/exclusions/:listingId')
  @HttpCode(200)
  @RequirePermission('contact.update')
  @ApiOperation({ summary: 'Let a listing marked not suitable appear as a match again' })
  @ApiOkResponse({ type: [RequirementExclusionDto] })
  async restore(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('requirementId', UUID_PARAM) requirementId: string,
    @Param('listingId', UUID_PARAM) listingId: string,
  ): Promise<RequirementExclusionDto[]> {
    return this.tenantDb.run(ctx, (tx) => this.requirements.restoreListing(tx, ctx, contactId, requirementId, listingId));
  }
}
