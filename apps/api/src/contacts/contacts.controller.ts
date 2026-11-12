import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Scope, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { EstateProRequest, PermissionScope, TenantContext } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { TenantDb } from '../database/database.module.js';
import { RateLimiter } from '../location/rate-limiter.js';
import { type ContactSortField, ContactsService } from './contacts.service.js';
import { DuplicatesService } from './duplicates.service.js';
import {
  AddMethodBody,
  AddRelationshipBody,
  ArchiveContactBody,
  ConsentHistoryDto,
  ConsentInput,
  ContactDto,
  ContactPageDto,
  CreateContactBody,
  DuplicateCheckBody,
  DuplicateCheckResultDto,
  EndRelationshipBody,
  MergeBody,
  MergePreviewDto,
  MergeResultDto,
  RELATIONSHIP_TYPES,
  UpdateContactBody,
  UpdateMethodBody,
} from './dto.js';
import { MergeService } from './merge.service.js';

const CONTACT_SORT = {
  allowed: { displayName: 'text', createdAt: 'timestamp', updatedAt: 'timestamp' },
  default: { field: 'updatedAt', direction: 'desc' },
} as const satisfies SortSpec<ContactSortField>;

const CONTACT_FILTERS: FilterSpec = {
  relationship: { type: 'enum', values: RELATIONSHIP_TYPES, multi: true },
  contactType: { type: 'enum', values: ['person', 'organisation'], multi: true },
  officeId: { type: 'uuid', multi: true },
  ownerMembershipId: { type: 'uuid', multi: true },
  sourceCode: { type: 'code', pattern: /^[a-z][a-z0-9_]*$/, multi: true },
  archived: { type: 'archived' },
};

