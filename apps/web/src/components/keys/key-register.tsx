'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useProperty } from '@/components/properties/use-property';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { TextField } from '@/components/ui/fields';
import { Fieldset, Page, PageHeader, Panel, RecordTabs } from '@/components/ui/layout';
import { type Chip, FilterBar, FilterSelect, listStyles, LoadMore, SortSelect } from '@/components/ui/list-controls';
import { ActionsMenu } from '@/components/ui/menu';
import { PeoplePicker } from '@/components/ui/people-picker';
import { When } from '@/components/ui/when';
import type { KeySetDto, KeysPanelDto, PropertyPageDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useOffices } from '@/lib/hooks/reference';

import { type KeyAction, KeySetFormDialog, keyWhere, useKeyActions, useKeyDialogState } from './key-dialogs';
import styles from './keys.module.css';

const ACTIVE = 'in_office,checked_out,with_owner,lost';
const TABS = ['out', 'overdue', 'all', 'lost', 'retired'] as const;
type Tab = (typeof TABS)[number];
const TAB_FILTERS: Record<Tab, Record<string, string>> = {
  out: { 'filter[status]': 'checked_out' },
  overdue: { 'filter[status]': 'checked_out', 'filter[overdue]': 'true' },
  all: { 'filter[status]': ACTIVE },
  lost: { 'filter[status]': 'lost' },
  retired: { 'filter[status]': 'retired' },
};
const SORTS = ['dueBackAt', '-updatedAt'] as const;

/** Status as text plus icon; overdue is never colour alone (K-1, K-2). */
function KeyStatus({ keySet }: { keySet: KeySetDto }) {
  const t = useTranslations('keys');
  if (keySet.isOverdue) {
    return (
      <StatusLabel tone="danger" icon="⚠">
        {t('overdue')}
      </StatusLabel>
    );
  }
  const tone = keySet.status === 'lost' ? 'danger' : keySet.status === 'checked_out' ? 'warning' : keySet.status === 'retired' ? 'neutral' : keySet.status === 'with_owner' ? 'info' : 'success';
  return <StatusLabel tone={tone}>{t(`status.${keySet.status}`)}</StatusLabel>;
}

function holderName(keySet: KeySetDto, t: ReturnType<typeof useTranslations<'keys'>>): string | null {
  if (!keySet.holder) return null;
  return keySet.holder.type === 'contact' ? t('contactHolder', { name: keySet.holder.displayName }) : keySet.holder.displayName;
}

/** Due back in the property's time zone, with "was due" once overdue. */
function DueBack({ keySet }: { keySet: KeySetDto }) {
  const t = useTranslations('keys');
  if (keySet.status !== 'checked_out') return <>—</>;
  if (!keySet.dueBackAt) return <span className={styles.meta}>{t('noDueTime')}</span>;
  return (
    <span className={keySet.isOverdue ? styles.overdue : undefined}>
      {keySet.isOverdue ? <span aria-hidden="true">⚠ </span> : null}
      {t.rich(keySet.isOverdue ? 'wasDue' : 'dueWhen', { when: () => <When iso={keySet.dueBackAt!} timeZone={keySet.property.timezone} /> })}
    </span>
  );
}

/** The row's primary move as a button and the rest in "More actions". */
function KeyRowActions({ keySet, open }: { keySet: KeySetDto; open: (keySet: KeySetDto, action: KeyAction) => void }) {
  const common = useTranslations('common');
  const { primary, menu } = useKeyActions(keySet, (action) => open(keySet, action));
  return (
    <span className={styles.rowActions}>
      {primary ? (
        <Button size="small" onPress={() => open(keySet, primary.action)} aria-label={`${primary.label} ${keySet.label}`}>
          {primary.label}
        </Button>
      ) : null}
      <ActionsMenu label={common('moreActions', { name: keySet.label })} actions={menu} />
    </span>
  );
}

