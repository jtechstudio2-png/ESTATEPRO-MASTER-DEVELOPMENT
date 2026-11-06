import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { TenantDb } from '../database/database.module.js';
import { ExportsModule } from '../exports/exports.module.js';
import { ErasureLedger } from './erasure-ledger.js';
import { ErasureService } from './erasure.service.js';
import { PrivacyRequestsController } from './requests.controller.js';
import { PRIVACY_ERASURE, PrivacyRequestsService } from './requests.service.js';

/**
 * The data-subject request register (gap G3). The erasure service is created
 * on first use, so the API starts without an erasure ledger bucket; carrying
 * out an erasure then answers 503 and erases nothing.
 */
@Module({
  imports: [AuthModule, ExportsModule],
  controllers: [PrivacyRequestsController],
  providers: [
    PrivacyRequestsService,
    {
      provide: PRIVACY_ERASURE,
      inject: [TenantDb, APP_CONFIG],
      useFactory: (tenantDb: TenantDb, config: AppConfig) => {
        let service: ErasureService | null = null;
        return () => (service ??= new ErasureService(tenantDb, null, ErasureLedger.fromConfig(config)));
      },
    },
  ],
  exports: [PrivacyRequestsService],
})
export class PrivacyModule {}
