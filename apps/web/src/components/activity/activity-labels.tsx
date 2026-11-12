'use client';

import NextLink from 'next/link';
import { useTranslations } from 'next-intl';

import type { ActivityDto, ActivityLinkDto } from '@/lib/api-schema';
import { usePicklist } from '@/lib/hooks/reference';

export type ActivityType = ActivityDto['activityType'];
/** Types a member can log (A-2); the rest are written by the system or later phases. */
export const LOGGABLE_TYPES = ['call', 'meeting', 'whatsapp', 'sms', 'email', 'note'] as const;
export type LoggableType = (typeof LOGGABLE_TYPES)[number];

const ICON: Record<ActivityType, string> = {
  call: '☎',
  email: '✉',
  sms: '✉',
  whatsapp: '✉',
  meeting: '◷',
  note: '✎',
  viewing: '⌂',
  offer: '¤',
  status_change: '⚙',
  document: '▤',
  portal: '⚙',
  system: '⚙',
};

/** Type in text with its icon (wireframes §10: the type is never shown by the icon alone). */
export function ActivityTypeLabel({ type }: { type: ActivityType }) {
  const t = useTranslations('activity');
  return (
    <span>
      <span aria-hidden="true">{ICON[type]} </span>
      {t(`type.${type}`)}
    </span>
  );
}

/** Outcome label from the company's picklist; the code when the list has not loaded. */
export function useOutcomeLabel(): (code: string | null) => string | null {
  const outcomes = usePicklist('activity_outcome');
  return (code) => (code === null ? null : (outcomes.data?.data.find((value) => value.code === code)?.label ?? code));
}

const LINK_PATH: Record<ActivityLinkDto['entityType'], string> = { contact: '/contacts', lead: '/leads', listing: '/listings', property: '/properties' };

/** "Linked: Ama Owusu, LEA-…0412" with a link to each record (A-1). */
export function ActivityLinks({ links, exclude }: { links: ActivityLinkDto[]; exclude?: string }) {
  const t = useTranslations('activity');
  const shown = links.filter((link) => link.entityId !== exclude);
  if (shown.length === 0) return null;
  return (
    <span>
      {t('linked')}{' '}
      {shown.map((link, index) => (
        <span key={`${link.entityType}-${link.entityId}`}>
          {index > 0 ? ', ' : null}
          <NextLink href={`${LINK_PATH[link.entityType]}/${link.entityId}`}>
            <bdi dir="auto">{link.label}</bdi>
          </NextLink>
        </span>
      ))}
    </span>
  );
}

/** Minutes and seconds as "6 min" (duration of calls and meetings). */
export function durationMinutes(seconds: number | null): number | null {
  return seconds === null ? null : Math.max(1, Math.round(seconds / 60));
}
