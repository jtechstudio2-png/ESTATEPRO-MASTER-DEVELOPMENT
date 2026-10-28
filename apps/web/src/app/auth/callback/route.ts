import { type NextRequest, NextResponse } from 'next/server';

import { env } from '@/server/env';
import { completeLogin } from '@/server/oidc';
import { currentSession, startSession, takeLoginTransaction } from '@/server/session';

/** Completes the OIDC flow: checks state, nonce and PKCE, then starts a server-side session. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = env().WEB_ORIGIN;
  const transaction = await takeLoginTransaction();
  if (transaction === null) return NextResponse.redirect(`${origin}/sign-in?error=expired`, { status: 303 });
  if (request.nextUrl.searchParams.has('error')) {
    return NextResponse.redirect(`${origin}/sign-in?error=denied`, { status: 303 });
  }
  try {
    // The callback URL as the provider saw it (the app may run behind a proxy).
    const callback = new URL(`${origin}/auth/callback${request.nextUrl.search}`);
    const tokens = await completeLogin(callback, transaction);
    // A step-up sign-in keeps the company the user was working in.
    const previous = transaction.stepUp ? await currentSession() : null;
    await startSession(tokens, previous !== null && previous.subject === tokens.subject ? previous.companyId : null);
  } catch {
    return NextResponse.redirect(`${origin}/sign-in?error=failed`, { status: 303 });
  }
  return NextResponse.redirect(`${origin}${transaction.returnTo}`, { status: 303 });
}
