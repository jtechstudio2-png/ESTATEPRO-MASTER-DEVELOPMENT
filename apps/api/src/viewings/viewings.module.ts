import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { CrmModule } from '../crm/crm.module.js';
import { KeysModule } from '../keys/keys.module.js';
import { ViewingsController } from './viewings.controller.js';
import { ViewingsService } from './viewings.service.js';

/** Viewings (Phase 6 milestone S1). */
@Module({
  imports: [AuthModule, ContactsModule, CrmModule, KeysModule],
  controllers: [ViewingsController],
  providers: [ViewingsService],
})
export class ViewingsModule {}
