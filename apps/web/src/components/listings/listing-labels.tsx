'use client';

import { useTranslations } from 'next-intl';

import { StatusLabel, type Tone } from '@/components/ui/feedback';
import type { ListingListItemDto, MoneyDto } from '@/lib/api-schema';
import { useFormat } from '@/lib/hooks/format';

export type ListingStatus = ListingListItemDto['status'];

const TONE: Record<ListingStatus, Tone> = {
  draft: 'neutral',
  available: 'success',
  reserved: 'info',
  under_contract: 'info',
  sold: 'neutral',
  rented: 'neutral',
  withdrawn: 'neutral',
  expired: 'warning',
};

export function ListingStatusLabel({ status }: { status: ListingStatus }) {
  const t = useTranslations('listings');
  return <StatusLabel tone={TONE[status]}>{t(`statusValue.${status}`)}</StatusLabel>;
}

/** Status plus publication, as text (never colour alone). */
export function ListingState({ listing }: { listing: Pick<ListingListItemDto, 'status' | 'isPublished'> }) {
  const t = useTranslations('listings');
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      <ListingStatusLabel status={listing.status} />
      {listing.isPublished ? (
        <StatusLabel tone="success" icon="●">
          {t('published')}
        </StatusLabel>
      ) : null}
    </span>
  );
}

/** "GH₵6,000 / month" for rentals; the amount always carries its currency. */
export function PriceText({ price, rentFrequency }: { price: MoneyDto; rentFrequency: ListingListItemDto['rentFrequency'] }) {
  const t = useTranslations('listings');
  const format = useFormat();
  const amount = format.money(price);
  return <span className="ep-num">{rentFrequency ? t('perPeriod', { price: amount, period: t(`frequency.${rentFrequency}`) }) : amount}</span>;
}

/** Statuses that close a campaign (D3): only relist is possible afterwards. */
export const TERMINAL: ListingStatus[] = ['sold', 'rented', 'withdrawn', 'expired'];
export const LIVE: ListingStatus[] = ['available', 'reserved', 'under_contract'];

/** Next statuses the API allows (listing-rules TRANSITIONS); draft → available is publishing. */
export function nextStatuses(listingType: 'sale' | 'rent', status: ListingStatus): ListingStatus[] {
  const transitions: Record<ListingStatus, ListingStatus[]> = {
    draft: ['withdrawn'],
    available: ['reserved', 'under_contract', 'withdrawn', 'expired'],
    reserved: ['available', 'under_contract', 'withdrawn'],
    under_contract: ['available', listingType === 'sale' ? 'sold' : 'rented', 'withdrawn'],
    sold: [],
    rented: [],
    withdrawn: [],
    expired: [],
  };
  return transitions[status];
}

/** Changes that need a reason: withdrawals, expiry and deals falling through. */
export function reasonRequired(from: ListingStatus, to: ListingStatus): boolean {
  return to === 'withdrawn' || to === 'expired' || (to === 'available' && (from === 'reserved' || from === 'under_contract'));
}
