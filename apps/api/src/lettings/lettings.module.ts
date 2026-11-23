import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { AgreementsController } from './agreements.controller.js';
import { AgreementsService } from './agreements.service.js';
import { ChargesService } from './charges.service.js';
import { LeasesController } from './leases.controller.js';
import { LeasesService } from './leases.service.js';
import { LettingsSettingsService } from './lettings-settings.service.js';
import { RentController } from './rent.controller.js';
import { RentReviewsController } from './rent-reviews.controller.js';
import { RentReviewsService } from './rent-reviews.service.js';

/** Management agreements and leases (Phase 7 L1); rent schedule, charges and reviews (L2). */
@Module({
  imports: [AuthModule, DocumentsModule, ListingsModule],
  controllers: [AgreementsController, LeasesController, RentController, RentReviewsController],
  providers: [AgreementsService, LeasesService, ChargesService, LettingsSettingsService, RentReviewsService],
})
export class LettingsModule {}
