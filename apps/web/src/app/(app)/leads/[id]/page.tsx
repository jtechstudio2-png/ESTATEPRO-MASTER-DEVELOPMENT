import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { LeadRecord } from '@/components/leads/lead-record';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('leads'))('recordTitle') };
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LeadRecord id={id} />;
}
