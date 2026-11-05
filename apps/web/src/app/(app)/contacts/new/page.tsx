import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ContactFormPage } from '@/components/contacts/contact-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('contacts'))('newTitle') };
}

export default function NewContactPage() {
  return <ContactFormPage />;
}
