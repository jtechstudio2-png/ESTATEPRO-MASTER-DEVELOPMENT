'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { useListing, useListingGrant } from '@/components/listings/use-listing';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNotice, Notice, Skeleton } from '@/components/ui/feedback';
import { Checkbox } from '@/components/ui/fields';
import { Cluster, Panel } from '@/components/ui/layout';
import type { ListingGalleryDto, ListingMediaDto, MediaDto, MediaPageDto } from '@/lib/api-schema';
import { bff, bffRequest } from '@/lib/bff';
import { useRefreshAll } from '@/lib/mutations';
import { ApiError } from '@/lib/problem';
import { MAX_PHOTOS_PER_LISTING, MAX_PLANS_PER_LISTING } from '@/lib/upload';

import { mediaName } from './media-details';
import { MediaStatus, MoveDialog } from './media-tab';
import styles from './media.module.css';

const PLAN_TYPES = ['floor_plan', 'site_plan', 'brochure'];
type Item = Pick<MediaDto, 'id' | 'mediaType' | 'caption' | 'roomLabel' | 'originalFilename' | 'externalProvider' | 'altText' | 'urls' | 'processingStatus' | 'rejectionReason'> & { isCover: boolean };

/**
 * G-6 listing gallery editor (M-D5): which property media the listing shows,
 * in what order, and the cover. Saving sends the whole selection in one
 * request with If-Match, so concurrent editors get a 412 rather than a merge.
 */
