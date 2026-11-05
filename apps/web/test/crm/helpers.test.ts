import { describe, expect, it } from 'vitest';

import { quickPick } from '@/components/activity/follow-up-dialog';
import { dayBounds } from '@/components/activity/follow-ups-list';
import { marketingWithdrawn, messageChannels } from '@/components/contacts/contact-frame';
import { currentConsents } from '@/components/contacts/consent-tab';
import type { ConsentDto, ContactDto } from '@/lib/api-schema';

const consent = (over: Partial<ConsentDto>): ConsentDto => ({
  id: crypto.randomUUID(),
  purpose: 'marketing',
  channel: 'email',
  status: 'granted',
  lawfulBasis: 'consent',
  capturedAt: '2026-10-01T10:00:00Z',
  capturedVia: 'web_form',
  evidence: null,
  capturedByMembershipId: null,
  ...over,
});

describe('follow-up quick picks (F-1) in the member time zone', () => {
  it('picks later today on the hour, tomorrow 10:00 and next Monday 10:00 in Accra and Doha', () => {
    // Wednesday 4 November 2026, 13:20 UTC.
    const now = new Date('2026-11-04T13:20:00Z');
    expect(quickPick('later', 'Africa/Accra', now)).toBe('2026-11-04T15:00');
    expect(quickPick('later', 'Asia/Qatar', now)).toBe('2026-11-04T18:00');
    expect(quickPick('tomorrow', 'Africa/Accra', now)).toBe('2026-11-05T10:00');
    expect(quickPick('nextWeek', 'Africa/Accra', now)).toBe('2026-11-09T10:00');
    // Late on Sunday in Doha is already Monday: next Monday is a week on.
    expect(quickPick('nextWeek', 'Asia/Qatar', new Date('2026-11-08T22:00:00Z'))).toBe('2026-11-16T10:00');
  });

  it('bounds today and the week (Monday to Sunday) as instants in the zone', () => {
    const bounds = dayBounds('Asia/Qatar', new Date('2026-11-04T13:20:00Z'));
    expect(bounds.startOfToday).toBe('2026-11-03T21:00:00.000Z');
    expect(bounds.endOfToday).toBe('2026-11-04T20:59:00.000Z');
    expect(bounds.endOfWeek).toBe('2026-11-08T20:59:00.000Z');
    const london = dayBounds('Europe/London', new Date('2026-11-08T12:00:00Z'));
    expect(london.endOfWeek).toBe('2026-11-08T23:59:00.000Z');
  });
});

describe('consent (C-6)', () => {
  it('takes the latest row per purpose and channel as the current state', () => {
    const rows = [
      consent({ capturedAt: '2026-09-01T10:00:00Z', status: 'granted' }),
      consent({ capturedAt: '2026-10-12T16:02:00Z', status: 'withdrawn' }),
      consent({ purpose: 'property_alerts', channel: 'whatsapp', capturedAt: '2026-09-02T10:14:00Z' }),
      consent({ purpose: 'data_processing', channel: null, lawfulBasis: 'contract' }),
    ];
    const current = currentConsents(rows);
    expect(current).toHaveLength(3);
    expect(current.find((row) => row.purpose === 'marketing')!.status).toBe('withdrawn');
  });
});

describe('message actions (C-2)', () => {
  const contact = {
    methods: [
      { id: 'm1', methodType: 'mobile', value: '+233245554412', label: null, isPrimary: true, verifiedAt: null, optedOutAt: null },
      { id: 'm2', methodType: 'whatsapp', value: '+233245554412', label: null, isPrimary: false, verifiedAt: '2026-09-01T00:00:00Z', optedOutAt: null },
      { id: 'm3', methodType: 'email', value: 'ama@example.test', label: null, isPrimary: false, verifiedAt: null, optedOutAt: '2026-10-12T16:02:00Z' },
      { id: 'm4', methodType: 'fax', value: '+233302000000', label: null, isPrimary: false, verifiedAt: null, optedOutAt: null },
    ],
    consents: [consent({ status: 'withdrawn', capturedAt: '2026-10-12T16:02:00Z' }), consent({ purpose: 'property_alerts', channel: 'whatsapp' })],
  } as unknown as ContactDto;

  it('offers SMS, WhatsApp and email, and blocks a channel the person opted out of', () => {
    const channels = messageChannels(contact);
    expect(channels.map((entry) => [entry.channel, entry.blocked])).toEqual([
      ['sms', false],
      ['whatsapp', false],
      ['email', true],
    ]);
  });

  it('warns about withdrawn marketing consent only', () => {
    expect(marketingWithdrawn(contact)).toHaveLength(1);
  });
});
