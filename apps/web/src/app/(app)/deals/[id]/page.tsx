import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { DealRecord } from '@/components/sales/deal-record';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('sales'))('dealTitle') };
}

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DealRecord id={id} />;
}
