'use client';

import { useQueries } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { LocationFilter, useLocationChip } from '@/components/map/location-filter';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { SegmentedControl, TextField } from '@/components/ui/fields';
import { Page, PageHeader, Panel } from '@/components/ui/layout';
import { type Chip, FilterBar, FilterSelect, listStyles, LoadMore, MoreFilters, SearchBox, SortSelect } from '@/components/ui/list-controls';
import { SavedViews } from '@/components/ui/saved-views';
import { When } from '@/components/ui/when';
import type { ListingListItemDto, ListingReadinessDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useOffices } from '@/lib/hooks/reference';

import { ListingState, PriceText } from './listing-labels';

const SORTS = ['-updatedAt', 'updatedAt', '-createdAt', 'createdAt', 'price', '-price', 'reference', '-reference'] as const;
const STATUSES = ['draft', 'available', 'reserved', 'under_contract', 'sold', 'rented', 'withdrawn', 'expired'] as const;
const ATTENTION = ['not-ready', 'photos', 'floor-plan', 'mandate-expiring', 'cover-alt', 'price-stale'] as const;

/** Publishing blockers for the draft rows shown (A-10), fetched only for those rows. */
function useBlockerCounts(rows: ListingListItemDto[]): Map<string, number> {
  const drafts = rows.filter((row) => row.status === 'draft' && row.archivedAt === null);
  const results = useQueries({
    queries: drafts.map((row) => ({ queryKey: ['readiness', row.id, row.updatedAt], queryFn: () => bff<ListingReadinessDto>(`listings/${row.id}/readiness`), staleTime: 60_000 })),
  });
  const counts = new Map<string, number>();
  drafts.forEach((row, index) => {
    const data = results[index]?.data;
    if (data) counts.set(row.id, data.blockers.length);
  });
  return counts;
}

/**
 * L-1 listing register. Embedded in the property record (Listings tab) with
 * the property fixed; on its own page with saved views and the map switch.
 */
