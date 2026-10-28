import { expect, expectAccessible, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

test.describe('Key register (K-1 to K-6, X-4, issue #7)', () => {
  test.beforeEach(async ({ page, state }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
  });

  test('K-2 opens on keys that are out, overdue first as text, with scoped counts', async ({ page, state }) => {
    await page.goto('/keys');
    const views = page.getByRole('navigation', { name: 'Key views' });
    await expect(views.getByRole('link', { name: /^Out/ })).toHaveAttribute('aria-current', 'page');
    await expect(views.getByRole('link', { name: /^Out/ })).toContainText('2');
    await expect(views.getByRole('link', { name: /^Overdue/ })).toContainText('2');
    const table = page.getByRole('table', { name: 'Key sets' });
    const row = table.getByRole('row').filter({ hasText: 'Villa spare' });
    await expect(row.getByRole('link', { name: /Villa spare · Labone Villa/ })).toHaveAttribute('href', `/properties/${state.records.laboneVilla.id}/keys`);
    await expect(row).toContainText(state.users.manager.name);
    await expect(row).toContainText('Overdue');
    await expect(row).toContainText('was due');
    await expect(page.getByText('Sorted by: Due back, soonest first')).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('combobox', { name: /Holder/ }).fill('Ama');
    await page.getByRole('option', { name: /Ama Boateng/ }).click();
    await expect(page.getByRole('heading', { name: 'No key sets match this view' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove filter Holder: Ama Boateng' }).click();
    await expect(table.getByRole('row').filter({ hasText: 'Villa spare' })).toBeVisible();
  });

  test('K-4 checks the overdue set back in from the register', async ({ page }) => {
    await page.goto('/keys?tab=overdue');
    await page.getByRole('table', { name: 'Key sets' }).getByRole('button', { name: 'Check in Villa spare' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Check in Villa spare' });
    await expect(dialog).toContainText('Held by Yaw Asante since');
    await dialog.getByRole('button', { name: 'Check in Villa spare' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('table', { name: 'Key sets' }).getByRole('row').filter({ hasText: 'Villa spare' })).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Key views' }).getByRole('link', { name: 'All' }).click();
    await expect(page.getByRole('table', { name: 'Key sets' }).getByRole('row').filter({ hasText: 'Villa spare' })).toContainText('In office');
  });

  test('K-5 adds a set on the property tab; a duplicate tag is shown on the field', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.laboneVilla.id}/keys`);
    await page.getByRole('button', { name: 'Add key set' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add key set · Labone Villa' });
    await dialog.getByRole('textbox', { name: /Tag number/ }).fill('Villa spare');
    await dialog.getByRole('button', { name: 'Add key set' }).click();
    await expect(dialog.getByRole('textbox', { name: /Tag number/ })).toHaveAttribute('aria-invalid', 'true');
    await dialog.getByRole('textbox', { name: /Tag number/ }).fill('K-200');
    await dialog.getByRole('textbox', { name: /Contents/ }).fill('2 front door, 1 gate fob');
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Add key set' }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('table', { name: 'Key sets' }).getByRole('row').filter({ hasText: 'K-200' });
    await expect(row).toContainText('2 front door, 1 gate fob');
    await expect(row).toContainText('In office');
  });

  test('K-3 checks the new set out to a staff member and K-6 shows the movement', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.laboneVilla.id}/keys`);
    const row = page.getByRole('table', { name: 'Key sets' }).getByRole('row').filter({ hasText: 'K-200' });
    await row.getByRole('button', { name: 'Check out K-200' }).click();
    const dialog = page.getByRole('dialog', { name: /^Check out K-200/ });
    await dialog.getByRole('combobox', { name: /Staff member/ }).fill('Ama');
    await page.getByRole('option', { name: /Ama Boateng/ }).click();
    await dialog.getByRole('button', { name: 'Check out' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText('Ama Boateng');
    await expect(row).toContainText('due');
    await row.getByRole('button', { name: 'More actions for K-200' }).click();
    await page.getByRole('menuitem', { name: 'History' }).click();
    const history = page.getByRole('dialog', { name: 'K-200 history' });
    await expect(history).toContainText('Checked out to Ama Boateng');
    await expect(history).toContainText(`recorded by ${state.users.owner.name}`);
    await expectAccessible(page);
  });

  test('K-4 retires a set only when it is in the office; retired sets are hidden until asked for', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.laboneVilla.id}/keys`);
    const table = page.getByRole('table', { name: 'Key sets' });
    await table.getByRole('button', { name: 'More actions for Villa spare' }).click();
    await page.getByRole('menuitem', { name: 'Retire' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Retire Villa spare?' });
    await dialog.getByRole('textbox', { name: /Reason/ }).fill('Locks changed');
    await dialog.getByRole('button', { name: 'Retire Villa spare' }).click();
    await expect(dialog).toBeHidden();
    await expect(table.getByRole('row').filter({ hasText: 'Villa spare' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show retired' }).click();
    await expect(table.getByRole('row').filter({ hasText: 'Villa spare' })).toContainText('Retired');
  });

  test('Quick create chooses the property, then opens K-5 and lands on its keys tab', async ({ page, state }) => {
    await page.goto('/keys/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Add key set' })).toBeVisible();
    await page.getByRole('textbox', { name: /Find property/ }).fill('East Legon');
    await page.getByRole('button', { name: 'Add key set to East Legon Plot 4' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add key set · East Legon Plot 4' });
    await dialog.getByRole('textbox', { name: /Tag number/ }).fill('EL-1');
    await dialog.getByRole('button', { name: 'Add key set' }).click();
    await expect(page).toHaveURL(new RegExp(`/properties/${state.records.eastLegon.id}/keys$`));
    await expect(page.getByRole('table', { name: 'Key sets' })).toContainText('EL-1');
  });

  test('X-4 shows the register as cards on a 320 px phone', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/keys?tab=all');
    const cards = page.getByRole('list', { name: 'Key sets' });
    await expect(cards.getByRole('listitem').filter({ hasText: 'K-200' })).toContainText('Ama Boateng');
    await expect(cards.getByRole('button', { name: 'Check in K-200' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expectAccessible(page);
  });
});
