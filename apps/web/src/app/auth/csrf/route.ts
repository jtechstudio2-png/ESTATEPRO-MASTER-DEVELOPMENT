import { NextResponse } from 'next/server';

import { currentSession } from '@/server/session';

/**
 * The current session's CSRF token and company, for a page that was kept
 * open while its user signed in again in another tab (X-3). Same-origin
 * only: the response is JSON without CORS headers, so other sites cannot
 * read it, and it is never cached.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const headers = { 'cache-control': 'no-store' };
  if (request.headers.get('sec-fetch-site') === 'cross-site') return NextResponse.json({ status: 403 }, { status: 403, headers });
  const session = await currentSession();
  if (session === null) return NextResponse.json({ status: 401 }, { status: 401, headers });
  return NextResponse.json({ csrfToken: session.csrfToken, companyId: session.companyId }, { headers });
}
