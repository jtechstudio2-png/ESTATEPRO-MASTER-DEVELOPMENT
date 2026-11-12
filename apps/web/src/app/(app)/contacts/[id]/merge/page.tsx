import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { MergePage } from '@/components/contacts/merge';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('merge'))('title') };
}

export default async function MergeContactsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ with?: string }> }) {
  const { id } = await params;
  const other = (await searchParams).with;
  const valid = typeof other === 'string' && /^[0-9a-f-]{36}$/i.test(other) && other !== id;
  return <MergePage id={id} otherId={valid ? other : null} />;
}
