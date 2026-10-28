'use client';

import { useTranslations } from 'next-intl';

import { LocationFilter, useLocationChip } from '@/components/map/location-filter';

import { useSession } from '@/components/session';
import { LinkButton } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { Page, PageHeader } from '@/components/ui/layout';
import { type Chip, FilterBar, FilterSelect, listStyles, LoadMore, MoreFilters, SearchBox, SortSelect } from '@/components/ui/list-controls';
import { SavedViews } from '@/components/ui/saved-views';
import { When } from '@/components/ui/when';
import type { PropertySummaryDto } from '@/lib/api-schema';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useCountries, useOffices, usePropertyTypes } from '@/lib/hooks/reference';

export const PROPERTY_SORTS = ['-updatedAt', 'updatedAt', '-createdAt', 'createdAt', 'reference', '-reference'] as const;

export function LocationStatus({ property }: { property: Pick<PropertySummaryDto, 'latitude' | 'locationStale'> }) {
  const t = useTranslations('properties');
  if (property.latitude === null) return <StatusLabel tone="neutral" icon="—">{t('locationNone')}</StatusLabel>;
  if (property.locationStale) return <StatusLabel tone="warning" icon="⚠">{t('locationCheck')}</StatusLabel>;
  return <StatusLabel tone="success" icon="●">{t('locationSet')}</StatusLabel>;
}

