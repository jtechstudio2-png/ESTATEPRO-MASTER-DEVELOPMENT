import { describe, expect, it } from 'vitest';

import { buildNavigation, buildQuickCreate, hasCrm, isCurrent, landingPath } from '@/components/shell/navigation';
import type { Grant } from '@/lib/session-types';

/** Grants of the system roles (migration 0014 and 0022), CRM part plus what the shell reads. */
const ROLES: Record<string, Record<string, Grant['scope']>> = {
  company_owner: { 'kyc.view': 'all', 'contact.view': 'all', 'contact.create': 'all', 'contact.export': 'all', 'lead.view': 'all', 'lead.create': 'all', 'lead.assign': 'all', 'lead.export': 'all', 'user.manage': 'all', 'settings.manage': 'all', 'property.view': 'all', 'listing.view': 'all', 'listing.approve_price': 'all', 'privacy.view': 'all', 'privacy.manage': 'all', 'privacy.fulfil': 'all' },
  sales_manager: { 'contact.view': 'office', 'contact.create': 'office', 'contact.export': 'office', 'lead.view': 'office', 'lead.create': 'office', 'lead.assign': 'office', 'lead.export': 'office', 'property.view': 'office', 'listing.view': 'office', 'listing.approve_price': 'office' },
  agent: { 'contact.view': 'own', 'contact.create': 'own', 'lead.view': 'own', 'lead.create': 'own', 'property.view': 'office', 'listing.view': 'office' },
  accountant: { 'contact.view': 'all', 'contact.view_sensitive': 'all', 'property.view': 'all', 'listing.view': 'all' },
  maintenance_staff: { 'contact.view': 'assigned', 'property.view': 'assigned' },
  tenant: { 'property.view': 'linked' },
};

const can = (role: string) => (permission: string) => {
  const scope = ROLES[role]![permission];
  return scope ? { key: permission, scope, isSensitive: false } : undefined;
};
const ids = (role: string) => buildNavigation(can(role)).flatMap((section) => section.items.map((item) => item.id));

describe('CRM navigation (SH-1, wireframes §2.2)', () => {
  it('sends each role to its home: agents to My day, owners to the admin dashboard, managers to the CRM dashboard', () => {
    expect(landingPath(can('agent'))).toBe('/my-day');
    expect(landingPath(can('company_owner'))).toBe('/dashboards/admin');
    expect(landingPath(can('sales_manager'))).toBe('/dashboards/crm');
    expect(landingPath(can('accountant'))).toBe('/dashboard');
    expect(landingPath(can('maintenance_staff'))).toBe('/dashboard');
  });

  it('shows the contact views, leads and follow-ups only to CRM staff', () => {
    expect(ids('company_owner')).toEqual(expect.arrayContaining(['admin-dashboard', 'crm-dashboard', 'contacts', 'contacts-buyer', 'contacts-landlord', 'requirements', 'identity-checks', 'exports', 'leads', 'follow-ups', 'crm-settings']));
    expect(ids('agent')).not.toContain('identity-checks');
    // Data-subject requests (gap G3): owners and office administrators only.
    expect(ids('company_owner')).toContain('privacy-requests');
    expect(ids('agent')).not.toContain('privacy-requests');
    expect(ids('agent')).toEqual(expect.arrayContaining(['my-day', 'crm-dashboard', 'contacts', 'leads', 'follow-ups']));
    expect(ids('agent')).not.toContain('admin-dashboard');
    expect(ids('agent')).not.toContain('exports');
    expect(ids('sales_manager')).not.toContain('my-day');
    // The accountant reads contacts but has no leads.
    expect(ids('accountant')).toContain('contacts');
    expect(ids('accountant')).not.toContain('leads');
    // Maintenance staff and portal users get no CRM screens at all.
    expect(hasCrm(can('maintenance_staff'))).toBe(false);
    expect(ids('maintenance_staff')).not.toContain('contacts');
    expect(ids('tenant')).not.toContain('contacts');
  });

  it('offers lead, contact and follow-up in the create menu by permission', () => {
    expect(buildQuickCreate(can('agent')).map((item) => item.id)).toEqual(['lead', 'contact', 'follow-up']);
    expect(buildQuickCreate(can('accountant')).map((item) => item.id)).toEqual(['follow-up']);
    expect(buildQuickCreate(can('maintenance_staff'))).toEqual([]);
  });

  it('marks a saved view current only on its own query, and the register only without one', () => {
    const items = buildNavigation(can('company_owner')).flatMap((section) => section.items);
    const register = items.find((item) => item.id === 'contacts')!;
    const buyers = items.find((item) => item.id === 'contacts-buyer')!;
    expect(isCurrent(register, '/contacts', new URLSearchParams())).toBe(true);
    expect(isCurrent(register, '/contacts', new URLSearchParams('view=buyer'))).toBe(false);
    expect(isCurrent(buyers, '/contacts', new URLSearchParams('view=buyer'))).toBe(true);
    expect(isCurrent(buyers, '/contacts', new URLSearchParams('view=seller'))).toBe(false);
    expect(isCurrent(register, '/contacts/1234', new URLSearchParams())).toBe(true);
    expect(isCurrent(register, '/leads', null)).toBe(false);
  });
});
