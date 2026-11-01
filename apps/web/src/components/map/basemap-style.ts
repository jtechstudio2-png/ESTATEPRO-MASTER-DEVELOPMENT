import type { StyleSpecification } from 'maplibre-gl';

/**
 * The basemap style (W-D4): self-hosted OpenStreetMap vector tiles in the
 * Protomaps basemap schema (layers earth, water, landuse, roads, buildings,
 * boundaries, places), read from one PMTiles archive. Without a tiles URL
 * the map is a plain background, so pins and areas still work everywhere.
 * Labels prefer the interface language and fall back to the local name.
 */
export const COLOURS = {
  background: '#eef2f6',
  earth: '#f5f7fa',
  water: '#b9d3e8',
  park: '#d9ead3',
  building: '#e3e8ef',
  roadMinor: '#ffffff',
  roadMajor: '#fbe7b2',
  roadCasing: '#d7dee7',
  boundary: '#9aa7b6',
  label: '#17212f',
  labelHalo: '#ffffff',
} as const;

export const ATTRIBUTION = '© OpenStreetMap contributors';

export function basemapStyle(options: { tilesUrl: string; glyphsUrl: string; language: string }): StyleSpecification {
  if (!options.tilesUrl) {
    return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': COLOURS.background } }] };
  }
  const source = 'basemap';
  const name = ['coalesce', ['get', `name:${options.language}`], ['get', 'name']] as unknown as string;
  const style: StyleSpecification = {
    version: 8,
    sources: {
      [source]: { type: 'vector', url: `pmtiles://${options.tilesUrl}`, attribution: ATTRIBUTION },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': COLOURS.background } },
      { id: 'earth', type: 'fill', source, 'source-layer': 'earth', paint: { 'fill-color': COLOURS.earth } },
      {
        id: 'parks',
        type: 'fill',
        source,
        'source-layer': 'landuse',
        filter: ['in', ['get', 'kind'], ['literal', ['park', 'forest', 'wood', 'nature_reserve', 'grass', 'golf_course']]],
        paint: { 'fill-color': COLOURS.park },
      },
      { id: 'water', type: 'fill', source, 'source-layer': 'water', paint: { 'fill-color': COLOURS.water } },
      { id: 'buildings', type: 'fill', source, 'source-layer': 'buildings', minzoom: 14, paint: { 'fill-color': COLOURS.building, 'fill-outline-color': COLOURS.roadCasing } },
      {
        id: 'roads-casing',
        type: 'line',
        source,
        'source-layer': 'roads',
        filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
        paint: { 'line-color': COLOURS.roadCasing, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 1.5, 18, 22] },
      },
      {
        id: 'roads-minor',
        type: 'line',
        source,
        'source-layer': 'roads',
        minzoom: 12,
        filter: ['in', ['get', 'kind'], ['literal', ['minor_road', 'other']]],
        paint: { 'line-color': COLOURS.roadMinor, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.5, 18, 12] },
      },
      {
        id: 'roads-major',
        type: 'line',
        source,
        'source-layer': 'roads',
        filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
        paint: { 'line-color': COLOURS.roadMajor, 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 1, 18, 18] },
      },
      {
        id: 'boundaries',
        type: 'line',
        source,
        'source-layer': 'boundaries',
        filter: ['<=', ['get', 'kind_detail'], 4],
        paint: { 'line-color': COLOURS.boundary, 'line-dasharray': [3, 2], 'line-width': 1 },
      },
    ],
  };
  if (options.glyphsUrl) {
    style.glyphs = options.glyphsUrl;
    style.layers.push(
      {
        id: 'road-labels',
        type: 'symbol',
        source,
        'source-layer': 'roads',
        minzoom: 14,
        layout: { 'symbol-placement': 'line', 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
        paint: { 'text-color': COLOURS.label, 'text-halo-color': COLOURS.labelHalo, 'text-halo-width': 1.5 },
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source,
        'source-layer': 'places',
        filter: ['in', ['get', 'kind'], ['literal', ['locality', 'neighbourhood', 'macrohood', 'region', 'country']]],
        layout: {
          'text-field': name,
          'text-font': ['Noto Sans Medium'],
          'text-size': ['match', ['get', 'kind'], 'country', 16, 'region', 14, 'locality', 14, 12],
        },
        paint: { 'text-color': COLOURS.label, 'text-halo-color': COLOURS.labelHalo, 'text-halo-width': 1.5 },
      },
    );
  }
  return style;
}
