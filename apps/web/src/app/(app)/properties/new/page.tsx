import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PropertyFormPage } from '@/components/properties/property-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('properties'))('addProperty') };
}

export default function NewPropertyPage() {
  return <PropertyFormPage />;
}
