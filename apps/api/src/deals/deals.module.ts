import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { CrmModule } from '../crm/crm.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { DealProgressService } from './deal-progress.service.js';
import { DealsController } from './deals.controller.js';
import { DealsService } from './deals.service.js';

/** Deals, lead conversion, milestones, exchange and completion (Phase 6 milestone S3). */
@Module({
  imports: [AuthModule, ContactsModule, CrmModule, ListingsModule],
  controllers: [DealsController],
  providers: [DealsService, DealProgressService],
})
export class DealsModule {}
