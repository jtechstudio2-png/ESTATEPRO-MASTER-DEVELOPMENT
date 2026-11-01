import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsInt, IsString, Max, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { RequirePermission, Scope, Tenant } from '../../src/auth/decorators.js';
import type { PermissionScope, TenantContext } from '../../src/common/request-context.js';

class ProbeChild {
  @IsString() @MinLength(2) label!: string;
}

class ProbeBody {
  @IsString() @MinLength(3) name!: string;
  @IsInt() @Max(10) count!: number;
  @ValidateNested() @Type(() => ProbeChild) child!: ProbeChild;
}

/**
 * Test-only controller (registered by tests, never by AppModule) that exercises
 * guard behaviour before real endpoints of every kind exist.
 */
@Controller('test-probe')
export class ProbeController {
  @Get('property-view')
  @RequirePermission('property.view')
  propertyView(@Tenant() ctx: TenantContext, @Scope() scope: PermissionScope) {
    return { scope, officeIds: ctx.officeIds, roleKey: ctx.roleKey };
  }

  @Post('contact-export')
  @RequirePermission('contact.export')
  sensitive(@Scope() scope: PermissionScope) {
    return { scope };
  }

  @Post('write')
  write(@Body() body: ProbeBody) {
    return { received: body.name };
  }

  @Get('no-tenant')
  noTenant(@Tenant() ctx: TenantContext) {
    return ctx;
  }
}
