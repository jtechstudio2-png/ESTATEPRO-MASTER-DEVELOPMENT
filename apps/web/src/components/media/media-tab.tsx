'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useProperty } from '@/components/properties/use-property';
import { useSession } from '@/components/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton, StatusLabel, type Tone } from '@/components/ui/feedback';
import { Checkbox, RadioGroupField, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Cluster, Panel } from '@/components/ui/layout';
import { LoadMore } from '@/components/ui/list-controls';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { When } from '@/components/ui/when';
import tableStyles from '@/components/ui/table.module.css';
import type { MediaDto, StorageUsageDto } from '@/lib/api-schema';
import { bff, bffRequest, newIdempotencyKey } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useRefreshAll } from '@/lib/mutations';

import { MediaDetailsDrawer, MediaLifecycleDialog, type MediaLifecycle, mediaName } from './media-details';
import styles from './media.module.css';
import { UploadPanel } from './upload-panel';

type View = 'photos' | 'plans' | 'links' | 'archived';
const TYPES: Record<Exclude<View, 'archived'>, string> = { photos: 'photo', plans: 'floor_plan,site_plan,brochure', links: 'video,virtual_tour' };
const STATUS_TONE: Record<MediaDto['processingStatus'], Tone> = { pending: 'info', ready: 'success', failed: 'danger', rejected: 'danger' };
const URL_LIFETIME_REFRESH = 10 * 60_000;

export function MediaStatus({ media }: { media: Pick<MediaDto, 'processingStatus' | 'rejectionReason'> }) {
  const t = useTranslations('media');
  return (
    <StatusLabel tone={STATUS_TONE[media.processingStatus]} icon={media.processingStatus === 'pending' ? '⏳' : media.processingStatus === 'ready' ? undefined : '✗'}>
      {t(`status.${media.processingStatus}`)}
    </StatusLabel>
  );
}

export function StorageLine() {
  const t = useTranslations('media');
  const format = useFormat();
  const storage = useQuery({ queryKey: ['settings', 'storage'], queryFn: () => bff<StorageUsageDto>('settings/storage') });
  if (!storage.data) return null;
  const { usedBytes, limitBytes } = storage.data;
  return (
    <NextLink href="/settings/storage" className={styles.storage}>
      {limitBytes !== null ? t('storageLine', { used: format.bytes(usedBytes), limit: format.bytes(limitBytes) }) : t('storageUnlimited', { used: format.bytes(usedBytes) })}
      {limitBytes !== null ? <meter min={0} max={limitBytes} value={usedBytes} aria-hidden="true" /> : null}
    </NextLink>
  );
}

/**
 * G-1 property media tab, with G-4 plans, G-5 links and G-7 archived as
 * views. Images load only through the signed URLs the API returns; the list
 * refreshes before they expire and while items are processing.
 */
