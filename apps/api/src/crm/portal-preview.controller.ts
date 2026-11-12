import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission, Tenant } from '../auth/decorators.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { PortalPreviewDto } from './portal-preview.dto.js';
import { PortalPreviewService } from './portal-preview.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/** Landlord visibility preview (Phase 5 milestone C4, CA-15; wireframe LL-1). */
@ApiTags('Contacts: portal preview')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1/contacts/:contactId')
export class PortalPreviewController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly preview: PortalPreviewService,
  ) {}

  @Get('portal-visibility-preview')
  @RequirePermission('contact.view')
  @ApiOperation({ summary: 'What this landlord would see in the landlord portal (read-only, audited; needs property.view)' })
  @ApiOkResponse({ type: PortalPreviewDto })
  async landlord(@Tenant() ctx: TenantContext, @Param('contactId', UUID_PARAM) id: string, @Res({ passthrough: true }) res: Response): Promise<PortalPreviewDto> {
    res.setHeader('Cache-Control', 'no-store');
    return this.tenantDb.run(ctx, (tx) => this.preview.landlord(tx, ctx, id));
  }
}