/** Malformed ids are answered like unknown ids (404). */
const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/** Contacts (Phase 5 milestone C1; wireframes C-1 to C-6). */
@ApiTags('Contacts')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/contacts')
export class ContactsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly contacts: ContactsService,
    private readonly duplicates: DuplicatesService,
    private readonly merges: MergeService,
    private readonly idempotency: IdempotencyService,
    private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Contact register; Buyers, Sellers, Landlords and Tenants are filter[relationship] views' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['displayName', '-displayName', 'createdAt', '-createdAt', 'updatedAt', '-updatedAt'] })
  @ApiQuery({ name: 'q', required: false, description: 'Name (any script), reference, email or phone number in any format' })
  @ApiQuery({ name: 'filter[relationship]', required: false, description: `Comma-separated: ${RELATIONSHIP_TYPES.join(', ')}` })
  @ApiQuery({ name: 'filter[contactType]', required: false, description: 'person, organisation' })
  @ApiQuery({ name: 'filter[officeId]', required: false })
  @ApiQuery({ name: 'filter[ownerMembershipId]', required: false })
  @ApiQuery({ name: 'filter[sourceCode]', required: false })
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'true', 'all'] })
  @ApiOkResponse({ type: ContactPageDto })
  async list(@Tenant() ctx: TenantContext, @Scope() scope: PermissionScope, @Query() query: ListQueryInput): Promise<ContactPageDto> {
    const parsed = parseListQuery<ContactSortField>(query, CONTACT_SORT, CONTACT_FILTERS);
    return this.tenantDb.run(ctx, (tx) => this.contacts.list(tx, ctx, scope, parsed));
  }

  @Post()
  @RequirePermission('contact.create')
  @ApiOperation({ summary: 'Create a contact. Answers 409 possible-duplicates unless confirmNotDuplicate is true' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: ContactDto })
  async create(
    @Tenant() ctx: TenantContext,
    @Scope() scope: PermissionScope,
    @Body() body: CreateContactBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.contacts.create(tx, ctx, scope, body),
      })),
    );
    res.status(result.status).location(`/api/v1/contacts/${result.body.id}`);
    setVersionEtag(res, result.body.version);
    return result.body;
  }

  @Post('duplicate-check')
  @HttpCode(200)
  @RequirePermission('contact.create')
  @ApiOperation({ summary: 'Find contacts with the same email, phone or tax number (rate-limited; audited without values)' })
  @ApiOkResponse({ type: DuplicateCheckResultDto })
  async duplicateCheck(@Tenant() ctx: TenantContext, @Body() body: DuplicateCheckBody): Promise<DuplicateCheckResultDto> {
    this.limiter.take(`contact-duplicates:${ctx.membershipId}`, this.config.DUPLICATE_CHECK_RATE_LIMIT_PER_MINUTE);
    const candidates = await this.tenantDb.run(ctx, (tx) => this.duplicates.check(tx, ctx, body));
    return { candidates };
  }

  @Get(':contactId')
  @RequirePermission('contact.view')
  @ApiOkResponse({ type: ContactDto })
  async get(@Tenant() ctx: TenantContext, @Param('contactId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<ContactDto> {
    const contact = await this.tenantDb.run(ctx, (tx) => this.contacts.get(tx, ctx, id));
    setVersionEtag(res, contact.version);
    return contact;
  }

  @Patch(':contactId')
  @RequirePermission('contact.update')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ContactDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Body() body: UpdateContactBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const expected = requireIfMatch(ifMatch);
    const contact = await this.tenantDb.run(ctx, (tx) => this.contacts.update(tx, ctx, id, expected, body));
    setVersionEtag(res, contact.version);
    return contact;
  }

  @Post(':contactId/archive')
  @HttpCode(200)
  @RequirePermission('contact.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ContactDto })
  async archive(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Body() body: ArchiveContactBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const expected = requireIfMatch(ifMatch);
    const contact = await this.tenantDb.run(ctx, (tx) => this.contacts.archive(tx, ctx, id, expected, body.reason));
    setVersionEtag(res, contact.version);
    return contact;
  }

  @Post(':contactId/restore')
  @HttpCode(200)
  @RequirePermission('contact.archive')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: ContactDto })
  async restore(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const expected = requireIfMatch(ifMatch);
    const contact = await this.tenantDb.run(ctx, (tx) => this.contacts.restore(tx, ctx, id, expected));
    setVersionEtag(res, contact.version);
    return contact;
  }

  // ----------------------------------------------------------------- methods

  @Post(':contactId/methods')
  @RequirePermission('contact.update')
  @ApiCreatedResponse({ type: ContactDto })
  async addMethod(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Body() body: AddMethodBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const contact = await this.tenantDb.run(ctx, (tx) => this.contacts.addMethod(tx, ctx, id, body));
    setVersionEtag(res, contact.version);
    return contact;
  }

  @Patch(':contactId/methods/:methodId')
  @RequirePermission('contact.update')
  @ApiOkResponse({ type: ContactDto })
  async updateMethod(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Param('methodId', UUID_PARAM) methodId: string,
    @Body() body: UpdateMethodBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const contact = await this.tenantDb.run(ctx, (tx) => this.contacts.updateMethod(tx, ctx, id, methodId, body));
    setVersionEtag(res, contact.version);
    return contact;
  }

  @Delete(':contactId/methods/:methodId')
  @RequirePermission('contact.update')
  @ApiOkResponse({ type: ContactDto })
  async removeMethod(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Param('methodId', UUID_PARAM) methodId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const contact = await this.tenantDb.run(ctx, (tx) => this.contacts.removeMethod(tx, ctx, id, methodId));
    setVersionEtag(res, contact.version);
    return contact;
  }

  // ------------------------------------------------------------ relationships

  @Post(':contactId/relationships')
  @RequirePermission('contact.update')
  @ApiCreatedResponse({ type: ContactDto })
  async addRelationship(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Body() body: AddRelationshipBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const contact = await this.tenantDb.run(ctx, (tx) => this.contacts.addRelationship(tx, ctx, id, body));
    setVersionEtag(res, contact.version);
    return contact;
  }

  @Post(':contactId/relationships/:relationshipId/end')
  @HttpCode(200)
  @RequirePermission('contact.update')
  @ApiOkResponse({ type: ContactDto })
  async endRelationship(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Param('relationshipId', UUID_PARAM) relationshipId: string,
    @Body() body: EndRelationshipBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContactDto> {
    const contact = await this.tenantDb.run(ctx, (tx) => this.contacts.endRelationship(tx, ctx, id, relationshipId, body));
    setVersionEtag(res, contact.version);
    return contact;
  }

  // ------------------------------------------------------------------ consent

  @Get(':contactId/consents')
  @RequirePermission('contact.view')
  @ApiOkResponse({ type: ConsentHistoryDto })
  async consents(@Tenant() ctx: TenantContext, @Param('contactId', UUID_PARAM) id: string): Promise<ConsentHistoryDto> {
    return { data: await this.tenantDb.run(ctx, (tx) => this.contacts.consentHistory(tx, ctx, id)) };
  }

  @Post(':contactId/consents')
  @RequirePermission('contact.update')
  @ApiOperation({ summary: 'Record a consent or a withdrawal (append-only)' })
  @ApiCreatedResponse({ type: ConsentHistoryDto })
  async recordConsent(@Tenant() ctx: TenantContext, @Param('contactId', UUID_PARAM) id: string, @Body() body: ConsentInput): Promise<ConsentHistoryDto> {
    return { data: await this.tenantDb.run(ctx, (tx) => this.contacts.recordConsent(tx, ctx, id, body)) };
  }

  // -------------------------------------------------------------------- merge

  @Get(':contactId/merge-preview')
  @RequirePermission('contact.merge')
  @ApiQuery({ name: 'mergeContactId', required: true, description: 'The contact that would be merged into this one' })
  @ApiOkResponse({ type: MergePreviewDto })
  async mergePreview(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Query('mergeContactId', UUID_PARAM) mergeContactId: string,
  ): Promise<MergePreviewDto> {
    return this.tenantDb.run(ctx, (tx) => this.merges.preview(tx, ctx, id, mergeContactId));
  }

  @Post(':contactId/merge')
  @HttpCode(200)
  @RequirePermission('contact.merge')
  @ApiOperation({ summary: 'Merge another contact into this one (explicit; cannot be undone)' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'Version of the contact to keep' })
  @ApiOkResponse({ type: MergeResultDto })
  async merge(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) id: string,
    @Body() body: MergeBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MergeResultDto> {
    const expected = requireIfMatch(ifMatch);
    const result = await this.tenantDb.run(ctx, (tx) => this.merges.merge(tx, ctx, id, expected, body));
    setVersionEtag(res, result.contact.version);
    return result;
  }
}
