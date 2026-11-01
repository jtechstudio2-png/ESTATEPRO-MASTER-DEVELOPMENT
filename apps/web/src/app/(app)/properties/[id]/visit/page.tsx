import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { FieldVisit } from '@/components/properties/field-visit';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('properties.field'))('startVisit') };
}

export default async function FieldVisitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FieldVisit propertyId={id} />;
}
