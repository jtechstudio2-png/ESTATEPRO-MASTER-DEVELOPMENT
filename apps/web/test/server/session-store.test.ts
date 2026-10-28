// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SessionStore } from '@/server/session-store';

import { dropDatabase } from '../support/database';

/**
 * Against PostgreSQL with the web_sessions table exactly as migration 0020
 * creates it (in a throwaway database).
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const database = `estatepro_web_unit_${process.pid}`;
const migration = readFileSync(new URL('../../../../database/migrations/0020_web_sessions.sql', import.meta.url), 'utf8');
const ddl = /CREATE TABLE web_sessions \([\s\S]*?\n\);/.exec(migration)![0];

let admin: pg.Client;
let pool: pg.Pool;
let store: SessionStore;
const key = randomBytes(32);
const csrf = randomBytes(32).toString('base64url');
const tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', idToken: 'id-1' };
const t0 = new Date('2026-10-28T10:00:00Z');

beforeAll(async () => {
  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  await pool.query('CREATE TABLE companies (id uuid PRIMARY KEY)');
  await pool.query(ddl);
  store = new SessionStore(pool, key, 120, 12);
});

afterAll(async () => {
  await pool.end();
  await dropDatabase(admin, database);
  await admin.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM web_sessions');
});

describe('server-side session store', () => {
  it('stores only the id hash and sealed tokens, and finds the session by its id', async () => {
    await store.create('session-a', 'user-1', tokens, new Date(t0.getTime() + 300_000), csrf, t0);
    const { rows } = await pool.query<{ id_hash: Buffer; token_ciphertext: Buffer }>('SELECT id_hash, token_ciphertext FROM web_sessions');
    expect(rows[0]!.id_hash.toString('utf8')).not.toContain('session-a');
    expect(rows[0]!.token_ciphertext.toString('utf8')).not.toContain('access-1');
    const found = await store.find('session-a', new Date(t0.getTime() + 30_000));
    expect(found).toMatchObject({ subject: 'user-1', tokens, csrfToken: csrf, companyId: null });
    expect(found!.idleExpiresAt.toISOString()).toBe('2026-10-28T12:00:00.000Z');
    expect(found!.expiresAt.toISOString()).toBe('2026-10-28T22:00:00.000Z');
    expect(await store.find('session-b', t0)).toBeNull();
  });

  it('extends the idle timeout at most once a minute, never past the absolute limit', async () => {
    await store.create('s', 'user-1', tokens, t0, csrf, t0);
    const later = new Date(t0.getTime() + 30 * 60_000);
    expect((await store.find('s', later))!.idleExpiresAt.toISOString()).toBe('2026-10-28T12:30:00.000Z');
    const nearEnd = new Date('2026-10-28T21:30:00Z');
    await pool.query("UPDATE web_sessions SET idle_expires_at = '2026-10-28T21:59:00Z'");
    expect((await store.find('s', nearEnd))!.idleExpiresAt.toISOString()).toBe('2026-10-28T22:00:00.000Z');
  });

  it('ends idle and expired sessions and removes them', async () => {
    await store.create('idle', 'user-1', tokens, t0, csrf, t0);
    expect(await store.find('idle', new Date(t0.getTime() + 121 * 60_000))).toBeNull();
    expect((await pool.query('SELECT 1 FROM web_sessions')).rowCount).toBe(0);
    await store.create('old', 'user-1', tokens, t0, csrf, t0);
    await store.create('new', 'user-2', tokens, t0, csrf, new Date(t0.getTime() + 13 * 3_600_000));
    expect((await pool.query('SELECT subject FROM web_sessions')).rows).toEqual([{ subject: 'user-2' }]);
  });

  it('refuses tokens moved from another session or sealed with another key', async () => {
    await store.create('a', 'user-1', tokens, t0, csrf, t0);
    await store.create('b', 'user-2', { ...tokens, accessToken: 'access-2' }, t0, csrf, t0);
    await pool.query(`UPDATE web_sessions SET token_ciphertext = (SELECT token_ciphertext FROM web_sessions w WHERE w.subject = 'user-2') WHERE subject = 'user-1'`);
    expect(await store.find('a', t0)).toBeNull();
    expect(await new SessionStore(pool, randomBytes(32), 120, 12).find('b', t0)).toBeNull();
    expect(await new SessionStore(pool, randomBytes(32), 120, 12).refreshTokens('b', t0, () => Promise.resolve({ tokens, accessExpiresAt: t0 }))).toBeNull();
  });

  it('selects a company and destroys sessions', async () => {
    const company = randomUUID();
    await pool.query('INSERT INTO companies (id) VALUES ($1)', [company]);
    await store.create('s', 'user-1', tokens, t0, csrf, t0);
    await store.selectCompany('s', company);
    expect((await store.find('s', t0))!.companyId).toBe(company);
    await store.destroy('s');
    expect(await store.find('s', t0)).toBeNull();
  });

  it('refreshes stale tokens once, even with concurrent requests', async () => {
    await store.create('s', 'user-1', tokens, t0, csrf, new Date());
    let calls = 0;
    const refresh = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { tokens: { ...tokens, accessToken: 'access-2', refreshToken: 'refresh-2' }, accessExpiresAt: new Date(Date.now() + 300_000) };
    };
    const staleBefore = new Date(Date.now() + 60_000);
    const [first, second] = await Promise.all([store.refreshTokens('s', staleBefore, refresh), store.refreshTokens('s', staleBefore, refresh)]);
    expect(calls).toBe(1);
    expect(first!.tokens.accessToken).toBe('access-2');
    expect(second!.tokens.accessToken).toBe('access-2');
    expect(await store.refreshTokens('missing', staleBefore, refresh)).toBeNull();
  });

  it('rolls back when the refresh fails', async () => {
    await store.create('s', 'user-1', tokens, t0, csrf, new Date());
    await expect(store.refreshTokens('s', new Date(Date.now() + 60_000), async () => Promise.reject(new Error('invalid_grant')))).rejects.toThrow('invalid_grant');
    expect((await store.find('s'))!.tokens.accessToken).toBe('access-1');
  });
});
