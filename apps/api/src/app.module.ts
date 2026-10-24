import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import type { EstateProRequest } from './common/request-context.js';
import { CompanyController } from './company/company.controller.js';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { MeController } from './me/me.controller.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.LOG_LEVEL,
          genReqId: (req) => (req as unknown as EstateProRequest).requestId,
          redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
          customProps: (req) => ({ companyId: (req as unknown as EstateProRequest).tenant?.companyId }),
        },
      }),
    }),
    DatabaseModule,
    AuditModule,
    AuthModule,
  ],
  controllers: [HealthController, MeController, CompanyController],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}

