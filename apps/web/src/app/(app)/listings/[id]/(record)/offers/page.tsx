import { ListingOffersTab } from '@/components/sales/record-panels';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListingOffersTab id={id} />;
}
