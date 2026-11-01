import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { NewListing } from '@/components/listings/new-listing';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('listings'))('newListing') };
}

export default function NewListingPage() {
  return <NewListing />;
}
