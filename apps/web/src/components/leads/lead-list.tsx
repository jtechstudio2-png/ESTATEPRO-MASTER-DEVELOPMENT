'use client';

import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { LEAD_TYPES, LeadStatusLabel, Ltr, ResponseLabel } from '@/components/crm/labels';
import { ExportDialog } from '@/components/exports/export-dialog';
import contactStyles from '@/components/contacts/contacts.module.css';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { TextField } from '@/components/ui/fields';
import { Page, PageHeader, Panel } from '@/components/ui/layout';
import { type Chip, FilterBar, FilterSelect, listStyles, LoadMore, MoreFilters, SearchBox, SortSelect } from '@/components/ui/list-controls';
import { PeoplePicker, type PickedMember } from '@/components/ui/people-picker';
import { When } from '@/components/ui/when';
import type { LeadSummaryDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useOffices, usePicklist } from '@/lib/hooks/reference';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

const TABS = ['inbox', 'mine', 'unassigned', 'open', 'closed'] as const;
type Tab = (typeof TABS)[number];
const SORTS = ['-receivedAt', 'receivedAt', '-updatedAt', 'updatedAt'] as const;
const OPEN = 'new,contacted,qualified';
const CLOSED = 'unqualified,converted,lost';

/** The API filters of an inbox tab (L-1). */
function tabFilters(tab: Tab): Record<string, string> {
  switch (tab) {
    case 'inbox':
      return { 'filter[status]': 'new' };
    case 'mine':
      return { 'filter[assignedTo]': 'me', 'filter[status]': OPEN };
    case 'unassigned':
      return { 'filter[assignedTo]': 'unassigned', 'filter[status]': OPEN };
    case 'open':
      return { 'filter[status]': OPEN };
    case 'closed':
      return { 'filter[status]': CLOSED };
  }
}

/**
 * L-1 lead inbox and register; embedded in the contact record (Leads tab)
 * with the contact fixed. Rows show the first line of the enquiry only, and
 * "past target" appears only when the company has set a response target.
 */
