import { choose, expect, expectAccessible, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

test.describe('Field use on phones and tablets (X-1 to X-3, T-1, T-2, issue #7)', () => {
  test('X-1 puts directions, map, photos, notes and keys one tap away on a phone', async ({ page, state }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/properties/${state.records.osuCourt.id}`);
    const actions = page.getByRole('navigation', { name: 'Field actions' });
    const directions = actions.getByRole('link', { name: /Directions/ });
    await expect(directions).toHaveAttribute('href', /destination=5\.5571%2C-0\.1818$/);
    await expect(directions).toHaveAttribute('target', '_blank');
    await expect(actions.getByRole('link', { name: 'Map', exact: true })).toHaveAttribute('href', /\/map\/properties\?filter\[bbox\]=/);
    await expect(page.getByText('Gate sticks; lift and push.')).toBeVisible();
    await expectAccessible(page);
    await actions.getByRole('link', { name: 'Add photos' }).click();
    await expect(page.getByRole('dialog', { name: 'Upload photos' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Upload photos' }).getByRole('textbox', { name: /Room/ })).toBeVisible();
  });

  test('X-3 opens the composer full screen and keeps the draft in memory when the session ends', async ({ page, context, state }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/properties/${state.records.osuCourt.id}`);
    await page.getByRole('navigation', { name: 'Field actions' }).getByRole('link', { name: 'Add note' }).click();
    const composer = page.getByRole('region', { name: 'Add note' });
    await expect(composer).toBeVisible();
    const box = (await composer.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(389);
    await composer.getByRole('textbox', { name: /^Note/ }).fill('Side gate padlock replaced; new key in the office.');

    // The session ends while the draft is open.
    await context.clearCookies();
    await composer.getByRole('button', { name: 'Save note' }).click();
    const banner = page.getByRole('alert').filter({ hasText: 'Your changes are still on this page.' });
    await expect(banner).toContainText('Your session has ended');
    await expect(page).toHaveURL(new RegExp(`/properties/${state.records.osuCourt.id}/notes`));
    await expect(composer.getByRole('textbox', { name: /^Note/ })).toHaveValue('Side gate padlock replaced; new key in the office.');

    // Sign in again in another tab, then come back and save.
    const other = await context.newPage();
    await signIn(other, state.users.owner.email, { company: state.companies.accra.name });
    await other.close();
    await banner.getByRole('button', { name: 'I have signed in' }).click();
    await expect(banner).toBeHidden();
    await composer.getByRole('button', { name: 'Save note' }).click();
    await expect(composer).toBeHidden();
    await expect(page.getByRole('listitem').filter({ hasText: 'Side gate padlock replaced' })).toBeVisible();
  });

  test('T-1 field visit on a tablet saves the visit notes as a Viewing note', async ({ page, state }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/properties/${state.records.osuCourt.id}`);
    await page.getByRole('navigation', { name: 'Field actions' }).getByRole('link', { name: 'Field visit' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Field visit · Osu Court' })).toBeVisible();
    await expect(page.getByText('A guide for this visit; the ticks are not saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Save visit' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'There is a problem' })).toContainText('Enter the visit notes.');
    await choose(page, 'Unit', 'Flat 1B');
    await expect(page.getByRole('heading', { level: 1, name: 'Field visit · Osu Court · Flat 1B' })).toBeVisible();
    await page.locator('label').filter({ hasText: 'Confirm access' }).click();
    await page.getByRole('textbox', { name: /Visit notes/ }).fill('Client liked the light; asked about parking.');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Save visit' }).click();
    await expect(page).toHaveURL(/filter%5Bcategory%5D=viewing|filter\[category\]=viewing/);
    const note = page.getByRole('listitem').filter({ hasText: 'Client liked the light' });
    await expect(note).toContainText('Viewing');
    await expect(note).toContainText('Internal');
  });

  test('T-2 shows the map and the list together on a tablet: stacked in portrait, side by side in landscape', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/map/properties');
    const map = page.getByRole('region', { name: 'Properties map', exact: true });
    const list = page.getByRole('list', { name: 'Properties' });
    await expect(map).toBeVisible();
    await expect(list).toBeVisible();
    expect((await map.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y);
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(map).toBeVisible();
    expect((await list.boundingBox())!.x).toBeLessThan((await map.boundingBox())!.x);
    await expectAccessible(page);
  });
});
