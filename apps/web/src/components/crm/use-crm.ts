'use client';

import { useQuery } from '@tanstack/react-query';

import type { ContactDto, CrmSettingsDto, LeadDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';

/** One contact (C-2). Keys start with "record" so every write refreshes it (useRefreshAll). */
export function useContact(id: string, enabled = true) {
  return useQuery({ queryKey: ['record', 'contact', id], queryFn: ({ signal }) => bff<ContactDto>(`contacts/${id}`, { signal }), enabled: enabled && id !== '' });
}

export function useLead(id: string) {
  return useQuery({ queryKey: ['record', 'lead', id], queryFn: ({ signal }) => bff<LeadDto>(`leads/${id}`, { signal }) });
}

/** The company's lead response target (D3); null means "not set". */
export function useCrmSettings(enabled = true) {
  return useQuery({ queryKey: ['reference', 'crm-settings'], queryFn: () => bff<CrmSettingsDto>('settings/crm'), staleTime: 5 * 60_000, enabled });
}

/** A `tel:` link for a phone number in any written format (Call actions, C-2 and D-M). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}
