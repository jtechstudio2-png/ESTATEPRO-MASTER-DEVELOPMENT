import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { MediaModule } from '../media/media.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

/** Documents of leases and management agreements (Phase 7 L1, W7-A1). */
@Module({
  imports: [AuthModule, MediaModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, IdempotencyService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
