import { describe, expect, it } from 'vitest';

import type { TenantContext } from '../src/common/request-context.js';
import { canOnDeal, dealWithin, grantCoversDeal, managesDeal } from '../src/deals/deal-access.js';
import { addDays } from '../src/deals/deal-effects.js';
import { equalShares } from '../src/deals/deal-progress.service.js';
import { stageMoveAllowed } from '../src/deals/deal-stage.js';
import { weigh } from '../src/deals/deals.service.js';

const ctx = (scope: string | null, officeIds: string[] = ['office-a']): TenantContext =>
  ({
    companyId: 'c',
    userId: 'u',
    membershipId: 'me',
    membershipType: 'staff',
    roleKey: 'x',
    contactId: null,
    officeIds,
    permissions: new Map(scope ? [['deal.update', { scope, isSensitive: false }], ['deal.view', { scope, isSensitive: false }]] : []),
    requestId: 'r',
    ipAddress: null,
    userAgent: null,
  }) as TenantContext;

const deal = (overrides: Partial<{ officeId: string; ownerMembershipId: string; agentIds: string[] }> = {}) => ({
  officeId: 'office-a',
  ownerMembershipId: 'someone',
  agentIds: [],
  ...overrides,
});

describe('deal scope (deals/deal-access.ts, S2-R3)', () => {
  it('all, office, own (owner or agent on the deal); anything else matches nothing', () => {
    expect(dealWithin('all', ctx('all'), deal())).toBe(true);
    expect(dealWithin('office', ctx('office'), deal())).toBe(true);
    expect(dealWithin('office', ctx('office', ['office-b']), deal())).toBe(false);
    expect(dealWithin('own', ctx('own'), deal())).toBe(false);
    expect(dealWithin('own', ctx('own'), deal({ ownerMembershipId: 'me' }))).toBe(true);
    expect(dealWithin('own', ctx('own'), deal({ agentIds: ['me'] }))).toBe(true);
    expect(dealWithin('linked', ctx('linked'), deal())).toBe(false);
    expect(dealWithin(undefined, ctx(null), deal())).toBe(false);
    expect(canOnDeal(ctx(null), 'deal.view', deal())).toBe(false);
  });

  it('managing (reassign, splits) needs company or office scope over the deal', () => {
    expect(managesDeal(ctx('all'), deal())).toBe(true);
    expect(managesDeal(ctx('office'), deal())).toBe(true);
    expect(managesDeal(ctx('office', ['office-b']), deal())).toBe(false);
    expect(managesDeal(ctx('own'), deal({ ownerMembershipId: 'me' }))).toBe(false);
  });

  it('another member\'s grant covers the deal they would own or work on', () => {
    const grant = (scope: 'all' | 'office' | 'own' | 'linked' | null) => ({ membershipId: 'm', name: 'M', scope, officeIds: ['office-a'] });
    expect(grantCoversDeal(grant('all'), { officeId: 'office-z' }, false)).toBe(true);
    expect(grantCoversDeal(grant('office'), { officeId: 'office-a' }, false)).toBe(true);
    expect(grantCoversDeal(grant('office'), { officeId: 'office-z' }, true)).toBe(false);
    expect(grantCoversDeal(grant('own'), { officeId: 'office-z' }, true)).toBe(true);
    expect(grantCoversDeal(grant('own'), { officeId: 'office-z' }, false)).toBe(false);
    expect(grantCoversDeal(grant('linked'), { officeId: 'office-a' }, true)).toBe(false);
  });
});

describe('deal life cycle (deals/deal-stage.ts, readiness §4.3)', () => {
  it('follows the drawn moves; closed deals never move', () => {
    expect(stageMoveAllowed('lead', 'qualification')).toBe(true);
    expect(stageMoveAllowed('viewing', 'qualification')).toBe(true);
    expect(stageMoveAllowed('qualification', 'qualification')).toBe(true);
    expect(stageMoveAllowed('qualification', 'lead')).toBe(false);
    expect(stageMoveAllowed('negotiation', 'contract')).toBe(false);
    expect(stageMoveAllowed('offer_accepted', 'negotiation')).toBe(true);
    expect(stageMoveAllowed('contract', 'closed_won')).toBe(true);
    expect(stageMoveAllowed('closed_won', 'closed_won')).toBe(false);
    expect(stageMoveAllowed('closed_lost', 'lead')).toBe(false);
  });
});

describe('arithmetic', () => {
  it('weighs a value by a percentage on decimal strings, half-up at four places', () => {
    expect(weigh('450000.0000', '5.00')).toBe('22500.0000');
    expect(weigh('100', '33.33')).toBe('33.3300');
    expect(weigh('0.0001', '50')).toBe('0.0001');
    expect(weigh('1', '0')).toBe('0.0000');
  });

  it('splits ownership into equal shares adding up to exactly 100 %', () => {
    expect(equalShares(['a'])).toEqual([{ contactId: 'a', sharePercent: '100.0000' }]);
    const three = equalShares(['a', 'b', 'c']);
    expect(three.map((s) => s.sharePercent)).toEqual(['33.3334', '33.3333', '33.3333']);
    expect(three.reduce((sum, s) => sum + Math.round(Number(s.sharePercent) * 10_000), 0)).toBe(1_000_000);
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });
});
