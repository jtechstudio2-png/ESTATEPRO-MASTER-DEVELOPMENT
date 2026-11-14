import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { ListingsModule } from '../listings/listings.module.js';
import { OffersController } from './offers.controller.js';
import { OffersService } from './offers.service.js';

/** Offers (Phase 6 milestone S2). */
@Module({
  imports: [AuthModule, ContactsModule, ListingsModule],
  controllers: [OffersController],
  providers: [OffersService],
})
export class OffersModule {}
