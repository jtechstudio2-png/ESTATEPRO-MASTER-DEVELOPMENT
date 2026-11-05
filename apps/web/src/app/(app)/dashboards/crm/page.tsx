import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { CrmDashboard } from '@/components/crm-dashboards/crm-dashboard';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('crmDashboard'))('title') };
}

export default function CrmDashboardPage() {
  return <CrmDashboard />;
}
