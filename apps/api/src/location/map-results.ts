import { ApiProperty } from '@nestjs/swagger';
import { type SelectQueryBuilder, sql } from 'kysely';

import { Problems } from '../common/problem.js';
import type { Tx } from '../database/database.module.js';
import type { BoundingBox, LocationFilter } from './location-filter.js';

/** Above this many matches the map shows clusters instead of points (ADR-006 L-D4). */
export const MAP_POINT_LIMIT = 500;
/** Cluster grid over the viewport: at most GRID × GRID cells. */
const GRID = 32;

export class MapClusterDto {
  @ApiProperty({ description: 'Records in this cell' }) count!: number;
  @ApiProperty({ description: 'Average position of the records' }) latitude!: number;
  @ApiProperty() longitude!: number;
  @ApiProperty({ type: [Number], description: 'west, south, east, north of the records in the cell (zoom here to expand)' })
  bounds!: [number, number, number, number];
}

export interface MapResult<P> {
  total: number;
  clustered: boolean;
  points: P[];
  clusters: MapClusterDto[];
}

/** The map endpoints always need a viewport. */
export function requireViewport(filter: LocationFilter): BoundingBox {
  if (filter.bbox === null) {
    throw Problems.validation([{ field: 'filter[bbox]', code: 'required', message: 'Give the map area as filter[bbox]=west,south,east,north.' }]);
  }
  return filter.bbox;
}

/**
 * Returns the matching records as points, or grid clusters when more than
 * MAP_POINT_LIMIT match. `points` selects the details shown on the map;
 * `positions` is the same scoped, filtered set with only latitude and
 * longitude, so clustering does not compute details for every record.
 */
export async function mapResult<
  D,
  T extends keyof D,
  R extends { latitude: string | null; longitude: string | null },
  D2,
  T2 extends keyof D2,
  P,
>(
  tx: Tx,
  points: SelectQueryBuilder<D, T, R>,
  positions: SelectQueryBuilder<D2, T2, { latitude: string | null; longitude: string | null }>,
  bbox: BoundingBox,
  toPoint: (row: R) => P,
): Promise<MapResult<P>> {
  // Cluster first: one lean pass over positions decides between points and clusters.
  const cellWidth = (bbox.east - bbox.west) / GRID;
  const cellHeight = (bbox.north - bbox.south) / GRID;
  const { rows: cells } = await sql<{
    count: number;
    latitude: string;
    longitude: string;
    west: string;
    south: string;
    east: string;
    north: string;
  }>`
    select count(*)::int as count,
           round(avg(latitude), 6) as latitude, round(avg(longitude), 6) as longitude,
           min(longitude) as west, min(latitude) as south, max(longitude) as east, max(latitude) as north
      from (${positions}) as pts
     group by least(floor((longitude - ${bbox.west}) / ${cellWidth}), ${GRID - 1}),
              least(floor((latitude - ${bbox.south}) / ${cellHeight}), ${GRID - 1})
     order by count desc`.execute(tx);
  const total = cells.reduce((sum, cell) => sum + cell.count, 0);
  if (total <= MAP_POINT_LIMIT) {
    const rows = total === 0 ? [] : await points.limit(MAP_POINT_LIMIT).execute();
    return { total: rows.length, clustered: false, points: rows.map(toPoint), clusters: [] };
  }
  const clusters = cells.map((cell) => ({
    count: cell.count,
    latitude: Number(cell.latitude),
    longitude: Number(cell.longitude),
    bounds: [Number(cell.west), Number(cell.south), Number(cell.east), Number(cell.north)] as [number, number, number, number],
  }));
  return { total, clustered: true, points: [], clusters };
}
