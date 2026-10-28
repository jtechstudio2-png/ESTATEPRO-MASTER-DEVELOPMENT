import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ListingList } from '@/components/listings/listing-list';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('listings'))('title') };
}

export default function ListingsPage() {
  return <ListingList />;
}