export function MediaTab({ propertyId }: { propertyId: string }) {
  const t = useTranslations('media');
  const common = useTranslations('common');
  const params = useListParams();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const { can, grant, readOnly } = useSession();
  const property = useProperty(propertyId);
  const view = (params.get('type') as View | null) ?? 'photos';
  const live = !readOnly && property.data?.archivedAt === null;
  const canEdit = can('property.update') && live;
  const canArchive = can('property.archive') && !readOnly;
  const canManage = grant('property.archive')?.scope === 'all' && !readOnly;

  const query = new URLSearchParams({ sort: 'sortOrder' });
  if (view === 'archived') query.set('filter[archived]', 'true');
  else query.set('filter[mediaType]', TYPES[view]);
  const result = usePagedList<MediaDto>(`properties/${propertyId}/media`, query, {
    limit: 100,
    refetchInterval: (rows) => (rows.some((row) => row.processingStatus === 'pending') ? 3000 : URL_LIFETIME_REFRESH),
  });
  const rows = result.rows;

  const [upload, setUpload] = useState<'photos' | 'plans' | null>(null);
  const [addingLink, setAddingLink] = useState(false);
  const opened = params.get('media');
  const [lifecycle, setLifecycle] = useState<{ media: MediaDto; action: MediaLifecycle } | null>(null);
  const [moving, setMoving] = useState<MediaDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ done: number; failed: Array<{ name: string; reason: string }> } | null>(null);

  /** New order → PATCH the items whose sortOrder changes (each with its own If-Match). */
  const reorder = async (item: MediaDto, to: number) => {
    const order = rows.filter((row) => row.id !== item.id);
    order.splice(to, 0, item);
    for (const [index, row] of order.entries()) {
      const sortOrder = (index + 1) * 10;
      if (row.sortOrder !== sortOrder) await bffRequest(`media/${row.id}`, { method: 'PATCH', version: row.version, body: { sortOrder } });
    }
    announce(t('moved', { name: mediaName(item, t(`type.${item.mediaType}`)), position: to + 1 }));
    await refresh();
  };

  const bulkArchive = async () => {
    setBulkBusy(true);
    const failed: Array<{ name: string; reason: string }> = [];
    let done = 0;
    for (const row of rows.filter((item) => selected.has(item.id))) {
      try {
        await bffRequest(`media/${row.id}/archive`, { method: 'POST', version: row.version, body: { reason: t('bulkArchive', { count: selected.size }) } });
        done += 1;
      } catch (error) {
        failed.push({ name: mediaName(row, t(`type.${row.mediaType}`)), reason: error instanceof Error ? error.message : '' });
      }
    }
    setBulkResult({ done, failed });
    // Failed rows stay selected (UI checklist §5).
    setSelected(new Set(rows.filter((row) => failed.some((item) => item.name === mediaName(row, t(`type.${row.mediaType}`)))).map((row) => row.id)));
    announce(t('bulkResult', { done, failed: failed.length }));
    setBulkBusy(false);
    setBulkOpen(false);
    await refresh();
  };

  const menu = (media: MediaDto, index: number): MenuAction[] => {
    const actions: MenuAction[] = [{ id: 'details', label: t('details'), onAction: () => params.set({ media: media.id }) }];
    if (canEdit && media.archivedAt === null && view !== 'archived') {
      if (index > 0) actions.push({ id: 'earlier', label: t('moveEarlier'), onAction: () => void reorder(media, index - 1) });
      if (index < rows.length - 1) actions.push({ id: 'later', label: t('moveLater'), onAction: () => void reorder(media, index + 1) });
      if (rows.length > 2) actions.push({ id: 'moveTo', label: t('moveTo'), onAction: () => setMoving(media) });
    }
    if (canArchive) {
      actions.push(
        media.archivedAt === null
          ? { id: 'archive', label: t('archive'), onAction: () => setLifecycle({ media, action: 'archive' }), danger: true }
          : { id: 'restore', label: t('restore'), onAction: () => setLifecycle({ media, action: 'restore' }) },
      );
    }
    if (canManage && media.archivedAt !== null && !media.legalHold) actions.push({ id: 'purge', label: t('purge'), onAction: () => setLifecycle({ media, action: 'purge' }), danger: true });
    return actions;
  };

  const views: Array<{ id: View; label: string }> = [
    { id: 'photos', label: t('photos') },
    { id: 'plans', label: t('plans') },
    { id: 'links', label: t('links') },
    { id: 'archived', label: t('archived') },
  ];

  const body = result.isPending ? (
    <div aria-busy="true" className={styles.grid}>
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} />
      ))}
    </div>
  ) : result.isError ? (
    <ErrorNotice error={result.error} onRetry={() => void result.refetch()} />
  ) : rows.length === 0 ? (
    <EmptyState headingLevel={3} title={view === 'photos' ? t('empty') : view === 'plans' ? t('emptyPlans') : view === 'links' ? t('emptyLinks') : t('emptyArchived')}>
      {view === 'photos' ? t('emptyDetail') : null}
    </EmptyState>
  ) : view === 'photos' ? (
    <>
      {canArchive ? (
        <Cluster>
          <Checkbox
            isSelected={selected.size === rows.length && rows.length > 0}
            onChange={(all) => setSelected(all ? new Set(rows.map((row) => row.id)) : new Set())}
          >
            {t('selectAll', { count: rows.length })}
          </Checkbox>
          {selected.size > 0 ? (
            <>
              <span aria-live="polite">{common('selected', { count: selected.size })}</span>
              <Button variant="danger" onPress={() => setBulkOpen(true)}>
                {t('bulkArchive', { count: selected.size })}
              </Button>
            </>
          ) : null}
        </Cluster>
      ) : null}
      {bulkResult ? (
        <Notice tone={bulkResult.failed.length > 0 ? 'warning' : 'success'} title={t('bulkResult', { done: bulkResult.done, failed: bulkResult.failed.length })}>
          {bulkResult.failed.length > 0 ? (
            <ul>
              {bulkResult.failed.map((item) => (
                <li key={item.name}>
                  <bdi>{item.name}</bdi>: {item.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      <ul className={styles.grid} aria-label={t('grid')}>
        {rows.map((media, index) => {
          const name = mediaName(media, t(`type.${media.mediaType}`));
          return (
            <li key={media.id} className={styles.tile}>
              <button type="button" className={styles.thumbButton} onClick={() => params.set({ media: media.id })} aria-label={`${t('details')}: ${name}`}>
                {media.processingStatus === 'ready' && media.urls.thumb ? (
                  <img src={media.urls.thumb} alt={media.altText ?? ''} className={styles.thumb} loading="lazy" />
                ) : (
                  <span className={styles.thumbPlaceholder} aria-hidden="true">
                    {media.processingStatus === 'pending' ? '⏳' : '✗'}
                  </span>
                )}
              </button>
              <div className={styles.tileMeta}>
                {canArchive ? (
                  <input
                    type="checkbox"
                    aria-label={t('select', { name })}
                    checked={selected.has(media.id)}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(media.id);
                      else next.delete(media.id);
                      setSelected(next);
                    }}
                  />
                ) : null}
                <span className={styles.caption}>
                  <bdi>{media.caption ?? media.roomLabel ?? t('noCaption')}</bdi>
                </span>
                <ActionsMenu label={t('actionsFor', { name })} actions={menu(media, index)} />
              </div>
              {media.processingStatus === 'ready' ? null : <MediaStatus media={media} />}
              {media.rejectionReason ? <span className={styles.reason}>{media.rejectionReason}</span> : null}
            </li>
          );
        })}
      </ul>
    </>
  ) : view === 'links' ? (
    <ul className={styles.links} aria-label={t('links')}>
      {rows.map((media, index) => (
        <li key={media.id}>
          <span>
            <strong>{t(`type.${media.mediaType}`)}</strong> · {media.externalProvider ? t(`provider.${media.externalProvider}`) : ''}
            {media.caption ? (
              <>
                {' · '}
                <bdi>{media.caption}</bdi>
              </>
            ) : null}
          </span>
          {media.urls.external ? (
            <a href={media.urls.external} target="_blank" rel="noopener noreferrer">
              {t('open')}
            </a>
          ) : null}
          <ActionsMenu label={t('actionsFor', { name: mediaName(media, t(`type.${media.mediaType}`)) })} actions={menu(media, index)} />
        </li>
      ))}
    </ul>
  ) : (
    <div className={tableStyles.region} role="region" aria-label={view === 'plans' ? t('planList') : t('archived')} tabIndex={0}>
      <table className={tableStyles.table}>
        <caption className="ep-visually-hidden">{view === 'plans' ? t('planList') : t('archived')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('item')}</th>
            <th scope="col">{common('status')}</th>
            {view === 'plans' ? (
              <>
                <th scope="col">{t('floorCol')}</th>
                <th scope="col">{t('pages')}</th>
              </>
            ) : (
              <>
                <th scope="col">{t('archivedCol')}</th>
                <th scope="col">{t('deletedOn')}</th>
              </>
            )}
            <th scope="col">
              <span className="ep-visually-hidden">{common('actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((media, index) => {
            const name = mediaName(media, t(`type.${media.mediaType}`));
            return (
              <tr key={media.id}>
                <th scope="row">
                  <button type="button" className={styles.linkButton} onClick={() => params.set({ media: media.id })}>
                    <bdi>{name}</bdi>
                  </button>
                  <span className={tableStyles.secondary}>{t(`type.${media.mediaType}`)}</span>
                </th>
                <td>
                  <MediaStatus media={media} />
                  {media.legalHold ? (
                    <StatusLabel tone="warning" icon="⚖">
                      {t('onHold')}
                    </StatusLabel>
                  ) : null}
                </td>
                {view === 'plans' ? (
                  <>
                    <td>{media.floorLabel ? <bdi>{media.floorLabel}</bdi> : '—'}</td>
                    <td className="ep-num">{media.pageCount ?? '—'}</td>
                  </>
                ) : (
                  <>
                    <td>{media.archivedAt ? <When iso={media.archivedAt} /> : '—'}</td>
                    <td>{media.legalHold ? t('onHold') : media.purgeAfter ? <When iso={media.purgeAfter} dateOnly /> : '—'}</td>
                  </>
                )}
                <td>
                  <Cluster>
                    {view === 'plans' && media.urls.download ? (
                      <a href={media.urls.download} download rel="noopener noreferrer">
                        {t('download')}
                      </a>
                    ) : null}
                    <ActionsMenu label={t('actionsFor', { name })} actions={menu(media, index)} />
                  </Cluster>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <Panel
      title={t('title')}
      actions={
        <Cluster>
          <StorageLine />
          {canEdit && view === 'photos' ? (
            <Button variant="primary" onPress={() => setUpload('photos')}>
              {t('upload')}
            </Button>
          ) : null}
          {canEdit && view === 'plans' ? (
            <Button variant="primary" onPress={() => setUpload('plans')}>
              {t('uploadPlans')}
            </Button>
          ) : null}
          {canEdit && view === 'links' ? (
            <Button variant="primary" onPress={() => setAddingLink(true)}>
              {t('addLink')}
            </Button>
          ) : null}
        </Cluster>
      }
    >
      <nav aria-label={t('views')} className={styles.views}>
        {views.map((item) => (
          <NextLink
            key={item.id}
            href={`/properties/${propertyId}/media${item.id === 'photos' ? '' : `?type=${item.id}`}`}
            aria-current={view === item.id ? 'page' : undefined}
            className={styles.view}
            scroll={false}
          >
            {item.label}
          </NextLink>
        ))}
      </nav>
      {view === 'archived' ? <p className={styles.quiet}>{t('archivedIntro')}</p> : null}
      <RefreshBar active={result.isFetching && !result.isPending} />
      {body}
      <LoadMore hasMore={result.hasNextPage} loading={result.isFetchingNextPage} onLoad={result.loadMore} shown={rows.length} />
      {upload ? <UploadPanel propertyId={propertyId} mode={upload} isOpen onOpenChange={(open) => (open ? undefined : setUpload(null))} /> : null}
      {addingLink ? <AddLinkDialog propertyId={propertyId} onClose={() => setAddingLink(false)} /> : null}
      {opened ? <MediaDetailsDrawer mediaId={opened} onClose={() => params.set({ media: null })} canEdit={canEdit} canArchive={canArchive} canManage={canManage} /> : null}
      {lifecycle ? <MediaLifecycleDialog media={lifecycle.media} action={lifecycle.action} onClose={() => setLifecycle(null)} /> : null}
      {moving ? <MoveDialog media={moving} total={rows.length} current={rows.findIndex((row) => row.id === moving.id) + 1} onMove={(position) => void reorder(moving, position - 1).then(() => setMoving(null))} onClose={() => setMoving(null)} /> : null}
      <ConfirmDialog
        isOpen={bulkOpen}
        onOpenChange={setBulkOpen}
        title={t('bulkArchiveTitle', { count: selected.size })}
        consequence={t('bulkArchiveConsequence')}
        confirmLabel={t('bulkArchive', { count: selected.size })}
        danger
        busy={bulkBusy}
        onConfirm={() => void bulkArchive()}
      />
    </Panel>
  );
}

/** "Move to position" (W-D3): the single-pointer and keyboard alternative to dragging. */
export function MoveDialog({ media, total, current, onMove, onClose }: { media: Pick<MediaDto, 'caption' | 'roomLabel' | 'originalFilename' | 'mediaType' | 'externalProvider'>; total: number; current: number; onMove: (position: number) => void; onClose: () => void }) {
  const t = useTranslations('media');
  const common = useTranslations('common');
  const [position, setPosition] = useState(String(current));
  const valid = Number.isInteger(Number(position)) && Number(position) >= 1 && Number(position) <= total;
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('moveToTitle', { name: mediaName(media, t(`type.${media.mediaType}`)) })}
      footer={
        <>
          <Button onPress={onClose}>{common('cancel')}</Button>
          <Button variant="primary" isDisabled={!valid} onPress={() => onMove(Number(position))}>
            {t('move')}
          </Button>
        </>
      }
    >
      <TextField label={t('position', { max: total })} value={position} onChange={setPosition} inputMode="numeric" autoFocus error={valid ? undefined : t('position', { max: total })} />
    </Dialog>
  );
}

/** G-5: external video or 3D tour; no third-party player is embedded in the workspace. */
function AddLinkDialog({ propertyId, onClose }: { propertyId: string; onClose: () => void }) {
  const t = useTranslations('media');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [url, setUrl] = useState('');
  const [mediaType, setMediaType] = useState<'video' | 'virtual_tour'>('video');
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const provider = /youtube\.com|youtu\.be/.test(url) ? 'youtube' : /vimeo\.com/.test(url) ? 'vimeo' : /matterport\.com/.test(url) ? 'matterport' : null;
  const fits = provider !== null && (mediaType === 'virtual_tour' ? provider === 'matterport' : provider !== 'matterport');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`properties/${propertyId}/media/links`, { method: 'POST', idempotencyKey, body: { mediaType, url: url.trim(), caption: caption.trim() || null } });
      announce(t('linkAdded', { type: t(`type.${mediaType}`) }));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('linkTitle')}
      isDismissable={!busy}
      footer={
        <>
          <Button onPress={onClose}>{common('cancel')}</Button>
          <Button variant="primary" onPress={() => void submit()} busy={busy} isDisabled={!fits}>
            {t('add')}
          </Button>
        </>
      }
    >
      <FormProblem error={error} fields={{ url: { label: t('link'), id: 'add-link-url' } }} />
      <TextField id="add-link-url" label={t('link')} value={url} onChange={setUrl} type="url" isRequired dir="ltr" description={t('linkHint')} error={fieldErrorsOf(error)['url']} />
      <RadioGroupField
        label={t('linkType')}
        value={mediaType}
        onChange={(value) => setMediaType(value as 'video' | 'virtual_tour')}
        options={[
          { id: 'video', label: t('type.video') },
          { id: 'virtual_tour', label: t('type.virtual_tour') },
        ]}
      />
      <TextField label={t('caption')} value={caption} onChange={setCaption} maxLength={500} dir="auto" />
      {url.trim() ? (
        <p role="status" className={fits ? styles.ok : styles.reason}>
          {fits && provider ? `✓ ${t('recognised', { provider: t(`provider.${provider}`) })}` : t('notRecognised')}
        </p>
      ) : null}
    </Dialog>
  );
}
