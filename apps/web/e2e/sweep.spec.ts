import type { Page } from '@playwright/test';

import { expect, expectAccessible, signIn, test } from './support/fixtures';

/**
 * Accessibility and layout sweep over every M6 screen (UI checklist §8, §9):
 * axe (WCAG 2.1 A/AA) in English at desktop width and at 320 px, and in
 * Arabic (right to left), with no sideways scrolling on a 320 px phone.
 */
async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `sideways scroll on ${page.url()}`).toBeLessThanOrEqual(0);
}

async function settled(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
}

/** Every CRM screen of a company (C5): dashboards, registers, the contact record tabs, forms and settings. */
function crmScreens(contactId: string, leadId: string | null): string[] {
  const contact = `/contacts/${contactId}`;
  return [
    '/dashboards/admin',
    '/dashboards/crm',
    '/contacts',
    '/contacts?view=landlord',
    '/contacts/new',
    contact,
    `${contact}/activity`,
    `${contact}/leads`,
    `${contact}/requirements`,
    `${contact}/properties`,
    `${contact}/identity`,
    `${contact}/consent`,
    '/requirements',
    '/identity-checks',
    '/contacts?view=seller',
    '/leads',
    '/leads/new',
    ...(leadId ? [`/leads/${leadId}`] : []),
    '/follow-ups',
    '/exports',
    '/settings/crm',
  ];
}

test.describe('Screen sweep (issue #7)', () => {
  test.setTimeout(480_000);

  test('every English screen passes axe on desktop and fits a 320 px phone', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    const property = `/properties/${state.records.osuCourt.id}`;
    const listing = `/listings/${state.records.listing.id}`;
    const screens = [
      '/dashboard',
      '/properties',
      property,
      `${property}/units`,
      `${property}/listings`,
      `${property}/media`,
      `${property}/notes`,
      `${property}/keys`,
      `${property}/activity`,
      `${property}/edit`,
      `${property}/visit`,
      '/properties/new',
      '/listings',
      '/listings/new',
      listing,
      `${listing}/gallery`,
      `${listing}/translations`,
      `${listing}/price-status`,
      `${listing}/history`,
      `${listing}/edit`,
      '/keys',
      '/keys/new',
      '/map/listings',
      '/map/properties',
      '/settings/property-types',
      '/settings/listings',
      '/settings/storage',
      // CRM (Phase 5 milestone C5).
      ...crmScreens(state.records.crm.ama.id, state.records.crm.portalLead.id),
      `/contacts/${state.records.crm.ama.id}/edit`,
      `/contacts/${state.records.crm.seller.id}/identity`,
    ];
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const screen of screens) {
        await page.goto(screen);
        await settled(page);
        await expectAccessible(page);
        if (width === 320) await noSidewaysScroll(page);
      }
    }
  });

  test('every Arabic screen is right to left and passes axe', async ({ page, state }) => {
    await signIn(page, state.users.arabic.email);
    const property = `/properties/${state.records.dohaTower.id}`;
    const screens = [
      '/dashboard',
      '/properties',
      property,
      `${property}/units`,
      `${property}/media`,
      `${property}/notes`,
      `${property}/keys`,
      `${property}/activity`,
      `${property}/edit`,
      `${property}/visit`,
      '/listings',
      '/listings/new',
      '/keys',
      '/map/listings',
      '/map/properties',
      '/settings/property-types',
      '/settings/listings',
      '/settings/storage',
      ...crmScreens(state.records.crm.dohaContact.id, null),
      // An erased person (ADR-007 E6): translated name, banner, document number gone.
      `/contacts/${state.records.crm.dohaErased.id}`,
      `/contacts/${state.records.crm.dohaErased.id}/identity`,
    ];
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const screen of screens) {
        await page.goto(screen);
        await settled(page);
        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
        await expectAccessible(page);
        if (width === 320) await noSidewaysScroll(page);
      }
    }
  });

  test('switching company never shows the previous company’s data', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/properties?q=Osu');
    await expect(page.getByRole('table', { name: 'Properties' }).getByRole('rowheader')).toContainText('Osu Court');
    await page.goto('/select-company');
    await page.getByRole('button', { name: `Open ${state.companies.doha.name}` }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/select-company'));
    await page.goto('/properties');
    await expect(page.getByRole('link', { name: /برج الدفنة/ }).first()).toBeVisible();
    await expect(page.getByText('Osu Court')).toHaveCount(0);
    // The other company's record is not found, not shown from a cache.
    await page.goto(`/properties/${state.records.osuCourt.id}`);
    await expect(page.getByText('Osu Court')).toHaveCount(0);
  });
});
