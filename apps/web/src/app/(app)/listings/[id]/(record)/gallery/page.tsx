import { GalleryEditor } from '@/components/media/gallery-editor';

export default async function ListingGalleryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GalleryEditor listingId={id} />;
}
