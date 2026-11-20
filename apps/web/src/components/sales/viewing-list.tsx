'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Ltr } from '@/components/crm/labels';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { SegmentedControl } from '@/components/ui/fields';
import { Page, PageHeader, Panel } from '@/components/ui/layout';
import { LoadMore } from '@/components/ui/list-controls';
import type { ViewingDto } from '@/lib/api-schema';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';

import { ViewingStatusLabel, ZonedTime } from './sales-labels';
import styles from './sales.module.css';
import { BookViewingDialog, OutcomeDialog, ViewingDrawer } from './viewing-dialogs';

function attendeeNames(viewing: ViewingDto): string {
  const [first, ...rest] = viewing.attendees;
  if (!first) return '—';
  return rest.length > 0 ? `${first.contact.name} +${rest.length}` : first.contact.name;
}

/**
 * Viewings of one deal (DL-3), listing (X-L3) or contact (X-C2, viewings they
 * attend), newest first; each row opens the V-3 drawer.
 */
export function ViewingList({ dealId, listingId, contactId }: { dealId?: string; listingId?: string | null; contactId?: string }) {
  const t = useTranslations('sales');
  const { can, readOnly } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const query = new URLSearchParams({ sort: '-scheduledStart' });
  if (dealId) query.set('filter[dealId]', dealId);
  else if (listingId) query.set('filter[listingId]', listingId);
  if (contactId) query.set('filter[contactId]', contactId);
  const result = usePagedList<ViewingDto>('viewings', query, { limit: 20 });
  const canBook = can('viewing.manage') && !readOnly && (dealId !== undefined || listingId);
  return (
    <Panel
      title={contactId ? t('viewingsAttended') : t('viewingsTitle')}
      actions={
        canBook ? (
          <Button variant="primary" onPress={() => setBooking(true)}>
            {t('bookViewing')}
          </Button>
        ) : undefined
      }
    >
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <Skeleton />
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState title={t('noViewings')} headingLevel={3}>
          {t('noViewingsDetail')}
        </EmptyState>
      ) : (
        <ViewingTable rows={result.rows} onOpen={setOpen} />
      )}
      {result.hasNextPage ? <LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} /> : null}
      {open ? <ViewingDrawer id={open} onClose={() => setOpen(null)} onOpenViewing={setOpen} /> : null}
      {booking ? <BookViewingDialog preset={{ ...(dealId ? { deal: { id: dealId, label: '' } } : {}), ...(listingId ? { listing: { id: listingId, label: '' } } : {}) }} onClose={() => setBooking(false)} /> : null}
    </Panel>
  );
}

function ViewingTable({ rows, onOpen, action }: { rows: ViewingDto[]; onOpen: (id: string) => void; action?: (row: ViewingDto) => React.ReactNode }) {
  const t = useTranslations('sales');
  return (
    <DataTable
      caption={t('viewingsTitle')}
      rows={rows}
      rowKey={(row) => row.id}
      identifier={{
        header: t('when'),
        label: (row) => (
          <button type="button" className={styles.linkButton} onClick={() => onOpen(row.id)}>
            <ZonedTime iso={row.scheduledStart} end={row.scheduledEnd} timeZone={row.timezone} />
          </button>
        ),
        secondary: (row) => (
          <>
            <Ltr>{row.listing.reference}</Ltr> <bdi dir="auto">{row.listing.title}</bdi>
          </>
        ),
      }}
      status={{ header: t('status'), cell: (row) => <ViewingStatusLabel status={row.status} /> }}
      columns={[
        { key: 'agent', header: t('agent'), cell: (row) => <bdi>{row.agent.name}</bdi>, onCard: true },
        { key: 'attendees', header: t('attendees'), cell: (row) => <bdi dir="auto">{attendeeNames(row)}</bdi> },
        { key: 'outcome', header: t('outcome'), cell: (row) => (row.outcome ? t(`outcomeName.${row.outcome}`) : row.needsOutcome ? t('outcomeMissing') : '—') },
        ...(action ? [{ key: 'action', header: t('action'), cell: action, onCard: true }] : []),
      ]}
    />
  );
}

/** V-5 viewings to follow up: over, still scheduled or confirmed, no outcome. Mine or (managers) the team. */
export function FollowUpViewings() {
  const t = useTranslations('sales');
  const { grant, readOnly, session } = useSession();
  const scope = grant('viewing.view')?.scope;
  const params = useListParams();
  const who: 'mine' | 'team' = scope !== 'own' && params.get('who') === 'team' ? 'team' : 'mine';
  const setWho = (value: 'mine' | 'team') => params.set({ who: value === 'team' ? 'team' : null });
  const [open, setOpen] = useState<string | null>(null);
  const [outcomeFor, setOutcomeFor] = useState<ViewingDto | null>(null);
  const query = new URLSearchParams({ 'filter[needsOutcome]': 'true', sort: '-scheduledStart' });
  if (who === 'mine') query.set('filter[agentMembershipId]', session.membershipId);
  const result = usePagedList<ViewingDto>('viewings', query, { limit: 25 });
  return (
    <Page>
      <PageHeader title={t('followUpTitle')} />
      {scope !== 'own' ? <SegmentedControl label={t('whose')} value={who} onChange={(value) => setWho(value as 'mine' | 'team')} options={[{ id: 'mine', label: t('mine') }, { id: 'team', label: t('team') }]} /> : null}
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <Skeleton />
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState title={t('followUpEmpty')}>{t('followUpEmptyDetail')}</EmptyState>
      ) : (
        <ViewingTable
          rows={result.rows}
          onOpen={setOpen}
          action={(row) =>
            row.canManage && !readOnly ? (
              <Button size="small" variant="primary" onPress={() => setOutcomeFor(row)} aria-label={t('outcomeFor', { reference: row.listing.reference })}>
                <span className={styles.bigTarget}>{t('recordOutcome')}</span>
              </Button>
            ) : null
          }
        />
      )}
      {result.hasNextPage ? <LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} /> : null}
      {open ? <ViewingDrawer id={open} onClose={() => setOpen(null)} onOpenViewing={setOpen} /> : null}
      {outcomeFor ? <OutcomeDialog viewing={outcomeFor} onClose={() => setOutcomeFor(null)} /> : null}
    </Page>
  );
}
