import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';

import { Tenant } from '../auth/decorators.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';

class CountryDto {
  @ApiProperty({ example: 'GH' }) code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() defaultCurrencyCode!: string;
  @ApiProperty() defaultLocaleCode!: string;
  @ApiProperty() defaultTimezone!: string;
  @ApiProperty({ enum: ['sqm', 'sqft'] }) areaDisplayUnit!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Field labels, required flags, patterns and local components' })
  addressFormat!: Record<string, unknown>;
  @ApiProperty({ type: [Number], nullable: true, description: 'west, south, east, north (ADR-006 L-D5)' })
  bounds!: [number, number, number, number] | null;
}

class CurrencyDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) symbol!: string | null;
  @ApiProperty() minorUnits!: number;
}

class LocaleDto {
  @ApiProperty({ example: 'ar-QA' }) code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['ltr', 'rtl'] }) textDirection!: string;
}

class PicklistValueDto {
  @ApiProperty() code!: string;
  @ApiProperty({ description: 'In the requested locale when translated' }) label!: string;
  @ApiProperty({ type: String, nullable: true }) countryCode!: string | null;
  @ApiProperty({ description: 'Added by the company (not a platform value)' }) isCompanyValue!: boolean;
}

class CountryListDto {
  @ApiProperty({ type: [CountryDto] }) data!: CountryDto[];
}
class CurrencyListDto {
  @ApiProperty({ type: [CurrencyDto] }) data!: CurrencyDto[];
}
class LocaleListDto {
  @ApiProperty({ type: [LocaleDto] }) data!: LocaleDto[];
}
class PicklistDto {
  @ApiProperty() listKey!: string;
  @ApiProperty({ type: [PicklistValueDto] }) data!: PicklistValueDto[];
}

const LIST_KEY = /^[a-z][a-z0-9_]{1,60}$/;
const COUNTRY = /^[A-Z]{2}$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

/**
 * Reference data for forms (M6 API gap A-9): countries with their address
 * formats and bounds, currencies, locales, and picklists (platform values
 * plus the company's own, filtered by country, labelled in a locale).
 */
@ApiTags('Reference')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/reference')
export class ReferenceController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get('countries')
  @ApiOkResponse({ type: CountryListDto })
  async countries(@Tenant() ctx: TenantContext): Promise<CountryListDto> {
    const rows = await this.tenantDb.run(ctx, (tx) =>
      tx
        .selectFrom('countries')
        .select([
          'code',
          'name',
          'defaultCurrencyCode',
          'defaultLocaleCode',
          'defaultTimezone',
          'areaDisplayUnit',
          'addressFormat',
          'boundsWest',
          'boundsSouth',
          'boundsEast',
          'boundsNorth',
        ])
        .where('isActive', '=', true)
        .orderBy('name')
        .execute(),
    );
    return {
      data: rows.map((row) => ({
        code: row.code,
        name: row.name,
        defaultCurrencyCode: row.defaultCurrencyCode,
        defaultLocaleCode: row.defaultLocaleCode,
        defaultTimezone: row.defaultTimezone,
        areaDisplayUnit: row.areaDisplayUnit,
        addressFormat: (row.addressFormat ?? {}) as Record<string, unknown>,
        bounds:
          row.boundsWest === null || row.boundsSouth === null || row.boundsEast === null || row.boundsNorth === null
            ? null
            : [Number(row.boundsWest), Number(row.boundsSouth), Number(row.boundsEast), Number(row.boundsNorth)],
      })),
    };
  }

  @Get('currencies')
  @ApiOkResponse({ type: CurrencyListDto })
  async currencies(@Tenant() ctx: TenantContext): Promise<CurrencyListDto> {
    const rows = await this.tenantDb.run(ctx, (tx) =>
      tx.selectFrom('currencies').select(['code', 'name', 'symbol', 'minorUnits']).where('isActive', '=', true).orderBy('code').execute(),
    );
    return { data: rows };
  }

  @Get('locales')
  @ApiOkResponse({ type: LocaleListDto })
  async locales(@Tenant() ctx: TenantContext): Promise<LocaleListDto> {
    const rows = await this.tenantDb.run(ctx, (tx) =>
      tx.selectFrom('locales').select(['code', 'name', 'textDirection']).where('isActive', '=', true).orderBy('code').execute(),
    );
    return { data: rows };
  }

  @Get('picklists/:listKey')
  @ApiQuery({ name: 'countryCode', required: false, description: 'Values for all countries plus this one' })
  @ApiQuery({ name: 'locale', required: false, description: 'Label language, e.g. ar-QA' })
  @ApiOkResponse({ type: PicklistDto })
  async picklist(
    @Tenant() ctx: TenantContext,
    @Param('listKey') listKey: string,
    @Query('countryCode') countryCode: unknown,
    @Query('locale') locale: unknown,
  ): Promise<PicklistDto> {
    const errors: FieldError[] = [];
    if (!LIST_KEY.test(listKey)) errors.push({ field: 'listKey', code: 'invalid', message: 'Use a picklist key such as tenure.' });
    if (countryCode !== undefined && (typeof countryCode !== 'string' || !COUNTRY.test(countryCode))) {
      errors.push({ field: 'countryCode', code: 'invalid', message: 'Use an ISO country code such as GH.' });
    }
    if (locale !== undefined && (typeof locale !== 'string' || !LOCALE.test(locale))) {
      errors.push({ field: 'locale', code: 'invalid', message: 'Use a locale such as en-GB or ar-QA.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    const country = typeof countryCode === 'string' ? countryCode : null;
    const language = typeof locale === 'string' ? locale : null;

    const rows = await this.tenantDb.run(ctx, (tx) =>
      tx
        .selectFrom('picklistValues as v')
        .select([
          'v.code',
          'v.countryCode',
          'v.companyId',
          'v.sortOrder',
          sql<string>`coalesce(
            (select t.label from picklist_value_translations t
              where t.picklist_value_id = v.id and t.locale_code = ${language}
              order by t.company_id nulls last limit 1),
            (select t.label from picklist_value_translations t
              where t.picklist_value_id = v.id and t.locale_code = split_part(${language}, '-', 1)
              order by t.company_id nulls last limit 1),
            v.label)`.as('label'),
        ])
        .where('v.listKey', '=', listKey)
        .where('v.isActive', '=', true)
        .where((eb) => (country === null ? eb('v.countryCode', 'is', null) : eb.or([eb('v.countryCode', 'is', null), eb('v.countryCode', '=', country)])))
        .orderBy('v.sortOrder')
        .orderBy('v.code')
        .execute(),
    );
    // A company value with the same code replaces the platform value.
    const byCode = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const existing = byCode.get(row.code);
      if (!existing || (existing.companyId === null && row.companyId !== null)) byCode.set(row.code, row);
    }
    return {
      listKey,
      data: [...byCode.values()].map((row) => ({ code: row.code, label: row.label, countryCode: row.countryCode, isCompanyValue: row.companyId !== null })),
    };
  }
}
