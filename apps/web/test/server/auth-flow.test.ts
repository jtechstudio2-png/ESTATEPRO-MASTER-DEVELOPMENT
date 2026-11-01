// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { NextRequest } from 'next/server';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CallbackRoute from '@/app/auth/callback/route';
import type * as CompanyRoute from '@/app/auth/company/route';
import type * as LoginRoute from '@/app/auth/login/route';
import type * as LogoutRoute from '@/app/auth/logout/route';
import type * as ServerApi from '@/server/api';
import type * as Context from '@/server/context';
import type * as Session from '@/server/session';

import { E2eIdp, subjectFor } from '../../e2e/support/idp';
import { dropDatabase } from '../support/database';

/**
 * The sign-in flow at the server layer (W-D9): login route → identity
 * provider → callback → server-side session → token refresh → company
 * choice → sign-out. Real OIDC (the e2e provider), real PostgreSQL; the
 * cookie jar and request headers are in memory.
 */
const jar = new Map<string, string>();
const requestHeaders = new Headers();
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(requestHeaders),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const database = `estatepro_web_auth_${process.pid}`;
const ddl = /CREATE TABLE web_sessions \([\s\S]*?\n\);/.exec(readFileSync(new URL('../../../../database/migrations/0020_web_sessions.sql', import.meta.url), 'utf8'))![0];
const origin = 'http://127.0.0.1:3999';
const companyId = randomUUID();
const otherCompany = randomUUID();
const email = 'kofi.owner@accra.test';

const idp = new E2eIdp();
let api: Server;
let admin: pg.Client;
let pool: pg.Pool;
const apiCalls: Array<{ path: string; company: string | undefined; auth: string | undefined }> = [];

type Modules = {
  login: typeof LoginRoute;
  callback: typeof CallbackRoute;
  logout: typeof LogoutRoute;
  company: typeof CompanyRoute;
  session: typeof Session;
  context: typeof Context;
  serverApi: typeof ServerApi;
};
let m: Modules;

beforeAll(async () => {
  await idp.start();
  api = createServer((req, res) => {
    apiCalls.push({ path: req.url ?? '', company: req.headers['x-company-id'] as string | undefined, auth: req.headers.authorization });
    const company = req.headers['x-company-id'];
    if (req.url === '/api/v1/me/context' && company === companyId) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ locale: 'ar-QA', textDirection: 'rtl', company: { id: companyId } }));
    } else if (req.url === '/api/v1/me/context') {
      res.writeHead(403, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ type: 'urn:estatepro:problem:forbidden', title: 'Forbidden', status: 403 }));
    } else if (req.url === '/api/v1/me') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'u1', memberships: [] }));
    } else {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));

  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  pool = new pg.Pool({ connectionString: url.toString() });
  await pool.query('CREATE TABLE companies (id uuid PRIMARY KEY)');
  await pool.query('INSERT INTO companies (id) VALUES ($1), ($2)', [companyId, otherCompany]);
  await pool.query(ddl);

  Object.assign(process.env, {
    NODE_ENV: 'test',
    WEB_ORIGIN: origin,
    API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    WEB_DATABASE_URL: url.toString(),
    WEB_SESSION_KEY: randomBytes(32).toString('base64'),
    OIDC_ISSUER: idp.issuer,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_AUDIENCE: idp.audience,
    OIDC_ALLOW_INSECURE: 'true',
  });
  m = {
    login: await import('@/app/auth/login/route'),
    callback: await import('@/app/auth/callback/route'),
    logout: await import('@/app/auth/logout/route'),
    company: await import('@/app/auth/company/route'),
    session: await import('@/server/session'),
    context: await import('@/server/context'),
    serverApi: await import('@/server/api'),
  };
});

afterAll(async () => {
  await idp.stop();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await pool.end();
  // The app's own session pool (created on first use) closes before the database goes.
  await (m.session.sessionStore() as unknown as { pool: pg.Pool }).pool.end();
  await dropDatabase(admin, database);
  await admin.end();
});

beforeEach(async () => {
  await pool.query('DELETE FROM web_sessions');
  jar.clear();
  apiCalls.length = 0;
  idp.accessTokenSeconds = 300;
});

