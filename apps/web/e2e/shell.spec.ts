import { expect, expectAccessible, signIn, test } from './support/fixtures';

test.describe('S-1 and S-2: sign-in, company picker and shell', () => {
  test('a member of several companies chooses one and sees the shell', async ({ page, state }) => {
    await signIn(page, state.users.owner.email);
    await expect(page).toHaveURL(/\/select-company/);
    await expect(page.getByRole('heading', { level: 1, name: 'Choose a company' })).toBeVisible();
    await expect(page.getByText('Read only')).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Open Accra Homes Ltd' }).click();
    // Owners land on the admin dashboard (SH-1).
    await expect(page).toHaveURL(/\/dashboards\/admin/);
    const nav = page.getByRole('navigation', { name: 'Main' }).first();
    for (const item of ['Admin dashboard', 'CRM dashboard', 'Property dashboard', 'Contacts', 'Buyers', 'Landlords', 'Requirements', 'Exports', 'Leads', 'Follow-ups', 'Properties', 'Listings', 'Map', 'Keys', 'Property types', 'Listing rules', 'CRM settings', 'Storage']) {
      await expect(nav.getByRole('link', { name: new RegExp(`^.?\\s*${item}`) })).toBeVisible();
    }
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('a read-only company opens with a banner and no create menu', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.london.name });
    await expect(page.getByRole('status').filter({ hasText: 'read-only' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create' })).toHaveCount(0);
  });

  test('a member of one company skips the picker and an agent lands on My day', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await expect(page).toHaveURL(/\/my-day/);
    await expect(page.getByRole('button', { name: /Account: Ama Boateng/ })).toBeVisible();
  });

  test('an Arabic company renders right to left', async ({ page, state }) => {
    await signIn(page, state.users.arabic.email);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.getByRole('navigation', { name: 'الرئيسية' }).first().getByRole('link', { name: /العقارات/ }).first()).toBeVisible();
  });

  test('signing out ends the session', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await page.getByRole('button', { name: /Account:/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in\?signedOut=1/);
    await page.goto('/properties');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
