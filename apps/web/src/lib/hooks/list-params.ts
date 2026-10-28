'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

const UI_ONLY = ['cursor', 'view', 'tab', 'unit', 'source', 'nearLabel', 'media', 'holderName', 'pane', 'compose', 'upload'];

/**
 * List state lives in the URL (UI checklist §2): filters, sort and search use
 * the API's own parameter names (`filter[status]`, `sort`, `q`), so the page
 * query is forwarded to the API unchanged and links can be shared.
 */
export function useListParams() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const get = useCallback((key: string): string | null => searchParams.get(key), [searchParams]);
  const getList = useCallback((key: string): string[] => searchParams.get(key)?.split(',').filter(Boolean) ?? [], [searchParams]);

  const set = useCallback(
    (updates: Record<string, string | string[] | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        const text = Array.isArray(value) ? value.join(',') : value;
        if (text === null || text === '') next.delete(key);
        else next.set(key, text);
      }
      // A filter or sort change starts again from the first page.
      next.delete('cursor');
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const clear = useCallback(
    (keep: string[] = []) => {
      const next = new URLSearchParams();
      for (const key of keep) {
        const value = searchParams.get(key);
        if (value !== null) next.set(key, value);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  /** Replaces the whole query (saved views). */
  const replaceAll = useCallback(
    (query: string) => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  /** The API query for this list: the URL's own parameters (no cursor). */
  const apiQuery = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    // Interface-only parameters never go to the API.
    for (const key of UI_ONLY) params.delete(key);
    return params;
  }, [searchParams]);

  return { get, getList, set, clear, replaceAll, apiQuery, searchParams };
}
