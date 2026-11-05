import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { systemContext } from '../src/common/request-context.js';
import { CompanyKeysService } from '../src/crypto/company-keys.service.js';
import { encryptField } from '../src/crypto/field-cipher.js';
import { KEY_PROVIDER, type KeyProvider } from '../src/crypto/key-provider.js';
import { KeyRotationService } from '../src/crypto/key-rotation.service.js';
import { lastCharacters, lookupHash } from '../src/crypto/lookup-hash.js';
import { createKysely, type Db, TenantDb } from '../src/database/database.module.js';
import { ErasureLedger } from '../src/privacy/erasure-ledger.js';
import { ErasureService } from '../src/privacy/erasure.service.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Rotation and erasure at volume (ADR-007 E5–E6). One company with 20,000
 * contacts holding an encrypted date of birth, 5,000 of them also an
 * encrypted tax number with its lookup hash. Budgets: a field-key rotation
 * moves at least 500 values a second; a lookup-key rotation re-hashes at
 * least 250 a second (two passes); erasing a person with 300 timeline entries,
 * 50 follow-ups and 100 audit rows takes under 2 seconds.
 */
const CONTACTS = 20_000;
const WITH_TAX = 5_000;

describe('key rotation and erasure performance', () => {
  let t: TestApp;
  let fx: Fixtures;
  let platform: Db;
  let rotation: KeyRotationService;
  let ledger: ErasureLedger;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  const results: Record<string, number> = {};

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    platform = createKysely(inject('databaseUrls').platform, 2, 'estatepro-tests-dp-perf');
    const provider = t.app.get<KeyProvider>(KEY_PROVIDER);
    rotation = new KeyRotationService(platform, provider, { ...t.config, KEY_ROTATION_SETTLE_SECONDS: 0 });
    ledger = ErasureLedger.fromConfig(t.config);
    company = await fx.company();
    const c = company.companyId;
    const keys = new CompanyKeysService(provider, t.config);
    const tenantDb = t.app.get(TenantDb);
    const ctx = systemContext(c, 'perf-seed');
    const { field, lookup } = await tenantDb.run(ctx, async (tx) => ({ field: await keys.active(tx, ctx, 'field'), lookup: await keys.active(tx, ctx, 'lookup') }));
    for (let start = 0; start < CONTACTS; start += 1_000) {
      const rows = Array.from({ length: Math.min(1_000, CONTACTS - start) }, (_, i) => {
        const n = start + i;
        const id = randomUUID();
        const tax = n < WITH_TAX ? `P${String(10_000_000 + n).padStart(10, '0')}` : null;
        const bind = (column: string) => ({ companyId: c, table: 'contacts', column, rowId: id });
        return {
          id,
          companyId: c,
          contactType: 'person',
          displayName: `Perf ${n}`,
          dateOfBirthEncrypted: encryptField(field.key, field.version, bind('date_of_birth_encrypted'), `19${String(50 + (n % 50))}-01-01`),
          taxNumberEncrypted: tax ? encryptField(field.key, field.version, bind('tax_number_encrypted'), tax) : null,
          taxNumberHash: tax ? lookupHash(lookup.key, 'tax_number', tax) : null,
          taxNumberLast4: tax ? lastCharacters(tax) : null,
        };
      });
      await fx.db.insertInto('contacts').values(rows).execute();
    }
    field.key.fill(0);
    lookup.key.fill(0);
    keys.clear();
  }, 300_000);

  afterAll(async () => {
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/data-protection-performance.json', `${JSON.stringify(results, null, 2)}\n`);
    rotation.close();
    ledger.destroy();
    await platform.destroy();
    await fx.close();
    await t.close();
  });

  it(`re-encrypts ${CONTACTS + WITH_TAX} values with a new field key at 500 or more a second`, async () => {
    const started = Date.now();
    const state = await rotation.start({ companyId: company.companyId, purpose: 'field', trigger: 'request', reason: 'Performance test', requestedBy: 'perf' });
    let current = state;
    while (current.status !== 'completed') current = await rotation.step(state.id, { maxBatches: 1_000 });
    const seconds = (Date.now() - started) / 1000;
    results['fieldRotationValues'] = current.rowsRewritten;
    results['fieldRotationSeconds'] = seconds;
    results['fieldRotationPerSecond'] = Math.round(current.rowsRewritten / seconds);
    expect(current.rowsRewritten).toBe(CONTACTS + WITH_TAX);
    expect(current.rowsRewritten / seconds).toBeGreaterThanOrEqual(500);
  }, 300_000);

  it(`re-hashes ${WITH_TAX} tax numbers with a new lookup key, two passes, at 250 or more a second`, async () => {
    const started = Date.now();
    const state = await rotation.start({ companyId: company.companyId, purpose: 'lookup', trigger: 'compromise', reason: 'Performance test', requestedBy: 'perf' });
    let current = state;
    while (current.status !== 'completed') current = await rotation.step(state.id, { maxBatches: 1_000 });
    const seconds = (Date.now() - started) / 1000;
    results['lookupRotationSeconds'] = seconds;
    results['lookupRotationPerSecond'] = Math.round((2 * WITH_TAX) / seconds);
    expect(current.rowsRewritten).toBe(WITH_TAX);
    expect((2 * WITH_TAX) / seconds).toBeGreaterThanOrEqual(250);
  }, 300_000);

  it('erases a person with a long history in under 2 seconds', async () => {
    const c = company.companyId;
    const person = await fx.db.insertInto('contacts').values({ companyId: c, contactType: 'person', displayName: 'Long history', primaryEmail: 'long@perf.test' }).returning('id').executeTakeFirstOrThrow();
    await sql`
      with made as (
        insert into activities (company_id, activity_type, direction, subject, body, occurred_at, created_by)
        select ${c}::uuid, 'note', 'internal', 'Note ' || n, 'About the long-history person ' || n, now() - make_interval(days => n), ${company.ownerMembershipId}::uuid
          from generate_series(1, 300) n
        returning id)
      insert into activity_links (company_id, activity_id, entity_type, entity_id) select ${c}::uuid, id, 'contact', ${person.id}::uuid from made`.execute(fx.db);
    await sql`
      insert into tasks (company_id, title, assigned_to, due_at, entity_type, entity_id)
      select ${c}::uuid, 'Call long history ' || n, ${company.ownerMembershipId}::uuid, now() + make_interval(days => n), 'contact', ${person.id}::uuid
        from generate_series(1, 50) n`.execute(fx.db);
    await sql`
      insert into audit_logs (company_id, actor_type, action, entity_type, entity_id, changes)
      select ${c}::uuid, 'user', 'contact.updated', 'contact', ${person.id}::uuid, jsonb_build_object('notes', jsonb_build_object('old', 'v' || n, 'new', 'v' || (n + 1)))
        from generate_series(1, 100) n`.execute(fx.db);

    const erasure = new ErasureService(t.app.get(TenantDb), platform, ledger);
    const started = Date.now();
    const result = await erasure.eraseContact(c, person.id, { requestReference: 'DSR-PERF-1', requestedBy: 'perf' });
    const ms = Date.now() - started;
    results['erasureMs'] = ms;
    expect(result.counts).toMatchObject({ contacts: 1, activities: 300, tasks: 50 });
    expect(result.counts['audit_logs']).toBeGreaterThanOrEqual(100);
    expect(ms).toBeLessThan(2_000);
  }, 120_000);
});
