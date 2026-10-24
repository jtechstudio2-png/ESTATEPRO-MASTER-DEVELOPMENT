import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
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

  project.provide('databaseUrls', {
    admin: databaseAdminUrl.toString(),
    app: roleUrl('estatepro_app'),
    auth: roleUrl('estatepro_auth'),
    platform: roleUrl('estatepro_platform'),
  });
}
