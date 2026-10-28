import { ListingHistoryTab } from '@/components/listings/listing-tabs';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListingHistoryTab id={id} />;
}
