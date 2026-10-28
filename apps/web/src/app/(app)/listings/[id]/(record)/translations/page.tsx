import { ListingTranslationsTab } from '@/components/listings/listing-translations';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListingTranslationsTab id={id} />;
}
