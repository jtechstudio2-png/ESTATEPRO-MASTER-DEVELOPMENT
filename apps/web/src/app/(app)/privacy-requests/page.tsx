import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PrivacyRequestList } from '@/components/privacy/request-list';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('privacy'))('registerTitle') };
}

export default function PrivacyRequestsPage() {
  return <PrivacyRequestList />;
}