export function LeadList({ contactId }: { contactId?: string }) {
  const t = useTranslations('leads');
  const crm = useTranslations('crm');
  const list = useTranslations('list');
  const { can, readOnly } = useSession();
  const params = useListParams();
  const { offices } = useOffices('lead.view');
  const sources = usePicklist('lead_source');
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const canAssign = can('lead.assign') && !readOnly;
  const tabs = TABS.filter((tab) => tab !== 'unassigned' || can('lead.assign'));
  const rawTab = params.get('tab');
  const tab: Tab = contactId ? 'open' : tabs.includes(rawTab as Tab) ? (rawTab as Tab) : 'inbox';
  const sort = params.get('sort') ?? (tab === 'inbox' ? 'receivedAt' : '-receivedAt');

  const query = new URLSearchParams(params.apiQuery);
  if (contactId) {
    query.set('filter[contactId]', contactId);
    if (!query.has('filter[archived]')) query.set('filter[archived]', 'all');
  } else {
    for (const [key, value] of Object.entries(tabFilters(tab))) if (!query.has(key)) query.set(key, value);
  }
  if (!query.has('sort')) query.set('sort', sort);
  const result = usePagedList<LeadSummaryDto>('leads', query);

  const chips: Chip[] = [];
  const q = params.get('q');
  if (q) chips.push({ key: 'q', label: `${list('search')}: ${q}`, onRemove: () => params.set({ q: null }) });
  const named = (key: string, label: string, value: (raw: string) => string) => {
    const raw = params.get(key);
    if (raw !== null) chips.push({ key, label: `${label}: ${value(raw)}`, onRemove: () => params.set({ [key]: null }) });
  };
  named('filter[leadType]', t('type'), (raw) => raw.split(',').map((id) => crm(`leadType.${id as (typeof LEAD_TYPES)[number]}`)).join(', '));
  named('filter[sourceCode]', t('source'), (raw) => sources.data?.data.find((value) => value.code === raw)?.label ?? raw);
  named('filter[officeId]', t('office'), (raw) => offices.find((office) => office.id === raw)?.name ?? raw);
  named('filter[attention]', t('attentionLabel'), (raw) => raw.split(',').map((id) => t(`attention.${id as 'response_overdue' | 'no_next_action'}`)).join(', '));
  named('filter[receivedAt][gte]', t('receivedFrom'), (raw) => raw.slice(0, 10));
  named('filter[archived]', t('archivedFilter'), () => t('archivedOnly'));
  const filtered = chips.length > 0;
  const sourceLabel = (code: string) => sources.data?.data.find((value) => value.code === code)?.label ?? code;

  const tabHref = (id: Tab) => {
    const next = new URLSearchParams();
    if (id !== 'inbox') next.set('tab', id);
    const text = next.toString();
    return text ? `/leads?${text}` : '/leads';
  };

  const body = result.isPending ? (
    <div aria-busy="true" aria-label={t('list')}>
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} />
      ))}
    </div>
  ) : result.isError ? (
    <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
  ) : result.rows.length === 0 ? (
    filtered ? (
      <EmptyState title={list('emptyFiltered')} action={<Button onPress={() => params.clear(['sort', 'tab'])}>{list('clearAll')}</Button>}>
        {list('emptyFilteredDetail')}
      </EmptyState>
    ) : (
      <EmptyState title={contactId ? t('emptyContact') : t(`empty.${tab}`)}>{t('emptyDetail')}</EmptyState>
    )
  ) : (
    <DataTable
      caption={contactId ? t('contactLeads') : t(`tab.${tab}`)}
      rows={result.rows}
      rowKey={(row) => row.id}
      sortNote={list('sortedBy', { sort: t(`sort.${sort as (typeof SORTS)[number]}`) })}
      {...(canAssign && !contactId
        ? {
            selection: {
              header: <span className="ep-visually-hidden">{t('select')}</span>,
              isSelected: (row: LeadSummaryDto) => selected.has(row.id),
              toggle: (row: LeadSummaryDto) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(row.id)) next.delete(row.id);
                  else next.add(row.id);
                  return next;
                }),
              label: (row: LeadSummaryDto) => t('selectNamed', { reference: row.reference }),
            },
          }
        : {})}
      identifier={{
        header: t('lead'),
        href: (row) => `/leads/${row.id}`,
        label: (row) => (
          <>
            <bdi dir="auto">{row.contact.name}</bdi> · <Ltr>{row.reference}</Ltr>
          </>
        ),
        secondary: (row) => (
          <>
            {crm(`leadType.${row.leadType}`)}
            {row.listing ? (
              <>
                {' · '}
                <Ltr>{row.listing.reference}</Ltr> <bdi dir="auto">{row.listing.title}</bdi>
              </>
            ) : null}
            {row.messagePreview ? (
              <>
                {' · '}
                <bdi dir="auto">{row.messagePreview}</bdi>
              </>
            ) : null}
          </>
        ),
      }}
      status={{
        header: t('status'),
        cell: (row) => (
          <span className={contactStyles.actions}>
            <LeadStatusLabel status={row.status} />
            <ResponseLabel response={row.response} />
          </span>
        ),
      }}
      columns={[
        { key: 'received', header: t('received'), cell: (row) => <When iso={row.receivedAt} />, onCard: true, ...(sort.endsWith('receivedAt') ? { sort: sort.startsWith('-') ? ('descending' as const) : ('ascending' as const) } : {}) },
        { key: 'source', header: t('source'), cell: (row) => sourceLabel(row.sourceCode) },
        { key: 'assigned', header: t('assigned'), cell: (row) => (row.assignedTo ? <bdi>{row.assignedTo.name}</bdi> : <span>{t('unassigned')}</span>), onCard: true },
        { key: 'phone', header: t('phone'), cell: (row) => (row.contact.primaryPhoneMasked ? <Ltr>{row.contact.primaryPhoneMasked}</Ltr> : '—') },
        { key: 'next', header: t('nextAction'), cell: (row) => (row.nextActionAt ? <When iso={row.nextActionAt} /> : row.status === 'new' || row.status === 'contacted' || row.status === 'qualified' ? <span>{t('noNextAction')}</span> : '—') },
      ]}
      footer={<LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={result.rows.length} />}
    />
  );

  const filters = (
    <FilterBar chips={chips} onClearAll={() => params.clear(['sort', 'tab'])} search={<SearchBox label={t('searchLabel')} value={q ?? ''} onChange={(value) => params.set({ q: value || null })} />}>
      <FilterSelect label={t('type')} value={params.get('filter[leadType]')} onChange={(value) => params.set({ 'filter[leadType]': value })} options={LEAD_TYPES.map((id) => ({ id, label: crm(`leadType.${id}`) }))} />
      <FilterSelect label={t('source')} value={params.get('filter[sourceCode]')} onChange={(value) => params.set({ 'filter[sourceCode]': value })} options={(sources.data?.data ?? []).map((value) => ({ id: value.code, label: value.label }))} />
      {offices.length > 1 ? (
        <FilterSelect label={t('office')} value={params.get('filter[officeId]')} onChange={(value) => params.set({ 'filter[officeId]': value })} options={offices.map((office) => ({ id: office.id, label: office.name }))} />
      ) : null}
      <MoreFilters activeCount={['filter[attention]', 'filter[receivedAt][gte]', 'filter[archived]'].filter((key) => params.get(key) !== null).length}>
        <FilterSelect
          label={t('attentionLabel')}
          value={params.get('filter[attention]')}
          onChange={(value) => params.set({ 'filter[attention]': value })}
          options={(['response_overdue', 'no_next_action'] as const).map((id) => ({ id, label: t(`attention.${id}`) }))}
        />
        <TextField label={t('receivedFrom')} type="date" value={params.get('filter[receivedAt][gte]')?.slice(0, 10) ?? ''} onChange={(value) => params.set({ 'filter[receivedAt][gte]': value ? `${value}T00:00:00Z` : null })} />
        <FilterSelect label={t('archivedFilter')} value={params.get('filter[archived]')} onChange={(value) => params.set({ 'filter[archived]': value })} options={[{ id: 'true', label: t('archivedOnly') }]} />
      </MoreFilters>
    </FilterBar>
  );

  if (contactId) {
    return (
      <Panel
        title={t('contactLeads')}
        actions={
          can('lead.create') && !readOnly ? (
            <LinkButton href={`/leads/new?contactId=${contactId}`} variant="primary">
              {t('newLead')}
            </LinkButton>
          ) : undefined
        }
      >
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
            {can('lead.export') && !readOnly ? <Button onPress={() => setExporting(true)}>{t('export')}</Button> : null}
            {can('lead.create') && !readOnly ? (
              <LinkButton href="/leads/new" variant="primary">
                {t('newLead')}
              </LinkButton>
            ) : null}
          </>
        }
      />
      <nav aria-label={t('tabsLabel')} className={contactStyles.views}>
        {tabs.map((id) => (
          <NextLink key={id} href={tabHref(id)} aria-current={tab === id ? 'page' : undefined} className={contactStyles.viewLink} scroll={false}>
            {t(`tab.${id}`)}
          </NextLink>
        ))}
      </nav>
      {filters}
      <div className={listStyles.toolbar}>
        <SortSelect value={sort} onChange={(value) => params.set({ sort: value })} options={SORTS.map((id) => ({ id, label: t(`sort.${id}`) }))} />
        {selected.size > 0 ? (
          <span className={contactStyles.actions} role="group" aria-label={list('bulkActions')}>
            <span>{t('selectedCount', { count: selected.size })}</span>
            <Button onPress={() => setAssigning(true)}>{t('assignSelected')}</Button>
            <Button variant="quiet" onPress={() => setSelected(new Set())}>
              {t('clearSelection')}
            </Button>
          </span>
        ) : null}
      </div>
      <RefreshBar active={result.isFetching && !result.isPending} />
      {body}
      {exporting ? (
        <ExportDialog
          request={{
            kind: 'leads',
            filters: {
              ...(params.get('filter[officeId]') ? { officeId: params.get('filter[officeId]')! } : {}),
              ...(params.get('filter[leadType]') ? { leadTypes: params.get('filter[leadType]')!.split(',') as Array<(typeof LEAD_TYPES)[number]> } : {}),
              statuses: (tabFilters(tab)['filter[status]'] ?? OPEN).split(',') as Array<LeadSummaryDto['status']>,
              ...(params.get('filter[receivedAt][gte]') ? { receivedFrom: params.get('filter[receivedAt][gte]')! } : {}),
            },
          }}
          summary={[t(`tab.${tab}`), ...(params.get('filter[officeId]') ? [offices.find((office) => office.id === params.get('filter[officeId]'))?.name ?? ''] : [])]}
          onClose={() => setExporting(false)}
        />
      ) : null}
      {assigning ? (
        <BulkAssignDialog
          leads={result.rows.filter((row) => selected.has(row.id))}
          onClose={(done) => {
            setAssigning(false);
            if (done) setSelected(new Set());
          }}
        />
      ) : null}
    </Page>
  );
}

