'use client';

import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useSession } from '@/components/session';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Page, PageHeader, RecordTabs } from '@/components/ui/layout';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { useDocumentTitle } from '@/lib/hooks/document-title';
import { useFormat } from '@/lib/hooks/format';
import { ApiError } from '@/lib/problem';

import { type ListingAction, ListingDialogs } from './listing-dialogs';
import { LIVE, ListingState, TERMINAL } from './listing-labels';
import { useListing, useListingGrant } from './use-listing';

/**
 * L-3 listing record: header with the primary action (publish when it is a
 * draft or unpublished, else edit), the overflow menu of allowed actions,
 * and tabs. Closed listings offer Relist only (D3).
 */
export function ListingFrame({ id, children }: { id: string; children: ReactNode }) {
  const t = useTranslations('listings');
  const common = useTranslations('common');
  const errors = useTranslations('errors');
  const pathname = usePathname();
  const announce = useAnnounce();
  const format = useFormat();
  const { can, grant, readOnly } = useSession();
  const covers = useListingGrant();
  const listing = useListing(id);
  const [action, setAction] = useState<ListingAction | null>(null);
  useDocumentTitle(listing.data ? `${listing.data.reference} · ${listing.data.title}` : null);

  if (listing.isPending) {
    return (
      <Page>
        <div aria-busy="true">
          <Skeleton width="40%" />
          <Skeleton />
        </div>
      </Page>
    );
  }
  if (listing.isError) {
    return (
      <Page>
        {listing.error instanceof ApiError && listing.error.status === 404 ? (
          <EmptyState title={errors('notFoundTitle')} action={<LinkButton href="/listings">{t('title')}</LinkButton>}>
            {errors('notFoundDetail')}
          </EmptyState>
        ) : (
          <ErrorNotice error={listing.error} onRetry={() => void listing.refetch()} />
        )}
      </Page>
    );
  }

  const record = listing.data;
  const archived = record.archivedAt !== null;
  const closed = TERMINAL.includes(record.status);
  const canUpdate = !archived && !closed && covers('listing.update', record);
  const canPublish = !archived && !closed && covers('listing.publish', record);
  // Reassigning needs listing.update with office or all scope that covers the listing (ADR-004 D4).
  const updateScope = grant('listing.update')?.scope;
  const canReassign = !archived && !closed && (updateScope === 'office' || updateScope === 'all') && covers('listing.update', record);
  const canRelist = closed && !archived && can('listing.create') && !readOnly;
  const canArchive = covers('listing.archive', record) && !LIVE.includes(record.status);

  const menu: MenuAction[] = [];
  if (canPublish && record.isPublished) menu.push({ id: 'unpublish', label: t('actions.unpublish'), onAction: () => setAction('unpublish') });
  if (canPublish) menu.push({ id: 'status', label: t('actions.changeStatus'), onAction: () => setAction('status') });
  if (canReassign) menu.push({ id: 'reassign', label: t('actions.reassign'), onAction: () => setAction('reassign') });
  if (canRelist) menu.push({ id: 'relist', label: t('actions.relist'), onAction: () => setAction('relist') });
  menu.push({ id: 'copy', label: t('actions.copyReference'), onAction: () => void navigator.clipboard?.writeText(record.reference).then(() => announce(common('copied', { value: record.reference }))) });
  if (canArchive) menu.push(archived ? { id: 'restore', label: t('actions.restore'), onAction: () => setAction('restore') } : { id: 'archive', label: t('actions.archive'), onAction: () => setAction('archive'), danger: true });

  const primary =
    canPublish && !record.isPublished ? (
      <Button variant="primary" onPress={() => setAction('publish')}>
        {t('actions.publish')}
      </Button>
    ) : canRelist ? (
      <Button variant="primary" onPress={() => setAction('relist')}>
        {t('actions.relist')}
      </Button>
    ) : null;

  const base = `/listings/${id}`;
  const tabs = [
    { href: base, label: t('tabs.overview'), current: pathname === base },
    { href: `${base}/gallery`, label: t('tabs.gallery'), count: record.media.photoCount + record.media.floorPlanCount, current: pathname.startsWith(`${base}/gallery`) },
    { href: `${base}/translations`, label: t('tabs.translations'), count: record.translations.length, current: pathname.startsWith(`${base}/translations`) },
    { href: `${base}/price-status`, label: t('tabs.priceStatus'), current: pathname.startsWith(`${base}/price-status`) },
    { href: `${base}/history`, label: t('tabs.history'), current: pathname.startsWith(`${base}/history`) },
  ];

  return (
    <Page>
      <PageHeader
        back={{ href: '/listings', label: t('title') }}
        title={
          <>
            <bdi className="ep-num">{record.reference}</bdi> · <bdi>{record.title}</bdi>
          </>
        }
        subtitle={
          <>
            <span>{t(`type.${record.listingType}`)}</span>
            <ListingState listing={record} />
            {record.isPublished ? null : <span>{t('notPublished')}</span>}
            <NextLink href={`/properties/${record.property.id}`}>
              <bdi>{t('unitLine', { unit: record.unit.unitLabel, property: record.property.name ?? record.property.reference })}</bdi>
            </NextLink>
            <span>
              {t('agent')}: <bdi>{record.agent.displayName}</bdi>
            </span>
          </>
        }
        actions={
          <>
            {primary}
            {canUpdate ? <LinkButton href={`${base}/edit`}>{t('actions.edit')}</LinkButton> : null}
            <ActionsMenu label={common('moreActions', { name: record.reference })} actions={menu} />
          </>
        }
      />
      {archived ? <Notice tone="warning" title={t('archivedBanner', { date: format.date(record.archivedAt!) })} /> : null}
      {!canUpdate && !archived && !closed ? <p className="ep-visually-hidden">{t('noPermission')}</p> : null}
      <RecordTabs label={t('tabs.label')} tabs={tabs} />
      {children}
      <ListingDialogs listing={record} action={action} onClose={() => setAction(null)} />
    </Page>
  );
}
