import { describe, expect, it } from 'vitest';

import { todayIn } from '../src/common/dates.js';
import type { PermissionScope, TenantContext } from '../src/common/request-context.js';
import { LISTING_STATUSES } from '../src/listings/dto.js';
import {
  assertListingAccess,
  canPlaceListingInOffice,
  canReassign,
  hasListingPermission,
  listingWithin,
} from '../src/listings/listing-access.js';
import { decimalPlaces, formatAmount, toScaled } from '../src/common/money.js';
import {
  advanceWithinCap,
  decimalSetting,
  depositWithinCap,
  isLive,
  isTerminal,
  reasonRequired,
  reductionExceeds,
  transitionError,
  TRANSITIONS,
} from '../src/listings/listing-rules.js';
import { ruleApplies } from '../src/listings/listings.service.js';
import type { ProblemError } from '../src/common/problem.js';

const OFFICE = '0190a1b2-c3d4-7e5f-8a9b-000000000001';
const OTHER_OFFICE = '0190a1b2-c3d4-7e5f-8a9b-000000000002';
const ME = '0190a1b2-c3d4-7e5f-8a9b-00000000000a';
const SOMEONE = '0190a1b2-c3d4-7e5f-8a9b-00000000000b';

const ctx = (grants: Record<string, PermissionScope>): TenantContext => ({
  companyId: 'c',
  userId: 'u',
  membershipId: ME,
  membershipType: 'staff',
  roleKey: 'agent',
  contactId: null,
  officeIds: [OFFICE],
  permissions: new Map(Object.entries(grants).map(([key, scope]) => [key, { scope, isSensitive: false }])),
  requestId: 'r',
  ipAddress: null,
  userAgent: null,
});

describe('listing access', () => {
  const mine = { officeId: OFFICE, agentMembershipId: ME };
  const colleagues = { officeId: OFFICE, agentMembershipId: SOMEONE };
  const elsewhere = { officeId: OTHER_OFFICE, agentMembershipId: SOMEONE };

  it('evaluates each scope against a listing', () => {
    const c = ctx({});
    expect(listingWithin(c, 'all', elsewhere)).toBe(true);
    expect(listingWithin(c, 'office', colleagues)).toBe(true);
    expect(listingWithin(c, 'office', elsewhere)).toBe(false);
    expect(listingWithin(c, 'own', mine)).toBe(true);
    expect(listingWithin(c, 'own', colleagues)).toBe(false);
    for (const scope of ['linked', 'team', 'assigned'] as const) expect(listingWithin(c, scope, mine)).toBe(false);
  });

  it('answers 404 outside the view scope and 403 outside the action scope', () => {
    const agent = ctx({ 'listing.view': 'office', 'listing.publish': 'own' });
    const status = (row: typeof mine, permission: string) => {
      try {
        assertListingAccess(agent, row, permission);
        return 200;
      } catch (error) {
        return (error as ProblemError).status;
      }
    };
    expect(status(mine, 'listing.publish')).toBe(200);
    expect(status(colleagues, 'listing.publish')).toBe(403);
    expect(status(elsewhere, 'listing.publish')).toBe(404);
    expect(status(mine, 'listing.archive')).toBe(403);
    expect(hasListingPermission(agent, mine, 'listing.archive')).toBe(false);
  });

  it('limits offices and reassignment by grant scope (D1, D4)', () => {
    const c = ctx({});
    expect(canPlaceListingInOffice(c, 'all', OTHER_OFFICE)).toBe(true);
    expect(canPlaceListingInOffice(c, 'office', OFFICE)).toBe(true);
    expect(canPlaceListingInOffice(c, 'own', OTHER_OFFICE)).toBe(false);
    expect(canPlaceListingInOffice(c, 'linked', OFFICE)).toBe(false);
    expect(canReassign(ctx({ 'listing.update': 'own' }), mine)).toBe(false);
    expect(canReassign(ctx({ 'listing.update': 'office' }), colleagues)).toBe(true);
    expect(canReassign(ctx({ 'listing.update': 'office' }), elsewhere)).toBe(false);
    expect(canReassign(ctx({ 'listing.update': 'all' }), elsewhere)).toBe(true);
    expect(canReassign(ctx({}), mine)).toBe(false);
  });
});

