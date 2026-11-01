import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { StorageSettings } from '@/components/settings/storage-settings';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('media.storage'))('title') };
}

export default function StoragePage() {
  return <StorageSettings />;
}
