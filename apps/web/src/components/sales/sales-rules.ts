/**
 * Pure rules of the Phase 6 screens (P6-W), kept apart so they are unit
 * tested: calendar weeks in a time zone, the board's "Move to" targets
 * (W-D1), split totals (S3-D6) and the offer chain (O-1).
 */

export const STAGE_CLASSES = ['lead', 'qualification', 'viewing', 'negotiation', 'offer_accepted', 'contract', 'closed_won', 'closed_lost'] as const;
export type StageClass = (typeof STAGE_CLASSES)[number];

/** Stages reached only by their action, never by moving a card (S3-D3, W-D1). */
export const ACTION_STAGES: Readonly<Partial<Record<StageClass, 'accept' | 'exchange' | 'complete' | 'lose'>>> = {
  offer_accepted: 'accept',
  contract: 'exchange',
  closed_won: 'complete',
  closed_lost: 'lose',
};

/** What dropping a card on a column does: move it (an allowed stage), explain the action, or nothing (same column). */
export function dropOutcome(fromStageId: string, target: { id: string; stageClass: string }, allowed: ReadonlyArray<{ id: string }>): { kind: 'move' } | { kind: 'action'; action: string } | { kind: 'none' } | { kind: 'refused' } {
  if (target.id === fromStageId) return { kind: 'none' };
  if (allowed.some((stage) => stage.id === target.id)) return { kind: 'move' };
  const action = ACTION_STAGES[target.stageClass as StageClass];
  return action ? { kind: 'action', action } : { kind: 'refused' };
}

/** Sum of split percentages in ten-thousandths (4 decimal places), so 33.3333 + 66.6667 is exactly 100. */
export function splitsTotal(splits: ReadonlyArray<number | string>): number {
  return splits.reduce<number>((sum, value) => sum + Math.round(Number(value) * 10_000), 0);
}

export function splitsComplete(splits: ReadonlyArray<number | string>): boolean {
  return splits.length === 0 || splitsTotal(splits) === 1_000_000;
}

/** Monday-to-Sunday week (YYYY-MM-DD days) containing `day`; shifted by `offsetWeeks`. */
export function weekDays(day: string, offsetWeeks = 0): string[] {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - weekday + offsetWeeks * 7);
  return Array.from({ length: 7 }, (_, index) => {
    const next = new Date(date);
    next.setUTCDate(date.getUTCDate() + index);
    return next.toISOString().slice(0, 10);
  });
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface ChainOffer {
  id: string;
  parentOfferId: string | null;
  submittedAt: string;
}

/**
 * Offers as threads (O-1): each root offer (newest first) followed by the
 * counter-offers that answer it, depth-first, with their depth for indenting.
 */
export function offerThreads<T extends ChainOffer>(offers: readonly T[]): Array<{ offer: T; depth: number }> {
  const byParent = new Map<string | null, T[]>();
  const ids = new Set(offers.map((offer) => offer.id));
  for (const offer of offers) {
    const parent = offer.parentOfferId !== null && ids.has(offer.parentOfferId) ? offer.parentOfferId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), offer]);
  }
  const result: Array<{ offer: T; depth: number }> = [];
  const visit = (parent: string | null, depth: number) => {
    const children = [...(byParent.get(parent) ?? [])].sort((a, b) => (depth === 0 ? b.submittedAt.localeCompare(a.submittedAt) : a.submittedAt.localeCompare(b.submittedAt)));
    for (const child of children) {
      result.push({ offer: child, depth });
      visit(child.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
}

/** A live viewing is drawn on the calendar; cancelled and superseded ones only when asked. */
export function shownOnCalendar(status: string, showCancelled: boolean): boolean {
  if (status === 'rescheduled') return false;
  return showCancelled || status !== 'cancelled';
}

export interface Placed {
  scheduledStart: string;
  status: string;
}

/**
 * Places viewings in a week grid (V-1): key "YYYY-MM-DD|HH" in the shown time
 * zone, earliest first, plus the hour rows to draw (working hours 07–19,
 * widened to include any viewing outside them).
 */
export function calendarCells<T extends Placed>(viewings: readonly T[], days: readonly string[], toLocal: (iso: string) => string, showCancelled: boolean): { cells: Map<string, T[]>; hours: number[] } {
  const cells = new Map<string, T[]>();
  let first = 7;
  let last = 19;
  const shown = new Set(days);
  for (const viewing of [...viewings].sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))) {
    if (!shownOnCalendar(viewing.status, showCancelled)) continue;
    const local = toLocal(viewing.scheduledStart);
    const day = local.slice(0, 10);
    if (!shown.has(day)) continue;
    const hour = Number(local.slice(11, 13));
    first = Math.min(first, hour);
    last = Math.max(last, hour);
    const key = `${day}|${String(hour).padStart(2, '0')}`;
    cells.set(key, [...(cells.get(key) ?? []), viewing]);
  }
  return { cells, hours: Array.from({ length: last - first + 1 }, (_, index) => first + index) };
}

/** Last day (YYYY-MM-DD) of a month given as YYYY-MM. */
export function monthEnd(month: string): string {
  const [year, mon] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, mon, 0)).toISOString().slice(0, 10);
}

/** Largest weighted value per currency, to scale the decorative forecast bars (FC-1). */
export function forecastScale(totals: ReadonlyArray<{ currency: string; weightedValue: { amount: string } }>): Map<string, number> {
  const scale = new Map<string, number>();
  for (const total of totals) scale.set(total.currency, Math.max(scale.get(total.currency) ?? 0, Number(total.weightedValue.amount)));
  for (const [currency, value] of scale) if (value <= 0) scale.delete(currency);
  return scale;
}

/** First month (YYYY-MM) of the calendar quarter containing a day (YYYY-MM-DD). */
export function quarterStart(day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number];
  return `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')}`;
}

/**
 * Decimal amounts added exactly (scaled to four places, never floats), the
 * result written with as many decimals as the widest input: money of one
 * currency only, never across currencies (S3-D14).
 */
export function addAmounts(amounts: readonly string[]): string {
  const places = Math.max(0, ...amounts.map((amount) => amount.split('.')[1]?.length ?? 0));
  const scaled = amounts.reduce((sum, amount) => {
    const [whole = '0', fraction = ''] = amount.split('.');
    return sum + BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
  }, 0n);
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, '0').slice(0, places);
  return places > 0 ? `${whole}.${fraction}` : `${whole}`;
}

/** Forecast totals per currency over several months (the board's quarter line). */
export function sumForecast(months: ReadonlyArray<{ totals: ReadonlyArray<{ currency: string; count: number; weightedValue: { amount: string } }> }>): Array<{ currency: string; count: number; weighted: string }> {
  const byCurrency = new Map<string, { count: number; amounts: string[] }>();
  for (const month of months) {
    for (const total of month.totals) {
      const entry = byCurrency.get(total.currency) ?? { count: 0, amounts: [] };
      entry.count += total.count;
      entry.amounts.push(total.weightedValue.amount);
      byCurrency.set(total.currency, entry);
    }
  }
  return [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, entry]) => ({ currency, count: entry.count, weighted: addAmounts(entry.amounts) }));
}
