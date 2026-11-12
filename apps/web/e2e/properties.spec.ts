import { choose, expect, expectAccessible, pickRadio, signIn, test } from './support/fixtures';

test.describe('Properties (P-1 to P-7)', () => {
  test.beforeEach(async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
  });

  test('P-1 lists, filters, searches and pages through properties with state in the URL', async ({ page }) => {
    await page.goto('/properties');
    await expect(page.getByRole('heading', { level: 1, name: 'Properties' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Properties' });
    await expect(table.getByRole('row')).toHaveCount(51);
    await expect(page.getByText('Sorted by: Last updated, newest first')).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(table.getByRole('row')).toHaveCount(56);
    await expect(page.getByText(/Loaded 5 more rows/)).toBeAttached();

    await page.getByLabel('Search reference, name or address').fill('Osu Court');
    await expect(page).toHaveURL(/q=Osu\+Court/);
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('rowheader')).toContainText('Osu Court');

    await page.getByRole('button', { name: 'Remove filter Search: Osu Court' }).click();
    await choose(page, 'Location', 'No location');
    await expect(page).toHaveURL(/filter%5BhasLocation%5D=false/);
    await expect(table.getByRole('rowheader')).toHaveCount(1);
    await expect(table.getByRole('rowheader')).toContainText('East Legon Plot 4');
    await page.reload();
    await expect(page.getByRole('table', { name: 'Properties' }).getByRole('rowheader')).toContainText('East Legon Plot 4');
  });

  test('P-2 shows the overview with pinned notes, summaries and key facts', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.osuCourt.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Osu Court');
    const tabs = page.getByRole('navigation', { name: 'Property sections' });
    for (const tab of ['Overview', 'Units', 'Listings', 'Media', 'Notes', 'Keys', 'Activity']) await expect(tabs.getByRole('link', { name: new RegExp(`^${tab}`) })).toBeVisible();
    await expect(page.getByText('Gate sticks; lift and push.')).toBeVisible();
    await expect(page.getByText(/Units: 3 · Available 2 · Under maintenance 1/)).toBeVisible();
    await expect(page.getByText(/Keys: 1 · Out 1 · Overdue 1/)).toBeVisible();
    await expect(page.getByText('GhanaPost GPS address: GA-123-4567')).toBeVisible();
    await expect(page).toHaveTitle(/Osu Court · EstatePro/);
    await expectAccessible(page);
  });

  test('links styled as buttons keep readable text when hovered', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.osuCourt.id}`);
    const visit = page.getByRole('navigation', { name: 'Field actions' }).getByRole('link', { name: 'Field visit' });
    await visit.hover();
    // White text on the hover brand colour, not brand-coloured text (global a:hover).
    await expect(visit).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expectAccessible(page);
    await page.getByRole('navigation', { name: 'Field actions' }).getByRole('link', { name: 'Keys' }).hover();
    await expectAccessible(page);
  });

  test('P-3 validates, then creates a property with a typed location', async ({ page }) => {
    await page.goto('/properties/new');
    await page.getByRole('button', { name: 'Save' }).first().click();
    const summary = page.getByRole('alert').filter({ hasText: 'There is a problem' });
    await expect(summary).toBeFocused();
    await expect(summary.getByRole('link', { name: /Type/ })).toBeVisible();

    await page.getByLabel('Name').fill('Airport Residences');
    await choose(page, 'Type', 'Apartment building');
    await page.getByLabel('Street address').fill('7 Liberation Road');
    await page.getByLabel('Town / City').fill('Accra');
    await page.getByLabel('Region').fill('Greater Accra');
    await page.getByLabel('Latitude').fill('5.6052');
    await page.getByLabel('Longitude').fill('-0.1718');
    await page.getByRole('button', { name: 'Move the pin to these coordinates' }).click();
    await expect(page.getByText('How was it found: Placed on map')).toBeVisible();
    await expectAccessible(page, { exclude: ['.maplibregl-canvas'] });
    await page.getByRole('button', { name: 'Save' }).first().click();
    await expect(page).toHaveURL(/\/properties\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Airport Residences');
    await expect(page.getByText('Placed on map · Building')).toBeVisible();
  });

  test('P-3 refuses a point outside the country before sending it', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.eastLegon.id}/edit`);
    await page.getByLabel('Latitude').fill('51.5');
    await page.getByLabel('Longitude').fill('-0.12');
    await page.getByRole('button', { name: 'Move the pin to these coordinates' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'outside Ghana' })).toBeVisible();
  });

  test('P-4 adds a unit and changes its availability with a required reason', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.laboneVilla.id}/units`);
    await expect(page.getByRole('table', { name: 'Units' }).getByRole('rowheader')).toHaveCount(1);
    await page.getByRole('button', { name: 'Add unit' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add unit' });
    await drawer.getByLabel('Label').fill('Boys quarters');
    await drawer.getByLabel('Bedrooms').fill('1');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(drawer).toBeHidden();
    const row = page.getByRole('row').filter({ hasText: 'Boys quarters' });
    await row.getByRole('button', { name: 'More actions for Boys quarters' }).click();
    await page.getByRole('menuitem', { name: 'Change availability' }).click();
    const dialog = page.getByRole('dialog', { name: 'Availability of Boys quarters' });
    await pickRadio(dialog, 'Under maintenance');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('Enter a reason.')).toBeVisible();
    await dialog.getByLabel('Reason').fill('Roof repair');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByText('Under maintenance')).toBeVisible();
    await expectAccessible(page);
  });

  test('P-5 archives and restores a property with a reason', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.eastLegon.id}`);
    await page.getByRole('button', { name: /More actions for PRP-/ }).click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Archive East Legon Plot 4?' });
    await dialog.getByLabel('Reason').fill('Sold by owner');
    await dialog.getByRole('button', { name: 'Archive East Legon Plot 4' }).click();
    await expect(page.getByText(/Archived .*: Sold by owner/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
    await page.getByRole('button', { name: /More actions for PRP-/ }).click();
    await page.getByRole('menuitem', { name: 'Restore' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore East Legon Plot 4' }).click();
    await expect(page.getByText(/Archived .*: Sold by owner/)).toBeHidden();
  });

  test('P-6 shows the property activity, filtered by type', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.osuCourt.id}/activity`);
    const feed = page.getByRole('list', { name: 'Property activity' });
    await expect(feed).toContainText('Property added');
    await expect(feed).toContainText('Keys checked out');
    await choose(page, 'Type', 'Keys');
    await expect(feed).not.toContainText('Property added');
    await expectAccessible(page);
  });

  test('P-7 lists platform types read-only and adds a company type', async ({ page }) => {
    await page.goto('/settings/property-types');
    await expect(page.getByRole('heading', { level: 1, name: 'Property types' })).toBeVisible();
    await page.getByRole('button', { name: 'Add type' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add property type' });
    await dialog.getByLabel('Code').fill('shop_with_flat');
    await dialog.getByLabel('Name').fill('Shop with flat');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await pickRadio(page, 'Company');
    await expect(page.getByRole('rowheader', { name: /Shop with flat/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit Shop with flat' })).toBeVisible();
    // The filter changes the URL; the page title is streamed back after the navigation (WCAG 2.4.2).
    await expect(page).toHaveTitle(/Property types/);
    await expectAccessible(page);
  });
});

test.describe('Properties by role and language', () => {
  test('an agent cannot archive and sees no settings write actions', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await page.goto(`/properties/${state.records.osuCourt.id}`);
    await page.getByRole('button', { name: /More actions for PRP-/ }).click();
    await expect(page.getByRole('menuitem', { name: 'Archive' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto('/settings/property-types');
    await expect(page.getByRole('button', { name: 'Add type' })).toHaveCount(0);
  });

  test('the Arabic overview is right to left and accessible', async ({ page, state }) => {
    await signIn(page, state.users.arabic.email);
    await page.goto(`/properties/${state.records.dohaTower.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('برج الدفنة');
    await expect(page.getByRole('navigation', { name: 'أقسام العقار' })).toBeVisible();
    await expectAccessible(page);
  });

  test('the register becomes cards at 320 px without sideways scrolling', async ({ page, state }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/properties');
    await expect(page.getByRole('list', { name: 'Properties' }).getByRole('listitem').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page);
  });
});
