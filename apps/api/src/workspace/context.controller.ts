import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';

import { Tenant } from '../auth/decorators.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';

class GrantDto {
  @ApiProperty({ example: 'listing.publish' }) key!: string;
  @ApiProperty({ enum: ['all', 'office', 'team', 'own', 'linked', 'assigned'] }) scope!: string;
  @ApiProperty({ description: 'Needs a recent sign-in with a second factor' }) isSensitive!: boolean;
}

class ContextUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() email!: string;
}

class ContextCompanyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Trading name, else legal name' }) name!: string;
  @ApiProperty({ enum: ['trial', 'active', 'past_due', 'read_only', 'suspended', 'cancelled'] }) status!: string;
  @ApiProperty({ example: 'GHS' }) baseCurrencyCode!: string;
  @ApiProperty({ example: 'GH' }) headquartersCountryCode!: string;
}

class SessionContextDto {
  @ApiProperty({ type: ContextUserDto }) user!: ContextUserDto;
  @ApiProperty({ type: ContextCompanyDto }) company!: ContextCompanyDto;
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty() roleKey!: string;
  @ApiProperty() roleName!: string;
  @ApiProperty({ type: [String], format: 'uuid', description: 'Offices the member belongs to' }) officeIds!: string[];
  @ApiProperty({ type: [GrantDto] }) permissions!: GrantDto[];
  @ApiProperty({ example: 'en-GH', description: "The user's locale, else the company's" }) locale!: string;
  @ApiProperty({ enum: ['ltr', 'rtl'] }) textDirection!: 'ltr' | 'rtl';
  @ApiProperty({ example: 'Africa/Accra', description: "The user's time zone, else the company's" }) timezone!: string;
}

/**
 * Who the caller is in the chosen company and what they may do (M6 API gap
 * A-1). The web app builds navigation and actions from this; the API still
 * checks every request. Any active staff member may read their own context.
 */
@ApiTags('Session')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class ContextController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get('me/context')
  @ApiOkResponse({ type: SessionContextDto })
  async context(@Tenant() ctx: TenantContext): Promise<SessionContextDto> {
    return this.tenantDb.run(ctx, async (tx) => {
      const row = await tx
        .selectFrom('companyMemberships as m')
        .innerJoin('users as u', 'u.id', 'm.userId')
        .innerJoin('companies as c', 'c.id', 'm.companyId')
        .innerJoin('roles as r', 'r.id', 'm.roleId')
        .select([
          'u.id as userId',
          'u.displayName',
          'u.email',
          'u.localeCode as userLocale',
          'u.timezone as userTimezone',
          'c.id as companyId',
          'c.legalName',
          'c.tradingName',
          'c.status',
          'c.baseCurrencyCode',
          'c.headquartersCountryCode',
          'c.defaultLocaleCode',
          'c.defaultTimezone',
          'r.name as roleName',
        ])
        .where('m.id', '=', ctx.membershipId)
        .executeTakeFirst();
      if (!row) throw Problems.notFound();
      const locale = row.userLocale ?? row.defaultLocaleCode;
      const direction = await tx.selectFrom('locales').select('textDirection').where('code', '=', locale).executeTakeFirst();
      return {
        user: { id: row.userId, displayName: row.displayName, email: row.email },
        company: {
          id: row.companyId,
          name: row.tradingName ?? row.legalName,
          status: row.status,
          baseCurrencyCode: row.baseCurrencyCode,
          headquartersCountryCode: row.headquartersCountryCode,
        },
        membershipId: ctx.membershipId,
        roleKey: ctx.roleKey,
        roleName: row.roleName,
        officeIds: [...ctx.officeIds],
        permissions: [...ctx.permissions.entries()]
          .map(([key, grant]) => ({ key, scope: grant.scope, isSensitive: grant.isSensitive }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        locale,
        textDirection: direction?.textDirection === 'rtl' ? 'rtl' : 'ltr',
        timezone: row.userTimezone ?? row.defaultTimezone,
      };
    });
  }
}
