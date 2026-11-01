import 'server-only';

import { cookies } from 'next/headers';
import pg from 'pg';

import { open, randomToken, seal } from './crypto';
import { env } from './env';
import type { LoginTransaction, TokenSet } from './oidc';
import { refreshTokens } from './oidc';
import { SessionStore, type StoredSession } from './session-store';

/** Refresh the access token when it expires within this window. */
const REFRESH_MARGIN_MS = 60_000;
const LOGIN_COOKIE_MAX_AGE = 600;

let store: SessionStore | null = null;

export function sessionStore(): SessionStore {
  if (store === null) {
    const settings = env();
    const pool = new pg.Pool({ connectionString: settings.WEB_DATABASE_URL, max: 10, application_name: 'estatepro-web' });
    store = new SessionStore(pool, Buffer.from(settings.WEB_SESSION_KEY, 'base64'), settings.SESSION_IDLE_MINUTES, settings.SESSION_ABSOLUTE_HOURS);
  }
  return store;
}

function secure(): boolean {
  return env().WEB_ORIGIN.startsWith('https://');
}

/** `__Host-` binds the cookie to this origin over https; plain names are used for http development. */
export function sessionCookieName(): string {
  return secure() ? '__Host-ep_session' : 'ep_session';
}

function loginCookieName(): string {
  return secure() ? '__Host-ep_login' : 'ep_login';
}

function cookieOptions(maxAge?: number) {
  return { httpOnly: true, secure: secure(), sameSite: 'lax' as const, path: '/', ...(maxAge === undefined ? {} : { maxAge }) };
}

function key(): Buffer {
  return Buffer.from(env().WEB_SESSION_KEY, 'base64');
}

export async function saveLoginTransaction(transaction: LoginTransaction): Promise<void> {
  const sealed = seal(key(), JSON.stringify({ ...transaction, exp: Date.now() + LOGIN_COOKIE_MAX_AGE * 1000 }), 'login');
  (await cookies()).set(loginCookieName(), sealed.toString('base64url'), cookieOptions(LOGIN_COOKIE_MAX_AGE));
}

/** Reads and deletes the pending login (single use). */
export async function takeLoginTransaction(): Promise<LoginTransaction | null> {
  const jar = await cookies();
  const raw = jar.get(loginCookieName())?.value;
  jar.delete(loginCookieName());
  if (!raw) return null;
  const plain = open(key(), Buffer.from(raw, 'base64url'), 'login');
  if (plain === null) return null;
  const parsed = JSON.parse(plain) as LoginTransaction & { exp: number };
  return parsed.exp > Date.now() ? parsed : null;
}

export async function startSession(tokens: TokenSet, previousCompanyId: string | null = null): Promise<void> {
  const jar = await cookies();
  const previous = jar.get(sessionCookieName())?.value;
  if (previous) await sessionStore().destroy(previous);
  const sessionId = randomToken();
  await sessionStore().create(
    sessionId,
    tokens.subject,
    { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, idToken: tokens.idToken },
    tokens.accessExpiresAt,
    randomToken(),
  );
  if (previousCompanyId !== null) await sessionStore().selectCompany(sessionId, previousCompanyId);
  jar.set(sessionCookieName(), sessionId, cookieOptions(env().SESSION_ABSOLUTE_HOURS * 3600));
}

export async function sessionId(): Promise<string | null> {
  return (await cookies()).get(sessionCookieName())?.value ?? null;
}

/**
 * The current session with a usable access token (refreshed when it is about
 * to expire), or null when signed out or the session cannot be refreshed.
 */
export async function currentSession(): Promise<StoredSession | null> {
  const id = await sessionId();
  if (!id) return null;
  const session = await sessionStore().find(id);
  if (session === null) return null;
  if (session.accessExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return session;
  if (session.tokens.refreshToken === null) return null;
  try {
    return await sessionStore().refreshTokens(id, new Date(Date.now() + REFRESH_MARGIN_MS), async (current) => {
      const next = await refreshTokens(session.subject, current.refreshToken!, current.idToken);
      return { tokens: { accessToken: next.accessToken, refreshToken: next.refreshToken, idToken: next.idToken }, accessExpiresAt: next.accessExpiresAt };
    });
  } catch {
    // The provider refused the refresh token (revoked or expired): sign in again.
    await sessionStore().destroy(id);
    return null;
  }
}

export async function endSession(): Promise<StoredSession | null> {
  const jar = await cookies();
  const id = jar.get(sessionCookieName())?.value;
  jar.delete(sessionCookieName());
  if (!id) return null;
  const session = await sessionStore().find(id);
  await sessionStore().destroy(id);
  return session;
}
