'use client';

import { useTranslations } from 'next-intl';

import { StatusLabel, type Tone } from '@/components/ui/feedback';
import type { PrivacyRequestSummaryDto } from '@/lib/api-schema';

const TONES: Record<PrivacyRequestSummaryDto['status'], Tone> = {
  received: 'warning',
  verifying: 'info',
  in_progress: 'info',
  completed: 'success',
  refused: 'neutral',
  withdrawn: 'neutral',
};

export function PrivacyStatusLabel({ status }: { status: PrivacyRequestSummaryDto['status'] }) {
  const t = useTranslations('privacy');
  return <StatusLabel tone={TONES[status]}>{t(`status.${status}`)}</StatusLabel>;
}

/** Due date with days left, or a warning when overdue (as text, not colour only). */
export function DueLabel({ row }: { row: Pick<PrivacyRequestSummaryDto, 'dueOn' | 'daysLeft' | 'overdue'> }) {
  const t = useTranslations('privacy');
  if (row.daysLeft === null) return null;
  return row.overdue ? (
    <StatusLabel tone="danger" icon="⚠">
      {t('overdueBy', { days: -row.daysLeft })}
    </StatusLabel>
  ) : (
    <span>{t('daysLeft', { days: row.daysLeft })}</span>
  );
}
