import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PropertyFormPage } from '@/components/properties/property-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('properties'))('editProperty') };
}

export default async function EditPropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PropertyFormPage id={id} />;
}