/** P-1 property register: filters, sort and search live in the URL and go to the API unchanged. */
export function PropertyList() {
  const t = useTranslations('properties');
  const list = useTranslations('list');
  const nav = useTranslations('nav');
  const { can, readOnly } = useSession();
  const params = useListParams();
  const format = useFormat();
  const { offices } = useOffices();
  const types = usePropertyTypes({ appliesTo: undefined });
  const countries = useCountries();
  const locationChip = useLocationChip();
  const near = params.get('filter[near]') !== null;

  const sort = params.get('sort') ?? '-updatedAt';
  const query = new URLSearchParams(params.apiQuery);
  if (!query.has('sort')) query.set('sort', sort);
  const result = usePagedList<PropertySummaryDto>('properties', query);

  const typeOptions = (types.data?.data ?? []).filter((type) => type.appliesTo !== 'unit').map((type) => ({ id: type.id, label: type.name }));
  const countryOptions = (countries.data?.data ?? []).map((country) => ({ id: country.code, label: country.name }));
  const officeOptions = offices.map((office) => ({ id: office.id, label: office.name }));
  const yesNo = (yes: string, no: string) => [
    { id: 'true', label: yes },
    { id: 'false', label: no },
  ];

  const filterDefs: Array<{ key: string; label: string; options?: Array<{ id: string; label: string }> }> = [
    { key: 'filter[officeId]', label: t('office'), options: officeOptions },
    { key: 'filter[propertyTypeId]', label: t('type'), options: typeOptions },
    { key: 'filter[countryCode]', label: t('country'), options: countryOptions },
    { key: 'filter[isManaged]', label: t('managed'), options: yesNo(t('managedYes'), t('managedNo')) },
    { key: 'filter[hasLocation]', label: t('hasLocation'), options: yesNo(t('hasLocationYes'), t('hasLocationNo')) },
    { key: 'filter[locationStale]', label: t('locationStale'), options: [{ id: 'true', label: t('locationCheck') }] },
    { key: 'filter[locality]', label: t('locality') },
    { key: 'filter[adminArea1]', label: t('adminArea1') },
    { key: 'filter[archived]', label: t('archivedFilter'), options: [{ id: 'true', label: t('archivedOnly') }] },
  ];
  const chips: Chip[] = [];
  const q = params.get('q');
  if (q) chips.push({ key: 'q', label: `${list('search')}: ${q}`, onRemove: () => params.set({ q: null }) });
  for (const def of filterDefs) {
    const value = params.get(def.key);
    if (value === null) continue;
    const shown = def.options?.find((option) => option.id === value)?.label ?? value;
    chips.push({ key: def.key, label: `${def.label}: ${shown}`, onRemove: () => params.set({ [def.key]: null }) });
  }
  const select = (key: string) => {
    const def = filterDefs.find((item) => item.key === key)!;
    return <FilterSelect key={key} label={def.label} value={params.get(key)} onChange={(value) => params.set({ [key]: value })} options={def.options ?? []} />;
  };
  if (locationChip) chips.push({ key: 'location', label: locationChip.label, onRemove: locationChip.clear });
  const moreActive = ['filter[locationStale]', 'filter[locality]', 'filter[adminArea1]', 'filter[archived]'].filter((key) => params.get(key) !== null).length;
  const sortOptions = [...PROPERTY_SORTS, ...(near ? (['distance'] as const) : [])].map((id) => ({ id, label: t(`sort.${id}`) }));
  const filtered = chips.length > 0;

  return (
    <Page>
      <PageHeader
        title={t('title')}
        actions={
          <>
            <nav aria-label={list('view')} className={listStyles.footer}>
              <LinkButton href="/properties" aria-current="page" variant="primary">
                {list('listView')}
              </LinkButton>
              <LinkButton href={`/map/properties?${params.apiQuery.toString()}`}>{list('mapView')}</LinkButton>
            </nav>
            <SavedViews list="properties" label={t('views')} />
            {can('property.create') && !readOnly ? (
              <LinkButton href="/properties/new" variant="primary">
                {t('addProperty')}
              </LinkButton>
            ) : null}
          </>
        }
      />
      <FilterBar
        chips={chips}
        onClearAll={() => params.clear(['sort'])}
        search={<SearchBox label={t('searchLabel')} value={q ?? ''} onChange={(value) => params.set({ q: value || null })} />}
      >
        {officeOptions.length > 1 ? select('filter[officeId]') : null}
        {select('filter[propertyTypeId]')}
        {countryOptions.length > 1 ? select('filter[countryCode]') : null}
        {select('filter[isManaged]')}
        {select('filter[hasLocation]')}
        <LocationFilter />
        <MoreFilters activeCount={moreActive}>
          {select('filter[locationStale]')}
          <SearchBox label={t('locality')} value={params.get('filter[locality]') ?? ''} onChange={(value) => params.set({ 'filter[locality]': value || null })} />
          <SearchBox label={t('adminArea1')} value={params.get('filter[adminArea1]') ?? ''} onChange={(value) => params.set({ 'filter[adminArea1]': value || null })} />
          {select('filter[archived]')}
        </MoreFilters>
      </FilterBar>
      <div className={listStyles.toolbar}>
        <SortSelect value={sort} onChange={(value) => params.set({ sort: value === '-updatedAt' ? null : value })} options={sortOptions} />
      </div>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <div aria-busy="true" aria-label={t('list')}>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} />
          ))}
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        filtered ? (
          <EmptyState title={t('emptyFilteredTitle')} action={<LinkButton href="/properties">{list('clearAll')}</LinkButton>}>
            {list('emptyFilteredDetail')}
          </EmptyState>
        ) : (
          <EmptyState
            title={t('emptyTitle')}
            action={
              can('property.create') && !readOnly ? (
                <LinkButton href="/properties/new" variant="primary">
                  {t('addProperty')}
                </LinkButton>
              ) : undefined
            }
          >
            {t('emptyDetail')}
          </EmptyState>
        )
      ) : (
        <DataTable
          caption={nav('properties')}
          rows={result.rows}
          rowKey={(row) => row.id}
          sortNote={list('sortedBy', { sort: t(`sort.${sort as (typeof PROPERTY_SORTS)[number] | 'distance'}`) })}
          identifier={{
            header: t('property'),
            href: (row) => `/properties/${row.id}`,
            label: (row) => (
              <>
                <bdi className="ep-num">{row.reference}</bdi>
                {row.name ? (
                  <>
                    {' · '}
                    <bdi>{row.name}</bdi>
                  </>
                ) : null}
              </>
            ),
            secondary: (row) => (row.formattedAddress ? <bdi>{row.formattedAddress}</bdi> : null),
          }}
          status={{ header: t('location'), cell: (row) => (row.archivedAt ? <StatusLabel tone="neutral">{t('archivedFilter')}</StatusLabel> : <LocationStatus property={row} />) }}
          columns={[
            { key: 'type', header: t('type'), cell: (row) => row.propertyType.name, onCard: true },
            { key: 'office', header: t('office'), cell: (row) => row.office.name, onCard: true },
            ...(near
              ? [{ key: 'distance', header: t('distance'), cell: (row: PropertySummaryDto) => (row.distanceMeters === null ? '—' : <span className="ep-num">{format.distance(row.distanceMeters)}</span>), align: 'end' as const }]
              : []),
            { key: 'units', header: t('units'), cell: (row) => <span className="ep-num">{format.number(row.unitCount)}</span>, align: 'end' },
            {
              key: 'updated',
              header: t('updated'),
              cell: (row) => <When iso={row.updatedAt} />,
              align: 'end',
              ...(sort.endsWith('updatedAt') ? { sort: sort.startsWith('-') ? ('descending' as const) : ('ascending' as const) } : {}),
            },
          ]}
          footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
        />
      )}
    </Page>
  );
}
