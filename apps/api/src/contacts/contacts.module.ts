import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { LocationModule } from '../location/location.module.js';
import { ContactsController } from './contacts.controller.js';
import { ContactsService } from './contacts.service.js';
import { DuplicatesService } from './duplicates.service.js';
import { KycController } from './kyc.controller.js';
import { KycService } from './kyc.service.js';
import { MergeService } from './merge.service.js';
import { ContactRequirementsController, RequirementsRegisterController } from './requirements.controller.js';
import { RequirementsService } from './requirements.service.js';
import { ContactSensitiveController } from './sensitive.controller.js';
import { ContactSensitiveService } from './sensitive.service.js';

/** Contacts (Phase 5 CRM): register, records, duplicates, merge, consent, protected details, requirements and KYC. */
@Module({
  imports: [AuthModule, LocationModule],
  controllers: [ContactsController, ContactSensitiveController, RequirementsRegisterController, ContactRequirementsController, KycController],
  providers: [ContactsService, DuplicatesService, MergeService, ContactSensitiveService, IdempotencyService, RequirementsService, KycService],
  exports: [ContactsService],
})
export class ContactsModule {}
