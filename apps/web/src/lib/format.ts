/**
 * Locale-aware formatting (UI checklist §1, §9). Amounts arrive as decimal
 * strings with their currency (ADR-003 §5) and are never summed across
 * currencies. Dates use the Gregorian calendar.
 */
export interface Money {
  amount: string;
  currency: string;
}

export function formatMoney(money: Money, locale: string): string {
  const value = Number(money.amount);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency, currencyDisplay: 'symbol' }).format(value);
  } catch {
    return `${money.currency} ${money.amount}`;
  }
}

export function formatNumber(value: number, locale: string, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(iso: string, locale: string, timeZone: string, withTime = false): string {
  const date = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat(locale, {
    calendar: 'gregory',
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
    timeZone: iso.length === 10 ? 'UTC' : timeZone,
  }).format(date);
}

/** "in 3 days", "2 hours ago" within 7 days; absolute otherwise (Phase 3 07 §3). */
export function formatRelative(iso: string, locale: string, timeZone: string, now = Date.now()): { text: string; absolute: string } {
  const absolute = formatDate(iso, locale, timeZone, true);
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs > 7 * 86_400_000) return { text: formatDate(iso, locale, timeZone), absolute };
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 3_600_000) return { text: rtf.format(Math.round(diff / 60_000), 'minute'), absolute };
  if (abs < 86_400_000) return { text: rtf.format(Math.round(diff / 3_600_000), 'hour'), absolute };
  return { text: rtf.format(Math.round(diff / 86_400_000), 'day'), absolute };
}

export function formatDistance(metres: number, locale: string): string {
  if (metres < 1000) return new Intl.NumberFormat(locale, { style: 'unit', unit: 'meter', maximumFractionDigits: 0 }).format(metres);
  return new Intl.NumberFormat(locale, { style: 'unit', unit: 'kilometer', maximumFractionDigits: 1 }).format(metres / 1000);
}

export function formatBytes(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: units[unit], unitDisplay: 'short', maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
}
