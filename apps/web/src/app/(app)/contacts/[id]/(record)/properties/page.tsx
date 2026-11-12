import { PropertiesTab } from '@/components/contacts/properties-tab';

export default async function ContactPropertiesTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PropertiesTab id={id} />;
}
