import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { LocationModule } from '../location/location.module.js';
import { ContactsController } from './contacts.controller.js';
import { ContactsService } from './contacts.service.js';
import { DuplicatesService } from './duplicates.service.js';
import { MergeService } from './merge.service.js';
import { ContactSensitiveController } from './sensitive.controller.js';
import { ContactSensitiveService } from './sensitive.service.js';

/** Contacts (Phase 5 CRM): register, records, duplicates, merge, consent and protected details. */
@Module({
  imports: [AuthModule, LocationModule],
  controllers: [ContactsController, ContactSensitiveController],
  providers: [ContactsService, DuplicatesService, MergeService, ContactSensitiveService, IdempotencyService],
  exports: [ContactsService],
})
export class ContactsModule {}
