'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { RadioGroupField, SelectField, TextField } from '@/components/ui/fields';
import { formClass } from '@/components/ui/layout';
import type { PropertyPageDto } from '@/lib/api-schema';
import { bff, query } from '@/lib/bff';
import { useFormat } from '@/lib/hooks/format';
import { useListParams } from '@/lib/hooks/list-params';

const RADII = [500, 1000, 2000, 5000, 10000, 20000, 50000];

/** "Within 2 km of Osu Court" (UI checklist §2): the chip text for a near/radius filter. */
export function useLocationChip(): { label: string; clear: () => void } | null {
  const t = useTranslations('location');
  const format = useFormat();
  const params = useListParams();
  const near = params.get('filter[near]');
  const polygon = params.get('filter[polygon]');
  if (polygon) return { label: t('insideArea'), clear: () => params.set({ 'filter[polygon]': null, sort: params.get('sort') === 'distance' ? null : params.get('sort') }) };
  if (!near) return null;
  const radius = Number(params.get('filter[radius]') ?? 2000);
  const place = params.get('nearLabel');
  return {
    label: place ? t('withinRadius', { distance: format.distance(radius), place }) : t('withinRadiusPoint', { distance: format.distance(radius) }),
    clear: () => params.set({ 'filter[near]': null, 'filter[radius]': null, nearLabel: null, sort: params.get('sort') === 'distance' ? null : params.get('sort') }),
  };
}

/**
 * LocationFilter (L-1, P-1): near a property or the device position, within a
 * radius (0.5–50 km, ADR-006). Drawing an area is on the map (M-2, M-3).
 */
export function LocationFilter() {
  const t = useTranslations('location');
  const common = useTranslations('common');
  const format = useFormat();
  const params = useListParams();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'property' | 'device'>('property');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<{ label: string; lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState(params.get('filter[radius]') ?? '2000');
  const [locating, setLocating] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const places = useQuery({
    queryKey: ['location-filter-places', search],
    queryFn: () => bff<PropertyPageDto>(`properties${query({ q: search, 'filter[hasLocation]': 'true', limit: 8 })}`),
    enabled: open && mode === 'property' && search.trim().length >= 2,
  });

  const apply = (point: { label: string; lat: number; lng: number }) => {
    params.set({ 'filter[near]': `${point.lat},${point.lng}`, 'filter[radius]': radius, nearLabel: point.label || null, 'filter[polygon]': null, sort: 'distance' });
    setOpen(false);
  };

  const useDevice = () => {
    setLocating(true);
    setDeviceError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        apply({ label: '', lat: Math.round(position.coords.latitude * 1e6) / 1e6, lng: Math.round(position.coords.longitude * 1e6) / 1e6 });
      },
      () => {
        setLocating(false);
        setDeviceError(t('locationDenied'));
      },
      { timeout: 15_000, maximumAge: 60_000 },
    );
  };

  return (
    <>
      <div>
        <Button onPress={() => setOpen(true)} aria-haspopup="dialog">
          {t('radius')}
          <span aria-hidden="true"> ▾</span>
        </Button>
      </div>
      <Dialog
        isOpen={open}
        onOpenChange={setOpen}
        title={t('radiusTool')}
        footer={
          <>
            <Button onPress={() => setOpen(false)}>{common('cancel')}</Button>
            {mode === 'property' ? (
              <Button variant="primary" isDisabled={chosen === null} onPress={() => chosen && apply(chosen)}>
                {common('apply')}
              </Button>
            ) : (
              <Button variant="primary" onPress={useDevice} busy={locating}>
                {t('useMyLocation')}
              </Button>
            )}
          </>
        }
      >
        <div className={formClass}>
          <RadioGroupField
            label={t('areaTools')}
            value={mode}
            onChange={(value) => setMode(value as 'property' | 'device')}
            options={[
              { id: 'property', label: t('nearProperty') },
              { id: 'device', label: t('nearMe') },
            ]}
          />
          <SelectField label={t('radiusSize')} value={radius} onChange={setRadius} options={RADII.map((value) => ({ id: String(value), label: format.distance(value) }))} />
          {mode === 'property' ? (
            <>
              <TextField label={t('placeSearch')} value={search} onChange={setSearch} autoComplete="off" />
              <ul aria-label={t('suggestions')} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {(places.data?.data ?? [])
                  .filter((place) => place.latitude !== null && place.longitude !== null)
                  .map((place) => {
                    const label = place.name ?? place.reference;
                    const selected = chosen?.label === label;
                    return (
                      <li key={place.id}>
                        <Button variant={selected ? 'primary' : 'quiet'} aria-pressed={selected} onPress={() => setChosen({ label, lat: place.latitude!, lng: place.longitude! })}>
                          <bdi>{label}</bdi>
                          {place.formattedAddress ? (
                            <span>
                              {' · '}
                              <bdi>{place.formattedAddress}</bdi>
                            </span>
                          ) : null}
                        </Button>
                      </li>
                    );
                  })}
              </ul>
            </>
          ) : deviceError ? (
            <p role="alert">{deviceError}</p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
