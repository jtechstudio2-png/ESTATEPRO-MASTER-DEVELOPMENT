import 'server-only';

import { headers } from 'next/headers';
import { cache } from 'react';

import { type MeResponse, type SessionContext, uiLanguage } from '@/lib/session-types';

import { isApiError, serverApi } from './api';
import { currentSession } from './session';

export interface PageContext {
  signedIn: boolean;
  session: SessionContext | null;
  csrfToken: string | null;
  /** Full locale for formatting (e.g. ar-QA) and the interface language. */
  locale: string;
  language: 'en' | 'ar';
  direction: 'ltr' | 'rtl';
}

async function acceptLanguage(): Promise<string> {
  const header = (await headers()).get('accept-language') ?? '';
  return header.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

/**
 * The signed-in member's context for this request (cached per request). When
 * no company is chosen, or the membership was ended, `session` is null.
 */
export const pageContext = cache(async (): Promise<PageContext> => {
  const stored = await currentSession();
  if (stored === null) {
    const locale = await acceptLanguage();
    return { signedIn: false, session: null, csrfToken: null, locale, language: uiLanguage(locale), direction: locale === 'ar' ? 'rtl' : 'ltr' };
  }
  let session: SessionContext | null = null;
  if (stored.companyId !== null) {
    try {
      session = await serverApi<SessionContext>('/api/v1/me/context');
    } catch (error) {
      if (!isApiError(error, 403) && !isApiError(error, 404)) throw error;
    }
  }
  const locale = session?.locale ?? (await acceptLanguage());
  return {
    signedIn: true,
    session,
    csrfToken: stored.csrfToken,
    locale,
    language: uiLanguage(locale),
    direction: session?.textDirection ?? (uiLanguage(locale) === 'ar' ? 'rtl' : 'ltr'),
  };
});

export const myMemberships = cache(async (): Promise<MeResponse> => serverApi<MeResponse>('/api/v1/me', { companyId: null }));
