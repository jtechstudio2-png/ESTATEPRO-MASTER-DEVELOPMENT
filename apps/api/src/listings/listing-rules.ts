import { toScaled } from '../common/money.js';
import type { ListingStatus } from './dto.js';

/**
 * Listing status model (decision D3). Draft becomes Available only through the
 * publish action. Sold, Rented, Withdrawn and Expired are terminal: a new
 * campaign is a new listing (relist).
 */
export const TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> = {
  draft: ['withdrawn'],
  available: ['reserved', 'under_contract', 'withdrawn', 'expired'],
  reserved: ['available', 'under_contract', 'withdrawn'],
  under_contract: ['available', 'sold', 'rented', 'withdrawn'],
  sold: [],
  rented: [],
  withdrawn: [],
  expired: [],
};

export const OPEN_STATUSES: readonly ListingStatus[] = ['draft', 'available', 'reserved', 'under_contract'];
export const LIVE_STATUSES: readonly ListingStatus[] = ['available', 'reserved', 'under_contract'];
export const TERMINAL_STATUSES: readonly ListingStatus[] = ['sold', 'rented', 'withdrawn', 'expired'];

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isLive(status: string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

/** Why a transition is not allowed, or null. */
export function transitionError(listingType: string, from: ListingStatus, to: ListingStatus): string | null {
  if (from === 'draft' && to === 'available') return 'Publish the listing to make it available.';
  if (to === 'sold' && listingType !== 'sale') return 'Only sales listings can be sold.';
  if (to === 'rented' && listingType !== 'rent') return 'Only rental listings can be rented.';
  if (!TRANSITIONS[from].includes(to)) {
    return isTerminal(from)
      ? `This listing is ${from.replace('_', ' ')} and closed. Relist the unit to market it again.`
      : `A listing cannot move from ${from.replace('_', ' ')} to ${to.replace('_', ' ')}.`;
  }
  return null;
}

/** Changes that must be explained: withdrawals, expiry and deals falling through. */
export function reasonRequired(from: ListingStatus, to: ListingStatus): boolean {
  return to === 'withdrawn' || to === 'expired' || (to === 'available' && (from === 'reserved' || from === 'under_contract'));
}

// ----------------------------------------------------------------------------- money

const FACTOR = 10_000n;

/** Whether moving from oldPrice to newPrice is a reduction of more than `percent`. */
export function reductionExceeds(oldPrice: string, newPrice: string, percent: number): boolean {
  const before = toScaled(oldPrice);
  const after = toScaled(newPrice);
  if (after >= before) return false;
  return (before - after) * 100n > BigInt(percent) * before;
}

/** Months covered by one rent period, as a fraction (weekly = 12/52). */
const MONTHS_PER_PERIOD: Record<string, { num: bigint; den: bigint }> = {
  weekly: { num: 12n, den: 52n },
  monthly: { num: 1n, den: 1n },
  quarterly: { num: 3n, den: 1n },
  semi_annual: { num: 6n, den: 1n },
  annual: { num: 12n, den: 1n },
};

/** Advance rent (in periods of `frequency`) is within a cap expressed in months. */
export function advanceWithinCap(periods: number, frequency: string, capMonths: string): boolean {
  const ratio = MONTHS_PER_PERIOD[frequency];
  if (!ratio) return false;
  return BigInt(periods) * ratio.num * FACTOR <= toScaled(capMonths) * ratio.den;
}

/** Deposit is within `multiple` times the periodic rent. */
export function depositWithinCap(deposit: string, rent: string, multiple: string): boolean {
  return toScaled(deposit) * FACTOR <= toScaled(multiple) * toScaled(rent);
}

/** A jurisdiction/company setting value as a decimal string, or null when unset. */
export function decimalSetting(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e15) return value.toFixed(4);
  if (typeof value === 'string' && /^\d{1,15}(\.\d{1,4})?$/.test(value)) return value;
  return null;
}
