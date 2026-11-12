import type { ReactNode } from 'react';

import { ContactFrame } from '@/components/contacts/contact-frame';

export default async function ContactLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactFrame id={id}>{children}</ContactFrame>;
}
