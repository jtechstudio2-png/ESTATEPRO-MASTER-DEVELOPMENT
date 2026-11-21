import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type RangeValue, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { KeySetDto } from '../keys/dto.js';
import {
  BookViewingBody,
  CancelViewingBody,
  FeedbackSharingBody,
  NoShowBody,
  RecordOutcomeBody,
  RescheduleViewingBody,
  VIEWING_STATUSES,
  ViewingDto,
  ViewingKeyCheckOutBody,
  ViewingPageDto,
} from './viewings.dto.js';
import { ViewingsService } from './viewings.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;

const VIEWING_SORT = { allowed: { scheduledStart: 'timestamp' }, default: { field: 'scheduledStart', direction: 'asc' } } as const satisfies SortSpec<'scheduledStart'>;
const VIEWING_FILTERS: FilterSpec = {
  scheduledStart: { type: 'range', pattern: DATE_TIME },
  status: { type: 'enum', values: VIEWING_STATUSES, multi: true },
  agentMembershipId: { type: 'uuid', multi: true },
  listingId: { type: 'uuid' },
  leadId: { type: 'uuid' },
  dealId: { type: 'uuid' },
  contactId: { type: 'uuid' },
  needsOutcome: { type: 'boolean' },
};

const one = (value: unknown): string | null => (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null);

