'use client';

import { type UseQueryResult, useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { keyWhere, useKeyDialogState } from '@/components/keys/key-dialogs';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { SegmentedControl, SelectField } from '@/components/ui/fields';
import { Cluster, Page, PageHeader, Panel } from '@/components/ui/layout';
import { When } from '@/components/ui/when';
import type {
  KeySetPageDto,
  KeysPanelDto,
  ListingAttentionDto,
  LocationsPanelDto,
  MaintenancePanelDto,
  MediaPanelDto,
  OfficeListDto,
  StorageUsageDto,
} from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';

import styles from './dashboard.module.css';

/**
 * D-1 property dashboard and D-2 keys I hold (W-D8: Phase 4 panels only).
 * Every panel loads and fails on its own; every count links to the list
 * filter that returns the same records.
 */
export function DashboardView() {
  const t = useTranslations('dashboard');
  const { session, grant, can } = useSession();
  const params = useListParams();
  const client = useQueryClient();
  const format = useFormat();
  const fetching = useIsFetching({ queryKey: ['dashboard'] });

  // D-1 is for those who run the book (Own, Adm, SM, PM): the managers' price-approval capability.
  const manager = can('listing.approve_price');
  const showListings = manager && can('listing.view');
  const showProperty = manager && can('property.view');
  const showKeys = manager && can('key.view');
  const showMyKeys = can('key.view');

  const officeId = params.get('filter[officeId]') ?? '';
  const listingType = params.get('filter[listingType]') ?? 'rent,sale';
  const scopeAll = ['property.view', 'listing.view', 'key.view'].some((key) => grant(key)?.scope === 'all');
  const offices = useQuery({
    queryKey: ['dashboard', 'offices'],
    queryFn: () => bff<OfficeListDto>('offices'),
    enabled: manager,
    staleTime: 300_000,
  });
  const officeOptions = (offices.data?.data ?? [])
    .filter((office) => office.archivedAt === null && (scopeAll || session.officeIds.includes(office.id)))
    .map((office) => ({ id: office.id, label: office.name }));

  const officeQuery = { 'filter[officeId]': officeId || undefined };
  const panel = <T,>(name: string, path: string, enabled: boolean, extra: Record<string, string | undefined> = {}) => ({
    queryKey: ['dashboard', name, officeId, extra],
    queryFn: () => bff<T>(`${path}${query({ ...officeQuery, ...extra })}`),
    enabled,
  });
  const listings = useQuery(panel<ListingAttentionDto>('listings', 'dashboards/property/listings', showListings, { 'filter[listingType]': listingType === 'rent,sale' ? undefined : listingType }));
  const keys = useQuery(panel<KeysPanelDto>('keys', 'dashboards/property/keys', showKeys));
  const locations = useQuery(panel<LocationsPanelDto>('locations', 'dashboards/property/locations', showProperty));
  const maintenance = useQuery(panel<MaintenancePanelDto>('maintenance', 'dashboards/property/maintenance', showProperty));
  const media = useQuery(panel<MediaPanelDto>('media', 'dashboards/property/media', showProperty));
  const storage = useQuery({ queryKey: ['dashboard', 'storage'], queryFn: () => bff<StorageUsageDto>('settings/storage'), enabled: showProperty });
  const updatedAt = Math.max(listings.dataUpdatedAt, keys.dataUpdatedAt, locations.dataUpdatedAt, maintenance.dataUpdatedAt, media.dataUpdatedAt);

  const listLink = (path: string, filters: Record<string, string | undefined>) => `${path}${query({ ...filters, ...officeQuery })}`;
  const typeFilter = listingType === 'rent,sale' ? undefined : listingType;

  if (!manager && !showMyKeys) {
    return (
      <Page>
        <PageHeader title={t('title')} />
        <EmptyState title={t('nothing')}>{t('nothingDetail')}</EmptyState>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title={manager ? t('title') : t('myDayTitle')}
        subtitle={manager ? t('scope', { scope: officeId ? (officeOptions.find((office) => office.id === officeId)?.label ?? '') : scopeAll ? t('scopeAll') : t('scopeMine') }) : undefined}
        actions={
          <Cluster>
            {updatedAt > 0 ? (
              <span className={styles.updated}>{t.rich('updated', { time: () => <When iso={new Date(updatedAt).toISOString()} /> })}</span>
            ) : null}
            <Button onPress={() => void client.invalidateQueries({ queryKey: ['dashboard'] })} busy={fetching > 0}>
              {t('refresh')}
            </Button>
          </Cluster>
        }
      />
      <RefreshBar active={fetching > 0 && updatedAt > 0} />
      {manager ? (
        <div className={styles.filters}>
          {officeOptions.length > 1 ? (
            <SelectField
              label={t('office')}
              value={officeId}
              onChange={(value) => params.set({ 'filter[officeId]': value || null })}
              options={[{ id: '', label: t('allOffices') }, ...officeOptions]}
            />
          ) : null}
          {showListings ? (
            <SegmentedControl
              label={t('listingType')}
              value={listingType}
              onChange={(value) => params.set({ 'filter[listingType]': value === 'rent,sale' ? null : value })}
              options={[
                { id: 'rent', label: t('rent') },
                { id: 'sale', label: t('sale') },
                { id: 'rent,sale', label: t('both') },
              ]}
            />
          ) : null}
        </div>
      ) : null}
      <div className={styles.grid}>
        {showListings ? (
          <DashboardPanel title={t('listingsPanel')} result={listings} rows={6}>
            {(data) => (
              <CountList
                items={[
                  { label: t('notReady'), count: data.notReady, href: listLink('/listings', { 'filter[attention]': 'not-ready', 'filter[listingType]': typeFilter }) },
                  { label: t('photos'), count: data.photos, href: listLink('/listings', { 'filter[attention]': 'photos', 'filter[listingType]': typeFilter }) },
                  { label: t('floorPlan'), count: data.floorPlan, href: listLink('/listings', { 'filter[attention]': 'floor-plan', 'filter[listingType]': typeFilter }) },
                  { label: t('mandateExpiring'), count: data.mandateExpiring, href: listLink('/listings', { 'filter[attention]': 'mandate-expiring', 'filter[listingType]': typeFilter }) },
                  { label: t('coverAlt'), count: data.coverAlt, href: listLink('/listings', { 'filter[attention]': 'cover-alt', 'filter[listingType]': typeFilter }) },
                  { label: t('priceStale'), count: data.priceStale, href: listLink('/listings', { 'filter[attention]': 'price-stale', 'filter[listingType]': typeFilter }) },
                ]}
              />
            )}
          </DashboardPanel>
        ) : null}
        {showKeys ? (
          <DashboardPanel title={t('keysPanel')} result={keys} rows={3}>
            {(data) => (
              <CountList
                items={[
                  { label: t('keysOverdue'), count: data.overdue, href: listLink('/keys', { tab: 'overdue' }), warn: data.overdue > 0 },
                  { label: t('keysOut'), count: data.out, href: listLink('/keys', { tab: 'out' }) },
                  { label: t('keysLost'), count: data.lost, href: listLink('/keys', { tab: 'lost' }), warn: data.lost > 0 },
                ]}
              />
            )}
          </DashboardPanel>
        ) : null}
        {showProperty ? (
          <DashboardPanel title={t('locationsPanel')} result={locations} rows={2}>
            {(data) => (
              <CountList
                items={[
                  { label: t('locationsMissing'), count: data.missing, href: listLink('/properties', { 'filter[hasLocation]': 'false' }) },
                  { label: t('locationsStale'), count: data.stale, href: listLink('/properties', { 'filter[locationStale]': 'true' }), warn: data.stale > 0 },
                ]}
              />
            )}
          </DashboardPanel>
        ) : null}
        {showProperty ? (
          <DashboardPanel title={t('maintenancePanel')} result={maintenance} rows={3}>
            {(data) =>
              data.count === 0 ? (
                <p className={styles.quiet}>{t('maintenanceNone')}</p>
              ) : (
                <>
                  <p>
                    <strong className="ep-num">{t('maintenanceCount', { count: data.count })}</strong>
                  </p>
                  <div role="region" aria-label={t('maintenancePanel')} tabIndex={0} className={styles.tableRegion}>
                    <table className={styles.table}>
                      <caption className="ep-visually-hidden">{t('maintenancePanel')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('unit')}</th>
                          <th scope="col">{t('property')}</th>
                          <th scope="col">{t('until')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.units.map((unit) => (
                          <tr key={unit.unitId}>
                            <th scope="row">
                              <NextLink href={`/properties/${unit.propertyId}/units?unit=${unit.unitId}`}>
                                <bdi>{unit.unitLabel}</bdi>
                              </NextLink>
                              {unit.note ? (
                                <span className={styles.quiet} dir="auto">
                                  {' '}
                                  · {unit.note}
                                </span>
                              ) : null}
                            </th>
                            <td>
                              <NextLink href={`/properties/${unit.propertyId}`}>
                                <bdi>{unit.propertyName}</bdi>
                              </NextLink>
                            </td>
                            <td>{unit.until ? <When iso={unit.until} dateOnly /> : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {data.count > data.units.length ? <p className={styles.quiet}>{t('maintenanceMore')}</p> : null}
                </>
              )
            }
          </DashboardPanel>
        ) : null}
        {showProperty ? (
          <DashboardPanel title={t('mediaPanel')} result={media} rows={2}>
            {(data) => (
              <>
                {data.rejected === 0 ? (
                  <p className={styles.quiet}>{t('mediaNone')}</p>
                ) : (
                  <>
                    <p>
                      {t('mediaRejected')}: <strong className="ep-num">{format.number(data.rejected)}</strong>
                    </p>
                    <ul className={styles.list}>
                      {data.recent.map((item) => (
                        <li key={item.mediaId}>
                          <NextLink href={`/properties/${item.propertyId}/media`}>
                            <bdi>{item.fileName ?? t('unknownFile')}</bdi>
                          </NextLink>{' '}
                          · <bdi>{item.propertyName}</bdi>
                          {item.reason ? <span className={styles.quiet}> · {item.reason}</span> : null} · <When iso={item.at} />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {storage.data ? (
                  <p>
                    {t('storage')}:{' '}
                    <NextLink href="/settings/storage" className="ep-num">
                      {storage.data.limitBytes !== null
                        ? t('storageUsed', { used: format.bytes(storage.data.usedBytes), limit: format.bytes(storage.data.limitBytes) })
                        : t('storageUnlimited', { used: format.bytes(storage.data.usedBytes) })}
                    </NextLink>
                  </p>
                ) : null}
              </>
            )}
          </DashboardPanel>
        ) : null}
        {showMyKeys ? <MyKeysPanel /> : null}
      </div>
    </Page>
  );
}

function DashboardPanel<T>({ title, result, rows, children }: { title: string; result: UseQueryResult<T>; rows: number; children: (data: T) => ReactNode }) {
  return (
    <Panel title={title}>
      <div aria-busy={result.isPending || undefined}>
        {result.isPending ? (
          Array.from({ length: rows }, (_, index) => <Skeleton key={index} width={index % 2 === 0 ? '100%' : '80%'} />)
        ) : result.isError ? (
          <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
        ) : (
          children(result.data)
        )}
      </div>
    </Panel>
  );
}

function CountList({ items }: { items: Array<{ label: string; count: number; href: string; warn?: boolean }> }) {
  const t = useTranslations('dashboard');
  const format = useFormat();
  return (
    <ul className={styles.counts}>
      {items.map((item) => (
        <li key={item.label}>
          <NextLink href={item.href} className={styles.countLink} aria-label={t('countLink', { label: item.label, count: format.number(item.count) })}>
            <span>{item.label}</span>
            <span className={`ep-num ${styles.count} ${item.warn ? styles.warn : ''}`}>
              {item.warn ? <span aria-hidden="true">⚠ </span> : null}
              {format.number(item.count)}
              <span aria-hidden="true" className="ep-mirror">
                {' '}
                →
              </span>
            </span>
          </NextLink>
        </li>
      ))}
    </ul>
  );
}

/** D-2: the member's own key holdings, soonest due first. */
function MyKeysPanel() {
  const t = useTranslations('keys');
  const { session, can, readOnly } = useSession();
  const canIssue = can('key.issue') && !readOnly;
  const dialogs = useKeyDialogState();
  const result = useQuery({
    queryKey: ['dashboard', 'my-keys', session.membershipId],
    queryFn: () => bff<KeySetPageDto>(`key-sets${query({ 'filter[holderMembershipId]': session.membershipId, 'filter[status]': 'checked_out', sort: 'dueBackAt', limit: 50 })}`),
  });
  const undated = useQuery({
    // Keys out without a due time are not in the due-back sort; list them after.
    queryKey: ['dashboard', 'my-keys-undated', session.membershipId],
    queryFn: () => bff<KeySetPageDto>(`key-sets${query({ 'filter[holderMembershipId]': session.membershipId, 'filter[status]': 'checked_out', limit: 50 })}`),
  });
  const dated = result.data?.data ?? [];
  const all = [...dated, ...(undated.data?.data ?? []).filter((keySet) => keySet.dueBackAt === null)];
  return (
    <Panel title={t('myKeys')}>
      <div aria-busy={result.isPending || undefined}>
        {result.isPending ? (
          <Skeleton />
        ) : result.isError ? (
          <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
        ) : all.length === 0 ? (
          <p className={styles.quiet}>{t('myKeysEmpty')}</p>
        ) : (
          <ul className={styles.list}>
            {all.map((keySet) => (
              <li key={keySet.id} className={styles.keyRow}>
                <span>
                  <strong>
                    <bdi>{keySet.label}</bdi>
                  </strong>{' '}
                  <NextLink href={`/properties/${keySet.property.id}/keys`}>
                    <bdi>{keyWhere(keySet)}</bdi>
                  </NextLink>
                  {' · '}
                  {keySet.dueBackAt ? (
                    <span className={keySet.isOverdue ? styles.overdue : undefined}>
                      {keySet.isOverdue ? (
                        <StatusLabel tone="danger" icon="⚠">
                          {t('overdue')}
                        </StatusLabel>
                      ) : null}{' '}
                      {t.rich(keySet.isOverdue ? 'wasDue' : 'dueWhen', { when: () => <When iso={keySet.dueBackAt!} timeZone={keySet.property.timezone} /> })}
                    </span>
                  ) : (
                    t('noDueTime')
                  )}
                </span>
                {canIssue ? (
                  <Button size="small" onPress={() => dialogs.open(keySet, 'check-in')} aria-label={`${t('checkIn')} ${keySet.label}`}>
                    {t('checkIn')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {dialogs.dialogs}
    </Panel>
  );
}
