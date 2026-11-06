import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PrivacyRequestRecord } from '@/components/privacy/request-record';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('privacy'))('registerTitle') };
}

export default async function PrivacyRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PrivacyRequestRecord id={id} />;
}
