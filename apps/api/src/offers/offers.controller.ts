import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { CounterOfferBody, OFFER_STATUSES, OfferDto, OfferPageDto, OfferReasonBody, RecordOfferBody } from './offers.dto.js';
import { OffersService } from './offers.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const OFFER_SORT = { allowed: { submittedAt: 'timestamp' }, default: { field: 'submittedAt', direction: 'desc' } } as const satisfies SortSpec<'submittedAt'>;
const OFFER_FILTERS: FilterSpec = {
  dealId: { type: 'uuid' },
  listingId: { type: 'uuid' },
  contactId: { type: 'uuid' },
  status: { type: 'enum', values: OFFER_STATUSES, multi: true },
};
const one = (value: unknown): string | null => (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null);

/** Offers (Phase 6 milestone S2; SAL-03; readiness report §4.2). */
@ApiTags('Offers')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/offers')
export class OffersController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly offers: OffersService,
  ) {}

  @Get()
  @RequirePermission('offer.view')
  @ApiOperation({ summary: 'Offers in your scope (by deal): a deal\'s negotiation, a listing\'s offers, a contact\'s offers; newest first' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['submittedAt', '-submittedAt'] })
  @ApiQuery({ name: 'filter[dealId]', required: false })
  @ApiQuery({ name: 'filter[listingId]', required: false })
  @ApiQuery({ name: 'filter[contactId]', required: false, description: 'Offers this contact made' })
  @ApiQuery({ name: 'filter[status]', required: false, description: `Any of ${OFFER_STATUSES.join(', ')}` })
  @ApiOkResponse({ type: OfferPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<OfferPageDto> {
    const parsed = parseListQuery<'submittedAt'>(query, OFFER_SORT, OFFER_FILTERS);
    const f = parsed.filters;
    return this.tenantDb.run(ctx, (tx) =>
      this.offers.list(tx, ctx, {
        limit: parsed.limit,
        cursor: parsed.cursor,
        direction: parsed.sort.direction,
        dealId: one(f['dealId']),
        listingId: one(f['listingId']),
        contactId: one(f['contactId']),
        statuses: Array.isArray(f['status']) ? (f['status']) : null,
      }),
    );
  }

  @Post()
  @RequirePermission('offer.manage')
  @ApiOperation({ summary: 'Record an offer on an open deal (moves an early deal to negotiation)' })
  @ApiCreatedResponse({ type: OfferDto })
  async record(@Tenant() ctx: TenantContext, @Body() body: RecordOfferBody, @Res({ passthrough: true }) res: Response): Promise<OfferDto> {
    const offer = await this.tenantDb.run(ctx, (tx) => this.offers.record(tx, ctx, body));
    res.location(`/api/v1/offers/${offer.id}`);
    return this.withEtag(res, offer);
  }

  @Get(':offerId')
  @RequirePermission('offer.view')
  @ApiOkResponse({ type: OfferDto })
  async get(@Tenant() ctx: TenantContext, @Param('offerId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<OfferDto> {
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.offers.get(tx, ctx, id)));
  }

  @Post(':offerId/counter')
  @HttpCode(201)
  @RequirePermission('offer.manage')
  @ApiOperation({ summary: 'Counter an open offer: a new offer from the other side, linked to it; returns the counter-offer' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the offer being countered' })
  @ApiCreatedResponse({ type: OfferDto })
  async counter(
    @Tenant() ctx: TenantContext,
    @Param('offerId', UUID_PARAM) id: string,
    @Body() body: CounterOfferBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OfferDto> {
    const version = requireIfMatch(ifMatch);
    const offer = await this.tenantDb.run(ctx, (tx) => this.offers.counter(tx, ctx, id, version, body));
    res.location(`/api/v1/offers/${offer.id}`);
    return this.withEtag(res, offer);
  }

  @Post(':offerId/accept')
  @HttpCode(200)
  @RequirePermission('offer.accept')
  @ApiOperation({ summary: 'Accept (company owner, sales managers): the deal moves to "offer accepted" and the listing is reserved' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: OfferDto })
  async accept(
    @Tenant() ctx: TenantContext,
    @Param('offerId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OfferDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.offers.accept(tx, ctx, id, version)));
  }

  @Post(':offerId/reject')
  @HttpCode(200)
  @RequirePermission('offer.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: OfferDto })
  async reject(
    @Tenant() ctx: TenantContext,
    @Param('offerId', UUID_PARAM) id: string,
    @Body() body: OfferReasonBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OfferDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.offers.reject(tx, ctx, id, version, body.reason ?? null)));
  }

  @Post(':offerId/withdraw')
  @HttpCode(200)
  @RequirePermission('offer.manage')
  @ApiOperation({ summary: 'Withdraw an open offer, or an accepted one with a reason (the deal returns to negotiation, the listing to available)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: OfferDto })
  async withdraw(
    @Tenant() ctx: TenantContext,
    @Param('offerId', UUID_PARAM) id: string,
    @Body() body: OfferReasonBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OfferDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.offers.withdraw(tx, ctx, id, version, body.reason ?? null)));
  }

  private withEtag(res: Response, offer: OfferDto): OfferDto {
    setVersionEtag(res, offer.version);
    return offer;
  }
}
