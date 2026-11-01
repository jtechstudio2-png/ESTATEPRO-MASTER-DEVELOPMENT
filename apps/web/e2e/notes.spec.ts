import { choose, expect, expectAccessible, pickRadio, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

test.describe('Property notes (N-1 to N-4, issue #7)', () => {
  test('N-1 shows pinned notes first with their audience as text', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/properties/${state.records.osuCourt.id}/notes`);
    const pinned = page.getByRole('region', { name: /Pinned \(1 of 5\)/ });
    await expect(pinned).toContainText('Gate sticks; lift and push.');
    await expect(pinned).toContainText('Internal');
    await expect(page.getByRole('navigation', { name: 'Note views' }).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
    await expectAccessible(page);
  });

  test('N-2 shares a note with the tenants of a unit only after choosing the unit and confirming', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/properties/${state.records.osuCourt.id}/notes`);
    await page.getByRole('button', { name: 'Add note' }).click();
    const composer = page.getByRole('region', { name: 'Add note' });
    await composer.getByRole('textbox', { name: /^Note/ }).fill('Water is shut off on Tuesdays from 9 to 11.');
    await expect(composer.getByText('43 of 10000 characters')).toBeVisible();
    await choose(page, 'Category', 'Maintenance', composer);
    await pickRadio(composer, 'Staff and the tenants of a unit (choose a unit)');
    await composer.getByRole('button', { name: 'Save note' }).click();
    await expect(composer.getByRole('alert')).toContainText('Choose a unit: tenant-visible notes belong to a unit.');
    await choose(page, 'Unit', 'Flat 1B', composer);
    await composer.getByRole('button', { name: 'Save note' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Share this note?' });
    await expect(confirm).toContainText('visible to the tenants of Flat 1B');
    await expectAccessible(page);
    await confirm.getByRole('button', { name: 'Share' }).click();
    await expect(composer).toBeHidden();
    const note = page.getByRole('listitem').filter({ hasText: 'Water is shut off' });
    await expect(note).toContainText('Tenant-visible (Flat 1B)');
    await expect(note).toContainText('Maintenance');
  });

  test('N-2 and N-3 edit a note and show its earlier wording', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/properties/${state.records.osuCourt.id}/notes?filter[category]=maintenance`);
    const note = page.getByRole('listitem').filter({ hasText: 'Water is shut off' });
    await note.getByRole('button', { name: 'More actions for this note' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const editor = page.getByRole('region', { name: 'Edit note' });
    await editor.getByRole('textbox', { name: /^Note/ }).fill('Water is shut off on Tuesdays from 9 to 12.');
    await editor.getByRole('button', { name: 'Save note' }).click();
    await expect(editor).toBeHidden();
    await expect(note).toContainText('edited');
    await note.getByRole('button', { name: 'More actions for this note' }).click();
    await page.getByRole('menuitem', { name: 'History' }).click();
    const drawer = page.getByRole('dialog', { name: /^History · note by / });
    await expect(drawer).toContainText('Current (v2)');
    await expect(drawer).toContainText('from 9 to 12.');
    await expect(drawer).toContainText('v1 · written');
    await expect(drawer).toContainText('from 9 to 11.');
    await expectAccessible(page);
  });

  test('N-4 archives with a reason, restores, and redacts every version', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/properties/${state.records.osuCourt.id}/notes?filter[category]=maintenance`);
    const note = page.getByRole('listitem').filter({ hasText: 'Water is shut off' });
    await note.getByRole('button', { name: 'More actions for this note' }).click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    const archive = page.getByRole('alertdialog', { name: 'Archive note?' });
    await archive.getByRole('button', { name: 'Archive note' }).click();
    await expect(archive.getByText('Enter a reason.')).toBeVisible();
    await archive.getByRole('textbox', { name: /Reason/ }).fill('Supply fixed');
    await archive.getByRole('button', { name: 'Archive note' }).click();
    await expect(note).toBeHidden();

    await page.goto(`/properties/${state.records.osuCourt.id}/notes?filter[archived]=true`);
    const archived = page.getByRole('listitem').filter({ hasText: 'Water is shut off' });
    await expect(archived).toContainText('Supply fixed');
    await archived.getByRole('button', { name: 'More actions for this note' }).click();
    await page.getByRole('menuitem', { name: 'Restore' }).click();
    await page.getByRole('alertdialog', { name: 'Restore note?' }).getByRole('button', { name: 'Restore note' }).click();
    await expect(archived).toBeHidden();

    await page.goto(`/properties/${state.records.osuCourt.id}/notes?filter[category]=maintenance`);
    await note.getByRole('button', { name: 'More actions for this note' }).click();
    await page.getByRole('menuitem', { name: 'Redact' }).click();
    const redact = page.getByRole('alertdialog', { name: 'Redact note?' });
    await pickRadio(redact, 'Sensitive data');
    await redact.getByRole('button', { name: 'Redact note' }).click();
    await expect(redact).toBeHidden();
    await expect(page.getByText('Water is shut off')).toHaveCount(0);
    const redacted = page.getByRole('listitem').filter({ hasText: '[Redacted]' });
    await redacted.getByRole('button', { name: 'More actions for this note' }).click();
    await page.getByRole('menuitem', { name: 'History' }).click();
    const drawer = page.getByRole('dialog', { name: /^History · note by / });
    // The current text and the one earlier version (archive and restore do not add versions).
    await expect(drawer.getByText('[Redacted]')).toHaveCount(2);
    await expect(drawer).not.toContainText('Water is shut off');
  });

  test('N-2 lets agents write staff-only notes; external audiences are for managers', async ({ page, state }) => {
    await signIn(page, state.users.agent.email, { company: state.companies.accra.name });
    await page.goto(`/properties/${state.records.osuCourt.id}/notes`);
    await page.getByRole('button', { name: 'Add note' }).click();
    const composer = page.getByRole('region', { name: 'Add note' });
    await expect(composer.getByRole('radio', { name: /Staff and landlord — managers only/ })).toBeDisabled();
    await expect(composer.getByRole('radio', { name: 'Staff only' })).toBeChecked();
    await expectAccessible(page);
  });
});
