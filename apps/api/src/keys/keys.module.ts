import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency.service.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { KeysController } from './keys.controller.js';
import { KeysService } from './keys.service.js';

@Module({
  imports: [ContactsModule],
  controllers: [KeysController],
  providers: [KeysService, IdempotencyService],
  exports: [KeysService],
})
export class KeysModule {}
