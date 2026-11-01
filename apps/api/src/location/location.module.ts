import { Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { GEOCODER, geocoderFromConfig } from './geocoder.js';
import { GeocodingController } from './geocoding.controller.js';
import { RateLimiter } from './rate-limiter.js';

@Module({
  controllers: [GeocodingController],
  providers: [
    { provide: RateLimiter, useFactory: () => new RateLimiter() },
    { provide: GEOCODER, inject: [APP_CONFIG], useFactory: (config: AppConfig) => geocoderFromConfig(config) },
  ],
  exports: [RateLimiter],
})
export class LocationModule {}
