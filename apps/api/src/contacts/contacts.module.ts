import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ContactSensitiveController } from './sensitive.controller.js';
import { ContactSensitiveService } from './sensitive.service.js';

/** Contacts (Phase 5 CRM). Starts with protected-detail reveal (ADR-007, encryption stage E4). */
@Module({
  imports: [AuthModule],
  controllers: [ContactSensitiveController],
  providers: [ContactSensitiveService],
})
export class ContactsModule {}
