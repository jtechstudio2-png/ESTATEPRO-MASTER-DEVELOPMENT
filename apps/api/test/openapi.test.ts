import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '../src/bootstrap.js';
import { createTestApp, type TestApp } from './support/app.js';

/** The committed contract must match the code (ADR-003 §8). Regenerate with `pnpm --filter @estatepro/api openapi`. */
describe('OpenAPI contract', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('matches the committed apps/api/openapi.json', () => {
    const committed = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'openapi.json'), 'utf8'));
    const generated = JSON.parse(JSON.stringify(buildOpenApiDocument(t.app)));
    expect(generated).toEqual(committed);
  });

  it('declares OpenAPI 3.1 and bearer authentication', () => {
    const document = buildOpenApiDocument(t.app);
    expect(document.openapi).toBe('3.1.0');
    expect(document.components?.securitySchemes?.['bearer']).toMatchObject({ type: 'http', scheme: 'bearer' });
  });
});
