import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PortalEndpoint, RequirePermission, Tenant } from '../auth/decorators.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { TenantDb } from '../database/database.module.js';
import { LandlordListingsDto, LandlordListingViewDto, LandlordPreviewDto } from './landlord.dto.js';
import { LandlordViewsService } from './landlord-views.service.js';

const UUID_PARAM = new ParseUUIDPipe({ exceptionFactory: () => Problems.notFound() });

/** Landlord visibility (Phase 6 milestone S4; issue #5; readiness report §6). */
@ApiTags('Landlord visibility')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Company-Id', required: true })
@Controller('api/v1')
export class LandlordController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly views: LandlordViewsService,
  ) {}

  @Get('portal/landlord/listings')
  @PortalEndpoint()
  @RequirePermission('listing.view')
  @ApiOperation({ summary: 'Landlord portal: your listings, with open offers, upcoming viewings and open deals (landlord portal accounts)' })
  @ApiOkResponse({ type: LandlordListingsDto })
  async listings(@Tenant() ctx: TenantContext): Promise<LandlordListingsDto> {
    return { data: await this.tenantDb.run(ctx, (tx) => this.views.myListings(tx, ctx)) };
  }

  @Get('portal/landlord/listings/:listingId')
  @PortalEndpoint()
  @RequirePermission('listing.view')
  @ApiOperation({ summary: 'Landlord portal: offers, deal progress and viewings on one of your listings, in reduced form' })
  @ApiOkResponse({ type: LandlordListingViewDto })
  async listing(@Tenant() ctx: TenantContext, @Param('listingId', UUID_PARAM) listingId: string): Promise<LandlordListingViewDto> {
    return this.tenantDb.run(ctx, (tx) => this.views.myListing(tx, ctx, listingId));
  }

  @Get('contacts/:contactId/portal-visibility-preview/listings/:listingId')
  @RequirePermission('contact.view')
  @ApiTags('Contacts: portal preview')
  @ApiOperation({ summary: 'What this landlord could see on one listing (LL-1): limited to what you may see; read-only, audited' })
  @ApiOkResponse({ type: LandlordPreviewDto })
  async preview(
    @Tenant() ctx: TenantContext,
    @Param('contactId', UUID_PARAM) contactId: string,
    @Param('listingId', UUID_PARAM) listingId: string,
  ): Promise<LandlordPreviewDto> {
    return this.tenantDb.run(ctx, (tx) => this.views.preview(tx, ctx, contactId, listingId));
  }
}
