import { choose, expect, expectAccessible, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

test.describe('Gallery and floor plans (G-1 to G-8, issue #7)', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
  });

  test('G-2 uploads a photo straight to storage and follows processing until ready; refuses a wrong type', async ({ page, state }) => {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(`/properties/${state.records.osuCourt.id}`);
    // A real image to upload: a screenshot of the overview (PNG, 1000 × 750).
    const image = await page.screenshot({ clip: { x: 0, y: 0, width: 1000, height: 750 } });
    await page.goto(`/properties/${state.records.osuCourt.id}/media`);
    await expect(page.getByRole('heading', { name: 'No photos yet' })).toBeVisible();
    await page.getByRole('button', { name: 'Upload photos' }).click();
    const panel = page.getByRole('dialog', { name: 'Upload photos' });
    await expect(panel.getByText('Location data is removed from every photo.')).toBeVisible();
    await expectAccessible(page);
    await panel.locator('input[type=file][multiple]').setInputFiles([
      { name: 'front.png', mimeType: 'image/png', buffer: image },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
    ]);
    const queue = panel.getByRole('list', { name: 'Upload queue' });
    await expect(queue.getByRole('listitem').filter({ hasText: 'notes.txt' })).toContainText('Not allowed here');
    await expect(queue.getByRole('listitem').filter({ hasText: 'front.png' })).toContainText('Ready', { timeout: 90_000 });
    await panel.getByRole('button', { name: 'Close' }).click();
    const grid = page.getByRole('list', { name: 'Photos' });
    await expect(grid.locator('img')).toHaveCount(1);
    await expect(grid.locator('img')).toHaveAttribute('src', /^http:\/\/127\.0\.0\.1:8333\//);
  });

  test('G-3 describes the photo for screen-reader users', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.osuCourt.id}/media`);
    await page.getByRole('button', { name: /^Details: / }).first().click();
    const drawer = page.getByRole('dialog', { name: /^Photo · / });
    await drawer.getByLabel('Caption').fill('Front of the building');
    await drawer.getByLabel('Alt text').fill('Four-storey white apartment block with balconies');
    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Details saved.')).toBeAttached();
    await expect(drawer.getByText('Not used in any listing.')).toBeVisible();
    await expectAccessible(page);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('list', { name: 'Photos' })).toContainText('Front of the building');
  });

  test('G-6 adds the photo to the listing gallery as its cover', async ({ page, state }) => {
    await page.goto(`/listings/${state.records.listing.id}/gallery`);
    await expect(page.getByRole('heading', { name: /In this listing \(0 \/ 60 photos/ })).toBeVisible();
    await page.getByRole('checkbox', { name: /Select Front of the building/ }).check({ force: true });
    await page.getByRole('button', { name: 'Add selected' }).click();
    await page.getByRole('button', { name: 'Save gallery' }).click();
    await expect(page.getByText('Gallery saved.')).toBeAttached();
    await expect(page.getByRole('heading', { name: /In this listing \(1 \/ 60 photos/ })).toBeVisible();
    await expect(page.getByText('Cover', { exact: true })).toBeAttached();
    await expectAccessible(page);
  });

  test('G-5 adds a video link without embedding a player', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.osuCourt.id}/media?type=links`);
    await page.getByRole('button', { name: 'Add video or tour' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add video or tour' });
    await dialog.getByLabel(/^Link/).fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await expect(dialog.getByRole('status')).toContainText('Recognised: YouTube');
    await dialog.getByRole('button', { name: 'Add' }).click();
    await expect(dialog).toBeHidden();
    const link = page.getByRole('link', { name: 'Open link' });
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(page.locator('iframe')).toHaveCount(0);
  });

  test('G-1 and G-7 archive the photo, show it with its deletion date, and restore it', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.osuCourt.id}/media`);
    await page.getByRole('button', { name: /More actions for Front of the building/ }).click();
    await page.getByRole('menuitem', { name: 'Archive' }).click();
    const confirm = page.getByRole('alertdialog', { name: /Archive Front of the building/ });
    await confirm.getByLabel(/Reason/).fill('Taken before repainting');
    await confirm.getByRole('button', { name: /^Archive Front/ }).click();
    await page.getByRole('link', { name: 'Archived' }).click();
    const table = page.getByRole('table', { name: 'Archived' });
    await expect(table.getByRole('rowheader')).toContainText('Front of the building');
    await expect(page.getByText('Archived items are deleted for good 90 days after archiving.')).toBeVisible();
    await expectAccessible(page);
    await table.getByRole('button', { name: /More actions for Front/ }).click();
    await page.getByRole('menuitem', { name: 'Restore' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /^Restore Front/ }).click();
    await expect(table.getByRole('rowheader')).toHaveCount(0);
  });

  test('G-4 uploads a floor plan as a plan and G-8 shows storage', async ({ page, state }) => {
    await page.goto(`/properties/${state.records.osuCourt.id}`);
    const plan = await page.screenshot({ clip: { x: 0, y: 0, width: 1000, height: 850 } });
    await page.goto(`/properties/${state.records.osuCourt.id}/media?type=plans`);
    await page.getByRole('button', { name: 'Upload floor plan' }).click();
    const panel = page.getByRole('dialog', { name: 'Upload plans and documents' });
    await choose(page, 'Document type', 'Floor plan', panel);
    await panel.locator('input[type=file][multiple]').setInputFiles({ name: 'ground-floor.png', mimeType: 'image/png', buffer: plan });
    await expect(panel.getByRole('list', { name: 'Upload queue' })).toContainText('Ready', { timeout: 90_000 });
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('table', { name: 'Plans and documents' }).getByRole('rowheader')).toContainText('ground-floor.png');
    await page.goto('/settings/storage');
    await expect(page.getByRole('heading', { level: 1, name: 'Storage' })).toBeVisible();
    await expect(page.getByText(/^Used /)).toBeVisible();
    await expectAccessible(page);
  });
});
