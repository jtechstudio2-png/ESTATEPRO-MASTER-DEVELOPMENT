import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { type ChargeSortField, ChargesService } from './charges.service.js';
import { LettingsSettingsService } from './lettings-settings.service.js';
import {
  AdjustmentBody,
  AdjustmentPreviewDto,
  AdjustmentResultDto,
  CHARGE_STATUSES,
  CHARGE_TYPES,
  CreateChargeBody,
  LedgerDto,
  LettingsSettingsBody,
  LettingsSettingsDto,
  ReasonBody,
  RentChargeDto,
  RentChargePageDto,
  RentScheduleBody,
} from './rent.dto.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const SORT = { allowed: { dueDate: 'text' }, default: { field: 'dueDate', direction: 'asc' } } as const satisfies SortSpec<ChargeSortField>;
const FILTERS: FilterSpec = {
  status: { type: 'enum', values: CHARGE_STATUSES, multi: true },
  chargeType: { type: 'enum', values: CHARGE_TYPES, multi: true },
  currency: { type: 'code', pattern: /^[A-Z]{3}$/, multi: true },
  leaseId: { type: 'uuid', multi: true },
  propertyId: { type: 'uuid', multi: true },
  officeId: { type: 'uuid', multi: true },
  dueDate: { type: 'range', pattern: /^\d{4}-\d{2}-\d{2}$/ },
};

