'use client';

import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { ErrorNotice, Notice, Skeleton, StatusLabel } from '@/components/ui/feedback';
import { FieldRow, TextField } from '@/components/ui/fields';
import { FormProblem, fieldErrorsOf } from '@/components/ui/form-problem';
import { Cluster, formClass } from '@/components/ui/layout';
import { ActionsMenu, type MenuAction } from '@/components/ui/menu';
import { When } from '@/components/ui/when';
import type { MediaDetailDto, MediaDto } from '@/lib/api-schema';
import { bffRequest } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';

import styles from './media.module.css';

export function mediaName(media: Pick<MediaDto, 'caption' | 'roomLabel' | 'originalFilename' | 'mediaType' | 'externalProvider'>, fallback: string): string {
  return media.caption ?? media.roomLabel ?? media.originalFilename ?? (media.externalProvider ? media.externalProvider : fallback);
}

export type MediaLifecycle = 'archive' | 'restore' | 'hold' | 'purge';

/** Archive, restore, legal hold and delete now (G-3, G-7), each confirmed. */
export function MediaLifecycleDialog({ media, action, onClose }: { media: MediaDto; action: MediaLifecycle; onClose: () => void }) {
  const t = useTranslations('media');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const name = mediaName(media, t(`type.${media.mediaType}`));
  const needsReason = action !== 'restore';

  const submit = async () => {
    if (needsReason && reason.trim() === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const path = action === 'hold' ? 'legal-hold' : action;
      const body = action === 'hold' ? { hold: !media.legalHold, reason: reason.trim() } : action === 'restore' ? {} : { reason: reason.trim() };
      await bffRequest(`media/${media.id}/${path}`, { method: 'POST', ...(action === 'archive' || action === 'restore' ? { version: media.version } : {}), body });
      announce(action === 'archive' ? t('archivedDone', { name }) : action === 'restore' ? t('restoredDone', { name }) : action === 'purge' ? t('purgedDone', { name }) : t('holdDone'));
      await refresh();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const copy = {
    archive: { title: t('archiveTitle', { name }), consequence: t('archiveConsequence'), confirm: t('archiveConfirm', { name }) },
    restore: { title: t('restoreTitle', { name }), consequence: t('restoreConsequence'), confirm: t('restoreConfirm', { name }) },
    hold: { title: t('legalHoldTitle', { name }), consequence: t('legalHoldConsequence'), confirm: media.legalHold ? t('legalHoldOff') : t('legalHoldOn') },
    purge: { title: t('purgeTitle', { name }), consequence: t('purgeConsequence'), confirm: t('purgeConfirm', { name }) },
  }[action];
  return (
    <ConfirmDialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={copy.title}
      consequence={copy.consequence}
      confirmLabel={copy.confirm}
      danger={action === 'archive' || action === 'purge'}
      busy={busy}
      onConfirm={() => void submit()}
      {...(action === 'purge' ? { confirmWord: 'DELETE' } : {})}
    >
      {error ? <FormProblem error={error} fields={{ reason: { label: common('reason'), id: reasonId } }} /> : null}
      {needsReason ? (
        <TextField
          id={reasonId}
          label={action === 'hold' ? t('holdReason') : common('reason')}
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

/** G-3 media details drawer: preview, caption, alt text, room and floor, usage, lifecycle. */
export function MediaDetailsDrawer({ mediaId, onClose, canEdit, canArchive, canManage }: { mediaId: string; onClose: () => void; canEdit: boolean; canArchive: boolean; canManage: boolean }) {
  const t = useTranslations('media');
  const common = useTranslations('common');
  const format = useFormat();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const detail = useQuery({
    queryKey: ['record', 'media', mediaId],
    queryFn: async () => {
      const response = await bffRequest<MediaDetailDto>(`media/${mediaId}`);
      return { ...response.data, version: response.version ?? response.data.version };
    },
    // Signed URLs last 15 minutes; refresh before they expire.
    refetchInterval: 10 * 60_000,
  });
  const media = detail.data;
  const [form, setForm] = useState({ caption: '', altText: '', roomLabel: '', floorLabel: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [lifecycle, setLifecycle] = useState<MediaLifecycle | null>(null);
  useEffect(() => {
    if (media) setForm({ caption: media.caption ?? '', altText: media.altText ?? '', roomLabel: media.roomLabel ?? '', floorLabel: media.floorLabel ?? '' });
  }, [media]);

  const save = async () => {
    if (!media) return;
    setBusy(true);
    setError(null);
    try {
      await bffRequest(`media/${media.id}`, {
        method: 'PATCH',
        version: media.version,
        body: { caption: form.caption.trim() || null, altText: form.altText.trim() || null, roomLabel: form.roomLabel.trim() || null, floorLabel: form.floorLabel.trim() || null },
      });
      announce(t('saved'));
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const name = media ? mediaName(media, t(`type.${media.mediaType}`)) : '';
  const editable = canEdit && media !== undefined && media.archivedAt === null;
  const menu: MenuAction[] = [];
  if (media && canManage) {
    menu.push({ id: 'hold', label: media.legalHold ? t('legalHoldOff') : t('legalHoldOn'), onAction: () => setLifecycle('hold') });
    if (media.archivedAt !== null && !media.legalHold) menu.push({ id: 'purge', label: t('purge'), onAction: () => setLifecycle('purge'), danger: true });
  }
  const errors = fieldErrorsOf(error);
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} title={media ? t('drawerTitle', { type: t(`type.${media.mediaType}`), name }) : t('details')} drawer>
      {detail.isPending ? (
        <Skeleton />
      ) : detail.isError ? (
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      ) : media ? (
        <div className={formClass}>
          {media.processingStatus === 'ready' && (media.urls.large ?? media.urls.medium) ? (
            <img src={media.urls.large ?? media.urls.medium} alt={media.altText ?? ''} className={styles.preview} />
          ) : media.processingStatus === 'rejected' || media.processingStatus === 'failed' ? (
            <Notice tone="danger" title={t('rejectedReason', { reason: media.rejectionReason ?? '' })} />
          ) : media.processingStatus === 'pending' ? (
            <Notice tone="info">{t('processingNote')}</Notice>
          ) : null}
          {media.urls.download ? (
            <a href={media.urls.download} download rel="noopener noreferrer">
              {t('download')}
            </a>
          ) : null}
          {media.urls.external ? (
            <a href={media.urls.external} target="_blank" rel="noopener noreferrer">
              {t('open')} ({media.externalProvider ? t(`provider.${media.externalProvider}`) : ''})
            </a>
          ) : null}
          {error instanceof ApiError && error.status === 412 ? (
            <Notice tone="warning" title={common('conflictTitle')}>
              {common('conflictDetail')}
            </Notice>
          ) : (
            <FormProblem error={error} fields={{}} />
          )}
          <TextField label={t('caption')} value={form.caption} onChange={(value) => setForm({ ...form, caption: value })} maxLength={500} dir="auto" isDisabled={!editable} error={errors['caption']} />
          <TextField
            label={t('altText')}
            value={form.altText}
            onChange={(value) => setForm({ ...form, altText: value })}
            maxLength={500}
            dir="auto"
            description={t('altHint')}
            isDisabled={!editable}
            error={errors['altText']}
          />
          <FieldRow>
            <TextField label={t('room')} value={form.roomLabel} onChange={(value) => setForm({ ...form, roomLabel: value })} maxLength={60} dir="auto" isDisabled={!editable} error={errors['roomLabel']} />
            <TextField label={t('floor')} value={form.floorLabel} onChange={(value) => setForm({ ...form, floorLabel: value })} maxLength={30} dir="auto" isDisabled={!editable} error={errors['floorLabel']} />
          </FieldRow>
          <section aria-label={t('usedIn')}>
            <h3 className={styles.subheading}>{t('usedIn')}</h3>
            {media.usedIn.length === 0 ? (
              <p className={styles.quiet}>{t('notUsed')}</p>
            ) : (
              <ul className={styles.inline}>
                {media.usedIn.map((usage) => (
                  <li key={usage.listingId}>
                    <NextLink href={`/listings/${usage.listingId}/gallery`}>
                      <bdi className="ep-num">{usage.reference}</bdi>
                    </NextLink>
                    {usage.isCover ? ` (${t('cover')})` : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className={styles.quiet}>
            {media.pageCount !== null
              ? t('infoPdf', { pages: media.pageCount, size: format.bytes(media.storedBytes ?? 0), when: format.date(media.createdAt) })
              : media.width !== null && media.height !== null
                ? t('info', { width: media.width, height: media.height, size: format.bytes(media.storedBytes ?? 0), when: format.date(media.createdAt) })
                : null}{' '}
            {media.uploadedByName ? t('uploadedBy', { name: media.uploadedByName }) : null}
            {media.originalFilename ? (
              <>
                {' · '}
                <bdi>{media.originalFilename}</bdi>
              </>
            ) : null}
          </p>
          {media.legalHold ? (
            <StatusLabel tone="warning" icon="⚖">
              {t('onHold')}
            </StatusLabel>
          ) : null}
          {media.archivedAt && media.purgeAfter && !media.legalHold ? (
            <p>
              {t('deletedOn')}: <When iso={media.purgeAfter} dateOnly />
            </p>
          ) : null}
          <Cluster>
            {editable ? (
              <Button variant="primary" onPress={() => void save()} busy={busy}>
                {common('save')}
              </Button>
            ) : null}
            {canArchive ? (
              media.archivedAt === null ? (
                <Button variant="danger" onPress={() => setLifecycle('archive')}>
                  {t('archive')}
                </Button>
              ) : (
                <Button onPress={() => setLifecycle('restore')}>{t('restore')}</Button>
              )
            ) : null}
            <ActionsMenu label={t('actionsFor', { name })} actions={menu} />
          </Cluster>
          {lifecycle ? <MediaLifecycleDialog media={media} action={lifecycle} onClose={() => (lifecycle === 'purge' ? onClose() : setLifecycle(null))} /> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
