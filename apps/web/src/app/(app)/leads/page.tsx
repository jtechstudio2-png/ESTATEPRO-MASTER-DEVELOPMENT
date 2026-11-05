import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { LeadList } from '@/components/leads/lead-list';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('leads'))('title') };
}

export default function LeadListPage() {
  return <LeadList />;
}
