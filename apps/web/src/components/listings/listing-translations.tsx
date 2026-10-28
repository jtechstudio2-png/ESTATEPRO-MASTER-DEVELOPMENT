'use client';

import { TranslationEditor } from './listing-editor';
import { useListing, useListingGrant } from './use-listing';

/** Translations tab (L-4): each language side by side; editable with listing.update. */
export function ListingTranslationsTab({ id }: { id: string }) {
  const listing = useListing(id);
  const covers = useListingGrant();
  if (!listing.data) return null;
  return <TranslationEditor listing={listing.data} readOnly={!covers('listing.update', listing.data) || listing.data.archivedAt !== null} />;
}
