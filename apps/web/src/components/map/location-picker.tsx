'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { FieldRow, SelectField, TextField } from '@/components/ui/fields';
import type { CountryDto, GeocodeSuggestionListDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { ApiError } from '@/lib/problem';

import { type LngLat, type MapHandle, MapView } from './map-view';
import styles from './picker.module.css';

export type GeocodeSource = 'manual_pin' | 'geocoder' | 'postcode_centroid' | 'import';
export type GeocodeAccuracy = 'rooftop' | 'street' | 'postcode' | 'locality';

export interface LocationValue {
  latitude: number;
  longitude: number;
  geocodeSource: GeocodeSource;
  geocodeAccuracy: GeocodeAccuracy;
}

/** ADR-006 L-D5: never (0, 0), and inside the country's box when it has one. Checked again by the API. */
export function locationProblem(value: { latitude: number; longitude: number }, country: Pick<CountryDto, 'bounds'> | undefined): 'invalid' | 'outside' | null {
  const { latitude, longitude } = value;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return 'invalid';
  if (latitude === 0 && longitude === 0) return 'invalid';
  const bounds = country?.bounds;
  if (bounds && bounds.length === 4) {
    const [west, south, east, north] = bounds as [number, number, number, number];
    if (latitude < south || latitude > north || longitude < west || longitude > east) return 'outside';
  }
  return null;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

interface LocationPickerProps {
  value: LocationValue | null;
  onChange: (value: LocationValue | null) => void;
  country: CountryDto | undefined;
  /** The address typed in the form, offered as the search text. */
  addressText: string;
  /** Address suggestions need property.create or property.update (API). */
  canSearch: boolean;
  stale: boolean;
  errors: { latitude?: string; longitude?: string };
  latitudeId: string;
}

/**
 * M-1 location picker (ADR-006 L-D2: the user confirms every stored point).
 * Suggestions come from the API's geocoder; the device location is used once
 * and kept only if the form is saved; search text is not stored anywhere.
 */
export function LocationPicker({ value, onChange, country, addressText, canSearch, stale, errors, latitudeId }: LocationPickerProps) {
  const t = useTranslations('location');
  const enums = useTranslations('enums');
  const format = useFormat();
  const map = useRef<MapHandle>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<GeocodeSuggestionListDto['data'] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [latText, setLatText] = useState(value ? String(value.latitude) : '');
  const [lngText, setLngText] = useState(value ? String(value.longitude) : '');
  const [coordError, setCoordError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const suggestionsLabel = useId();

  useEffect(() => {
    setLatText(value ? String(value.latitude) : '');
    setLngText(value ? String(value.longitude) : '');
  }, [value]);

  const place = (next: LocationValue, announce = true) => {
    const problem = locationProblem(next, country);
    if (problem) {
      setCoordError(problem === 'outside' ? t('outsideCountry', { country: country?.name ?? '' }) : t('invalidCoordinates'));
      return;
    }
    setCoordError(null);
    onChange({ ...next, latitude: round(next.latitude), longitude: round(next.longitude) });
    if (announce) setStatus(t('pinPlaced', { lat: format.number(round(next.latitude)), lng: format.number(round(next.longitude)) }));
  };

  const manual = (lngLat: LngLat) => place({ latitude: lngLat[1], longitude: lngLat[0], geocodeSource: 'manual_pin', geocodeAccuracy: value?.geocodeSource === 'manual_pin' ? value.geocodeAccuracy : 'rooftop' });

  const runSearch = async () => {
    const text = (search ?? addressText).trim();
    if (text.length < 3 || !country) return;
    setSearching(true);
    setSearchError(null);
    try {
      const near = value ? `${value.latitude},${value.longitude}` : undefined;
      const result = await bff<GeocodeSuggestionListDto>(`geocoding/suggestions${query({ q: text, countryCode: country.code, language: format.locale.split('-')[0], near })}`);
      setSuggestions(result.data);
    } catch (error) {
      setSuggestions(null);
      if (error instanceof ApiError && error.status === 429) setSearchError(t('tooManySearches', { seconds: error.retryAfter ?? 60 }));
      else setSearchError(t('geocodingUnavailable'));
    } finally {
      setSearching(false);
    }
  };

  const useDevice = () => {
    if (!('geolocation' in navigator)) {
      setCoordError(t('locationDenied'));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const next: LocationValue = { latitude: position.coords.latitude, longitude: position.coords.longitude, geocodeSource: 'manual_pin', geocodeAccuracy: 'rooftop' };
        place(next);
        map.current?.flyTo([next.longitude, next.latitude], 17);
      },
      () => {
        setLocating(false);
        setCoordError(t('locationDenied'));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };

  const applyTyped = () => {
    if (latText.trim() === '' && lngText.trim() === '') return;
    const latitude = Number(latText.replace(',', '.'));
    const longitude = Number(lngText.replace(',', '.'));
    if (latText.trim() === '' || lngText.trim() === '' || Number.isNaN(latitude) || Number.isNaN(longitude)) {
      setCoordError(t('invalidCoordinates'));
      return;
    }
    if (value && latitude === value.latitude && longitude === value.longitude) return;
    place({ latitude, longitude, geocodeSource: 'manual_pin', geocodeAccuracy: value?.geocodeAccuracy ?? 'rooftop' });
    map.current?.flyTo([longitude, latitude], 16);
  };

  const initial = value
    ? { center: [value.longitude, value.latitude] as LngLat, zoom: 16 }
    : country?.bounds && country.bounds.length === 4
      ? { bounds: country.bounds as [number, number, number, number] }
      : { center: [0, 20] as LngLat, zoom: 2 };

  return (
    <div className={styles.picker}>
      {stale ? <Notice tone="warning" title={t('staleNotice')} /> : null}
      {canSearch ? (
        <div className={styles.search}>
          <TextField label={t('findAddress')} value={search ?? addressText} onChange={setSearch} autoComplete="off" />
          <Button onPress={() => void runSearch()} busy={searching}>
            {t('search')}
          </Button>
        </div>
      ) : null}
      {searchError ? <Notice tone="info">{searchError}</Notice> : null}
      {suggestions !== null ? (
        suggestions.length === 0 ? (
          <p className={styles.quiet}>{t('noSuggestions')}</p>
        ) : (
          <fieldset className={styles.suggestions} aria-labelledby={suggestionsLabel}>
            <legend id={suggestionsLabel}>{t('suggestions')}</legend>
            {suggestions.map((suggestion, index) => (
              <label key={`${suggestion.latitude},${suggestion.longitude},${index}`} className={styles.suggestion}>
                <input
                  type="radio"
                  name={suggestionsLabel}
                  checked={value?.geocodeSource === 'geocoder' && value.latitude === round(suggestion.latitude) && value.longitude === round(suggestion.longitude)}
                  onChange={() => {
                    place({ latitude: suggestion.latitude, longitude: suggestion.longitude, geocodeSource: 'geocoder', geocodeAccuracy: suggestion.accuracy });
                    map.current?.flyTo([suggestion.longitude, suggestion.latitude], suggestion.accuracy === 'locality' ? 13 : 17);
                  }}
                />
                <span>
                  <bdi>{suggestion.label}</bdi> <span className={styles.quiet}>({t(`suggestionAccuracy.${suggestion.accuracy}`)})</span>
                </span>
              </label>
            ))}
          </fieldset>
        )
      ) : null}
      <p className={styles.quiet} id={`${latitudeId}-help`}>
        {t('pickerHelp')}
      </p>
      <div className={styles.map}>
        <MapView ref={map} label={t('pickerMap')} initial={initial} pin={value ? [value.longitude, value.latitude] : null} onPinMove={manual} onMapClick={manual} />
      </div>
      <div aria-live="polite" className="ep-visually-hidden">
        {status}
      </div>
      <FieldRow>
        <TextField id={latitudeId} label={t('latitude')} value={latText} onChange={setLatText} inputMode="decimal" dir="ltr" error={errors.latitude} />
        <TextField label={t('longitude')} value={lngText} onChange={setLngText} inputMode="decimal" dir="ltr" error={errors.longitude} />
      </FieldRow>
      <div className={styles.actions}>
        <Button onPress={applyTyped}>{t('applyCoordinates')}</Button>
        <Button onPress={useDevice} busy={locating}>
          {t('useMyLocation')}
        </Button>
        {value ? (
          <Button
            variant="quiet"
            onPress={() => {
              onChange(null);
              setSuggestions(null);
              setStatus(t('noPin'));
            }}
          >
            {t('removeLocation')}
          </Button>
        ) : null}
      </div>
      {coordError ? (
        <p className={styles.error} role="alert">
          {coordError}
        </p>
      ) : null}
      {value ? (
        <FieldRow>
          <p className={styles.found}>
            {t('howFound')}: <strong>{enums(`geocodeSource.${value.geocodeSource}`)}</strong>
          </p>
          <SelectField
            label={t('accuracy')}
            value={value.geocodeAccuracy}
            onChange={(next) => onChange({ ...value, geocodeAccuracy: next as GeocodeAccuracy })}
            options={(['rooftop', 'street', 'postcode', 'locality'] as const).map((id) => ({ id, label: enums(`geocodeAccuracy.${id}`) }))}
          />
        </FieldRow>
      ) : (
        <p className={styles.quiet}>{t('noPin')}</p>
      )}
    </div>
  );
}
