import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Test files share one database; run them one after another for deterministic data.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts', // process bootstrap only
        'src/database/schema.ts', // generated types
        'src/cli/provision-company.ts', // process entry; logic is in the tested service and argument parser
        'src/openapi/generate.ts', // script; the document it writes is verified by test/openapi.test.ts
        'src/worker/main.ts', // process entry; the worker it builds is tested through createWorker
      ],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95, statements: 95, functions: 95, branches: 90 },
    },
  },
});
