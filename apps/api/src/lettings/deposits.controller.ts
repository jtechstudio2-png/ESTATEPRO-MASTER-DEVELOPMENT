import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { DeductionBody, DeductionDecisionBody, DepositBody, DepositDto, LeaseDepositDto, ProtectionBody, ReturnDepositBody } from './deposits.dto.js';
import { DepositsService } from './deposits.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/** Deposits: registration, protection, deductions and return (Phase 7 L4; LET-06; DP-1; P7-D11). */
@ApiTags('Deposits')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class DepositsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly deposits: DepositsService,
  ) {}

  @Get('leases/:leaseId/deposit')
  @RequirePermission('deposit.view')
  @ApiTags('Leases')
  @ApiOperation({ summary: "The lease's deposit (or none yet), the amount its terms name, and the jurisdiction's protection rule" })
  @ApiOkResponse({ type: LeaseDepositDto })
  async forLease(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) leaseId: string, @Res({ passthrough: true }) res: Response): Promise<LeaseDepositDto> {
    const result = await this.tenantDb.run(ctx, (tx) => this.deposits.forLease(tx, ctx, leaseId));
    if (result.deposit) setVersionEtag(res, result.deposit.version);
    return result;
  }

  @Put('leases/:leaseId/deposit')
  @RequirePermission('deposit.manage')
  @ApiTags('Leases')
  @ApiOperation({ summary: "Register the lease's deposit, or change how it is held; a deposit the agency collects gets its deposit charge" })
  @ApiHeader({ name: 'If-Match', required: false, description: "The deposit's version, required once it exists" })
  @ApiOkResponse({ type: LeaseDepositDto })
  async save(
    @Tenant() ctx: TenantContext,
    @Param('leaseId', UUID_PARAM) leaseId: string,
    @Body() body: DepositBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LeaseDepositDto> {
    const version = ifMatch === undefined || ifMatch.trim() === '' ? null : requireIfMatch(ifMatch);
    const result = await this.tenantDb.run(ctx, (tx) => this.deposits.save(tx, ctx, leaseId, version, body));
    if (result.deposit) setVersionEtag(res, result.deposit.version);
    return result;
  }

  @Post('deposits/:depositId/protection')
  @HttpCode(200)
  @RequirePermission('deposit.manage')
  @ApiOperation({ summary: 'Record the protection of a held deposit (scheme, reference, date)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DepositDto })
  async protect(@Tenant() ctx: TenantContext, @Param('depositId', UUID_PARAM) id: string, @Body() body: ProtectionBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DepositDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deposits.protect(tx, ctx, id, version, body)));
  }

  @Post('deposits/:depositId/deductions')
  @RequirePermission('deposit.manage')
  @ApiOperation({ summary: 'Propose a deduction with its evidence (after notice or once the lease has ended)' })
  @ApiHeader({ name: 'If-Match', required: true, description: "The deposit's version" })
  @ApiCreatedResponse({ type: DepositDto })
  async addDeduction(@Tenant() ctx: TenantContext, @Param('depositId', UUID_PARAM) id: string, @Body() body: DeductionBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DepositDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deposits.addDeduction(tx, ctx, id, version, body)));
  }

  @Patch('deposits/:depositId/deductions/:deductionId')
  @RequirePermission('deposit.manage')
  @ApiOperation({ summary: 'Agree, dispute, adjudicate or withdraw a deduction, or attach its evidence' })
  @ApiHeader({ name: 'If-Match', required: true, description: "The deduction's version" })
  @ApiOkResponse({ type: DepositDto })
  async decide(
    @Tenant() ctx: TenantContext,
    @Param('depositId', UUID_PARAM) id: string,
    @Param('deductionId', UUID_PARAM) deductionId: string,
    @Body() body: DeductionDecisionBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DepositDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deposits.decideDeduction(tx, ctx, id, deductionId, version, body)));
  }

  @Post('deposits/:depositId/return')
  @HttpCode(200)
  @RequirePermission('deposit.manage')
  @ApiOperation({ summary: 'Record the return: the deposit less its settled deductions (returned, partly returned or forfeited)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: DepositDto })
  async returnDeposit(@Tenant() ctx: TenantContext, @Param('depositId', UUID_PARAM) id: string, @Body() body: ReturnDepositBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<DepositDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.deposits.returnDeposit(tx, ctx, id, version, body)));
  }
}

function withEtag<T extends { version: number }>(res: Response, body: T): T {
  setVersionEtag(res, body.version);
  return body;
}
