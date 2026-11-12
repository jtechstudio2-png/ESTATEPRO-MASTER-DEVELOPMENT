import { ContactOverview } from '@/components/contacts/contact-overview';

export default async function ContactOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ContactOverview id={id} />;
}
