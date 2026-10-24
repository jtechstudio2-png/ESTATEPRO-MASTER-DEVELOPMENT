import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Response } from 'express';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { RequirePermission, Tenant } from '../auth/decorators.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { requireIfMatch, setVersionEtag } from '../common/http.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb, type Tx } from '../database/database.module.js';
import { preferredLocales } from '../reference/picklists.js';

registerConstraintMessages({
  property_types_company_id_code_country_code_key: 'A property type with this code already exists for this country.',
});

const USAGE_CLASSES = ['residential', 'commercial', 'industrial', 'land', 'mixed_use', 'hospitality', 'agricultural', 'other'] as const;
const APPLIES_TO = ['property', 'unit', 'both'] as const;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class PropertyTypeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) parentId!: string | null;
  @ApiProperty() code!: string;
  @ApiProperty({ description: 'Name in the best matching Accept-Language, else the default name' }) name!: string;
  @ApiProperty({ enum: USAGE_CLASSES }) usageClass!: string;
  @ApiProperty({ enum: APPLIES_TO }) appliesTo!: string;
  @ApiProperty({ type: String, nullable: true, description: 'NULL = all countries' }) countryCode!: string | null;
  @ApiProperty({ description: 'false = platform default (read-only); true = this company’s own type' }) isCompanyDefined!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() version!: number;
}

class PropertyTypeListDto {
  @ApiProperty({ type: [PropertyTypeDto] }) data!: PropertyTypeDto[];
}

export class CreatePropertyTypeBody {
  @ApiProperty({ example: 'shop_with_flat' }) @Matches(/^[a-z0-9][a-z0-9_]{1,62}$/) code!: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @ApiProperty({ enum: USAGE_CLASSES }) @IsIn(USAGE_CLASSES) usageClass!: string;
  @ApiProperty({ enum: APPLIES_TO }) @IsIn(APPLIES_TO) appliesTo!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() parentId?: string;
  @ApiPropertyOptional({ description: 'Limit to one country; omit for all countries' })
  @IsOptional()
  @Matches(/^[A-Z]{2}$/)
  countryCode?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 10000 }) @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
}

export class UpdatePropertyTypeBody {
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional({ minimum: 0, maximum: 10000 }) @IsOptional() @IsInt() @Min(0) @Max(10_000) sortOrder?: number;
}

interface TypeRow {
  id: string;
  companyId: string | null;
  parentId: string | null;
  code: string;
  name: string;
  usageClass: string;
  appliesTo: string;
  countryCode: string | null;
  sortOrder: number;
  isActive: boolean;
  version: number;
}

