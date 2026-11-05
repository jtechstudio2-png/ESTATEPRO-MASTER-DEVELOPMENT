import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { FollowUpsList } from '@/components/activity/follow-ups-list';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('followUps'))('title') };
}

export default function FollowUpsListPage() {
  return <FollowUpsList />;
}
