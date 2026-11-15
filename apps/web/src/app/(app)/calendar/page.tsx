import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ViewingCalendar } from '@/components/sales/viewing-calendar';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('sales'))('calendarTitle') };
}

export default function CalendarPage() {
  return <ViewingCalendar />;
}
