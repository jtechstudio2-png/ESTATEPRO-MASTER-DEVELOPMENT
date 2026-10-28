import { MediaTab } from '@/components/media/media-tab';

export default async function PropertyMediaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MediaTab propertyId={id} />;
}
