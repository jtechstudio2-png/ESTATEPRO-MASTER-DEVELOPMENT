import type { ReactNode } from 'react';

import { ListingFrame } from '@/components/listings/listing-frame';

export default async function ListingLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ListingFrame id={id}>{children}</ListingFrame>;
}
