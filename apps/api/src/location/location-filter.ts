import { type RawBuilder, sql } from 'kysely';

import type { FilterSpec, ParsedFilters } from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { Tx } from '../database/database.module.js';

/**
 * Location filters shared by the property and listing lists and their map
 * endpoints (ADR-006 L-D4). Coordinates are WGS 84 decimal degrees.
 *
 *   filter[near]=lat,lng & filter[radius]=metres   circle, radius 1 m – 50 km
 *   filter[bbox]=west,south,east,north              map viewport
 *   filter[polygon]=lng lat,lng lat,…               3–100 points, closed automatically
 *   filter[hasLocation]=true|false
 *   filter[locality]=Accra,Tema                     case-insensitive, exact
 *   filter[adminArea1]=Greater Accra
 *
 * Viewport and polygon edges are straight lines in latitude/longitude, as they
 * are drawn on the map; the radius is measured in metres on the spheroid.
 */

export const MAX_RADIUS_METRES = 50_000;
export const MAX_POLYGON_POINTS = 100;
/** Largest viewport side, in degrees (a whole country such as the UK fits). */
export const MAX_BBOX_SPAN_DEGREES = 30;
/** Largest polygon, in square kilometres. */
export const MAX_POLYGON_AREA_KM2 = 25_000;

const DECIMAL = String.raw`-?\d{1,3}(?:\.\d{1,8})?`;
const PLACE_NAME = /^[\p{L}\p{M}\p{N} .'’()&/-]{1,120}$/u;

export const LOCATION_FILTERS: FilterSpec = {
  near: { type: 'code', pattern: new RegExp(`^${DECIMAL},${DECIMAL}$`) },
  radius: { type: 'code', pattern: /^\d{1,6}$/ },
  bbox: { type: 'code', pattern: new RegExp(`^${DECIMAL}(?:,${DECIMAL}){3}$`) },
  polygon: { type: 'code', pattern: new RegExp(`^${DECIMAL} ${DECIMAL}(?:, ?${DECIMAL} ${DECIMAL}){2,${MAX_POLYGON_POINTS}}$`) },
  hasLocation: { type: 'boolean' },
  locality: { type: 'code', pattern: PLACE_NAME, multi: true },
  adminArea1: { type: 'code', pattern: PLACE_NAME, multi: true },
};

export interface Point {
  latitude: number;
  longitude: number;
}

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface LocationFilter {
  near: (Point & { radius: number }) | null;
  bbox: BoundingBox | null;
  /** Closed ring of [longitude, latitude] pairs. */
  polygon: Array<[number, number]> | null;
  hasLocation: boolean | null;
  localities: string[] | null;
  adminAreas: string[] | null;
}

export const NO_LOCATION_FILTER: LocationFilter = Object.freeze({
  near: null,
  bbox: null,
  polygon: null,
  hasLocation: null,
  localities: null,
  adminAreas: null,
});

/** True when any location filter was given (the list then joins addresses). */
export function hasLocationFilter(filter: LocationFilter): boolean {
  return (
    filter.near !== null ||
    filter.bbox !== null ||
    filter.polygon !== null ||
    filter.hasLocation !== null ||
    filter.localities !== null ||
    filter.adminAreas !== null
  );
}

function single(filters: ParsedFilters, key: string): string | null {
  const value = filters[key];
  return Array.isArray(value) ? (value[0] ?? null) : null;
}

const inRange = (value: number, limit: number) => Number.isFinite(value) && Math.abs(value) <= limit;

/** Validates the location filters already matched by LOCATION_FILTERS patterns. */
export function parseLocationFilter(filters: ParsedFilters): LocationFilter {
  const errors: FieldError[] = [];
  const result: LocationFilter = { near: null, bbox: null, polygon: null, hasLocation: null, localities: null, adminAreas: null };

  const near = single(filters, 'near');
  const radius = single(filters, 'radius');
  if ((near === null) !== (radius === null)) {
    errors.push({
      field: near === null ? 'filter[near]' : 'filter[radius]',
      code: 'pair',
      message: 'Give filter[near] (latitude,longitude) and filter[radius] (metres) together.',
    });
  } else if (near !== null && radius !== null) {
    const [latitude, longitude] = near.split(',').map(Number) as [number, number];
    const metres = Number(radius);
    if (!inRange(latitude, 90) || !inRange(longitude, 180)) {
      errors.push({ field: 'filter[near]', code: 'invalid-coordinates', message: 'Use latitude,longitude in decimal degrees.' });
    }
    if (metres < 1 || metres > MAX_RADIUS_METRES) {
      errors.push({ field: 'filter[radius]', code: 'radius-too-large', message: `Use a radius from 1 to ${MAX_RADIUS_METRES} metres.` });
    }
    result.near = { latitude, longitude, radius: metres };
  }

  const bbox = single(filters, 'bbox');
  if (bbox !== null) {
    const [west, south, east, north] = bbox.split(',').map(Number) as [number, number, number, number];
    if (!inRange(west, 180) || !inRange(east, 180) || !inRange(south, 90) || !inRange(north, 90) || west >= east || south >= north) {
      errors.push({
        field: 'filter[bbox]',
        code: 'invalid-bbox',
        message: 'Use west,south,east,north in decimal degrees, with west < east and south < north.',
      });
    } else if (east - west > MAX_BBOX_SPAN_DEGREES || north - south > MAX_BBOX_SPAN_DEGREES) {
      errors.push({ field: 'filter[bbox]', code: 'area-too-large', message: `Zoom in: the map area may span at most ${MAX_BBOX_SPAN_DEGREES} degrees.` });
    }
    result.bbox = { west, south, east, north };
  }

  const polygon = single(filters, 'polygon');
  if (polygon !== null) {
    const points = polygon.split(',').map((pair) => pair.trim().split(' ').map(Number) as [number, number]);
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]]);
    if (points.some(([lng, lat]) => !inRange(lng, 180) || !inRange(lat, 90))) {
      errors.push({ field: 'filter[polygon]', code: 'invalid-polygon', message: 'Use "longitude latitude" pairs in decimal degrees.' });
    } else if (points.length - 1 < 3 || points.length - 1 > MAX_POLYGON_POINTS) {
      errors.push({ field: 'filter[polygon]', code: 'invalid-polygon', message: `Draw a shape with 3 to ${MAX_POLYGON_POINTS} points.` });
    }
    result.polygon = points;
  }

  if (typeof filters['hasLocation'] === 'boolean') result.hasLocation = filters['hasLocation'];
  if (result.hasLocation === false && (result.near || result.bbox || result.polygon)) {
    errors.push({ field: 'filter[hasLocation]', code: 'conflict', message: 'Records without a location cannot match a map area.' });
  }
  const localities = filters['locality'];
  if (Array.isArray(localities)) result.localities = localities.map((value) => value.toLowerCase());
  const adminAreas = filters['adminArea1'];
  if (Array.isArray(adminAreas)) result.adminAreas = adminAreas.map((value) => value.toLowerCase());

  if (errors.length > 0) throw Problems.validation(errors);
  return result;
}

