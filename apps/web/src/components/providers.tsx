'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type AbstractIntlMessages, NextIntlClientProvider, useTranslations } from 'next-intl';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { I18nProvider, RouterProvider } from 'react-aria-components';

import { SESSION_ENDED_EVENT, setCsrfToken } from '@/lib/bff';
import { ApiError } from '@/lib/problem';

import { AnnouncerProvider } from './announcer';
import { hasUnsavedChanges } from './ui/unsaved-guard';
import { type MapConfig, MapConfigProvider } from './map/map-config';

interface ProvidersProps {
  children: ReactNode;
  locale: string;
  language: string;
  timeZone: string;
  messages: AbstractIntlMessages;
  csrfToken: string | null;
  /** Cache scope: everything cached belongs to this company (cleared on switch). */
  companyId: string | null;
  mapConfig: MapConfig;
}

function retry(failureCount: number, error: unknown): boolean {
  // Only transient failures are retried; problems from the API are answers.
  if (error instanceof ApiError) return error.status >= 502 && failureCount < 2;
  return failureCount < 2;
}

export function Providers({ children, locale, language, timeZone, messages, csrfToken, companyId, mapConfig }: ProvidersProps) {
  const router = useRouter();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry, staleTime: 30_000, refetchOnWindowFocus: true }, mutations: { retry: false } },
      }),
  );
  setCsrfToken(csrfToken);
  // Switching company never shows data cached for the previous one (UI checklist §10).
  // Only a change clears the cache: clearing on first mount would orphan queries in flight.
  const cachedFor = useRef(companyId);
  useEffect(() => {
    if (cachedFor.current === companyId) return;
    cachedFor.current = companyId;
    queryClient.clear();
  }, [companyId, queryClient]);

  return (
    <NextIntlClientProvider locale={language} messages={messages} timeZone={timeZone}>
      <I18nProvider locale={locale}>
        <RouterProvider navigate={(href) => router.push(href)}>
          <QueryClientProvider client={queryClient}>
            <MapConfigProvider value={mapConfig}>
              <AnnouncerProvider>
                <SessionEnded companyId={companyId} />
                {children}
              </AnnouncerProvider>
            </MapConfigProvider>
          </QueryClientProvider>
        </RouterProvider>
      </I18nProvider>
    </NextIntlClientProvider>
  );
}

/**
 * The session ended (a 401 from the BFF). With nothing unsaved, go to
 * sign-in and come back here afterwards. With unsaved changes (X-3), keep
 * the page and its draft in memory and offer sign-in in a new tab; nothing
 * is written to device storage. Back on this page, the new session's CSRF
 * token is picked up, provided it is for the same company.
 */
function SessionEnded({ companyId }: { companyId: string | null }) {
  const t = useTranslations('errors');
  const [kept, setKept] = useState(false);
  const [problem, setProblem] = useState<'signedOut' | 'otherCompany' | null>(null);
  useEffect(() => {
    const ended = () => {
      if (hasUnsavedChanges()) {
        setKept(true);
        return;
      }
      window.location.assign(`/sign-in?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    };
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, ended);
  }, []);

  const resume = async () => {
    const response = await fetch('/auth/csrf', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    if (!response?.ok) {
      setProblem('signedOut');
      return;
    }
    const current = (await response.json()) as { csrfToken: string; companyId: string | null };
    if (current.companyId !== companyId) {
      setProblem('otherCompany');
      return;
    }
    setCsrfToken(current.csrfToken);
    setProblem(null);
    setKept(false);
  };

  if (!kept) return null;
  return (
    <div role="alert" className="ep-session-ended">
      <strong>{t('sessionTitle')}</strong> {t('sessionKeptDetail')}{' '}
      <a href="/sign-in?returnTo=%2Fdashboard" target="_blank" rel="noopener">
        {t('signInNewTab')}
      </a>{' '}
      <button type="button" onClick={() => void resume()}>
        {t('sessionSignedIn')}
      </button>
      {problem ? <span>{problem === 'signedOut' ? t('sessionStillSignedOut') : t('sessionOtherCompany')}</span> : null}
    </div>
  );
}
