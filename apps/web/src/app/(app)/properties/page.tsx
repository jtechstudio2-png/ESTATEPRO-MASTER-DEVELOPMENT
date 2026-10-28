import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PropertyList } from '@/components/properties/property-list';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('properties'))('title') };
}

export default function PropertiesPage() {
  return <PropertyList />;
}
