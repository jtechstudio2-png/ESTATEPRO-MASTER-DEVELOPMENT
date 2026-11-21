import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { LandlordController } from './landlord.controller.js';
import { LandlordViewsService } from './landlord-views.service.js';

/** Landlord visibility of offers, deal progress and viewings (Phase 6 milestone S4, issue #5). */
@Module({
  imports: [AuthModule, ContactsModule],
  controllers: [LandlordController],
  providers: [LandlordViewsService],
})
export class LandlordModule {}
