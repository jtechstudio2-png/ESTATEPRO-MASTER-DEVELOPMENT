import type { Grant } from '@/lib/session-types';

export interface NavItem {
  id: string;
  href: string;
  /** Message key under "nav". */
  label: string;
  /** Also current for these path prefixes. */
  match: string[];
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

type Can = (permission: string) => Grant | undefined;

/**
 * Navigation from the member's permissions (M6 report §13, UI checklist §10).
 * Sections and items without permission are not rendered at all.
 */
export function buildNavigation(can: Can): NavSection[] {
  const sections: NavSection[] = [];
  const home: NavItem[] = [];
  if (can('property.view') || can('key.view')) home.push({ id: 'dashboard', href: '/dashboard', label: 'dashboard', match: ['/dashboard'] });
  if (home.length > 0) sections.push({ id: 'home', label: 'home', items: home });

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
  if (can('property.view')) settings.push({ id: 'storage', href: '/settings/storage', label: 'storage', match: ['/settings/storage'] });
  if (settings.length > 0) sections.push({ id: 'settings', label: 'settings', items: settings });
  return sections;
}

export interface QuickCreateItem {
  id: string;
  href: string;
  label: string;
}

export function buildQuickCreate(can: Can): QuickCreateItem[] {
  const items: QuickCreateItem[] = [];
  if (can('property.create')) items.push({ id: 'property', href: '/properties/new', label: 'createProperty' });
  if (can('listing.create')) items.push({ id: 'listing', href: '/listings/new', label: 'createListing' });
  if (can('key.manage')) items.push({ id: 'key-set', href: '/keys/new', label: 'createKeySet' });
  return items;
}

export function isCurrent(item: NavItem, pathname: string): boolean {
  return item.match.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
