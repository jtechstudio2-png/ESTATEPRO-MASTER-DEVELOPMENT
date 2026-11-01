import { UnitsTab } from '@/components/properties/units-tab';

export default async function PropertyUnitsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UnitsTab propertyId={id} />;
}
