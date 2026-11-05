import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { NewLead } from '@/components/leads/new-lead';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('leads'))('newTitle') };
}

export default function NewLeadPage() {
  return <NewLead />;
}
