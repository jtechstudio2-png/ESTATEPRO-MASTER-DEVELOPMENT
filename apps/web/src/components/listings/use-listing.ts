'use client';

import { useQuery } from '@tanstack/react-query';

import { useSession } from '@/components/session';
import type { ListingDto, ListingReadinessDto } from '@/lib/api-schema';
import { bff, bffRequest } from '@/lib/bff';

export function useListing(id: string) {
  return useQuery({
    queryKey: ['record', 'listing', id],
    queryFn: async () => {
      const response = await bffRequest<ListingDto>(`listings/${id}`);
      return { ...response.data, version: response.version ?? response.data.version };
    },
  });
}

/** Publish readiness (A-10): what stops the listing going live now. */
export function useReadiness(id: string, enabled = true) {
  return useQuery({ queryKey: ['record', 'listing-readiness', id], queryFn: () => bff<ListingReadinessDto>(`listings/${id}/readiness`), enabled });
}

/**
 * Whether the member's grant covers this listing for a permission (ADR-004):
 * all → any; office → listings of their offices; own → listings assigned to them
 * (listing-access.ts listingWithin).
 * The API decides in the end; this only hides actions that would be refused.
 */
export function useListingGrant() {
  const { grant, session, readOnly } = useSession();
  return (permission: string, listing: Pick<ListingDto, 'office' | 'agent'>): boolean => {
    if (readOnly) return false;
    const scope = grant(permission)?.scope;
    if (scope === 'all') return true;
    if (scope === 'office') return session.officeIds.includes(listing.office.id);
    if (scope === 'own') return listing.agent.membershipId === session.membershipId;
    return false;
  };
}
