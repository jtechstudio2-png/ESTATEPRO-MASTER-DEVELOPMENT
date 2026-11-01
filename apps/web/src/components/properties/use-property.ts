'use client';

import { useQuery } from '@tanstack/react-query';

import type { PropertyDto, PropertySummaryCountsDto } from '@/lib/api-schema';
import { bff, bffRequest } from '@/lib/bff';

/** The property record with its version (ETag) for If-Match. */
export function useProperty(id: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['record', 'property', id],
    queryFn: async () => {
      const response = await bffRequest<PropertyDto>(`properties/${id}`);
      return { ...response.data, version: response.version ?? response.data.version };
    },
  });
}

/** Counts for the overview and tab labels (A-8); sections without permission are null. */
export function usePropertySummary(id: string) {
  return useQuery({ queryKey: ['record', 'property-summary', id], queryFn: () => bff<PropertySummaryCountsDto>(`properties/${id}/summary`) });
}

export function propertyTitle(property: Pick<PropertyDto, 'reference' | 'name'>): string {
  return property.name ? `${property.reference} · ${property.name}` : property.reference;
}
