import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { AgreementsController } from './agreements.controller.js';
import { AgreementsService } from './agreements.service.js';
import { LeasesController } from './leases.controller.js';
import { LeasesService } from './leases.service.js';

/** Management agreements and leases (Phase 7 milestone L1). */
@Module({
  imports: [AuthModule, DocumentsModule, ListingsModule],
  controllers: [AgreementsController, LeasesController],
  providers: [AgreementsService, LeasesService],
})
export class LettingsModule {}