/** Property categories: platform defaults by country plus company-defined types (Phase 4 "Property Categories"). */
@ApiTags('Property types')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/property-types')
export class PropertyTypesController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('property.view')
  @ApiQuery({ name: 'filter[countryCode]', required: false, description: 'Types usable in this country' })
  @ApiQuery({ name: 'filter[appliesTo]', required: false, enum: ['property', 'unit'] })
  @ApiQuery({ name: 'filter[active]', required: false, enum: ['true', 'false', 'all'] })
  @ApiOkResponse({ type: PropertyTypeListDto })
  async list(
    @Tenant() ctx: TenantContext,
    @Query('filter') filter: unknown,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<PropertyTypeListDto> {
    const parsed = parseTypeFilters(filter);
    const rows = await this.tenantDb.run(ctx, async (tx) => {
      let query = tx
        .selectFrom('propertyTypes')
        .select(['id', 'companyId', 'parentId', 'code', 'name', 'usageClass', 'appliesTo', 'countryCode', 'sortOrder', 'isActive', 'version']);
      if (parsed.countryCode) {
        const country = parsed.countryCode;
        query = query.where((eb) => eb.or([eb('countryCode', 'is', null), eb('countryCode', '=', country)]));
      }
      if (parsed.appliesTo) query = query.where('appliesTo', 'in', [parsed.appliesTo, 'both']);
      if (parsed.active !== 'all') query = query.where('isActive', '=', parsed.active === 'true');
      const types = await query.orderBy('sortOrder').orderBy('name').execute();
      return this.localise(tx, types, acceptLanguage);
    });
    return { data: rows.map(toDto) };
  }

  @Post()
  @RequirePermission('settings.manage')
  @ApiCreatedResponse({ type: PropertyTypeDto })
  async create(
    @Tenant() ctx: TenantContext,
    @Body() body: CreatePropertyTypeBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PropertyTypeDto> {
    const created = await this.tenantDb.run(ctx, async (tx) => {
      if (body.countryCode) {
        const country = await tx.selectFrom('countries').select('code').where('code', '=', body.countryCode).where('isActive', '=', true).executeTakeFirst();
        if (!country) throw Problems.validation([{ field: 'countryCode', code: 'unsupported', message: 'This country is not supported.' }]);
      }
      if (body.parentId) {
        const parent = await tx.selectFrom('propertyTypes').select('id').where('id', '=', body.parentId).executeTakeFirst();
        if (!parent) throw Problems.validation([{ field: 'parentId', code: 'not-found', message: 'The parent type does not exist.' }]);
      }
      const row = await tx
        .insertInto('propertyTypes')
        .values({
          companyId: ctx.companyId,
          code: body.code,
          name: body.name,
          usageClass: body.usageClass,
          appliesTo: body.appliesTo,
          parentId: body.parentId ?? null,
          countryCode: body.countryCode ?? null,
          sortOrder: body.sortOrder ?? 100,
        })
        .returning(['id', 'companyId', 'parentId', 'code', 'name', 'usageClass', 'appliesTo', 'countryCode', 'sortOrder', 'isActive', 'version'])
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, { action: 'property_type.created', entityType: 'property_type', entityId: row.id, metadata: { code: row.code } });
      return row;
    });
    res.status(201).location(`/api/v1/property-types/${created.id}`);
    setVersionEtag(res, created.version);
    return toDto(created);
  }

  @Patch(':propertyTypeId')
  @RequirePermission('settings.manage')
  @ApiHeader({ name: 'If-Match', required: true })
  @ApiOkResponse({ type: PropertyTypeDto })
  async update(
    @Tenant() ctx: TenantContext,
    @Param('propertyTypeId', new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() })) id: string,
    @Body() body: UpdatePropertyTypeBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PropertyTypeDto> {
    const expectedVersion = requireIfMatch(ifMatch);
    const updated = await this.tenantDb.run(ctx, async (tx) => {
      // Platform types are readable but not lockable (FOR UPDATE applies the
      // update policy, which hides them), so check ownership before locking.
      const visible = await tx.selectFrom('propertyTypes').select('companyId').where('id', '=', id).executeTakeFirst();
      if (!visible) throw Problems.notFound();
      if (visible.companyId === null) {
        throw Problems.forbidden('Platform property types cannot be changed. Add your own type instead.');
      }
      const current = await tx
        .selectFrom('propertyTypes')
        .select(['id', 'version'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.version !== expectedVersion) throw Problems.preconditionFailed();
      const changes = { name: body.name, isActive: body.isActive, sortOrder: body.sortOrder };
      const row = await tx
        .updateTable('propertyTypes')
        .set(Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)))
        .where('id', '=', id)
        .returning(['id', 'companyId', 'parentId', 'code', 'name', 'usageClass', 'appliesTo', 'countryCode', 'sortOrder', 'isActive', 'version'])
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, {
        action: 'property_type.updated',
        entityType: 'property_type',
        entityId: id,
        changes: diffForAudit(current, row),
      });
      return row;
    });
    setVersionEtag(res, updated.version);
    return toDto(updated);
  }

  private async localise(tx: Tx, rows: TypeRow[], acceptLanguage: string | undefined): Promise<TypeRow[]> {
    const locales = preferredLocales(acceptLanguage);
    if (locales.length === 0 || rows.length === 0) return rows;
    const translations = await tx
      .selectFrom('propertyTypeTranslations')
      .select(['propertyTypeId', 'localeCode', 'name'])
      .where('propertyTypeId', 'in', rows.map((row) => row.id))
      .where('localeCode', 'in', locales)
      .execute();
    return rows.map((row) => {
      for (const locale of locales) {
        const match = translations.find((t) => t.propertyTypeId === row.id && t.localeCode === locale);
        if (match) return { ...row, name: match.name };
      }
      return row;
    });
  }
}

function parseTypeFilters(filter: unknown): { countryCode?: string; appliesTo?: string; active: string } {
  const result: { countryCode?: string; appliesTo?: string; active: string } = { active: 'true' };
  if (filter === undefined) return result;
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw Problems.validation([{ field: 'filter', code: 'invalid', message: 'Use filter[name]=value.' }]);
  }
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (key === 'countryCode' && typeof value === 'string' && /^[A-Z]{2}$/.test(value)) result.countryCode = value;
    else if (key === 'appliesTo' && (value === 'property' || value === 'unit')) result.appliesTo = value;
    else if (key === 'active' && (value === 'true' || value === 'false' || value === 'all')) result.active = value;
    else {
      const known = ['countryCode', 'appliesTo', 'active'].includes(key);
      throw Problems.validation([
        { field: `filter[${key}]`, code: known ? 'invalid' : 'unknown-filter', message: known ? 'This filter value is not valid.' : 'This filter is not supported.' },
      ]);
    }
  }
  return result;
}

function toDto(row: TypeRow): PropertyTypeDto {
  return {
    id: row.id,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    usageClass: row.usageClass,
    appliesTo: row.appliesTo,
    countryCode: row.countryCode,
    isCompanyDefined: row.companyId !== null,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    version: row.version,
  };
}
