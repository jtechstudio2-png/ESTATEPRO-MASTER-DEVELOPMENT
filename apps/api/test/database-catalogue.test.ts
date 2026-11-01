import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { SENSITIVE_FIELDS } from '../src/crypto/sensitive-fields.js';
import { createKysely, type Db, SchemaCasePlugin } from '../src/database/database.module.js';

class ExposedCasePlugin extends SchemaCasePlugin {
  toSnake(name: string): string {
    return this.snakeCase(name);
  }
}

/**
 * Catalogue checks (audit item IS-11): structural guarantees that must hold for
 * every table, including tables added in later phases.
 */
describe('database catalogue', () => {
  let admin: Db;

  beforeAll(() => {
    admin = createKysely(inject('databaseUrls').admin, 1, 'estatepro-catalogue-test');
  });

  afterAll(async () => {
    await admin.destroy();
  });

  it('enables row-level security with at least one policy on every table that has company_id', async () => {
    const { rows } = await sql<{ table: string; rls: boolean; policies: number }>`
      select c.relname as table, c.relrowsecurity as rls,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition`.execute(admin);
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((row) => !row.rls || row.policies === 0)).toEqual([]);
  });

  it('registers every encrypted column with the field-encryption register (ADR-007 §3)', async () => {
    const { rows } = await sql<{ tableName: string; columnName: string; dataType: string }>`
      select table_name, column_name, data_type from information_schema.columns
       where table_schema = 'public' and column_name like '%\_encrypted'`.execute(admin);
    const inDatabase = rows.map((row) => `${row.tableName}.${row.columnName}`).sort();
    const registered = SENSITIVE_FIELDS.map((field) => `${field.table}.${field.column}`).sort();
    expect(inDatabase).toEqual(registered);
    expect(rows.filter((row) => row.dataType !== 'bytea')).toEqual([]);
    for (const field of SENSITIVE_FIELDS.filter((spec) => spec.lookup)) {
      const hash = await sql<{ dataType: string }>`
        select data_type from information_schema.columns
         where table_schema = 'public' and table_name = ${field.table} and column_name = ${field.lookup!.hashColumn}`.execute(admin);
      expect(hash.rows, `${field.table}.${field.lookup!.hashColumn}`).toEqual([{ dataType: 'bytea' }]);
    }
  });

  it('never indexes an encrypted column, directly or in an expression (ADR-007 §6)', async () => {
    const { rows } = await sql<{ indexName: string; definition: string }>`
      select indexname as index_name, indexdef as definition from pg_indexes
       where schemaname = 'public' and indexdef ~ '_encrypted'`.execute(admin);
    expect(rows).toEqual([]);
  });

  it('never lets the runtime role own a table (owners bypass RLS)', async () => {
    const { rows } = await sql<{ table: string }>`
      select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and pg_get_userbyid(c.relowner) = 'estatepro_app'`.execute(admin);
    expect(rows).toEqual([]);
  });

  it('keeps the runtime role subject to RLS', async () => {
    const { rows } = await sql<{ bypass: boolean; superuser: boolean }>`
      select rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = 'estatepro_app'`.execute(admin);
    expect(rows).toEqual([{ bypass: false, superuser: false }]);
  });

  it('maps every generated camelCase column name back to its schema column', async () => {
    const plugin = new ExposedCasePlugin();
    const columns = await sql<{ columnName: string }>`
      SELECT DISTINCT column_name FROM information_schema.columns WHERE table_schema = 'public'
    `.execute(admin);
    const mismatched = columns.rows
      .map((row) => row.columnName)
      .filter((name) => plugin.toSnake(name.replace(/_([a-z0-9])/g, (_match: string, char: string) => char.toUpperCase())) !== name);
    expect(mismatched).toEqual([]);
  });
});
