import { PropertyKeysTab } from '@/components/keys/key-register';

export default async function PropertyKeysPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PropertyKeysTab propertyId={id} />;
}
