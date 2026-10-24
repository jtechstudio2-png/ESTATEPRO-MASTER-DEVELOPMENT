import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiNoContentResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Scope, Tenant } from '../auth/decorators.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { EstateProRequest, PermissionScope, TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { ArchiveBody } from '../properties/dto.js';
import {
  AssignAgentBody,
  CreateListingBody,
  HistoryPageDto,
  LISTING_STATUSES,
  LISTING_TYPES,
  ListingDto,
  ListingPageDto,
  ListingSettingsBody,
  ListingSettingsDto,
  ListingStatusBody,
  PriceHistoryPageDto,
  RelistBody,
  StatusHistoryPageDto,
  TranslationBody,
  UpdateListingBody,
} from './dto.js';
import { ListingSettingsService } from './listing-settings.service.js';
import { type ListingSortField, ListingsService } from './listings.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const LOCALE_PARAM = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const DATE_RANGE = /^\d{4}-\d{2}-\d{2}$/;

const LIST_SORT = {
  allowed: { reference: 'text', createdAt: 'timestamp', updatedAt: 'timestamp', price: 'numeric' },
  default: { field: 'updatedAt', direction: 'desc' },
} as const;

const LIST_FILTERS: FilterSpec = {
  listingType: { type: 'enum', values: LISTING_TYPES, multi: true },
  status: { type: 'enum', values: LISTING_STATUSES, multi: true },
  officeId: { type: 'uuid', multi: true },
  agentMembershipId: { type: 'uuid', multi: true },
  propertyId: { type: 'uuid', multi: true },
  unitId: { type: 'uuid', multi: true },
  isPublished: { type: 'boolean' },
  archived: { type: 'archived' },
  currencyCode: { type: 'code', pattern: /^[A-Z]{3}$/, multi: true },
  price: { type: 'range', pattern: /^\d{1,15}(\.\d{1,4})?$/ },
  bedrooms: { type: 'range', pattern: /^\d{1,3}$/ },
  availableFrom: { type: 'range', pattern: DATE_RANGE },
  mandateExpiresOn: { type: 'range', pattern: DATE_RANGE },
};

const HISTORY_SORT = { allowed: { changedAt: 'timestamp' }, default: { field: 'changedAt', direction: 'asc' } } as const;
const AUDIT_SORT = { allowed: { occurredAt: 'timestamp' }, default: { field: 'occurredAt', direction: 'desc' } } as const;

function parseListingQuery(query: ListQueryInput) {
  return parseListQuery<ListingSortField>(query, { allowed: { ...LIST_SORT.allowed }, default: { ...LIST_SORT.default } }, LIST_FILTERS);
}

