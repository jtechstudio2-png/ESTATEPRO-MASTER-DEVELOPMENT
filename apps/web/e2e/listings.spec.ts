import { choose, expect, expectAccessible, pickRadio, signIn, test } from './support/fixtures';

test.describe('Listings (L-1 to L-10)', () => {
  test.beforeEach(async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
  });

  test('L-1 lists listings with type, status and publication filters', async ({ page }) => {
    await page.goto('/listings');
    const table = page.getByRole('table', { name: 'Listings' });
    await expect(table.getByRole('rowheader').first()).toContainText('2-bed apartment, Osu');
    await expect(table).toContainText('Draft');
    await expectAccessible(page);
    await pickRadio(page, 'Sale');
    await expect(page).toHaveURL(/filter%5BlistingType%5D=sale/);
    await expect(page.getByRole('heading', { name: 'No listings match these filters' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear all' }).first().click();
    await choose(page, 'Status', 'Draft');
    await expect(table.getByRole('rowheader')).toHaveCount(1);
  });

  test('L-2 creates a sale draft for a whole-property unit', async ({ page }) => {
    await page.goto('/listings/new');
    await page.getByRole('textbox', { name: 'Search property or unit' }).fill('Labone');
    await page.getByRole('button', { name: /Labone Villa/ }).click();
    await choose(page, 'Unit', /^Whole property/);
    await pickRadio(page, 'Sale');
    await page.getByLabel(/^Price/).fill('450000');
    await page.getByLabel(/^Title/).fill('Four-bed villa, Labone');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Create draft' }).first().click();
    await expect(page).toHaveURL(/\/listings\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Four-bed villa, Labone');
    await expect(page.getByText('Draft').first()).toBeVisible();
  });

  test('L-5 and L-6 publish the draft, then reserve it with its history recorded (L-9)', async ({ page, state }) => {
    await page.goto(`/listings/${state.records.listing.id}`);
    await expect(page.getByRole('heading', { name: 'Publishing checklist' })).toBeVisible();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    const publish = page.getByRole('alertdialog', { name: /Publish LST-/ });
    await expect(publish.getByText('Ready to publish.')).toBeVisible();
    await publish.getByRole('button', { name: /^Publish LST-/ }).click();
    await expect(publish).toBeHidden();
    await expect(page.getByText('Available').first()).toBeVisible();
    await expect(page.getByText('Published').first()).toBeVisible();

    await page.getByRole('button', { name: /More actions for LST-/ }).click();
    await page.getByRole('menuitem', { name: 'Change status' }).click();
    const status = page.getByRole('alertdialog', { name: 'Change status · Available' });
    await pickRadio(status, 'Reserved');
    await status.getByRole('button', { name: 'Change status: Reserved' }).click();
    await expect(status).toBeHidden();

    await page.getByRole('link', { name: 'Price & status' }).click();
    const history = page.getByRole('list', { name: 'Status history' });
    await expect(history).toContainText('Available → Reserved');
    await expect(history).toContainText('by Kofi Owusu');
    await expectAccessible(page);
  });

  test('L-4 asks for a reason when a live price goes down, and saves an Arabic translation', async ({ page, state }) => {
    await page.goto(`/listings/${state.records.listing.id}/edit`);
    await page.getByLabel('Price (GHS)').fill('5500');
    await expect(page.getByLabel(/Reason for price change/)).toBeVisible();
    await page.getByLabel(/Reason for price change/).fill('Owner agreed a lower rent');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/listings/${state.records.listing.id}$`));
    await page.getByRole('link', { name: /^Translations/ }).click();
    await choose(page, 'Add language', 'Arabic (Qatar)');
    const arabic = page.getByRole('region', { name: 'Arabic (Qatar)' });
    await arabic.getByLabel(/Title/).fill('شقة بغرفتي نوم، أوسو');
    await expect(arabic.getByLabel(/Title/)).toHaveAttribute('dir', 'rtl');
    await arabic.getByRole('button', { name: /Save Arabic/ }).click();
    await expect(page.getByRole('button', { name: /Remove Arabic/ })).toBeVisible();
    await page.getByRole('link', { name: 'Price & status' }).click();
    await expect(page.getByRole('list', { name: 'Price history' })).toContainText('Owner agreed a lower rent');
  });

  test('L-7 reassigns the listing to another agent', async ({ page, state }) => {
    await page.goto(`/listings/${state.records.listing.id}`);
    await page.getByRole('button', { name: /More actions for LST-/ }).click();
    await page.getByRole('menuitem', { name: 'Reassign' }).click();
    const dialog = page.getByRole('alertdialog', { name: /Reassign LST-/ });
    await dialog.getByRole('combobox', { name: /New agent/ }).fill('Ama');
    await page.getByRole('option', { name: /Ama Boateng/ }).click();
    await dialog.getByRole('button', { name: 'Reassign' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Agent: Ama Boateng')).toBeVisible();
  });

  test('L-10 saves the listing rules', async ({ page }) => {
    await page.goto('/settings/listings');
    await page.getByLabel('Minimum photos to publish').fill('3');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Listing rules saved.')).toBeAttached();
    await page.reload();
    await expect(page.getByLabel('Minimum photos to publish')).toHaveValue('3');
    await page.getByLabel('Minimum photos to publish').fill('');
    await page.getByRole('button', { name: 'Save' }).click();
    await expectAccessible(page);
  });
});

test('an agent sees their listing without reassign or rules editing', async ({ page, state }) => {
  await signIn(page, state.users.agent.email);
  await page.goto(`/listings/${state.records.listing.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('2-bed apartment');
  await page.getByRole('button', { name: /More actions for LST-/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Reassign' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/settings/listings');
  await expect(page.getByText('Only company administrators can change these rules.')).toBeVisible();
});
