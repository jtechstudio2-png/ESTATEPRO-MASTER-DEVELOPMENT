import { OwnershipTab } from '@/components/properties/ownership-tab';

export default async function PropertyOwnershipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OwnershipTab propertyId={id} />;
}
