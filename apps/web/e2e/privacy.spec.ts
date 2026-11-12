import { choose, expect, expectAccessible, pickRadio, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

/**
 * Data-subject request register (gap G3) against the real API: the register
 * with an overdue request, the admin dashboard figure, logging a request from
 * the contact record, verifying identity, producing an access report, and
 * carrying out an erasure, which completes the request. Office staff without
 * the privacy permissions see no register.
 */
test.describe('Privacy requests (gap G3)', () => {
  test('the register lists the overdue request first and the admin dashboard links to it', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/dashboards/admin');
    const privacy = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Privacy and consent' }) });
    await expect(privacy.getByRole('link', { name: /Past their due date/ })).toContainText('1');
    await privacy.getByRole('link', { name: /Open access and erasure requests/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy requests' })).toBeVisible();
    const row = page.getByRole('table', { name: 'Open' }).getByRole('row').filter({ hasText: state.records.privacy.overdueRequest.reference });
    await expect(row).toContainText('Kojo Requester');
    await expect(row).toContainText('5 days overdue');
    await expect(row).toContainText('Received');
    await expectAccessible(page);
    await page.getByRole('navigation', { name: 'Request views' }).getByRole('link', { name: 'Closed' }).click();
    await expect(page.getByText('No closed requests')).toBeVisible();
  });

  test('an access request: verify identity, start work, produce the report and offer the download', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/privacy-requests/${state.records.privacy.overdueRequest.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(state.records.privacy.overdueRequest.reference);
    await expect(page.getByText('Verify the requester\'s identity and start work before fulfilling the request.')).toBeVisible();
    await page.getByRole('button', { name: 'Verify identity' }).click();
    const verify = page.getByRole('alertdialog', { name: "Verify the requester's identity" });
    await choose(page, 'How it was verified', 'Identity documents seen', verify);
    await verify.getByRole('textbox', { name: /^Note/ }).fill('Ghana Card seen at the Osu office');
    await expectAccessible(page);
    await verify.getByRole('button', { name: 'Verify identity' }).click();
    await expect(page.getByText(/Identity documents seen · Kofi Owusu/)).toBeVisible();

    await page.getByRole('button', { name: 'Move on' }).click();
    const move = page.getByRole('alertdialog', { name: /^Move DSR-/ });
    await choose(page, 'New status', 'In progress', move);
    await move.getByRole('button', { name: 'Move on' }).click();
    await expect(page.getByRole('heading', { level: 1 }).locator('..')).toContainText('In progress');

    await page.getByRole('button', { name: 'Produce access report' }).click();
    const report = page.getByRole('alertdialog', { name: /Produce the access report/ });
    await expect(report).toContainText('including protected details');
    await report.getByRole('button', { name: 'Produce access report' }).click();
    await expect(page.getByText(/Report ready until/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download report' })).toBeVisible();
    const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'History' }) });
    await expect(history).toContainText('Access report produced');
    await expect(history).toContainText('Identity verified');
    const evidence = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Evidence' }) });
    await expect(evidence).toContainText('Ghana Card seen at the Osu office');
    await expectAccessible(page);
  });

  test('an erasure request logged from the contact record: merge blocked while open, then carried out after typing ERASE', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/contacts/${state.records.privacy.toErase.id}`);
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Privacy requests' }) });
    await expect(panel).toContainText('No privacy requests.');
    await panel.getByRole('link', { name: 'Log a privacy request' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Log a privacy request' })).toBeVisible();
    await expect(page.getByText('Afua Eraseme')).toBeVisible();
    await pickRadio(page, "Erasure request: delete the person's data");
    await page.getByRole('textbox', { name: /^Summary of the request/ }).fill('Phoned asking us to delete her details');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Log request' }).click();
    await expect(page).toHaveURL(/\/privacy-requests\/[0-9a-f-]{36}$/);
    const reference = (await page.getByRole('heading', { level: 1 }).textContent())!.split('·')[0]!.trim();

    // While the erasure request is open the person cannot be merged.
    const requestUrl = page.url();
    await page.goto(`/contacts/${state.records.crm.amaDuplicate.id}/merge?with=${state.records.privacy.toErase.id}`);
    await expect(page.getByText(`An erasure request (${reference}) is open for one of these contacts. Close it before merging.`)).toBeVisible();
    await page.goto(requestUrl);

    await page.getByRole('button', { name: 'Verify identity' }).click();
    const verify = page.getByRole('alertdialog', { name: "Verify the requester's identity" });
    await choose(page, 'How it was verified', 'Confirmed through contact details we hold', verify);
    await verify.getByRole('button', { name: 'Verify identity' }).click();
    await page.getByRole('button', { name: 'Move on' }).click();
    const move = page.getByRole('alertdialog', { name: /^Move DSR-/ });
    await choose(page, 'New status', 'In progress', move);
    await move.getByRole('button', { name: 'Move on' }).click();

    await page.getByRole('button', { name: 'Carry out erasure' }).click();
    const erase = page.getByRole('alertdialog', { name: 'Erase this person?' });
    await expect(erase.getByRole('button', { name: 'Carry out erasure' })).toBeDisabled();
    await expectAccessible(page);
    await erase.getByRole('textbox', { name: /ERASE/ }).fill('ERASE');
    await erase.getByRole('button', { name: 'Carry out erasure' }).click();
    await expect(page.getByText('Erasure carried out and recorded in the erasure ledger.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).locator('..')).toContainText('Completed');
    await page.getByRole('link', { name: /Erased contact/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Erased contact' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('Afua');
  });

  test('agents have no register and no privacy panel', async ({ page, state }) => {
    await signIn(page, state.users.agent.email, { company: state.companies.accra.name });
    await expect(page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: /Privacy requests/ })).toHaveCount(0);
    const res = await page.goto('/privacy-requests');
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByText('You do not have access')).toBeVisible();
  });
});
