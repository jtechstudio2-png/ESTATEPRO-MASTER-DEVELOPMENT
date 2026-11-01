import { NextResponse } from 'next/server';

import { csrfValid } from '@/server/csrf';
import { env } from '@/server/env';
import { endSessionUrl } from '@/server/oidc';
import { currentSession, endSession } from '@/server/session';

/** Signs out: deletes the server-side session, then signs out at the provider when it supports it. */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await currentSession();
  if (session !== null && !csrfValid(request, session)) return NextResponse.json({ status: 403 }, { status: 403 });
  const ended = await endSession();
  const providerLogout = await endSessionUrl(ended?.tokens.idToken ?? null).catch(() => null);
  return NextResponse.json({ redirectTo: providerLogout?.toString() ?? `${env().WEB_ORIGIN}/sign-in?signedOut=1` });
}
