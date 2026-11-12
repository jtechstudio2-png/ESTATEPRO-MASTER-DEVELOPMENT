import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { NewPrivacyRequest } from '@/components/privacy/new-request';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('privacy'))('newTitle') };
}

export default function NewPrivacyRequestPage() {
  return <NewPrivacyRequest />;
}
