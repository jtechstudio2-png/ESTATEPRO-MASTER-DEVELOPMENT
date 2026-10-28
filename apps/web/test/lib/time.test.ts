import { describe, expect, it } from 'vitest';

import { instantToZoned, todayIn, zonedToInstant } from '@/lib/time';

describe('wall-clock times in a time zone', () => {
  it('turns a local time into an instant and back', () => {
    expect(zonedToInstant('2026-10-28T17:00', 'Africa/Accra')).toBe('2026-10-28T17:00:00.000Z');
    expect(zonedToInstant('2026-10-28T17:00', 'Asia/Qatar')).toBe('2026-10-28T14:00:00.000Z');
    expect(instantToZoned('2026-10-28T14:00:00.000Z', 'Asia/Qatar')).toBe('2026-10-28T17:00');
  });

  it('settles the offset across a daylight-saving change (London)', () => {
    // 25 Oct 2026: clocks go back at 02:00 BST. Before: UTC+1; after: UTC+0.
    expect(zonedToInstant('2026-10-24T09:00', 'Europe/London')).toBe('2026-10-24T08:00:00.000Z');
    expect(zonedToInstant('2026-10-26T09:00', 'Europe/London')).toBe('2026-10-26T09:00:00.000Z');
    expect(instantToZoned('2026-07-01T12:00:00.000Z', 'Europe/London')).toBe('2026-07-01T13:00');
  });

  it('rejects malformed input and gives today in a zone', () => {
    expect(zonedToInstant('28/10/2026 17:00', 'Europe/London')).toBeNull();
    expect(todayIn('Asia/Qatar', new Date('2026-10-28T22:30:00Z'))).toBe('2026-10-29');
    expect(todayIn('Africa/Accra', new Date('2026-10-28T22:30:00Z'))).toBe('2026-10-28');
  });
});
