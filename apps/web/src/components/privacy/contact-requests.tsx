'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';

import contactStyles from '@/components/contacts/contacts.module.css';
import { Ltr } from '@/components/crm/labels';
import { useSession } from '@/components/session';
import { LinkButton } from '@/components/ui/button';
import { ErrorNotice, Skeleton } from '@/components/ui/feedback';
import { Panel } from '@/components/ui/layout';
import type { PrivacyRequestPageDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';

import { DueLabel, PrivacyStatusLabel } from './labels';

/**
 * C-2 contact record (gap G3): the person's access and erasure requests, and
 * "Log a privacy request". Shown only to members with privacy.view.
 */
export function ContactPrivacyRequests({ contactId, canLog }: { contactId: string; canLog: boolean }) {
  const t = useTranslations('privacy');
  const { can, readOnly } = useSession();
  const requests = useQuery({
    queryKey: ['list', 'privacy-requests', 'contact', contactId],
    queryFn: () => bff<PrivacyRequestPageDto>(`privacy-requests?filter[view]=all&filter[contactId]=${contactId}&sort=-createdAt&limit=20`),
    enabled: can('privacy.view'),
  });
  if (!can('privacy.view')) return null;
  return (
    <Panel
      title={t('contactPanelTitle')}
      actions={
        canLog && can('privacy.manage') && !readOnly ? (
          <LinkButton size="small" href={`/privacy-requests/new?contactId=${contactId}`}>
            {t('logForContact')}
          </LinkButton>
        ) : undefined
      }
    >
      {requests.isPending ? (
        <Skeleton />
      ) : requests.isError ? (
        <ErrorNotice error={requests.error} />
      ) : requests.data.data.length === 0 ? (
        <p>{t('contactNone')}</p>
      ) : (
        <ul className={contactStyles.list}>
          {requests.data.data.map((row) => (
            <li key={row.id}>
              <span className={contactStyles.itemMain}>
                <NextLink href={`/privacy-requests/${row.id}`}>
                  <Ltr>{row.reference}</Ltr> · {t(`type.${row.requestType}`)}
                </NextLink>
                <span className={contactStyles.meta}>
                  <PrivacyStatusLabel status={row.status} /> <DueLabel row={row} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
