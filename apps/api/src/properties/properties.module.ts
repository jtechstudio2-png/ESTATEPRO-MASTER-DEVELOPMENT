import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency.service.js';
import { LocationModule } from '../location/location.module.js';
import { PropertyTypesController } from '../property-types/property-types.controller.js';
import { OwnershipsService } from './ownerships.service.js';
import { PropertiesController } from './properties.controller.js';
import { PropertiesService } from './properties.service.js';
import { UnitsService } from './units.service.js';

@Module({
  imports: [LocationModule],
  controllers: [PropertyTypesController, PropertiesController],
  providers: [PropertiesService, UnitsService, OwnershipsService, IdempotencyService],
  exports: [PropertiesService, UnitsService],
})
export class PropertiesModule {}
