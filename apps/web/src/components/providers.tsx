'use client';

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type AbstractIntlMessages, NextIntlClientProvider } from 'next-intl';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { I18nProvider, RouterProvider } from 'react-aria-components';

import { setCsrfToken } from '@/lib/bff';
import { ApiError } from '@/lib/problem';

import { AnnouncerProvider } from './announcer';
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
        queryCache: new QueryCache({
          onError: (error) => {
            // The session ended: go to sign-in and come back here afterwards.
            if (error instanceof ApiError && error.status === 401) {
              window.location.assign(`/sign-in?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
            }
          },
        }),
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
              <AnnouncerProvider>{children}</AnnouncerProvider>
            </MapConfigProvider>
          </QueryClientProvider>
        </RouterProvider>
      </I18nProvider>
    </NextIntlClientProvider>
  );
}
