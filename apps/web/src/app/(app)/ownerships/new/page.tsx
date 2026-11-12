import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { NewOwnership } from '@/components/properties/new-ownership';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('ownership'))('newTitle') };
}

export default function NewOwnershipPage() {
  return <NewOwnership />;
}
