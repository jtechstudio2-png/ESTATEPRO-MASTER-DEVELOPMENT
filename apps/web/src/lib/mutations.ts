'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

/**
 * After a successful write every cached query is marked stale, so lists,
 * records, tab counts and dashboard panels all show the new state.
 */
export function useRefreshAll(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries(), [client]);
}
