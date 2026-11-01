'use client';

import { useQuery } from '@tanstack/react-query';
import type { Feature } from 'geojson';
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

import { useAnnounce } from '@/components/announcer';
import { ListingState, ListingStatusLabel, PriceText } from '@/components/listings/listing-labels';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorNotice, Notice, RefreshBar, Skeleton } from '@/components/ui/feedback';
import { SegmentedControl, SelectField } from '@/components/ui/fields';
import { Page, PageHeader } from '@/components/ui/layout';
import { type Chip, FilterBar, FilterSelect, listStyles, LoadMore, SortSelect } from '@/components/ui/list-controls';
import type { ListingListItemDto, ListingMapDto, LocationsPanelDto, MediaDto, PropertyMapDto, PropertySummaryDto } from '@/lib/api-schema';
import { bff } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';
import { usePagedList } from '@/lib/hooks/paged-list';
import { useOffices, usePropertyTypes } from '@/lib/hooks/reference';

import { LocationFilter, useLocationChip } from './location-filter';
import { type Bbox, type LngLat, type MapHandle, type MapPoint, MapView } from './map-view';
import styles from './map-search.module.css';

type Kind = 'listings' | 'properties';
type Tool = 'radius' | 'draw' | null;

const RADII = [500, 1000, 2000, 5000, 10000, 20000, 50000];
const MAX_DRAW_POINTS = 100;
const PAN_STEP = 80;
const LISTING_STATUSES = ['draft', 'available', 'reserved', 'under_contract', 'sold', 'rented', 'withdrawn', 'expired'] as const;
const LISTING_SORTS = ['-updatedAt', 'price', '-price'] as const;
const PROPERTY_SORTS = ['-updatedAt', 'reference'] as const;

/**
 * Where the map opens when the URL has no viewport: the member's market
 * (west, south, east, north). Each fits the API's 30° viewport limit.
 */
const COUNTRY_VIEWS: Record<string, Bbox> = {
  GH: [-3.26, 4.73, 1.2, 11.17],
  QA: [50.75, 24.47, 51.64, 26.18],
  GB: [-8.65, 49.86, 1.77, 60.86],
};

const round = (value: number) => Math.round(value * 1e5) / 1e5;
const bboxParam = (bbox: Bbox) => bbox.map(round).join(',');

function parseBbox(raw: string | null): Bbox | null {
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) ? (parts as Bbox) : null;
}

function parsePolygon(raw: string | null): LngLat[] | null {
  if (!raw) return null;
  const points = raw.split(',').map((pair) => pair.trim().split(' ').map(Number) as LngLat);
  return points.length >= 3 && points.every((point) => point.length === 2 && point.every(Number.isFinite)) ? points : null;
}

/** A circle as a polygon for display (equirectangular; the API measures on the spheroid). */
function circle(lat: number, lng: number, metres: number, steps = 64): LngLat[] {
  const dLat = metres / 111_320;
  const dLng = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = (index / steps) * 2 * Math.PI;
    return [lng + dLng * Math.cos(angle), lat + dLat * Math.sin(angle)] as LngLat;
  });
}

function boundsOf(points: LngLat[]): Bbox {
  const lngs = points.map((point) => point[0]);
  const lats = points.map((point) => point[1]);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

/** The applied area (radius or drawn polygon) as a ring, from the URL. */
function useArea(params: ReturnType<typeof useListParams>): LngLat[] | null {
  const near = params.get('filter[near]');
  const radius = Number(params.get('filter[radius]') ?? 2000);
  const polygon = params.get('filter[polygon]');
  return useMemo(() => {
    const drawn = parsePolygon(polygon);
    if (drawn) return [...drawn, drawn[0]!];
    if (!near) return null;
    const [lat, lng] = near.split(',').map(Number);
    return lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng) ? circle(lat, lng, radius) : null;
  }, [near, radius, polygon]);
}

/** Cover thumbnail, requested only once the card is on screen (M-2 security note). */
function CoverThumb({ mediaId }: { mediaId: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || mediaId === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [mediaId]);
  const media = useQuery({ queryKey: ['record', 'media', mediaId], queryFn: () => bff<MediaDto>(`media/${mediaId}`), enabled: visible && mediaId !== null, staleTime: 5 * 60_000 });
  const thumb = media.data?.urls.thumb;
  return (
    <span ref={ref} className={styles.thumb} aria-hidden={thumb ? undefined : true}>
      {thumb ? <img src={thumb} alt="" /> : null}
    </span>
  );
}

