import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { FollowUpViewings } from '@/components/sales/viewing-list';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('sales'))('followUpTitle') };
}

export default function FollowUpViewingsPage() {
  return <FollowUpViewings />;
}
