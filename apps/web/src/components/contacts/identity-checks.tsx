'use client';

import NextLink from 'next/link';
import { useTranslations } from 'next-intl';

import { IdentityStatusLabel, Ltr } from '@/components/crm/labels';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { Page, PageHeader } from '@/components/ui/layout';
import { FilterSelect, LoadMore } from '@/components/ui/list-controls';
import { When } from '@/components/ui/when';
import type { KycQueueItemDto } from '@/lib/api-schema';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';

import styles from './contacts.module.css';

const QUEUES = ['open', 'expiring', 'verified', 'failed', 'expired'] as const;
type Queue = (typeof QUEUES)[number];
const CHECK_TYPES = ['identity', 'address', 'source_of_funds', 'sanctions_pep', 'company_ownership'] as const;

/** The API filters behind each queue tab. */
function queueFilters(queue: Queue): Record<string, string> {
  switch (queue) {
    case 'open':
      return {};
    case 'expiring':
      return { 'filter[expiring]': 'true' };
    default:
      return { 'filter[status]': queue };
  }
}

/**
 * Identity checks (SH-1; Phase 5 milestone C6): every check of the contacts
 * in the member's identity-check scope, open ones first, with checks due for
 * renewal. Decisions are taken on the contact's Identity tab, where the
 * documents are; document numbers show only their last four characters.
 */
export function IdentityChecks() {
  const t = useTranslations('identity');
  const list = useTranslations('list');
  const format = useFormat();
  const params = useListParams();
  const raw = params.get('queue');
  const queue: Queue = QUEUES.includes(raw as Queue) ? (raw as Queue) : 'open';
  const query = new URLSearchParams(params.apiQuery);
  query.delete('queue');
  for (const [key, value] of Object.entries(queueFilters(queue))) query.set(key, value);
  if (queue !== 'open' && queue !== 'expiring') query.set('sort', '-createdAt');
  const result = usePagedList<KycQueueItemDto>('kyc-checks', query);

  const queueHref = (id: Queue) => {
    const next = new URLSearchParams();
    if (id !== 'open') next.set('queue', id);
    const checkType = params.get('filter[checkType]');
    if (checkType) next.set('filter[checkType]', checkType);
    const text = next.toString();
    return text ? `/identity-checks?${text}` : '/identity-checks';
  };

  return (
    <Page>
      <PageHeader title={t('queueTitle')} subtitle={t('queueSubtitle')} />
      <nav aria-label={t('queueViews')} className={styles.views}>
        {QUEUES.map((id) => (
          <NextLink key={id} href={queueHref(id)} aria-current={queue === id ? 'page' : undefined} className={styles.viewLink} scroll={false}>
            {t(`queue.${id}`)}
          </NextLink>
        ))}
      </nav>
      <div className={styles.actions}>
        <FilterSelect label={t('checkTypeLabel')} value={params.get('filter[checkType]')} onChange={(value) => params.set({ 'filter[checkType]': value })} options={CHECK_TYPES.map((id) => ({ id, label: t(`checkType.${id}`) }))} />
      </div>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <div aria-busy="true" aria-label={t('queueTitle')}>
          <Skeleton />
          <Skeleton />
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState title={t(`queueEmpty.${queue}`)}>{t('queueEmptyDetail')}</EmptyState>
      ) : (
        <DataTable
          caption={t(`queue.${queue}`)}
          rows={result.rows}
          rowKey={(row) => row.id}
          sortNote={list('sortedBy', { sort: queue === 'open' || queue === 'expiring' ? t('oldestFirst') : t('newestFirst') })}
          identifier={{
            header: t('contactHeader'),
            href: (row) => `/contacts/${row.contact.id}/identity`,
            label: (row) => <bdi dir="auto">{row.contact.name}</bdi>,
            secondary: (row) => (row.contact.reference ? <Ltr>{row.contact.reference}</Ltr> : null),
          }}
          status={{ header: t('status'), cell: (row) => <IdentityStatusLabel status={row.status} /> }}
          columns={[
            { key: 'type', header: t('checkTypeLabel'), cell: (row) => t(`checkType.${row.checkType}`), onCard: true },
            {
              key: 'risk',
              header: t('riskLabel'),
              cell: (row) =>
                row.riskRating ? (
                  <StatusLabel tone={row.riskRating === 'high' ? 'danger' : row.riskRating === 'medium' ? 'warning' : 'neutral'}>{t(`riskValue.${row.riskRating}`)}</StatusLabel>
                ) : (
                  '—'
                ),
            },
            {
              key: 'document',
              header: t('document'),
              cell: (row) =>
                row.identityDocument ? (
                  <span className={styles.masked} aria-label={t('maskedLast4', { last4: row.identityDocument.numberLast4 })}>
                    •••• {row.identityDocument.numberLast4}
                  </span>
                ) : (
                  '—'
                ),
            },
            { key: 'recorded', header: t('recordedHeader'), cell: (row) => <When iso={row.createdAt} />, onCard: true },
            { key: 'expires', header: t('expires'), cell: (row) => (row.expiresOn ? <span className="ep-num">{format.date(row.expiresOn)}</span> : '—'), align: 'end' },
          ]}
          footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
        />
      )}
    </Page>
  );
}
