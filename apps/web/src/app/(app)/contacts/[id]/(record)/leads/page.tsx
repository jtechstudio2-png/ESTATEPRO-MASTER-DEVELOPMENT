import { ContactLeadsTab } from '@/components/contacts/contact-tabs';

export default async function ContactContactLeadsTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactLeadsTab id={id} />;
}
