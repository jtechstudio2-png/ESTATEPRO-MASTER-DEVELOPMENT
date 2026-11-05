import { writeFileSync } from 'node:fs';

import type { Locator, Page } from '@playwright/test';

import { expect, signIn, test } from './support/fixtures';

/**
 * Performance of the main screens on the production build: a full page load
 * (cold JavaScript cache per screen) until the screen shows its data, the
 * Largest Contentful Paint, and the JavaScript transferred. The budgets are
 * deliberately loose so a slow CI runner does not fail them; the measured
 * values are written to test-results/perf.json for the milestone report.
 * Screens that draw a map load MapLibre on demand (about 290 KB
 * compressed) and have their own script budget.
 */
const BUDGET = { readyMs: 4000, lcpMs: 4000, scriptKb: 300, mapScriptKb: 600 };

interface Measure {
  screen: string;
  readyMs: number;
  lcpMs: number;
  domContentLoadedMs: number;
  scriptKb: number;
  requests: number;
}

async function measure(page: Page, screen: string, url: string, ready: (page: Page) => Locator): Promise<Measure> {
  const client = await page.context().newCDPSession(page);
  await client.send('Network.clearBrowserCache');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  const started = Date.now();
  await page.goto(url);
  await expect(ready(page)).toBeVisible({ timeout: 15_000 });
  const readyMs = Date.now() - started;
  const timing = await page.evaluate(
    () =>
      new Promise<{ lcp: number; dcl: number; scriptBytes: number; requests: number }>((resolve) => {
        let lcp = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) lcp = Math.max(lcp, entry.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => {
          const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
          const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
          const scripts = resources.filter((entry) => entry.initiatorType === 'script' || entry.name.endsWith('.js'));
          resolve({ lcp, dcl: navigation.domContentLoadedEventEnd, scriptBytes: scripts.reduce((sum, entry) => sum + entry.encodedBodySize, 0), requests: resources.length });
        }, 300);
      }),
  );
  await client.send('Network.setCacheDisabled', { cacheDisabled: false });
  return { screen, readyMs, lcpMs: Math.round(timing.lcp), domContentLoadedMs: Math.round(timing.dcl), scriptKb: Math.round(timing.scriptBytes / 1024), requests: timing.requests };
}

test('main screens load within budget', { tag: '@performance' }, async ({ page, state }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, state.users.owner.email, { company: state.companies.accra.name });
  const property = `/properties/${state.records.osuCourt.id}`;
  const screens: Array<[string, string, (page: Page) => Locator, boolean?]> = [
    ['Dashboard (D-1, D-2)', '/dashboard', (p) => p.getByRole('heading', { name: 'Keys I hold' })],
    ['Property register (P-1), 55 properties', '/properties', (p) => p.getByRole('table', { name: 'Properties' }).getByRole('rowheader').first()],
    ['Property overview (P-2), with mini map', property, (p) => p.getByText('Gate sticks; lift and push.'), true],
    ['Listing register (L-1)', '/listings', (p) => p.getByRole('table', { name: 'Listings' }).getByRole('rowheader').first()],
    ['Property media (G-1)', `${property}/media`, (p) => p.getByRole('heading', { level: 2 }).first()],
    ['Notes (N-1)', `${property}/notes`, (p) => p.getByText('Gate sticks; lift and push.')],
    ['Key register (K-2)', '/keys?tab=all', (p) => p.getByRole('table', { name: 'Key sets' }).getByRole('rowheader').first()],
    ['Property map (M-3), 54 pins', '/map/properties', (p) => p.getByRole('region', { name: 'Properties map', exact: true }).getByRole('button', { name: /Osu Court$/ }), true],
    ['Admin dashboard (D-A)', '/dashboards/admin', (p) => p.getByRole('heading', { name: 'Users and access' })],
    ['CRM dashboard (D-C)', '/dashboards/crm', (p) => p.getByRole('heading', { name: /New leads not yet contacted/ })],
    ['Contact register (C-1)', '/contacts', (p) => p.getByRole('table', { name: 'Contacts' }).getByRole('rowheader').first()],
    ['Contact record (C-2)', `/contacts/${state.records.crm.ama.id}`, (p) => p.getByRole('heading', { name: 'Contact methods' })],
    ['Lead inbox (L-1)', '/leads?tab=open', (p) => p.getByRole('table', { name: 'All open' }).getByRole('rowheader').first()],
    ['Lead record (L-2)', `/leads/${state.records.crm.agentLead.id}`, (p) => p.getByRole('heading', { name: 'Status history' })],
    ['Follow-ups (F-2)', '/follow-ups?range=done', (p) => p.getByRole('heading', { level: 1, name: 'Follow-ups' })],
  ];
  const results: Array<Measure & { map: boolean }> = [];
  for (const [name, url, ready, map = false] of screens) results.push({ ...(await measure(page, name, url, ready)), map });
  writeFileSync('test-results/perf.json', `${JSON.stringify({ measuredAt: new Date().toISOString(), budget: BUDGET, results }, null, 2)}\n`);
  console.table(results);
  for (const result of results) {
    expect(result.readyMs, `${result.screen}: time to data`).toBeLessThan(BUDGET.readyMs);
    expect(result.lcpMs, `${result.screen}: LCP`).toBeLessThan(BUDGET.lcpMs);
    expect(result.scriptKb, `${result.screen}: JavaScript transferred`).toBeLessThan(result.map ? BUDGET.mapScriptKb : BUDGET.scriptKb);
  }
});
