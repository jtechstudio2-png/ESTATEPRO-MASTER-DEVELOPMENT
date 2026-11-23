import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { type ArrearsSortField, ArrearsService } from './arrears.service.js';
import { ARREARS_BUCKETS, ArrearsActionBody, ArrearsPageDto, ClosePlanBody, LeaseArrearsDto, PaymentPlanBody } from './receipts.dto.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const SORT = { allowed: { oldestDueDate: 'text' }, default: { field: 'oldestDueDate', direction: 'asc' } } as const satisfies SortSpec<ArrearsSortField>;
const FILTERS: FilterSpec = {
  officeId: { type: 'uuid', multi: true },
  leaseId: { type: 'uuid', multi: true },
  currency: { type: 'code', pattern: /^[A-Z]{3}$/, multi: true },
  bucket: { type: 'enum', values: ARREARS_BUCKETS, multi: true },
  nextActionDue: { type: 'boolean' },
};

function asOfParam(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw Problems.validation([{ field: 'asOf', code: 'invalid', message: 'Use a real date such as 2026-11-28.' }]);
  return value;
}

/** Arrears, arrears actions and payment plans (Phase 7 L3; LET-05; AR-1, AR-2; P7-D10). */
@ApiTags('Arrears')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class ArrearsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly arrears: ArrearsService,
  ) {}

  @Get('arrears')
  @RequirePermission('rent.view')
  @ApiOperation({ summary: 'Leases owing money past its due date, as of a date, with ageing; oldest debt first; totals per currency' })
  @ApiQuery({ name: 'asOf', required: false, description: 'Default: today (company time zone). A past date reproduces its figures' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['oldestDueDate', '-oldestDueDate'] })
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiQuery({ name: 'filter[leaseId]', required: false })
  @ApiQuery({ name: 'filter[currency]', required: false })
  @ApiQuery({ name: 'filter[bucket]', required: false, description: 'The age of the oldest unpaid charge: 1-30, 31-60, 61-90, 90+' })
  @ApiQuery({ name: 'filter[nextActionDue]', required: false })
  @ApiOkResponse({ type: ArrearsPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput & { asOf?: unknown }): Promise<ArrearsPageDto> {
    const { asOf, ...rest } = query;
    const parsed = parseListQuery<ArrearsSortField>(rest, SORT, FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.arrears.list(tx, ctx, parsed, asOfParam(asOf)));
  }

  @Get('leases/:leaseId/arrears')
  @RequirePermission('rent.view')
  @ApiTags('Leases')
  @ApiQuery({ name: 'asOf', required: false })
  @ApiOkResponse({ type: LeaseArrearsDto })
  async forLease(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) leaseId: string, @Query('asOf') asOf: unknown): Promise<LeaseArrearsDto> {
    return this.tenantDb.run(ctx, (tx) => this.arrears.forLease(tx, ctx, leaseId, asOfParam(asOf)));
  }

  @Post('leases/:leaseId/arrears-actions')
  @RequirePermission('arrears.manage')
  @ApiTags('Leases')
  @ApiOperation({ summary: 'Record an arrears action (a history: never edited)' })
  @ApiCreatedResponse({ type: LeaseArrearsDto })
  async recordAction(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) leaseId: string, @Body() body: ArrearsActionBody): Promise<LeaseArrearsDto> {
    return this.tenantDb.run(ctx, (tx) => this.arrears.recordAction(tx, ctx, leaseId, body));
  }

  @Post('leases/:leaseId/payment-plans')
  @RequirePermission('arrears.manage')
  @ApiTags('Leases')
  @ApiOperation({ summary: 'Agree a payment plan (one active per lease; at most what the lease owes)' })
  @ApiCreatedResponse({ type: LeaseArrearsDto })
  async createPlan(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) leaseId: string, @Body() body: PaymentPlanBody): Promise<LeaseArrearsDto> {
    return this.tenantDb.run(ctx, (tx) => this.arrears.createPlan(tx, ctx, leaseId, body));
  }

  @Patch('leases/:leaseId/payment-plans/:planId')
  @RequirePermission('arrears.manage')
  @ApiTags('Leases')
  @ApiOperation({ summary: 'Close a plan: completed, broken or cancelled (final)' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the plan' })
  @ApiOkResponse({ type: LeaseArrearsDto })
  async closePlan(
    @Tenant() ctx: TenantContext,
    @Param('leaseId', UUID_PARAM) leaseId: string,
    @Param('planId', UUID_PARAM) planId: string,
    @Body() body: ClosePlanBody,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<LeaseArrearsDto> {
    const version = requireIfMatch(ifMatch);
    return this.tenantDb.run(ctx, (tx) => this.arrears.closePlan(tx, ctx, leaseId, planId, version, body));
  }
}
