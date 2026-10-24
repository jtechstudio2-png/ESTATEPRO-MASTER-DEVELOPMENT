import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency.service.js';
import { ListingSettingsService } from './listing-settings.service.js';
import { ListingsController } from './listings.controller.js';
import { ListingsService } from './listings.service.js';

@Module({
  controllers: [ListingsController],
  providers: [ListingsService, ListingSettingsService, IdempotencyService],
})
export class ListingsModule {}
