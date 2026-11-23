import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { MediaModule } from '../media/media.module.js';
import { AgreementsController } from './agreements.controller.js';
import { AgreementsService } from './agreements.service.js';
import { ArrearsController } from './arrears.controller.js';
import { ArrearsService } from './arrears.service.js';
import { BankImportService } from './bank-import.service.js';
import { ChargesService } from './charges.service.js';
import { DepositsController } from './deposits.controller.js';
import { DepositsService } from './deposits.service.js';
import { InspectionsController } from './inspections.controller.js';
import { InspectionsService } from './inspections.service.js';
import { LeaseEndingController } from './lease-ending.controller.js';
import { LeaseEndingService } from './lease-ending.service.js';
import { LeasesController } from './leases.controller.js';
import { LeasesService } from './leases.service.js';
import { LettingsSettingsService } from './lettings-settings.service.js';
import { ReceiptsController } from './receipts.controller.js';
import { ReceiptsService } from './receipts.service.js';
import { RentController } from './rent.controller.js';
import { RentReviewsController } from './rent-reviews.controller.js';
import { RentReviewsService } from './rent-reviews.service.js';

/**
 * Lettings: management agreements and leases (Phase 7 L1); rent schedule,
 * charges and reviews (L2); receipts, bank-file import, allocation, arrears
 * and payment plans (L3); deposits, inspections, notice, ending, closing and
 * renewal (L4).
 */
@Module({
  imports: [AuthModule, DocumentsModule, ListingsModule, MediaModule],
  controllers: [
    AgreementsController,
    LeasesController,
    LeaseEndingController,
    RentController,
    RentReviewsController,
    ReceiptsController,
    ArrearsController,
    DepositsController,
    InspectionsController,
  ],
  providers: [
    AgreementsService,
    LeasesService,
    ChargesService,
    LettingsSettingsService,
    RentReviewsService,
    ReceiptsService,
    BankImportService,
    ArrearsService,
    DepositsService,
    LeaseEndingService,
    InspectionsService,
    IdempotencyService,
  ],
})
export class LettingsModule {}
