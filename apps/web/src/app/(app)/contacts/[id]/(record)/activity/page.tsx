import { ContactActivityTab } from '@/components/contacts/contact-tabs';

export default async function ContactContactActivityTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactActivityTab id={id} />;
}
