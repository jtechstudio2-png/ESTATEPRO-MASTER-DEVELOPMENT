import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { MediaModule } from '../media/media.module.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';

/** Contact and lead exports (Phase 5 milestone C4, CA-16). */
@Module({
  imports: [AuthModule, MediaModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
