import { type NextRequest, NextResponse } from 'next/server';

import { startLogin } from '@/server/oidc';
import { safeReturnTo } from '@/server/return-to';
import { saveLoginTransaction } from '@/server/session';

/** Starts the OIDC Authorization Code flow with PKCE (W-D9). `stepUp=1` forces a fresh sign-in for MFA. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const stepUp = request.nextUrl.searchParams.get('stepUp') === '1';
  const { url, transaction } = await startLogin(returnTo, stepUp);
  await saveLoginTransaction(transaction);
  return NextResponse.redirect(url, { status: 303 });
}
