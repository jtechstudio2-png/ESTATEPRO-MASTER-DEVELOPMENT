import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { ACTIVITY_TYPES, ActivityDetailDto, ActivityPageDto, ArchiveActivityBody, EditActivityBody, LogActivityBody } from './activities.dto.js';
import { ActivitiesService, type TimelineQuery } from './activities.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/** Activity timeline and logging (Phase 5 milestone C3; wireframes A-1, A-2; decision D5). */
@ApiTags('Activities')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class ActivitiesController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly activities: ActivitiesService,
  ) {}

  @Get('contacts/:contactId/activities')
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Contact timeline: activities on the contact and its leads, newest first' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'filter[activityType]', required: false, description: ACTIVITY_TYPES.join(', ') })
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'all'] })
  @ApiOkResponse({ type: ActivityPageDto })
  async contactTimeline(@Tenant() ctx: TenantContext, @Param('contactId', UUID_PARAM) id: string, @Query() query: Record<string, unknown>): Promise<ActivityPageDto> {
    const parsed = parseTimeline(query);
    return this.tenantDb.run(ctx, (tx) => this.activities.contactTimeline(tx, ctx, id, parsed));
  }

  @Get('leads/:leadId/activities')
  @RequirePermission('lead.view')
  @ApiOperation({ summary: 'Lead timeline, newest first' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'filter[activityType]', required: false })
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'all'] })
  @ApiOkResponse({ type: ActivityPageDto })
  async leadTimeline(@Tenant() ctx: TenantContext, @Param('leadId', UUID_PARAM) id: string, @Query() query: Record<string, unknown>): Promise<ActivityPageDto> {
    const parsed = parseTimeline(query);
    return this.tenantDb.run(ctx, (tx) => this.activities.leadTimeline(tx, ctx, id, parsed));
  }

  @Post('activities')
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Log a call, message, meeting or note (recorded, not sent)' })
  @ApiCreatedResponse({ type: ActivityDetailDto })
  async log(@Tenant() ctx: TenantContext, @Body() body: LogActivityBody, @Res({ passthrough: true }) res: Response): Promise<ActivityDetailDto> {
    const activity = await this.tenantDb.run(ctx, (tx) => this.activities.log(tx, ctx, body));
    res.location(`/api/v1/activities/${activity.id}`);
    setVersionEtag(res, activity.version);
    return activity;
  }

  @Get('activities/:activityId')
  @RequirePermission('contact.view')
  @ApiOkResponse({ type: ActivityDetailDto })
  async get(@Tenant() ctx: TenantContext, @Param('activityId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<ActivityDetailDto> {
    const activity = await this.tenantDb.run(ctx, (tx) => this.activities.get(tx, ctx, id));
    setVersionEtag(res, activity.version);
    return activity;
  }

  @Patch('activities/:activityId')
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Edit your own activity within 24 hours; the earlier version is kept (D5)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ActivityDetailDto })
  async edit(
    @Tenant() ctx: TenantContext,
    @Param('activityId', UUID_PARAM) id: string,
    @Body() body: EditActivityBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ActivityDetailDto> {
    const version = requireIfMatch(ifMatch);
    const activity = await this.tenantDb.run(ctx, (tx) => this.activities.edit(tx, ctx, id, version, body));
    setVersionEtag(res, activity.version);
    return activity;
  }

  @Post('activities/:activityId/archive')
  @HttpCode(200)
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Archive with a reason (author, or a manager over a linked record)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ActivityDetailDto })
  async archive(
    @Tenant() ctx: TenantContext,
    @Param('activityId', UUID_PARAM) id: string,
    @Body() body: ArchiveActivityBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ActivityDetailDto> {
    const version = requireIfMatch(ifMatch);
    const activity = await this.tenantDb.run(ctx, (tx) => this.activities.archive(tx, ctx, id, version, body.reason));
    setVersionEtag(res, activity.version);
    return activity;
  }
}

function parseTimeline(query: Record<string, unknown>): TimelineQuery {
  const errors: Array<{ field: string; code: string; message: string }> = [];
  let limit = 50;
  if (query['limit'] !== undefined) {
    limit = typeof query['limit'] === 'string' && /^\d{1,3}$/.test(query['limit']) ? Number(query['limit']) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) errors.push({ field: 'limit', code: 'range', message: 'Use a whole number from 1 to 100.' });
  }
  let cursor: TimelineQuery['cursor'] = null;
  const rawCursor = query['cursor'];
  if (rawCursor !== undefined) {
    try {
      if (typeof rawCursor !== 'string') throw new Error('bad');
      const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as { t?: unknown; n?: unknown };
      if (typeof decoded.t !== 'string' || Number.isNaN(Date.parse(decoded.t)) || typeof decoded.n !== 'string' || !/^\d{1,19}$/.test(decoded.n)) throw new Error('bad');
      cursor = { t: decoded.t, n: decoded.n };
    } catch {
      errors.push({ field: 'cursor', code: 'invalid', message: 'The cursor is not valid for this list.' });
    }
  }
  const filter = (query['filter'] ?? {}) as Record<string, unknown>;
  let types: string[] | null = null;
  const rawTypes = filter['activityType'];
  if (rawTypes !== undefined) {
    types = typeof rawTypes === 'string' ? rawTypes.split(',').map((value) => value.trim()) : [];
    if (types.length === 0 || !types.every((type) => (ACTIVITY_TYPES as readonly string[]).includes(type))) {
      errors.push({ field: 'filter[activityType]', code: 'invalid', message: `Allowed: ${ACTIVITY_TYPES.join(', ')}.` });
    }
  }
  const archived = filter['archived'] ?? 'false';
  if (archived !== 'false' && archived !== 'all') errors.push({ field: 'filter[archived]', code: 'invalid', message: 'Use false or all.' });
  const unknown = Object.keys(filter).filter((key) => key !== 'activityType' && key !== 'archived');
  for (const key of unknown) errors.push({ field: `filter[${key}]`, code: 'unknown-filter', message: 'This filter is not supported.' });
  if (errors.length > 0) throw Problems.validation(errors);
  return { limit, cursor, types, includeArchived: archived === 'all' };
}
