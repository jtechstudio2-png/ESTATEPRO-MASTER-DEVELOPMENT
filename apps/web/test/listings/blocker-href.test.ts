import { describe, expect, it } from 'vitest';

import { blockerHref } from '@/components/listings/listing-dialogs';

const listing = { id: 'l1', property: { id: 'p1' }, unit: { id: 'u1' } } as Parameters<typeof blockerHref>[0];

describe('publish checklist links (issue #18)', () => {
  it('sends a missing owner to the property Ownership tab', () => {
    expect(blockerHref(listing, { code: 'no-owner', field: 'sellerKyc' })).toBe('/properties/p1/ownership');
  });

  it("sends an unverified owner to that contact's Identity tab", () => {
    expect(blockerHref(listing, { code: 'unverified', field: 'sellerKyc.0b7c1f4e-1111-4222-8333-944455556666' })).toBe('/contacts/0b7c1f4e-1111-4222-8333-944455556666/identity');
  });

  it('falls back to the Ownership tab when no owner is named', () => {
    expect(blockerHref(listing, { code: 'unverified', field: 'sellerKyc' })).toBe('/properties/p1/ownership');
  });

  it('keeps the other links', () => {
    expect(blockerHref(listing, { code: 'unavailable', field: 'unit.availability' })).toBe('/properties/p1/units?unit=u1');
    expect(blockerHref(listing, { code: 'archived', field: 'unitId' })).toBeNull();
  });
});
