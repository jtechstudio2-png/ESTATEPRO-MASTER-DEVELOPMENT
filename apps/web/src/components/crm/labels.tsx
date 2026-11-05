'use client';

import { useTranslations } from 'next-intl';

import { StatusLabel, type Tone } from '@/components/ui/feedback';
import { When } from '@/components/ui/when';
import type { ContactSummaryDto, IdentityCheckSummaryDto, KycCheckDto, LeadSummaryDto, NextFollowUpDto, TaskDto } from '@/lib/api-schema';

export type ContactRole = ContactSummaryDto['roles'][number];
export type LeadStatus = LeadSummaryDto['status'];
export type LeadType = LeadSummaryDto['leadType'];
export type IdentityStatus = IdentityCheckSummaryDto['status'] | KycCheckDto['status'];

export const CONTACT_ROLES: readonly ContactRole[] = ['buyer', 'seller', 'landlord', 'tenant', 'applicant', 'guarantor', 'supplier', 'developer', 'investor', 'other'];
export const LEAD_TYPES: readonly LeadType[] = ['buy', 'rent', 'sell', 'let', 'valuation', 'management', 'other'];
export const LEAD_STATUSES: readonly LeadStatus[] = ['new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost'];

/**
 * A contact's name with its local-script form (wireframes §11): each in its
 * own element with automatic direction, so Arabic and Latin never reorder.
 */
export function ContactName({ name, local }: { name: string; local?: string | null }) {
  if (!local || local === name) return <bdi dir="auto">{name}</bdi>;
  return (
    <>
      <bdi dir="auto">{local}</bdi> (<bdi dir="auto">{name}</bdi>)
    </>
  );
}

/**
 * A phone number, email or reference inside text of either direction
 * (wireframes §11): isolated and left to right so "+974 55 …" keeps its order.
 */
export function Ltr({ children }: { children: string }) {
  return (
    <bdi dir="ltr" className="ep-num">
      {children}
    </bdi>
  );
}

/** "Buyer · Landlord" (C-1). */
export function RoleList({ roles }: { roles: readonly ContactRole[] }) {
  const t = useTranslations('crm');
  if (roles.length === 0) return <span>{t('noRoles')}</span>;
  // Always in the same order, whatever order the API returns them in.
  const ordered = [...roles].sort((a, b) => CONTACT_ROLES.indexOf(a) - CONTACT_ROLES.indexOf(b));
  return <span>{ordered.map((role) => t(`role.${role}`)).join(' · ')}</span>;
}

const LEAD_TONE: Record<LeadStatus, Tone> = { new: 'info', contacted: 'neutral', qualified: 'success', unqualified: 'neutral', converted: 'success', lost: 'warning' };

export function LeadStatusLabel({ status }: { status: LeadStatus }) {
  const t = useTranslations('crm');
  return <StatusLabel tone={LEAD_TONE[status]}>{t(`leadStatus.${status}`)}</StatusLabel>;
}

const IDENTITY: Record<IdentityStatus, { tone: Tone; icon: string }> = {
  none: { tone: 'neutral', icon: '–' },
  pending: { tone: 'info', icon: '⏳' },
  in_review: { tone: 'info', icon: '⏳' },
  verified: { tone: 'success', icon: '✓' },
  failed: { tone: 'danger', icon: '✕' },
  expired: { tone: 'warning', icon: '⌛' },
};

/** Identity check states use icon and text, never colour alone (SE-1). */
export function IdentityStatusLabel({ status }: { status: IdentityStatus }) {
  const t = useTranslations('crm');
  const look = IDENTITY[status];
  return (
    <StatusLabel tone={look.tone} icon={look.icon}>
      {t(`identityStatus.${status}`)}
    </StatusLabel>
  );
}

/** Response target state of a lead (D3): "past target" only when the company has set one (L-1). */
export function ResponseLabel({ response }: { response: LeadSummaryDto['response'] }) {
  const t = useTranslations('crm');
  if (response === null) return null;
  if (response.overdue) {
    return (
      <StatusLabel tone="danger" icon="⚠">
        {t('response.overdue')}
      </StatusLabel>
    );
  }
  if (response.late) return <StatusLabel tone="warning">{t('response.late')}</StatusLabel>;
  return null;
}

const PRIORITY_TONE: Record<TaskDto['priority'], Tone> = { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' };

export function PriorityLabel({ priority }: { priority: TaskDto['priority'] }) {
  const t = useTranslations('crm');
  return <StatusLabel tone={PRIORITY_TONE[priority]}>{t(`priority.${priority}`)}</StatusLabel>;
}

/** Overdue follow-ups say so in text with the icon (wireframes §10). */
export function OverdueMark({ overdue }: { overdue: boolean }) {
  const t = useTranslations('crm');
  if (!overdue) return null;
  return (
    <StatusLabel tone="danger" icon="⚠">
      {t('overdue')}
    </StatusLabel>
  );
}

/**
 * "Next" column (B-1, SE-1, LL-1): the next follow-up the viewer may see.
 * With `warnWhenNone`, an active client without one is flagged in text.
 */
export function NextFollowUpCell({ next, warnWhenNone = false }: { next: NextFollowUpDto | null | undefined; warnWhenNone?: boolean }) {
  const t = useTranslations('crm');
  if (!next) {
    return warnWhenNone ? (
      <StatusLabel tone="warning" icon="⚠">
        {t('noFollowUp')}
      </StatusLabel>
    ) : (
      <span>—</span>
    );
  }
  return (
    <span>
      <When iso={next.dueAt} /> <OverdueMark overdue={next.overdue} />
    </span>
  );
}
