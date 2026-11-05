import { RequirementsTab } from '@/components/contacts/requirements';

export default async function ContactRequirementsTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequirementsTab id={id} />;
}