describe('listing status model (D3)', () => {
  it('has no way out of terminal statuses and only publish leaves draft for available', () => {
    for (const status of ['sold', 'rented', 'withdrawn', 'expired'] as const) {
      expect(TRANSITIONS[status]).toEqual([]);
      expect(isTerminal(status)).toBe(true);
      expect(transitionError('sale', status, 'available')).toContain('Relist');
    }
    expect(transitionError('sale', 'draft', 'available')).toContain('Publish');
    expect(transitionError('sale', 'draft', 'reserved')).toContain('cannot move');
    expect(transitionError('rent', 'under_contract', 'sold')).toContain('sales');
    expect(transitionError('sale', 'under_contract', 'rented')).toContain('rental');
    expect(transitionError('sale', 'under_contract', 'sold')).toBeNull();
    expect(isLive('reserved')).toBe(true);
    expect(isLive('draft')).toBe(false);
  });

  it('only allows statuses from the catalogue', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(LISTING_STATUSES).toContain(from);
      for (const to of targets) expect(LISTING_STATUSES).toContain(to);
    }
  });

  it('requires reasons for withdrawals, expiry and deals falling through', () => {
    expect(reasonRequired('available', 'withdrawn')).toBe(true);
    expect(reasonRequired('available', 'expired')).toBe(true);
    expect(reasonRequired('reserved', 'available')).toBe(true);
    expect(reasonRequired('under_contract', 'available')).toBe(true);
    expect(reasonRequired('available', 'reserved')).toBe(false);
    expect(reasonRequired('under_contract', 'sold')).toBe(false);
  });
});

describe('decimal rules', () => {
  it('scales decimal strings without floating point', () => {
    expect(toScaled('0.1')).toBe(1000n);
    expect(toScaled('123456789012345.6789')).toBe(1234567890123456789n);
    expect(decimalPlaces('10.500')).toBe(1);
    expect(decimalPlaces('10')).toBe(0);
    expect(formatAmount('450000.0000', 2)).toBe('450000.00');
    expect(formatAmount('12.3450', 3)).toBe('12.345');
    expect(formatAmount('0.0050', 2)).toBe('0.01');
    expect(formatAmount('99.5000', 0)).toBe('100');
  });

  it('detects reductions above the approval threshold, exclusive', () => {
    expect(reductionExceeds('100000', '90000', 10)).toBe(false);
    expect(reductionExceeds('100000', '89999.99', 10)).toBe(true);
    expect(reductionExceeds('100000', '110000', 10)).toBe(false);
    expect(reductionExceeds('0.30', '0.20', 33)).toBe(true);
  });

  it('converts advance rent periods to months for the cap', () => {
    expect(advanceWithinCap(104, 'weekly', '24')).toBe(true);
    expect(advanceWithinCap(105, 'weekly', '24')).toBe(false);
    expect(advanceWithinCap(4, 'quarterly', '12')).toBe(true);
    expect(advanceWithinCap(3, 'semi_annual', '12')).toBe(false);
    expect(advanceWithinCap(1, 'annual', '6')).toBe(false);
    expect(advanceWithinCap(6, 'monthly', '6')).toBe(true);
    expect(advanceWithinCap(1, 'fortnightly', '6')).toBe(false);
    expect(depositWithinCap('1153.85', '1000', '1.1538')).toBe(false);
    expect(depositWithinCap('1153.80', '1000', '1.1538')).toBe(true);
  });

  it('reads numeric settings as decimals and ignores anything else', () => {
    expect(decimalSetting(24)).toBe('24.0000');
    expect(decimalSetting('1.5')).toBe('1.5');
    expect(decimalSetting(-1)).toBeNull();
    expect(decimalSetting('lots')).toBeNull();
    expect(decimalSetting(null)).toBeNull();
    expect(decimalSetting(1e20)).toBeNull();
  });
});

describe('required document rule conditions', () => {
  it('matches known facts and fails closed on unknown condition keys', () => {
    const facts = { listing_type: 'rent', usage: 'residential' };
    expect(ruleApplies({}, facts)).toBe(true);
    expect(ruleApplies(null, facts)).toBe(true);
    expect(ruleApplies(['x'], facts)).toBe(true);
    expect(ruleApplies({ listing_type: 'rent' }, facts)).toBe(true);
    expect(ruleApplies({ listing_type: 'sale' }, facts)).toBe(false);
    expect(ruleApplies({ usage: ['commercial', 'residential'] }, facts)).toBe(true);
    expect(ruleApplies({ usage: ['commercial'] }, facts)).toBe(false);
    expect(ruleApplies({ furnished: true }, facts)).toBe(true);
  });
});

describe('todayIn', () => {
  it('returns the local calendar date of a time zone', () => {
    const instant = new Date('2026-03-01T23:30:00Z');
    expect(todayIn('Africa/Accra', instant)).toBe('2026-03-01');
    expect(todayIn('Asia/Qatar', instant)).toBe('2026-03-02');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2026-03-01');
  });
});
