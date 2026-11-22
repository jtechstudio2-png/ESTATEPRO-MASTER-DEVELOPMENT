import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { type LeaseSortField, LeasesService } from './leases.service.js';
import {
  ActivateLeaseBody,
  CancelLeaseBody,
  CreateLeaseBody,
  LEASE_PARTY_ROLES,
  LEASE_STATUSES,
  LEASE_TYPES,
  LeaseDto,
  LeaseFromDealBody,
  LeasePageDto,
  LeasePartyInput,
  UpdateLeaseBody,
  UpdateLeasePartyBody,
} from './lettings.dto.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const SORT = {
  allowed: { updatedAt: 'timestamp', startDate: 'text', endDate: 'text' },
  default: { field: 'updatedAt', direction: 'desc' },
} as const satisfies SortSpec<LeaseSortField>;
const FILTERS: FilterSpec = {
  status: { type: 'enum', values: LEASE_STATUSES, multi: true },
  leaseType: { type: 'enum', values: LEASE_TYPES, multi: true },
  unitId: { type: 'uuid', multi: true },
  propertyId: { type: 'uuid', multi: true },
  officeId: { type: 'uuid', multi: true },
  managementAgreementId: { type: 'uuid', multi: true },
  contactId: { type: 'uuid', multi: true },
  endDate: { type: 'range', pattern: /^\d{4}-\d{2}-\d{2}$/ },
};

/** Leases (Phase 7 L1; LET-01; wireframes LS-1 to LS-5; P7-D4, P7-D5). */
@ApiTags('Leases')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class LeasesController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly leases: LeasesService,
  ) {}

  @Get('leases')
  @RequirePermission('lease.view')
  @ApiOperation({ summary: 'Leases in your scope; open ones (not closed or cancelled) by default' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['updatedAt', '-updatedAt', 'startDate', '-startDate', 'endDate', '-endDate'] })
  @ApiQuery({ name: 'q', required: false, description: 'Reference prefix, unit, property or tenant name' })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[leaseType]', required: false })
  @ApiQuery({ name: 'filter[unitId]', required: false })
  @ApiQuery({ name: 'filter[propertyId]', required: false })
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiQuery({ name: 'filter[managementAgreementId]', required: false })
  @ApiQuery({ name: 'filter[contactId]', required: false, description: 'Any party' })
  @ApiQuery({ name: 'filter[endDate][gte]', required: false })
  @ApiQuery({ name: 'filter[endDate][lte]', required: false, description: 'Leases ending by this day' })
  @ApiOkResponse({ type: LeasePageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<LeasePageDto> {
    const parsed = parseListQuery<LeaseSortField>(query, SORT, FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.leases.list(tx, ctx, parsed));
  }

  @Post('leases')
  @RequirePermission('lease.create')
  @ApiOperation({ summary: 'Draw up a draft lease for a unit' })
  @ApiCreatedResponse({ type: LeaseDto })
  async create(@Tenant() ctx: TenantContext, @Body() body: CreateLeaseBody, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const lease = await this.tenantDb.run(ctx, (tx) => this.leases.create(tx, ctx, body));
    res.location(`/api/v1/leases/${lease.id}`);
    return withEtag(res, lease);
  }

  @Post('deals/:dealId/lease')
  @HttpCode(201)
  @RequirePermission('deal.update')
  @ApiTags('Deals')
  @ApiOperation({ summary: 'Draw up the draft lease of a letting deal at "terms agreed" (needs lease.create too); the deal moves to lease signing (P7-D4)' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the deal' })
  @ApiCreatedResponse({ type: LeaseDto })
  async fromDeal(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) dealId: string, @Body() body: LeaseFromDealBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    const lease = await this.tenantDb.run(ctx, (tx) => this.leases.fromDeal(tx, ctx, dealId, version, body));
    res.location(`/api/v1/leases/${lease.id}`);
    return withEtag(res, lease);
  }

  @Get('leases/:leaseId')
  @RequirePermission('lease.view')
  @ApiOkResponse({ type: LeaseDto })
  async get(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leases.get(tx, ctx, id)));
  }

  @Patch('leases/:leaseId')
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Edit the terms of a draft or a lease awaiting signature' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async update(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Body() body: UpdateLeaseBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leases.update(tx, ctx, id, version, body)));
  }

  @Post('leases/:leaseId/parties')
  @HttpCode(200)
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Add a party (before activation)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async addParty(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Body() body: LeasePartyInput, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leases.addParty(tx, ctx, id, version, body)));
  }

  @Patch('leases/:leaseId/parties/:contactId/:partyRole')
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Change a party\'s share or primary flag (before activation) or portal access (any time)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async updateParty(
    @Tenant() ctx: TenantContext,
    @Param('leaseId', UUID_PARAM) id: string,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('partyRole') role: string,
    @Body() body: UpdateLeasePartyBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeaseDto> {
    if (!(LEASE_PARTY_ROLES as readonly string[]).includes(role)) throw Problems.notFound();
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leases.updateParty(tx, ctx, id, version, contactId, role, body)));
  }

  @Delete('leases/:leaseId/parties/:contactId/:partyRole')
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Remove a party (before activation; not the primary tenant)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async removeParty(
    @Tenant() ctx: TenantContext,
    @Param('leaseId', UUID_PARAM) id: string,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('partyRole') role: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeaseDto> {
    if (!(LEASE_PARTY_ROLES as readonly string[]).includes(role)) throw Problems.notFound();
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leases.removeParty(tx, ctx, id, version, contactId, role)));
  }

  @Post('leases/:leaseId/send-for-signature')
  @HttpCode(200)
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Draft → pending signature (needs a primary tenant and a landlord; holds the unit for the dates)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async sendForSignature(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leases.sendForSignature(tx, ctx, id, version)));
  }

  @Post('leases/:leaseId/return-to-draft')
  @HttpCode(200)
  @RequirePermission('lease.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async returnToDraft(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leases.returnToDraft(tx, ctx, id, version)));
  }

  @Post('leases/:leaseId/activate')
  @HttpCode(200)
  @RequirePermission('lease.activate')
  @ApiOperation({ summary: 'Activate with the signed lease (P7-D5); the rent listing becomes rented (P7-D4)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async activate(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Body() body: ActivateLeaseBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leases.activate(tx, ctx, id, version, body)));
  }

  @Post('leases/:leaseId/cancel')
  @HttpCode(200)
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Cancel a lease that is not yet active, with the reason' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async cancel(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Body() body: CancelLeaseBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leases.cancel(tx, ctx, id, version, body.reason)));
  }
}

function withEtag<T extends { version: number }>(res: Response, body: T): T {
  setVersionEtag(res, body.version);
  return body;
}
