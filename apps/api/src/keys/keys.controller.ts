import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { EstateProRequest, TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import {
  CheckOutBody,
  CreateKeySetBody,
  KEY_STATUSES,
  KeyMovementPageDto,
  KeyNoteBody,
  KeySetDto,
  KeySetPageDto,
  RetireKeySetBody,
  UpdateKeySetBody,
} from './dto.js';
import { type KeySetSortField, KeysService } from './keys.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

const KEY_SORT = {
  allowed: { label: 'text', updatedAt: 'timestamp', dueBackAt: 'timestamp' },
  default: { field: 'label', direction: 'asc' },
} as const satisfies SortSpec<KeySetSortField>;

const KEY_FILTERS: FilterSpec = {
  status: { type: 'enum', values: KEY_STATUSES, multi: true },
  overdue: { type: 'boolean' },
  propertyId: { type: 'uuid', multi: true },
  unitId: { type: 'uuid', multi: true },
  holderMembershipId: { type: 'uuid', multi: true },
  officeId: { type: 'uuid', multi: true },
};

@ApiTags('Key register')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class KeysController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly keys: KeysService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('key-sets')
  @RequirePermission('key.view')
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['label', '-label', 'updatedAt', '-updatedAt', 'dueBackAt', '-dueBackAt'] })
  @ApiQuery({ name: 'filter[status]', required: false, description: `${KEY_STATUSES.join(', ')} (default: all but retired)` })
  @ApiQuery({ name: 'filter[overdue]', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'filter[propertyId]', required: false })
  @ApiQuery({ name: 'filter[unitId]', required: false })
  @ApiQuery({ name: 'filter[holderMembershipId]', required: false })
  @ApiQuery({ name: 'filter[officeId]', required: false, description: "The property's office" })
  @ApiOkResponse({ type: KeySetPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<KeySetPageDto> {
    const parsed = parseListQuery<KeySetSortField>(query, KEY_SORT, KEY_FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.keys.list(tx, ctx, parsed, null));
  }

  @Get('properties/:propertyId/key-sets')
  @RequirePermission('key.view')
  @ApiOkResponse({ type: KeySetPageDto })
  async listForProperty(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) propertyId: string,
    @Query() query: ListQueryInput,
  ): Promise<KeySetPageDto> {
    const parsed = parseListQuery<KeySetSortField>(query, KEY_SORT, KEY_FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.keys.list(tx, ctx, parsed, propertyId));
  }

  @Post('properties/:propertyId/key-sets')
  @RequirePermission('key.manage')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: KeySetDto })
  async create(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) propertyId: string,
    @Body() body: CreateKeySetBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KeySetDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.keys.create(tx, ctx, propertyId, body),
      })),
    );
    res.status(result.status).location(`/api/v1/key-sets/${result.body.id}`);
    setVersionEtag(res, result.body.version);
    return result.body;
  }

  @Get('key-sets/:keySetId')
  @RequirePermission('key.view')
  @ApiOkResponse({ type: KeySetDto })
  async get(@Tenant() ctx: TenantContext, @Param('keySetId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<KeySetDto> {
    const keySet = await this.tenantDb.run(ctx, (tx) => this.keys.get(tx, ctx, id));
    setVersionEtag(res, keySet.version);
    return keySet;
  }

  @Patch('key-sets/:keySetId')
  @RequirePermission('key.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: KeySetDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('keySetId', UUID_PARAM) id: string,
    @Body() body: UpdateKeySetBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KeySetDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.keys.update(tx, ctx, id, expected, body)));
  }

  @Post('key-sets/:keySetId/check-out')
  @RequirePermission('key.issue')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: KeySetDto })
  async checkOut(
    @Tenant() ctx: TenantContext,
    @Param('keySetId', UUID_PARAM) id: string,
    @Body() body: CheckOutBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KeySetDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.keys.checkOut(tx, ctx, id, expected, body)));
  }

  @Post('key-sets/:keySetId/check-in')
  @RequirePermission('key.issue')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: KeySetDto })
  async checkIn(
    @Tenant() ctx: TenantContext,
    @Param('keySetId', UUID_PARAM) id: string,
    @Body() body: KeyNoteBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KeySetDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.keys.move(tx, ctx, id, expected, 'check_in', body.note ?? null)));
  }

  @Post('key-sets/:keySetId/report-lost')
  @RequirePermission('key.issue')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: KeySetDto })
  async reportLost(
    @Tenant() ctx: TenantContext,
    @Param('keySetId', UUID_PARAM) id: string,
    @Body() body: KeyNoteBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KeySetDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.keys.move(tx, ctx, id, expected, 'lost', body.note ?? null)));
  }

  @Post('key-sets/:keySetId/found')
  @RequirePermission('key.issue')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: KeySetDto })
  async found(
    @Tenant() ctx: TenantContext,
    @Param('keySetId', UUID_PARAM) id: string,
    @Body() body: KeyNoteBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KeySetDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.keys.move(tx, ctx, id, expected, 'found', body.note ?? null)));
  }

  @Post('key-sets/:keySetId/retire')
  @RequirePermission('key.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: KeySetDto })
  async retire(
    @Tenant() ctx: TenantContext,
    @Param('keySetId', UUID_PARAM) id: string,
    @Body() body: RetireKeySetBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KeySetDto> {
    const expected = requireIfMatch(ifMatch);
    return this.respond(res, await this.tenantDb.run(ctx, (tx) => this.keys.retire(tx, ctx, id, expected, body.reason)));
  }

  @Get('key-sets/:keySetId/movements')
  @RequirePermission('key.view')
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: KeyMovementPageDto })
  async movements(@Tenant() ctx: TenantContext, @Param('keySetId', UUID_PARAM) id: string, @Query() query: ListQueryInput): Promise<KeyMovementPageDto> {
    const parsed = parseListQuery<'occurredAt'>(query, { allowed: { occurredAt: 'timestamp' }, default: { field: 'occurredAt', direction: 'desc' } }, {});
    return this.tenantDb.run(ctx, (tx) => this.keys.movements(tx, ctx, id, parsed));
  }

  private respond(res: Response, keySet: KeySetDto): KeySetDto {
    res.status(200);
    setVersionEtag(res, keySet.version);
    return keySet;
  }
}
