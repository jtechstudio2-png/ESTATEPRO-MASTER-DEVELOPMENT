import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./test/support/empty.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/support/setup.ts'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
    coverage: {
      provider: 'v8',
      // The logic layer. Screens are covered by the Playwright suite (e2e/), one spec per wireframe group.
      include: ['src/lib/**/*.ts', 'src/server/**/*.ts', 'src/middleware.ts', 'src/app/**/route.ts'],
      exclude: ['src/lib/api-schema.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { statements: 95, branches: 88, functions: 95, lines: 95 },
    },
  },
});