/** Viewings (Phase 6 milestone S1; SAL-02; readiness report §4.1). */
@ApiTags('Viewings')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/viewings')
export class ViewingsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly viewings: ViewingsService,
  ) {}

  @Get()
  @RequirePermission('viewing.view')
  @ApiOperation({ summary: 'Viewings in your scope: the agent calendar (time range, agents), a listing, lead, deal or contact, and "needing feedback"' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['scheduledStart', '-scheduledStart'] })
  @ApiQuery({ name: 'filter[scheduledStart][gte]', required: false, description: 'Calendar range start (week or day boundaries computed by the client in the office time zone)' })
  @ApiQuery({ name: 'filter[scheduledStart][lte]', required: false })
  @ApiQuery({ name: 'filter[status]', required: false, description: `Any of ${VIEWING_STATUSES.join(', ')}` })
  @ApiQuery({ name: 'filter[agentMembershipId]', required: false, description: 'One or more agents (your own calendar: your membership id)' })
  @ApiQuery({ name: 'filter[listingId]', required: false })
  @ApiQuery({ name: 'filter[leadId]', required: false })
  @ApiQuery({ name: 'filter[dealId]', required: false })
  @ApiQuery({ name: 'filter[contactId]', required: false, description: 'Viewings this contact attends' })
  @ApiQuery({ name: 'filter[needsOutcome]', required: false, enum: ['true', 'false'], description: 'Scheduled or confirmed and already over: record an outcome or a no-show' })
  @ApiOkResponse({ type: ViewingPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<ViewingPageDto> {
    const parsed = parseListQuery<'scheduledStart'>(query, VIEWING_SORT, VIEWING_FILTERS);
    const f = parsed.filters;
    return this.tenantDb.run(ctx, (tx) =>
      this.viewings.list(tx, ctx, {
        limit: parsed.limit,
        cursor: parsed.cursor,
        direction: parsed.sort.direction,
        start: (f['scheduledStart'] as RangeValue | undefined) ?? null,
        statuses: Array.isArray(f['status']) ? (f['status']) : null,
        agentIds: Array.isArray(f['agentMembershipId']) ? (f['agentMembershipId']) : null,
        listingId: one(f['listingId']),
        leadId: one(f['leadId']),
        dealId: one(f['dealId']),
        contactId: one(f['contactId']),
        needsOutcome: typeof f['needsOutcome'] === 'boolean' ? f['needsOutcome'] : null,
      }),
    );
  }

  @Post()
  @RequirePermission('viewing.manage')
  @ApiOperation({ summary: 'Book a viewing on a live listing; from a lead or an open deal' })
  @ApiCreatedResponse({ type: ViewingDto })
  async book(@Tenant() ctx: TenantContext, @Body() body: BookViewingBody, @Res({ passthrough: true }) res: Response): Promise<ViewingDto> {
    const viewing = await this.tenantDb.run(ctx, (tx) => this.viewings.book(tx, ctx, body));
    res.location(`/api/v1/viewings/${viewing.id}`);
    setVersionEtag(res, viewing.version);
    return viewing;
  }

  @Get(':viewingId')
  @RequirePermission('viewing.view')
  @ApiOkResponse({ type: ViewingDto })
  async get(@Tenant() ctx: TenantContext, @Param('viewingId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<ViewingDto> {
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.viewings.get(tx, ctx, id)));
  }

  @Post(':viewingId/confirm')
  @HttpCode(200)
  @RequirePermission('viewing.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ViewingDto })
  async confirm(
    @Tenant() ctx: TenantContext,
    @Param('viewingId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ViewingDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.viewings.confirm(tx, ctx, id, version)));
  }

  @Post(':viewingId/reschedule')
  @HttpCode(200)
  @RequirePermission('viewing.manage')
  @ApiOperation({ summary: 'Move to a new time: the viewing is kept as rescheduled and a new one is booked with the same attendees (returned)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ViewingDto })
  async reschedule(
    @Tenant() ctx: TenantContext,
    @Param('viewingId', UUID_PARAM) id: string,
    @Body() body: RescheduleViewingBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ViewingDto> {
    const version = requireIfMatch(ifMatch);
    const viewing = await this.tenantDb.run(ctx, (tx) => this.viewings.reschedule(tx, ctx, id, version, body));
    res.location(`/api/v1/viewings/${viewing.id}`);
    return this.withEtag(res, viewing);
  }

  @Post(':viewingId/cancel')
  @HttpCode(200)
  @RequirePermission('viewing.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ViewingDto })
  async cancel(
    @Tenant() ctx: TenantContext,
    @Param('viewingId', UUID_PARAM) id: string,
    @Body() body: CancelViewingBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ViewingDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.viewings.cancel(tx, ctx, id, version, body.reason)));
  }

  @Post(':viewingId/outcome')
  @HttpCode(200)
  @RequirePermission('viewing.manage')
  @ApiOperation({ summary: 'Record the outcome, feedback and attendance once the viewing has started; final once recorded (P6-D3)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ViewingDto })
  async outcome(
    @Tenant() ctx: TenantContext,
    @Param('viewingId', UUID_PARAM) id: string,
    @Body() body: RecordOutcomeBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ViewingDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.viewings.recordOutcome(tx, ctx, id, version, body)));
  }

  @Post(':viewingId/no-show')
  @HttpCode(200)
  @RequirePermission('viewing.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ViewingDto })
  async noShow(
    @Tenant() ctx: TenantContext,
    @Param('viewingId', UUID_PARAM) id: string,
    @Body() body: NoShowBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ViewingDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.viewings.noShow(tx, ctx, id, version, body.note ?? null)));
  }

  @Post(':viewingId/feedback-sharing')
  @HttpCode(200)
  @RequirePermission('viewing.manage')
  @ApiOperation({ summary: 'Share (or stop sharing) a completed viewing\'s feedback with the landlord' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ViewingDto })
  async feedbackSharing(
    @Tenant() ctx: TenantContext,
    @Param('viewingId', UUID_PARAM) id: string,
    @Body() body: FeedbackSharingBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ViewingDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.viewings.setFeedbackSharing(tx, ctx, id, version, body.shared)));
  }

  @Post(':viewingId/keys/check-out')
  @HttpCode(200)
  @RequirePermission('key.issue')
  @ApiOperation({ summary: 'Check keys out for this viewing, to its agent or one of its attendees' })
  @ApiOkResponse({ type: KeySetDto })
  async checkOutKeys(@Tenant() ctx: TenantContext, @Param('viewingId', UUID_PARAM) id: string, @Body() body: ViewingKeyCheckOutBody): Promise<KeySetDto> {
    return this.tenantDb.run(ctx, (tx) => this.viewings.checkOutKeys(tx, ctx, id, body));
  }

  private withEtag(res: Response, viewing: ViewingDto): ViewingDto {
    setVersionEtag(res, viewing.version);
    return viewing;
  }
}