@ApiTags('Listings')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class ListingsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly listings: ListingsService,
    private readonly settings: ListingSettingsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('listings')
  @RequirePermission('listing.view')
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['reference', '-reference', 'createdAt', '-createdAt', 'updatedAt', '-updatedAt', 'price', '-price'] })
  @ApiQuery({ name: 'q', required: false, description: 'Reference or title (any language) contains' })
  @ApiQuery({ name: 'filter[listingType]', required: false, description: 'sale, rent' })
  @ApiQuery({ name: 'filter[status]', required: false, description: 'Comma-separated statuses' })
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiQuery({ name: 'filter[agentMembershipId]', required: false })
  @ApiQuery({ name: 'filter[propertyId]', required: false })
  @ApiQuery({ name: 'filter[unitId]', required: false })
  @ApiQuery({ name: 'filter[isPublished]', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'true', 'all'] })
  @ApiQuery({ name: 'filter[currencyCode]', required: false, description: 'Required (single) with a price range' })
  @ApiQuery({ name: 'filter[price][gte]', required: false })
  @ApiQuery({ name: 'filter[price][lte]', required: false })
  @ApiQuery({ name: 'filter[bedrooms][gte]', required: false })
  @ApiQuery({ name: 'filter[bedrooms][lte]', required: false })
  @ApiQuery({ name: 'filter[availableFrom][lte]', required: false })
  @ApiQuery({ name: 'filter[mandateExpiresOn][lte]', required: false })
  @ApiOkResponse({ type: ListingPageDto })
  async list(@Tenant() ctx: TenantContext, @Scope() scope: PermissionScope, @Query() query: ListQueryInput): Promise<ListingPageDto> {
    const parsed = parseListingQuery(query);
    return this.tenantDb.run(ctx, (tx) => this.listings.list(tx, ctx, scope, parsed));
  }

  @Get('properties/:propertyId/listings')
  @RequirePermission('listing.view')
  @ApiOkResponse({ type: ListingPageDto })
  async listForProperty(
    @Tenant() ctx: TenantContext,
    @Scope() scope: PermissionScope,
    @Param('propertyId', UUID_PARAM) propertyId: string,
    @Query() query: ListQueryInput,
  ): Promise<ListingPageDto> {
    const parsed = parseListingQuery(query);
    parsed.filters['propertyId'] = [propertyId];
    return this.tenantDb.run(ctx, async (tx) => {
      await this.listings.assertPropertyVisible(tx, ctx, { propertyId });
      return this.listings.list(tx, ctx, scope, parsed);
    });
  }

  @Get('units/:unitId/listings')
  @RequirePermission('listing.view')
  @ApiOkResponse({ type: ListingPageDto })
  async listForUnit(
    @Tenant() ctx: TenantContext,
    @Scope() scope: PermissionScope,
    @Param('unitId', UUID_PARAM) unitId: string,
    @Query() query: ListQueryInput,
  ): Promise<ListingPageDto> {
    const parsed = parseListingQuery(query);
    parsed.filters['unitId'] = [unitId];
    return this.tenantDb.run(ctx, async (tx) => {
      await this.listings.assertPropertyVisible(tx, ctx, { unitId });
      return this.listings.list(tx, ctx, scope, parsed);
    });
  }

  @Post('listings')
  @RequirePermission('listing.create')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: ListingDto })
  async create(
    @Tenant() ctx: TenantContext,
    @Scope() scope: PermissionScope,
    @Body() body: CreateListingBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.listings.create(tx, ctx, scope, body),
      })),
    );
    res.status(result.status).location(`/api/v1/listings/${result.body.id}`);
    setVersionEtag(res, result.body.version);
    return result.body;
  }

  @Get('listings/:listingId')
  @RequirePermission('listing.view')
  @ApiOkResponse({ type: ListingDto })
  async get(@Tenant() ctx: TenantContext, @Param('listingId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<ListingDto> {
    const listing = await this.tenantDb.run(ctx, (tx) => this.listings.get(tx, ctx, id));
    setVersionEtag(res, listing.version);
    return listing;
  }

  @Patch('listings/:listingId')
  @RequirePermission('listing.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ListingDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) id: string,
    @Body() body: UpdateListingBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.listings.update(tx, ctx, id, expected, body)));
  }

  @Post('listings/:listingId/publish')
  @RequirePermission('listing.publish')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ListingDto })
  async publish(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.listings.publish(tx, ctx, id, expected)));
  }

  @Post('listings/:listingId/unpublish')
  @RequirePermission('listing.publish')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ListingDto })
  async unpublish(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.listings.unpublish(tx, ctx, id, expected)));
  }

  @Post('listings/:listingId/status-transitions')
  @RequirePermission('listing.publish')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ListingDto })
  async changeStatus(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) id: string,
    @Body() body: ListingStatusBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.listings.changeStatus(tx, ctx, id, expected, body.toStatus, body.reason)));
  }

  @Post('listings/:listingId/assign')
  @RequirePermission('listing.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ListingDto })
  async assign(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) id: string,
    @Body() body: AssignAgentBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.listings.assign(tx, ctx, id, expected, body)));
  }

  @Post('listings/:listingId/relist')
  @RequirePermission('listing.create')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: ListingDto })
  async relist(
    @Tenant() ctx: TenantContext,
    @Scope() scope: PermissionScope,
    @Param('listingId', UUID_PARAM) id: string,
    @Body() body: RelistBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.listings.relist(tx, ctx, scope, id, body.agentMembershipId),
      })),
    );
    res.status(result.status).location(`/api/v1/listings/${result.body.id}`);
    setVersionEtag(res, result.body.version);
    return result.body;
  }

  @Post('listings/:listingId/archive')
  @RequirePermission('listing.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ListingDto })
  async archive(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) id: string,
    @Body() body: ArchiveBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.listings.archive(tx, ctx, id, expected, body.reason)));
  }

  @Post('listings/:listingId/restore')
  @RequirePermission('listing.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ListingDto })
  async restore(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.listings.restore(tx, ctx, id, expected)));
  }

  @Put('listings/:listingId/translations/:localeCode')
  @RequirePermission('listing.update')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the listing' })
  @ApiOkResponse({ type: ListingDto })
  async saveTranslation(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) id: string,
    @Param('localeCode') localeCode: string,
    @Body() body: TranslationBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingDto> {
    if (!LOCALE_PARAM.test(localeCode)) throw Problems.notFound('This language is not supported.');
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.listings.saveTranslation(tx, ctx, id, expected, localeCode, body)));
  }

  @Delete('listings/:listingId/translations/:localeCode')
  @RequirePermission('listing.update')
  @HttpCode(204)
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the listing' })
  @ApiNoContentResponse({ description: 'Removed; the ETag header carries the listing’s new version' })
  async removeTranslation(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) id: string,
    @Param('localeCode') localeCode: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (!LOCALE_PARAM.test(localeCode)) throw Problems.notFound('This language is not supported.');
    const expected = requireIfMatch(ifMatch);
    const listing = await this.tenantDb.run(ctx, (tx) => this.listings.removeTranslation(tx, ctx, id, expected, localeCode));
    setVersionEtag(res, listing.version);
  }

  @Get('listings/:listingId/status-history')
  @RequirePermission('listing.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: StatusHistoryPageDto })
  async statusHistory(@Tenant() ctx: TenantContext, @Param('listingId', UUID_PARAM) id: string, @Query() query: ListQueryInput): Promise<StatusHistoryPageDto> {
    const parsed = parseListQuery<'changedAt'>(query, { allowed: { ...HISTORY_SORT.allowed }, default: { ...HISTORY_SORT.default } }, {});
    return this.tenantDb.run(ctx, (tx) => this.listings.statusHistory(tx, ctx, id, parsed));
  }

  @Get('listings/:listingId/price-history')
  @RequirePermission('listing.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: PriceHistoryPageDto })
  async priceHistory(@Tenant() ctx: TenantContext, @Param('listingId', UUID_PARAM) id: string, @Query() query: ListQueryInput): Promise<PriceHistoryPageDto> {
    const parsed = parseListQuery<'changedAt'>(query, { allowed: { ...HISTORY_SORT.allowed }, default: { ...HISTORY_SORT.default } }, {});
    return this.tenantDb.run(ctx, (tx) => this.listings.priceHistory(tx, ctx, id, parsed));
  }

  @Get('listings/:listingId/history')
  @RequirePermission('listing.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: HistoryPageDto })
  async history(@Tenant() ctx: TenantContext, @Param('listingId', UUID_PARAM) id: string, @Query() query: ListQueryInput): Promise<HistoryPageDto> {
    const parsed = parseListQuery<'occurredAt'>(query, { allowed: { ...AUDIT_SORT.allowed }, default: { ...AUDIT_SORT.default } }, {});
    return this.tenantDb.run(ctx, (tx) => this.listings.history(tx, ctx, id, parsed));
  }

  // --------------------------------------------------------------------------- settings

  @Get('settings/listings')
  @RequirePermission('listing.view')
  @ApiOkResponse({ type: ListingSettingsDto })
  async getSettings(@Tenant() ctx: TenantContext): Promise<ListingSettingsDto> {
    return this.tenantDb.run(ctx, (tx) => this.settings.get(tx));
  }

  @Put('settings/listings')
  @RequirePermission('settings.manage')
  @ApiOkResponse({ type: ListingSettingsDto })
  async saveSettings(@Tenant() ctx: TenantContext, @Body() body: ListingSettingsBody): Promise<ListingSettingsDto> {
    return this.tenantDb.run(ctx, (tx) => this.settings.save(tx, ctx, body));
  }

  private respond(res: Response, listing: ListingDto): ListingDto {
    res.status(200);
    setVersionEtag(res, listing.version);
    return listing;
  }
}
