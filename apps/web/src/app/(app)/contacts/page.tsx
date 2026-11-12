import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ContactList } from '@/components/contacts/contact-list';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('contacts'))('title') };
}

export default function ContactsPage() {
  return <ContactList />;
}