export function ListingList({ propertyId }: { propertyId?: string }) {
  const t = useTranslations('listings');
  const list = useTranslations('list');
  const { can, readOnly } = useSession();
  const params = useListParams();
  const format = useFormat();
  const { offices } = useOffices('listing.view');
  const locationChip = useLocationChip();
  const [priceDraft, setPriceDraft] = useState({ min: params.get('filter[price][gte]') ?? '', max: params.get('filter[price][lte]') ?? '', currency: params.get('filter[currencyCode]') ?? '' });

  const near = params.get('filter[near]') !== null;
  const sort = params.get('sort') ?? '-updatedAt';
  const query = new URLSearchParams(params.apiQuery);
  if (!query.has('sort')) query.set('sort', sort);
  if (propertyId) query.set('filter[propertyId]', propertyId);
  const result = usePagedList<ListingListItemDto>('listings', query);
  const blockers = useBlockerCounts(result.rows);

  const listingType = params.get('filter[listingType]');
  const chips: Chip[] = [];
  const q = params.get('q');
  if (q) chips.push({ key: 'q', label: `${list('search')}: ${q}`, onRemove: () => params.set({ q: null }) });
  const named = (key: string, label: string, value: (raw: string) => string) => {
    const raw = params.get(key);
    if (raw !== null) chips.push({ key, label: `${label}: ${value(raw)}`, onRemove: () => params.set({ [key]: null }) });
  };
  named('filter[officeId]', t('office'), (raw) => offices.find((office) => office.id === raw)?.name ?? raw);
  named('filter[listingType]', t('typeLabel'), (raw) => t(`type.${raw as 'rent' | 'sale'}`));
  named('filter[status]', t('status'), (raw) => raw.split(',').map((status) => t(`statusValue.${status as (typeof STATUSES)[number]}`)).join(', '));
  named('filter[isPublished]', t('publishedFilter'), (raw) => (raw === 'true' ? t('publishedYes') : t('publishedNo')));
  named('filter[attention]', t('attention.label'), (raw) => raw.split(',').map((kind) => t(`attention.${kind as (typeof ATTENTION)[number]}`)).join(', '));
  named('filter[bedrooms][gte]', t('bedsMin'), (raw) => raw);
  named('filter[archived]', t('archivedFilter'), () => t('archivedOnly'));
  const price = params.get('filter[price][gte]') ?? params.get('filter[price][lte]');
  if (price !== null) {
    chips.push({
      key: 'price',
      label: `${t('priceFilter')}: ${params.get('filter[price][gte]') ?? '0'}–${params.get('filter[price][lte]') ?? '∞'} ${params.get('filter[currencyCode]') ?? ''}`,
      onRemove: () => params.set({ 'filter[price][gte]': null, 'filter[price][lte]': null, 'filter[currencyCode]': null }),
    });
  }
  if (locationChip) chips.push({ key: 'location', label: locationChip.label, onRemove: locationChip.clear });

  const sortOptions = [...SORTS, ...(near ? (['distance'] as const) : [])].map((id) => ({ id, label: t(`sort.${id}`) }));
  const priceProblem = (priceDraft.min || priceDraft.max) && !/^[A-Z]{3}$/.test(priceDraft.currency) ? t('currencyNeeded') : undefined;
  const filtered = chips.length > 0;
  const canCreate = can('listing.create') && !readOnly;

  const filters = (
    <FilterBar chips={chips} onClearAll={() => params.clear(['sort'])} search={<SearchBox label={t('searchLabel')} value={q ?? ''} onChange={(value) => params.set({ q: value || null })} />}>
      {!propertyId && offices.length > 1 ? (
        <FilterSelect label={t('office')} value={params.get('filter[officeId]')} onChange={(value) => params.set({ 'filter[officeId]': value })} options={offices.map((office) => ({ id: office.id, label: office.name }))} />
      ) : null}
      <SegmentedControl
        label={t('typeLabel')}
        value={listingType ?? 'all'}
        onChange={(value) => params.set({ 'filter[listingType]': value === 'all' ? null : value })}
        options={[
          { id: 'all', label: list('any') },
          { id: 'rent', label: t('type.rent') },
          { id: 'sale', label: t('type.sale') },
        ]}
      />
      <FilterSelect label={t('status')} value={params.get('filter[status]')} onChange={(value) => params.set({ 'filter[status]': value })} options={STATUSES.map((id) => ({ id, label: t(`statusValue.${id}`) }))} />
      <FilterSelect
        label={t('publishedFilter')}
        value={params.get('filter[isPublished]')}
        onChange={(value) => params.set({ 'filter[isPublished]': value })}
        options={[
          { id: 'true', label: t('publishedYes') },
          { id: 'false', label: t('publishedNo') },
        ]}
      />
      {!propertyId ? <LocationFilter /> : null}
      <MoreFilters activeCount={['filter[attention]', 'filter[bedrooms][gte]', 'filter[price][gte]', 'filter[price][lte]', 'filter[archived]'].filter((key) => params.get(key) !== null).length}>
        <FilterSelect label={t('attention.label')} value={params.get('filter[attention]')} onChange={(value) => params.set({ 'filter[attention]': value })} options={ATTENTION.map((id) => ({ id, label: t(`attention.${id}`) }))} />
        <FilterSelect
          label={t('bedsMin')}
          value={params.get('filter[bedrooms][gte]')}
          onChange={(value) => params.set({ 'filter[bedrooms][gte]': value })}
          options={['1', '2', '3', '4', '5'].map((id) => ({ id, label: `${id}+` }))}
        />
        <TextField label={t('priceMin')} value={priceDraft.min} onChange={(min) => setPriceDraft({ ...priceDraft, min })} inputMode="decimal" />
        <TextField label={t('priceMax')} value={priceDraft.max} onChange={(max) => setPriceDraft({ ...priceDraft, max })} inputMode="decimal" />
        <TextField label={t('currency')} value={priceDraft.currency} onChange={(currency) => setPriceDraft({ ...priceDraft, currency: currency.toUpperCase() })} maxLength={3} dir="ltr" error={priceProblem} />
        <div>
          <Button
            isDisabled={priceProblem !== undefined}
            onPress={() =>
              params.set({ 'filter[price][gte]': priceDraft.min || null, 'filter[price][lte]': priceDraft.max || null, 'filter[currencyCode]': priceDraft.min || priceDraft.max ? priceDraft.currency : null })
            }
          >
            {t('priceFilter')}
          </Button>
        </div>
        <FilterSelect label={t('archivedFilter')} value={params.get('filter[archived]')} onChange={(value) => params.set({ 'filter[archived]': value })} options={[{ id: 'true', label: t('archivedOnly') }]} />
      </MoreFilters>
    </FilterBar>
  );

  const body = result.isPending ? (
    <div aria-busy="true" aria-label={t('list')}>
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} />
      ))}
    </div>
  ) : result.isError ? (
    <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
  ) : result.rows.length === 0 ? (
    filtered ? (
      <EmptyState title={t('emptyFilteredTitle')} action={<Button onPress={() => params.clear(['sort'])}>{list('clearAll')}</Button>}>
        {list('emptyFilteredDetail')}
      </EmptyState>
    ) : (
      <EmptyState
        title={propertyId ? t('emptyProperty') : t('emptyTitle')}
        action={
          canCreate ? (
            <LinkButton href={propertyId ? `/listings/new?propertyId=${propertyId}` : '/listings/new'} variant="primary">
              {t('newListing')}
            </LinkButton>
          ) : undefined
        }
      >
        {t('emptyDetail')}
      </EmptyState>
    )
  ) : (
    <DataTable
      caption={t('list')}
      rows={result.rows}
      rowKey={(row) => row.id}
      sortNote={list('sortedBy', { sort: t(`sort.${sort as (typeof SORTS)[number]}`) })}
      identifier={{
        header: t('listing'),
        href: (row) => `/listings/${row.id}`,
        label: (row) => (
          <>
            <bdi className="ep-num">{row.reference}</bdi> · <bdi>{row.title}</bdi>
          </>
        ),
        secondary: (row) => (
          <>
            <bdi>{t('unitLine', { unit: row.unit.unitLabel, property: row.property.name ?? row.property.reference })}</bdi>
            {(blockers.get(row.id) ?? 0) > 0 ? (
              <span>
                {' · '}
                <span aria-hidden="true">⚠ </span>
                {t('blockers', { count: blockers.get(row.id)! })}
              </span>
            ) : null}
          </>
        ),
      }}
      status={{ header: t('status'), cell: (row) => <ListingState listing={row} /> }}
      columns={[
        { key: 'price', header: t('price'), cell: (row) => <PriceText price={row.price} rentFrequency={row.rentFrequency} />, align: 'end', onCard: true, ...(sort.endsWith('price') ? { sort: sort.startsWith('-') ? ('descending' as const) : ('ascending' as const) } : {}) },
        ...(near ? [{ key: 'distance', header: t('distance'), cell: (row: ListingListItemDto) => (row.distanceMeters === null ? '—' : <span className="ep-num">{format.distance(row.distanceMeters)}</span>), align: 'end' as const, onCard: true }] : []),
        { key: 'agent', header: t('agent'), cell: (row) => <bdi>{row.agent.displayName}</bdi>, onCard: !near },
        { key: 'updated', header: t('updated'), cell: (row) => <When iso={row.updatedAt} />, align: 'end' },
      ]}
      footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
    />
  );

  if (propertyId) {
    return (
      <Panel
        title={t('title')}
        actions={
          canCreate ? (
            <LinkButton href={`/listings/new?propertyId=${propertyId}`} variant="primary">
              {t('newListing')}
            </LinkButton>
          ) : undefined
        }
      >
        {filters}
        <RefreshBar active={result.isFetching && !result.isPending} />
        {body}
      </Panel>
    );
  }

  return (
    <Page>
      <PageHeader
        title={t('title')}
        actions={
          <>
            <nav aria-label={list('view')} className={listStyles.footer}>
              <LinkButton href="/listings" aria-current="page" variant="primary">
                {list('listView')}
              </LinkButton>
              <LinkButton href={`/map/listings?${params.apiQuery.toString()}`}>{list('mapView')}</LinkButton>
            </nav>
            <SavedViews list="listings" label={t('title')} />
            {canCreate ? (
              <LinkButton href="/listings/new" variant="primary">
                {t('newListing')}
              </LinkButton>
            ) : null}
          </>
        }
      />
      {filters}
      <div className={listStyles.toolbar}>
        <SortSelect value={sort} onChange={(value) => params.set({ sort: value === '-updatedAt' ? null : value })} options={sortOptions} />
      </div>
      {params.get('filter[price][gte]') && !params.get('filter[currencyCode]') ? <Notice tone="info">{t('currencyNeeded')}</Notice> : null}
      <RefreshBar active={result.isFetching && !result.isPending} />
      {body}
    </Page>
  );
}
