import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { EstateProRequest, TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { BankImportService, type ImportLineSortField } from './bank-import.service.js';
import {
  AllocateBody,
  AllocationViewDto,
  CheckImportBody,
  ClearPaymentBody,
  CommitImportBody,
  ImportLineDto,
  ImportLinePageDto,
  MatchLineBody,
  PAYMENT_STATUSES,
  PaymentDto,
  PaymentImportDto,
  PaymentPageDto,
  RecordPaymentBody,
  ReverseAllocationBody,
  UnwindPaymentBody,
  UnwindResultDto,
} from './receipts.dto.js';
import { type PaymentSortField, ReceiptsService } from './receipts.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SORT = {
  allowed: { receivedOn: 'text', instrumentDate: 'text' },
  default: { field: 'receivedOn', direction: 'desc' },
} as const satisfies SortSpec<PaymentSortField>;
const FILTERS: FilterSpec = {
  status: { type: 'enum', values: PAYMENT_STATUSES, multi: true },
  methodCode: { type: 'code', pattern: /^[a-z0-9_]{1,50}$/, multi: true },
  leaseId: { type: 'uuid', multi: true },
  payerContactId: { type: 'uuid', multi: true },
  bankAccountId: { type: 'uuid', multi: true },
  currency: { type: 'code', pattern: /^[A-Z]{3}$/, multi: true },
  unallocated: { type: 'boolean' },
  receivedOn: { type: 'range', pattern: DATE },
  instrumentDate: { type: 'range', pattern: DATE },
};
const QUEUE_SORT = { allowed: { txnDate: 'text' }, default: { field: 'txnDate', direction: 'asc' } } as const satisfies SortSpec<ImportLineSortField>;

