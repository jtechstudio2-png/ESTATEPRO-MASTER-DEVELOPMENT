import { NextResponse } from 'next/server';

import { isApiError, serverApi } from '@/server/api';
import { csrfValid } from '@/server/csrf';
import { currentSession, sessionId, sessionStore } from '@/server/session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chooses the company to work in (S-1). The API confirms the membership by
 * answering /me/context for that company before it is stored in the session.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await currentSession();
  if (session === null) return NextResponse.json({ status: 401 }, { status: 401 });
  if (!csrfValid(request, session)) return NextResponse.json({ status: 403 }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { companyId?: unknown } | null;
  const companyId = typeof body?.companyId === 'string' && UUID.test(body.companyId) ? body.companyId.toLowerCase() : null;
  if (companyId === null) return NextResponse.json({ status: 422 }, { status: 422 });
  try {
    await serverApi('/api/v1/me/context', { companyId });
  } catch (error) {
    const status = isApiError(error) ? error.status : 502;
    return NextResponse.json(isApiError(error) ? error.problem : { status }, { status });
  }
  await sessionStore().selectCompany((await sessionId())!, companyId);
  return NextResponse.json({ companyId });
}
