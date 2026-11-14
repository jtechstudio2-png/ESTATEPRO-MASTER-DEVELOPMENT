import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { DealProgressService } from './deal-progress.service.js';
import {
  CompleteBody,
  CompleteMilestoneBody,
  ConvertLeadBody,
  CreateDealBody,
  DEAL_STATUSES,
  DEAL_TYPES,
  DealDto,
  DealPartyBody,
  DealSummaryPageDto,
  ExchangeBody,
  ForecastDto,
  LoseDealBody,
  MoveStageBody,
  PipelineDto,
  ReassignDealBody,
  SetDealAgentsBody,
  STAGE_CLASSES,
  UpdateDealBody,
  UpdateMilestoneBody,
} from './deals.dto.js';
import { type DealSortField, DealsService } from './deals.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBER = /^(me|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DEAL_SORT = {
  allowed: { updatedAt: 'timestamp', createdAt: 'timestamp', stageEnteredAt: 'timestamp' },
  default: { field: 'updatedAt', direction: 'desc' },
} as const satisfies SortSpec<DealSortField>;
const DEAL_FILTERS: FilterSpec = {
  dealType: { type: 'enum', values: DEAL_TYPES, multi: true },
  status: { type: 'enum', values: DEAL_STATUSES, multi: true },
  stageId: { type: 'uuid', multi: true },
  stageClass: { type: 'enum', values: STAGE_CLASSES, multi: true },
  officeId: { type: 'uuid', multi: true },
  ownerMembershipId: { type: 'code', pattern: MEMBER, multi: true },
  listingId: { type: 'uuid', multi: true },
  contactId: { type: 'uuid', multi: true },
  leadId: { type: 'uuid', multi: true },
  attention: { type: 'enum', values: ['stalled'], multi: true },
  expectedCloseDate: { type: 'range', pattern: /^\d{4}-\d{2}-\d{2}$/ },
};

