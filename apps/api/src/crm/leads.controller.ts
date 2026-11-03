import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { EstateProRequest, TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { CrmSettingsService } from './crm-settings.service.js';
import {
  ArchiveLeadBody,
  AssignLeadBody,
  ChangeLeadStatusBody,
  CreateLeadBody,
  CrmSettingsBody,
  CrmSettingsDto,
  LEAD_STATUSES,
  LEAD_TYPES,
  LeadDto,
  LeadPageDto,
  UpdateLeadBody,
} from './leads.dto.js';
import { type LeadSortField, LeadsService } from './leads.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;

const LEAD_SORT = {
  allowed: { receivedAt: 'timestamp', updatedAt: 'timestamp' },
  default: { field: 'receivedAt', direction: 'desc' },
} as const satisfies SortSpec<LeadSortField>;

const LEAD_FILTERS: FilterSpec = {
  status: { type: 'enum', values: LEAD_STATUSES, multi: true },
  leadType: { type: 'enum', values: LEAD_TYPES, multi: true },
  sourceCode: { type: 'code', pattern: /^[a-z][a-z0-9_]*$/, multi: true },
  officeId: { type: 'uuid', multi: true },
  contactId: { type: 'uuid', multi: true },
  listingId: { type: 'uuid', multi: true },
  assignedTo: { type: 'code', pattern: /^(me|unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, multi: true },
  receivedAt: { type: 'range', pattern: DATE_TIME },
  attention: { type: 'enum', values: ['response_overdue', 'no_next_action'], multi: true },
  archived: { type: 'archived' },
};

/** Leads (Phase 5 milestone C3; wireframes L-1 to L-4). */
@ApiTags('Leads')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class LeadsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly leads: LeadsService,
    private readonly settings: CrmSettingsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('leads')
  @RequirePermission('lead.view')
  @ApiOperation({ summary: 'Lead inbox and register (Inbox, Mine, Unassigned, All open, Closed are filters)' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['receivedAt', '-receivedAt', 'updatedAt', '-updatedAt'] })
  @ApiQuery({ name: 'q', required: false, description: 'Lead reference or contact name' })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[leadType]', required: false })
  @ApiQuery({ name: 'filter[sourceCode]', required: false })
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiQuery({ name: 'filter[contactId]', required: false })
  @ApiQuery({ name: 'filter[listingId]', required: false })
  @ApiQuery({ name: 'filter[assignedTo]', required: false, description: 'Member ids, "me" or "unassigned" (needs lead.assign)' })
  @ApiQuery({ name: 'filter[receivedAt][gte]', required: false })
  @ApiQuery({ name: 'filter[receivedAt][lte]', required: false })
  @ApiQuery({ name: 'filter[attention]', required: false, description: 'response_overdue (needs a response target), no_next_action' })
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'true', 'all'] })
  @ApiOkResponse({ type: LeadPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<LeadPageDto> {
    const parsed = parseListQuery<LeadSortField>(query, LEAD_SORT, LEAD_FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.leads.list(tx, ctx, parsed));
  }

  @Post('leads')
  @RequirePermission('lead.create')
  @ApiOperation({ summary: 'Capture a lead for an existing or a new contact (L-3)' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: LeadDto })
  async create(
    @Tenant() ctx: TenantContext,
    @Body() body: CreateLeadBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeadDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.leads.create(tx, ctx, body),
      })),
    );
    res.status(result.status).location(`/api/v1/leads/${result.body.id}`);
    setVersionEtag(res, result.body.version);
    return result.body;
  }

  @Get('leads/:leadId')
  @RequirePermission('lead.view')
  @ApiOkResponse({ type: LeadDto })
  async get(@Tenant() ctx: TenantContext, @Param('leadId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<LeadDto> {
    const lead = await this.tenantDb.run(ctx, (tx) => this.leads.get(tx, ctx, id));
    setVersionEtag(res, lead.version);
    return lead;
  }

  @Patch('leads/:leadId')
  @RequirePermission('lead.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeadDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('leadId', UUID_PARAM) id: string,
    @Body() body: UpdateLeadBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeadDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leads.update(tx, ctx, id, version, body)));
  }

  @Post('leads/:leadId/status')
  @HttpCode(200)
  @RequirePermission('lead.update')
  @ApiOperation({ summary: 'Change status: contacted, qualified, unqualified (with a note), lost (with a reason); reopening is a manager action' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeadDto })
  async changeStatus(
    @Tenant() ctx: TenantContext,
    @Param('leadId', UUID_PARAM) id: string,
    @Body() body: ChangeLeadStatusBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeadDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leads.changeStatus(tx, ctx, id, version, body)));
  }

  @Post('leads/:leadId/assign')
  @HttpCode(200)
  @RequirePermission('lead.assign')
  @ApiOperation({ summary: 'Assign the lead to a team member in your scope who works in its office' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeadDto })
  async assign(
    @Tenant() ctx: TenantContext,
    @Param('leadId', UUID_PARAM) id: string,
    @Body() body: AssignLeadBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeadDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leads.assign(tx, ctx, id, version, body)));
  }

  @Post('leads/:leadId/archive')
  @HttpCode(200)
  @RequirePermission('lead.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeadDto })
  async archive(
    @Tenant() ctx: TenantContext,
    @Param('leadId', UUID_PARAM) id: string,
    @Body() body: ArchiveLeadBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeadDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leads.archive(tx, ctx, id, version, body.reason)));
  }

  @Post('leads/:leadId/restore')
  @HttpCode(200)
  @RequirePermission('lead.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeadDto })
  async restore(
    @Tenant() ctx: TenantContext,
    @Param('leadId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeadDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.leads.restore(tx, ctx, id, version)));
  }

  @Get('settings/crm')
  @RequirePermission('lead.view')
  @ApiOperation({ summary: 'CRM settings: the lead response target (decision D3)' })
  @ApiOkResponse({ type: CrmSettingsDto })
  async getSettings(@Tenant() ctx: TenantContext): Promise<CrmSettingsDto> {
    return this.tenantDb.run(ctx, (tx) => this.settings.get(tx));
  }

  @Put('settings/crm')
  @RequirePermission('settings.manage')
  @ApiOkResponse({ type: CrmSettingsDto })
  async saveSettings(@Tenant() ctx: TenantContext, @Body() body: CrmSettingsBody): Promise<CrmSettingsDto> {
    return this.tenantDb.run(ctx, (tx) => this.settings.save(tx, ctx, body));
  }

  private withEtag(res: Response, lead: LeadDto): LeadDto {
    setVersionEtag(res, lead.version);
    return lead;
  }
}
