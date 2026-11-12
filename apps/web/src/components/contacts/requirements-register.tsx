'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { NextFollowUpCell } from '@/components/crm/labels';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { SegmentedControl, TextField } from '@/components/ui/fields';
import { Page, PageHeader } from '@/components/ui/layout';
import { type Chip, FilterBar, FilterSelect, listStyles, LoadMore, MoreFilters, SortSelect } from '@/components/ui/list-controls';
import { When } from '@/components/ui/when';
import type { RequirementDto } from '@/lib/api-schema';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';

import { useAreaText, useBudgetText } from './requirements';

const SORTS = ['-updatedAt', 'updatedAt', '-createdAt', 'createdAt'] as const;
const FINANCING = ['cash', 'mortgage_approved', 'mortgage_in_progress', 'not_started', 'not_applicable'] as const;
const STATUSES = ['active', 'paused', 'fulfilled', 'cancelled'] as const;

/**
 * B-1 buyers and tenants by what they want: active requirements with budget,
 * bedrooms, areas, financing and the number of matching published listings
 * (D4). A budget only matches listings in the same currency.
 */
export function RequirementsRegister() {
  const t = useTranslations('requirements');
  const list = useTranslations('list');
  const { session } = useSession();
  const params = useListParams();
  const budget = useBudgetText();
  const areaText = useAreaText();
  const [draft, setDraft] = useState({ min: params.get('filter[budget][gte]') ?? '', max: params.get('filter[budget][lte]') ?? '', locality: params.get('filter[locality]') ?? '' });

  const sort = params.get('sort') ?? '-updatedAt';
  const query = new URLSearchParams(params.apiQuery);
  if (!query.has('sort')) query.set('sort', sort);
  if (!query.has('filter[status]')) query.set('filter[status]', 'active');
  const result = usePagedList<RequirementDto>('requirements', query);

  const chips: Chip[] = [];
  const named = (key: string, label: string, value: (raw: string) => string) => {
    const raw = params.get(key);
    if (raw !== null) chips.push({ key, label: `${label}: ${value(raw)}`, onRemove: () => params.set({ [key]: null }) });
  };
  named('filter[requirementType]', t('typeLabel'), (raw) => t(`type.${raw as 'buy' | 'rent'}`));
  named('filter[status]', t('statusLabel'), (raw) => raw.split(',').map((id) => t(`status.${id as (typeof STATUSES)[number]}`)).join(', '));
  named('filter[financingStatus]', t('financingLabel'), (raw) => raw.split(',').map((id) => t(`financing.${id as (typeof FINANCING)[number]}`)).join(', '));
  named('filter[locality]', t('locality'), (raw) => raw);
  named('filter[moveBy][lte]', t('moveByBefore'), (raw) => raw);
  const budgetFilter = params.get('filter[budget][gte]') ?? params.get('filter[budget][lte]');
  if (budgetFilter !== null) {
    chips.push({
      key: 'budget',
      label: `${t('budget')}: ${params.get('filter[budget][gte]') ?? '0'}–${params.get('filter[budget][lte]') ?? '∞'} ${params.get('filter[currencyCode]') ?? ''}`,
      onRemove: () => params.set({ 'filter[budget][gte]': null, 'filter[budget][lte]': null, 'filter[currencyCode]': null }),
    });
  }

  return (
    <Page>
      <PageHeader title={t('registerTitle')} subtitle={t('registerSubtitle')} />
      <FilterBar chips={chips} onClearAll={() => params.clear(['sort'])}>
        <SegmentedControl
          label={t('typeLabel')}
          value={params.get('filter[requirementType]') ?? 'any'}
          onChange={(value) => params.set({ 'filter[requirementType]': value === 'any' ? null : value })}
          options={[
            { id: 'any', label: list('any') },
            { id: 'buy', label: t('type.buy') },
            { id: 'rent', label: t('type.rent') },
          ]}
        />
        <FilterSelect label={t('financingLabel')} value={params.get('filter[financingStatus]')} onChange={(value) => params.set({ 'filter[financingStatus]': value })} options={FINANCING.map((id) => ({ id, label: t(`financing.${id}`) }))} />
        <TextField label={t('locality')} value={draft.locality} onChange={(locality) => setDraft({ ...draft, locality })} dir="auto" />
        <div>
          <Button onPress={() => params.set({ 'filter[locality]': draft.locality.trim() || null })}>{t('applyLocality')}</Button>
        </div>
        <MoreFilters activeCount={['filter[budget][gte]', 'filter[budget][lte]', 'filter[status]', 'filter[moveBy][lte]'].filter((key) => params.get(key) !== null).length}>
          <FilterSelect label={t('statusLabel')} value={params.get('filter[status]')} onChange={(value) => params.set({ 'filter[status]': value })} options={STATUSES.map((id) => ({ id, label: t(`status.${id}`) }))} />
          <TextField label={t('minPrice')} value={draft.min} onChange={(min) => setDraft({ ...draft, min })} inputMode="decimal" dir="ltr" />
          <TextField label={t('maxPrice')} value={draft.max} onChange={(max) => setDraft({ ...draft, max })} inputMode="decimal" dir="ltr" />
          <div>
            <Button
              onPress={() =>
                params.set({
                  'filter[budget][gte]': draft.min || null,
                  'filter[budget][lte]': draft.max || null,
                  'filter[currencyCode]': draft.min || draft.max ? session.company.baseCurrencyCode : null,
                })
              }
            >
              {t('applyBudget', { currency: session.company.baseCurrencyCode })}
            </Button>
          </div>
          <TextField label={t('moveByBefore')} type="date" value={params.get('filter[moveBy][lte]') ?? ''} onChange={(value) => params.set({ 'filter[moveBy][lte]': value || null })} />
        </MoreFilters>
      </FilterBar>
      <div className={listStyles.toolbar}>
        <SortSelect value={sort} onChange={(value) => params.set({ sort: value })} options={SORTS.map((id) => ({ id, label: t(`sort.${id}`) }))} />
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
        <EmptyState title={chips.length > 0 ? list('emptyFiltered') : t('registerEmpty')}>{chips.length > 0 ? list('emptyFilteredDetail') : t('registerEmptyDetail')}</EmptyState>
      ) : (
        <DataTable
          caption={t('registerTitle')}
          rows={result.rows}
          rowKey={(row) => row.id}
          sortNote={list('sortedBy', { sort: t(`sort.${sort as (typeof SORTS)[number]}`) })}
          identifier={{ header: t('contact'), href: (row) => `/contacts/${row.contact.id}/requirements`, label: (row) => <bdi dir="auto">{row.contact.name}</bdi>, secondary: (row) => t(`type.${row.requirementType}`) }}
          status={{ header: t('statusLabel'), cell: (row) => <StatusLabel tone={row.status === 'active' ? 'success' : 'neutral'}>{t(`status.${row.status}`)}</StatusLabel> }}
          columns={[
            { key: 'budget', header: t('budget'), cell: (row) => <span className="ep-num">{budget(row)}</span>, onCard: true },
            { key: 'beds', header: t('bedsHeader'), cell: (row) => (row.minBedrooms !== null ? `${row.minBedrooms}+` : '—'), align: 'end' },
            { key: 'areas', header: t('areas'), cell: (row) => (row.areas.length === 0 ? t('anywhere') : <bdi dir="auto">{row.areas.map(areaText).join(' · ')}</bdi>), onCard: true },
            { key: 'financing', header: t('financingLabel'), cell: (row) => (row.financingStatus ? t(`financing.${row.financingStatus}`) : '—') },
            {
              key: 'matches',
              header: t('matches'),
              cell: (row) => (row.matchCount === null ? '—' : <span className="ep-num">{t('matchCount', { count: row.matchCount, capped: row.matchCountCapped ? 'yes' : 'no' })}</span>),
              align: 'end',
            },
            { key: 'next', header: t('next'), cell: (row) => <NextFollowUpCell next={row.nextFollowUp} warnWhenNone={row.status === 'active'} />, onCard: true },
            { key: 'updated', header: t('updated'), cell: (row) => <When iso={row.updatedAt} />, align: 'end' },
          ]}
          footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
        />
      )}
    </Page>
  );
}
