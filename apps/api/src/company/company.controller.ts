import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';

import { Tenant } from '../auth/decorators.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';

class CompanyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() legalName!: string;
  @ApiProperty({ nullable: true, type: String }) tradingName!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty({ type: [String] }) businessTypes!: string[];
  @ApiProperty({ example: 'GH' }) headquartersCountryCode!: string;
  @ApiProperty({ example: 'GHS' }) baseCurrencyCode!: string;
  @ApiProperty({ example: 'en-GH' }) defaultLocaleCode!: string;
  @ApiProperty({ example: 'Africa/Accra' }) defaultTimezone!: string;
  @ApiProperty({ minimum: 1, maximum: 12 }) fiscalYearStartMonth!: number;
}

class OfficeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() countryCode!: string;
  @ApiProperty() jurisdictionCode!: string;
  @ApiProperty() currencyCode!: string;
  @ApiProperty() localeCode!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty({ type: [Number], description: 'ISO weekdays, 1 = Monday' }) workingDays!: number[];
  @ApiProperty() isHeadOffice!: boolean;
  @ApiProperty({ nullable: true, type: String }) formattedAddress!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) archivedAt!: string | null;
}

class OfficeListDto {
  @ApiProperty({ type: [OfficeDto] }) data!: OfficeDto[];
}

/**
 * Company profile and offices: reference data every staff member needs to
 * fill in forms (currency, timezone, office). Visible to every active staff
 * member of the company, so no specific permission is required.
 */
@ApiTags('Company')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class CompanyController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get('company')
  @ApiOkResponse({ type: CompanyDto })
  async company(@Tenant() ctx: TenantContext): Promise<CompanyDto> {
    const company = await this.tenantDb.run(ctx, (tx) =>
      tx
        .selectFrom('companies')
        .select([
          'id',
          'legalName',
          'tradingName',
          'status',
          'businessTypes',
          'headquartersCountryCode',
          'baseCurrencyCode',
          'defaultLocaleCode',
          'defaultTimezone',
          'fiscalYearStartMonth',
        ])
        .where('id', '=', ctx.companyId)
        .executeTakeFirst(),
    );
    if (!company) throw Problems.notFound();
    return company;
  }

  @Get('offices')
  @ApiQuery({ name: 'filter[archived]', required: false, enum: ['false', 'true', 'all'] })
  @ApiOkResponse({ type: OfficeListDto })
  async offices(
    @Tenant() ctx: TenantContext,
    @Query('filter') filter: Record<string, unknown> | undefined,
  ): Promise<OfficeListDto> {
    const archived = parseArchivedFilter(filter);
    const offices = await this.tenantDb.run(ctx, (tx) => {
      let query = this.officeQuery(tx).orderBy('o.isHeadOffice', 'desc').orderBy('o.name');
      if (archived === 'false') query = query.where('o.archivedAt', 'is', null);
      if (archived === 'true') query = query.where('o.archivedAt', 'is not', null);
      return query.execute();
    });
    return { data: offices.map(toOfficeDto) };
  }

  @Get('offices/:officeId')
  @ApiOkResponse({ type: OfficeDto })
  async office(
    @Tenant() ctx: TenantContext,
    @Param('officeId', new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() })) officeId: string,
  ): Promise<OfficeDto> {
    const office = await this.tenantDb.run(ctx, (tx) =>
      this.officeQuery(tx).where('o.id', '=', officeId).executeTakeFirst(),
    );
    if (!office) throw Problems.notFound();
    return toOfficeDto(office);
  }

  private officeQuery(tx: Parameters<Parameters<TenantDb['run']>[1]>[0]) {
    return tx
      .selectFrom('offices as o')
      .leftJoin('addresses as a', 'a.id', 'o.addressId')
      .select([
        'o.id',
        'o.code',
        'o.name',
        'o.countryCode',
        'o.jurisdictionCode',
        'o.currencyCode',
        'o.localeCode',
        'o.timezone',
        'o.workingDays',
        'o.isHeadOffice',
        'o.archivedAt',
        'a.formatted as formattedAddress',
      ]);
  }
}

function parseArchivedFilter(filter: Record<string, unknown> | undefined): 'false' | 'true' | 'all' {
  if (filter === undefined) return 'false';
  const keys = Object.keys(filter);
  const unknown = keys.filter((key) => key !== 'archived');
  if (unknown.length > 0) {
    throw Problems.validation(
      unknown.map((key) => ({ field: `filter[${key}]`, code: 'unknown-filter', message: 'This filter is not supported.' })),
    );
  }
  const value = filter['archived'];
  if (value === undefined) return 'false';
  if (value === 'false' || value === 'true' || value === 'all') return value;
  throw Problems.validation([
    { field: 'filter[archived]', code: 'invalid', message: 'Use false, true or all.' },
  ]);
}

function toOfficeDto(row: {
  id: string;
  code: string;
  name: string;
  countryCode: string;
  jurisdictionCode: string;
  currencyCode: string;
  localeCode: string;
  timezone: string;
  workingDays: number[];
  isHeadOffice: boolean;
  archivedAt: Date | null;
  formattedAddress: string | null;
}): OfficeDto {
  return { ...row, archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null };
}
