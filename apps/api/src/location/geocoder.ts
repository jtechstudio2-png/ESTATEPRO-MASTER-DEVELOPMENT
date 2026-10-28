import type { AppConfig } from '../config/config.js';

export const GEOCODER = Symbol('GEOCODER');

export type GeocodeAccuracy = 'rooftop' | 'street' | 'postcode' | 'locality';

export interface GeocodeSuggestion {
  label: string;
  latitude: number;
  longitude: number;
  accuracy: GeocodeAccuracy;
}

export interface GeocodeQuery {
  text: string;
  countryCode: string;
  /** Bias results towards this point (for example the office). */
  proximity: { latitude: number; longitude: number } | null;
  language: string | null;
  limit: number;
}

/** Address suggestions only: a user confirms every stored location (ADR-006 L-D2). */
export interface GeocoderPort {
  readonly enabled: boolean;
  suggest(query: GeocodeQuery): Promise<GeocodeSuggestion[]>;
}

/** Raised when the provider cannot answer (timeout, outage, bad credentials). */
export class GeocoderUnavailableError extends Error {}

export class DisabledGeocoder implements GeocoderPort {
  readonly enabled = false;

  suggest(): Promise<GeocodeSuggestion[]> {
    return Promise.reject(new GeocoderUnavailableError('geocoding is not configured'));
  }
}

interface MapboxFeature {
  geometry?: { type?: string; coordinates?: unknown };
  properties?: {
    feature_type?: string;
    full_address?: string;
    name?: string;
    place_formatted?: string;
    coordinates?: { accuracy?: string };
  };
}

/**
 * Mapbox Geocoding API v6, forward search with permanent=true: results may be
 * stored once the user confirms them (temporary results may not).
 */
export class MapboxGeocoder implements GeocoderPort {
  readonly enabled = true;

  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async suggest(query: GeocodeQuery): Promise<GeocodeSuggestion[]> {
    const url = new URL('/search/geocode/v6/forward', this.baseUrl);
    url.searchParams.set('q', query.text);
    url.searchParams.set('country', query.countryCode.toLowerCase());
    url.searchParams.set('permanent', 'true');
    url.searchParams.set('autocomplete', 'true');
    url.searchParams.set('limit', String(query.limit));
    if (query.proximity) url.searchParams.set('proximity', `${query.proximity.longitude},${query.proximity.latitude}`);
    if (query.language) url.searchParams.set('language', query.language);
    url.searchParams.set('access_token', this.accessToken);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: 'application/json' } });
    } catch (error) {
      throw new GeocoderUnavailableError(`geocoder request failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    if (!response.ok) {
      // The URL carries the token, so it is never included in errors or logs.
      throw new GeocoderUnavailableError(`geocoder answered ${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GeocoderUnavailableError('geocoder returned an unreadable response');
    }
    const features = (body as { features?: unknown }).features;
    if (!Array.isArray(features)) throw new GeocoderUnavailableError('geocoder returned an unexpected response');
    return features.flatMap((feature) => {
      const suggestion = toSuggestion(feature as MapboxFeature);
      return suggestion ? [suggestion] : [];
    });
  }
}

function toSuggestion(feature: MapboxFeature): GeocodeSuggestion | null {
  const coordinates = feature.geometry?.coordinates;
  if (feature.geometry?.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [longitude, latitude] = coordinates as [unknown, unknown];
  if (typeof longitude !== 'number' || typeof latitude !== 'number' || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const properties = feature.properties ?? {};
  const label =
    properties.full_address ?? [properties.name, properties.place_formatted].filter((part) => typeof part === 'string' && part.length > 0).join(', ');
  if (!label) return null;
  return {
    label: label.slice(0, 300),
    latitude: Math.round(latitude * 1e6) / 1e6,
    longitude: Math.round(longitude * 1e6) / 1e6,
    accuracy: accuracyOf(properties.feature_type, properties.coordinates?.accuracy),
  };
}

/** Maps Mapbox feature types and coordinate accuracy to EstatePro's four levels. */
export function accuracyOf(featureType: string | undefined, coordinateAccuracy: string | undefined): GeocodeAccuracy {
  switch (featureType) {
    case 'address':
      return coordinateAccuracy === 'rooftop' || coordinateAccuracy === 'parcel' || coordinateAccuracy === 'point' ? 'rooftop' : 'street';
    case 'street':
      return 'street';
    case 'postcode':
      return 'postcode';
    default:
      return 'locality';
  }
}

export function geocoderFromConfig(config: AppConfig): GeocoderPort {
  if (config.GEOCODER_PROVIDER === 'mapbox' && config.MAPBOX_ACCESS_TOKEN !== undefined) {
    return new MapboxGeocoder(config.MAPBOX_API_URL, config.MAPBOX_ACCESS_TOKEN, config.GEOCODER_TIMEOUT_MS);
  }
  return new DisabledGeocoder();
}
