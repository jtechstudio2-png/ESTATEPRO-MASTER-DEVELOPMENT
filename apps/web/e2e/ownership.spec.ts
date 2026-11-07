import { choose, expect, expectAccessible, pickRadio, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/**
 * P5-H against the real API: the property Ownership tab, adding an owner from
 * a contact (LL-1), ending an ownership into history, the seller identity
 * publish rule (#18) with links to fix each item, an agent who may not see
 * the owner, and the Arabic tab.
 */
test.describe('Ownership records and seller identity (P5-H, #18)', () => {
  test('the Ownership tab lists the current owner with their identity status', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/properties/${state.records.laboneVilla.id}`);
    await page.getByRole('navigation', { name: 'Property sections' }).getByRole('link', { name: 'Ownership' }).click();
    await expect(page).toHaveURL(/\/ownership$/);
    const row = page.getByRole('table', { name: 'Ownership records', exact: true }).getByRole('row').filter({ hasText: 'Ama Owusu' });
    await expect(row).toContainText('Whole property');
    await expect(row).toContainText('100 %');
    await expect(row).toContainText('Legal owner');
    await expect(row).toContainText('Not verified');
    await expect(row.getByRole('link', { name: 'Check identity' })).toHaveAttribute('href', `/contacts/${state.records.crm.ama.id}/identity`);
    await expectAccessible(page);
  });

  test('LL-1: an owner is added from the contact, then the ownership is ended into history', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/contacts/${state.records.crm.seller.id}/properties`);
    await page.getByRole('link', { name: 'Add ownership' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Add ownership' })).toBeVisible();
    await expect(page.getByText('Esi Sarpong')).toBeVisible();
    await page.getByRole('textbox', { name: 'Find a property' }).fill('Labone');
    await page.getByRole('button', { name: /Labone Villa/ }).click();
    await choose(page, 'Type of ownership', 'Developer');
    await page.getByLabel(/^Share/).fill('100');
    await page.getByLabel(/^First day of ownership/).fill('2024-03-01');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Record ownership' }).click();
    await expect(page).toHaveURL(new RegExp(`/contacts/${state.records.crm.seller.id}/properties$`));
    // A developer record is counted apart from Ama's 100 % legal ownership.
    await expect(page.getByRole('link', { name: /Labone Villa/ })).toBeVisible();

    await page.goto(`/properties/${state.records.laboneVilla.id}/ownership`);
    const current = page.getByRole('table', { name: 'Ownership records', exact: true });
    await expect(current.getByRole('row').filter({ hasText: 'Esi Sarpong' })).toContainText('Developer');
    await current.getByRole('button', { name: 'End ownership of Esi Sarpong' }).click();
    const end = page.getByRole('alertdialog', { name: 'End this ownership' });
    await end.getByLabel(/^Last day of ownership/).fill(yesterday());
    await end.getByRole('textbox', { name: /^Reason/ }).fill('Development agreement ended');
    await expectAccessible(page);
    await end.getByRole('button', { name: 'End ownership of Esi Sarpong' }).click();
    await expect(end).toBeHidden();
    await expect(page.getByRole('table', { name: 'Ownership records', exact: true }).getByRole('row').filter({ hasText: 'Esi Sarpong' })).toHaveCount(0);
    const past = page.getByRole('table', { name: 'Ended ownership records' }).getByRole('row').filter({ hasText: 'Esi Sarpong' });
    await expect(past).toContainText('Development agreement ended');
    await expect(past.getByRole('button')).toHaveCount(0);
  });

  test('#18: with the rule on, the checklist names each missing or unverified owner and links to the fix', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/settings/listings');
    const rule = page.getByRole('checkbox', { name: "Every current owner's identity must be verified before publishing" });
    await rule.check({ force: true });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Listing rules saved.')).toBeAttached();
    try {
      await page.goto('/listings/new');
      await page.getByRole('textbox', { name: 'Search property or unit' }).fill('Osu Court');
      await page.getByRole('button', { name: /Osu Court/ }).click();
      await choose(page, 'Unit', /^Flat 1B/);
      await pickRadio(page, 'Sale');
      await page.getByLabel(/^Price/).fill('380000');
      await page.getByLabel(/^Title/).fill('Two-bed flat for sale, Osu');
      await page.getByRole('button', { name: 'Create draft' }).first().click();
      await expect(page).toHaveURL(/\/listings\/[0-9a-f-]{36}$/);

      const checklist = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Publishing checklist' }) });
      const missing = checklist.getByRole('listitem').filter({ hasText: 'No owner recorded' });
      await expect(missing).toBeVisible();
      await expect(missing.getByRole('link', { name: 'Fix' })).toHaveAttribute('href', `/properties/${state.records.osuCourt.id}/ownership`);
      await expectAccessible(page);
      const listingUrl = page.url();

      // Record Esi (identity check still in review) as the owner of Flat 1B.
      await missing.getByRole('link', { name: 'Fix' }).click();
      await page.getByRole('link', { name: 'Add ownership' }).click();
      await page.getByRole('combobox', { name: 'Owner' }).fill('Esi Sar');
      await page.getByRole('option', { name: /Esi Sarpong/ }).click();
      await choose(page, 'Covers', /^Flat 1B/);
      await page.getByRole('button', { name: 'Record ownership' }).click();
      await expect(page).toHaveURL(new RegExp(`/properties/${state.records.osuCourt.id}/ownership$`));
      await expect(page.getByRole('table', { name: 'Ownership records', exact: true }).getByRole('row').filter({ hasText: 'Esi Sarpong' })).toContainText('Flat 1B');

      await page.goto(listingUrl);
      const unverified = checklist.getByRole('listitem').filter({ hasText: 'Owner identity not verified' });
      await expect(unverified).toBeVisible();
      await expect(unverified.getByRole('link', { name: 'Fix' })).toHaveAttribute('href', `/contacts/${state.records.crm.seller.id}/identity`);
      await expect(checklist.getByText('No owner recorded')).toHaveCount(0);
    } finally {
      await page.goto('/settings/listings');
      await rule.uncheck({ force: true });
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Listing rules saved.')).toBeAttached();
    }
  });

  test('an agent sees owners only among their contacts, and cannot change ownership', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await page.goto(`/properties/${state.records.laboneVilla.id}/ownership`);
    // Ama is one of the agent's contacts (D1); Esi, who ended her ownership above, is not.
    const current = page.getByRole('table', { name: 'Ownership records', exact: true });
    await expect(current.getByRole('row').filter({ hasText: 'Ama Owusu' })).toContainText('Legal owner');
    const past = page.getByRole('table', { name: 'Ended ownership records', exact: true });
    await expect(past).toContainText('A contact you cannot see');
    await expect(past).not.toContainText('Esi Sarpong');
    await expect(page.getByRole('link', { name: 'Add ownership' })).toHaveCount(0);
    await expect(current.getByRole('button', { name: /End ownership/ })).toHaveCount(0);
    await expectAccessible(page);
  });

  test('the Arabic Ownership tab is right to left and accessible', async ({ page, state }) => {
    await signIn(page, state.users.arabic.email);
    await page.goto(`/properties/${state.records.dohaTower.id}/ownership`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('navigation', { name: 'أقسام العقار' }).getByRole('link', { name: 'الملكية' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'لا يوجد مالك حالي مسجّل' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'إضافة ملكية' })).toBeVisible();
    await expectAccessible(page);
  });
});
