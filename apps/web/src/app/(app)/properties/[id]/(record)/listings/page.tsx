import { ListingList } from '@/components/listings/listing-list';

export default async function PropertyListingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListingList propertyId={id} />;
}
