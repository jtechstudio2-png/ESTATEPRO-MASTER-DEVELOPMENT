import { ConsentTab } from '@/components/contacts/consent-tab';

export default async function ContactConsentTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConsentTab id={id} />;
}
