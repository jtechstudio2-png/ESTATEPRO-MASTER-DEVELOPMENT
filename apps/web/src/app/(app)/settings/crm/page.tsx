import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { CrmSettings } from '@/components/settings/crm-settings';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('crmSettings'))('title') };
}

export default function CrmSettingsPage() {
  return <CrmSettings />;
}
