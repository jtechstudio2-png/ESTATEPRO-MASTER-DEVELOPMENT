import { describe, expect, it } from 'vitest';

import { buildNavigation, buildQuickCreate } from '@/components/shell/navigation';
import { addAmounts, addDays, calendarCells, quarterStart, sumForecast, dropOutcome, forecastScale, monthEnd, offerThreads, shownOnCalendar, splitsComplete, splitsTotal, weekDays } from '@/components/sales/sales-rules';
import type { Grant } from '@/lib/session-types';
import { instantToZoned } from '@/lib/time';

const STAGES = {
  lead: { id: 's1', stageClass: 'lead' },
  qualification: { id: 's2', stageClass: 'qualification' },
  negotiation: { id: 's4', stageClass: 'negotiation' },
  offerAccepted: { id: 's5', stageClass: 'offer_accepted' },
  contract: { id: 's6', stageClass: 'contract' },
  won: { id: 's7', stageClass: 'closed_won' },
  lost: { id: 's8', stageClass: 'closed_lost' },
};

describe('pipeline board moves (PB-1, W-D1)', () => {
  it('moves only to the stages the API allows', () => {
    expect(dropOutcome('s1', STAGES.qualification, [{ id: 's2' }, { id: 's4' }])).toEqual({ kind: 'move' });
    expect(dropOutcome('s1', STAGES.negotiation, [{ id: 's2' }, { id: 's4' }])).toEqual({ kind: 'move' });
  });

  it('does nothing when a card is dropped on its own column', () => {
    expect(dropOutcome('s1', STAGES.lead, [{ id: 's2' }])).toEqual({ kind: 'none' });
  });

  it('explains the action that reaches a later stage instead of moving', () => {
    expect(dropOutcome('s4', STAGES.offerAccepted, [{ id: 's1' }])).toEqual({ kind: 'action', action: 'accept' });
    expect(dropOutcome('s5', STAGES.contract, [])).toEqual({ kind: 'action', action: 'exchange' });
    expect(dropOutcome('s6', STAGES.won, [])).toEqual({ kind: 'action', action: 'complete' });
    expect(dropOutcome('s6', STAGES.lost, [])).toEqual({ kind: 'action', action: 'lose' });
  });

  it('refuses an early stage the deal may not move to', () => {
    expect(dropOutcome('s4', STAGES.lead, [{ id: 's2' }])).toEqual({ kind: 'refused' });
  });
});

describe('commission splits (DL-4, S3-D6)', () => {
  it('totals to four decimal places without floating-point drift', () => {
    expect(splitsTotal(['33.3333', '66.6667'])).toBe(1_000_000);
    expect(splitsTotal([0.1, 0.2])).toBe(3_000);
    expect(splitsComplete(['60', '40'])).toBe(true);
    expect(splitsComplete(['60', '30'])).toBe(false);
    expect(splitsComplete(['33.3333', '33.3333', '33.3334'])).toBe(true);
  });

  it('accepts a deal without agents', () => {
    expect(splitsComplete([])).toBe(true);
  });
});

