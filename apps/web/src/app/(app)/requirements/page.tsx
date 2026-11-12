import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { RequirementsRegister } from '@/components/contacts/requirements-register';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('requirements'))('registerTitle') };
}

export default function RequirementsRegisterPage() {
  return <RequirementsRegister />;
}
