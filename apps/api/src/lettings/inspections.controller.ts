import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import {
  CancelInspectionBody,
  CompleteInspectionBody,
  INSPECTION_STATUSES,
  INSPECTION_TYPES,
  InspectionDto,
  InspectionItemsBody,
  InspectionPageDto,
  InspectionPhotoBody,
  ScheduleInspectionBody,
  TenantAcknowledgementBody,
  UpdateInspectionBody,
} from './inspections.dto.js';
import { type InspectionSortField, InspectionsService } from './inspections.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SORT = { allowed: { scheduledAt: 'timestamp', completedAt: 'timestamp' }, default: { field: 'scheduledAt', direction: 'desc' } } as const satisfies SortSpec<InspectionSortField>;
const FILTERS: FilterSpec = {
  status: { type: 'enum', values: INSPECTION_STATUSES, multi: true },
  inspectionType: { type: 'enum', values: INSPECTION_TYPES, multi: true },
  propertyId: { type: 'uuid', multi: true },
  unitId: { type: 'uuid', multi: true },
  leaseId: { type: 'uuid', multi: true },
  inspectorId: { type: 'uuid', multi: true },
  officeId: { type: 'uuid', multi: true },
  scheduledAt: { type: 'range', pattern: DATE },
};

/** Inspections: scheduling, recording items and photos, completion and the tenant's acknowledgement (Phase 7 L4; LET-09; IN-1 to IN-3; W7-S1). */
@ApiTags('Inspections')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class InspectionsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly inspections: InspectionsService,
  ) {}

  @Get('inspections')
  @RequirePermission('inspection.view')
  @ApiOperation({ summary: 'Inspections in your scope; latest scheduled first' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['scheduledAt', '-scheduledAt', 'completedAt', '-completedAt'] })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[inspectionType]', required: false })
  @ApiQuery({ name: 'filter[propertyId]', required: false })
  @ApiQuery({ name: 'filter[unitId]', required: false })
  @ApiQuery({ name: 'filter[leaseId]', required: false })
  @ApiQuery({ name: 'filter[inspectorId]', required: false })
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiQuery({ name: 'filter[scheduledAt][gte]', required: false, description: "A date, in the property's time zone" })
  @ApiQuery({ name: 'filter[scheduledAt][lte]', required: false })
  @ApiOkResponse({ type: InspectionPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<InspectionPageDto> {
    const parsed = parseListQuery<InspectionSortField>(query, SORT, FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.inspections.list(tx, ctx, parsed));
  }

  @Post('inspections')
  @RequirePermission('inspection.manage')
  @ApiOperation({ summary: "Schedule an inspection; items come from the unit's last completed inspection" })
  @ApiCreatedResponse({ type: InspectionDto })
  async schedule(@Tenant() ctx: TenantContext, @Body() body: ScheduleInspectionBody, @Res({ passthrough: true }) res: Response): Promise<InspectionDto> {
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.inspections.schedule(tx, ctx, body)));
  }

  @Get('inspections/:inspectionId')
  @RequirePermission('inspection.view')
  @ApiOkResponse({ type: InspectionDto })
  async get(@Tenant() ctx: TenantContext, @Param('inspectionId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<InspectionDto> {
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.inspections.get(tx, ctx, id)));
  }

  @Patch('inspections/:inspectionId')
  @RequirePermission('inspection.manage')
  @ApiOperation({ summary: 'Start it, reschedule or reassign it (while scheduled), record the overall condition and summary' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: InspectionDto })
  async update(@Tenant() ctx: TenantContext, @Param('inspectionId', UUID_PARAM) id: string, @Body() body: UpdateInspectionBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<InspectionDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.inspections.update(tx, ctx, id, version, body)));
  }

  @Put('inspections/:inspectionId/items')
  @RequirePermission('inspection.manage')
  @ApiOperation({ summary: 'Save the items, in order (items left out are removed)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: InspectionDto })
  async saveItems(@Tenant() ctx: TenantContext, @Param('inspectionId', UUID_PARAM) id: string, @Body() body: InspectionItemsBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<InspectionDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.inspections.saveItems(tx, ctx, id, version, body)));
  }

  @Post('inspections/:inspectionId/items/:itemId/photos')
  @HttpCode(200)
  @RequirePermission('inspection.manage')
  @ApiOperation({ summary: 'Link a photo uploaded to the inspection to one of its items (W7-S1)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: InspectionDto })
  async addPhoto(
    @Tenant() ctx: TenantContext,
    @Param('inspectionId', UUID_PARAM) id: string,
    @Param('itemId', UUID_PARAM) itemId: string,
    @Body() body: InspectionPhotoBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InspectionDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.inspections.addPhoto(tx, ctx, id, itemId, version, body)));
  }

  @Delete('inspections/:inspectionId/items/:itemId/photos/:documentId')
  @RequirePermission('inspection.manage')
  @ApiOperation({ summary: 'Unlink a photo from an item (the document stays with the inspection)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: InspectionDto })
  async removePhoto(
    @Tenant() ctx: TenantContext,
    @Param('inspectionId', UUID_PARAM) id: string,
    @Param('itemId', UUID_PARAM) itemId: string,
    @Param('documentId', UUID_PARAM) documentId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InspectionDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.inspections.removePhoto(tx, ctx, id, itemId, documentId, version)));
  }

  @Post('inspections/:inspectionId/complete')
  @HttpCode(200)
  @RequirePermission('inspection.manage')
  @ApiOperation({ summary: 'Complete: the overall condition and every item recorded, every photo scanned clean' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: InspectionDto })
  async complete(@Tenant() ctx: TenantContext, @Param('inspectionId', UUID_PARAM) id: string, @Body() body: CompleteInspectionBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<InspectionDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.inspections.complete(tx, ctx, id, version, body)));
  }

  @Post('inspections/:inspectionId/tenant-signed')
  @HttpCode(200)
  @RequirePermission('inspection.manage')
  @ApiOperation({ summary: "Record the tenant's acknowledgement of a completed inspection (once)" })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: InspectionDto })
  async acknowledge(@Tenant() ctx: TenantContext, @Param('inspectionId', UUID_PARAM) id: string, @Body() body: TenantAcknowledgementBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<InspectionDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.inspections.acknowledge(tx, ctx, id, version, body)));
  }

  @Post('inspections/:inspectionId/cancel')
  @HttpCode(200)
  @RequirePermission('inspection.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: InspectionDto })
  async cancel(@Tenant() ctx: TenantContext, @Param('inspectionId', UUID_PARAM) id: string, @Body() body: CancelInspectionBody, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: Response): Promise<InspectionDto> {
    const version = requireIfMatch(ifMatch);
    return withEtag(res, await this.tenantDb.run(ctx, (tx) => this.inspections.cancel(tx, ctx, id, version, body)));
  }
}

function withEtag<T extends { version: number }>(res: Response, body: T): T {
  setVersionEtag(res, body.version);
  return body;
}
