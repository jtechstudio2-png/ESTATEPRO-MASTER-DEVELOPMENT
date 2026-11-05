import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { MyDay } from '@/components/crm-dashboards/my-day';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('myDay'))('titlePlain') };
}

export default function MyDayPage() {
  return <MyDay />;
}
