'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Ltr } from '@/components/crm/labels';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { TextField } from '@/components/ui/fields';
import { Page, PageHeader, Panel } from '@/components/ui/layout';
import { type Chip, FilterBar, FilterSelect, listStyles, LoadMore, MoreFilters, SearchBox, SortSelect } from '@/components/ui/list-controls';
import { When } from '@/components/ui/when';
import type { DealSummaryDto } from '@/lib/api-schema';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useOffices } from '@/lib/hooks/reference';
import { useFormat } from '@/lib/hooks/format';

import { NewDealDialog } from './deal-dialogs';
import { DealStatusLabel, MoneyText, StalledLabel } from './sales-labels';
import styles from './sales.module.css';
import { STAGE_CLASSES } from './sales-rules';

const SORTS = ['-updatedAt', 'updatedAt', '-createdAt', '-stageEnteredAt', 'stageEnteredAt'] as const;

/**
 * DL-1 deals list (`deal.view`, in scope), and the Deals panels of the
 * contact (X-C2) and listing (X-L3) records with the record fixed. Values are
 * shown in each deal's own currency; nothing is converted (S3-D14).
 */
export function DealList({ contactId, listingId }: { contactId?: string; listingId?: string }) {
  const t = useTranslations('sales');
  const list = useTranslations('list');
  const format = useFormat();
  const { can, readOnly } = useSession();
  const params = useListParams();
  const { offices } = useOffices('deal.view');
  const embedded = contactId !== undefined || listingId !== undefined;
  // Quick create (SH-2) opens the new deal dialog here.
  const [creating, setCreating] = useState(!embedded && params.get('compose') === '1');
  const sort = params.get('sort') ?? '-updatedAt';

  const query = new URLSearchParams(embedded ? '' : params.apiQuery);
  query.delete('compose');
  if (contactId) query.set('filter[contactId]', contactId);
  if (listingId) query.set('filter[listingId]', listingId);
  if (embedded || !query.has('filter[status]')) query.set('filter[status]', embedded ? 'open,won,lost' : 'open');
  if (!query.has('sort')) query.set('sort', sort);
  const result = usePagedList<DealSummaryDto>('deals', query, { limit: embedded ? 10 : 25 });

  const chips: Chip[] = [];
  const q = params.get('q');
  if (!embedded && q) chips.push({ key: 'q', label: `${list('search')}: ${q}`, onRemove: () => params.set({ q: null }) });
  const named = (key: string, label: string, value: (raw: string) => string) => {
    const raw = params.get(key);
    if (!embedded && raw !== null) chips.push({ key, label: `${label}: ${value(raw)}`, onRemove: () => params.set({ [key]: null }) });
  };
  named('filter[status]', t('status'), (raw) => raw.split(',').map((id) => t(`dealStatus.${id as 'open'}`)).join(', '));
  named('filter[dealType]', t('dealType'), (raw) => raw.split(',').map((id) => t(`dealTypeName.${id as 'sale'}`)).join(', '));
  named('filter[stageClass]', t('stage'), (raw) => raw.split(',').map((id) => t(`stageClass.${id as 'lead'}`)).join(', '));
  named('filter[officeId]', t('office'), (raw) => offices.find((office) => office.id === raw)?.name ?? raw);
  named('filter[ownerMembershipId]', t('owner'), (raw) => (raw === 'me' ? t('ownerMe') : raw));
  named('filter[attention]', t('attentionLabel'), (raw) => raw.split(',').map((id) => (id === 'listing_closed' ? t('listingClosedOnly') : t('stalledOnly'))).join(', '));
  named('filter[expectedCloseDate][gte]', t('closeFrom'), (raw) => format.date(raw));
  named('filter[expectedCloseDate][lte]', t('closeTo'), (raw) => format.date(raw));
  const filtered = chips.length > 0;

  const body = result.isPending ? (
    <div aria-busy="true" aria-label={t('dealsTitle')}>
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} />
      ))}
    </div>
  ) : result.isError ? (
    <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
  ) : result.rows.length === 0 ? (
    filtered ? (
      <EmptyState title={list('emptyFiltered')} action={<Button onPress={() => params.clear(['sort'])}>{list('clearAll')}</Button>}>
        {list('emptyFilteredDetail')}
      </EmptyState>
    ) : (
      <EmptyState title={embedded ? t('noDealsHere') : t('noDeals')} headingLevel={embedded ? 3 : 2}>
        {t('noDealsDetail')}
      </EmptyState>
    )
  ) : (
    <DataTable
      caption={t('dealsTitle')}
      rows={result.rows}
      rowKey={(row) => row.id}
      {...(embedded ? {} : { sortNote: list('sortedBy', { sort: t(`dealSort.${sort as (typeof SORTS)[number]}`) }) })}
      identifier={{
        header: t('deal'),
        href: (row) => `/deals/${row.id}`,
        label: (row) => (
          <>
            <Ltr>{row.reference}</Ltr> · <bdi dir="auto">{row.primaryContact.name}</bdi>
          </>
        ),
        secondary: (row) => (
          <>
            {t(`dealTypeName.${row.dealType}`)}
            {row.listing ? (
              <>
                {' · '}
                <Ltr>{row.listing.reference}</Ltr> <bdi dir="auto">{row.listing.title}</bdi>
              </>
            ) : null}
          </>
        ),
      }}
      status={{
        header: t('stage'),
        cell: (row) => (
          <span className={styles.inline}>
            <bdi dir="auto">{row.stage.name}</bdi>
            {row.status !== 'open' ? <DealStatusLabel status={row.status} /> : null}
            {row.stalled ? <StalledLabel since={row.stageEnteredAt} /> : null}
          </span>
        ),
      }}
      columns={[
        { key: 'value', header: t('value'), cell: (row) => <MoneyText money={row.expectedValue} />, onCard: true },
        { key: 'weighted', header: t('weighted'), cell: (row) => <MoneyText money={row.weightedValue} /> },
        { key: 'close', header: t('expectedClose'), cell: (row) => (row.expectedCloseDate ? <span>{format.date(row.expectedCloseDate)}</span> : '—') },
        { key: 'owner', header: t('owner'), cell: (row) => <bdi>{row.owner.name}</bdi>, onCard: true },
        { key: 'updated', header: t('updated'), cell: (row) => <When iso={row.updatedAt} />, ...(sort.endsWith('updatedAt') ? { sort: sort.startsWith('-') ? ('descending' as const) : ('ascending' as const) } : {}) },
      ]}
      footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
    />
  );

  if (embedded) {
    return (
      <Panel
        title={t('dealsTitle')}
        actions={
          can('deal.create') && !readOnly && contactId ? (
            <Button variant="primary" onPress={() => setCreating(true)}>
              {t('newDeal')}
            </Button>
          ) : undefined
        }
      >
        <RefreshBar active={result.isFetching && !result.isPending} />
        {body}
        {creating ? <NewDealDialog presetContact={contactId ? { id: contactId } : null} onClose={() => setCreating(false)} /> : null}
      </Panel>
    );
  }

  return (
    <Page>
      <PageHeader
        title={t('dealsTitle')}
        actions={
          <>
            <LinkButton href="/pipeline">{t('boardView')}</LinkButton>
            {can('deal.create') && !readOnly ? (
              <Button variant="primary" onPress={() => setCreating(true)}>
                {t('newDeal')}
              </Button>
            ) : null}
          </>
        }
      />
      <FilterBar chips={chips} onClearAll={() => params.clear(['sort'])} search={<SearchBox label={t('dealSearchLabel')} value={q ?? ''} onChange={(value) => params.set({ q: value || null })} />}>
        <FilterSelect label={t('status')} value={params.get('filter[status]')} onChange={(value) => params.set({ 'filter[status]': value })} options={(['open', 'won', 'lost'] as const).map((id) => ({ id, label: t(`dealStatus.${id}`) }))} />
        <FilterSelect label={t('dealType')} value={params.get('filter[dealType]')} onChange={(value) => params.set({ 'filter[dealType]': value })} options={(['sale', 'letting'] as const).map((id) => ({ id, label: t(`dealTypeName.${id}`) }))} />
        <FilterSelect label={t('stage')} value={params.get('filter[stageClass]')} onChange={(value) => params.set({ 'filter[stageClass]': value })} options={STAGE_CLASSES.map((id) => ({ id, label: t(`stageClass.${id}`) }))} />
        <FilterSelect label={t('owner')} value={params.get('filter[ownerMembershipId]')} onChange={(value) => params.set({ 'filter[ownerMembershipId]': value })} options={[{ id: 'me', label: t('ownerMe') }]} />
        <MoreFilters activeCount={['filter[officeId]', 'filter[attention]', 'filter[expectedCloseDate][gte]', 'filter[expectedCloseDate][lte]'].filter((key) => params.get(key) !== null).length}>
          {offices.length > 1 ? (
            <FilterSelect label={t('office')} value={params.get('filter[officeId]')} onChange={(value) => params.set({ 'filter[officeId]': value })} options={offices.map((office) => ({ id: office.id, label: office.name }))} />
          ) : null}
          <FilterSelect label={t('attentionLabel')} value={params.get('filter[attention]')} onChange={(value) => params.set({ 'filter[attention]': value })} options={[{ id: 'stalled', label: t('stalledOnly') }, { id: 'listing_closed', label: t('listingClosedOnly') }]} />
          <TextField label={t('closeFrom')} type="date" value={params.get('filter[expectedCloseDate][gte]') ?? ''} onChange={(value) => params.set({ 'filter[expectedCloseDate][gte]': value || null })} />
          <TextField label={t('closeTo')} type="date" value={params.get('filter[expectedCloseDate][lte]') ?? ''} onChange={(value) => params.set({ 'filter[expectedCloseDate][lte]': value || null })} />
        </MoreFilters>
      </FilterBar>
      <div className={listStyles.toolbar}>
        <SortSelect value={sort} onChange={(value) => params.set({ sort: value })} options={SORTS.map((id) => ({ id, label: t(`dealSort.${id}`) }))} />
      </div>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {body}
      {creating ? (
        <NewDealDialog
          presetContact={null}
          onClose={() => {
            setCreating(false);
            if (params.get('compose') !== null) params.set({ compose: null });
          }}
        />
      ) : null}
    </Page>
  );
}