/**
 * Rejects self-intersecting or oversized polygons with a field error (the
 * search would otherwise silently return nothing or scan a whole country).
 */
export async function assertUsablePolygon(tx: Tx, filter: LocationFilter): Promise<void> {
  if (filter.polygon === null) return;
  const { rows } = await sql<{ valid: boolean; areaKm2: number }>`
    select ST_IsValid(g) as valid, ST_Area(g::geography) / 1e6 as "areaKm2" from (select ${polygonGeometry(filter.polygon)} as g) s`.execute(tx);
  const row = rows[0]!;
  if (!row.valid) {
    throw Problems.validation([{ field: 'filter[polygon]', code: 'invalid-polygon', message: 'The shape crosses itself. Redraw it.' }]);
  }
  if (row.areaKm2 > MAX_POLYGON_AREA_KM2) {
    throw Problems.validation([
      { field: 'filter[polygon]', code: 'area-too-large', message: `Draw a smaller shape (at most ${MAX_POLYGON_AREA_KM2} km²).` },
    ]);
  }
}

function polygonGeometry(ring: Array<[number, number]>): RawBuilder<unknown> {
  const wkt = `POLYGON((${ring.map(([lng, lat]) => `${lng} ${lat}`).join(',')}))`;
  // Bound as a parameter; the text is built only from validated numbers.
  return sql`ST_GeomFromText(${wkt}, 4326)`;
}

export function pointGeography(point: Point): RawBuilder<unknown> {
  return sql`ST_SetSRID(ST_MakePoint(${point.longitude}::float8, ${point.latitude}::float8), 4326)::geography`;
}

/**
 * Conditions on an `addresses` alias. Each shape has an index-assisted test on
 * the geography column (the shape densified so its bounding box follows the
 * map's straight edges), then the exact test.
 */
export function locationConditions(filter: LocationFilter, alias: string): Array<RawBuilder<boolean>> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  const conditions: Array<RawBuilder<boolean>> = [];
  if (filter.near) {
    conditions.push(sql<boolean>`ST_DWithin(${column('location')}, ${pointGeography(filter.near)}, ${filter.near.radius}::float8)`);
  }
  if (filter.bbox) {
    const { west, south, east, north } = filter.bbox;
    conditions.push(sql<boolean>`${column('location')} && ST_Segmentize(ST_MakeEnvelope(${west}::float8, ${south}::float8, ${east}::float8, ${north}::float8, 4326), 0.05)::geography
      and ${column('latitude')} between ${south} and ${north} and ${column('longitude')} between ${west} and ${east}`);
  }
  if (filter.polygon) {
    const shape = polygonGeometry(filter.polygon);
    conditions.push(sql<boolean>`${column('location')} && ST_Segmentize(${shape}, 0.05)::geography
      and ST_Covers(${shape}, ${column('location')}::geometry)`);
  }
  if (filter.hasLocation !== null) {
    conditions.push(filter.hasLocation ? sql<boolean>`${column('location')} is not null` : sql<boolean>`${column('location')} is null`);
  }
  if (filter.localities) conditions.push(sql<boolean>`lower(${column('locality')}) = any(${filter.localities}::text[])`);
  if (filter.adminAreas) conditions.push(sql<boolean>`lower(${column('adminArea1')}) = any(${filter.adminAreas}::text[])`);
  return conditions;
}

/** Distance in metres from the search centre, rounded to 0.1 m (sort and cursor value). */
export function distanceSql(filter: LocationFilter, alias: string): RawBuilder<string> {
  if (!filter.near) throw Problems.internal();
  return sql<string>`round(ST_Distance(${sql.ref(`${alias}.location`)}, ${pointGeography(filter.near)})::numeric, 1)`;
}

/** sort=distance needs a centre; called by both lists. */
export function assertDistanceSort(sortField: string, filter: LocationFilter): void {
  if (sortField === 'distance' && filter.near === null) {
    throw Problems.validation([
      { field: 'sort', code: 'distance-sort-needs-near', message: 'Sort by distance only with filter[near] and filter[radius].' },
    ]);
  }
}

/**
 * Settings for one location search, local to the request transaction: a time
 * cap, and no JIT compilation (it costs more than these short queries take).
 */
export async function configureSearchTransaction(tx: Tx, milliseconds: number): Promise<void> {
  await sql`select set_config('statement_timeout', ${String(milliseconds)}, true), set_config('jit', 'off', true)`.execute(tx);
}
