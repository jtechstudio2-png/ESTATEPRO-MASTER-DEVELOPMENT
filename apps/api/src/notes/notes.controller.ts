import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type ListQueryInput, parseListQuery } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { EstateProRequest, TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import {
  ArchiveNoteBody,
  CreateNoteBody,
  NOTE_CATEGORIES,
  NOTE_VISIBILITIES,
  NoteDto,
  NotePageDto,
  NoteRevisionPageDto,
  RedactNoteBody,
  UpdateNoteBody,
} from './dto.js';
import { type NoteSortField, NotesService } from './notes.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

@ApiTags('Property notes')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class NotesController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly notes: NotesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('properties/:propertyId/notes')
  @RequirePermission('property_note.view')
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['createdAt', '-createdAt', 'updatedAt', '-updatedAt'] })
  @ApiQuery({ name: 'filter[pinned]', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'filter[unitId]', required: false })
  @ApiQuery({ name: 'filter[category]', required: false, description: NOTE_CATEGORIES.join(', ') })
  @ApiQuery({ name: 'filter[visibility]', required: false, description: NOTE_VISIBILITIES.join(', ') })
  @ApiQuery({ name: 'filter[authorId]', required: false, description: 'Membership ids' })
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'true', 'all'] })
  @ApiOkResponse({ type: NotePageDto })
  async list(@Tenant() ctx: TenantContext, @Param('propertyId', UUID_PARAM) propertyId: string, @Query() query: ListQueryInput): Promise<NotePageDto> {
    const parsed = parseListQuery<NoteSortField>(
      query,
      { allowed: { createdAt: 'timestamp', updatedAt: 'timestamp' }, default: { field: 'createdAt', direction: 'desc' } },
      {
        pinned: { type: 'boolean' },
        unitId: { type: 'uuid', multi: true },
        category: { type: 'enum', values: NOTE_CATEGORIES, multi: true },
        visibility: { type: 'enum', values: NOTE_VISIBILITIES, multi: true },
        authorId: { type: 'uuid', multi: true },
        archived: { type: 'archived' },
      },
    );
    return this.tenantDb.run(ctx, (tx) => this.notes.list(tx, ctx, propertyId, parsed));
  }

  @Post('properties/:propertyId/notes')
  @RequirePermission('property_note.create')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiCreatedResponse({ type: NoteDto })
  async create(
    @Tenant() ctx: TenantContext,
    @Param('propertyId', UUID_PARAM) propertyId: string,
    @Body() body: CreateNoteBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: EstateProRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NoteDto> {
    const result = await this.tenantDb.run(ctx, (tx) =>
      this.idempotency.run(tx, ctx, idempotencyKey, { method: 'POST', path: req.path, body: req.body as unknown }, async () => ({
        status: 201,
        body: await this.notes.create(tx, ctx, propertyId, body),
      })),
    );
    res.status(result.status).location(`/api/v1/property-notes/${result.body.id}`);
    setVersionEtag(res, result.body.version);
    return result.body;
  }

  @Get('property-notes/:noteId')
  @RequirePermission('property_note.view')
  @ApiOkResponse({ type: NoteDto })
  async get(@Tenant() ctx: TenantContext, @Param('noteId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<NoteDto> {
    const note = await this.tenantDb.run(ctx, (tx) => this.notes.get(tx, ctx, id));
    setVersionEtag(res, note.version);
    return note;
  }

  @Patch('property-notes/:noteId')
  @RequirePermission('property_note.create')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: NoteDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('noteId', UUID_PARAM) id: string,
    @Body() body: UpdateNoteBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NoteDto> {
    const expected = requireIfMatch(ifMatch);
    const note = await this.tenantDb.run(ctx, (tx) => this.notes.update(tx, ctx, id, expected, body));
    setVersionEtag(res, note.version);
    return note;
  }

  @Post('property-notes/:noteId/archive')
  @RequirePermission('property_note.create')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: NoteDto })
  async archive(
    @Tenant() ctx: TenantContext,
    @Param('noteId', UUID_PARAM) id: string,
    @Body() body: ArchiveNoteBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NoteDto> {
    const expected = requireIfMatch(ifMatch);
    const note = await this.tenantDb.run(ctx, (tx) => this.notes.archive(tx, ctx, id, expected, body.reason));
    res.status(200);
    setVersionEtag(res, note.version);
    return note;
  }

  @Post('property-notes/:noteId/restore')
  @RequirePermission('property_note.create')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: NoteDto })
  async restore(
    @Tenant() ctx: TenantContext,
    @Param('noteId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NoteDto> {
    const expected = requireIfMatch(ifMatch);
    const note = await this.tenantDb.run(ctx, (tx) => this.notes.restore(tx, ctx, id, expected));
    res.status(200);
    setVersionEtag(res, note.version);
    return note;
  }

  @Post('property-notes/:noteId/redact')
  @RequirePermission('property_note.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: NoteDto })
  async redact(
    @Tenant() ctx: TenantContext,
    @Param('noteId', UUID_PARAM) id: string,
    @Body() body: RedactNoteBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NoteDto> {
    const expected = requireIfMatch(ifMatch);
    const note = await this.tenantDb.run(ctx, (tx) => this.notes.redact(tx, ctx, id, expected, body.reason));
    res.status(200);
    setVersionEtag(res, note.version);
    return note;
  }

  @Get('property-notes/:noteId/revisions')
  @RequirePermission('property_note.view')
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })
  @ApiQuery({ name: 'before', required: false, description: 'Revisions older than this one' })
  @ApiOkResponse({ type: NoteRevisionPageDto })
  async revisions(
    @Tenant() ctx: TenantContext,
    @Param('noteId', UUID_PARAM) id: string,
    @Query('limit') limit: unknown,
    @Query('before') before: unknown,
  ): Promise<NoteRevisionPageDto> {
    const size = limit === undefined ? 50 : typeof limit === 'string' && /^\d{1,3}$/.test(limit) ? Number(limit) : NaN;
    const older = before === undefined ? null : typeof before === 'string' && /^\d{1,9}$/.test(before) ? Number(before) : NaN;
    if (!Number.isInteger(size) || size < 1 || size > 100) {
      throw Problems.validation([{ field: 'limit', code: 'range', message: 'Use a whole number from 1 to 100.' }]);
    }
    if (older !== null && !Number.isInteger(older)) {
      throw Problems.validation([{ field: 'before', code: 'invalid', message: 'Use a revision number.' }]);
    }
    return this.tenantDb.run(ctx, (tx) => this.notes.revisions(tx, ctx, id, size, older));
  }
}
