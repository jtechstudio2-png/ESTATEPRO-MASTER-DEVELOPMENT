import { NextResponse } from 'next/server';

import { csrfValid } from '@/server/csrf';
import { env } from '@/server/env';
import { currentSession } from '@/server/session';

const SEGMENT = /^[A-Za-z0-9._~-]{1,100}$/;
const FORWARD_REQUEST = ['accept', 'content-type', 'if-match', 'idempotency-key'] as const;
const FORWARD_RESPONSE = ['content-type', 'etag', 'retry-after'] as const;
const READ = new Set(['GET', 'HEAD']);
const MAX_BODY_BYTES = 1_000_000;

function problem(status: number, code: string, title: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: `urn:estatepro:problem:${code}`, title, status, detail },
    { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } },
  );
}

/**
 * The browser's only way to the API (W-D9): adds the session's access token
 * and company, checks CSRF on writes, and forwards the request unchanged
 * otherwise. Paths map /bff/{path} → {API}/api/v1/{path}.
 */
async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const { path } = await context.params;
  // "." and ".." would step outside /api/v1 once the URL is resolved.
  if (path.length === 0 || !path.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
    return problem(404, 'not-found', 'Not found', 'No endpoint matches this path.');
  }
  const session = await currentSession();
  if (session === null) return problem(401, 'unauthenticated', 'Authentication required', 'Your session has ended. Sign in again.');
  if (!READ.has(request.method) && !csrfValid(request, session)) {
    return problem(403, 'csrf-failed', 'Request not allowed', 'This request did not come from EstatePro. Reload the page and try again.');
  }
  if (session.companyId === null && path[0] !== 'me') {
    return problem(409, 'company-required', 'Choose a company', 'Choose the company you are working in first.');
  }

  const headers: Record<string, string> = { authorization: `Bearer ${session.tokens.accessToken}` };
  if (session.companyId !== null) headers['x-company-id'] = session.companyId;
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  let body: ArrayBuffer | undefined;
  if (!READ.has(request.method)) {
    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return problem(413, 'payload-too-large', 'Payload too large', 'The request body is too large.');
  }

  const search = new URL(request.url).search;
  let upstream: Response;
  try {
    upstream = await fetch(`${env().API_BASE_URL}/api/v1/${path.join('/')}${search}`, {
      method: request.method,
      headers,
      ...(body !== undefined && body.byteLength > 0 ? { body } : {}),
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return problem(502, 'api-unreachable', 'Service unavailable', 'EstatePro could not be reached. Try again shortly.');
  }

  const responseHeaders = new Headers({ 'cache-control': 'no-store' });
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  const location = upstream.headers.get('location');
  if (location !== null) responseHeaders.set('location', location.replace(/^\/api\/v1\//, '/bff/'));
  const payload = upstream.status === 204 ? null : await upstream.arrayBuffer();
  return new NextResponse(payload, { status: upstream.status, headers: responseHeaders });
}

export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST, proxy as PUT };
