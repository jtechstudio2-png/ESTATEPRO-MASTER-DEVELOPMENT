'use client';

import { useSession } from '@/components/session';
import { Stack } from '@/components/ui/layout';

import { DealList } from './deal-list';
import { OfferList } from './offers';
import { ViewingList } from './viewing-list';

/** X-C2: the contact's deals, offers made and viewings attended, each by its own permission. */
export function ContactSalesTab({ id }: { id: string }) {
  const { can } = useSession();
  return (
    <Stack>
      {can('deal.view') ? <DealList contactId={id} /> : null}
      {can('offer.view') ? <OfferList contactId={id} /> : null}
      {can('viewing.view') ? <ViewingList contactId={id} /> : null}
    </Stack>
  );
}

/** X-L3 listing tabs: viewings, offers (O-4) and deals, rows only in the member's scope. */
export function ListingViewingsTab({ id }: { id: string }) {
  return <ViewingList listingId={id} />;
}

export function ListingOffersTab({ id }: { id: string }) {
  return <OfferList listingId={id} />;
}

export function ListingDealsTab({ id }: { id: string }) {
  return <DealList listingId={id} />;
}
