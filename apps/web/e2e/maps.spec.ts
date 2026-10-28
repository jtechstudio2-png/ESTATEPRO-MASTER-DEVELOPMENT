import { expect, expectAccessible, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

test.describe('Map search (M-2, M-3, X-5, issue #7)', () => {
  test.beforeEach(async ({ page, state }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
  });

  test('M-3 opens on the member’s market with pins, the list beside them and properties without a location', async ({ page }) => {
    await page.goto('/map/properties');
    await expect(page).toHaveURL(/filter%5Bbbox%5D=|filter\[bbox\]=/);
    await expect(page.getByRole('heading', { level: 2, name: /results in this area/ })).toBeVisible();
    const map = page.getByRole('region', { name: 'Properties map' });
    const osu = map.getByRole('button', { name: /^PRP-.*, Osu Court$/ });
    await expect(osu).toBeVisible();
    await expect(page.getByRole('link', { name: /No location: 1/ })).toHaveAttribute('href', '/properties?filter[hasLocation]=false');
    await expectAccessible(page);

    // Pins overlap at country zoom; markers are buttons, so the keyboard reaches each one.
    await osu.focus();
    await page.keyboard.press('Enter');
    await expect(osu).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Show Osu Court on the map' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('M-3 refreshes only on "Search this area" after the map moves', async ({ page }) => {
    await page.goto('/map/properties');
    const heading = page.getByRole('heading', { level: 2, name: /results in this area/ });
    await expect(heading).toBeVisible();
    const before = await heading.textContent();
    const map = page.getByRole('region', { name: 'Properties map' });
    // One move: the button appears once the move has ended.
    await map.getByRole('button', { name: 'Zoom in' }).click();
    const search = page.getByRole('button', { name: 'Search this area' });
    await expect(search).toBeVisible();
    await expect(heading).toHaveText(before!);
    await search.click();
    await expect(search).toBeHidden();
    await expect(page).toHaveURL(/bbox/);
  });

  test('M-3 radius tool from the keyboard: the crosshair sets the centre and the list sorts by distance', async ({ page }) => {
    // A viewport centred on Osu Court, so the crosshair starts on it.
    await page.goto('/map/properties?filter[bbox]=-0.1918,5.5471,-0.1718,5.5671');
    await expect(page.getByRole('region', { name: 'Properties map' }).getByRole('button', { name: /^PRP-.*, Osu Court$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Radius', exact: true }).click();
    await expect(page.getByText(/Click the map to set the centre/)).toBeVisible();
    await page.getByRole('button', { name: 'Crosshair' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByText('Centre set.')).toBeAttached();
    await page.getByRole('button', { name: 'Search this radius' }).click();
    await expect(page.getByRole('button', { name: /Remove filter Within 2 km of the chosen point/ })).toBeVisible();
    await expect(page).toHaveURL(/sort=distance/);
    const first = page.getByRole('list', { name: 'Properties' }).getByRole('listitem').first();
    await expect(first).toContainText('Osu Court');
    await expect(first).toContainText(/\d+ m away/);
  });

  test('M-3 draw tool works from the keyboard: crosshair, Space adds points, Enter finishes', async ({ page }) => {
    await page.goto('/map/properties');
    await expect(page.getByRole('region', { name: 'Properties map' }).getByRole('button', { name: /^PRP-.*, Osu Court$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Draw', exact: true }).click();
    const crosshair = page.getByRole('button', { name: 'Crosshair' });
    await crosshair.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await expect(page.getByRole('group', { name: 'Draw an area' }).getByText('3 points', { exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /Remove filter Inside the drawn area/ })).toBeVisible();
    await expect(page).toHaveURL(/polygon/);
    await page.getByRole('button', { name: 'Clear area' }).click();
    await expect(page).not.toHaveURL(/polygon/);
  });

  test('M-2 shows listings with price and status, and the list view keeps the filters', async ({ page, state }) => {
    await page.goto('/map/listings?filter[listingType]=rent');
    const map = page.getByRole('region', { name: 'Listings map' });
    await expect(map.getByRole('button', { name: new RegExp(`^${state.records.listing.reference}, `) })).toBeVisible();
    const card = page.getByRole('list', { name: 'Listings' }).getByRole('listitem').filter({ hasText: state.records.listing.reference });
    await expect(card).toContainText(/GH₵[\d,]+\.\d{2} \/ month/);
    // Price and status depend on whether the listing specs ran first (L-4 and L-6 change them).
    await expect(card).toContainText(/Draft|Reserved/);
    await expectAccessible(page);
    await page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'List' }).click();
    await expect(page).toHaveURL(/\/listings\?.*listingType%5D=rent|\/listings\?.*listingType\]=rent/);
    await expect(page).not.toHaveURL(/bbox/);
  });

  test('X-5 shows one pane at a time on a 320 px phone, with a list switch', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/map/listings');
    await expect(page.getByRole('region', { name: 'Listings map' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Listings' })).toBeHidden();
    await page.locator('label').filter({ hasText: /^\s*List\s*$/ }).first().click();
    await expect(page.getByRole('list', { name: 'Listings' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Listings map' })).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page);
  });
});
