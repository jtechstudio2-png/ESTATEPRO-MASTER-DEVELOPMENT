'use client';

import { useTranslations } from 'next-intl';
import NextLink from 'next/link';
import { useState } from 'react';

import { ContactName, IdentityStatusLabel, Ltr, NextFollowUpCell, RoleList } from '@/components/crm/labels';
import { ExportDialog } from '@/components/exports/export-dialog';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, ErrorNotice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { SegmentedControl } from '@/components/ui/fields';
import { Page, PageHeader } from '@/components/ui/layout';
import { type Chip, FilterBar, FilterSelect, listStyles, LoadMore, MoreFilters, SearchBox, SortSelect } from '@/components/ui/list-controls';
import { When } from '@/components/ui/when';
import type { ContactSummaryDto } from '@/lib/api-schema';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useOffices, usePicklist } from '@/lib/hooks/reference';

import styles from './contacts.module.css';

const SORTS = ['displayName', '-displayName', '-updatedAt', 'updatedAt', '-createdAt', 'createdAt'] as const;
/** Relationship views of the one register (SH-1, decision D2); "all" has no filter. */
export const CONTACT_VIEWS = ['all', 'buyer', 'seller', 'landlord', 'tenant', 'applicant', 'supplier', 'other'] as const;
type View = (typeof CONTACT_VIEWS)[number];

/**
 * C-1 contact register with the Buyer, Seller, Landlord and Tenant views
 * (SE-1 and LL-1 lists). A person with two roles appears in both views. Phone
 * numbers are partly masked in lists; search never matches protected fields.
 */
