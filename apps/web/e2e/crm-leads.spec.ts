import type { Page } from '@playwright/test';

import { choose, expect, expectAccessible, pickRadio, signIn, test } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

/** Picks a staff member in a people picker by typing part of the name. */
async function pickPerson(page: Page, label: string | RegExp, name: string, scope = page.locator('body')): Promise<void> {
  const box = scope.getByRole('combobox', { name: label });
  await box.fill(name.slice(0, 3));
  await page.getByRole('option', { name: new RegExp(name) }).click();
}

/**
 * Leads (L-1 to L-4), activity (A-1, A-2) and follow-ups (F-1, F-2): the
 * inbox, assignment by a manager, allowed status changes, logging a call
 * (first response), editing within the window, follow-ups mine and team.
 */
test.describe('CRM leads, activity and follow-ups', () => {
  test('L-1 inbox shows the new portal lead with the first line of its message; unassigned is a manager view', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/leads');
    const inbox = page.getByRole('table', { name: 'Inbox: new' });
    const row = inbox.getByRole('row').filter({ hasText: 'Yaw Adjei' });
    await expect(row).toContainText('Is the flat still available?');
    await expect(row).toContainText('Unassigned');
    await expectAccessible(page);
    await page.getByRole('navigation', { name: 'Lead views' }).getByRole('link', { name: 'Unassigned' }).click();
    await expect(page.getByRole('table', { name: 'Unassigned' })).toContainText('Yaw Adjei');
  });

  test('L-2 and L-4 assign the lead, change its status and keep the history', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/leads/${state.records.crm.portalLead.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Yaw Adjei');
    await page.getByRole('button', { name: 'Assign', exact: true }).click();
    const assign = page.getByRole('alertdialog', { name: /^Assign · / });
    await pickPerson(page, /^Assign to/, 'Ama Boateng', assign);
    await assign.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(assign).toBeHidden();
    await expect(page.getByText('Assigned to Ama Boateng').first()).toBeVisible();

    await page.getByRole('button', { name: 'Change status' }).click();
    const status = page.getByRole('alertdialog', { name: /^Change status · / });
    await choose(page, 'New status', 'Lost', status);
    await status.getByRole('button', { name: 'Change status' }).click();
    await expect(status.getByText('Choose why the lead was lost.').first()).toBeVisible();
    await choose(page, 'New status', 'Contacted', status);
    await expectAccessible(page);
    await status.getByRole('button', { name: 'Change status' }).click();
    await expect(status).toBeHidden();
    const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Status history' }) });
    await expect(history).toContainText('New → Contacted');
    const assignments = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Assignments' }) });
    await expect(assignments).toContainText('To Ama Boateng, by Kofi Owusu');
  });

  test('A-2 logs a call on the lead; A-1 shows it, and the author edits it within the window', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/leads/${state.records.crm.portalLead.id}`);
    await page.getByRole('button', { name: 'Log activity' }).first().click();
    const log = page.getByRole('dialog', { name: 'Log activity' });
    await choose(page, 'Outcome', 'Interested', log);
    await log.getByRole('textbox', { name: /^Notes/ }).fill('Wants an evening viewing on Saturday.');
    await expectAccessible(page);
    await log.getByRole('button', { name: 'Save activity' }).click();
    await expect(log).toBeHidden();
    const timeline = page.getByRole('list', { name: 'Activity entries' });
    const entry = timeline.getByRole('listitem').filter({ hasText: 'Wants an evening viewing' });
    await expect(entry).toContainText('Call');
    await expect(entry).toContainText('Outbound');
    await expect(entry).toContainText('Outcome: Interested');
    await expect(page.getByText('First response')).toBeVisible();

    await entry.getByRole('button', { name: /^More actions for Call/ }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit activity' });
    await edit.getByRole('textbox', { name: /^Notes/ }).fill('Wants an evening viewing on Sunday.');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();
    const edited = timeline.getByRole('listitem').filter({ hasText: 'on Sunday' });
    await expect(edited).toContainText('(edited)');
    await edited.getByRole('button', { name: /^More actions for Call/ }).click();
    await page.getByRole('menuitem', { name: 'Earlier versions' }).click();
    const drawer = page.getByRole('dialog', { name: 'Earlier versions' });
    await expect(drawer).toContainText('on Saturday');
    await expect(drawer).toContainText('on Sunday');
  });

  test('F-1 schedules a follow-up on the lead in the member’s time zone', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto(`/leads/${state.records.crm.portalLead.id}`);
    await page.getByRole('button', { name: 'Schedule follow-up' }).click();
    const dialog = page.getByRole('dialog', { name: 'Schedule follow-up' });
    await dialog.getByRole('textbox', { name: /^What/ }).fill('Confirm Saturday viewing');
    await dialog.getByRole('button', { name: 'Tomorrow 10:00' }).click();
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Schedule' }).click();
    await expect(dialog).toBeHidden();
    const next = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Next action' }) });
    await expect(next).toContainText('Confirm Saturday viewing');
  });

  test('L-3 captures a lead for an existing contact found by phone', async ({ page }) => {
    await signIn(page, 'kofi.owner@accra.test', { company: 'Accra Homes Ltd' });
    await page.goto('/leads/new');
    await page.getByRole('combobox', { name: 'Find contact' }).fill('Esi');
    await page.getByRole('option', { name: /Esi Sarpong/ }).click();
    await choose(page, 'Type', 'Valuation');
    await choose(page, 'Source', 'Referral');
    await page.getByRole('textbox', { name: /^Message/ }).fill('Would like a valuation of her flat.');
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Create lead' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Esi Sarpong');
    await expect(page.getByText('Would like a valuation of her flat.')).toBeVisible();
  });

  test('L-3 creates a new contact in place, running the duplicate check', async ({ page }) => {
    await signIn(page, 'kofi.owner@accra.test', { company: 'Accra Homes Ltd' });
    await page.goto('/leads/new');
    await pickRadio(page, 'A new contact');
    await page.getByRole('textbox', { name: /^Name/ }).fill('Kwesi Appiah');
    await page.getByRole('textbox', { name: /^Mobile/ }).fill('+233 20 777 7781');
    await page.getByRole('textbox', { name: /^Email/ }).focus();
    await expect(page.getByRole('region', { name: 'Possible duplicate' })).toContainText('Yaw Adjei');
    await page.getByRole('button', { name: 'Not the same person: continue' }).click();
    await choose(page, 'Source', 'Walk-in');
    await page.getByRole('button', { name: 'Create lead' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Kwesi Appiah');
  });

  test('F-2 the agent marks the overdue follow-up done', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await page.goto('/follow-ups?range=overdue');
    const list = page.getByRole('table', { name: 'My follow-ups' });
    const row = list.getByRole('row').filter({ hasText: 'Call Ama about East Legon options' });
    await expect(row).toContainText('Overdue');
    await expect(page.getByRole('navigation', { name: 'Whose follow-ups' })).toHaveCount(0);
    await expectAccessible(page);
    await row.getByRole('button', { name: 'Done: Call Ama about East Legon options' }).click();
    await page.getByRole('alertdialog', { name: 'Mark as done?' }).getByRole('button', { name: 'Mark done' }).click();
    await expect(page.getByRole('heading', { name: 'Nothing overdue' })).toBeVisible();
    await page.goto('/follow-ups?range=done');
    await expect(page.getByRole('table', { name: 'My follow-ups' })).toContainText('Call Ama about East Legon options');
  });

  test('F-2 managers see their team’s follow-ups', async ({ page, state }) => {
    await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
    await page.goto('/follow-ups?tab=team');
    await expect(page.getByRole('table', { name: 'Team follow-ups' })).toContainText('Confirm Saturday viewing');
  });

  test('agents see only their own leads and cannot assign', async ({ page, state }) => {
    await signIn(page, state.users.agent.email);
    await page.goto('/leads?tab=open');
    const table = page.getByRole('table', { name: 'All open' });
    await expect(table).toContainText('Ama Owusu');
    await expect(page.getByRole('navigation', { name: 'Lead views' }).getByRole('link', { name: 'Unassigned' })).toHaveCount(0);
    await page.goto(`/leads/${state.records.crm.agentLead.id}`);
    await expect(page.getByRole('button', { name: 'Assign', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
  });
});
