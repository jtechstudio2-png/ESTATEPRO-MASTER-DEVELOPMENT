import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { type AgreementSortField, AgreementsService } from './agreements.service.js';
import { ActivateAgreementBody, AGREEMENT_STATUSES, AgreementDto, AgreementPageDto, CreateAgreementBody, EndAgreementBody, SERVICE_LEVELS, UpdateAgreementBody } from './lettings.dto.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const SORT = {
  allowed: { createdAt: 'timestamp', startDate: 'text' },
  default: { field: 'createdAt', direction: 'desc' },
} as const satisfies SortSpec<AgreementSortField>;
const FILTERS: FilterSpec = {
  status: { type: 'enum', values: AGREEMENT_STATUSES, multi: true },
  serviceLevel: { type: 'enum', values: SERVICE_LEVELS, multi: true },
  propertyId: { type: 'uuid', multi: true },
  landlordContactId: { type: 'uuid', multi: true },
};

/** Management agreements (Phase 7 L1; LET-02; wireframes MA-1, MA-2). */
@ApiTags('Management agreements')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/management-agreements')
export class AgreementsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly agreements: AgreementsService,
  ) {}

  @Get()
  @RequirePermission('management_agreement.view')
  @ApiOperation({ summary: 'Agreements in your scope, newest first' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['createdAt', '-createdAt', 'startDate', '-startDate'] })
  @ApiQuery({ name: 'q', required: false, description: 'Reference prefix, landlord or property name' })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[serviceLevel]', required: false })
  @ApiQuery({ name: 'filter[propertyId]', required: false })
  @ApiQuery({ name: 'filter[landlordContactId]', required: false })
  @ApiOkResponse({ type: AgreementPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<AgreementPageDto> {
    const parsed = parseListQuery<AgreementSortField>(query, SORT, FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.agreements.list(tx, ctx, parsed));
  }

  @Post()
  @RequirePermission('management_agreement.manage')
  @ApiOperation({ summary: 'Record a landlord\'s instruction as a draft agreement' })
  @ApiCreatedResponse({ type: AgreementDto })
  async create(@Tenant() ctx: TenantContext, @Body() body: CreateAgreementBody, @Res({ passthrough: true }) res: Response): Promise<AgreementDto> {
    const agreement = await this.tenantDb.run(ctx, (tx) => this.agreements.create(tx, ctx, body));
    res.location(`/api/v1/management-agreements/${agreement.id}`);
    return withEtag(res, agreement);
  }

  @Get(':agreementId')
  @RequirePermission('management_agreement.view')
  @ApiOkResponse({ type: AgreementDto })
  async get(@Tenant() ctx: TenantContext, @Param('agreementId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<AgreementDto> {
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.agreements.get(tx, ctx, id)));
  }

  @Patch(':agreementId')
  @RequirePermission('management_agreement.manage')
  @ApiOperation({ summary: 'Edit a draft; once active only the approval limit, float, payouts, end date and notice change' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: AgreementDto })
  async update(@Tenant() ctx: TenantContext, @Param('agreementId', UUID_PARAM) id: string, @Body() body: UpdateAgreementBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<AgreementDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.agreements.update(tx, ctx, id, version, body)));
  }

  @Post(':agreementId/activate')
  @HttpCode(200)
  @RequirePermission('management_agreement.approve')
  @ApiOperation({ summary: 'Activate (or reactivate) with the signed agreement scanned clean; one live agreement per unit' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: AgreementDto })
  async activate(@Tenant() ctx: TenantContext, @Param('agreementId', UUID_PARAM) id: string, @Body() body: ActivateAgreementBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<AgreementDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.agreements.activate(tx, ctx, id, version, body.documentId)));
  }

  @Post(':agreementId/suspend')
  @HttpCode(200)
  @RequirePermission('management_agreement.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: AgreementDto })
  async suspend(@Tenant() ctx: TenantContext, @Param('agreementId', UUID_PARAM) id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<AgreementDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.agreements.suspend(tx, ctx, id, version)));
  }

  @Post(':agreementId/end')
  @HttpCode(200)
  @RequirePermission('management_agreement.manage')
  @ApiOperation({ summary: 'End the agreement (refused while leases under it are live)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: AgreementDto })
  async end(@Tenant() ctx: TenantContext, @Param('agreementId', UUID_PARAM) id: string, @Body() body: EndAgreementBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<AgreementDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.agreements.end(tx, ctx, id, version, body.endDate)));
  }
}

function withEtag<T extends { version: number }>(res: Response, body: T): T {
  setVersionEtag(res, body.version);
  return body;
}