/**
 * M-2 listing map search and M-3 property map: list and map side by side
 * (one at a time below 1024 px, X-5). The map refreshes on "Search this
 * area", not on every move; clusters come back above 500 results and zoom
 * to their bounds. Radius and drawn areas work with the pointer or with the
 * keyboard crosshair.
 */
export function MapSearch({ kind }: { kind: Kind }) {
  const t = useTranslations('location');
  const list = useTranslations('list');
  const lt = useTranslations('listings');
  const pt = useTranslations('properties');
  const format = useFormat();
  const announce = useAnnounce();
  const params = useListParams();
  const mapRef = useRef<MapHandle>(null);
  const { offices, isPending: officesPending } = useOffices(kind === 'listings' ? 'listing.view' : 'property.view');
  const propertyTypes = usePropertyTypes();
  const locationChip = useLocationChip();
  const [pending, setPending] = useState<Bbox | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [draft, setDraft] = useState<LngLat[]>([]);
  const [radius, setRadius] = useState(params.get('filter[radius]') ?? '2000');
  const applyNextMove = useRef(false);

  const applied = parseBbox(params.get('filter[bbox]'));
  const near = params.get('filter[near]') !== null;
  const pane = params.get('pane') === 'list' ? 'list' : 'map';
  const area = useArea(params);
  const areaFeature: Feature | null = area ? { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [area] } } : null;

  // Where the map opens: the URL viewport, else the member's market.
  const countryView = offices.map((office) => COUNTRY_VIEWS[office.countryCode]).find((view) => view !== undefined) ?? null;
  const [initial] = useState<{ bounds: Bbox } | null>(() => (applied ? { bounds: applied } : null));
  const opening = initial ?? (countryView ? { bounds: countryView } : null);
  const wroteView = useRef(false);
  const missingView = applied === null && countryView !== null ? bboxParam(countryView) : null;
  useEffect(() => {
    // Only the first market view is written to the URL; later views come from "Search this area".
    if (missingView === null || wroteView.current) return;
    wroteView.current = true;
    params.set({ 'filter[bbox]': missingView });
  }, [missingView, params]);

  const defaultSort = '-updatedAt';
  const sort = params.get('sort') ?? (near ? 'distance' : defaultSort);
  const listQuery = new URLSearchParams(params.apiQuery);
  listQuery.set('sort', sort);
  const ready = applied !== null;
  const mapQuery = useQuery({
    queryKey: ['list', `${kind}-map`, params.apiQuery.toString()],
    queryFn: ({ signal }) => bff<ListingMapDto | PropertyMapDto>(`${kind}/map?${params.apiQuery.toString()}`, { signal }),
    enabled: ready,
    retry: false,
  });
  const listResult = usePagedList<ListingListItemDto | PropertySummaryDto>(kind, listQuery, { limit: 25, enabled: ready });
  const noLocation = useQuery({
    queryKey: ['dashboard', 'locations'],
    queryFn: () => bff<LocationsPanelDto>('dashboards/property/locations'),
    enabled: kind === 'properties',
  });

  // A selected pin whose record is not on the loaded page of the list is shown above it.
  const selectedPoint =
    selected !== null && !listResult.rows.some((row) => row.id === selected) && mapQuery.data && !mapQuery.data.clustered
      ? (mapQuery.data.points as Array<ListingMapDto['points'][number] | PropertyMapDto['points'][number]>).find((point) => point.id === selected) ?? null
      : null;
  const covers = new Map<string, string | null>();
  if (kind === 'listings' && mapQuery.data) for (const point of (mapQuery.data as ListingMapDto).points) covers.set(point.id, point.coverMediaId);

  const points: MapPoint[] = useMemo(() => {
    const data = mapQuery.data;
    if (!data) return [];
    if (data.clustered) {
      return data.clusters.map((cluster, index) => ({
        id: `${index}:${cluster.latitude},${cluster.longitude}`,
        lng: cluster.longitude,
        lat: cluster.latitude,
        count: cluster.count,
        bounds: cluster.bounds as Bbox,
        label: t('cluster', { count: cluster.count }),
      }));
    }
    if (kind === 'listings') {
      return (data as ListingMapDto).points.map((point) => ({
        id: point.id,
        lng: point.longitude,
        lat: point.latitude,
        label: `${point.reference}, ${format.money(point.price)}, ${lt(`statusValue.${point.status}`)}`,
      }));
    }
    return (data as PropertyMapDto).points.map((point) => ({ id: point.id, lng: point.longitude, lat: point.latitude, label: `${point.reference}, ${point.name ?? ''}` }));
  }, [mapQuery.data, kind, t, lt, format]);

  const searchArea = (bbox: Bbox) => {
    setPending(null);
    params.set({ 'filter[bbox]': bboxParam(bbox), cursor: null });
  };

  const activate = (point: MapPoint) => {
    if (point.count && point.bounds) {
      applyNextMove.current = true;
      mapRef.current?.fitBounds(point.bounds);
      return;
    }
    setSelected(point.id);
    announce(t('selected', { name: point.label }));
    document.getElementById(`map-card-${point.id}`)?.scrollIntoView({ block: 'nearest' });
  };

  const addPoint = (at: LngLat) => {
    if (tool === 'radius') {
      setDraft([at]);
      announce(t('radiusCentreSet'));
    } else if (tool === 'draw' && draft.length < MAX_DRAW_POINTS) {
      setDraft([...draft, at]);
      announce(t('drawPoints', { count: draft.length + 1 }));
    }
  };

  const cancelTool = () => {
    setTool(null);
    setDraft([]);
  };

  const finish = () => {
    if (tool === 'radius' && draft[0]) {
      const [lng, lat] = draft[0];
      const ring = circle(lat, lng, Number(radius));
      const bounds = boundsOf(ring);
      params.set({ 'filter[near]': `${round(lat)},${round(lng)}`, 'filter[radius]': radius, nearLabel: null, 'filter[polygon]': null, 'filter[bbox]': bboxParam(bounds), sort: 'distance', cursor: null });
      mapRef.current?.fitBounds(bounds);
    } else if (tool === 'draw' && draft.length >= 3) {
      const bounds = boundsOf(draft);
      params.set({
        'filter[polygon]': draft.map(([lng, lat]) => `${round(lng)} ${round(lat)}`).join(','),
        'filter[near]': null,
        'filter[radius]': null,
        nearLabel: null,
        'filter[bbox]': bboxParam(bounds),
        sort: params.get('sort') === 'distance' ? null : params.get('sort'),
        cursor: null,
      });
      mapRef.current?.fitBounds(bounds);
    } else {
      return;
    }
    setPending(null);
    cancelTool();
  };

  const onToolKey = (event: KeyboardEvent) => {
    if (tool === null) return;
    const pan: Record<string, [number, number]> = { ArrowUp: [0, -PAN_STEP], ArrowDown: [0, PAN_STEP], ArrowLeft: [-PAN_STEP, 0], ArrowRight: [PAN_STEP, 0] };
    const offset = pan[event.key];
    if (offset && event.target instanceof HTMLElement && event.target.dataset['crosshair'] === 'true') {
      event.preventDefault();
      mapRef.current?.panBy(offset);
    } else if (event.key === ' ' && event.target instanceof HTMLElement && event.target.dataset['crosshair'] === 'true') {
      event.preventDefault();
      const centre = mapRef.current?.getCenter();
      if (centre) addPoint(centre);
    } else if (event.key === 'Enter' && tool === 'draw') {
      event.preventDefault();
      finish();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelTool();
    }
  };

  // Filters (the list view's filters carry over through the URL).
  const chips: Chip[] = [];
  const named = (key: string, label: string, value: (raw: string) => string) => {
    const raw = params.get(key);
    if (raw !== null) chips.push({ key, label: `${label}: ${value(raw)}`, onRemove: () => params.set({ [key]: null }) });
  };
  if (kind === 'listings') {
    named('filter[status]', lt('status'), (raw) => raw.split(',').map((status) => lt(`statusValue.${status as (typeof LISTING_STATUSES)[number]}`)).join(', '));
    named('filter[bedrooms][gte]', lt('bedsMin'), (raw) => raw);
    const price = params.get('filter[price][gte]') ?? params.get('filter[price][lte]');
    if (price !== null) {
      chips.push({
        key: 'price',
        label: `${lt('priceFilter')}: ${params.get('filter[price][gte]') ?? '0'}–${params.get('filter[price][lte]') ?? '∞'} ${params.get('filter[currencyCode]') ?? ''}`,
        onRemove: () => params.set({ 'filter[price][gte]': null, 'filter[price][lte]': null, 'filter[currencyCode]': null }),
      });
    }
  } else {
    named('filter[propertyTypeId]', pt('type'), (raw) => propertyTypes.data?.data.find((type) => type.id === raw)?.name ?? raw);
    named('filter[isManaged]', pt('managed'), (raw) => (raw === 'true' ? pt('managedYes') : pt('managedNo')));
  }
  named('filter[officeId]', lt('office'), (raw) => offices.find((office) => office.id === raw)?.name ?? raw);
  if (locationChip) chips.push({ key: 'location', label: locationChip.label, onRemove: locationChip.clear });

  const total = mapQuery.data?.total ?? null;
  const listHref = (() => {
    const next = new URLSearchParams(params.apiQuery);
    next.delete('filter[bbox]');
    const search = next.toString();
    return `/${kind}${search ? `?${search}` : ''}`;
  })();
  const sortOptions = [...(near ? (['distance'] as const) : []), ...(kind === 'listings' ? LISTING_SORTS : PROPERTY_SORTS)].map((id) => ({
    id,
    label: id === 'distance' ? t('sortDistance') : kind === 'listings' ? lt(`sort.${id as (typeof LISTING_SORTS)[number]}`) : pt(`sort.${id as (typeof PROPERTY_SORTS)[number]}`),
  }));
  const showSearchArea = pending !== null && (applied === null || bboxParam(pending) !== bboxParam(applied));

  return (
    <Page>
      <PageHeader
        title={kind === 'listings' ? t('mapListings') : t('mapProperties')}
        actions={
          <nav aria-label={list('view')} className={listStyles.footer}>
            <LinkButton href={listHref}>{list('listView')}</LinkButton>
            <LinkButton href={`/map/${kind}?${params.apiQuery.toString()}`} aria-current="page" variant="primary">
              {list('mapView')}
            </LinkButton>
          </nav>
        }
      />
      <FilterBar chips={chips} onClearAll={() => params.clear(['sort', 'filter[bbox]'])}>
        {kind === 'listings' ? (
          <>
            <SegmentedControl
              label={lt('typeLabel')}
              value={params.get('filter[listingType]') ?? 'all'}
              onChange={(value) => params.set({ 'filter[listingType]': value === 'all' ? null : value })}
              options={[
                { id: 'all', label: list('any') },
                { id: 'rent', label: lt('type.rent') },
                { id: 'sale', label: lt('type.sale') },
              ]}
            />
            <FilterSelect label={lt('status')} value={params.get('filter[status]')} onChange={(value) => params.set({ 'filter[status]': value })} options={LISTING_STATUSES.map((id) => ({ id, label: lt(`statusValue.${id}`) }))} />
            <FilterSelect label={lt('bedsMin')} value={params.get('filter[bedrooms][gte]')} onChange={(value) => params.set({ 'filter[bedrooms][gte]': value })} options={['1', '2', '3', '4', '5'].map((id) => ({ id, label: `${id}+` }))} />
          </>
        ) : (
          <>
            <FilterSelect
              label={pt('type')}
              value={params.get('filter[propertyTypeId]')}
              onChange={(value) => params.set({ 'filter[propertyTypeId]': value })}
              options={(propertyTypes.data?.data ?? []).filter((type) => type.appliesTo !== 'unit').map((type) => ({ id: type.id, label: type.name }))}
            />
            <FilterSelect
              label={pt('managed')}
              value={params.get('filter[isManaged]')}
              onChange={(value) => params.set({ 'filter[isManaged]': value })}
              options={[
                { id: 'true', label: pt('managedYes') },
                { id: 'false', label: pt('managedNo') },
              ]}
            />
          </>
        )}
        <div className={styles.areaTools} role="group" aria-label={t('areaTools')}>
          <Button onPress={() => (tool === 'radius' ? cancelTool() : (setDraft([]), setTool('radius')))} aria-pressed={tool === 'radius'}>
            {t('radius')}
          </Button>
          <Button onPress={() => (tool === 'draw' ? cancelTool() : (setDraft([]), setTool('draw')))} aria-pressed={tool === 'draw'}>
            {t('draw')}
          </Button>
          <LocationFilter label={t('nearPlace')} />
          {area ? <Button onPress={() => locationChip?.clear()}>{t('clearArea')}</Button> : null}
        </div>
        {kind === 'properties' && noLocation.data ? (
          <NextLink href="/properties?filter[hasLocation]=false" className={styles.noLocation}>
            {t('noLocationCount', { count: noLocation.data.missing })}
            <span aria-hidden="true"> ›</span>
          </NextLink>
        ) : null}
      </FilterBar>

      <div className={styles.paneSwitch}>
        <SegmentedControl
          label={t('listMap')}
          value={pane}
          onChange={(value) => params.set({ pane: value === 'map' ? null : value })}
          options={[
            { id: 'map', label: t('showMap') },
            { id: 'list', label: t('showList') },
          ]}
        />
      </div>

      <div className={styles.layout} data-pane={pane}>
        <section className={styles.results} aria-labelledby="map-results-heading">
          <h2 id="map-results-heading" className={styles.resultsHeading} aria-live="polite">
            {total === null ? (kind === 'listings' ? lt('title') : pt('title')) : t('results', { count: total })}
          </h2>
          <SortSelect value={sort} onChange={(value) => params.set({ sort: value === (near ? 'distance' : defaultSort) ? null : value })} options={sortOptions} />
          <RefreshBar active={listResult.isFetching && !listResult.isPending} />
          {!ready ? (
            officesPending ? (
              <Skeleton />
            ) : (
              <p className={styles.quiet}>{t('zoomToSearch')}</p>
            )
          ) : listResult.isPending ? (
            <div aria-busy="true">
              <Skeleton />
              <Skeleton />
              <Skeleton width="80%" />
            </div>
          ) : listResult.isError ? (
            <ErrorNotice error={listResult.error} onRetry={() => void listResult.refetch()} />
          ) : listResult.rows.length === 0 ? (
            <EmptyState headingLevel={3} title={t('results', { count: 0 })}>
              {list('emptyFilteredDetail')}
            </EmptyState>
          ) : (
            <>
              <ul className={styles.cards} aria-label={kind === 'listings' ? lt('list') : pt('list')}>
                {selectedPoint ? (
                  <li id={`map-card-${selectedPoint.id}`} className={styles.card} data-selected="true">
                    {'coverMediaId' in selectedPoint ? <CoverThumb mediaId={selectedPoint.coverMediaId} /> : null}
                    <div className={styles.cardBody}>
                      <NextLink href={`/${kind}/${selectedPoint.id}`} className={styles.cardTitle}>
                        <bdi>{'name' in selectedPoint ? (selectedPoint.name ?? selectedPoint.reference) : selectedPoint.reference}</bdi>
                      </NextLink>
                      <span className={styles.quiet}>
                        <bdi className="ep-num">{selectedPoint.reference}</bdi>
                      </span>
                      {'price' in selectedPoint ? (
                        <>
                          <PriceText price={selectedPoint.price} rentFrequency={selectedPoint.rentFrequency} />
                          <ListingStatusLabel status={selectedPoint.status} />
                        </>
                      ) : null}
                      <Button size="small" variant="quiet" aria-pressed onPress={() => setSelected(null)}>
                        {t('showOnMap', { name: 'name' in selectedPoint ? (selectedPoint.name ?? selectedPoint.reference) : selectedPoint.reference })}
                      </Button>
                    </div>
                  </li>
                ) : null}
                {listResult.rows.map((row) => {
                  const isSelected = row.id === selected;
                  const name = kind === 'listings' ? (row as ListingListItemDto).title : ((row as PropertySummaryDto).name ?? row.reference);
                  return (
                    <li key={row.id} id={`map-card-${row.id}`} className={styles.card} data-selected={isSelected}>
                      {kind === 'listings' ? <CoverThumb mediaId={covers.get(row.id) ?? null} /> : null}
                      <div className={styles.cardBody}>
                        <NextLink href={`/${kind}/${row.id}`} className={styles.cardTitle}>
                          <bdi>{name}</bdi>
                        </NextLink>
                        <span className={styles.quiet}>
                          <bdi className="ep-num">{row.reference}</bdi>
                          {row.distanceMeters !== null ? ` · ${t('distanceAway', { distance: format.distance(row.distanceMeters) })}` : null}
                        </span>
                        {kind === 'listings' ? (
                          <>
                            <PriceText price={(row as ListingListItemDto).price} rentFrequency={(row as ListingListItemDto).rentFrequency} />
                            <ListingState listing={row as ListingListItemDto} />
                          </>
                        ) : (
                          <span className={styles.quiet}>
                            <bdi>{(row as PropertySummaryDto).propertyType.name}</bdi>
                            {(row as PropertySummaryDto).formattedAddress ? (
                              <>
                                {' · '}
                                <bdi>{(row as PropertySummaryDto).formattedAddress}</bdi>
                              </>
                            ) : null}
                          </span>
                        )}
                        {mapQuery.data && !mapQuery.data.clustered ? (
                          <Button size="small" variant="quiet" aria-pressed={isSelected} onPress={() => setSelected(isSelected ? null : row.id)}>
                            {t('showOnMap', { name })}
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <LoadMore hasMore={listResult.hasNextPage} loading={listResult.isFetchingNextPage} onLoad={listResult.loadMore} shown={listResult.rows.length} />
            </>
          )}
        </section>

        <div className={styles.mapPane} onKeyDown={onToolKey}>
          {opening ? (
            <MapView
              ref={mapRef}
              label={kind === 'listings' ? t('mapListings') : t('mapProperties')}
              initial={opening}
              points={points}
              selectedId={selected}
              onPointActivate={activate}
              onMapClick={tool ? addPoint : undefined}
              onMoveEnd={(bbox) => {
                if (applyNextMove.current) {
                  applyNextMove.current = false;
                  searchArea(bbox);
                } else {
                  setPending(bbox);
                }
              }}
              area={tool === null ? areaFeature : null}
              draft={tool === 'draw' ? draft : tool === 'radius' && draft[0] ? circle(draft[0][1], draft[0][0], Number(radius)) : []}
              className={styles.map}
            >
              {tool ? <button type="button" className={styles.crosshair} data-crosshair="true" aria-label={t('crosshair')} aria-describedby="map-tool-help" /> : null}
              {showSearchArea ? (
                <div className={styles.searchArea}>
                  <Button variant="primary" onPress={() => pending && searchArea(pending)}>
                    {t('searchArea')}
                  </Button>
                </div>
              ) : null}
            </MapView>
          ) : (
            <Skeleton />
          )}
          {tool ? (
            <div className={styles.toolPanel} role="group" aria-label={tool === 'radius' ? t('radiusTool') : t('drawTool')}>
              <p id="map-tool-help" className={styles.quiet}>
                {tool === 'radius' ? t('radiusHelp') : t('drawHelp')}
              </p>
              {tool === 'radius' ? (
                <SelectField label={t('radiusSize')} value={radius} onChange={setRadius} options={RADII.map((value) => ({ id: String(value), label: format.distance(value) }))} />
              ) : (
                <p className={styles.quiet}>
                  {t('drawPoints', { count: draft.length })}
                </p>
              )}
              <div className={listStyles.footer}>
                <Button onPress={cancelTool}>{tool === 'radius' ? t('radiusCancel') : t('drawCancel')}</Button>
                <Button variant="primary" onPress={finish} isDisabled={tool === 'radius' ? draft.length === 0 : draft.length < 3}>
                  {tool === 'radius' ? t('radiusApply') : t('drawFinish')}
                </Button>
              </div>
            </div>
          ) : null}
          {mapQuery.isError ? <ErrorNotice error={mapQuery.error} onRetry={() => void mapQuery.refetch()} /> : null}
          {mapQuery.data?.clustered ? <Notice tone="info">{t('clustered')}</Notice> : null}
        </div>
      </div>
    </Page>
  );
}