/** K-1 property keys tab: every set for this property and where it is now. */
export function PropertyKeysTab({ propertyId }: { propertyId: string }) {
  const t = useTranslations('keys');
  const { can, readOnly } = useSession();
  const params = useListParams();
  const property = useProperty(propertyId);
  const dialogs = useKeyDialogState();
  const [adding, setAdding] = useState(false);
  const showRetired = params.get('view') === 'retired';
  const listQuery = new URLSearchParams({ sort: 'label' });
  if (showRetired) listQuery.set('filter[status]', `${ACTIVE},retired`);
  const result = usePagedList<KeySetDto>(`properties/${propertyId}/key-sets`, listQuery, { limit: 50 });
  const canAdd = can('key.manage') && !readOnly && property.data?.archivedAt === null;
  const propertyName = property.data ? (property.data.name ?? property.data.reference) : '';

  return (
    <Panel
      title={t('title')}
      actions={
        canAdd ? (
          <Button variant="primary" onPress={() => setAdding(true)}>
            {t('addKeySet')}
          </Button>
        ) : undefined
      }
    >
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <div aria-busy="true">
          <Skeleton />
          <Skeleton width="80%" />
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState headingLevel={3} title={t('empty')}>
          {t('emptyDetail')}
        </EmptyState>
      ) : (
        <DataTable
          caption={t('list')}
          rows={result.rows}
          rowKey={(row) => row.id}
          identifier={{ header: t('tag'), label: (row) => <bdi className="ep-num">{row.label}</bdi>, secondary: (row) => (row.unitLabel ? <bdi>{row.unitLabel}</bdi> : null) }}
          status={{ header: t('statusLabel'), cell: (row) => <KeyStatus keySet={row} /> }}
          columns={[
            { key: 'unit', header: t('unit'), cell: (row) => (row.unitLabel ? <bdi>{row.unitLabel}</bdi> : '—') },
            { key: 'contents', header: t('contents'), cell: (row) => (row.description ? <bdi>{row.description}</bdi> : '—') },
            {
              key: 'holder',
              header: t('holderDue'),
              onCard: true,
              cell: (row) =>
                row.holder ? (
                  <>
                    <bdi>{holderName(row, t)}</bdi>
                    <span className={styles.due}>
                      <DueBack keySet={row} />
                    </span>
                  </>
                ) : (
                  '—'
                ),
            },
          ]}
          actions={(row) => <KeyRowActions keySet={row} open={dialogs.open} />}
          actionsHeader={t('actionsHeader')}
          footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
        />
      )}
      <div className={listStyles.footer}>
        <Button variant="quiet" onPress={() => params.set({ view: showRetired ? null : 'retired' })} aria-pressed={showRetired}>
          {t('showRetired')}
        </Button>
      </div>
      {dialogs.dialogs}
      {adding ? <KeySetFormDialog propertyId={propertyId} propertyName={propertyName} onOpenChange={(open) => setAdding(open)} /> : null}
    </Panel>
  );
}

/**
 * K-2 company key register (X-4 on phones: the table becomes cards). The
 * tab counts come from the keys panel, which applies the member's office
 * scope before counting.
 */
