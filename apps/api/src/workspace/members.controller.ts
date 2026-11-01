import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';

import { Tenant } from '../auth/decorators.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';

class MemberDto {
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() roleName!: string;
}

class MemberListDto {
  @ApiProperty({ type: [MemberDto] }) data!: MemberDto[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION = /^[a-z_]+\.[a-z_]+$/;
const MAX_RESULTS = 50;

/**
 * Staff picker (M6 API gap A-2): names and ids of active staff memberships (the
 * same rule the API applies to agents and key holders), for choosing
 * an agent or a key holder. Returns no contact details. With
 * filter[permission] (and filter[officeId]) only members whose role grants
 * that permission for the office are returned, matching the API's own
 * eligibility rules (e.g. listing.update for listing agents).
 */
@ApiTags('Session')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class MembersController {
  constructor(private readonly tenantDb: TenantDb) {}

  @Get('members')
  @ApiQuery({ name: 'q', required: false, description: 'Name contains (2–100 characters)' })
  @ApiQuery({ name: 'filter[permission]', required: false, example: 'listing.update' })
  @ApiQuery({ name: 'filter[officeId]', required: false, description: 'With filter[permission]: the grant must cover this office' })
  @ApiOkResponse({ type: MemberListDto })
  async list(
    @Tenant() ctx: TenantContext,
    @Query('q') q: unknown,
    @Query('filter') filter: Record<string, unknown> | undefined,
  ): Promise<MemberListDto> {
    const errors: FieldError[] = [];
    const text = typeof q === 'string' ? q.trim() : null;
    if (q !== undefined && (text === null || text.length < 2 || text.length > 100)) {
      errors.push({ field: 'q', code: 'length', message: 'Search text must be 2 to 100 characters.' });
    }
    const permission = filter?.['permission'];
    const officeId = filter?.['officeId'];
    if (permission !== undefined && (typeof permission !== 'string' || !PERMISSION.test(permission))) {
      errors.push({ field: 'filter[permission]', code: 'invalid', message: 'Use a permission key such as listing.update.' });
    }
    if (officeId !== undefined && (typeof officeId !== 'string' || !UUID.test(officeId))) {
      errors.push({ field: 'filter[officeId]', code: 'invalid', message: 'Use an office id.' });
    }
    if (officeId !== undefined && permission === undefined) {
      errors.push({ field: 'filter[officeId]', code: 'needs-permission', message: 'Use filter[officeId] together with filter[permission].' });
    }
    if (filter !== undefined && Object.keys(filter).some((key) => key !== 'permission' && key !== 'officeId')) {
      errors.push({ field: 'filter', code: 'unknown-filter', message: 'Only filter[permission] and filter[officeId] are supported.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);

    const rows = await this.tenantDb.run(ctx, (tx) => {
      let qb = tx
        .selectFrom('companyMemberships as m')
        .innerJoin('users as u', 'u.id', 'm.userId')
        .innerJoin('roles as r', 'r.id', 'm.roleId')
        .select(['m.id as membershipId', 'u.displayName', 'r.name as roleName'])
        .where('m.status', '=', 'active')
        .where('m.membershipType', '=', 'staff');
      if (text !== null) qb = qb.where('u.displayName', 'ilike', `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      if (typeof permission === 'string') {
        const office = typeof officeId === 'string' ? officeId.toLowerCase() : null;
        qb = qb.where(
          sql<boolean>`exists (select 1 from role_permissions rp
            where rp.role_id = m.role_id and rp.permission_key = ${permission}
              and (rp.scope = 'all' or ${office}::uuid is null
                   or (rp.scope in ('office', 'own') and exists (
                         select 1 from membership_offices mo where mo.membership_id = m.id and mo.office_id = ${office}::uuid))))`,
        );
      }
      return qb.orderBy('u.displayName').orderBy('m.id').limit(MAX_RESULTS).execute();
    });
    return { data: rows };
  }
}
