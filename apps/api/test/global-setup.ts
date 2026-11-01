import { readdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

import pg from 'pg';
import type { TestProject } from 'vitest/node';

/**
 * Builds a fresh test database from every migration in database/migrations,
 * then exposes connection strings for the three runtime roles.
 *
 * TEST_DATABASE_ADMIN_URL must point at a superuser on a PostgreSQL 16+ server
 * (default: postgres://postgres:postgres@127.0.0.1:5432/postgres).
 */
export interface TestDatabaseUrls {
  admin: string;
  app: string;
  auth: string;
  platform: string;
}

/**
 * S3-compatible storage (SeaweedFS in development and CI) and clamd. Both are
 * required: media tests exercise the real services and never skip.
 */
export interface TestServices {
  storageEndpoint: string;
  storageBucket: string;
  storageAccessKeyId: string;
  storageSecretAccessKey: string;
  clamavHost: string;
  clamavPort: number;
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
    testServices: TestServices;
  }
}

const ROLE_PASSWORD = 'estatepro-test';
const RUNTIME_ROLES = ['estatepro_app', 'estatepro_auth', 'estatepro_platform'] as const;

export default async function setup(project: TestProject): Promise<void> {
  const adminUrl = new URL(process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres');
  const databaseName = process.env['TEST_DATABASE_NAME'] ?? 'estatepro_api_test';

  const server = new pg.Client({ connectionString: adminUrl.toString() });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${databaseName}`);
  await server.end();

  const databaseAdminUrl = new URL(adminUrl);
  databaseAdminUrl.pathname = `/${databaseName}`;
  const admin = new pg.Client({ connectionString: databaseAdminUrl.toString() });
  await admin.connect();
  const migrationsDir = join(import.meta.dirname, '..', '..', '..', 'database', 'migrations');
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    try {
      await admin.query(readFileSync(join(migrationsDir, file), 'utf8'));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  // Runtime roles are created NOLOGIN by migration 0001; allow them to log in on the test server.
  for (const role of RUNTIME_ROLES) {
    await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${ROLE_PASSWORD}'`);
  }
  await admin.end();

  const roleUrl = (role: string): string => {
    const url = new URL(databaseAdminUrl);
    url.username = role;
    url.password = ROLE_PASSWORD;
    return url.toString();
  };

  project.provide('testServices', await prepareServices());

  project.provide('databaseUrls', {
    admin: databaseAdminUrl.toString(),
    app: roleUrl('estatepro_app'),
    auth: roleUrl('estatepro_auth'),
    platform: roleUrl('estatepro_platform'),
  });
}

async function prepareServices(): Promise<TestServices> {
  const services: TestServices = {
    storageEndpoint: process.env['TEST_STORAGE_ENDPOINT'] ?? 'http://127.0.0.1:8333',
    storageBucket: process.env['TEST_STORAGE_BUCKET'] ?? 'estatepro-test-media',
    storageAccessKeyId: process.env['TEST_STORAGE_ACCESS_KEY_ID'] ?? 'estatepro-test',
    storageSecretAccessKey: process.env['TEST_STORAGE_SECRET_ACCESS_KEY'] ?? 'estatepro-test-secret',
    clamavHost: process.env['TEST_CLAMAV_HOST'] ?? '127.0.0.1',
    clamavPort: Number(process.env['TEST_CLAMAV_PORT'] ?? 3310),
  };

  const s3 = new S3Client({
    endpoint: services.storageEndpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: services.storageAccessKeyId, secretAccessKey: services.storageSecretAccessKey },
  });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: services.storageBucket })).catch(async () => {
      await s3.send(new CreateBucketCommand({ Bucket: services.storageBucket }));
    });
  } catch (error) {
    throw new Error(`Test object storage is not reachable at ${services.storageEndpoint}: ${(error as Error).message}`);
  } finally {
    s3.destroy();
  }

  const pong = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: services.clamavHost, port: services.clamavPort });
    let reply = '';
    socket.setTimeout(10_000, () => socket.destroy(new Error('timeout')));
    socket.on('connect', () => socket.end('zPING\0'));
    socket.on('data', (chunk) => (reply += chunk.toString('utf8')));
    socket.on('end', () => resolve(reply));
    socket.on('error', reject);
  }).catch((error: Error) => {
    throw new Error(`clamd is not reachable at ${services.clamavHost}:${services.clamavPort}: ${error.message}`);
  });
  if (!pong.startsWith('PONG')) throw new Error(`clamd did not answer PING (got "${pong}")`);
  return services;
}
