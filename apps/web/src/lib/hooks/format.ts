'use client';

import { useMemo } from 'react';

import { useSession } from '@/components/session';

import { formatBytes, formatDate, formatDistance, formatMoney, formatNumber, formatRelative, type Money } from '../format';

/** Formatters bound to the member's locale and time zone (UI checklist §1, §9). */
export function useFormat() {
  const { session } = useSession();
  return useMemo(() => {
    const locale = session.locale;
    const zone = session.timezone;
    return {
      locale,
      timeZone: zone,
      money: (money: Money) => formatMoney(money, locale),
      number: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(value, locale, options),
      date: (iso: string, timeZone = zone) => formatDate(iso, locale, timeZone),
      dateTime: (iso: string, timeZone = zone) => formatDate(iso, locale, timeZone, true),
      relative: (iso: string, timeZone = zone) => formatRelative(iso, locale, timeZone),
      distance: (metres: number) => formatDistance(metres, locale),
      bytes: (bytes: number) => formatBytes(bytes, locale),
    };
  }, [session.locale, session.timezone]);
}
