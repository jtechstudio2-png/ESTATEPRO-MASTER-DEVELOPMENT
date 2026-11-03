import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { CrmSettingsService } from '../crm/crm-settings.service.js';
import { DashboardsController } from './dashboards.controller.js';
import { DashboardsService } from './dashboards.service.js';

/** Dashboards (Phase 5 milestone C4, CA-14). */
@Module({
  imports: [AuthModule],
  controllers: [DashboardsController],
  providers: [DashboardsService, CrmSettingsService],
})
export class DashboardsModule {}
