'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';

import { useAnnounce } from '@/components/announcer';
import { bff } from '@/lib/bff';

export interface Page<T> {
  data: T[];
  page: { limit: number; nextCursor: string | null };
}

/**
 * A cursor-paginated API list with "Load more" (UI checklist §3). New pages
 * are announced politely; a filter change (new query) starts from page one.
 */
export function usePagedList<T>(path: string, query: URLSearchParams, options: { limit?: number; enabled?: boolean; noun?: string } = {}) {
  const t = useTranslations('list');
  const announce = useAnnounce();
  const base = new URLSearchParams(query);
  base.set('limit', String(options.limit ?? 50));
  const key = `${path}?${base.toString()}`;
  const result = useInfiniteQuery({
    queryKey: ['list', key],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams(base);
      if (pageParam) params.set('cursor', pageParam);
      return bff<Page<T>>(`${path}?${params.toString()}`, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.page.nextCursor,
    enabled: options.enabled ?? true,
  });
  const rows = result.data?.pages.flatMap((page) => page.data) ?? [];
  const pageCount = result.data?.pages.length ?? 0;
  const previousPages = useRef(pageCount);
  useEffect(() => {
    if (pageCount > previousPages.current && result.data) {
      const added = result.data.pages[pageCount - 1]?.data.length ?? 0;
      announce(t('loadedMore', { count: added }));
    }
    previousPages.current = pageCount;
  }, [pageCount, result.data, announce, t]);
  const loadMore = useCallback(() => void result.fetchNextPage(), [result]);
  return { ...result, rows, loadMore };
}
