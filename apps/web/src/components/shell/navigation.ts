import type { Grant } from '@/lib/session-types';

export interface NavItem {
  id: string;
  href: string;
  /** Message key under "nav". */
  label: string;
  /** Also current for these path prefixes. */
  match: string[];
  /** Current only when the query also matches (saved views of one register, SH-1). */
  query?: Record<string, string>;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

type Can = (permission: string) => Grant | undefined;

/**
 * CRM screens are for staff who work contacts: not for maintenance staff,
 * whose `assigned` contact access is limited to their work orders (wireframes
 * §2.1), nor for portal users (`linked`).
 */
export function hasCrm(can: Can): boolean {
  const scope = can('contact.view')?.scope;
  return scope === 'all' || scope === 'office' || scope === 'team' || scope === 'own';
}

/** Leads in scope beyond one's own: the CRM dashboard is the manager's home (D-C). */
function leadScope(can: Can): Grant['scope'] | undefined {
  return can('lead.view')?.scope;
}

/**
 * The start page for a member (SH-1): agents land on My day, owners and
 * administrators on the admin dashboard, sales and property managers on the
 * CRM dashboard, everyone else on the property dashboard.
 */
export function landingPath(can: Can): string {
  const leads = leadScope(can);
  if (leads === 'own') return '/my-day';
  if (can('user.manage')) return '/dashboards/admin';
  if (leads !== undefined) return '/dashboards/crm';
  return '/dashboard';
}

/**
 * Navigation from the member's permissions (M6 report §13, UI checklist §10).
 * Sections and items without permission are not rendered at all.
 */
export function buildNavigation(can: Can): NavSection[] {
  const sections: NavSection[] = [];
  const crm = hasCrm(can);
  const home: NavItem[] = [];
  const leads = leadScope(can);
  if (leads === 'own') home.push({ id: 'my-day', href: '/my-day', label: 'myDay', match: ['/my-day'] });
  if (can('user.manage')) home.push({ id: 'admin-dashboard', href: '/dashboards/admin', label: 'adminDashboard', match: ['/dashboards/admin'] });
  if (leads !== undefined) home.push({ id: 'crm-dashboard', href: '/dashboards/crm', label: 'crmDashboard', match: ['/dashboards/crm'] });
  // D-1 for those who run the book (listing.approve_price: Own, Adm, SM, PM); D-2 for key holders.
  if (can('listing.approve_price') || can('key.view')) home.push({ id: 'dashboard', href: '/dashboard', label: 'dashboard', match: ['/dashboard'] });
  if (home.length > 0) sections.push({ id: 'home', label: 'home', items: home });

  if (crm) {
    // Buyers, sellers, landlords and tenants are saved views of the one register (decision D2).
    const contacts: NavItem[] = [
      { id: 'contacts', href: '/contacts', label: 'contacts', match: ['/contacts'] },
      ...(['buyer', 'seller', 'landlord', 'tenant'] as const).map((role) => ({
        id: `contacts-${role}`,
        href: `/contacts?view=${role}`,
        label: `view.${role}`,
        match: ['/contacts'],
        query: { view: role },
      })),
      { id: 'requirements', href: '/requirements', label: 'requirements', match: ['/requirements'] },
    ];
    if (can('kyc.view')) contacts.push({ id: 'identity-checks', href: '/identity-checks', label: 'identityChecks', match: ['/identity-checks'] });
    if (can('privacy.view')) contacts.push({ id: 'privacy-requests', href: '/privacy-requests', label: 'privacyRequests', match: ['/privacy-requests'] });
    if (can('contact.export') || can('lead.export') || can('user.manage') || can('privacy.fulfil')) contacts.push({ id: 'exports', href: '/exports', label: 'exports', match: ['/exports'] });
    sections.push({ id: 'contacts', label: 'contactsSection', items: contacts });

    const sales: NavItem[] = [];
    if (leads !== undefined) sales.push({ id: 'leads', href: '/leads', label: 'leads', match: ['/leads'] });
    sales.push({ id: 'follow-ups', href: '/follow-ups', label: 'followUps', match: ['/follow-ups'] });
    sections.push({ id: 'sales', label: 'salesSection', items: sales });
  }

  const properties: NavItem[] = [];
  if (can('property.view')) properties.push({ id: 'properties', href: '/properties', label: 'properties', match: ['/properties'] });
  if (can('listing.view')) properties.push({ id: 'listings', href: '/listings', label: 'listings', match: ['/listings'] });
  if (can('listing.view') || can('property.view')) {
    properties.push({ id: 'map', href: can('listing.view') ? '/map/listings' : '/map/properties', label: 'map', match: ['/map'] });
  }
  if (can('key.view')) properties.push({ id: 'keys', href: '/keys', label: 'keys', match: ['/keys'] });
  if (properties.length > 0) sections.push({ id: 'properties', label: 'propertiesSection', items: properties });

  const settings: NavItem[] = [];
  if (can('property.view')) settings.push({ id: 'property-types', href: '/settings/property-types', label: 'propertyTypes', match: ['/settings/property-types'] });
  if (can('listing.view')) settings.push({ id: 'listing-rules', href: '/settings/listings', label: 'listingRules', match: ['/settings/listings'] });
  if (leads !== undefined && can('settings.manage')) settings.push({ id: 'crm-settings', href: '/settings/crm', label: 'crmSettings', match: ['/settings/crm'] });
  if (can('property.view')) settings.push({ id: 'storage', href: '/settings/storage', label: 'storage', match: ['/settings/storage'] });
  if (settings.length > 0) sections.push({ id: 'settings', label: 'settings', items: settings });
  return sections;
}

export interface QuickCreateItem {
  id: string;
  href: string;
  label: string;
}

/** "+ New" (SH-1): the common records, filtered by permission. */
export function buildQuickCreate(can: Can): QuickCreateItem[] {
  const items: QuickCreateItem[] = [];
  if (can('lead.create')) items.push({ id: 'lead', href: '/leads/new', label: 'createLead' });
  if (hasCrm(can) && can('contact.create')) items.push({ id: 'contact', href: '/contacts/new', label: 'createContact' });
  if (hasCrm(can)) items.push({ id: 'follow-up', href: '/follow-ups?compose=1', label: 'createFollowUp' });
  if (can('property.create')) items.push({ id: 'property', href: '/properties/new', label: 'createProperty' });
  if (can('listing.create')) items.push({ id: 'listing', href: '/listings/new', label: 'createListing' });
  if (can('key.manage')) items.push({ id: 'key-set', href: '/keys/new', label: 'createKeySet' });
  return items;
}

export function isCurrent(item: NavItem, pathname: string, search: URLSearchParams | null = null): boolean {
  const onPath = item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (!onPath) return false;
  const view = search?.get('view') ?? null;
  // A saved view is current only on its own query; the register itself only without one.
  if (item.query) return Object.entries(item.query).every(([key, value]) => search?.get(key) === value);
  if (item.id === 'contacts' && pathname === '/contacts') return view === null;
  return true;
}