/** Receipts, allocation and bank-file import (Phase 7 L3; LET-04; RP-1 to RP-7; P7-D7, P7-D8). */
@ApiTags('Receipts')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class ReceiptsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly receipts: ReceiptsService,
    private readonly imports: BankImportService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ----------------------------------------------------------------- bank-file import (declared before payments/:paymentId)

  @Post('payments/imports')
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'Check a bank file (a clean bank statement document of the account, EstatePro CSV v1); nothing is imported yet' })
  @ApiCreatedResponse({ type: PaymentImportDto })
  async checkImport(@Tenant() ctx: TenantContext, @Body() body: CheckImportBody, @Res({ passthrough: true }) res: Response): Promise<PaymentImportDto> {
    const result = await this.tenantDb.run(ctx, (tx) => this.imports.check(tx, ctx, body));
    res.location(`/api/v1/payments/imports/${result.id}`);
    return withEtag(res, result);
  }

  @Get('payments/imports/:importId')
  @RequirePermission('payment.record')
  @ApiOkResponse({ type: PaymentImportDto })
  async getImport(@Tenant() ctx: TenantContext, @Param('importId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<PaymentImportDto> {
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.imports.get(tx, id)));
  }

  @Post('payments/imports/:importId/commit')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'Import matched lines and those given a payer as cleared receipts; other unmatched lines wait in the queue' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PaymentImportDto })
  async commitImport(@Tenant() ctx: TenantContext, @Param('importId', UUID_PARAM) id: string, @Body() body: CommitImportBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<PaymentImportDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.imports.commit(tx, ctx, id, version, body)));
  }

  @Post('payments/imports/:importId/cancel')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PaymentImportDto })
  async cancelImport(@Tenant() ctx: TenantContext, @Param('importId', UUID_PARAM) id: string, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<PaymentImportDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.imports.cancel(tx, ctx, id, version)));
  }

  @Get('payments/import-lines')
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'Bank-file lines waiting for a payer (the queue), oldest first' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: ImportLinePageDto })
  async queue(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<ImportLinePageDto> {
    const parsed = parseListQuery<ImportLineSortField>(query, QUEUE_SORT, {});
    return this.tenantDb.run(ctx, (tx) => this.imports.queue(tx, parsed));
  }

  @Post('payments/import-lines/:lineId/match')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'Match a queued line to its payer (and lease): it becomes a cleared receipt' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ImportLineDto })
  async match(@Tenant() ctx: TenantContext, @Param('lineId', UUID_PARAM) id: string, @Body() body: MatchLineBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<ImportLineDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.imports.match(tx, ctx, id, version, body.payerContactId, body.leaseId ?? null)));
  }

  // ----------------------------------------------------------------- receipts

  @Get('payments')
  @RequirePermission('rent.view')
  @ApiOperation({ summary: 'Receipts in your scope; this month unless a date, lease, payer or unallocated filter is given' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['receivedOn', '-receivedOn', 'instrumentDate', '-instrumentDate'] })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[methodCode]', required: false })
  @ApiQuery({ name: 'filter[leaseId]', required: false })
  @ApiQuery({ name: 'filter[payerContactId]', required: false })
  @ApiQuery({ name: 'filter[bankAccountId]', required: false })
  @ApiQuery({ name: 'filter[currency]', required: false })
  @ApiQuery({ name: 'filter[unallocated]', required: false, description: 'Cleared receipts with money not yet allocated (RP-5)' })
  @ApiQuery({ name: 'filter[receivedOn][gte]', required: false })
  @ApiQuery({ name: 'filter[receivedOn][lte]', required: false })
  @ApiQuery({ name: 'filter[instrumentDate][gte]', required: false })
  @ApiQuery({ name: 'filter[instrumentDate][lte]', required: false, description: 'Post-dated cheques due by this day (RP-6)' })
  @ApiOkResponse({ type: PaymentPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<PaymentPageDto> {
    const parsed = parseListQuery<PaymentSortField>(query, SORT, FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.receipts.list(tx, ctx, parsed));
  }

  @Post('payments')
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'Record a receipt; a cheque dated after today stays pending until cleared. Send an Idempotency-Key: a repeated submit returns the first receipt' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: PaymentDto })
  async record(
    @Tenant() ctx: TenantContext,
    @Body() body: RecordPaymentBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.receipts.record(tx, ctx, body),
      })),
    );
    res.status(result.status).location(`/api/v1/payments/${result.body.id}`);
    return withEtag(res, result.body);
  }

  @Get('payments/:paymentId')
  @RequirePermission('rent.view')
  @ApiOkResponse({ type: PaymentDto })
  async get(@Tenant() ctx: TenantContext, @Param('paymentId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<PaymentDto> {
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.receipts.get(tx, ctx, id)));
  }

  @Post('payments/:paymentId/clear')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'A pending cheque has cleared' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PaymentDto })
  async clear(@Tenant() ctx: TenantContext, @Param('paymentId', UUID_PARAM) id: string, @Body() body: ClearPaymentBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<PaymentDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.receipts.clear(tx, ctx, id, version, body.valueDate)));
  }

  @Post('payments/:paymentId/bounce')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'A cheque bounced: its allocations are reversed and the rent is owed again' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: UnwindResultDto })
  async bounce(@Tenant() ctx: TenantContext, @Param('paymentId', UUID_PARAM) id: string, @Body() body: UnwindPaymentBody, @Headers('if-match') ifMatch: string | undefined): Promise<UnwindResultDto> {
    const version = requireIfMatch(ifMatch);
    return this.tenantDb.run(ctx, (tx) => this.receipts.unwind(tx, ctx, id, version, 'bounce', body.reason, body.on));
  }

  @Post('payments/:paymentId/refund')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'Refund a cleared receipt: its allocations are reversed first' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: UnwindResultDto })
  async refund(@Tenant() ctx: TenantContext, @Param('paymentId', UUID_PARAM) id: string, @Body() body: UnwindPaymentBody, @Headers('if-match') ifMatch: string | undefined): Promise<UnwindResultDto> {
    const version = requireIfMatch(ifMatch);
    return this.tenantDb.run(ctx, (tx) => this.receipts.unwind(tx, ctx, id, version, 'refund', body.reason, body.on));
  }

  @Post('payments/:paymentId/void')
  @HttpCode(200)
  @RequirePermission('payment.record')
  @ApiOperation({ summary: 'Void a receipt entered in error: its allocations are reversed first' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: UnwindResultDto })
  async void(@Tenant() ctx: TenantContext, @Param('paymentId', UUID_PARAM) id: string, @Body() body: UnwindPaymentBody, @Headers('if-match') ifMatch: string | undefined): Promise<UnwindResultDto> {
    const version = requireIfMatch(ifMatch);
    return this.tenantDb.run(ctx, (tx) => this.receipts.unwind(tx, ctx, id, version, 'void', body.reason, body.on));
  }

  @Get('payments/:paymentId/allocations')
  @RequirePermission('rent.view')
  @ApiOperation({ summary: 'The receipt, its allocations and the oldest-first suggestion (not applied, P7-D8)' })
  @ApiOkResponse({ type: AllocationViewDto })
  async allocations(@Tenant() ctx: TenantContext, @Param('paymentId', UUID_PARAM) id: string): Promise<AllocationViewDto> {
    return this.tenantDb.run(ctx, (tx) => this.receipts.allocationView(tx, ctx, id));
  }

  @Post('payments/:paymentId/allocations')
  @RequirePermission('payment.allocate')
  @ApiOperation({ summary: 'Allocate the receipt to charges, all lines in one transaction' })
  @ApiCreatedResponse({ type: AllocationViewDto })
  async allocate(@Tenant() ctx: TenantContext, @Param('paymentId', UUID_PARAM) id: string, @Body() body: AllocateBody): Promise<AllocationViewDto> {
    return this.tenantDb.run(ctx, (tx) => this.receipts.allocate(tx, ctx, id, body));
  }

  @Post('payments/:paymentId/allocations/:allocationId/reverse')
  @HttpCode(200)
  @RequirePermission('payment.allocate')
  @ApiOperation({ summary: 'Reverse one allocation: the charge is owed again and the money unallocated' })
  @ApiOkResponse({ type: AllocationViewDto })
  async reverse(@Tenant() ctx: TenantContext, @Param('paymentId', UUID_PARAM) id: string, @Param('allocationId', UUID_PARAM) allocationId: string, @Body() body: ReverseAllocationBody): Promise<AllocationViewDto> {
    return this.tenantDb.run(ctx, (tx) => this.receipts.reverseAllocation(tx, ctx, id, allocationId, body.on));
  }
}

function withEtag<T extends { version: number }>(res: Response, body: T): T {
  setVersionEtag(res, body.version);
  return body;
}
