'use client';

import { useTranslations } from 'next-intl';

import { StatusLabel, type Tone } from '@/components/ui/feedback';
import type { DealSummaryDto, OfferDto, ViewingDto } from '@/lib/api-schema';
import { useFormat } from '@/lib/hooks/format';

export type DealStatus = DealSummaryDto['status'];
export type OfferStatus = OfferDto['status'];
export type ViewingStatus = ViewingDto['status'];

const DEAL_TONE: Record<string, Tone> = { open: 'info', won: 'success', lost: 'neutral' };
const OFFER_TONE: Record<string, Tone> = { submitted: 'info', countered: 'neutral', accepted: 'success', rejected: 'neutral', withdrawn: 'neutral', expired: 'warning' };
const VIEWING_TONE: Record<string, Tone> = { scheduled: 'info', confirmed: 'success', completed: 'neutral', cancelled: 'neutral', no_show: 'warning', rescheduled: 'neutral' };

export function DealStatusLabel({ status }: { status: string }) {
  const t = useTranslations('sales');
  return <StatusLabel tone={DEAL_TONE[status] ?? 'neutral'}>{t(`dealStatus.${status as 'open'}`)}</StatusLabel>;
}

export function OfferStatusLabel({ status }: { status: string }) {
  const t = useTranslations('sales');
  return <StatusLabel tone={OFFER_TONE[status] ?? 'neutral'} icon={status === 'accepted' ? '✓' : undefined}>{t(`offerStatus.${status as 'submitted'}`)}</StatusLabel>;
}

export function ViewingStatusLabel({ status }: { status: string }) {
  const t = useTranslations('sales');
  return <StatusLabel tone={VIEWING_TONE[status] ?? 'neutral'} icon={status === 'confirmed' ? '✓' : undefined}>{t(`viewingStatus.${status as 'scheduled'}`)}</StatusLabel>;
}

/** "Stalled 9 days": icon and words, never colour alone (§9). */
export function StalledLabel({ since }: { since: string }) {
  const t = useTranslations('sales');
  const days = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86_400_000));
  return (
    <StatusLabel tone="warning" icon="⚠">
      {t('stalled', { days })}
    </StatusLabel>
  );
}

/** An amount in its currency, isolated left to right inside text of either direction (§10). */
export function MoneyText({ money }: { money: { amount: string; currency: string } | null | undefined }) {
  const format = useFormat();
  if (!money) return <span>—</span>;
  return (
    <bdi dir="ltr" className="ep-num">
      {format.money(money)}
    </bdi>
  );
}

/** A time in the property's time zone with the zone named (V-1 to V-5, §10). */
export function ZonedTime({ iso, timeZone, end }: { iso: string; timeZone: string; end?: string }) {
  const format = useFormat();
  const time = (value: string) => new Intl.DateTimeFormat(format.locale, { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const day = new Intl.DateTimeFormat(format.locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
  return (
    <time dateTime={iso} className="ep-num">
      {day} {time(iso)}
      {end ? `–${time(end)}` : ''} <span>({timeZone})</span>
    </time>
  );
}
