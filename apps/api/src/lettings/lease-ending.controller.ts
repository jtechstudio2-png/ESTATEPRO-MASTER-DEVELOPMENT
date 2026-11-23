import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { CloseCheckDto, EndLeaseBody, NoticeBody, NoticeResultDto, RenewalDecisionBody, RenewalLeaseBody } from './ending.dto.js';
import { LeaseEndingService } from './lease-ending.service.js';
import { LeaseDto } from './lettings.dto.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/** Notice, ending, closing and renewal of leases (Phase 7 L4; LET-07; LS-6, LS-7). */
@ApiTags('Leases')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class LeaseEndingController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly ending: LeaseEndingService,
  ) {}

  @Post('leases/:leaseId/notice')
  @HttpCode(200)
  @RequirePermission('lease.update')
  @ApiOperation({ summary: "Record notice: the tenancy then ends on the given date (default: the lease's notice days, shown, not enforced as law)" })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: NoticeResultDto })
  async notice(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Body() body: NoticeBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<NoticeResultDto> {
    const version = requireIfMatch(ifMatch);
    const result = await this.tenantDb.run(ctx, (tx) => this.ending.notice(tx, ctx, id, version, body));
    setVersionEtag(res, result.lease.version);
    return result;
  }

  @Post('leases/:leaseId/end')
  @HttpCode(200)
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'End the lease on or after its end date, with the move-out date; the rent to the end date is charged first' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async end(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Body() body: EndLeaseBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.ending.end(tx, ctx, id, version, body)));
  }

  @Get('leases/:leaseId/close-check')
  @RequirePermission('lease.view')
  @ApiOperation({ summary: 'What closing the lease waits for: nothing owed, no unsettled receipt, the deposit settled (the move-out inspection is shown)' })
  @ApiOkResponse({ type: CloseCheckDto })
  async closeCheck(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string): Promise<CloseCheckDto> {
    return this.tenantDb.run(ctx, (tx) => this.ending.closeCheck(tx, ctx, id));
  }

  @Post('leases/:leaseId/close')
  @HttpCode(200)
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Close an ended lease once it is settled; then the unit can be relisted' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async close(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.ending.close(tx, ctx, id, version)));
  }

  @Post('leases/:leaseId/renewal-decision')
  @HttpCode(200)
  @RequirePermission('lease.update')
  @ApiOperation({ summary: 'Record the renewal decision: renew, not renewing, or decide later' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: LeaseDto })
  async renewalDecision(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Body() body: RenewalDecisionBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.ending.renewalDecision(tx, ctx, id, version, body)));
  }

  @Post('leases/:leaseId/renewal')
  @RequirePermission('lease.create')
  @ApiOperation({ summary: 'Draw up the renewal: a draft lease of the same unit and parties from the day after this one ends' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the lease being renewed' })
  @ApiCreatedResponse({ type: LeaseDto, description: 'The renewal lease (draft)' })
  async renewal(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string, @Body() body: RenewalLeaseBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<LeaseDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.ending.renewal(tx, ctx, id, version, body)));
  }
}

function withEtag<T extends { version: number }>(res: Response, body: T): T {
  setVersionEtag(res, body.version);
  return body;
}
