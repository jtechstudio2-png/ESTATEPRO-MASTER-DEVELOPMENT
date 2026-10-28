import { ActivityTab } from '@/components/properties/activity-tab';

export default async function PropertyActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ActivityTab propertyId={id} />;
}
