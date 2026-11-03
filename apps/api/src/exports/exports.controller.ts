import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { ContactExportBody, ExportDownloadDto, ExportJobDto, LeadExportBody } from './dto.js';
import { ExportsService } from './exports.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/** Contact and lead exports (Phase 5 milestone C4, CA-16): purpose stated, scoped, audited, expiring. */
@ApiTags('Exports')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class ExportsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly exports: ExportsService,
  ) {}

  @Post('contacts/exports')
  @RequirePermission('contact.export')
  @ApiOperation({ summary: 'Export contacts in your scope as CSV (no protected details, notes or messages)' })
  @ApiCreatedResponse({ type: ExportJobDto })
  async contacts(@Tenant() ctx: TenantContext, @Body() body: ContactExportBody, @Res({ passthrough: true }) res: Response): Promise<ExportJobDto> {
    const job = await this.tenantDb.run(ctx, (tx) => this.exports.exportContacts(tx, ctx, body));
    res.location(`/api/v1/exports/${job.id}`);
    return job;
  }

  @Post('leads/exports')
  @RequirePermission('lead.export')
  @ApiOperation({ summary: 'Export leads in your scope as CSV (no enquiry messages)' })
  @ApiCreatedResponse({ type: ExportJobDto })
  async leads(@Tenant() ctx: TenantContext, @Body() body: LeadExportBody, @Res({ passthrough: true }) res: Response): Promise<ExportJobDto> {
    const job = await this.tenantDb.run(ctx, (tx) => this.exports.exportLeads(tx, ctx, body));
    res.location(`/api/v1/exports/${job.id}`);
    return job;
  }

  @Get('exports')
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Your exports (members who manage users see all)' })
  @ApiOkResponse({ type: [ExportJobDto] })
  async list(@Tenant() ctx: TenantContext): Promise<ExportJobDto[]> {
    return this.tenantDb.run(ctx, (tx) => this.exports.list(tx, ctx));
  }

  @Get('exports/:exportId')
  @RequirePermission('contact.view')
  @ApiOkResponse({ type: ExportJobDto })
  async get(@Tenant() ctx: TenantContext, @Param('exportId', UUID_PARAM) id: string): Promise<ExportJobDto> {
    return this.tenantDb.run(ctx, (tx) => this.exports.get(tx, ctx, id));
  }

  @Post('exports/:exportId/download')
  @HttpCode(200)
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'A five-minute download link for your export (audited)' })
  @ApiOkResponse({ type: ExportDownloadDto })
  async download(@Tenant() ctx: TenantContext, @Param('exportId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<ExportDownloadDto> {
    res.setHeader('Cache-Control', 'no-store');
    return this.tenantDb.run(ctx, (tx) => this.exports.download(tx, ctx, id));
  }
}
