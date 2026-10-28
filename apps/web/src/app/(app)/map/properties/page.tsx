import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { MapSearch } from '@/components/map/map-search';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('location'))('mapProperties') };
}

export default function MapPropertiesPage() {
  return <MapSearch kind="properties" />;
}
