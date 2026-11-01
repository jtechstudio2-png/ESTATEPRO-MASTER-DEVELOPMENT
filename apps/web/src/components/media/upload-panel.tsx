'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { type DragEvent, useEffect, useId, useRef, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/feedback';
import { Checkbox, FieldRow, SelectField, TextField } from '@/components/ui/fields';
import type { ListingPageDto, MediaDto, UnitPageDto } from '@/lib/api-schema';
import { bff, bffRequest } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';
import { allowedTypes, precheck, type UploadMediaType, uploadFile } from '@/lib/upload';

import styles from './media.module.css';

type Stage = 'waiting' | 'hashing' | 'uploading' | 'confirming' | 'done' | 'ready' | 'rejected' | 'failed' | 'cancelled';

interface QueueItem {
  key: string;
  file: File;
  stage: Stage;
  percent: number;
  reason: string | null;
  mediaId: string | null;
  controller: AbortController | null;
  /** Room label for the batch the file was added with (X-2), set once it is ready. */
  roomLabel: string | null;
}

const NONE = '__none__';
const ACTIVE: Stage[] = ['hashing', 'uploading', 'confirming'];

interface NetworkInformation extends EventTarget {
  type?: string;
}

/** Whether the device says it is on mobile data (Network Information API, where the browser has it). */
function useOnMobileData(): boolean {
  const [cellular, setCellular] = useState(false);
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
    if (!connection) return;
    const read = () => setCellular(connection.type === 'cellular');
    read();
    connection.addEventListener('change', read);
    return () => connection.removeEventListener('change', read);
  }, []);
  return cellular;
}

/**
 * G-2 upload panel: checks type and size first, hashes in the browser, puts
 * the bytes straight to storage on a signed URL, confirms, then follows
 * processing until each file is ready or rejected. Progress is announced at
 * 25% steps and at completion (UI checklist §6).
 */
