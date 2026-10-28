import { describe, expect, it } from 'vitest';

import { formatBytes, formatDate, formatDistance, formatMoney, formatNumber, formatRelative } from '@/lib/format';

describe('formatting', () => {
  it('formats money in its own currency, and falls back for an unknown code', () => {
    expect(formatMoney({ amount: '6000.00', currency: 'GHS' }, 'en-GH')).toMatch(/6,000\.00/);
    expect(formatMoney({ amount: '1250.5', currency: 'GBP' }, 'en-GB')).toBe('£1,250.50');
    expect(formatMoney({ amount: '10', currency: 'NOT-A-CODE' }, 'en-GB')).toBe('NOT-A-CODE 10');
  });

  it('formats numbers, dates and date-only values in the Gregorian calendar', () => {
    expect(formatNumber(1234.5, 'en-GB')).toBe('1,234.5');
    expect(formatDate('2026-10-28', 'en-GB', 'Asia/Qatar')).toBe('28 Oct 2026');
    expect(formatDate('2026-10-28T21:30:00Z', 'en-GB', 'Asia/Qatar', true)).toBe('29 Oct 2026, 00:30');
    expect(formatDate('2026-10-28', 'ar-QA', 'Asia/Qatar')).toMatch(/2026|٢٠٢٦/);
  });

  it('describes nearby times relatively and keeps the absolute time', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(formatRelative('2026-10-28T11:30:00Z', 'en-GB', 'UTC', now).text).toBe('30 minutes ago');
    expect(formatRelative('2026-10-28T15:00:00Z', 'en-GB', 'UTC', now).text).toBe('in 3 hours');
    expect(formatRelative('2026-10-25T12:00:00Z', 'en-GB', 'UTC', now).text).toBe('3 days ago');
    const far = formatRelative('2026-09-01T12:00:00Z', 'en-GB', 'UTC', now);
    expect(far.text).toBe('1 Sept 2026');
    expect(far.absolute).toBe('1 Sept 2026, 12:00');
  });

  it('formats distances and sizes', () => {
    expect(formatDistance(420, 'en-GB')).toBe('420 m');
    expect(formatDistance(2400, 'en-GB')).toBe('2.4 km');
    expect(formatBytes(512, 'en-GB')).toBe('512 byte');
    expect(formatBytes(4.2 * 1024 * 1024, 'en-GB')).toBe('4.2 MB');
    expect(formatBytes(3 * 1024 ** 5, 'en-GB')).toBe('3,072 TB');
  });
});
