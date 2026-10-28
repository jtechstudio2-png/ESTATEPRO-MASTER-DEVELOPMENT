import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env['E2E_WEB_PORT'] ?? 3100);

/**
 * End-to-end tests against the production build, the real API and a fresh
 * database (e2e/global-setup.ts). Desktop and mobile widths, English and
 * Arabic (RTL) are covered by the specs themselves.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: process.env['CI'] ? 2 : 3,
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-GB',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
});
