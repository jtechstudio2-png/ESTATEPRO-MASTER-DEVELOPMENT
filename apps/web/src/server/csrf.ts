import 'server-only';

import { safeEqual } from './crypto';
import { env } from './env';
import type { StoredSession } from './session-store';

/**
 * Writes must come from our own pages: the Origin header must be ours (or,
 * when absent, Sec-Fetch-Site must be same-origin) and the X-CSRF-Token
 * header must match the session's token (UI checklist §10).
 */
export function csrfValid(request: Request, session: StoredSession): boolean {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const sameOrigin = origin !== null ? origin === env().WEB_ORIGIN : site === 'same-origin';
  const token = request.headers.get('x-csrf-token');
  return sameOrigin && token !== null && safeEqual(token, session.csrfToken);
}
