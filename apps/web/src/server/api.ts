import 'server-only';

import { redirect } from 'next/navigation';

import { ApiError, problemFromResponse } from '@/lib/problem';

import { env } from './env';
import { currentSession } from './session';

/**
 * Server-side API access for server components and route handlers. Uses the
 * session's access token (refreshed if needed) and the selected company.
 * Signed-out users are sent to sign in.
 */
export async function serverApi<T>(path: string, init: { companyId?: string | null; signal?: AbortSignal } = {}): Promise<T> {
  const session = await currentSession();
  if (session === null) redirect('/sign-in');
  const companyId = init.companyId === undefined ? session.companyId : init.companyId;
  const headers: Record<string, string> = { authorization: `Bearer ${session.tokens.accessToken}`, accept: 'application/json' };
  if (companyId) headers['x-company-id'] = companyId;
  const response = await fetch(`${env().API_BASE_URL}${path}`, { headers, cache: 'no-store', ...(init.signal ? { signal: init.signal } : {}) });
  if (!response.ok) throw await problemFromResponse(response);
  return (await response.json()) as T;
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}
