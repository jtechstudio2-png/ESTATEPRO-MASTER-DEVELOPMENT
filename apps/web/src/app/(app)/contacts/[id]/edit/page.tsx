import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ContactFormPage } from '@/components/contacts/contact-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('contacts'))('editPage') };
}

export default async function EditContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactFormPage id={id} />;
}
