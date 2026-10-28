'use client';

import { useQuery } from '@tanstack/react-query';

import { useSession } from '@/components/session';
import type { CountryListDto, OfficeListDto, PicklistDto, PropertyTypeListDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';

const REFERENCE_STALE = 10 * 60_000;

/** Offices the member may filter by or place records in (office-scoped roles see their own). */
export function useOffices(permission = 'property.view') {
  const { session, grant } = useSession();
  const result = useQuery({ queryKey: ['reference', 'offices'], queryFn: () => bff<OfficeListDto>('offices'), staleTime: REFERENCE_STALE });
  const scope = grant(permission)?.scope;
  const offices = (result.data?.data ?? []).filter((office) => office.archivedAt === null && (scope === 'all' || session.officeIds.includes(office.id)));
  return { ...result, offices };
}

export function usePropertyTypes(filters: { appliesTo?: string; countryCode?: string; active?: boolean } = {}) {
  return useQuery({
    queryKey: ['reference', 'property-types', filters],
    queryFn: () =>
      bff<PropertyTypeListDto>(
        `property-types${query({ 'filter[appliesTo]': filters.appliesTo, 'filter[countryCode]': filters.countryCode, 'filter[active]': filters.active === undefined ? undefined : String(filters.active) })}`,
      ),
    staleTime: REFERENCE_STALE,
  });
}

export function useCountries() {
  return useQuery({ queryKey: ['reference', 'countries'], queryFn: () => bff<CountryListDto>('reference/countries'), staleTime: REFERENCE_STALE });
}

export function usePicklist(listKey: string, countryCode?: string) {
  const { session } = useSession();
  return useQuery({
    queryKey: ['reference', 'picklist', listKey, countryCode, session.locale],
    queryFn: () => bff<PicklistDto>(`reference/picklists/${listKey}${query({ countryCode, locale: session.locale })}`),
    staleTime: REFERENCE_STALE,
  });
}