export function KeyRegister() {
  const t = useTranslations('keys');
  const list = useTranslations('list');
  const { can, readOnly } = useSession();
  const params = useListParams();
  const dialogs = useKeyDialogState();
  const { offices } = useOffices('key.view');
  const rawTab = params.get('tab');
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'out';
  const officeId = params.get('filter[officeId]');
  const holderId = params.get('filter[holderMembershipId]');
  const sort = params.get('sort') ?? (tab === 'out' || tab === 'overdue' ? 'dueBackAt' : '-updatedAt');

  const listQuery = new URLSearchParams(params.apiQuery);
  for (const [key, value] of Object.entries(TAB_FILTERS[tab])) listQuery.set(key, value);
  listQuery.set('sort', sort);
  const result = usePagedList<KeySetDto>('key-sets', listQuery, { limit: 50 });
  const counts = useQuery({
    queryKey: ['list', 'key-counts', officeId],
    queryFn: () => bff<KeysPanelDto>(`dashboards/property/keys${query({ 'filter[officeId]': officeId ?? undefined })}`),
  });

  const tabHref = (id: Tab) => {
    const next = new URLSearchParams();
    if (id !== 'out') next.set('tab', id);
    if (officeId) next.set('filter[officeId]', officeId);
    if (holderId) {
      next.set('filter[holderMembershipId]', holderId);
      next.set('holderName', params.get('holderName') ?? '');
    }
    const search = next.toString();
    return search ? `/keys?${search}` : '/keys';
  };
  // Counts describe the office scope only; with a holder filter they would mislead.
  const count = (id: Tab) => (holderId === null && counts.data ? (id === 'out' ? counts.data.out : id === 'overdue' ? counts.data.overdue : id === 'lost' ? counts.data.lost : null) : null);

  const chips: Chip[] = [];
  if (officeId) chips.push({ key: 'office', label: `${t('office')}: ${offices.find((office) => office.id === officeId)?.name ?? officeId}`, onRemove: () => params.set({ 'filter[officeId]': null }) });
  if (holderId) chips.push({ key: 'holder', label: `${t('holder')}: ${params.get('holderName') ?? ''}`, onRemove: () => params.set({ 'filter[holderMembershipId]': null, holderName: null }) });
  const holderValue = holderId ? { membershipId: holderId, displayName: params.get('holderName') ?? '' } : null;
  const canAdd = can('key.manage') && !readOnly;

  return (
    <Page>
      <PageHeader
        title={t('registerTitle')}
        actions={
          canAdd ? (
            <LinkButton href="/keys/new" variant="primary">
              {t('addKeySet')}
            </LinkButton>
          ) : undefined
        }
      />
      <RecordTabs label={t('views')} tabs={TABS.map((id) => ({ href: tabHref(id), label: t(`tabs.${id}`), count: count(id), current: id === tab }))} />
      <FilterBar chips={chips} onClearAll={() => params.set({ 'filter[officeId]': null, 'filter[holderMembershipId]': null, holderName: null })}>
        {offices.length > 1 ? (
          <FilterSelect label={t('office')} value={officeId} onChange={(value) => params.set({ 'filter[officeId]': value })} options={offices.map((office) => ({ id: office.id, label: office.name }))} />
        ) : null}
        <PeoplePicker
          key={holderId ?? 'anyone'}
          label={t('holder')}
          value={holderValue}
          onChange={(member) => params.set({ 'filter[holderMembershipId]': member?.membershipId ?? null, holderName: member?.displayName ?? null })}
          description={holderId ? undefined : t('anyone')}
        />
      </FilterBar>
      <div className={listStyles.toolbar}>
        <SortSelect value={sort} onChange={(value) => params.set({ sort: value })} options={SORTS.map((id) => ({ id, label: id === 'dueBackAt' ? t('sortDue') : t('sortUpdated') }))} />
      </div>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {result.isPending ? (
        <div aria-busy="true" aria-label={t('list')}>
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} />
          ))}
        </div>
      ) : result.isError ? (
        <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
      ) : result.rows.length === 0 ? (
        <EmptyState
          title={t('emptyRegister')}
          action={chips.length > 0 ? <Button onPress={() => params.set({ 'filter[officeId]': null, 'filter[holderMembershipId]': null, holderName: null })}>{list('clearAll')}</Button> : undefined}
        >
          {chips.length > 0 ? list('emptyFilteredDetail') : t('emptyRegisterDetail')}
        </EmptyState>
      ) : (
        <DataTable
          caption={t('list')}
          rows={result.rows}
          rowKey={(row) => row.id}
          sortNote={list('sortedBy', { sort: sort === 'dueBackAt' ? t('sortDue') : t('sortUpdated') })}
          identifier={{
            header: `${t('tag')} · ${t('propertyUnit')}`,
            href: (row) => `/properties/${row.property.id}/keys`,
            label: (row) => (
              <>
                <bdi className="ep-num">{row.label}</bdi> · <bdi>{keyWhere(row)}</bdi>
              </>
            ),
          }}
          status={{ header: t('statusLabel'), cell: (row) => <KeyStatus keySet={row} /> }}
          columns={[
            { key: 'holder', header: t('holder'), cell: (row) => (row.holder ? <bdi>{holderName(row, t)}</bdi> : '—'), onCard: true },
            { key: 'out', header: t('outSince'), cell: (row) => (row.checkedOutAt && row.status === 'checked_out' ? <When iso={row.checkedOutAt} timeZone={row.property.timezone} /> : '—') },
            { key: 'due', header: t('dueBack'), cell: (row) => <DueBack keySet={row} />, onCard: true, ...(sort === 'dueBackAt' ? { sort: 'ascending' as const } : {}) },
          ]}
          actions={(row) => <KeyRowActions keySet={row} open={dialogs.open} />}
          actionsHeader={t('actionsHeader')}
          footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
        />
      )}
      {dialogs.dialogs}
    </Page>
  );
}

/** Quick create from the "New" menu: choose the property, then K-5. */
export function NewKeySet() {
  const t = useTranslations('keys');
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const properties = useQuery({
    queryKey: ['list', 'key-set-properties', search],
    queryFn: () => bff<PropertyPageDto>(`properties${query({ q: search.trim(), limit: 20 })}`),
    enabled: search.trim().length >= 2,
  });
  return (
    <Page>
      <PageHeader title={t('newTitle')} back={{ href: '/keys', label: t('registerTitle') }} />
      <Panel>
        <Fieldset legend={t('chooseProperty')}>
          <TextField label={t('propertySearch')} value={search} onChange={setSearch} description={t('propertySearchHint')} autoComplete="off" />
          {properties.isError ? <ErrorNotice error={properties.error} onRetry={() => void properties.refetch()} /> : null}
          {properties.data && properties.data.data.length === 0 ? <p className={styles.meta}>{t('noProperties')}</p> : null}
          <ul className={styles.myKeys} aria-label={t('propertySearch')}>
            {(properties.data?.data ?? [])
              .filter((item) => item.archivedAt === null)
              .map((item) => (
                <li key={item.id}>
                  <span>
                    <bdi className="ep-num">{item.reference}</bdi> · <bdi>{item.name ?? item.formattedAddress ?? ''}</bdi>
                  </span>
                  <Button size="small" onPress={() => setPicked({ id: item.id, name: item.name ?? item.reference })} aria-label={t('addTo', { property: item.name ?? item.reference })}>
                    {t('choose')}
                  </Button>
                </li>
              ))}
          </ul>
        </Fieldset>
      </Panel>
      {picked ? (
        <KeySetFormDialog
          propertyId={picked.id}
          propertyName={picked.name}
          onOpenChange={(open) => (open ? undefined : setPicked(null))}
          onSaved={() => router.push(`/properties/${picked.id}/keys`)}
        />
      ) : null}
    </Page>
  );
}
