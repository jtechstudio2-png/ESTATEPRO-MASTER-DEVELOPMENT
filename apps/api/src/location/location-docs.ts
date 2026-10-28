import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';

import { MAX_POLYGON_POINTS, MAX_RADIUS_METRES } from './location-filter.js';

/** OpenAPI documentation of the shared location filters (ADR-006 L-D4). */
export function LocationQueryDocs(): MethodDecorator {
  return applyDecorators(
    ApiQuery({ name: 'filter[near]', required: false, description: 'Centre for a radius search: latitude,longitude' }),
    ApiQuery({ name: 'filter[radius]', required: false, description: `Radius in metres (1–${MAX_RADIUS_METRES}); with filter[near]` }),
    ApiQuery({ name: 'filter[bbox]', required: false, description: 'Map viewport: west,south,east,north' }),
    ApiQuery({
      name: 'filter[polygon]',
      required: false,
      description: `Area drawn on the map: "longitude latitude" pairs separated by commas, 3–${MAX_POLYGON_POINTS} points`,
    }),
    ApiQuery({ name: 'filter[hasLocation]', required: false, enum: ['true', 'false'] }),
    ApiQuery({ name: 'filter[locality]', required: false, description: 'Comma-separated town or city names (case-insensitive)' }),
    ApiQuery({ name: 'filter[adminArea1]', required: false, description: 'Comma-separated regions (case-insensitive)' }),
  );
}
