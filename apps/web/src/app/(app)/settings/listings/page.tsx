import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ListingSettings } from '@/components/settings/listing-settings';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('listings.settings'))('title') };
}

export default function ListingSettingsPage() {
  return <ListingSettings />;
}
