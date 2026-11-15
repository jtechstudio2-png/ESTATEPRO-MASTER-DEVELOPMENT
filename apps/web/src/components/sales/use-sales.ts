'use client';

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import type { DealDto, OfferPageDto, PipelineDto, ViewingDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

/** One deal (DL-3). Keys start with "record" so every write refreshes it (useRefreshAll). */
export function useDeal(id: string, enabled = true) {
  return useQuery({ queryKey: ['record', 'deal', id], queryFn: ({ signal }) => bff<DealDto>(`deals/${id}`, { signal }), enabled: enabled && id !== '' });
}

export function useViewing(id: string | null) {
  return useQuery({ queryKey: ['record', 'viewing', id], queryFn: ({ signal }) => bff<ViewingDto>(`viewings/${id}`, { signal }), enabled: id !== null });
}

/** All offers of a deal, oldest first (O-1 builds the chain). */
export function useDealOffers(dealId: string, enabled = true) {
  return useQuery({
    queryKey: ['record', 'deal-offers', dealId],
    queryFn: ({ signal }) => bff<OfferPageDto>(`offers?filter[dealId]=${dealId}&sort=submittedAt&limit=100`, { signal }),
    enabled: enabled && dealId !== '',
  });
}

export function usePipeline(dealType: string, filters: { officeId?: string | null; ownerMembershipId?: string | null }) {
  const params = new URLSearchParams({ dealType });
  if (filters.officeId) params.set('officeId', filters.officeId);
  if (filters.ownerMembershipId) params.set('ownerMembershipId', filters.ownerMembershipId);
  return useQuery({ queryKey: ['list', 'pipeline', params.toString()], queryFn: ({ signal }) => bff<PipelineDto>(`deals/pipeline?${params.toString()}`, { signal }) });
}

/**
 * One write from a dialog: busy state, the error for FormProblem, a refresh
 * of every cached query and a polite announcement on success. A stale version
 * (412) refreshes the record so the next attempt has the current one.
 */
export function useAction() {
  const refresh = useRefreshAll();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    async <T>(work: () => Promise<T>, message: string, after?: (result: T) => void) => {
      setBusy(true);
      setError(null);
      try {
        const result = await work();
        announce(message);
        await refresh();
        after?.(result);
        return true;
      } catch (caught) {
        setError(caught);
        if (caught instanceof ApiError && caught.status === 412) await refresh();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [announce, refresh],
  );
  return { busy, error, setError, run };
}

/** Phones (≤ 767 px) get the reduced Phase 6 scope (W-D4). */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}
