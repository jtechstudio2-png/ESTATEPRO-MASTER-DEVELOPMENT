import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Forecast } from '@/components/sales/forecast';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('sales'))('forecastTitle') };
}

export default function ForecastPage() {
  return <Forecast />;
}
