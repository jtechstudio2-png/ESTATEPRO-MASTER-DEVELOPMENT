import { describe, expect, it } from 'vitest';

import type { PermissionScope, TenantContext } from '../src/common/request-context.js';
import { agreementWithin, canOnAgreement, canOnLease, leaseWithin } from '../src/lettings/lettings-access.js';

const ctx = (scope: PermissionScope | null, officeIds: string[] = ['office-a']): TenantContext => ({
  companyId: 'c',
  userId: 'u',
  membershipId: 'me',
  membershipType: 'staff',
  roleKey: 'x',
  contactId: null,
  officeIds,
  permissions: new Map(scope ? [['lease.view', { scope, isSensitive: false }], ['management_agreement.view', { scope, isSensitive: false }]] : []),
  requestId: 'r',
  ipAddress: null,
  userAgent: null,
});

const lease = { officeId: 'office-a', createdBy: 'someone', dealOwnerId: null, dealAgentIds: [] as string[] };

/** Lease and agreement scope rules (L1, lettings-access.ts). */
describe('lettings record scope', () => {
  it('reads leases by company, office, or as their own', () => {
    expect(leaseWithin('all', ctx('all'), lease)).toBe(true);
    expect(leaseWithin('office', ctx('office'), lease)).toBe(true);
    expect(leaseWithin('office', ctx('office', ['office-b']), lease)).toBe(false);
    expect(leaseWithin('own', ctx('own'), lease)).toBe(false);
    expect(leaseWithin('own', ctx('own'), { ...lease, createdBy: 'me' })).toBe(true);
    expect(leaseWithin('own', ctx('own'), { ...lease, dealOwnerId: 'me' })).toBe(true);
    expect(leaseWithin('own', ctx('own'), { ...lease, dealAgentIds: ['me'] })).toBe(true);
    // The portal scope is milestone L5; other scopes match nothing.
    expect(leaseWithin('linked', ctx('linked'), lease)).toBe(false);
    expect(leaseWithin(undefined, ctx(null), lease)).toBe(false);
    expect(canOnLease(ctx('office'), 'lease.view', lease)).toBe(true);
    expect(canOnLease(ctx(null), 'lease.view', lease)).toBe(false);
  });

  it('reads agreements by company or office only', () => {
    expect(agreementWithin('all', ctx('all'), { officeId: 'office-z' })).toBe(true);
    expect(agreementWithin('office', ctx('office'), { officeId: 'office-a' })).toBe(true);
    expect(agreementWithin('office', ctx('office'), { officeId: 'office-z' })).toBe(false);
    expect(agreementWithin('own', ctx('own'), { officeId: 'office-a' })).toBe(false);
    expect(agreementWithin('linked', ctx('linked'), { officeId: 'office-a' })).toBe(false);
    expect(canOnAgreement(ctx('all'), 'management_agreement.view', { officeId: 'x' })).toBe(true);
    expect(canOnAgreement(ctx(null), 'management_agreement.view', { officeId: 'x' })).toBe(false);
  });
});