/** Deals (Phase 6 milestone S3; SAL-01, SAL-04 to SAL-07; readiness report §4.3, §4.4). */
@ApiTags('Deals')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class DealsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly deals: DealsService,
    private readonly progress: DealProgressService,
  ) {}

  @Get('deals')
  @RequirePermission('deal.view')
  @ApiOperation({ summary: 'Deals in your scope (pipeline list): open deals by default, most recently changed first' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['updatedAt', '-updatedAt', 'createdAt', '-createdAt', 'stageEnteredAt', '-stageEnteredAt'] })
  @ApiQuery({ name: 'q', required: false, description: 'Reference prefix or contact name' })
  @ApiQuery({ name: 'filter[dealType]', required: false, description: 'sale, letting' })
  @ApiQuery({ name: 'filter[status]', required: false, description: 'open (default), won, lost' })
  @ApiQuery({ name: 'filter[stageId]', required: false, description: 'Board column' })
  @ApiQuery({ name: 'filter[stageClass]', required: false })
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiQuery({ name: 'filter[ownerMembershipId]', required: false, description: 'Member ids or "me"' })
  @ApiQuery({ name: 'filter[listingId]', required: false })
  @ApiQuery({ name: 'filter[contactId]', required: false, description: 'Primary contact or any party' })
  @ApiQuery({ name: 'filter[leadId]', required: false })
  @ApiQuery({ name: 'filter[attention]', required: false, description: 'stalled: longer in its stage than the stage allows' })
  @ApiQuery({ name: 'filter[expectedCloseDate][gte]', required: false })
  @ApiQuery({ name: 'filter[expectedCloseDate][lte]', required: false })
  @ApiOkResponse({ type: DealSummaryPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<DealSummaryPageDto> {
    const parsed = parseListQuery<DealSortField>(query, DEAL_SORT, DEAL_FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.deals.list(tx, ctx, parsed));
  }

  @Get('deals/pipeline')
  @RequirePermission('deal.view')
  @ApiOperation({ summary: 'Pipeline board columns (SAL-06): open deals per stage with stalled counts and totals per currency' })
  @ApiQuery({ name: 'dealType', required: true, enum: DEAL_TYPES })
  @ApiQuery({ name: 'officeId', required: false, description: 'Comma-separated office ids' })
  @ApiQuery({ name: 'ownerMembershipId', required: false, description: 'Comma-separated member ids or "me"' })
  @ApiOkResponse({ type: PipelineDto })
  async pipeline(@Tenant() ctx: TenantContext, @Query() query: Record<string, unknown>): Promise<PipelineDto> {
    const errors: FieldError[] = [];
    const filters = { dealType: dealTypeOf(query['dealType'], errors), ...boardFilters(ctx, query, errors) };
    if (errors.length > 0) throw Problems.validation(errors);
    return this.tenantDb.run(ctx, (tx) => this.deals.pipeline(tx, ctx, filters));
  }

  @Get('deals/forecast')
  @RequirePermission('deal.view')
  @ApiOperation({ summary: 'Forecast (SAL-07): open deals by expected close month; expected value × probability, per currency' })
  @ApiQuery({ name: 'dealType', required: true, enum: DEAL_TYPES })
  @ApiQuery({ name: 'from', required: false, description: 'First month, YYYY-MM (default: this month)' })
  @ApiQuery({ name: 'months', required: false, description: '1 to 24 (default 12)' })
  @ApiQuery({ name: 'officeId', required: false })
  @ApiQuery({ name: 'ownerMembershipId', required: false })
  @ApiOkResponse({ type: ForecastDto })
  async forecast(@Tenant() ctx: TenantContext, @Query() query: Record<string, unknown>): Promise<ForecastDto> {
    const errors: FieldError[] = [];
    const dealType = dealTypeOf(query['dealType'], errors);
    const raw = query['from'];
    const from = raw === undefined ? new Date().toISOString().slice(0, 7) : typeof raw === 'string' ? raw : '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from)) errors.push({ field: 'from', code: 'invalid', message: 'Use a month such as 2026-11.' });
    const months = query['months'] === undefined ? 12 : Number(query['months']);
    if (!Number.isInteger(months) || months < 1 || months > 24) errors.push({ field: 'months', code: 'range', message: 'Use a whole number from 1 to 24.' });
    const filters = boardFilters(ctx, query, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    return this.tenantDb.run(ctx, (tx) => this.deals.forecast(tx, ctx, { dealType, from, months, ...filters }));
  }

  @Post('deals')
  @RequirePermission('deal.create')
  @ApiOperation({ summary: 'Create a deal directly (walk-in, referral); it starts at the lead stage with its primary contact as buyer or tenant' })
  @ApiCreatedResponse({ type: DealDto })
  async create(@Tenant() ctx: TenantContext, @Body() body: CreateDealBody, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const deal = await this.tenantDb.run(ctx, (tx) => this.deals.create(tx, ctx, body));
    res.location(`/api/v1/deals/${deal.id}`);
    return this.withEtag(res, deal);
  }

  @Post('leads/:leadId/convert')
  @HttpCode(201)
  @RequirePermission('lead.update')
  @ApiTags('Leads')
  @ApiOperation({ summary: 'Convert a buy or rent lead into its one deal (needs lead.update and deal.create); the lead keeps its history' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the lead' })
  @ApiCreatedResponse({ type: DealDto })
  async convert(
    @Tenant() ctx: TenantContext,
    @Param('leadId', UUID_PARAM) leadId: string,
    @Body() body: ConvertLeadBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    const deal = await this.tenantDb.run(ctx, (tx) => this.deals.convertLead(tx, ctx, leadId, version, body));
    res.location(`/api/v1/deals/${deal.id}`);
    return this.withEtag(res, deal);
  }

  @Get('deals/:dealId')
  @RequirePermission('deal.view')
  @ApiOkResponse({ type: DealDto })
  async get(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deals.get(tx, ctx, id)));
  }

  @Patch('deals/:dealId')
  @RequirePermission('deal.update')
  @ApiOperation({ summary: 'Edit the expected value, fee, close date and probability; the listing until offers are recorded' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DealDto })
  async update(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Body() body: UpdateDealBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deals.update(tx, ctx, id, version, body)));
  }

  @Post('deals/:dealId/stage')
  @HttpCode(200)
  @RequirePermission('deal.update')
  @ApiOperation({ summary: 'Move the deal among lead, qualification, viewing and negotiation as the life cycle allows (later stages follow their actions)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DealDto })
  async moveStage(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Body() body: MoveStageBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deals.moveStage(tx, ctx, id, version, body)));
  }

  @Post('deals/:dealId/reassign')
  @HttpCode(200)
  @RequirePermission('deal.update')
  @ApiOperation({ summary: 'Hand the deal to another agent (managers); recorded with the note' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DealDto })
  async reassign(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Body() body: ReassignDealBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deals.reassign(tx, ctx, id, version, body)));
  }

  @Put('deals/:dealId/agents')
  @RequirePermission('deal.update')
  @ApiOperation({ summary: 'Set the agents credited and their splits (managers); splits add up to 100 %' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DealDto })
  async setAgents(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Body() body: SetDealAgentsBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deals.setAgents(tx, ctx, id, version, body.agents)));
  }

  @Post('deals/:dealId/parties')
  @HttpCode(200)
  @RequirePermission('deal.update')
  @ApiOperation({ summary: 'Add a party (buyer, seller, lawyer, lender, …); after acceptance a new buyer gets an identity check' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DealDto })
  async addParty(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Body() body: DealPartyBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deals.addParty(tx, ctx, id, version, body)));
  }

  @Post('deals/:dealId/parties/remove')
  @HttpCode(200)
  @RequirePermission('deal.update')
  @ApiOperation({ summary: 'Remove a party role (the primary contact stays)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DealDto })
  async removeParty(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Body() body: DealPartyBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deals.removeParty(tx, ctx, id, version, body)));
  }

  @Patch('deals/:dealId/milestones/:milestoneId')
  @RequirePermission('deal.update')
  @ApiOperation({ summary: 'Change an open milestone\'s due date or notes' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the deal' })
  @ApiOkResponse({ type: DealDto })
  async updateMilestone(
    @Tenant() ctx: TenantContext,
    @Param('dealId', UUID_PARAM) id: string,
    @Param('milestoneId', UUID_PARAM) milestoneId: string,
    @Body() body: UpdateMilestoneBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deals.updateMilestone(tx, ctx, id, milestoneId, version, body)));
  }

  @Post('deals/:dealId/milestones/:milestoneId/complete')
  @HttpCode(200)
  @RequirePermission('deal.update')
  @ApiOperation({ summary: 'Mark a milestone done (identity milestones complete themselves, P6-D7)' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the deal' })
  @ApiOkResponse({ type: DealDto })
  async completeMilestone(
    @Tenant() ctx: TenantContext,
    @Param('dealId', UUID_PARAM) id: string,
    @Param('milestoneId', UUID_PARAM) milestoneId: string,
    @Body() body: CompleteMilestoneBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deals.completeMilestone(tx, ctx, id, milestoneId, version, body.notes ?? null)));
  }

  @Post('deals/:dealId/exchange')
  @HttpCode(200)
  @RequirePermission('deal.update')
  @ApiOperation({ summary: 'Contracts exchanged (sales): the sale is recorded, the deal moves to contract, the listing goes under contract (buyers verified, P6-D6)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DealDto })
  async exchange(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Body() body: ExchangeBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, async (tx) => this.deals.get(tx, ctx, await this.progress.exchange(tx, ctx, id, version, body))));
  }

  @Post('deals/:dealId/complete')
  @HttpCode(200)
  @RequirePermission('deal.close')
  @ApiOperation({ summary: 'Completion (sales; company owner and sales managers): required milestones done; the deal is won, the listing sold, the ownership transferred (P6-D8)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DealDto })
  async complete(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Body() body: CompleteBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, async (tx) => this.deals.get(tx, ctx, await this.progress.complete(tx, ctx, id, version, body))));
  }

  @Post('deals/:dealId/lose')
  @HttpCode(200)
  @RequirePermission('deal.close')
  @ApiOperation({ summary: 'Close the deal as lost with a reason (company owner and sales managers); an accepted offer is withdrawn and an exchanged sale falls through' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DealDto })
  async lose(@Tenant() ctx: TenantContext, @Param('dealId', UUID_PARAM) id: string, @Body() body: LoseDealBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DealDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, async (tx) => this.deals.get(tx, ctx, await this.progress.lose(tx, ctx, id, version, body))));
  }

  private withEtag(res: Response, deal: DealDto): DealDto {
    setVersionEtag(res, deal.version);
    return deal;
  }
}

function dealTypeOf(value: unknown, errors: FieldError[]): string {
  if (typeof value !== 'string' || !(DEAL_TYPES as readonly string[]).includes(value)) {
    errors.push({ field: 'dealType', code: 'required', message: 'Choose sale or letting.' });
    return '';
  }
  return value;
}

function boardFilters(ctx: TenantContext, query: Record<string, unknown>, errors: FieldError[]): { officeIds: string[] | null; ownerIds: string[] | null } {
  const list = (key: string, pattern: RegExp): string[] | null => {
    const value = query[key];
    if (value === undefined) return null;
    const items = typeof value === 'string' ? value.split(',').map((item) => item.trim()) : [];
    if (items.length === 0 || items.length > 50 || !items.every((item) => pattern.test(item))) {
      errors.push({ field: key, code: 'invalid', message: 'Use comma-separated ids.' });
      return null;
    }
    return items.map((item) => (item === 'me' ? ctx.membershipId : item.toLowerCase()));
  };
  return { officeIds: list('officeId', UUID), ownerIds: list('ownerMembershipId', MEMBER) };
}
