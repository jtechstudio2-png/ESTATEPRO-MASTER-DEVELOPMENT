import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test as base } from '@playwright/test';

import { e2eState, type E2eState } from './state';

export { expect };

/** Signs in through the test identity provider exactly as a user would (S-1). */
export async function signIn(page: Page, email: string, options: { company?: string; returnTo?: string; mfa?: boolean } = {}): Promise<void> {
  await page.goto(`/sign-in${options.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : ''}`);
  await page.getByRole('link', { name: /^(Sign in|تسجيل الدخول)$/ }).click();
  await page.getByLabel('Email').fill(email);
  if (options.mfa === false) await page.getByLabel('Second factor').uncheck();
  await page.getByRole('button', { name: 'Continue' }).click();
  if (options.company) {
    await page.waitForURL(/\/select-company|\/dashboard|\/properties|\/listings|\/keys|\/map|\/settings/);
    if (page.url().includes('/select-company')) {
      await page.getByRole('button', { name: new RegExp(`(Open|فتح) ${escape(options.company)}`) }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/select-company'));
    }
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** axe with WCAG 2.1 A and AA rules (UI checklist §8). */
export async function expectAccessible(page: Page, options: { exclude?: string[] } = {}): Promise<void> {
  // A soft navigation (a filter written to the URL) streams the new <title> in; scan the settled page.
  await expect.poll(() => page.title()).not.toBe('');
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  const result = await builder.analyze();
  const summary = result.violations.map((violation) => `${violation.id}: ${violation.help}\n  ${violation.nodes.map((node) => node.target.join(' ')).join('\n  ')}`);
  expect(summary, summary.join('\n')).toEqual([]);
}

export const test = base.extend<{ state: E2eState }>({
  state: async ({}, use) => {
    await use(e2eState());
  },
});

/** Opens the select labelled `label` (its button is named "<value> <label>") and picks `option`. */
export async function choose(page: Page, label: string, option: string | RegExp, scope: Page | Locator = page): Promise<void> {
  await scope.getByRole('button', { name: new RegExp(`(^|\\s)${escape(label)}(\\s|$)`) }).first().click();
  await page.getByRole('option', typeof option === 'string' ? { name: option, exact: true } : { name: option }).click();
}

/** Picks a radio by clicking its visible label (the input itself is visually hidden). */
export async function pickRadio(scope: Page | Locator, name: string): Promise<void> {
  await scope.locator('label').filter({ hasText: new RegExp(`^\\s*${escape(name)}\\s*$`) }).first().click();
}