/** Runs the login route, signs in at the provider and returns the callback URL. */
async function signInAtProvider(query = 'returnTo=%2Fproperties%3Fq%3Dosu'): Promise<{ authorize: URL; callback: URL }> {
  const started = await m.login.GET(new NextRequest(`${origin}/auth/login?${query}`));
  expect(started.status).toBe(303);
  const authorize = new URL(started.headers.get('location')!);
  const form = new URLSearchParams({ email, mfa: '1' });
  for (const name of ['redirect_uri', 'state', 'nonce', 'code_challenge', 'client_id']) form.set(name, authorize.searchParams.get(name) ?? '');
  const submitted = await fetch(`${idp.issuer}/authorize`, { method: 'POST', body: form, redirect: 'manual' });
  return { authorize, callback: new URL(submitted.headers.get('location')!) };
}

describe('sign-in, session and sign-out', () => {
  it('signs in with PKCE, state and nonce, and keeps only a session id in the cookie', async () => {
    const { authorize, callback } = await signInAtProvider();
    expect(authorize.origin + authorize.pathname).toBe(`${idp.issuer}/authorize`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${origin}/auth/callback`);
    expect(authorize.searchParams.get('audience')).toBe(idp.audience);
    expect(authorize.searchParams.has('prompt')).toBe(false);
    expect(jar.has('ep_login')).toBe(true);

    const done = await m.callback.GET(new NextRequest(callback));
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${origin}/properties?q=osu`);
    expect(jar.has('ep_login')).toBe(false);
    const cookie = jar.get('ep_session')!;
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const session = await m.session.currentSession();
    expect(session).toMatchObject({ subject: subjectFor(email), companyId: null });
    expect(session!.tokens.accessToken.split('.')).toHaveLength(3);
    expect(session!.csrfToken).toHaveLength(43);
  });

  it('refuses a replayed or missing login, a provider error and a forged code', async () => {
    const { callback } = await signInAtProvider();
    const transaction = jar.get('ep_login')!;
    expect((await m.callback.GET(new NextRequest(callback))).headers.get('location')).toBe(`${origin}/properties?q=osu`);
    expect((await m.callback.GET(new NextRequest(callback))).headers.get('location')).toBe(`${origin}/sign-in?error=expired`);
    jar.set('ep_login', transaction);
    expect((await m.callback.GET(new NextRequest(callback))).headers.get('location')).toBe(`${origin}/sign-in?error=failed`);
    jar.set('ep_login', transaction);
    expect((await m.callback.GET(new NextRequest(`${origin}/auth/callback?error=access_denied`))).headers.get('location')).toBe(`${origin}/sign-in?error=denied`);
    jar.set('ep_login', 'not-a-sealed-value');
    expect((await m.callback.GET(new NextRequest(callback))).headers.get('location')).toBe(`${origin}/sign-in?error=expired`);
  });

  it('refreshes the access token before it expires, and signs out when the refresh is refused', async () => {
    idp.accessTokenSeconds = 30;
    const { callback } = await signInAtProvider();
    await m.callback.GET(new NextRequest(callback));
    const first = (await m.session.currentSession())!;
    expect(first.accessExpiresAt.getTime() - Date.now()).toBeLessThan(60_000);
    idp.accessTokenSeconds = 300;
    const refreshed = (await m.session.currentSession())!;
    expect(refreshed.tokens.accessToken).not.toBe(first.tokens.accessToken);
    expect(refreshed.accessExpiresAt.getTime() - Date.now()).toBeGreaterThan(60_000);

    await pool.query("UPDATE web_sessions SET access_expires_at = now() - interval '1 minute'");
    const sealed = await pool.query<{ token_ciphertext: Buffer }>('SELECT token_ciphertext FROM web_sessions');
    expect(sealed.rowCount).toBe(1);
    // Revoke at the provider: an unknown refresh token is refused.
    (idp as unknown as { refreshTokens: Map<string, unknown> }).refreshTokens.clear();
    expect(await m.session.currentSession()).toBeNull();
    expect((await pool.query('SELECT 1 FROM web_sessions')).rowCount).toBe(0);
  });

  it('chooses a company only after the API confirms the membership, and builds the page context', async () => {
    const { callback } = await signInAtProvider();
    await m.callback.GET(new NextRequest(callback));
    const session = (await m.session.currentSession())!;
    const choose = (body: unknown, headers: Record<string, string> = { origin, 'x-csrf-token': session.csrfToken }) =>
      m.company.POST(new Request(`${origin}/auth/company`, { method: 'POST', headers, body: JSON.stringify(body) }));

    expect((await choose({ companyId }, { origin: 'https://evil.test', 'x-csrf-token': session.csrfToken })).status).toBe(403);
    expect((await choose({ companyId: 'not-a-uuid' })).status).toBe(422);
    expect((await choose({ companyId: otherCompany })).status).toBe(403);
    expect((await m.session.currentSession())!.companyId).toBeNull();

    requestHeaders.set('accept-language', 'ar-QA,ar;q=0.9');
    const before = await m.context.pageContext();
    expect(before).toMatchObject({ signedIn: true, session: null, language: 'ar', direction: 'rtl' });

    expect(await (await choose({ companyId: companyId.toUpperCase() })).json()).toEqual({ companyId });
    expect((await m.session.currentSession())!.companyId).toBe(companyId);
    const context = await m.context.pageContext();
    expect(context).toMatchObject({ signedIn: true, locale: 'ar-QA', language: 'ar', direction: 'rtl', csrfToken: session.csrfToken });
    expect(apiCalls.at(-1)).toMatchObject({ path: '/api/v1/me/context', company: companyId });
    expect(apiCalls.at(-1)!.auth).toBe(`Bearer ${session.tokens.accessToken}`);
    expect(await m.context.myMemberships()).toMatchObject({ id: 'u1' });
    expect(apiCalls.at(-1)).toMatchObject({ path: '/api/v1/me', company: undefined });
  });

  it('step-up sign-in forces a fresh login and keeps the company', async () => {
    const { callback } = await signInAtProvider();
    await m.callback.GET(new NextRequest(callback));
    await m.session.sessionStore().selectCompany(jar.get('ep_session')!, companyId);
    const oldCookie = jar.get('ep_session');
    const { authorize, callback: again } = await signInAtProvider('returnTo=%2Fsettings&stepUp=1');
    expect(authorize.searchParams.get('prompt')).toBe('login');
    expect(authorize.searchParams.get('max_age')).toBe('0');
    expect((await m.callback.GET(new NextRequest(again))).headers.get('location')).toBe(`${origin}/settings`);
    expect(jar.get('ep_session')).not.toBe(oldCookie);
    expect((await m.session.currentSession())!.companyId).toBe(companyId);
    expect((await pool.query('SELECT 1 FROM web_sessions')).rowCount).toBe(1);
  });

  it('signs out at the app and the provider; signed-out visitors get the defaults', async () => {
    const { callback } = await signInAtProvider();
    await m.callback.GET(new NextRequest(callback));
    const session = (await m.session.currentSession())!;
    expect((await m.logout.POST(new Request(`${origin}/auth/logout`, { method: 'POST', headers: { origin: 'https://evil.test' } }))).status).toBe(403);
    const out = await m.logout.POST(new Request(`${origin}/auth/logout`, { method: 'POST', headers: { origin, 'x-csrf-token': session.csrfToken } }));
    const target = new URL(((await out.json()) as { redirectTo: string }).redirectTo);
    expect(target.origin + target.pathname).toBe(`${idp.issuer}/logout`);
    expect(target.searchParams.get('id_token_hint')).toBe(session.tokens.idToken);
    expect(target.searchParams.get('post_logout_redirect_uri')).toBe(`${origin}/sign-in?signedOut=1`);
    expect(jar.has('ep_session')).toBe(false);
    expect(await m.session.currentSession()).toBeNull();
    expect(await m.session.endSession()).toBeNull();

    requestHeaders.set('accept-language', 'en-GB');
    expect(await m.context.pageContext()).toMatchObject({ signedIn: false, session: null, csrfToken: null, language: 'en', direction: 'ltr' });
    await expect(m.serverApi.serverApi('/api/v1/me')).rejects.toThrow('redirect:/sign-in');
  });
});