export function ContactList() {
  const t = useTranslations('contacts');
  const crm = useTranslations('crm');
  const list = useTranslations('list');
  const { can, grant, readOnly, session } = useSession();
  const params = useListParams();
  const { offices } = useOffices('contact.view');
  const sources = usePicklist('lead_source');
  const [exporting, setExporting] = useState(false);

  const rawView = params.get('view');
  const view: View = CONTACT_VIEWS.includes(rawView as View) ? (rawView as View) : 'all';
  const sort = params.get('sort') ?? (view === 'all' ? 'displayName' : '-updatedAt');
  const query = new URLSearchParams(params.apiQuery);
  if (!query.has('sort')) query.set('sort', sort);
  if (view !== 'all') query.set('filter[relationship]', view);
  const result = usePagedList<ContactSummaryDto>('contacts', query);

  const showIdentity = can('kyc.view') && (view === 'seller' || view === 'landlord' || view === 'all');
  const chips: Chip[] = [];
  const q = params.get('q');
  if (q) chips.push({ key: 'q', label: `${list('search')}: ${q}`, onRemove: () => params.set({ q: null }) });
  const named = (key: string, label: string, value: (raw: string) => string) => {
    const raw = params.get(key);
    if (raw !== null) chips.push({ key, label: `${label}: ${value(raw)}`, onRemove: () => params.set({ [key]: null }) });
  };
  named('filter[officeId]', t('office'), (raw) => offices.find((office) => office.id === raw)?.name ?? raw);
  named('filter[ownerMembershipId]', t('owner'), (raw) => (raw === session.membershipId ? t('ownerMe') : raw));
  named('filter[sourceCode]', t('source'), (raw) => sources.data?.data.find((value) => value.code === raw)?.label ?? raw);
  named('filter[contactType]', t('contactType'), (raw) => crm(`contactType.${raw as 'person' | 'organisation'}`));
  named('filter[archived]', t('archivedFilter'), () => t('archivedOnly'));
  const filtered = chips.length > 0;
  const canCreate = can('contact.create') && !readOnly;
  const canExport = can('contact.export') && !readOnly;
  const scope = grant('contact.view')?.scope;

  const exportSummary = [
    view !== 'all' ? t(`views.${view}`) : null,
    params.get('filter[officeId]') ? offices.find((office) => office.id === params.get('filter[officeId]'))?.name ?? null : null,
    params.get('filter[contactType]') ? crm(`contactType.${params.get('filter[contactType]') as 'person' | 'organisation'}`) : null,
  ].filter((item): item is string => item !== null);

  const viewNav = (
    <nav aria-label={t('viewsLabel')} className={styles.views}>
      {CONTACT_VIEWS.map((id) => {
        const next = new URLSearchParams(params.searchParams.toString());
        next.delete('cursor');
        if (id === 'all') next.delete('view');
        else next.set('view', id);
        const text = next.toString();
        return (
          <NextLink key={id} href={text ? `/contacts?${text}` : '/contacts'} aria-current={view === id ? 'page' : undefined} className={styles.viewLink} scroll={false}>
            {t(`views.${id}`)}
          </NextLink>
        );
      })}
    </nav>
  );

  const filters = (
    <FilterBar chips={chips} onClearAll={() => params.clear(['sort', 'view'])} search={<SearchBox label={t('searchLabel')} value={q ?? ''} onChange={(value) => params.set({ q: value || null })} />}>
      {offices.length > 1 ? (
        <FilterSelect label={t('office')} value={params.get('filter[officeId]')} onChange={(value) => params.set({ 'filter[officeId]': value })} options={offices.map((office) => ({ id: office.id, label: office.name }))} />
      ) : null}
      {scope !== 'own' ? (
        <FilterSelect
          label={t('owner')}
          value={params.get('filter[ownerMembershipId]')}
          onChange={(value) => params.set({ 'filter[ownerMembershipId]': value })}
          options={[{ id: session.membershipId, label: t('ownerMe') }]}
        />
      ) : null}
      <SegmentedControl
        label={t('contactType')}
        value={params.get('filter[contactType]') ?? 'any'}
        onChange={(value) => params.set({ 'filter[contactType]': value === 'any' ? null : value })}
        options={[
          { id: 'any', label: list('any') },
          { id: 'person', label: crm('contactType.person') },
          { id: 'organisation', label: crm('contactType.organisation') },
        ]}
      />
      <MoreFilters activeCount={['filter[sourceCode]', 'filter[archived]'].filter((key) => params.get(key) !== null).length}>
        <FilterSelect
          label={t('source')}
          value={params.get('filter[sourceCode]')}
          onChange={(value) => params.set({ 'filter[sourceCode]': value })}
          options={(sources.data?.data ?? []).map((value) => ({ id: value.code, label: value.label }))}
        />
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
      <EmptyState title={list('emptyFiltered')} action={<Button onPress={() => params.clear(['sort', 'view'])}>{list('clearAll')}</Button>}>
        {list('emptyFilteredDetail')}
      </EmptyState>
    ) : (
      <EmptyState
        title={view === 'all' ? t('emptyTitle') : t('emptyView', { view: t(`views.${view}`) })}
        action={
          canCreate ? (
            <LinkButton href={view === 'all' ? '/contacts/new' : `/contacts/new?role=${view}`} variant="primary">
              {t('newContact')}
            </LinkButton>
          ) : undefined
        }
      >
        {scope === 'own' ? t('emptyOwn') : t('emptyDetail')}
      </EmptyState>
    )
  ) : (
    <DataTable
      caption={view === 'all' ? t('list') : t('listView', { view: t(`views.${view}`) })}
      rows={result.rows}
      rowKey={(row) => row.id}
      sortNote={list('sortedBy', { sort: t(`sort.${sort as (typeof SORTS)[number]}`) })}
      identifier={{
        header: t('name'),
        href: (row) => `/contacts/${row.id}`,
        label: (row) => <ContactName name={row.displayName} local={row.displayNameLocal} />,
        secondary: (row) => (
          <>
            {row.reference ? <Ltr>{row.reference}</Ltr> : null}
            {row.reference ? ' · ' : null}
            {crm(`contactType.${row.contactType}`)}
            {row.archivedAt ? ` · ${t('archivedTag')}` : null}
          </>
        ),
      }}
      columns={[
        { key: 'roles', header: t('roles'), cell: (row) => <RoleList roles={row.roles} />, onCard: true },
        { key: 'phone', header: t('phone'), cell: (row) => (row.primaryPhoneMasked ? <Ltr>{row.primaryPhoneMasked}</Ltr> : '—'), onCard: true },
        ...(showIdentity
          ? [{ key: 'identity', header: t('identityCheck'), cell: (row: ContactSummaryDto) => (row.identityCheck ? <IdentityStatusLabel status={row.identityCheck.status} /> : '—') }]
          : []),
        ...(view === 'seller' || view === 'landlord'
          ? [{ key: 'listings', header: t('listings'), cell: (row: ContactSummaryDto) => <ListingsCell summary={row.listings} />, onCard: true }]
          : []),
        ...(view === 'seller'
          ? [
              {
                key: 'valuation',
                header: t('valuationLead'),
                cell: (row: ContactSummaryDto) =>
                  row.valuationLead ? (
                    <NextLink href={`/leads/${row.valuationLead.id}`}>
                      <Ltr>{row.valuationLead.reference}</Ltr> {crm(`leadStatus.${row.valuationLead.status as 'new'}`)}
                    </NextLink>
                  ) : (
                    '—'
                  ),
              },
            ]
          : []),
        ...(view === 'landlord'
          ? [{ key: 'properties', header: t('propertiesCount'), cell: (row: ContactSummaryDto) => (row.properties === null || row.properties === undefined ? '—' : <span className="ep-num">{row.properties}</span>), align: 'end' as const }]
          : []),
        {
          key: 'next',
          header: t('next'),
          cell: (row) => <NextFollowUpCell next={row.nextFollowUp} warnWhenNone={view === 'buyer' || view === 'seller'} />,
          onCard: view !== 'all',
        },
        { key: 'owner', header: t('owner'), cell: (row) => (row.owner ? <bdi>{row.owner.name}</bdi> : <span>{t('ownerNone')}</span>) },
        { key: 'office', header: t('office'), cell: (row) => (row.office ? <bdi>{row.office.name}</bdi> : '—') },
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
  );

  return (
    <Page>
      <PageHeader
        title={view === 'all' ? t('title') : t(`viewTitles.${view}`)}
        actions={
          <>
            {canExport ? <Button onPress={() => setExporting(true)}>{t('export')}</Button> : null}
            {canCreate ? (
              <LinkButton href={view === 'all' ? '/contacts/new' : `/contacts/new?role=${view}`} variant="primary">
                {t('newContact')}
              </LinkButton>
            ) : null}
          </>
        }
      />
      {viewNav}
      {filters}
      <div className={listStyles.toolbar}>
        <SortSelect value={sort} onChange={(value) => params.set({ sort: value })} options={SORTS.map((id) => ({ id, label: t(`sort.${id}`) }))} />
      </div>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {body}
      {exporting ? (
        <ExportDialog
          request={{
            kind: 'contacts',
            filters: {
              ...(view !== 'all' ? { relationships: [view] } : {}),
              ...(params.get('filter[officeId]') ? { officeId: params.get('filter[officeId]')! } : {}),
              ...(params.get('filter[contactType]') ? { contactType: params.get('filter[contactType]') as 'person' | 'organisation' } : {}),
            },
          }}
          summary={exportSummary}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </Page>
  );
}

/** SE-1 and LL-1 "Listings": the latest listing on their units, and how many more (only listings the viewer may see). */
function ListingsCell({ summary }: { summary: ContactSummaryDto['listings'] }) {
  const t = useTranslations('contacts');
  if (summary === null || summary === undefined) return <span>—</span>;
  if (summary.active === 0 || summary.latest === null) return <span>{t('noListings')}</span>;
  return (
    <span>
      <NextLink href={`/listings/${summary.latest.id}`}>
        <Ltr>{summary.latest.reference}</Ltr>
      </NextLink>{' '}
      {summary.latest.isPublished ? t('published') : t('notPublished')}
      {summary.active > 1 ? ` ${t('moreListings', { count: summary.active - 1 })}` : ''}
    </span>
  );
}
