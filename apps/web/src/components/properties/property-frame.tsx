'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { LinkButton } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Page, PageHeader, RecordTabs } from '@/components/ui/layout';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import type { PropertyDto } from '@/lib/api-schema';
import { bffRequest } from '@/lib/bff';
import { useDocumentTitle } from '@/lib/hooks/document-title';
import { useFormat } from '@/lib/hooks/format';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import { LocationStatus } from './property-list';
import { propertyTitle, useProperty, usePropertySummary } from './use-property';

/**
 * The property record page (P-2 pattern, Phase 3 07 §1): header with the
 * primary action, overflow menu and tabs. Tabs appear only with their own
 * permission; the URL holds the tab.
 */
export function PropertyFrame({ id, children }: { id: string; children: ReactNode }) {
  const t = useTranslations('properties');
  const common = useTranslations('common');
  const errors = useTranslations('errors');
  const pathname = usePathname();
  const router = useRouter();
  const announce = useAnnounce();
  const format = useFormat();
  const { can, readOnly } = useSession();
  const property = useProperty(id);
  const summary = usePropertySummary(id);
  const [dialog, setDialog] = useState<'archive' | 'restore' | null>(null);
  useDocumentTitle(property.data ? propertyTitle(property.data) : null);

  if (property.isPending) {
    return (
      <Page>
        <div aria-busy="true">
          <Skeleton width="40%" />
          <Skeleton width="60%" />
          <Skeleton />
        </div>
      </Page>
    );
  }
  if (property.isError) {
    return (
      <Page>
        {property.error instanceof ApiError && property.error.status === 404 ? (
          <EmptyState title={t('notFound')} action={<LinkButton href="/properties">{t('backToList')}</LinkButton>}>
            {errors('notFoundDetail')}
          </EmptyState>
        ) : (
          <ErrorNotice error={property.error} onRetry={() => void property.refetch()} />
        )}
      </Page>
    );
  }

  const record = property.data;
  const counts = summary.data;
  const base = `/properties/${id}`;
  const tabs = [
    { href: base, label: t('tabs.overview'), current: pathname === base },
    { href: `${base}/units`, label: t('tabs.units'), count: counts?.units.total ?? null, current: pathname.startsWith(`${base}/units`) },
    { href: `${base}/ownership`, label: t('tabs.ownership'), current: pathname.startsWith(`${base}/ownership`) },
    ...(can('listing.view') ? [{ href: `${base}/listings`, label: t('tabs.listings'), count: counts?.listings ? counts.listings.live + counts.listings.draft : null, current: pathname.startsWith(`${base}/listings`) }] : []),
    { href: `${base}/media`, label: t('tabs.media'), count: counts ? counts.media.photos + counts.media.plans + counts.media.links : null, current: pathname.startsWith(`${base}/media`) },
    ...(can('property_note.view') ? [{ href: `${base}/notes`, label: t('tabs.notes'), count: counts?.notes?.total ?? null, current: pathname.startsWith(`${base}/notes`) }] : []),
    ...(can('key.view') ? [{ href: `${base}/keys`, label: t('tabs.keys'), count: counts?.keys?.active ?? null, current: pathname.startsWith(`${base}/keys`) }] : []),
    { href: `${base}/activity`, label: t('tabs.activity'), current: pathname.startsWith(`${base}/activity`) },
  ];

  const writable = !readOnly && record.archivedAt === null;
  const menu: MenuAction[] = [];
  if (record.address.latitude !== null) {
    menu.push({ id: 'map', label: t('openMap'), onAction: () => router.push(`/map/properties?filter[near]=${record.address.latitude},${record.address.longitude}&filter[radius]=1000`) });
  }
  menu.push({
    id: 'copy',
    label: common('copyReference'),
    onAction: () => {
      void navigator.clipboard?.writeText(record.reference).then(() => announce(common('copied', { value: record.reference })));
    },
  });
  if (can('property.archive') && !readOnly) {
    menu.push(
      record.archivedAt === null
        ? { id: 'archive', label: t('archive'), onAction: () => setDialog('archive'), danger: true }
        : { id: 'restore', label: t('restore'), onAction: () => setDialog('restore') },
    );
  }

  return (
    <Page>
      <PageHeader
        back={{ href: '/properties', label: t('backToList') }}
        title={<bdi>{propertyTitle(record)}</bdi>}
        subtitle={
          <>
            <span>{record.propertyType.name}</span>
            <span aria-hidden="true">·</span>
            <span>{record.office.name}</span>
            {record.isManaged ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{t('managedYes')}</span>
              </>
            ) : null}
            <LocationStatus property={{ latitude: record.address.latitude, locationStale: record.address.locationStale }} />
          </>
        }
        actions={
          <>
            {can('property.update') && writable ? (
              <LinkButton href={`${base}/edit`} variant="primary">
                {common('edit')}
              </LinkButton>
            ) : null}
            <ActionsMenu label={common('moreActions', { name: record.reference })} actions={menu} />
          </>
        }
      />
      {record.archivedAt !== null ? (
        <Notice tone="warning" title={t('archivedBanner', { date: format.date(record.archivedAt), reason: record.archivedReason ?? '' })} />
      ) : null}
      <RecordTabs label={t('tabs.label')} tabs={tabs} />
      {children}
      {dialog ? <ArchiveDialog property={record} mode={dialog} onClose={() => setDialog(null)} /> : null}
    </Page>
  );
}

/** P-5: archive (reason required) or restore, with If-Match. Blockers come back from the API and are shown as stated. */
function ArchiveDialog({ property, mode, onClose }: { property: PropertyDto; mode: 'archive' | 'restore'; onClose: () => void }) {
  const t = useTranslations('properties');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const name = property.name ?? property.reference;

  const submit = async () => {
    if (mode === 'archive' && reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`properties/${property.id}/${mode}`, { method: 'POST', version: property.version, body: mode === 'archive' ? { reason: reason.trim() } : {} });
      announce(mode === 'archive' ? t('archived', { name }) : t('restored', { name }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
      // A 412 means the record changed: reload it so a retry uses the new version.
      if (caught instanceof ApiError && caught.status === 412) await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={mode === 'archive' ? t('archiveTitle', { name }) : t('restoreTitle', { name })}
      consequence={mode === 'archive' ? t('archiveConsequence') : t('restoreConsequence')}
      confirmLabel={mode === 'archive' ? t('archiveConfirm', { name }) : t('restoreConfirm', { name })}
      onConfirm={() => void submit()}
      busy={busy}
      danger={mode === 'archive'}
    >
      {error ? (
        error instanceof ApiError && error.status === 412 ? (
          <Notice tone="warning" title={common('conflictTitle')}>
            {common('conflictDetail')}
          </Notice>
        ) : (
          <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} />
        )
      ) : null}
      {mode === 'archive' ? (
        <TextField
          id={reasonId}
          label={common('reason')}
          value={reason}
          onChange={(value) => {
            setReason(value);
            setMissing(false);
          }}
          isRequired
          maxLength={500}
          dir="auto"
          error={missing ? common('reasonRequired') : fieldErrorsOf(error)['reason']}
        />
      ) : null}
    </ConfirmDialog>
  );
}