export function UploadPanel({
  propertyId,
  mode,
  isOpen,
  onOpenChange,
  listingId,
}: {
  propertyId: string;
  mode: 'photos' | 'plans';
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  listingId?: string;
}) {
  const t = useTranslations('media');
  const format = useFormat();
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [mediaType, setMediaType] = useState<UploadMediaType>(mode === 'photos' ? 'photo' : 'floor_plan');
  const [unitId, setUnitId] = useState(NONE);
  const [attachTo, setAttachTo] = useState(listingId ?? NONE);
  const [quotaFull, setQuotaFull] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [room, setRoom] = useState('');
  const [waitForWifi, setWaitForWifi] = useState(false);
  const onMobileData = useOnMobileData();
  const announced = useRef(new Map<string, number>());
  const running = useRef(false);

  useEffect(() => setMediaType(mode === 'photos' ? 'photo' : 'floor_plan'), [mode]);
  const units = useQuery({ queryKey: ['record', 'units-for-select', propertyId], queryFn: () => bff<UnitPageDto>(`properties/${propertyId}/units?limit=100`), enabled: isOpen });
  const listings = useQuery({
    queryKey: ['record', 'property-open-listings', propertyId],
    queryFn: () => bff<ListingPageDto>(`listings?filter[propertyId]=${propertyId}&filter[status]=draft,available,reserved,under_contract&limit=50`),
    enabled: isOpen,
  });

  // Follow processing of uploaded files until ready or rejected.
  const pending = queue.filter((item) => item.stage === 'done' && item.mediaId !== null);
  useQuery({
    queryKey: ['upload-processing', pending.map((item) => item.mediaId).join(',')],
    queryFn: async () => {
      const results = await Promise.all(pending.map((item) => bff<MediaDto>(`media/${item.mediaId}`)));
      // The batch's room label is set once processing has finished (X-2).
      await Promise.all(
        results
          .filter((media) => media.processingStatus === 'ready')
          .map((media) => {
            const roomLabel = pending.find((item) => item.mediaId === media.id)?.roomLabel;
            return roomLabel && media.roomLabel !== roomLabel ? bffRequest(`media/${media.id}`, { method: 'PATCH', version: media.version, body: { roomLabel } }) : Promise.resolve(null);
          }),
      );
      setQueue((current) =>
        current.map((item) => {
          const media = results.find((result) => result.id === item.mediaId);
          if (!media || media.processingStatus === 'pending') return item;
          announce(`${item.file.name}: ${t(`status.${media.processingStatus}`)}`);
          return { ...item, stage: media.processingStatus === 'ready' ? 'ready' : 'rejected', reason: media.rejectionReason };
        }),
      );
      if (results.some((media) => media.processingStatus !== 'pending')) await refresh();
      return results.length;
    },
    enabled: pending.length > 0,
    refetchInterval: 2000,
  });

  const update = (key: string, patch: Partial<QueueItem>) => setQueue((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const start = async (item: QueueItem) => {
    const controller = new AbortController();
    update(item.key, { stage: 'hashing', controller, reason: null, percent: 0 });
    try {
      const media = await uploadFile(
        item.file,
        { propertyId, mediaType, ...(unitId === NONE ? {} : { unitId }), ...(attachTo === NONE ? {} : { listingId: attachTo }) },
        {
          signal: controller.signal,
          onStage: (stage) => update(item.key, { stage }),
          onProgress: (fraction) => {
            const percent = Math.round(fraction * 100);
            update(item.key, { percent });
            const step = Math.floor(percent / 25) * 25;
            if (step > (announced.current.get(item.key) ?? 0) && step < 100) {
              announced.current.set(item.key, step);
              announce(t('announceProgress', { name: item.file.name, percent: step }));
            }
          },
        },
      );
      update(item.key, { stage: 'done', percent: 100, mediaId: media.id, controller: null });
      announce(t('announceDone', { name: item.file.name }));
      await refresh();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        update(item.key, { stage: 'cancelled', controller: null });
        return;
      }
      if (error instanceof ApiError && error.code === 'quota-exceeded') setQuotaFull(true);
      const reason = error instanceof ApiError ? (error.problem.errors?.[0]?.message ?? error.problem.detail ?? error.problem.title) : error instanceof Error ? error.message : '';
      update(item.key, { stage: 'failed', reason, controller: null });
    }
  };

  const add = (files: FileList | File[]) => {
    const items: QueueItem[] = Array.from(files).map((file, index) => {
      const problem = precheck(file, mediaType);
      return {
        key: `${Date.now()}-${index}-${file.name}`,
        file,
        stage: problem ? 'failed' : 'waiting',
        percent: 0,
        reason: problem ? (problem.code === 'size' ? t('tooBig', { limit: format.bytes(problem.limit!) }) : t('wrongType', { type: file.type || file.name.split('.').pop() || '?' })) : null,
        mediaId: null,
        controller: null,
        roomLabel: mediaType === 'photo' && room.trim() ? room.trim() : null,
      };
    });
    setQueue((current) => [...current, ...items]);
  };

  // One upload at a time keeps memory use low for hashing and gives clear
  // progress; on mobile data the queue can wait for Wi-Fi.
  const paused = waitForWifi && onMobileData;
  const next = queue.find((item) => item.stage === 'waiting');
  const busy = queue.some((item) => ACTIVE.includes(item.stage));
  useEffect(() => {
    if (paused || busy || !next || running.current) return;
    running.current = true;
    void start(next).finally(() => {
      running.current = false;
    });
  }, [paused, busy, next]);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) add(event.dataTransfer.files);
  };

  const done = queue.filter((item) => ['done', 'ready', 'rejected'].includes(item.stage)).length;
  const accept = allowedTypes(mediaType).join(',');
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} title={mode === 'photos' ? t('uploadTitle') : t('uploadPlansTitle')} size="wide">
      <div className={styles.upload}>
        {mode === 'plans' ? (
          <SelectField
            label={t('planType')}
            value={mediaType}
            onChange={(value) => setMediaType(value as UploadMediaType)}
            options={(['floor_plan', 'site_plan', 'brochure'] as const).map((id) => ({ id, label: t(`type.${id}`) }))}
          />
        ) : null}
        <FieldRow>
          <SelectField
            label={t('unit')}
            value={unitId}
            onChange={setUnitId}
            options={[{ id: NONE, label: t('wholeProperty') }, ...(units.data?.data ?? []).filter((unit) => unit.archivedAt === null).map((unit) => ({ id: unit.id, label: unit.unitLabel }))]}
          />
          <SelectField
            label={t('attachListing')}
            value={attachTo}
            onChange={setAttachTo}
            options={[{ id: NONE, label: t('none') }, ...(listings.data?.data ?? []).map((listing) => ({ id: listing.id, label: `${listing.reference} · ${listing.title}` }))]}
          />
        </FieldRow>
        <div
          className={styles.dropzone}
          data-dragging={dragging || undefined}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p>
            {t('drop')}{' '}
            <Button onPress={() => input.current?.click()} variant="primary">
              {t('choose')}
            </Button>{' '}
            {mode === 'photos' ? <Button onPress={() => camera.current?.click()}>{t('takePhoto')}</Button> : null}
          </p>
          <p className={styles.quiet}>{mode === 'photos' ? t('photoRules') : t('planRules')}</p>
          <input
            ref={input}
            id={inputId}
            type="file"
            multiple
            accept={accept}
            hidden
            aria-label={t('choose')}
            onChange={(event) => {
              if (event.target.files) add(event.target.files);
              event.target.value = '';
            }}
          />
          <input
            ref={camera}
            type="file"
            accept="image/jpeg"
            capture="environment"
            hidden
            aria-label={t('takePhoto')}
            onChange={(event) => {
              if (event.target.files) add(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
        {mode === 'photos' ? <TextField label={t('batchRoom')} value={room} onChange={setRoom} maxLength={60} description={t('batchRoomHint')} dir="auto" /> : null}
        {quotaFull ? <Notice tone="danger" title={t('quota')} /> : null}
        {onMobileData ? (
          <Notice tone="info">
            {t('mobileData', { count: queue.filter((item) => item.stage === 'waiting' || ACTIVE.includes(item.stage)).length })}
            <Checkbox isSelected={waitForWifi} onChange={setWaitForWifi}>
              {t('waitForWifi')}
            </Checkbox>
          </Notice>
        ) : null}
        {mode === 'photos' ? <p className={styles.quiet}>ⓘ {t('gpsNote')}</p> : null}
        {queue.length > 0 ? (
          <>
            <ul className={styles.queue} aria-label={t('queue')}>
              {queue.map((item) => (
                <li key={item.key} className={styles.queueItem} data-stage={item.stage}>
                  <span className={styles.fileName}>
                    <bdi>{item.file.name}</bdi>
                  </span>
                  <span className="ep-num">{format.bytes(item.file.size)}</span>
                  <span className={styles.fileStatus}>
                    {item.stage === 'uploading' ? (
                      <>
                        <progress max={100} value={item.percent} aria-label={item.file.name} />{' '}
                      </>
                    ) : null}
                    {item.stage === 'rejected' || item.stage === 'failed' ? <span aria-hidden="true">✗ </span> : null}
                    {item.stage === 'ready' || item.stage === 'done' ? <span aria-hidden="true">✓ </span> : null}
                    {t(`fileStatus.${item.stage}`, { percent: item.percent, reason: item.reason ?? '' })}
                  </span>
                  {item.controller ? (
                    <Button size="small" onPress={() => item.controller?.abort()} aria-label={`${t('cancel')} ${item.file.name}`}>
                      {t('cancel')}
                    </Button>
                  ) : item.stage === 'failed' || item.stage === 'cancelled' ? (
                    precheck(item.file, mediaType) === null ? (
                      <Button size="small" onPress={() => void start(item)} aria-label={`${t('retry')} ${item.file.name}`}>
                        {t('retry')}
                      </Button>
                    ) : null
                  ) : null}
                </li>
              ))}
            </ul>
            <p>
              {t('summary', { done, total: queue.length })} · {t('leaveNote')}
            </p>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