describe('calendar weeks (V-1, W-D3)', () => {
  it('returns Monday to Sunday around any day, across months and years', () => {
    expect(weekDays('2026-11-18')).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
    expect(weekDays('2026-11-22')[0]).toBe('2026-11-16');
    expect(weekDays('2026-11-16', 1)[0]).toBe('2026-11-23');
    expect(weekDays('2026-01-01', -1)).toEqual(['2025-12-22', '2025-12-23', '2025-12-24', '2025-12-25', '2025-12-26', '2025-12-27', '2025-12-28']);
  });

  it('adds days across a month end', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('hides cancelled viewings unless asked and never draws superseded ones', () => {
    expect(shownOnCalendar('scheduled', false)).toBe(true);
    expect(shownOnCalendar('cancelled', false)).toBe(false);
    expect(shownOnCalendar('cancelled', true)).toBe(true);
    expect(shownOnCalendar('rescheduled', true)).toBe(false);
  });

  it('places viewings by local day and hour in the shown time zone and widens the hours when needed', () => {
    const days = weekDays('2026-11-18');
    const toLocal = (iso: string) => instantToZoned(iso, 'Asia/Qatar');
    const viewings = [
      { id: 'b', scheduledStart: '2026-11-18T07:30:00Z', status: 'confirmed' }, // 10:30 in Doha
      { id: 'a', scheduledStart: '2026-11-18T07:00:00Z', status: 'scheduled' }, // 10:00 in Doha
      { id: 'c', scheduledStart: '2026-11-19T02:00:00Z', status: 'scheduled' }, // 05:00 in Doha
      { id: 'd', scheduledStart: '2026-11-20T08:00:00Z', status: 'cancelled' },
      { id: 'e', scheduledStart: '2026-12-01T08:00:00Z', status: 'scheduled' }, // another week
    ];
    const { cells, hours } = calendarCells(viewings, days, toLocal, false);
    expect(cells.get('2026-11-18|10')?.map((viewing) => viewing.id)).toEqual(['a', 'b']);
    expect(cells.get('2026-11-19|05')?.map((viewing) => viewing.id)).toEqual(['c']);
    expect(cells.has('2026-11-20|11')).toBe(false);
    expect(hours[0]).toBe(5);
    expect(hours.at(-1)).toBe(19);
    expect(calendarCells(viewings, days, toLocal, true).cells.get('2026-11-20|11')?.map((viewing) => viewing.id)).toEqual(['d']);
  });
});

describe('offer chain (O-1)', () => {
  it('lists roots newest first with their counter-offers beneath, oldest first, and keeps orphans as roots', () => {
    const offers = [
      { id: 'o1', parentOfferId: null, submittedAt: '2026-11-04T10:00:00Z' },
      { id: 'o2', parentOfferId: null, submittedAt: '2026-11-10T10:00:00Z' },
      { id: 'o3', parentOfferId: 'o2', submittedAt: '2026-11-11T10:00:00Z' },
      { id: 'o4', parentOfferId: 'o3', submittedAt: '2026-11-12T10:00:00Z' },
      { id: 'o5', parentOfferId: 'outside-scope', submittedAt: '2026-11-01T10:00:00Z' },
    ];
    expect(offerThreads(offers).map(({ offer, depth }) => `${offer.id}:${depth}`)).toEqual(['o2:0', 'o3:1', 'o4:2', 'o1:0', 'o5:0']);
  });
});

describe('forecast (FC-1)', () => {
  it('ends months correctly, leap years included', () => {
    expect(monthEnd('2026-11')).toBe('2026-11-30');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(monthEnd('2026-12')).toBe('2026-12-31');
  });

  it('scales bars per currency and never across currencies', () => {
    const scale = forecastScale([
      { currency: 'GHS', weightedValue: { amount: '100.00' } },
      { currency: 'GHS', weightedValue: { amount: '400.00' } },
      { currency: 'QAR', weightedValue: { amount: '50.00' } },
      { currency: 'USD', weightedValue: { amount: '0.00' } },
    ]);
    expect(scale.get('GHS')).toBe(400);
    expect(scale.get('QAR')).toBe(50);
    expect(scale.has('USD')).toBe(false);
  });
});

describe('Sales navigation (SH-2)', () => {
  const grants = (map: Record<string, Grant['scope']>) => (permission: string) => (map[permission] ? { key: permission, scope: map[permission], isSensitive: false } : undefined);
  const ids = (map: Record<string, Grant['scope']>) => buildNavigation(grants(map)).flatMap((section) => section.items.map((item) => item.id));

  it('shows pipeline, deals and forecast with deal.view, calendar and follow-up with viewing.view', () => {
    const agent = { 'contact.view': 'own', 'lead.view': 'own', 'deal.view': 'own', 'viewing.view': 'own', 'deal.create': 'own', 'viewing.manage': 'own' } as const;
    expect(ids(agent)).toEqual(expect.arrayContaining(['leads', 'follow-ups', 'pipeline', 'deals', 'calendar', 'viewings-follow-up', 'forecast']));
    expect(buildQuickCreate(grants(agent)).map((item) => item.id)).toEqual(expect.arrayContaining(['deal', 'viewing']));
  });

  it('gives accountants the read-only sales screens without the CRM items', () => {
    const accountant = { 'deal.view': 'all', 'viewing.view': 'all', 'property.view': 'all' } as const;
    const items = ids(accountant);
    expect(items).toEqual(expect.arrayContaining(['pipeline', 'deals', 'calendar', 'forecast']));
    expect(items).not.toContain('leads');
    expect(buildQuickCreate(grants(accountant)).map((item) => item.id)).not.toContain('deal');
  });

  it('renders no Sales section without any sales permission', () => {
    expect(buildNavigation(grants({ 'property.view': 'linked' })).some((section) => section.id === 'sales')).toBe(false);
  });
});

describe('board forecast line (S6, Phase 3 design 06 §5)', () => {
  it('starts the quarter at its first month', () => {
    expect(quarterStart('2026-11-20')).toBe('2026-10');
    expect(quarterStart('2026-01-01')).toBe('2026-01');
    expect(quarterStart('2026-06-30')).toBe('2026-04');
    expect(quarterStart('2026-09-15')).toBe('2026-07');
  });

  it('adds decimal amounts exactly, keeping the widest number of decimals', () => {
    expect(addAmounts(['0.10', '0.20'])).toBe('0.30');
    expect(addAmounts(['308000.00', '45000.50', '1.005'])).toBe('353001.505');
    expect(addAmounts(['1200', '300'])).toBe('1500');
    expect(addAmounts([])).toBe('0');
  });

  it('totals the quarter per currency, never across currencies', () => {
    const totals = sumForecast([
      { totals: [{ currency: 'GHS', count: 2, weightedValue: { amount: '100.00' } }, { currency: 'QAR', count: 1, weightedValue: { amount: '50.00' } }] },
      { totals: [{ currency: 'GHS', count: 1, weightedValue: { amount: '0.50' } }] },
      { totals: [] },
    ]);
    expect(totals).toEqual([
      { currency: 'GHS', count: 3, weighted: '100.50' },
      { currency: 'QAR', count: 1, weighted: '50.00' },
    ]);
  });
});
