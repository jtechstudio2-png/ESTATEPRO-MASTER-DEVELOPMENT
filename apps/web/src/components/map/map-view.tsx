'use client';

import 'maplibre-gl/dist/maplibre-gl.css';

import type { Feature, FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap, Marker } from 'maplibre-gl';
import { useLocale, useTranslations } from 'next-intl';
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { basemapStyle, COLOURS } from './basemap-style';
import { useMapConfig } from './map-config';
import styles from './map.module.css';

export type LngLat = [number, number];
export type Bbox = [number, number, number, number];

export interface MapPoint {
  id: string;
  lng: number;
  lat: number;
  /** Accessible name of the marker, e.g. "PRP-…, Osu Court". */
  label: string;
  /** Clusters carry a count and bounds; points are single records. */
  count?: number;
  bounds?: Bbox;
}

export interface MapHandle {
  fitBounds: (bounds: Bbox, maxZoom?: number) => void;
  flyTo: (center: LngLat, zoom?: number) => void;
  getBounds: () => Bbox | null;
  getCenter: () => LngLat | null;
  getZoom: () => number;
}

interface MapViewProps {
  /** Names the map region (UI checklist §8). */
  label: string;
  initial: { center: LngLat; zoom: number } | { bounds: Bbox };
  points?: MapPoint[];
  selectedId?: string | null;
  onPointActivate?: (point: MapPoint) => void;
  onMapClick?: (lngLat: LngLat) => void;
  onMoveEnd?: (bbox: Bbox, zoom: number) => void;
  /** A draggable pin (M-1). Arrow keys move it while focused. */
  pin?: LngLat | null;
  pinLabel?: string;
  onPinMove?: (lngLat: LngLat) => void;
  /** Area overlay: a radius circle or a drawn polygon (M-2). */
  area?: Feature | null;
  /** Points of an area being drawn. */
  draft?: LngLat[];
  interactive?: boolean;
  className?: string;
  children?: ReactNode;
}

let assetsReady = false;

async function loadMapLibre() {
  const maplibre = await import('maplibre-gl');
  if (!assetsReady) {
    const { Protocol } = await import('pmtiles');
    // The worker and the tile protocol are self-hosted (W-D4).
    maplibre.setWorkerUrl('/basemap/maplibre-gl-worker.mjs');
    maplibre.addProtocol('pmtiles', new Protocol().tile);
    assetsReady = true;
  }
  return maplibre;
}

