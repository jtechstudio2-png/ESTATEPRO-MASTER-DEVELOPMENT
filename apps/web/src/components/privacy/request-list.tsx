'use client';

import NextLink from 'next/link';
import { useTranslations } from 'next-intl';

import contactStyles from '@/components/contacts/contacts.module.css';
import { ContactName, Ltr } from '@/components/crm/labels';
import { useSession } from '@/components/session';
import { LinkButton } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { Page, PageHeader } from '@/components/ui/layout';
import { FilterSelect, LoadMore } from '@/components/ui/list-controls';
import type { PrivacyRequestSummaryDto } from '@/lib/api-schema';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';

import { DueLabel, PrivacyStatusLabel } from './labels';

const VIEWS = ['open', 'overdue', 'closed', 'all'] as const;
type View = (typeof VIEWS)[number];

/**
 * The data-subject request register (gap G3): open requests soonest due
 * first, overdue ones flagged in words, closed ones newest first.
 */
export function PrivacyRequestList() {
  const t = useTranslations('privacy');
  const list = useTranslations('list');
  const format = useFormat();
  const { can, readOnly } = useSession();
  const params = useListParams();
  const raw = params.get('view');
  const view: View = VIEWS.includes(raw as View) ? (raw as View) : 'open';
  const mine = params.get('mine') === 'true';
  const query = new URLSearchParams(params.apiQuery);
  query.delete('view');
  query.delete('mine');
  query.set('filter[view]', view);
  if (mine) query.set('filter[assignedTo]', 'me');
  if (view === 'closed' || view === 'all') query.set('sort', '-createdAt');
  const result = usePagedList<PrivacyRequestSummaryDto>('privacy-requests', query);

  const viewHref = (id: View) => {
    const next = new URLSearchParams();
    if (id !== 'open') next.set('view', id);
    const type = params.get('filter[requestType]');
    if (type) next.set('filter[requestType]', type);
    if (mine) next.set('mine', 'true');
    const text = next.toString();
    return text ? `/privacy-requests?${text}` : '/privacy-requests';
  };

  return (
    <Page>
      <PageHeader
        title={t('registerTitle')}
        subtitle={t('registerSubtitle')}
        actions={can('privacy.manage') && !readOnly ? <LinkButton href="/privacy-requests/new" variant="primary">{t('logRequest')}</LinkButton> : null}
      />
      <nav aria-label={t('views')} className={contactStyles.views}>
        {VIEWS.map((id) => (
          <NextLink key={id} href={viewHref(id)} aria-current={view === id ? 'page' : undefined} className={contactStyles.viewLink} scroll={false}>
            {t(`view.${id}`)}
          </NextLink>
        ))}
      </nav>
      <div className={contactStyles.actions}>
        <FilterSelect
          label={t('typeFilter')}
          value={params.get('filter[requestType]')}
          onChange={(value) => params.set({ 'filter[requestType]': value })}
          options={(['access', 'erasure'] as const).map((id) => ({ id, label: t(`type.${id}`) }))}
        />
        <FilterSelect label={t('assigneeHeader')} value={mine ? 'true' : null} onChange={(value) => params.set({ mine: value })} options={[{ id: 'true', label: t('me') }]} />
      </div>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <div aria-busy="true" aria-label={t('registerTitle')}>
          <Skeleton />
          <Skeleton />
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState title={t(`empty.${view}`)}>{t('emptyDetail')}</EmptyState>
      ) : (
        <DataTable
          caption={t(`view.${view}`)}
          rows={result.rows}
          rowKey={(row) => row.id}
          sortNote={list('sortedBy', { sort: view === 'open' || view === 'overdue' ? t('soonestDue') : t('newestFirst') })}
          identifier={{
            header: t('requestHeader'),
            href: (row) => `/privacy-requests/${row.id}`,
            label: (row) => <Ltr>{row.reference}</Ltr>,
            secondary: (row) => <ContactName name={row.contact.name} />,
          }}
          status={{ header: t('statusHeader'), cell: (row) => <PrivacyStatusLabel status={row.status} /> }}
          columns={[
            { key: 'type', header: t('typeHeader'), cell: (row) => t(`type.${row.requestType}`), onCard: true },
            { key: 'received', header: t('receivedHeader'), cell: (row) => <span className="ep-num">{format.date(row.receivedOn)}</span> },
            {
              key: 'due',
              header: t('dueHeader'),
              cell: (row) => (
                <span>
                  <span className="ep-num">{format.date(row.dueOn)}</span> <DueLabel row={row} />
                </span>
              ),
              onCard: true,
            },
            { key: 'assignee', header: t('assigneeHeader'), cell: (row) => (row.assignedTo ? <bdi>{row.assignedTo.name}</bdi> : t('unassigned')) },
          ]}
          footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
        />
      )}
    </Page>
  );
}