/** Rent charges, adjustments, the lease ledger and lettings settings (Phase 7 L2; LET-03; RL-1, RC-1 to RC-4, ST-2). */
@ApiTags('Rent')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class RentController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly charges: ChargesService,
    private readonly settings: LettingsSettingsService,
  ) {}

  @Get('rent-charges')
  @RequirePermission('rent.view')
  @ApiOperation({ summary: 'Charges across leases in your scope; posted by default; totals per currency' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['dueDate', '-dueDate'] })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[chargeType]', required: false })
  @ApiQuery({ name: 'filter[currency]', required: false })
  @ApiQuery({ name: 'filter[leaseId]', required: false })
  @ApiQuery({ name: 'filter[propertyId]', required: false })
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiQuery({ name: 'filter[dueDate][gte]', required: false })
  @ApiQuery({ name: 'filter[dueDate][lte]', required: false })
  @ApiOkResponse({ type: RentChargePageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<RentChargePageDto> {
    const parsed = parseListQuery<ChargeSortField>(query, SORT, FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.charges.list(tx, ctx, parsed));
  }

  @Get('rent-charges/:chargeId')
  @RequirePermission('rent.view')
  @ApiOkResponse({ type: RentChargeDto })
  async get(@Tenant() ctx: TenantContext, @Param('chargeId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<RentChargeDto> {
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.charges.get(tx, ctx, id)));
  }

  @Post('leases/:leaseId/charges')
  @RequirePermission('rent.manage')
  @ApiTags('Leases')
  @ApiOperation({ summary: 'Add a charge the schedule does not create (service, utility, repair recharge, fee, other), posted now or on its due date' })
  @ApiCreatedResponse({ type: RentChargeDto })
  async create(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) leaseId: string, @Body() body: CreateChargeBody, @Res({ passthrough: true }) res: Response): Promise<RentChargeDto> {
    const charge = await this.tenantDb.run(ctx, (tx) => this.charges.create(tx, ctx, leaseId, body));
    res.location(`/api/v1/rent-charges/${charge.id}`);
    return withEtag(res, charge);
  }

  @Post('rent-charges/:chargeId/waive')
  @HttpCode(200)
  @RequirePermission('rent.manage')
  @ApiOperation({ summary: 'Waive a posted charge with nothing allocated, with the reason' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: RentChargeDto })
  async waive(@Tenant() ctx: TenantContext, @Param('chargeId', UUID_PARAM) id: string, @Body() body: ReasonBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<RentChargeDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.charges.waive(tx, ctx, id, version, body.reason)));
  }

  @Post('rent-charges/:chargeId/cancel')
  @HttpCode(200)
  @RequirePermission('rent.manage')
  @ApiOperation({ summary: 'Cancel a scheduled charge, or a posted one with nothing allocated' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: RentChargeDto })
  async cancel(@Tenant() ctx: TenantContext, @Param('chargeId', UUID_PARAM) id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<RentChargeDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.charges.cancel(tx, ctx, id, version)));
  }

  @Post('rent-charges/:chargeId/adjustments/preview')
  @HttpCode(200)
  @RequirePermission('rent.manage')
  @ApiOperation({ summary: 'What the charge would owe after the adjustment; nothing is saved' })
  @ApiOkResponse({ type: AdjustmentPreviewDto })
  async preview(@Tenant() ctx: TenantContext, @Param('chargeId', UUID_PARAM) id: string, @Body() body: AdjustmentBody): Promise<AdjustmentPreviewDto> {
    return this.tenantDb.run(ctx, (tx) => this.charges.previewAdjustment(tx, ctx, id, body));
  }

  @Post('rent-charges/:chargeId/adjustments')
  @RequirePermission('rent.manage')
  @ApiOperation({ summary: 'Correct a posted charge by a credit or debit (append-only; approved; open period; never below what is paid)' })
  @ApiCreatedResponse({ type: AdjustmentResultDto })
  async adjust(@Tenant() ctx: TenantContext, @Param('chargeId', UUID_PARAM) id: string, @Body() body: AdjustmentBody): Promise<AdjustmentResultDto> {
    return this.tenantDb.run(ctx, (tx) => this.charges.adjust(tx, ctx, id, body));
  }

  @Get('leases/:leaseId/ledger')
  @RequirePermission('rent.view')
  @ApiTags('Leases')
  @ApiOperation({ summary: 'The lease ledger as of a date: charges, receipts, reversals and adjustments with the running balance and ageing' })
  @ApiQuery({ name: 'asOf', required: false, description: 'Default: today in the property\'s time zone' })
  @ApiOkResponse({ type: LedgerDto })
  async ledger(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) leaseId: string, @Query('asOf') asOf: string | undefined): Promise<LedgerDto> {
    if (asOf !== undefined && typeof asOf !== 'string') throw Problems.validation([{ field: 'asOf', code: 'invalid', message: 'Use a real date such as 2026-11-28.' }]);
    return this.tenantDb.run(ctx, (tx) => this.charges.ledger(tx, ctx, leaseId, asOf));
  }

  @Post('leases/:leaseId/rent-schedule')
  @HttpCode(200)
  @RequirePermission('rent.manage')
  @ApiTags('Leases')
  @ApiOperation({ summary: 'Start the rent schedule of an imported live lease from a date (fixed once set); posts what is already due' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the lease' })
  @ApiOkResponse({ schema: { type: 'object', properties: { posted: { type: 'integer' } } } })
  async startSchedule(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) leaseId: string, @Body() body: RentScheduleBody, @Headers('if-match') ifMatch: string | undefined): Promise<{ posted: number }> {
    const version = requireIfMatch(ifMatch);
    return this.tenantDb.run(ctx, (tx) => this.charges.startSchedule(tx, ctx, leaseId, version, body.from));
  }

  @Get('settings/lettings')
  @RequirePermission('lease.view')
  @ApiTags('Settings')
  @ApiOperation({ summary: 'Lettings settings (ST-2): charge lead time and the signed-lease rule' })
  @ApiOkResponse({ type: LettingsSettingsDto })
  async getSettings(@Tenant() ctx: TenantContext): Promise<LettingsSettingsDto> {
    return this.tenantDb.run(ctx, (tx) => this.settings.get(tx));
  }

  @Put('settings/lettings')
  @RequirePermission('settings.manage')
  @ApiTags('Settings')
  @ApiOkResponse({ type: LettingsSettingsDto })
  async saveSettings(@Tenant() ctx: TenantContext, @Body() body: LettingsSettingsBody): Promise<LettingsSettingsDto> {
    return this.tenantDb.run(ctx, (tx) => this.settings.save(tx, ctx, body));
  }
}

function withEtag<T extends { version: number }>(res: Response, body: T): T {
  setVersionEtag(res, body.version);
  return body;
}
