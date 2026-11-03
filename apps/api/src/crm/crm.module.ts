import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { ContactsModule } from '../contacts/contacts.module.js';
import { ActivitiesController } from './activities.controller.js';
import { ActivitiesService } from './activities.service.js';
import { CrmSettingsService } from './crm-settings.service.js';
import { LeadsController } from './leads.controller.js';
import { LeadsService } from './leads.service.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

/** CRM work: leads, the activity timeline and follow-ups (Phase 5 milestone C3). */
@Module({
  imports: [AuthModule, ContactsModule],
  controllers: [LeadsController, ActivitiesController, TasksController],
  providers: [LeadsService, ActivitiesService, TasksService, CrmSettingsService, IdempotencyService],
})
export class CrmModule {}
