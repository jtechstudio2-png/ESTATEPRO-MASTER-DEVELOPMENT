import { expect, expectAccessible, pickRadio, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

/** Monday-based week containing a UTC day (the seeded office is in Africa/Accra, UTC+0). */
function sameWeek(a: Date, b: Date): boolean {
  const monday = (date: Date) => {
    const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    copy.setUTCDate(copy.getUTCDate() - ((copy.getUTCDay() + 6) % 7));
    return copy.getTime();
  };
  return monday(a) === monday(b);
}

/**
 * Phase 6 screens (P6-W): pipeline board, deals list, deal record and its
 * dialogs, offers, calendar and viewings, forecast, landlord preview and the
 * Sales navigation. Every screen is checked with axe; Arabic (RTL) and 320 px
 * are covered at the end.
 */
test.describe('Sales pipeline screens', () => {
  test('SH-2 Sales navigation and the agent\'s follow-up badge', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    const nav = page.getByRole('navigation', { name: /main/i });
    for (const name of ['Pipeline', 'Deals', 'Calendar', 'Forecast']) await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: /To follow up/ })).toBeVisible();
    await expect(nav.getByLabel(/1 viewing needs an outcome/)).toBeVisible();
  });

  test('PB-1 board: columns with counts and totals; "Move to" explains a later stage instead of moving (W-D1)', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/pipeline');
    await expect(page.getByRole('heading', { level: 1, name: 'Pipeline' })).toBeVisible();
    const column = page.getByRole('region', { name: /^Negotiation/ });
    const card = column.getByRole('listitem').filter({ hasText: state.records.sales.deal.reference });
    await expect(card).toContainText('Kofi Mensah');
    await expect(card).toContainText('1,200,000');
    await expectAccessible(page);
    await card.getByRole('button', { name: `Move to · ${state.records.sales.deal.reference}` }).click();
    await page.getByRole('menuitem', { name: 'Offer accepted' }).click();
    await expect(page.locator('#main').getByText('Accept an offer to reach Offer accepted.')).toBeVisible();
    // The card stayed where it was.
    await expect(page.getByRole('region', { name: /^Negotiation/ })).toContainText(state.records.sales.deal.reference);
  });

  test('DL-1 deals list: search by contact, open the deal', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/deals');
    const table = page.getByRole('table', { name: 'Deals' });
    await expect(table.getByRole('row').filter({ hasText: 'Kofi Mensah' })).toContainText('Negotiation');
    await expectAccessible(page);
    await page.getByRole('searchbox', { name: 'Search reference or contact' }).fill('Kofi');
    await expect(page).toHaveURL(/q=Kofi/);
    await table.getByRole('link', { name: new RegExp(state.records.sales.deal.reference) }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(state.records.sales.deal.reference);
  });

  test('DL-3 deal record: stage path, next step, tabs and read-only timeline (W-A2)', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/deals/${state.records.sales.deal.id}`);
    await expect(page.getByRole('navigation', { name: 'Deal stages' }).locator('[aria-current="step"]')).toHaveText('Negotiation');
    await expect(page.getByRole('heading', { name: 'Next step' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Parties' })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Timeline' }).click();
    await expect(page.getByRole('heading', { name: 'Activity' }).or(page.getByRole('heading', { name: /timeline/i })).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Log/ })).toHaveCount(0);
    await expectAccessible(page);
    await page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'History' }).click();
    await expect(page.getByRole('heading', { name: 'Stage history' })).toBeVisible();
    await expectAccessible(page);
  });

  test('O-1 and O-3 offer chain: accept the offer; the deal moves on and its milestones appear (DL-5)', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/deals/${state.records.sales.deal.id}?tab=offers`);
    const chain = page.getByRole('list', { name: 'Offers and counter-offers' });
    await expect(chain).toContainText('1,100,000');
    await expect(chain).toContainText('Subject to a survey');
    await expectAccessible(page);
    await chain.getByRole('button', { name: /^Accept / }).click();
    const dialog = page.getByRole('alertdialog', { name: /^Accept .* from Kofi Mensah\?/ });
    await expect(dialog).toContainText('The listing');
    await dialog.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(chain).toContainText('Accepted');
    await page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: /^Milestones/ }).click();
    await expect(page.getByRole('heading', { name: 'Milestones' })).toBeVisible();
    await expect(page.locator('#main').getByText('automatic').first()).toBeVisible();
    await expectAccessible(page);
    await page.getByRole('navigation', { name: 'Deal sections' }).getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByRole('navigation', { name: 'Deal stages' }).locator('[aria-current="step"]')).toHaveText('Offer accepted');
    // P6-D6: exchange waits for the buyer's identity check.
    await expect(page.locator('#main').getByText(/1 buyer is not verified/)).toBeVisible();
  });

  test('V-1 calendar: the agent\'s week shows tomorrow\'s viewing; V-3 drawer confirms it', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await page.goto('/calendar');
    const now = new Date();
    if (!sameWeek(now, new Date(now.getTime() + 86_400_000))) await page.getByRole('button', { name: 'Next week' }).click();
    const grid = page.getByRole('table', { name: /^Viewings, / });
    const event = grid.getByRole('button', { name: /4-bed villa, Labone/ }).last();
    await expect(event).toContainText('Scheduled');
    await expectAccessible(page);
    await event.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Kofi Mensah');
    await expectAccessible(page);
    await drawer.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(drawer).toContainText('Confirmed');
  });

  test('V-5 and V-4: record the outcome of the viewing that has happened', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await page.goto('/viewings/follow-up');
    const table = page.getByRole('table', { name: 'Viewings' });
    await expect(table).toContainText('4-bed villa, Labone');
    await expectAccessible(page);
    await table.getByRole('button', { name: /^Outcome… · / }).click();
    const dialog = page.getByRole('alertdialog', { name: 'How did the viewing go?' });
    await expect(dialog).toContainText('cannot be changed once saved');
    await pickRadio(dialog, 'Interested');
    await dialog.getByRole('textbox', { name: 'Feedback' }).fill('Liked the garden; asked about the road noise.');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Nothing to follow up' })).toBeVisible();
  });

  test('FC-1 forecast: per-currency table with the open deal', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/forecast');
    const table = page.getByRole('table', { name: 'Open deals by expected close month' });
    await expect(table.getByRole('row', { name: /No date/ })).toContainText('GHS');
    await expectAccessible(page);
  });

  test('X-L3 listing tabs and LP-1 landlord preview for the sale listing', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/listings/${state.records.sales.saleListing.id}/offers`);
    await expect(page.getByRole('table', { name: 'Offers' })).toContainText('Kofi Mensah');
    await expectAccessible(page);
    await page.goto(`/listings/${state.records.sales.saleListing.id}/deals`);
    await expect(page.getByRole('table', { name: 'Deals' })).toContainText(state.records.sales.deal.reference);
    await page.goto(`/contacts/${state.records.crm.ama.id}/properties`);
    const preview = page.getByRole('region', { name: /What this landlord could see/ }).or(page.locator('section').filter({ hasText: 'What this landlord could see' })).first();
    await preview.getByRole('button', { name: /Listing/ }).click();
    await page.getByRole('option', { name: state.records.sales.saleListing.reference }).click();
    await expect(preview).toContainText('Subject to a survey');
    await expect(preview).toContainText('Never shown to landlords');
    await expect(preview).not.toContainText('+233');
    await expectAccessible(page);
  });

  test('CV-1 convert the buy lead to a deal from the lead record (X-L2)', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/leads/${state.records.crm.agentLead.id}`);
    await page.getByRole('button', { name: 'Convert to deal' }).click();
    const dialog = page.getByRole('alertdialog', { name: /^Convert .* to a deal/ });
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
    await page.waitForURL(/\/deals\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Ama');
    await page.goto(`/leads/${state.records.crm.agentLead.id}`);
    await expect(page.locator('#main').getByText('This lead was converted to a deal.')).toBeVisible();
  });

  test('W-A1 global search finds the deal by reference', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/deals');
    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox', { name: /Search properties, units, listings and deals/ });
    await box.fill(state.records.sales.deal.reference.slice(0, 12));
    await expect(page.getByRole('group', { name: 'Deals' })).toContainText(state.records.sales.deal.reference);
  });

  test('Arabic (RTL) at 320 px and desktop: board, deals, calendar and forecast pass axe', async ({ page, state }) => {
    await signIn(page, state.users.arabic.email);
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ['/pipeline', '/deals', '/calendar', '/forecast', '/viewings/follow-up']) {
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expectAccessible(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${path} at ${width}px scrolls sideways`).toBeLessThanOrEqual(1);
      }
    }
  });

  test('XD-1 and XV-1 on a 320 px phone: stage list instead of the board, agenda instead of the week', async ({ page, state }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await signIn(page, state.users.agent.email);
    await page.goto('/pipeline');
    await expect(page.getByRole('region', { name: 'Stages' })).toBeVisible();
    await expectAccessible(page);
    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: /^Tomorrow/ })).toBeVisible();
    await expectAccessible(page);
    await page.goto(`/deals/${state.records.sales.deal.id}`);
    await expect(page.getByRole('heading', { name: 'Milestones' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Agents and splits' })).toHaveCount(0);
    await expectAccessible(page);
  });
});
