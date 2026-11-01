import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PropertyTypesSettings } from '@/components/settings/property-types';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('properties.types'))('title') };
}

export default function PropertyTypesPage() {
  return <PropertyTypesSettings />;
}
