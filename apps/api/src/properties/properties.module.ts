import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency.service.js';
import { PropertyTypesController } from '../property-types/property-types.controller.js';
import { PropertiesController } from './properties.controller.js';
import { PropertiesService } from './properties.service.js';
import { UnitsService } from './units.service.js';

@Module({
  controllers: [PropertyTypesController, PropertiesController],
  providers: [PropertiesService, UnitsService, IdempotencyService],
  exports: [PropertiesService, UnitsService],
})
export class PropertiesModule {}
