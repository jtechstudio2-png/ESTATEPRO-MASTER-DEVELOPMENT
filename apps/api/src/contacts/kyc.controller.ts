import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import {
  ApproveKycCheckBody,
  ArchiveIdentityDocumentBody,
  CreateIdentityDocumentBody,
  CreateKycCheckBody,
  IdentityDocumentDto,
  KycCheckDto,
  RejectKycCheckBody,
  UpdateIdentityDocumentBody,
  UpdateKycCheckBody,
} from './kyc.dto.js';
import { KycService } from './kyc.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/**
 * Identity documents and KYC checks of a contact (Phase 5 milestone C2;
 * wireframes C-5 and SE-1). Document numbers are never returned here: they
 * are revealed one at a time through POST …/identity-documents/{id}/reveal.
 */
@ApiTags('Contacts: identity and KYC')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/contacts/:contactId')
export class KycController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly kyc: KycService,
  ) {}

  // ------------------------------------------------------ identity documents

  @Get('identity-documents')
  @RequirePermission('kyc.view')
  @ApiOperation({ summary: 'Identity documents (masked: last characters only)' })
  @ApiQuery({ name: 'includeArchived', required: false, enum: ['true', 'false'] })
  @ApiOkResponse({ type: [IdentityDocumentDto] })
  async listDocuments(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Query('includeArchived') includeArchived: string | undefined,
  ): Promise<IdentityDocumentDto[]> {
    if (includeArchived !== undefined && includeArchived !== 'true' && includeArchived !== 'false') {
      throw Problems.validation([{ field: 'includeArchived', code: 'invalid', message: 'Use true or false.' }]);
    }
    return this.tenantDb.run(ctx, (tx) => this.kyc.listDocuments(tx, ctx, contactId, includeArchived === 'true'));
  }

  @Post('identity-documents')
  @RequirePermission('kyc.manage')
  @ApiOperation({ summary: 'Record an identity document. The number is encrypted; 409 possible-duplicates when another contact has it' })
  @ApiCreatedResponse({ type: IdentityDocumentDto })
  async addDocument(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Body() body: CreateIdentityDocumentBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IdentityDocumentDto> {
    const document = await this.tenantDb.run(ctx, (tx) => this.kyc.addDocument(tx, ctx, contactId, body));
    setVersionEtag(res, document.version);
    return document;
  }

  @Patch('identity-documents/:documentId')
  @RequirePermission('kyc.manage')
  @ApiOperation({ summary: 'Correct a document that is not yet verified' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: IdentityDocumentDto })
  async updateDocument(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('documentId', UUID_PARAM) documentId: string,
    @Body() body: UpdateIdentityDocumentBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IdentityDocumentDto> {
    const version = requireIfMatch(ifMatch);
    const document = await this.tenantDb.run(ctx, (tx) => this.kyc.updateDocument(tx, ctx, contactId, documentId, version, body));
    setVersionEtag(res, document.version);
    return document;
  }

  @Post('identity-documents/:documentId/archive')
  @HttpCode(200)
  @RequirePermission('kyc.manage')
  @ApiOperation({ summary: 'Archive a document (it is kept as evidence)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: IdentityDocumentDto })
  async archiveDocument(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('documentId', UUID_PARAM) documentId: string,
    @Body() body: ArchiveIdentityDocumentBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IdentityDocumentDto> {
    const version = requireIfMatch(ifMatch);
    const document = await this.tenantDb.run(ctx, (tx) => this.kyc.archiveDocument(tx, ctx, contactId, documentId, version, body.reason));
    setVersionEtag(res, document.version);
    return document;
  }

  // ------------------------------------------------------------- KYC checks

  @Get('kyc-checks')
  @RequirePermission('kyc.view')
  @ApiOkResponse({ type: [KycCheckDto] })
  async listChecks(@Tenant() ctx: TenantContext, @Param('contactId', UUID_PARAM) contactId: string): Promise<KycCheckDto[]> {
    return this.tenantDb.run(ctx, (tx) => this.kyc.listChecks(tx, ctx, contactId));
  }

  @Post('kyc-checks')
  @RequirePermission('kyc.manage')
  @ApiOperation({ summary: 'Record a KYC/AML check (identity, address, source of funds, sanctions/PEP, company ownership)' })
  @ApiCreatedResponse({ type: KycCheckDto })
  async recordCheck(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Body() body: CreateKycCheckBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KycCheckDto> {
    const check = await this.tenantDb.run(ctx, (tx) => this.kyc.recordCheck(tx, ctx, contactId, body));
    setVersionEtag(res, check.version);
    return check;
  }

  @Patch('kyc-checks/:checkId')
  @RequirePermission('kyc.manage')
  @ApiOperation({ summary: 'Update an open check (pending or in review)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: KycCheckDto })
  async updateCheck(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('checkId', UUID_PARAM) checkId: string,
    @Body() body: UpdateKycCheckBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KycCheckDto> {
    const version = requireIfMatch(ifMatch);
    const check = await this.tenantDb.run(ctx, (tx) => this.kyc.updateCheck(tx, ctx, contactId, checkId, version, body));
    setVersionEtag(res, check.version);
    return check;
  }

  @Post('kyc-checks/:checkId/approve')
  @HttpCode(200)
  @RequirePermission('kyc.approve')
  @ApiOperation({ summary: 'Sign a check off as verified, with a risk rating; a verified identity check also verifies its document' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: KycCheckDto })
  async approve(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('checkId', UUID_PARAM) checkId: string,
    @Body() body: ApproveKycCheckBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KycCheckDto> {
    const version = requireIfMatch(ifMatch);
    const check = await this.tenantDb.run(ctx, (tx) => this.kyc.approveCheck(tx, ctx, contactId, checkId, version, body));
    setVersionEtag(res, check.version);
    return check;
  }

  @Post('kyc-checks/:checkId/reject')
  @HttpCode(200)
  @RequirePermission('kyc.approve')
  @ApiOperation({ summary: 'Sign a check off as failed, with the reason' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: KycCheckDto })
  async reject(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('checkId', UUID_PARAM) checkId: string,
    @Body() body: RejectKycCheckBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KycCheckDto> {
    const version = requireIfMatch(ifMatch);
    const check = await this.tenantDb.run(ctx, (tx) => this.kyc.rejectCheck(tx, ctx, contactId, checkId, version, body));
    setVersionEtag(res, check.version);
    return check;
  }
}