export function GalleryEditor({ listingId }: { listingId: string }) {
  const t = useTranslations('media');
  const g = useTranslations('media.gallery');
  const common = useTranslations('common');
  const announce = useAnnounce();
  const refresh = useRefreshAll();
  const listing = useListing(listingId);
  const covers = useListingGrant();
  const gallery = useQuery({ queryKey: ['record', 'listing-gallery', listingId], queryFn: () => bff<ListingGalleryDto>(`listings/${listingId}/media`), refetchInterval: 10 * 60_000 });
  const propertyId = listing.data?.property.id;
  const media = useQuery({
    queryKey: ['record', 'property-media-picker', propertyId],
    queryFn: () => bff<MediaPageDto>(`properties/${propertyId}/media?sort=sortOrder&limit=100&filter[mediaType]=photo,floor_plan,site_plan,brochure`),
    enabled: propertyId !== undefined,
    refetchInterval: 10 * 60_000,
  });
  const [items, setItems] = useState<Item[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (gallery.data && items === null) setItems(gallery.data.data.map((item: ListingMediaDto) => ({ ...item })));
  }, [gallery.data, items]);

  if (listing.isPending || gallery.isPending || items === null) return <Skeleton />;
  if (listing.isError) return <ErrorNotice error={listing.error} onRetry={() => void listing.refetch()} />;
  if (gallery.isError) return <ErrorNotice error={gallery.error} onRetry={() => void gallery.refetch()} />;

  const record = listing.data;
  const editable = covers('listing.update', record) && record.archivedAt === null;
  const photos = items.filter((item) => item.mediaType === 'photo').length;
  const plans = items.filter((item) => PLAN_TYPES.includes(item.mediaType)).length;
  const inGallery = new Set(items.map((item) => item.id));
  const candidates = (media.data?.data ?? []).filter((item) => !inGallery.has(item.id) && item.archivedAt === null);
  const cover = items.find((item) => item.isCover) ?? items.find((item) => item.mediaType === 'photo');
  const dirty = JSON.stringify(items.map((item) => [item.id, item.id === (items.find((other) => other.isCover) ?? items.find((other) => other.mediaType === 'photo'))?.id])) !==
    JSON.stringify(gallery.data.data.map((item) => [item.id, item.isCover]));
  const nameOf = (item: Item) => mediaName(item, t(`type.${item.mediaType}`));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    setItems(next);
    announce(t('moved', { name: nameOf(item!), position: to + 1 }));
  };

  const addPicked = () => {
    const additions = candidates.filter((item) => picked.has(item.id) && item.processingStatus === 'ready');
    const nextPhotos = photos + additions.filter((item) => item.mediaType === 'photo').length;
    const nextPlans = plans + additions.filter((item) => PLAN_TYPES.includes(item.mediaType)).length;
    if (nextPhotos > MAX_PHOTOS_PER_LISTING || nextPlans > MAX_PLANS_PER_LISTING) {
      announce(g('limit', { maxPhotos: MAX_PHOTOS_PER_LISTING, maxPlans: MAX_PLANS_PER_LISTING }));
      return;
    }
    setItems([...items, ...additions.map((item) => ({ ...item, isCover: false }))]);
    setPicked(new Set());
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const coverId = cover?.id;
      const saved = await bffRequest<ListingGalleryDto>(`listings/${listingId}/media`, {
        method: 'PUT',
        version: record.version,
        body: { items: items.map((item) => ({ mediaId: item.id, isCover: item.id === coverId })) },
      });
      // The saved selection is the new baseline; the queries refresh behind it.
      setItems(saved.data.data.map((item) => ({ ...item })));
      announce(g('saved'));
      await refresh();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title={g('title', { reference: record.reference })}
      actions={
        editable ? (
          <Cluster>
            <Button onPress={() => setItems(null)} isDisabled={!dirty || busy}>
              {common('cancel')}
            </Button>
            <Button variant="primary" onPress={() => void save()} busy={busy} isDisabled={!dirty}>
              {g('save')}
            </Button>
          </Cluster>
        ) : undefined
      }
    >
      {editable ? null : <Notice tone="info">{g('readOnly')}</Notice>}
      {error instanceof ApiError && error.status === 412 ? (
        <Notice tone="warning" title={common('conflictTitle')} action={<Button onPress={() => void refresh().then(() => setItems(null))}>{common('conflictReload')}</Button>}>
          {common('conflictDetail')}
        </Notice>
      ) : error ? (
        <ErrorNotice error={error} />
      ) : null}
      {cover && !cover.altText ? <Notice tone="warning">{g('coverNoAlt')}</Notice> : null}
      <div className={styles.gallery}>
        <section aria-labelledby="gallery-in-listing">
          <h3 id="gallery-in-listing" className={styles.subheading}>
            {g('inListing', { photos, maxPhotos: MAX_PHOTOS_PER_LISTING, plans, maxPlans: MAX_PLANS_PER_LISTING })}
          </h3>
          {editable ? <p className={styles.quiet}>{g('dragHint')}</p> : null}
          {items.length === 0 ? (
            <EmptyState title={g('empty')} headingLevel={4} />
          ) : (
            <ol className={styles.ordered}>
              {items.map((item, index) => {
                const name = nameOf(item);
                return (
                  <li
                    key={item.id}
                    className={styles.orderedItem}
                    draggable={editable}
                    data-dragging={dragging === index}
                    data-over={over === index && dragging !== index}
                    onDragStart={() => setDragging(index)}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setOver(index);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragging !== null) move(dragging, index);
                      setDragging(null);
                      setOver(null);
                    }}
                    aria-label={g('positionOf', { index: index + 1, total: items.length })}
                  >
                    <span className="ep-num">
                      {index + 1}
                      {item.id === cover?.id ? (
                        <span title={g('coverLabel')}>
                          {' '}
                          <span aria-hidden="true">★</span>
                          <span className="ep-visually-hidden">{g('coverLabel')}</span>
                        </span>
                      ) : null}
                    </span>
                    {item.urls.thumb ? <img src={item.urls.thumb} alt="" className={styles.smallThumb} /> : <span className={styles.smallThumb} aria-hidden="true" />}
                    <span>
                      <bdi>{name}</bdi> <span className={styles.quiet}>· {t(`type.${item.mediaType}`)}</span>
                    </span>
                    {editable ? (
                      <Cluster>
                        <Button size="small" variant="quiet" onPress={() => move(index, index - 1)} isDisabled={index === 0} aria-label={`${common('moveUp')}: ${name}`}>
                          <span aria-hidden="true">↑</span>
                        </Button>
                        <Button size="small" variant="quiet" onPress={() => move(index, index + 1)} isDisabled={index === items.length - 1} aria-label={`${common('moveDown')}: ${name}`}>
                          <span aria-hidden="true">↓</span>
                        </Button>
                        <Button size="small" variant="quiet" onPress={() => setMoving(index)} aria-label={`${t('moveTo')} ${name}`}>
                          #
                        </Button>
                        {item.mediaType === 'photo' && item.id !== cover?.id ? (
                          <Button size="small" onPress={() => setItems(items.map((other) => ({ ...other, isCover: other.id === item.id })))} aria-label={g('makeCover', { name })}>
                            ★
                          </Button>
                        ) : null}
                        <Button size="small" variant="quiet" onPress={() => setItems(items.filter((other) => other.id !== item.id))} aria-label={g('remove', { name })}>
                          <span aria-hidden="true">✕</span>
                        </Button>
                      </Cluster>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
        {editable ? (
          <section aria-labelledby="gallery-property-media">
            <h3 id="gallery-property-media" className={styles.subheading}>
              {g('propertyMedia')}
            </h3>
            <p className={styles.quiet}>{g('notReady')}</p>
            <ul className={styles.ordered}>
              {candidates.map((item) => (
                <li key={item.id} className={styles.orderedItem}>
                  <Checkbox
                    isSelected={picked.has(item.id)}
                    isDisabled={item.processingStatus !== 'ready'}
                    onChange={(value) => {
                      const next = new Set(picked);
                      if (value) next.add(item.id);
                      else next.delete(item.id);
                      setPicked(next);
                    }}
                  >
                    <span className="ep-visually-hidden">{t('select', { name: mediaName(item, t(`type.${item.mediaType}`)) })}</span>
                  </Checkbox>
                  {item.urls.thumb ? <img src={item.urls.thumb} alt="" className={styles.smallThumb} /> : <span className={styles.smallThumb} aria-hidden="true" />}
                  <span>
                    <bdi>{mediaName(item, t(`type.${item.mediaType}`))}</bdi>
                  </span>
                  {item.processingStatus === 'ready' ? null : <MediaStatus media={item} />}
                </li>
              ))}
            </ul>
            <Button onPress={addPicked} isDisabled={picked.size === 0}>
              {g('addSelected')}
            </Button>
          </section>
        ) : null}
      </div>
      {moving !== null && items[moving] ? (
        <MoveDialog
          media={items[moving]}
          total={items.length}
          current={moving + 1}
          onMove={(position) => {
            move(moving, position - 1);
            setMoving(null);
          }}
          onClose={() => setMoving(null)}
        />
      ) : null}
    </Panel>
  );
}
