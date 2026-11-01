import 'reflect-metadata';

import { Module, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { inject } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../../src/config/config.js';
import { TestIdp } from './idp.js';
import { testServiceEnv } from './services.js';

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof supertest>;
  idp: TestIdp;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function createTestApp(
  overrides: Record<string, string> = {},
  options: { controllers?: Type<unknown>[] } = {},
): Promise<TestApp> {
  const urls = inject('databaseUrls');
  const idp = new TestIdp();
  await idp.start();

  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'silent',
    DATABASE_URL: urls.app,
    AUTH_DATABASE_URL: urls.auth,
    DATABASE_POOL_MAX: '4',
    OIDC_ISSUER: idp.issuer,
    OIDC_AUDIENCE: idp.audience,
    OIDC_JWKS_URL: idp.jwksUrl,
    OIDC_PROVIDER: idp.provider,
    ...testServiceEnv(),
    ...overrides,
  });

  @Module({ controllers: options.controllers ?? [] })
  class TestControllersModule {}

  const moduleRef = await Test.createTestingModule({ imports: [AppModule, TestControllersModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
  configureApp(app, { trustProxyHops: config.TRUST_PROXY_HOPS });
  await app.init();

  return {
    app,
    http: supertest(app.getHttpServer()),
    idp,
    config,
    close: async () => {
      await app.close();
      await idp.stop();
    },
  };
}