function bboxOf(map: MapLibreMap): Bbox {
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * MapLibre map on our own tiles (W-D4). Markers are real buttons (focusable,
 * named, text plus shape); the map region is named; controls sit at the
 * inline end; north stays up and the map itself is never mirrored in RTL.
 */
export const MapView = forwardRef<MapHandle, MapViewProps>(function MapView(
  { label, initial, points = [], selectedId = null, onPointActivate, onMapClick, onMoveEnd, pin = null, pinLabel, onPinMove, area = null, draft = [], interactive = true, className, children },
  ref,
) {
  const t = useTranslations('location');
  const language = useLocale();
  const config = useMapConfig();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef<Map<string, Marker>>(new Map());
  const pinMarker = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const callbacks = useRef({ onPointActivate, onMapClick, onMoveEnd, onPinMove });
  callbacks.current = { onPointActivate, onMapClick, onMoveEnd, onPinMove };
  const pointsRef = useRef(points);
  pointsRef.current = points;

  useImperativeHandle(ref, () => ({
    fitBounds: (bounds, maxZoom = 16) => mapRef.current?.fitBounds([bounds[0], bounds[1], bounds[2], bounds[3]], { padding: 40, maxZoom, duration: 0 }),
    flyTo: (center, zoom) => mapRef.current?.jumpTo({ center, ...(zoom === undefined ? {} : { zoom }) }),
    getBounds: () => (mapRef.current ? bboxOf(mapRef.current) : null),
    getCenter: () => {
      const center = mapRef.current?.getCenter();
      return center ? [center.lng, center.lat] : null;
    },
    getZoom: () => mapRef.current?.getZoom() ?? 0,
  }));

  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | null = null;
    void loadMapLibre()
      .then((maplibre) => {
        if (cancelled || !container.current) return;
        const rtl = document.documentElement.dir === 'rtl';
        map = new maplibre.Map({
          container: container.current,
          style: basemapStyle({ tilesUrl: config.tilesUrl, glyphsUrl: config.glyphsUrl, language }),
          ...('bounds' in initial ? { bounds: initial.bounds, fitBoundsOptions: { padding: 40, maxZoom: 16 } } : { center: initial.center, zoom: initial.zoom }),
          interactive,
          attributionControl: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          maxPitch: 0,
          locale: {
            'NavigationControl.ZoomIn': t('zoomIn'),
            'NavigationControl.ZoomOut': t('zoomOut'),
            'Map.Title': label,
          },
        });
        map.touchZoomRotate.disableRotation();
        if (interactive) map.addControl(new maplibre.NavigationControl({ showCompass: false }), rtl ? 'top-left' : 'top-right');
        if (config.tilesUrl) map.addControl(new maplibre.AttributionControl({ compact: false }), rtl ? 'bottom-left' : 'bottom-right');
        map.getCanvas().setAttribute('aria-label', label);
        map.on('load', () => {
          if (!map) return;
          map.addSource('area', { type: 'geojson', data: EMPTY });
          map.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': '#175cd3', 'fill-opacity': 0.12 } });
          map.addLayer({ id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': '#175cd3', 'line-width': 2 } });
          map.addSource('draft', { type: 'geojson', data: EMPTY });
          map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', paint: { 'line-color': COLOURS.label, 'line-width': 2, 'line-dasharray': [2, 2] } });
          map.addLayer({ id: 'draft-points', type: 'circle', source: 'draft', paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': COLOURS.label, 'circle-stroke-width': 2 } });
          mapRef.current = map;
          setReady(true);
        });
        map.on('click', (event) => callbacks.current.onMapClick?.([event.lngLat.lng, event.lngLat.lat]));
        map.on('moveend', () => {
          if (map) callbacks.current.onMoveEnd?.(bboxOf(map), map.getZoom());
        });
        map.on('error', (event) => {
          // Tile errors leave the background usable; only a failed style is fatal.
          if (!map?.isStyleLoaded() && String(event.error?.message ?? '').includes('style')) setFailed(true);
        });
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      for (const marker of markers.current.values()) marker.remove();
      markers.current.clear();
      pinMarker.current = null;
      mapRef.current = null;
      map?.remove();
    };
    // The map is created once; later prop changes are applied by the effects below.
  }, []);

  // Markers: one focusable button per point or cluster.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    void import('maplibre-gl').then(({ Marker: MarkerClass }) => {
      const seen = new Set<string>();
      for (const point of points) {
        const key = `${point.count ? 'c' : 'p'}:${point.id}`;
        seen.add(key);
        let marker = markers.current.get(key);
        if (!marker) {
          // Markers that do something are buttons; display-only ones are images.
          const activatable = Boolean(callbacks.current.onPointActivate);
          const element = document.createElement(activatable ? 'button' : 'span');
          if (element instanceof HTMLButtonElement) element.type = 'button';
          else element.setAttribute('role', 'img');
          element.className = (point.count ? styles.cluster : styles.marker) ?? '';
          element.addEventListener('click', (event) => {
            event.stopPropagation();
            const current = pointsRef.current.find((item) => `${item.count ? 'c' : 'p'}:${item.id}` === key);
            if (current) callbacks.current.onPointActivate?.(current);
          });
          marker = new MarkerClass({ element, anchor: 'center' }).setLngLat([point.lng, point.lat]).addTo(map);
          markers.current.set(key, marker);
        }
        const element = marker.getElement();
        marker.setLngLat([point.lng, point.lat]);
        element.setAttribute('aria-label', point.label);
        element.textContent = point.count ? String(point.count) : '';
        if (!point.count && element instanceof HTMLButtonElement) element.setAttribute('aria-pressed', String(point.id === selectedId));
        element.dataset['selected'] = point.id === selectedId ? 'true' : 'false';
      }
      for (const [key, marker] of markers.current) {
        if (!seen.has(key)) {
          marker.remove();
          markers.current.delete(key);
        }
      }
    });
  }, [points, selectedId, ready]);
  // The draggable location pin (M-1): pointer drag, or arrow keys while focused.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (pin === null) {
      pinMarker.current?.remove();
      pinMarker.current = null;
      return;
    }
    void import('maplibre-gl').then(({ Marker: MarkerClass }) => {
      if (!pinMarker.current) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = styles.pin ?? '';
        button.textContent = '✚';
        button.addEventListener('keydown', (event) => {
          const step = event.shiftKey ? 50 : 5;
          const delta: Record<string, [number, number]> = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
          const move = delta[event.key];
          if (!move || !pinMarker.current) return;
          event.preventDefault();
          const at = map.project(pinMarker.current.getLngLat());
          const next = map.unproject([at.x + move[0], at.y + move[1]]);
          pinMarker.current.setLngLat(next);
          callbacks.current.onPinMove?.([next.lng, next.lat]);
        });
        pinMarker.current = new MarkerClass({ element: button, draggable: Boolean(callbacks.current.onPinMove), anchor: 'center' }).setLngLat(pin).addTo(map);
        pinMarker.current.on('dragend', () => {
          const at = pinMarker.current?.getLngLat();
          if (at) callbacks.current.onPinMove?.([at.lng, at.lat]);
        });
      }
      pinMarker.current.setLngLat(pin);
      pinMarker.current.getElement().setAttribute('aria-label', pinLabel ?? t('pin'));
    });
  }, [pin, pinLabel, ready, t]);

  useEffect(() => {
    const source = mapRef.current?.getSource<GeoJSONSource>('area');
    if (ready && source) void source.setData(area ? { type: 'FeatureCollection', features: [area] } : EMPTY);
  }, [area, ready]);

  useEffect(() => {
    const source = mapRef.current?.getSource<GeoJSONSource>('draft');
    if (!ready || !source) return;
    const features: Feature[] = draft.map((point) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: point } }));
    if (draft.length > 1) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: draft } });
    void source.setData({ type: 'FeatureCollection', features });
  }, [draft, ready]);

  return (
    <section className={`${styles.frame} ${className ?? ''}`} aria-label={label}>
      <div ref={container} className={styles.canvas} dir="ltr" />
      {!config.tilesUrl ? <p className={styles.noTiles}>{t('noBasemap')}</p> : null}
      {failed ? <p className={styles.noTiles}>{t('mapFailed')}</p> : null}
      {children}
    </section>
  );
});
