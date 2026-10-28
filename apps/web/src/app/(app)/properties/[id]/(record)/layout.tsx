import type { ReactNode } from 'react';

import { PropertyFrame } from '@/components/properties/property-frame';

export default async function PropertyLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PropertyFrame id={id}>{children}</PropertyFrame>;
}
