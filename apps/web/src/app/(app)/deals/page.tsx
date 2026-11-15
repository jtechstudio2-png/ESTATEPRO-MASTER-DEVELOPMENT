import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { DealList } from '@/components/sales/deal-list';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('sales'))('dealsTitle') };
}

export default function DealsPage() {
  return <DealList />;
}
