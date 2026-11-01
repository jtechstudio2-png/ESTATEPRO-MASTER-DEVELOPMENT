import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency.service.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

@Module({
  controllers: [NotesController],
  providers: [NotesService, IdempotencyService],
})
export class NotesModule {}
