import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ExportsList } from '@/components/exports/exports-list';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('exports'))('title') };
}

export default function ExportsListPage() {
  return <ExportsList />;
}
