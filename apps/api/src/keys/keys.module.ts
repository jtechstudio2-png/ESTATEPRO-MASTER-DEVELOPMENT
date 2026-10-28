import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency.service.js';
import { KeysController } from './keys.controller.js';
import { KeysService } from './keys.service.js';

@Module({
  controllers: [KeysController],
  providers: [KeysService, IdempotencyService],
})
export class KeysModule {}
