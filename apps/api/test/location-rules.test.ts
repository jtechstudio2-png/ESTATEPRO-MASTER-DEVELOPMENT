import { describe, expect, it } from 'vitest';

import { withoutSearchText } from '../src/app.module.js';
import { ConfigError, loadConfig } from '../src/config/config.js';
import { accuracyOf, DisabledGeocoder, geocoderFromConfig, GeocoderUnavailableError, MapboxGeocoder } from '../src/location/geocoder.js';
import { hasLocationFilter, NO_LOCATION_FILTER, parseLocationFilter } from '../src/location/location-filter.js';
import { RateLimiter } from '../src/location/rate-limiter.js';
import { checkCoordinates } from '../src/reference/address.js';

const baseEnv = {
  DATABASE_URL: 'postgres://a:b@localhost/db',
  AUTH_DATABASE_URL: 'postgres://a:b@localhost/db',
  OIDC_ISSUER: 'https://idp.example/',
  OIDC_AUDIENCE: 'api',
  OIDC_JWKS_URL: 'https://idp.example/jwks',
  OIDC_PROVIDER: 'example-idp',
  STORAGE_BUCKET: 'estatepro-media',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
};

describe('geocoder configuration (L-D2)', () => {
  it('is off by default and needs a token for Mapbox', () => {
    const config = loadConfig(baseEnv);
    expect(config).toMatchObject({ GEOCODER_PROVIDER: 'none', MAPBOX_API_URL: 'https://api.mapbox.com', SEARCH_STATEMENT_TIMEOUT_MS: 5_000 });
    expect(geocoderFromConfig(config)).toBeInstanceOf(DisabledGeocoder);
    expect(() => loadConfig({ ...baseEnv, GEOCODER_PROVIDER: 'mapbox' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...baseEnv, GEOCODER_PROVIDER: 'mapbox' })).toThrow(/MAPBOX_ACCESS_TOKEN/);
    expect(geocoderFromConfig(loadConfig({ ...baseEnv, GEOCODER_PROVIDER: 'mapbox', MAPBOX_ACCESS_TOKEN: 'pk.x' }))).toBeInstanceOf(MapboxGeocoder);
  });

  it('maps Mapbox feature types to four accuracy levels', () => {
    expect(accuracyOf('address', 'rooftop')).toBe('rooftop');
    expect(accuracyOf('address', 'parcel')).toBe('rooftop');
    expect(accuracyOf('address', 'interpolated')).toBe('street');
    expect(accuracyOf('street', undefined)).toBe('street');
    expect(accuracyOf('postcode', undefined)).toBe('postcode');
    expect(accuracyOf('neighborhood', undefined)).toBe('locality');
    expect(accuracyOf(undefined, undefined)).toBe('locality');
  });

  it('turns network failures into an unavailable error without leaking the URL', async () => {
    const failing = new MapboxGeocoder('https://api.mapbox.com', 'pk.secret', 1_000, () => Promise.reject(new TypeError('fetch failed')));
    const error = await failing.suggest({ text: 'Osu', countryCode: 'GH', proximity: null, language: null, limit: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeocoderUnavailableError);
    expect(String(error)).not.toContain('pk.secret');
    await expect(new DisabledGeocoder().suggest()).rejects.toBeInstanceOf(GeocoderUnavailableError);
  });
});

describe('location filter parsing (L-D4)', () => {
  it('parses each shape', () => {
    const filter = parseLocationFilter({
      near: ['5.5571,-0.1818'],
      radius: ['2500'],
      bbox: ['-0.35,5.45,0.05,5.75'],
      polygon: ['-0.25 5.50,-0.10 5.50,-0.17 5.70,-0.25 5.50'],
      hasLocation: true,
      locality: ['Accra', 'TEMA'],
      adminArea1: ['Greater Accra'],
    });
    expect(filter).toEqual({
      near: { latitude: 5.5571, longitude: -0.1818, radius: 2500 },
      bbox: { west: -0.35, south: 5.45, east: 0.05, north: 5.75 },
      polygon: [
        [-0.25, 5.5],
        [-0.1, 5.5],
        [-0.17, 5.7],
        [-0.25, 5.5],
      ],
      hasLocation: true,
      localities: ['accra', 'tema'],
      adminAreas: ['greater accra'],
    });
    expect(hasLocationFilter(filter)).toBe(true);
    expect(hasLocationFilter(NO_LOCATION_FILTER)).toBe(false);
    expect(hasLocationFilter(parseLocationFilter({ archived: 'false' }))).toBe(false);
  });

  it('closes open polygons and rejects out-of-range points', () => {
    expect(parseLocationFilter({ polygon: ['-0.25 5.5,-0.1 5.5,-0.17 5.7'] }).polygon).toHaveLength(4);
    expect(() => parseLocationFilter({ polygon: ['-200 5.5,-0.1 5.5,-0.17 5.7'] })).toThrow();
    expect(() => parseLocationFilter({ bbox: ['-0.35,95,0.05,96'] })).toThrow();
    expect(() => parseLocationFilter({ near: ['5.5,-0.1'], radius: ['0'] })).toThrow();
  });
});

describe('coordinate checks (L-D5)', () => {
  const ghana = { name: 'Ghana', boundsSouth: '4.65', boundsWest: '-3.31', boundsNorth: '11.22', boundsEast: '1.25' };

  it('accepts points in the country and rejects 0,0 and points outside', () => {
    expect(checkCoordinates(ghana, 5.6, -0.2, 'address')).toEqual([]);
    expect(checkCoordinates(ghana, 0, 0, 'address')[0]?.code).toBe('invalid-coordinates');
    expect(checkCoordinates(ghana, 51.5, -0.12, 'address')[0]?.code).toBe('outside-country');
  });

  it('skips the box check for countries without bounds', () => {
    expect(checkCoordinates({ name: 'Elsewhere', boundsSouth: null, boundsWest: null, boundsNorth: null, boundsEast: null }, 40, 10, 'a')).toEqual([]);
  });
});

describe('rate limiter', () => {
  it('allows the limit per minute, then answers 429 with the seconds left', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(() => now);
    limiter.take('k', 2);
    limiter.take('k', 2);
    expect(() => limiter.take('k', 2)).toThrow(expect.objectContaining({ status: 429, headers: { 'Retry-After': '60' } }));
    now += 45_500;
    expect(() => limiter.take('k', 2)).toThrow(expect.objectContaining({ headers: { 'Retry-After': '15' } }));
    limiter.take('other', 2);
    now += 15_000;
    limiter.take('k', 2);
  });

  it('sweeps expired windows when many keys accumulate', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 10_000; i += 1) limiter.take(`key-${i}`, 1);
    now = 61_000;
    limiter.take('fresh', 1);
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.size).toBe(1);
  });
});

describe('request logging', () => {
  it('drops the query string of geocoding requests only', () => {
    expect(withoutSearchText('/api/v1/geocoding/suggestions?q=12%20Oxford%20St&countryCode=GH')).toBe('/api/v1/geocoding/suggestions');
    expect(withoutSearchText('/api/v1/properties?filter[locality]=Accra')).toBe('/api/v1/properties?filter[locality]=Accra');
    expect(withoutSearchText(undefined)).toBeUndefined();
  });
});
