import 'reflect-metadata';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Writes apps/api/openapi.json (ADR-003 §8). The document only needs the route
 * metadata, so connection settings get inert values when they are not set:
 * no database connection or JWKS request is made during generation.
 */
const GENERATION_DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgres://openapi:openapi@localhost:5432/openapi',
  AUTH_DATABASE_URL: 'postgres://openapi:openapi@localhost:5432/openapi',
  OIDC_ISSUER: 'https://idp.invalid/',
  OIDC_AUDIENCE: 'estatepro-api',
  OIDC_JWKS_URL: 'https://idp.invalid/.well-known/jwks.json',
  OIDC_PROVIDER: 'openapi-generation',
  STORAGE_BUCKET: 'openapi-generation',
  STORAGE_ACCESS_KEY_ID: 'openapi',
  STORAGE_SECRET_ACCESS_KEY: 'openapi',
  LOG_LEVEL: 'silent',
};
for (const [key, value] of Object.entries(GENERATION_DEFAULTS)) {
  process.env[key] ??= value;
}

const { AppModule } = await import('../app.module.js');
const { buildOpenApiDocument } = await import('../bootstrap.js');

const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, bodyParser: false });
const document = buildOpenApiDocument(app);
const target = process.argv[2] ?? join(import.meta.dirname, '..', '..', 'openapi.json');
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
await app.close();
process.stdout.write(`OpenAPI document written to ${target}\n`);
