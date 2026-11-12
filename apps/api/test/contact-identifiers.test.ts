import { describe, expect, it } from 'vitest';

import { contactWithinScope } from '../src/contacts/contact-access.js';
import type { TenantContext } from '../src/common/request-context.js';
import { isEmail, maskPhone, normaliseEmail, normaliseMethod, normalisePhone, searchNormalise } from '../src/contacts/identifiers.js';

describe('contact identifiers (CRM-02)', () => {
  it('normalises phone numbers to E.164, completing national numbers with the office calling code', () => {
    expect(normalisePhone('024 555 4412', '+233')).toBe('+233245554412');
    expect(normalisePhone('(024) 555-4412', '+233')).toBe('+233245554412');
    expect(normalisePhone('5500 1234', '+974')).toBe('+97455001234');
    expect(normalisePhone('07700 900123', '+44')).toBe('+447700900123');
    expect(normalisePhone('+233 24 555 4412', null)).toBe('+233245554412');
    expect(normalisePhone('00974 5500 1234', null)).toBe('+97455001234');
  });

  it('refuses values that cannot be phone numbers', () => {
    expect(normalisePhone('024 555 4412', null)).toBeNull();
    expect(normalisePhone('12', '+233')).toBeNull();
    expect(normalisePhone('call me', '+233')).toBeNull();
    expect(normalisePhone('+0123456789', null)).toBeNull();
  });

  it('normalises emails and checks their shape', () => {
    expect(normaliseEmail('  Ama.Owusu@Example.COM ')).toBe('ama.owusu@example.com');
    expect(isEmail('ama@example.com')).toBe(true);
    expect(isEmail('ama@example')).toBe(false);
    expect(isEmail('a b@example.com')).toBe(false);
    expect(isEmail(`${'a'.repeat(250)}@x.com`)).toBe(false);
  });

  it('normalises every method type, rejecting invalid values', () => {
    expect(normaliseMethod('email', 'A@B.CO', '+233')).toBe('a@b.co');
    expect(normaliseMethod('email', 'nope', '+233')).toBeNull();
    expect(normaliseMethod('whatsapp', '024 555 4412', '+233')).toBe('+233245554412');
    expect(normaliseMethod('fax', '+44 20 7946 0000', null)).toBe('+442079460000');
    expect(normaliseMethod('website', ' Https://Example.com ', null)).toBe('https://example.com');
    expect(normaliseMethod('other', '   ', null)).toBeNull();
  });

  it('masks phone numbers for lists', () => {
    expect(maskPhone('+233245554412')).toBe('+23324•••4412');
    expect(maskPhone('+1234567')).toBe('+1•••67');
    expect(maskPhone(null)).toBeNull();
  });

  it('folds Arabic spelling variants and diacritics like app.search_normalise', () => {
    expect(searchNormalise('أحمد الكوارى')).toBe(searchNormalise('احمد الكواري'));
    expect(searchNormalise('مَدْرَسَة')).toBe('مدرسه');
    expect(searchNormalise('مسؤول')).toBe('مسوول');
    expect(searchNormalise('ـسلامـ')).toBe('سلام');
    expect(searchNormalise('Kofi OWUSU')).toBe('kofi owusu');
  });
});

describe('contact record scope', () => {
  const ctx = { membershipId: 'm-1', officeIds: ['office-a'] } as unknown as TenantContext;

  it('applies all, office and own scopes', () => {
    expect(contactWithinScope('all', ctx, { officeId: null, ownerMembershipId: null })).toBe(true);
    expect(contactWithinScope('office', ctx, { officeId: 'office-a', ownerMembershipId: null })).toBe(true);
    expect(contactWithinScope('office', ctx, { officeId: null, ownerMembershipId: 'm-1' })).toBe(false);
    expect(contactWithinScope('own', ctx, { officeId: null, ownerMembershipId: 'm-1' })).toBe(true);
    expect(contactWithinScope('assigned', ctx, { officeId: 'office-a', ownerMembershipId: 'm-1' })).toBe(false);
  });
});
