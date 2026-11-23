import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { ProblemError, Problems } from '../common/problem.js';
import type { EstateProRequest, TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { CreateDocumentUploadBody, DocumentDownloadDto, DocumentDto, DocumentListDto, DocumentUploadTicketDto } from './documents.dto.js';
import { DocumentsService } from './documents.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/** Documents for leases and management agreements (Phase 7 L1, W7-A1). */
@ApiTags('Documents')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class DocumentsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly documents: DocumentsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('documents/uploads')
  @RequirePermission('document.upload')
  @ApiOperation({ summary: 'Start a document upload for a lease or agreement; PUT the file to uploadUrl, then confirm' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: DocumentUploadTicketDto })
  async createUpload(
    @Tenant() ctx: TenantContext,
    @Body() body: CreateDocumentUploadBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentUploadTicketDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.documents.createUpload(tx, ctx, body),
      })),
    );
    res.status(result.status);
    return result.body;
  }

  @Post('documents/uploads/:uploadId/confirm')
  @RequirePermission('document.upload')
  @ApiOperation({ summary: 'Confirm the uploaded file: the document is recorded and its security scan queued (scanStatus "pending")' })
  @ApiCreatedResponse({ type: DocumentDto })
  async confirmUpload(@Tenant() ctx: TenantContext, @Param('uploadId', UUID_PARAM) uploadId: string, @Res({ passthrough: true }) res: Response): Promise<DocumentDto> {
    const document = await this.tenantDb.run(ctx, (tx) => this.documents.confirmUpload(tx, ctx, uploadId));
    if (document instanceof ProblemError) throw document;
    res.status(201).location(`/api/v1/documents/${document.id}`);
    return document;
  }

  @Get('documents/:documentId')
  @RequirePermission('document.view')
  @ApiOkResponse({ type: DocumentDto })
  async get(@Tenant() ctx: TenantContext, @Param('documentId', UUID_PARAM) id: string): Promise<DocumentDto> {
    return this.tenantDb.run(ctx, (tx) => this.documents.get(tx, ctx, id));
  }

  @Post('documents/:documentId/download')
  @RequirePermission('document.view')
  @ApiOperation({ summary: 'A short-lived link to a clean document (the download is audited)' })
  @ApiCreatedResponse({ type: DocumentDownloadDto })
  async download(@Tenant() ctx: TenantContext, @Param('documentId', UUID_PARAM) id: string): Promise<DocumentDownloadDto> {
    return this.tenantDb.run(ctx, (tx) => this.documents.download(tx, ctx, id));
  }

  @Get('leases/:leaseId/documents')
  @RequirePermission('document.view')
  @ApiTags('Leases')
  @ApiOkResponse({ type: DocumentListDto })
  async forLease(@Tenant() ctx: TenantContext, @Param('leaseId', UUID_PARAM) id: string): Promise<DocumentListDto> {
    return { data: await this.tenantDb.run(ctx, (tx) => this.documents.listFor(tx, ctx, 'lease', id)) };
  }

  @Get('management-agreements/:agreementId/documents')
  @RequirePermission('document.view')
  @ApiTags('Management agreements')
  @ApiOkResponse({ type: DocumentListDto })
  async forAgreement(@Tenant() ctx: TenantContext, @Param('agreementId', UUID_PARAM) id: string): Promise<DocumentListDto> {
    return { data: await this.tenantDb.run(ctx, (tx) => this.documents.listFor(tx, ctx, 'management_agreement', id)) };
  }

  @Get('inspections/:inspectionId/documents')
  @RequirePermission('document.view')
  @ApiTags('Inspections')
  @ApiOkResponse({ type: DocumentListDto })
  async forInspection(@Tenant() ctx: TenantContext, @Param('inspectionId', UUID_PARAM) id: string): Promise<DocumentListDto> {
    return { data: await this.tenantDb.run(ctx, (tx) => this.documents.listFor(tx, ctx, 'inspection', id)) };
  }
}
