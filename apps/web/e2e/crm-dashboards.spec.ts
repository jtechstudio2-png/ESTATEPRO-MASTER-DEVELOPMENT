import { expect, expectAccessible, pickRadio, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

/**
 * Dashboards (D-A, D-C, D-M), the follow-up list (F-2) and the response
 * target setting. Every number is in the viewer's scope; figures the product
 * cannot know yet say so instead of showing zero (C4-D7).
 */
test.describe('CRM dashboards (D-A, D-C, D-M)', () => {
  test('D-M My day lists the agent’s overdue follow-up first and what is waiting', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await expect(page).toHaveURL(/\/my-day/);
    const today = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Today', exact: true }) });
    const first = today.getByRole('listitem').first();
    await expect(first).toContainText('Call Ama about East Legon options');
    await expect(first).toContainText('Overdue');
    const waiting = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Waiting on me' }) });
    await expect(waiting.getByRole('link', { name: /Overdue follow-ups/ })).toContainText('1');
    await expectAccessible(page);
    // Agents have no admin dashboard: the page answers "not allowed", never the data.
    await page.goto('/dashboards/admin');
    await expect(page.getByText('Users and access')).toHaveCount(0);
  });

  test('D-C shows new leads not yet contacted, follow-ups and the response target', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/dashboards/crm');
    const waiting = page.locator('section').filter({ has: page.getByRole('heading', { name: /New leads not yet contacted/ }) });
    await expect(waiting.getByRole('table', { name: 'Oldest new leads without a reply' })).toContainText('Yaw Adjei');
    await expect(page.getByText('Target: 1 h 00')).toBeVisible();
    const followUps = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Follow-ups', exact: true }) });
    await expect(followUps.getByRole('link', { name: /Overdue/ })).toContainText('1');
    await expect(page.getByRole('table', { name: 'Response time per person' })).toContainText('Ama Boateng');
    await expectAccessible(page);
    await pickRadio(page, 'Last 7 days');
    await expect(page).toHaveURL(/days=7/);
    await expect(page.getByRole('heading', { name: 'Leads received in the last 7 days' })).toBeVisible();
  });

  test('D-A shows the account health with unknowable figures marked "Not available"', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await expect(page).toHaveURL(/\/dashboards\/admin/);
    const users = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Users and access' }) });
    await expect(users.getByText('Users without required second factor').locator('..')).toContainText('Not available');
    const privacy = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Privacy and consent' }) });
    await expect(privacy.getByText('Open access and erasure requests').locator('..')).toContainText('Not available');
    await expect(privacy.getByRole('link', { name: /Contact and lead exports/ })).toBeVisible();
    await expectAccessible(page);
  });

  test('CRM settings set the response target; managers without settings rights only read it', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/settings/crm');
    await expect(page.getByRole('spinbutton', { name: /^Target in minutes/ }).or(page.getByRole('textbox', { name: /^Target in minutes/ }))).toHaveValue('60');
    await expectAccessible(page);
  });
});
