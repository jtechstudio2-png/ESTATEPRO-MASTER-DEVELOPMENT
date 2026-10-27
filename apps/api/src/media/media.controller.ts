import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiNoContentResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { type ListQueryInput, parseListQuery } from '../common/list-query.js';
import { ProblemError, Problems } from '../common/problem.js';
import type { EstateProRequest, TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import {
  CreateLinkBody,
  CreateUploadBody,
  LegalHoldBody,
  ListingGalleryDto,
  ListingMediaBody,
  MediaDto,
  MediaPageDto,
  ReasonBody,
  StorageUsageDto,
  UpdateMediaBody,
  UploadTicketDto,
} from './dto.js';
import { type MediaSortField, MediaService } from './media.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

@ApiTags('Media')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class MediaController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly media: MediaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('media/uploads')
  @RequirePermission('property.view')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: UploadTicketDto, description: 'Upload the file with PUT to uploadUrl, then confirm' })
  async createUpload(
    @Tenant() ctx: TenantContext,
    @Body() body: CreateUploadBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UploadTicketDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.media.createUpload(tx, ctx, body),
      })),
    );
    res.status(result.status);
    return result.body;
  }

  @Post('media/uploads/:uploadId/confirm')
  @RequirePermission('property.view')
  @ApiCreatedResponse({ type: MediaDto, description: 'Media created with processingStatus "pending"' })
  async confirmUpload(
    @Tenant() ctx: TenantContext,
    @Param('uploadId', UUID_PARAM) uploadId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaDto> {
    const media = await this.tenantDb.run(ctx, (tx) => this.media.confirmUpload(tx, ctx, uploadId));
    if (media instanceof ProblemError) throw media;
    res.status(201).location(`/api/v1/media/${media.id}`);
    setVersionEtag(res, media.version);
    return media;
  }

  @Get('properties/:propertyId/media')
  @RequirePermission('property.view')
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['sortOrder', '-sortOrder', 'createdAt', '-createdAt'] })
  @ApiQuery({ name: 'filter[mediaType]', required: false })
  @ApiQuery({ name: 'filter[processingStatus]', required: false })
  @ApiQuery({ name: 'filter[unitId]', required: false })
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'true', 'all'] })
  @ApiOkResponse({ type: MediaPageDto })
  async list(@Tenant() ctx: TenantContext, @Param('propertyId', UUID_PARAM) propertyId: string, @Query() query: ListQueryInput): Promise<MediaPageDto> {
    const parsed = parseListQuery<MediaSortField>(
      query,
      { allowed: { sortOrder: 'numeric', createdAt: 'timestamp' }, default: { field: 'sortOrder', direction: 'asc' } },
      {
        mediaType: { type: 'enum', values: ['photo', 'video', 'floor_plan', 'virtual_tour', 'site_plan', 'brochure'], multi: true },
        processingStatus: { type: 'enum', values: ['pending', 'ready', 'failed', 'rejected'], multi: true },
        unitId: { type: 'uuid', multi: true },
        archived: { type: 'archived' },
      },
    );
    return this.tenantDb.run(ctx, (tx) => this.media.list(tx, ctx, propertyId, parsed));
  }

  @Post('properties/:propertyId/media/links')
  @RequirePermission('property.update')
  @ApiCreatedResponse({ type: MediaDto, description: 'External video (YouTube, Vimeo) or virtual tour (Matterport)' })
  async createLink(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) propertyId: string,
    @Body() body: CreateLinkBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaDto> {
    const media = await this.tenantDb.run(ctx, (tx) => this.media.createLink(tx, ctx, propertyId, body));
    res.status(201).location(`/api/v1/media/${media.id}`);
    setVersionEtag(res, media.version);
    return media;
  }

  @Get('media/:mediaId')
  @RequirePermission('property.view')
  @ApiOkResponse({ type: MediaDto })
  async get(@Tenant() ctx: TenantContext, @Param('mediaId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<MediaDto> {
    const media = await this.tenantDb.run(ctx, (tx) => this.media.get(tx, ctx, id));
    setVersionEtag(res, media.version);
    return media;
  }

  @Patch('media/:mediaId')
  @RequirePermission('property.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: MediaDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('mediaId', UUID_PARAM) id: string,
    @Body() body: UpdateMediaBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.media.update(tx, ctx, id, expected, body)));
  }

  @Post('media/:mediaId/archive')
  @RequirePermission('property.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: MediaDto })
  async archive(
    @Tenant() ctx: TenantContext,
    @Param('mediaId', UUID_PARAM) id: string,
    @Body() body: ReasonBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.media.archive(tx, ctx, id, expected, body.reason)));
  }

  @Post('media/:mediaId/restore')
  @RequirePermission('property.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: MediaDto })
  async restore(
    @Tenant() ctx: TenantContext,
    @Param('mediaId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.media.restore(tx, ctx, id, expected)));
  }

  @Post('media/:mediaId/purge')
  @RequirePermission('property.archive')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Permanently deleted (erasure request; media must be archived and not under legal hold)' })
  async purge(@Tenant() ctx: TenantContext, @Param('mediaId', UUID_PARAM) id: string, @Body() body: ReasonBody): Promise<void> {
    await this.tenantDb.run(ctx, (tx) => this.media.purgeNow(tx, ctx, id, body.reason));
  }

  @Post('media/:mediaId/legal-hold')
  @RequirePermission('property.archive')
  @ApiOkResponse({ type: MediaDto })
  async legalHold(
    @Tenant() ctx: TenantContext,
    @Param('mediaId', UUID_PARAM) id: string,
    @Body() body: LegalHoldBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MediaDto> {
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.media.setLegalHold(tx, ctx, id, body)));
  }

  @Get('listings/:listingId/media')
  @RequirePermission('listing.view')
  @ApiOkResponse({ type: ListingGalleryDto })
  async listingGallery(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) listingId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingGalleryDto> {
    const gallery = await this.tenantDb.run(ctx, (tx) => this.media.listingGallery(tx, ctx, listingId));
    setVersionEtag(res, gallery.listingVersion);
    return gallery;
  }

  @Put('listings/:listingId/media')
  @RequirePermission('listing.update')
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the listing' })
  @ApiOkResponse({ type: ListingGalleryDto })
  async setListingGallery(
    @Tenant() ctx: TenantContext,
    @Param('listingId', UUID_PARAM) listingId: string,
    @Body() body: ListingMediaBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ListingGalleryDto> {
    const expected = requireIfMatch(ifMatch);
    const gallery = await this.tenantDb.run(ctx, (tx) => this.media.setListingGallery(tx, ctx, listingId, expected, body));
    setVersionEtag(res, gallery.listingVersion);
    return gallery;
  }

  @Get('settings/storage')
  @RequirePermission('property.view')
  @ApiOkResponse({ type: StorageUsageDto })
  async storageUsage(@Tenant() ctx: TenantContext): Promise<StorageUsageDto> {
    return this.tenantDb.run(ctx, (tx) => this.media.storageUsage(tx, ctx));
  }

  private respond(res: Response, media: MediaDto): MediaDto {
    res.status(200);
    setVersionEtag(res, media.version);
    return media;
  }
}
