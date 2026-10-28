'use client';

import NextLink from 'next/link';
import { useTranslations } from 'next-intl';

import { useSession } from '@/components/session';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { Panel } from '@/components/ui/layout';
import { FilterSelect, LoadMore } from '@/components/ui/list-controls';
import { When } from '@/components/ui/when';
import type { PropertyHistoryEntryDto } from '@/lib/api-schema';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';

import styles from './activity.module.css';

const ENTITY_PERMISSION: Record<PropertyHistoryEntryDto['entityType'], string> = {
  property: 'property.view',
  unit: 'property.view',
  media: 'property.view',
  property_note: 'property_note.view',
  key_set: 'key.view',
  listing: 'listing.view',
};

function relatedHref(propertyId: string, entry: PropertyHistoryEntryDto): string | null {
  if (entry.entityId === null) return null;
  switch (entry.entityType) {
    case 'unit':
      return `/properties/${propertyId}/units?unit=${entry.entityId}`;
    case 'listing':
      return `/listings/${entry.entityId}`;
    case 'media':
      return `/properties/${propertyId}/media?media=${entry.entityId}`;
    case 'property_note':
      return `/properties/${propertyId}/notes`;
    case 'key_set':
      return `/properties/${propertyId}/keys`;
    default:
      return null;
  }
}

/**
 * P-6 activity: who changed what on the property and its units, media,
 * notes, keys and listings (A-4). Metadata only: note text is never audited.
 */
export function ActivityTab({ propertyId }: { propertyId: string }) {
  const t = useTranslations('properties.activity');
  const { can } = useSession();
  const params = useListParams();
  const entity = params.get('filter[entityType]');
  const since = params.get('filter[occurredAt][gte]');
  const period = since === null ? null : String(Math.round((Date.now() - new Date(`${since}T00:00:00Z`).getTime()) / 86_400_000));
  const sinceDays = (days: string | null) => (days === null ? null : new Date(Date.now() - Number(days) * 86_400_000).toISOString().slice(0, 10));
  const result = usePagedList<PropertyHistoryEntryDto>(`properties/${propertyId}/history`, params.apiQuery);
  const types = (Object.keys(ENTITY_PERMISSION) as Array<PropertyHistoryEntryDto['entityType']>).filter((type) => can(ENTITY_PERMISSION[type]));

  const describe = (entry: PropertyHistoryEntryDto) => {
    const [kind, verb] = entry.action.split('.') as [string, string | undefined];
    const key = `actions.${kind}.${verb ?? ''}`;
    return t.has(key) ? t(key) : entry.action.replace(/[._]/g, ' ');
  };

  return (
    <Panel title={t('title')}>
      <div className={styles.filters}>
        <FilterSelect label={t('type')} value={entity} onChange={(value) => params.set({ 'filter[entityType]': value })} options={types.map((type) => ({ id: type, label: t(`entity.${type}`) }))} />
        <FilterSelect
          label={t('period')}
          value={['7', '30', '90'].find((days) => Math.abs(Number(days) - Number(period)) <= 1) ?? null}
          onChange={(value) => params.set({ 'filter[occurredAt][gte]': sinceDays(value) })}
          options={['7', '30', '90'].map((days) => ({ id: days, label: t('lastDays', { days: Number(days) }) }))}
        />
      </div>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <div aria-busy="true">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <>
          <ol className={styles.feed} aria-label={t('list')}>
            {result.rows.map((entry) => {
              const href = relatedHref(propertyId, entry);
              const changed = entry.changes ? Object.keys(entry.changes) : [];
              return (
                <li key={entry.id} className={styles.entry}>
                  <span className={styles.when}>
                    <When iso={entry.occurredAt} />
                  </span>
                  <span className={styles.who}>{entry.actorType === 'system' ? t('system') : <bdi>{entry.actorName ?? '—'}</bdi>}</span>
                  <span className={styles.what}>
                    {href ? <NextLink href={href}>{describe(entry)}</NextLink> : describe(entry)}
                    {changed.length > 0 ? <span className={styles.fields}> · {t('changed', { fields: changed.join(', ') })}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
          <LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />
        </>
      )}
    </Panel>
  );
}
