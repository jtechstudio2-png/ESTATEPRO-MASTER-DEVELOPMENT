'use client';

import { useTranslations } from 'next-intl';

import { MapView } from './map-view';

/** P-2 mini map: our own tiles, no interaction, the property as one marker. */
export function MiniMap({ latitude, longitude, label }: { latitude: number; longitude: number; label: string }) {
  const t = useTranslations('location');
  return (
    <div style={{ blockSize: 200 }}>
      <MapView
        label={`${t('map')}: ${label}`}
        initial={{ center: [longitude, latitude], zoom: 15 }}
        points={[{ id: 'self', lng: longitude, lat: latitude, label }]}
        interactive={false}
      />
    </div>
  );
}
