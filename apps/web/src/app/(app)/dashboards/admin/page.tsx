import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AdminDashboard } from '@/components/crm-dashboards/admin-dashboard';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('adminDashboard'))('title') };
}

export default function AdminDashboardPage() {
  return <AdminDashboard />;
}
