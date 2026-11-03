import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { type FilterSpec, type ListQueryInput, parseListQuery, type RangeValue, type SortSpec } from '../common/list-query.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { CancelTaskBody, CreateTaskBody, PRIORITIES, ReassignTaskBody, TASK_ENTITY_TYPES, TASK_STATUSES, TaskDto, TaskPageDto, UpdateTaskBody } from './tasks.dto.js';
import { TasksService } from './tasks.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });
const DATE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;

const TASK_SORT = { allowed: { dueAt: 'timestamp' }, default: { field: 'dueAt', direction: 'asc' } } as const satisfies SortSpec<'dueAt'>;
const TASK_FILTERS: FilterSpec = {
  view: { type: 'enum', values: ['mine', 'team'] },
  status: { type: 'enum', values: TASK_STATUSES, multi: true },
  overdue: { type: 'boolean' },
  reminderDue: { type: 'boolean' },
  dueAt: { type: 'range', pattern: DATE_TIME },
  priority: { type: 'enum', values: PRIORITIES, multi: true },
  assignedTo: { type: 'uuid', multi: true },
  entityType: { type: 'enum', values: TASK_ENTITY_TYPES },
  entityId: { type: 'uuid' },
};

/** Follow-ups (Phase 5 milestone C3; wireframes F-1, F-2; decision D6). */
@ApiTags('Follow-ups')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/tasks')
export class TasksController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly tasks: TasksService,
  ) {}

  @Get()
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Follow-ups: Mine (default) or Team (managers); open by default, soonest first' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: ['dueAt', '-dueAt'] })
  @ApiQuery({ name: 'filter[view]', required: false, enum: ['mine', 'team'] })
  @ApiQuery({ name: 'filter[status]', required: false, description: 'Default open' })
  @ApiQuery({ name: 'filter[overdue]', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'filter[reminderDue]', required: false, enum: ['true', 'false'], description: 'In-app reminders that are due' })
  @ApiQuery({ name: 'filter[dueAt][gte]', required: false, description: 'Today / this week boundaries, computed by the client in the office timezone' })
  @ApiQuery({ name: 'filter[dueAt][lte]', required: false })
  @ApiQuery({ name: 'filter[priority]', required: false })
  @ApiQuery({ name: 'filter[assignedTo]', required: false, description: 'Team view only' })
  @ApiQuery({ name: 'filter[entityType]', required: false, enum: TASK_ENTITY_TYPES })
  @ApiQuery({ name: 'filter[entityId]', required: false })
  @ApiOkResponse({ type: TaskPageDto })
  async list(@Tenant() ctx: TenantContext, @Query() query: ListQueryInput): Promise<TaskPageDto> {
    const parsed = parseListQuery<'dueAt'>(query, TASK_SORT, TASK_FILTERS);
    const f = parsed.filters;
    const view = Array.isArray(f['view']) ? (f['view'][0] as 'mine' | 'team') : 'mine';
    const entityType = Array.isArray(f['entityType']) ? f['entityType'][0] : undefined;
    const entityId = Array.isArray(f['entityId']) ? f['entityId'][0] : undefined;
    if ((entityType === undefined) !== (entityId === undefined)) {
      throw Problems.validation([{ field: 'filter[entityId]', code: 'pair', message: 'Give filter[entityType] and filter[entityId] together.' }]);
    }
    if (view === 'mine' && Array.isArray(f['assignedTo'])) {
      throw Problems.validation([{ field: 'filter[assignedTo]', code: 'team-only', message: 'Filter by assignee in the team view.' }]);
    }
    return this.tenantDb.run(ctx, (tx) =>
      this.tasks.list(tx, ctx, {
        view,
        limit: parsed.limit,
        cursor: parsed.cursor,
        direction: parsed.sort.direction,
        statuses: Array.isArray(f['status']) ? f['status'] : ['open'],
        overdue: typeof f['overdue'] === 'boolean' ? f['overdue'] : null,
        reminderDue: typeof f['reminderDue'] === 'boolean' ? f['reminderDue'] : null,
        due: (f['dueAt'] as RangeValue | undefined) ?? null,
        priorities: Array.isArray(f['priority']) ? f['priority'] : null,
        assignedTo: Array.isArray(f['assignedTo']) ? f['assignedTo'] : null,
        about: entityType && entityId ? { entityType, entityId } : null,
      }),
    );
  }

  @Post()
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Schedule a follow-up for yourself, or (managers) for someone in your team' })
  @ApiCreatedResponse({ type: TaskDto })
  async create(@Tenant() ctx: TenantContext, @Body() body: CreateTaskBody, @Res({ passthrough: true }) res: Response): Promise<TaskDto> {
    const task = await this.tenantDb.run(ctx, (tx) => this.tasks.create(tx, ctx, body));
    res.location(`/api/v1/tasks/${task.id}`);
    setVersionEtag(res, task.version);
    return task;
  }

  @Get(':taskId')
  @RequirePermission('contact.view')
  @ApiOkResponse({ type: TaskDto })
  async get(@Tenant() ctx: TenantContext, @Param('taskId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<TaskDto> {
    const task = await this.tenantDb.run(ctx, (tx) => this.tasks.get(tx, ctx, id));
    setVersionEtag(res, task.version);
    return task;
  }

  @Patch(':taskId')
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'Edit or reschedule an open follow-up' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: TaskDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('taskId', UUID_PARAM) id: string,
    @Body() body: UpdateTaskBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaskDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.tasks.update(tx, ctx, id, version, body)));
  }

  @Post(':taskId/assign')
  @HttpCode(200)
  @RequirePermission('lead.assign')
  @ApiOperation({ summary: 'Give the follow-up to someone in your team (D6)' })
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: TaskDto })
  async reassign(
    @Tenant() ctx: TenantContext,
    @Param('taskId', UUID_PARAM) id: string,
    @Body() body: ReassignTaskBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaskDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.tasks.reassign(tx, ctx, id, version, body.assignedTo)));
  }

  @Post(':taskId/complete')
  @HttpCode(200)
  @RequirePermission('contact.view')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: TaskDto })
  async complete(
    @Tenant() ctx: TenantContext,
    @Param('taskId', UUID_PARAM) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaskDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.tasks.complete(tx, ctx, id, version)));
  }

  @Post(':taskId/cancel')
  @HttpCode(200)
  @RequirePermission('contact.view')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: TaskDto })
  async cancel(
    @Tenant() ctx: TenantContext,
    @Param('taskId', UUID_PARAM) id: string,
    @Body() body: CancelTaskBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TaskDto> {
    const version = requireIfMatch(ifMatch);
    return this.withEtag(res, await this.tenantDb.run(ctx, (tx) => this.tasks.cancel(tx, ctx, id, version, body.reason)));
  }

  private withEtag(res: Response, task: TaskDto): TaskDto {
    setVersionEtag(res, task.version);
    return task;
  }
}
