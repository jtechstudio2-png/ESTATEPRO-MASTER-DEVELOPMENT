import { choose, expect, expectAccessible, pickRadio, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

/**
 * Contacts (wireframes C-1 to C-6, B-1, B-2, SE-1, LL-1; Phase 5 milestone
 * C5) against the real API: masking, duplicates, reveal with reason and
 * step-up, consent, merge, identity checks, requirements, the landlord
 * preview, exports with a purpose, and scope (agent, other company).
 */
test.describe('CRM contacts (C-1 to C-6)', () => {
  test('C-1 lists contacts with masked phones and relationship views', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/contacts');
    const table = page.getByRole('table', { name: 'Contacts' });
    const ama = table.getByRole('row').filter({ hasText: 'Ama Owusu' }).first();
    await expect(ama).toContainText('Buyer · Landlord');
    await expect(ama).toContainText('+23324•••4412');
    await expect(table).not.toContainText('555 4412');
    await expectAccessible(page);

    await page.getByRole('navigation', { name: 'Contact views' }).getByRole('link', { name: 'Landlords' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Landlords' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Landlords contacts' })).toContainText('Ama Owusu');
    await expect(page.getByRole('table', { name: 'Landlords contacts' })).not.toContainText('Esi Sarpong');

    await page.getByRole('navigation', { name: 'Contact views' }).getByRole('link', { name: 'Sellers' }).click();
    const sellers = page.getByRole('table', { name: 'Sellers contacts' });
    await expect(sellers.getByRole('row').filter({ hasText: 'Esi Sarpong' })).toContainText('In review');
  });

  test('C-2 shows the record with roles, the consent warning and the latest activity', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/contacts/${state.records.crm.ama.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Ama Owusu' })).toBeVisible();
    await expect(page.getByText(/Marketing consent withdrawn .* \(Email\)/)).toBeVisible();
    const methods = page.getByRole('region', { name: 'Contact methods' }).or(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Contact methods' }) }));
    await expect(methods.first()).toContainText('★Primary');
    await expect(page.getByRole('link', { name: 'Call Ama Owusu' })).toHaveAttribute('href', 'tel:+233245554412');
    for (const tab of ['Overview', 'Activity', 'Leads', 'Requirements', 'Properties', 'Identity', 'Consent']) {
      await expect(page.getByRole('navigation', { name: 'Contact sections' }).getByRole('link', { name: tab })).toBeVisible();
    }
    await expectAccessible(page);
  });

  test('C-3 warns about a duplicate phone, records the choice and creates the contact', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/contacts/new?role=buyer');
    await page.getByRole('textbox', { name: /^Display name/ }).fill('Akosua Mensah');
    await page.getByRole('textbox', { name: /^Mobile/ }).fill('024 555 4412');
    await page.getByRole('textbox', { name: /^Email/ }).focus();
    const duplicate = page.getByRole('region', { name: 'Possible duplicate' });
    await expect(duplicate).toContainText('Ama Owusu');
    await expect(duplicate).toContainText('has the same phone number.');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Create contact' }).click();
    // Saving without a decision is refused by the API and shows the same panel.
    await expect(duplicate).toBeVisible();
    await duplicate.getByRole('button', { name: 'Not the same person: continue' }).click();
    await expect(duplicate).toContainText('You confirmed this is a different person.');
    await page.getByRole('button', { name: 'Create contact' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Akosua Mensah' })).toBeVisible();
    await expect(page.getByText('Buyer', { exact: true }).first()).toBeVisible();
  });

  test('C-5 shows protected details masked and reveals one for a reason, then hides it', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/contacts/${state.records.crm.ama.id}/identity`);
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Identity and sensitive details' }) });
    await expect(panel).toContainText('•••• 4821');
    await expect(panel).not.toContainText('GHA-7788');
    await panel.getByRole('button', { name: 'Reveal Tax number' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reveal Tax number' });
    await dialog.getByRole('button', { name: 'Reveal' }).click();
    await expect(dialog.getByText(/Describe the reason in at least 10 characters/)).toBeVisible();
    await dialog.getByRole('textbox', { name: /^Details/ }).fill('Sale of Labone Villa, deed of transfer');
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Reveal' }).click();
    await expect(panel).toContainText('GHA-7788-4821');
    await expect(panel).toContainText(/Hides in \d+ s/);
    await panel.getByRole('button', { name: 'Hide' }).click();
    await expect(panel).not.toContainText('GHA-7788-4821');
    await expect(panel).toContainText('•••• 4821');
  });

  test('C-5 asks for a fresh second-factor sign-in once the reveal window has passed, then reveals', async ({ page, state }) => {
    test.setTimeout(120_000);
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/contacts/${state.records.crm.ama.id}/identity`);
    // The e2e API allows reveals for 30 seconds after a second-factor sign-in (production: 5 minutes).
    await page.waitForTimeout(31_000);
    await page.getByRole('button', { name: 'Reveal Tax number' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reveal Tax number' });
    await dialog.getByRole('textbox', { name: /^Details/ }).fill('Sale of Labone Villa, deed of transfer');
    await dialog.getByRole('button', { name: 'Reveal' }).click();
    await expect(dialog.getByText('Sign in again to reveal')).toBeVisible();
    await expect(dialog).not.toContainText('GHA-7788-4821');
    await expectAccessible(page);
    await dialog.getByRole('link', { name: 'Sign in again to continue' }).click();
    await page.getByLabel('Email').fill(state.users.owner.email);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(new RegExp(`/contacts/${state.records.crm.ama.id}/identity`));
    await page.getByRole('button', { name: 'Reveal Tax number' }).click();
    const again = page.getByRole('dialog', { name: 'Reveal Tax number' });
    await again.getByRole('textbox', { name: /^Details/ }).fill('Sale of Labone Villa, deed of transfer');
    await again.getByRole('button', { name: 'Reveal' }).click();
    await expect(page.getByText('GHA-7788-4821')).toBeVisible();
  });

  test('C-6 shows the current consent, keeps history and records a new consent', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/contacts/${state.records.crm.ama.id}/consent`);
    const current = page.getByRole('table', { name: 'Current consent by purpose and channel' });
    await expect(current.getByRole('row').filter({ hasText: 'Marketing' })).toContainText('Withdrawn');
    await page.getByRole('button', { name: 'Show full history' }).click();
    await expect(page.getByRole('table', { name: 'Full consent history, newest first' }).getByRole('row')).toHaveCount(3);
    await page.getByRole('button', { name: 'Record consent' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record consent or withdrawal' });
    await choose(page, 'Purpose', 'Property alerts', dialog);
    await choose(page, 'Channel', 'WhatsApp', dialog);
    await dialog.getByRole('textbox', { name: /^Evidence/ }).fill('Asked on the phone');
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Record consent' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Show current only' }).click();
    await expect(page.getByRole('table', { name: 'Current consent by purpose and channel' }).getByRole('row').filter({ hasText: 'Property alerts' })).toContainText('Granted');
  });

  test('C-4 compares two contacts, lets the user choose fields and merges after typing MERGE', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/contacts/${state.records.crm.amaDuplicate.id}`);
    await page.getByRole('button', { name: 'More actions for Ama Owusu-Boateng' }).click();
    await page.getByRole('menuitem', { name: 'Merge with another contact' }).click();
    const chooser = page.getByRole('dialog', { name: 'Merge Ama Owusu-Boateng with…' });
    await chooser.getByRole('searchbox', { name: 'Search name, phone, email or reference' }).fill('Akosua');
    await chooser.getByRole('button', { name: 'Compare with Akosua Mensah' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Merge contacts' })).toBeVisible();
    const fields = page.getByRole('table', { name: 'Choose, for each field, which value the kept record has' });
    await expect(fields.getByRole('row').filter({ hasText: 'Display name' })).toContainText('Akosua Mensah');
    await expectAccessible(page);
    // Keep Akosua's record and take the email from the merged record.
    await page.getByRole('button', { name: 'Keep the other record instead' }).click();
    await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Record to keep' }) })).toContainText(/Keep\s+Akosua Mensah.*and merge\s+Ama Owusu-Boateng/);
    await fields.getByRole('row').filter({ hasText: 'Email' }).getByRole('radio', { name: 'Merged' }).check();
    await page.getByRole('button', { name: 'Merge 2 contacts' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Merge these contacts?' });
    await expect(confirm.getByRole('button', { name: 'Merge 2 contacts' })).toBeDisabled();
    await confirm.getByRole('textbox', { name: 'Type MERGE to confirm' }).fill('MERGE');
    await confirm.getByRole('button', { name: 'Merge 2 contacts' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Akosua Mensah' })).toBeVisible();
    await expect(page.getByText('Buyer · Tenant').first()).toBeVisible();
    await expect(page.getByText('ama.ob@example.test')).toBeVisible();
    // The merged record stays for the audit trail and points to the kept one.
    await page.goto(`/contacts/${state.records.crm.amaDuplicate.id}`);
    await expect(page.getByText('This contact was merged into another record.')).toBeVisible();
  });

  test('SE-1 and KYC: a manager signs off an identity check once, with a risk rating', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/contacts/${state.records.crm.seller.id}/identity`);
    await expect(page.getByText('•••• 4567')).toBeVisible();
    const checks = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Identity checks' }) });
    await expect(checks).toContainText('In review');
    await checks.getByRole('button', { name: 'More actions for the Identity check' }).click();
    await page.getByRole('menuitem', { name: 'Approve' }).click();
    const approve = page.getByRole('alertdialog', { name: 'Approve the Identity check?' });
    await expectAccessible(page);
    await approve.getByRole('button', { name: 'Approve' }).click();
    await expect(checks).toContainText('Verified');
    await expect(checks).toContainText('Risk: Low');
    // Signed off: no further decision is offered.
    await expect(checks.getByRole('button', { name: 'More actions for the Identity check' })).toHaveCount(0);
  });

  test('B-1 and B-2 list requirements by budget and show matches from published listings only', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/requirements');
    const table = page.getByRole('table', { name: 'Requirements' });
    await expect(table.getByRole('row').filter({ hasText: 'Ama Owusu' })).toContainText('East Legon');
    await expectAccessible(page);
    await page.goto(`/contacts/${state.records.crm.ama.id}/requirements`);
    await page.getByRole('button', { name: /for the Buy requirement$/ }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Matches · Ama Owusu' });
    await expect(drawer.getByRole('heading', { name: 'No published listing matches' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Add requirement' }).click();
    const form = page.getByRole('dialog', { name: 'New requirement · Ama Owusu' });
    await pickRadio(form, 'Rent');
    await form.getByRole('textbox', { name: /^Maximum price/ }).fill('5000');
    await form.getByRole('textbox', { name: /^Minimum price/ }).fill('8000');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByText('The maximum must not be less than the minimum.').first()).toBeVisible();
    await form.getByRole('textbox', { name: /^Minimum price/ }).fill('4000');
    await form.getByRole('textbox', { name: /^Area or neighbourhood/ }).fill('Osu');
    await form.getByRole('button', { name: 'Add area' }).click();
    await expectAccessible(page);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toBeHidden();
    await expect(page.getByText('Osu', { exact: true })).toBeVisible();
  });

  test('LL-1 shows what the landlord owns and what the portal would show, from the same resolver', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/contacts/${state.records.crm.ama.id}/properties`);
    await expect(page.getByRole('link', { name: /Labone Villa/ })).toBeVisible();
    await expect(page.getByText(/Owner, 100 % · from/)).toBeVisible();
    const preview = page.locator('section').filter({ has: page.getByRole('heading', { name: 'What this landlord could see in the portal' }) });
    await expect(preview).toContainText('Visible: Labone Villa');
    await expect(preview).toContainText('Not visible:');
    await expectAccessible(page);
  });

  test('CA-16 exports contacts only with a purpose, and lists the export for its requester', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/contacts?view=landlord');
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export contacts' });
    await expect(dialog).toContainText('Never included: identity, tax or bank numbers');
    await dialog.getByRole('button', { name: 'Make export' }).click();
    await expect(dialog.getByText('Enter a purpose of at least 5 characters.').first()).toBeVisible();
    await dialog.getByRole('textbox', { name: /^Purpose/ }).fill('Q4 landlord mail-out');
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Make export' }).click();
    await expect(dialog.getByText(/Export ready: 1 row/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await page.goto('/exports');
    const row = page.getByRole('table', { name: 'Exports' }).getByRole('row').filter({ hasText: 'Contacts' }).first();
    await expect(row).toContainText('Ready');
    await expect(row.getByRole('button', { name: /^Download / })).toBeVisible();
    await expectAccessible(page);
  });

  test('agents see the contacts behind their leads, read only, and cannot export or reveal', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await page.goto('/contacts');
    const table = page.getByRole('table', { name: 'Contacts' });
    await expect(table).toContainText('Ama Owusu');
    await expect(table).not.toContainText('Esi Sarpong');
    await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
    await page.goto(`/contacts/${state.records.crm.ama.id}`);
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0);
    await page.goto(`/contacts/${state.records.crm.seller.id}`);
    await expect(page.getByRole('heading', { name: 'Contact not found' })).toBeVisible();
  });

  test('another company never sees these contacts', async ({ page, state }) => {
    await signIn(page, state.users.arabic.email);
    await page.goto(`/contacts/${state.records.crm.ama.id}`);
    await expect(page.getByText('Ama Owusu')).toHaveCount(0);
    await page.goto('/contacts');
    await expect(page.getByRole('link', { name: /أحمد الكواري/ })).toBeVisible();
    await expect(page.getByText('Ama Owusu')).toHaveCount(0);
  });
});
