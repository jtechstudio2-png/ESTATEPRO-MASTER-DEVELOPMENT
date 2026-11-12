import { Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { TokenVerifier } from '../auth/token-verifier.service.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { EstateProRequest, TenantContext } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { TenantDb } from '../database/database.module.js';
import {
  AddEvidenceBody,
  AssignableMemberDto,
  AssignPrivacyRequestBody,
  CarryOutErasureBody,
  ChangePrivacyRequestStatusBody,
  CreatePrivacyRequestBody,
  ExtendPrivacyRequestBody,
  PrivacyRequestDto,
  PrivacyRequestPageDto,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  VerifyIdentityBody,
} from './requests.dto.js';
import { PrivacyRequestsService, type RequestSortField } from './requests.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

const SORT = {
  allowed: { dueOn: 'text', createdAt: 'timestamp' },
  default: { field: 'dueOn', direction: 'asc' },
} as const satisfies SortSpec<RequestSortField>;

const FILTERS: FilterSpec = {
  view: { type: 'enum', values: ['open', 'overdue', 'closed', 'all'] },
  requestType: { type: 'enum', values: REQUEST_TYPES, multi: true },
  status: { type: 'enum', values: REQUEST_STATUSES, multi: true },
  contactId: { type: 'uuid' },
  assignedTo: { type: 'enum', values: ['me', 'none'] },
};

/**
 * Data-subject request register (gap G3): access and erasure requests, their
 * lifecycle, assignment, due dates, evidence and history. Fulfilment (erasure,
 * access report) needs privacy.fulfil and a second-factor sign-in within the
 * reveal window, because it removes or discloses protected data.
 */
@ApiTags('Privacy requests')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/privacy-requests')
export class PrivacyRequestsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly requests: PrivacyRequestsService,
    private readonly verifier: TokenVerifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @RequirePermission('privacy.view')
  @ApiOperation({ summary: 'Requests: open ones by default, soonest due first' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['dueOn', '-dueOn', 'createdAt', '-createdAt'] })
  @ApiQuery({ name: 'filter[view]', required: false, enum: ['open', 'overdue', 'closed', 'all'] })
  @ApiQuery({ name: 'filter[requestType]', required: false, description: REQUEST_TYPES.join(', ') })
  @ApiQuery({ name: 'filter[status]', required: false, description: REQUEST_STATUSES.join(', ') })
  @ApiQuery({ name: 'filter[contactId]', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'filter[assignedTo]', required: false, enum: ['me', 'none'] })
  @ApiOkResponse({ type: PrivacyRequestPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<PrivacyRequestPageDto> {
    const parsed = parseListQuery<RequestSortField>(query, SORT, FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.requests.list(tx, ctx, parsed));
  }

  @Get('assignable')
  @RequirePermission('privacy.manage')
  @ApiOperation({ summary: 'Members who can be given requests' })
  @ApiOkResponse({ type: [AssignableMemberDto] })
  async assignable(@Tenant() ctx: TenantContext): Promise<AssignableMemberDto[]> {
    return this.tenantDb.run(ctx, (tx) => this.requests.assignable(tx));
  }

  @Get(':id')
  @RequirePermission('privacy.view')
  @ApiOperation({ summary: 'A request with its evidence and history' })
  @ApiOkResponse({ type: PrivacyRequestDto })
  async get(@Tenant() ctx: TenantContext, @Param('id', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<PrivacyRequestDto> {
    const request = await this.tenantDb.run(ctx, (tx) => this.requests.get(tx, ctx, id));
    setVersionEtag(res, request.version);
    return request;
  }

  @Post()
  @RequirePermission('privacy.manage')
  @ApiOperation({ summary: `Log a request; it is due ${30} days after it reached the company` })
  @ApiCreatedResponse({ type: PrivacyRequestDto })
  async create(@Tenant() ctx: TenantContext, @Body() body: CreatePrivacyRequestBody, @Res({ passthrough: true }) res: Response): Promise<PrivacyRequestDto> {
    const request = await this.tenantDb.run(ctx, (tx) => this.requests.create(tx, ctx, body));
    setVersionEtag(res, request.version);
    return request;
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermission('privacy.manage')
  @ApiOperation({ summary: 'Give the request to a member, or clear the assignee' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PrivacyRequestDto })
  async assign(
    @Tenant() ctx: TenantContext,
    @Param('id', UUID_PARAM) id: string,
    @Body() body: AssignPrivacyRequestBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PrivacyRequestDto> {
    return this.versioned(res, ifMatch, (version) => this.tenantDb.run(ctx, (tx) => this.requests.assign(tx, ctx, id, version, body)));
  }

  @Post(':id/verify-identity')
  @HttpCode(200)
  @RequirePermission('privacy.manage')
  @ApiOperation({ summary: "Record how the requester's identity was verified (once)" })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PrivacyRequestDto })
  async verifyIdentity(
    @Tenant() ctx: TenantContext,
    @Param('id', UUID_PARAM) id: string,
    @Body() body: VerifyIdentityBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PrivacyRequestDto> {
    return this.versioned(res, ifMatch, (version) => this.tenantDb.run(ctx, (tx) => this.requests.verifyIdentity(tx, ctx, id, version, body)));
  }

  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('privacy.manage')
  @ApiOperation({ summary: 'Move the request on: verifying, in progress, completed (access), refused or withdrawn' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PrivacyRequestDto })
  async changeStatus(
    @Tenant() ctx: TenantContext,
    @Param('id', UUID_PARAM) id: string,
    @Body() body: ChangePrivacyRequestStatusBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PrivacyRequestDto> {
    return this.versioned(res, ifMatch, (version) => this.tenantDb.run(ctx, (tx) => this.requests.changeStatus(tx, ctx, id, version, body)));
  }

  @Post(':id/extend')
  @HttpCode(200)
  @RequirePermission('privacy.manage')
  @ApiOperation({ summary: 'Extend the due date once, with the reason' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PrivacyRequestDto })
  async extend(
    @Tenant() ctx: TenantContext,
    @Param('id', UUID_PARAM) id: string,
    @Body() body: ExtendPrivacyRequestBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PrivacyRequestDto> {
    return this.versioned(res, ifMatch, (version) => this.tenantDb.run(ctx, (tx) => this.requests.extend(tx, ctx, id, version, body)));
  }

  @Post(':id/evidence')
  @RequirePermission('privacy.manage')
  @ApiOperation({ summary: 'Record evidence: the request, identity proof seen, correspondence or the response (append-only)' })
  @ApiCreatedResponse({ type: PrivacyRequestDto })
  async addEvidence(
    @Tenant() ctx: TenantContext,
    @Param('id', UUID_PARAM) id: string,
    @Body() body: AddEvidenceBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PrivacyRequestDto> {
    const request = await this.tenantDb.run(ctx, (tx) => this.requests.addEvidence(tx, ctx, id, body));
    setVersionEtag(res, request.version);
    return request;
  }

  @Post(':id/access-report')
  @HttpCode(200)
  @RequirePermission('privacy.fulfil')
  @ApiOperation({ summary: 'Produce the access report (JSON, protected details included) as a 24-hour export for you; audited' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PrivacyRequestDto })
  async accessReport(
    @Tenant() ctx: TenantContext,
    @Req() req: EstateProRequest,
    @Param('id', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PrivacyRequestDto> {
    this.requireFreshSecondFactor(req);
    res.setHeader('Cache-Control', 'no-store');
    return this.versioned(res, ifMatch, (version) => this.tenantDb.run(ctx, (tx) => this.requests.generateAccessReport(tx, ctx, id, version)));
  }

  @Post(':id/erase')
  @HttpCode(200)
  @RequirePermission('privacy.fulfil')
  @ApiOperation({ summary: 'Carry out the erasure (ADR-007 §8) and complete the request; cannot be undone' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PrivacyRequestDto })
  async erase(
    @Tenant() ctx: TenantContext,
    @Req() req: EstateProRequest,
    @Param('id', UUID_PARAM) id: string,
    @Body() body: CarryOutErasureBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PrivacyRequestDto> {
    void body;
    this.requireFreshSecondFactor(req);
    return this.versioned(res, ifMatch, (version) => this.tenantDb.run(ctx, (tx) => this.requests.carryOutErasure(tx, ctx, id, version)));
  }

  private async versioned(res: Response, ifMatch: string | undefined, work: (version: number) => Promise<PrivacyRequestDto>): Promise<PrivacyRequestDto> {
    const request = await work(requireIfMatch(ifMatch));
    setVersionEtag(res, request.version);
    return request;
  }

  /** Erasing and disclosing protected data use the reveal window (ADR-007 §9), tighter than the general step-up. */
  private requireFreshSecondFactor(req: EstateProRequest): void {
    const token = req.auth?.token;
    if (!token || token.authTime === null || !this.verifier.hasRecentMfa(token, new Date(), this.config.REVEAL_STEP_UP_MAX_AGE_SECONDS)) {
      throw Problems.mfaRequired('This needs a second-factor sign-in within the last few minutes. Sign in again and retry.');
    }
  }
}
