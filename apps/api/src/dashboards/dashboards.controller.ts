import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { type DashboardQuery, DashboardsService } from './dashboards.service.js';
import { AdminDashboardDto, CrmDashboardDto, MyDayDto } from './dto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Dashboards (Phase 5 milestone C4; wireframes D-A, D-C, D-M). Every figure is computed in your scope. */
@ApiTags('Dashboards')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/dashboards')
export class DashboardsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly dashboards: DashboardsService,
  ) {}

  @Get('crm')
  @RequirePermission('lead.view')
  @ApiOperation({ summary: 'CRM dashboard: waiting leads, follow-ups, statuses, response times, sources, requirements' })
  @ApiQuery({ name: 'officeId', required: false })
  @ApiQuery({ name: 'days', required: false, schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } })
  @ApiQuery({ name: 'timezone', required: false, description: 'IANA time zone for today and this week (default: your office)' })
  @ApiOkResponse({ type: CrmDashboardDto })
  async crm(@Tenant() ctx: TenantContext, @Query() query: Record<string, unknown>): Promise<CrmDashboardDto> {
    const parsed = parseQuery(query, 30);
    return this.tenantDb.run(ctx, (tx) => this.dashboards.crm(tx, ctx, parsed));
  }

  @Get('admin')
  @RequirePermission('user.manage')
  @ApiOperation({ summary: 'Admin dashboard: attention items, access, lead flow by office, data quality, privacy, exports, account' })
  @ApiQuery({ name: 'officeId', required: false })
  @ApiOkResponse({ type: AdminDashboardDto })
  async admin(@Tenant() ctx: TenantContext, @Query() query: Record<string, unknown>): Promise<AdminDashboardDto> {
    const parsed = parseQuery(query, 7, ['officeId']);
    return this.tenantDb.run(ctx, (tx) => this.dashboards.admin(tx, ctx, parsed));
  }

  @Get('my-day')
  @RequirePermission('lead.view')
  @ApiOperation({ summary: 'My day: my follow-ups due today or overdue and my new leads, in my office time zone' })
  @ApiQuery({ name: 'timezone', required: false })
  @ApiOkResponse({ type: MyDayDto })
  async myDay(@Tenant() ctx: TenantContext, @Query() query: Record<string, unknown>): Promise<MyDayDto> {
    const parsed = parseQuery(query, 1, ['timezone']);
    return this.tenantDb.run(ctx, (tx) => this.dashboards.myDay(tx, ctx, parsed));
  }
}

function parseQuery(query: Record<string, unknown>, defaultDays: number, allowed = ['officeId', 'days', 'timezone']): DashboardQuery {
  const errors: FieldError[] = [];
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) errors.push({ field: key, code: 'unknown-parameter', message: 'This parameter is not supported here.' });
  }
  const officeId = query['officeId'];
  if (officeId !== undefined && (typeof officeId !== 'string' || !UUID.test(officeId))) {
    errors.push({ field: 'officeId', code: 'invalid', message: 'Use an office id.' });
  }
  let days = defaultDays;
  if (query['days'] !== undefined) {
    days = typeof query['days'] === 'string' && /^\d{1,3}$/.test(query['days']) ? Number(query['days']) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > 365) errors.push({ field: 'days', code: 'range', message: 'Use a whole number of days from 1 to 365.' });
  }
  const timezone = query['timezone'];
  if (timezone !== undefined && (typeof timezone !== 'string' || !isTimeZone(timezone))) {
    errors.push({ field: 'timezone', code: 'invalid', message: 'Use an IANA time zone such as Africa/Accra.' });
  }
  if (errors.length > 0) throw Problems.validation(errors);
  return { officeId: (officeId as string | undefined)?.toLowerCase() ?? null, days, timezone: (timezone as string | undefined) ?? null };
}

function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
