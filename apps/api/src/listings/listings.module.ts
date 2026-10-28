import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency.service.js';
import { LocationModule } from '../location/location.module.js';
import { ListingSettingsService } from './listing-settings.service.js';
import { ListingsController } from './listings.controller.js';
import { ListingsService } from './listings.service.js';

@Module({
  imports: [LocationModule],
  controllers: [ListingsController],
  providers: [ListingsService, ListingSettingsService, IdempotencyService],
})
export class ListingsModule {}
