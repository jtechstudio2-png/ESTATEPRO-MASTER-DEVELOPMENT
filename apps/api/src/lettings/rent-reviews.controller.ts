import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { RentReviewDto, RentReviewListDto, ScheduleReviewBody, UpdateReviewBody } from './rent.dto.js';
import { RentReviewsService } from './rent-reviews.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/** Rent reviews of a lease (Phase 7 L2; LET-08; RR-1). */
@ApiTags('Leases')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/leases/:leaseId/rent-reviews')
export class RentReviewsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly reviews: RentReviewsService,
  ) {}

  @Get()
  @RequirePermission('lease.view')
  @ApiOperation({ summary: 'The lease\'s rent reviews, latest first' })
  @ApiOkResponse({ type: RentReviewListDto })
  async list(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) leaseId: string): Promise<RentReviewListDto> {
    return { data: await this.tenantDb.run(ctx, (tx) => this.reviews.list(tx, ctx, leaseId)) };
  }

  @Post()
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Schedule a rent review (one open review per lease)' })
  @ApiCreatedResponse({ type: RentReviewDto })
  async schedule(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) leaseId: string, @Body() body: ScheduleReviewBody, @Res({ passthrough: true }) res: Response): Promise<RentReviewDto> {
    const review = await this.tenantDb.run(ctx, (tx) => this.reviews.schedule(tx, ctx, leaseId, body));
    res.location(`/api/v1/leases/${leaseId}/rent-reviews/${review.id}`);
    return withEtag(res, review);
  }

  @Patch(':reviewId')
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Edit, propose (notice to the outbox), agree, dispute or cancel a review' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the review' })
  @ApiOkResponse({ type: RentReviewDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('leaseId', UUID_PARAM) leaseId: string,
    @Param('reviewId', UUID_PARAM) reviewId: string,
    @Body() body: UpdateReviewBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RentReviewDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.reviews.update(tx, ctx, leaseId, reviewId, version, body)));
  }

  @Post(':reviewId/apply')
  @HttpCode(200)
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Apply an agreed review: the agreed rent is charged from its effective date' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the review' })
  @ApiOkResponse({ type: RentReviewDto })
  async apply(
    @Tenant() ctx: TenantContext,
    @Param('leaseId', UUID_PARAM) leaseId: string,
    @Param('reviewId', UUID_PARAM) reviewId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RentReviewDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.reviews.apply(tx, ctx, leaseId, reviewId, version)));
  }
}

function withEtag<T extends { version: number }>(res: Response, body: T): T {
  setVersionEtag(res, body.version);
  return body;
}
