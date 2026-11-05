import { IdentityTab } from '@/components/contacts/identity-tab';

export default async function ContactIdentityTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <IdentityTab id={id} />;
}