/**
 * Bulk assign (L-1, `lead.assign`): one request per lead with that lead's
 * version, so a lead changed by someone else is reported, never overwritten.
 */
function BulkAssignDialog({ leads, onClose }: { leads: LeadSummaryDto[]; onClose: (done: boolean) => void }) {
  const t = useTranslations('leads');
  const list = useTranslations('list');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [assignee, setAssignee] = useState<PickedMember | null>(null);
  const [missing, setMissing] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (assignee === null) {
      setMissing(true);
      return;
    }
    setBusy(true);
    const failed: string[] = [];
    let done = 0;
    for (const lead of leads) {
      try {
        const current = await bff<{ version: number }>(`leads/${lead.id}`);
        await bff(`leads/${lead.id}/assign`, { method: 'POST', version: current.version, body: { assignedTo: assignee.membershipId } });
        done += 1;
      } catch (caught) {
        failed.push(list('bulkFailedRow', { name: lead.reference, reason: caught instanceof ApiError ? (caught.problem.detail ?? caught.problem.title) : t('networkFailed') }));
      }
    }
    announce(list('bulkResult', { done, failed: failed.length }));
    await refresh();
    setBusy(false);
    if (failed.length === 0) onClose(true);
    else setFailures(failed);
  };
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose(false))}
      title={t('bulkAssignTitle', { count: leads.length })}
      consequence={t('bulkAssignConsequence')}
      confirmLabel={t('assign')}
      onConfirm={() => void submit()}
      busy={busy}
    >
      {failures.length > 0 ? (
        <Notice tone="warning" title={t('bulkPartial')}>
          <ul>
            {failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <PeoplePicker
        label={t('assignTo')}
        value={assignee}
        onChange={(member) => {
          setAssignee(member);
          setMissing(false);
        }}
        permission="lead.view"
        isRequired
        error={missing ? t('assigneeRequired') : undefined}
      />
    </ConfirmDialog>
  );
}
