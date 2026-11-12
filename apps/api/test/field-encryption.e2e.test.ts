import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inject } from 'vitest';

import { systemContext } from '../src/common/request-context.js';
import { CompanyKeysService } from '../src/crypto/company-keys.service.js';
import { KEY_PROVIDER, type KeyProvider } from '../src/crypto/key-provider.js';
import { SensitiveDataService } from '../src/crypto/sensitive-data.service.js';
import { createKysely, type Db, TenantDb } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

const DATE_OF_BIRTH = '1979-11-04';
const TAX_NUMBER = 'P0012345678';
const PASSPORT = 'G-4821-7733';

describe('field encryption keys and protected-detail reveal (ADR-007, stages E1–E4)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let app: Db;
  let company: Company;
  let other: Company;
  let tenantDb: TenantDb;
  let sensitive: SensitiveDataService;
  let keys: CompanyKeysService;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};
  const subjects: Record<string, string> = {};

  const as = (who: string, companyId = company.companyId, token = tokens[who]!) => ({
    reveal: (path: string, body: object = { reason: 'Verifying identity for a sale' }) =>
      t.http.post(path).auth(token, { type: 'bearer' }).set('X-Company-Id', companyId).send(body),
  });

  /** Seeds a contact the way the CRM will: id chosen first, values sealed for that row. */
  async function seedContact(
    companyId: string,
    values: { dateOfBirth?: string; taxNumber?: string; ownerMembershipId?: string; officeId?: string; anonymised?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    const ctx = systemContext(companyId, 'test-seed');
    await tenantDb.run(ctx, async (tx) => {
      const place = (column: string) => ({ table: 'contacts', column, rowId: id });
      const dob = values.dateOfBirth ? await sensitive.seal(tx, ctx, place('date_of_birth_encrypted'), values.dateOfBirth) : null;
      const tax = values.taxNumber ? await sensitive.protectIdentifier(tx, ctx, place('tax_number_encrypted'), 'tax_number', values.taxNumber) : null;
      await tx
        .insertInto('contacts')
        .values({
          id,
          companyId,
          contactType: 'person',
          displayName: `Contact ${id.slice(0, 8)}`,
          officeId: values.officeId ?? null,
          ownerMembershipId: values.ownerMembershipId ?? null,
          dateOfBirthEncrypted: dob,
          taxNumberEncrypted: tax?.encrypted ?? null,
          taxNumberHash: tax?.hash ?? null,
          taxNumberLast4: tax?.last4 ?? null,
        })
        .execute();
      if (values.anonymised) await sql`select app.erase_contact(${id}::uuid)`.execute(tx);
    });
    return id;
  }

  async function seedPassport(companyId: string, contactId: string, number: string): Promise<string> {
    const id = randomUUID();
    const ctx = systemContext(companyId, 'test-seed');
    await tenantDb.run(ctx, async (tx) => {
      const protectedNumber = await sensitive.protectIdentifier(tx, ctx, { table: 'identity_documents', column: 'number_encrypted', rowId: id }, 'identity_number', number);
      await tx
        .insertInto('identityDocuments')
        .values({
          id,
          companyId,
          contactId,
          documentTypeCode: 'passport',
          issuingCountryCode: 'GH',
          numberEncrypted: protectedNumber.encrypted,
          numberHash: protectedNumber.hash,
          numberLast4: protectedNumber.last4,
        })
        .execute();
    });
    return id;
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    app = createKysely(inject('databaseUrls').app, 2, 'estatepro-tests-app');
    tenantDb = t.app.get(TenantDb);
    sensitive = t.app.get(SensitiveDataService);
    keys = t.app.get(CompanyKeysService);
    company = await fx.company();
    other = await fx.company();
    const kumasi = (await fx.office(company.companyId, 'KSI')).id;
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      admin: { ...(await fx.member(company.companyId, { roleKey: 'office_admin' })), companyId: company.companyId },
      manager: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [kumasi] })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [name, person] of Object.entries(people)) {
      members[name] = person.membershipId;
      subjects[name] = `fe-${name}-${person.companyId}`;
      await fx.linkIdentity(person.userId, subjects[name]);
      tokens[name] = await t.idp.token({ sub: subjects[name], amr: ['pwd', 'mfa'], authTime: now - 30 });
    }
  });

  afterAll(async () => {
    await app.destroy();
    await fx.close();
    await t.close();
  });

  describe('company keys', () => {
    it('creates one field key and one lookup key per company on first use, stored only wrapped', async () => {
      const ctx = systemContext(company.companyId, 'test-keys');
      const [first, second] = await Promise.all([
        tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'field')),
        tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'field')),
      ]);
      expect(first.version).toBe(1);
      expect(first.key.equals(second.key)).toBe(true);
      await tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'lookup'));

      const rows = await fx.db.selectFrom('companyDataKeys').selectAll().where('companyId', '=', company.companyId).orderBy('purpose').execute();
      expect(rows.map((row) => [row.purpose, row.version, row.status])).toEqual([
        ['field', 1, 'active'],
        ['lookup', 1, 'active'],
      ]);
      expect(rows[0]!.kmsKeyRef).toMatch(/^local:/);
      expect(rows[0]!.wrappedKey!.includes(first.key)).toBe(false);
    });

    it('serves keys from the cache without unwrapping again, and hands out copies', async () => {
      const ctx = systemContext(company.companyId, 'test-cache');
      const first = await tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'field'));
      first.key.fill(0);
      const second = await tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'field'));
      expect(second.key.equals(Buffer.alloc(32))).toBe(false);
    });

    it('keeps each company to its own keys under row-level security', async () => {
      const ctx = systemContext(other.companyId, 'test-isolation');
      await tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'field'));
      const visible = await tenantDb.run(systemContext(company.companyId, 'test-isolation'), (tx) =>
        tx.selectFrom('companyDataKeys').select('companyId').distinct().execute(),
      );
      expect(visible.map((row) => row.companyId)).toEqual([company.companyId]);
    });

    it('lets the runtime role create only a first active key, and never change or delete keys', async () => {
      const attempt = (statement: ReturnType<typeof sql>) =>
        app.transaction().execute(async (tx) => {
          await sql`select set_config('app.company_id', ${company.companyId}, true), set_config('app.user_id', ${company.ownerUserId}, true)`.execute(tx);
          await statement.execute(tx);
        });
      await expect(
        attempt(sql`insert into company_data_keys (company_id, purpose, version, wrapped_key, kms_key_ref) values (${company.companyId}, 'field', 2, ${Buffer.alloc(48)}, 'local:x')`),
      ).rejects.toThrow(/row-level security/);
      await expect(attempt(sql`update company_data_keys set status = 'decrypt_only' where company_id = ${company.companyId}`)).rejects.toThrow(/permission denied/);
      await expect(attempt(sql`delete from company_data_keys where company_id = ${company.companyId}`)).rejects.toThrow(/permission denied/);
      await expect(
        attempt(sql`insert into company_data_keys (company_id, purpose, version, wrapped_key, kms_key_ref) values (${other.companyId}, 'field', 1, ${Buffer.alloc(48)}, 'local:x')`),
      ).rejects.toThrow(/row-level security/);
    });

    it('only moves keys forward and never replaces key material (platform role)', async () => {
      const where = (purpose: string) => sql`company_id = ${company.companyId} and purpose = ${purpose} and version = 1`;
      await expect(sql`update company_data_keys set wrapped_key = ${Buffer.alloc(48, 1)} where ${where('lookup')}`.execute(fx.db)).rejects.toThrow(
        /key material cannot be replaced/,
      );
      await expect(sql`update company_data_keys set kms_key_ref = 'local:other' where ${where('lookup')}`.execute(fx.db)).rejects.toThrow(/cannot change/);
      // A throwaway company to walk the full lifecycle without affecting other tests.
      const spare = await fx.company();
      const ctx = systemContext(spare.companyId, 'test-lifecycle');
      await tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'field'));
      const spareWhere = sql`company_id = ${spare.companyId} and purpose = 'field' and version = 1`;
      await sql`update company_data_keys set status = 'decrypt_only', retired_at = now() where ${spareWhere}`.execute(fx.db);
      await expect(sql`update company_data_keys set status = 'active', retired_at = null where ${spareWhere}`.execute(fx.db)).rejects.toThrow(
        /cannot go from decrypt_only to active/,
      );
      await sql`update company_data_keys set status = 'destroyed', wrapped_key = null, destroyed_at = now() where ${spareWhere}`.execute(fx.db);
      keys.clear();
      // Crypto-shredded: the company can no longer read values sealed with that key.
      await expect(tenantDb.run(ctx, (tx) => keys.version(tx, ctx, 'field', 1))).rejects.toThrow(/not available/);
      await expect(sql`update company_data_keys set wrapped_key = null where ${where('field')}`.execute(fx.db)).rejects.toThrow(/check constraint/);
    });
  });

  describe('key cache (ADR-007 §4.5)', () => {
    it('unwraps again after the cache entry expires', async () => {
      const provider = t.app.get<KeyProvider>(KEY_PROVIDER);
      const unwrap = vi.spyOn(provider, 'unwrap');
      const ctx = systemContext(company.companyId, 'test-expiry');
      keys.clear();
      await tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'field'));
      await tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'field'));
      expect(unwrap).toHaveBeenCalledTimes(1);
      const later = Date.now() + 301_000;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      await tenantDb.run(ctx, (tx) => keys.active(tx, ctx, 'field'));
      expect(unwrap).toHaveBeenCalledTimes(2);
      vi.restoreAllMocks();
    });

    it('evicts the least recently used key beyond the size limit, and works with caching off', async () => {
      const settings: Record<string, string>[] = [{ FIELD_KEY_CACHE_MAX_ENTRIES: '1' }, { FIELD_KEY_CACHE_TTL_SECONDS: '0' }];
      for (const overrides of settings) {
        const small = await createTestApp(overrides);
        try {
          const smallKeys = small.app.get(CompanyKeysService);
          const smallDb = small.app.get(TenantDb);
          const provider = small.app.get<KeyProvider>(KEY_PROVIDER);
          const unwrap = vi.spyOn(provider, 'unwrap');
          const a = systemContext(company.companyId, 'test-evict');
          const b = systemContext(other.companyId, 'test-evict');
          const first = await smallDb.run(a, (tx) => smallKeys.active(tx, a, 'field'));
          await smallDb.run(b, (tx) => smallKeys.active(tx, b, 'field'));
          const again = await smallDb.run(a, (tx) => smallKeys.active(tx, a, 'field'));
          expect(again.key.equals(first.key)).toBe(true);
          // Company A's key was evicted by B's (or never cached), so it was unwrapped twice.
          expect(unwrap).toHaveBeenCalledTimes(3);
        } finally {
          vi.restoreAllMocks();
          await small.close();
        }
      }
    });

    it('fails closed when the stored keys were wrapped by a different root key', async () => {
      const id = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH });
      const wrongRoot = await createTestApp({ FIELD_ENCRYPTION_LOCAL_ROOT_KEY: Buffer.alloc(32, 9).toString('base64') });
      try {
        const subject = `fe-owner-wrong-root-${company.companyId}`;
        await fx.linkIdentity(company.ownerUserId, subject, wrongRoot.idp.provider);
        const token = await wrongRoot.idp.token({ sub: subject, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
        const response = await wrongRoot.http
          .post(`/api/v1/contacts/${id}/sensitive/dateOfBirth/reveal`)
          .auth(token, { type: 'bearer' })
          .set('X-Company-Id', company.companyId)
          .send({ reason: 'Verifying identity for a sale' });
        expect(response.status).toBe(503);
        expect(response.body.type).toMatch(/encryption-unavailable$/);
        expect(JSON.stringify(response.body)).not.toContain(DATE_OF_BIRTH);
      } finally {
        await wrongRoot.close();
      }
    });
  });

  describe('sealing and hashing', () => {
    it('stores ciphertext only: the database never holds the value, the hash or a usable key', async () => {
      const id = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH, taxNumber: TAX_NUMBER });
      const row = await fx.db.selectFrom('contacts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(row.dateOfBirthEncrypted!.toString('latin1')).not.toContain(DATE_OF_BIRTH);
      expect(row.taxNumberEncrypted!.toString('latin1')).not.toContain(TAX_NUMBER);
      expect(row.taxNumberLast4).toBe('5678');
      expect(row.taxNumberHash).toHaveLength(32);
      expect(row.taxNumber).toBeNull();
    });

    it('gives the same identifier different hashes in different companies, and equal hashes for different formatting', async () => {
      const hashIn = async (companyId: string, value: string) => {
        const ctx = systemContext(companyId, 'test-hash');
        return tenantDb.run(ctx, (tx) => sensitive.hash(tx, ctx, 'identity_number', value));
      };
      const mine = await hashIn(company.companyId, PASSPORT);
      expect(mine.equals(await hashIn(company.companyId, 'g 48217733'))).toBe(true);
      expect(mine.equals(await hashIn(other.companyId, PASSPORT))).toBe(false);
    });

    it('enforces encryption of individuals’ tax and registration numbers in the database (E-Q1)', async () => {
      const ctx = systemContext(company.companyId, 'test-check');
      await expect(
        tenantDb.run(ctx, (tx) =>
          tx.insertInto('contacts').values({ companyId: company.companyId, contactType: 'person', displayName: 'Plain', taxNumber: TAX_NUMBER }).execute(),
        ),
      ).rejects.toThrow(/contacts_person_identifiers_encrypted/);
      await expect(
        tenantDb.run(ctx, (tx) =>
          tx.insertInto('contacts').values({ companyId: company.companyId, contactType: 'organisation', displayName: 'Org', organisationName: 'Org Ltd', taxNumber: 'C000111' }).execute(),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('reveal endpoint (wireframe C-5)', () => {
    const fieldPath = (contactId: string, field: string) => `/api/v1/contacts/${contactId}/sensitive/${field}/reveal`;

    it('reveals one value to the company owner, uncached, and audits it without the value', async () => {
      const id = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH });
      const response = await as('owner').reveal(fieldPath(id, 'dateOfBirth'), { reason: 'Checking age for tenancy referencing' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ field: 'dateOfBirth', value: DATE_OF_BIRTH, hideAfterSeconds: 60 });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['pragma']).toBe('no-cache');

      const audit = await fx.db
        .selectFrom('auditLogs')
        .selectAll()
        .where('companyId', '=', company.companyId)
        .where('entityId', '=', id)
        .where('action', '=', 'contact.sensitive_revealed')
        .executeTakeFirstOrThrow();
      expect(audit.actorMembershipId).toBe(members['owner']);
      expect(audit.metadata).toMatchObject({ field: 'dateOfBirth', reason: 'Checking age for tenancy referencing' });
      expect(typeof (audit.metadata as { stepUpAt?: unknown }).stepUpAt).toBe('string');
      expect(JSON.stringify(audit)).not.toContain(DATE_OF_BIRTH);
    });

    it('reveals tax numbers and identity document numbers to the accountant', async () => {
      const id = await seedContact(company.companyId, { taxNumber: TAX_NUMBER });
      const documentId = await seedPassport(company.companyId, id, PASSPORT);
      const tax = await as('accountant').reveal(fieldPath(id, 'taxNumber'));
      expect(tax.status).toBe(200);
      expect(tax.body.value).toBe(TAX_NUMBER);
      const passport = await as('accountant').reveal(`/api/v1/contacts/${id}/identity-documents/${documentId}/reveal`);
      expect(passport.status).toBe(200);
      expect(passport.body).toMatchObject({ field: 'documentNumber', value: PASSPORT });
      const audits = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', id).where('action', '=', 'contact.sensitive_revealed').execute();
      expect(audits.map((row) => (row.metadata as { field: string }).field).sort()).toEqual(['documentNumber', 'taxNumber']);
    });

    it('refuses roles without contact.view_sensitive, including office administrators (E-Q5)', async () => {
      const id = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH, officeId: company.officeId, ownerMembershipId: members['agent'] });
      for (const who of ['admin', 'manager', 'agent']) {
        const response = await as(who).reveal(fieldPath(id, 'dateOfBirth'));
        expect(response.status, who).toBe(403);
        expect(response.body.type).toMatch(/forbidden$/);
      }
      const audits = await fx.db.selectFrom('auditLogs').select('id').where('entityId', '=', id).where('action', '=', 'contact.sensitive_revealed').execute();
      expect(audits).toHaveLength(0);
    });

    it('needs a second-factor sign-in within the reveal window (5 minutes), not just the general step-up window', async () => {
      const id = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH });
      const now = Math.floor(Date.now() / 1000);
      const tenMinutes = await t.idp.token({ sub: subjects['owner']!, amr: ['pwd', 'mfa'], authTime: now - 600 });
      const stale = await as('owner', company.companyId, tenMinutes).reveal(fieldPath(id, 'dateOfBirth'));
      expect(stale.status).toBe(403);
      expect(stale.body.type).toMatch(/mfa-required$/);
      expect(stale.body.value).toBeUndefined();
      const noMfa = await t.idp.token({ sub: subjects['owner']!, amr: ['pwd'], authTime: now });
      expect((await as('owner', company.companyId, noMfa).reveal(fieldPath(id, 'dateOfBirth'))).status).toBe(403);
      const fresh = await t.idp.token({ sub: subjects['owner']!, amr: ['pwd', 'mfa'], authTime: now - 120 });
      expect((await as('owner', company.companyId, fresh).reveal(fieldPath(id, 'dateOfBirth'))).status).toBe(200);
    });

    it('requires a reason of at least 10 characters', async () => {
      const id = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH });
      for (const body of [{}, { reason: 'short' }, { reason: 'x'.repeat(501) }]) {
        const response = await as('owner').reveal(fieldPath(id, 'dateOfBirth'), body);
        expect(response.status).toBe(422);
        expect(JSON.stringify(response.body)).not.toContain(DATE_OF_BIRTH);
      }
    });

    it('answers 404 for unknown fields, missing values, anonymised contacts and other companies’ contacts', async () => {
      const id = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH });
      expect((await as('owner').reveal(fieldPath(id, 'primaryEmail'))).status).toBe(404);
      expect((await as('owner').reveal(fieldPath(id, 'taxNumber'))).status).toBe(404);
      const anonymised = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH, anonymised: true });
      expect((await as('owner').reveal(fieldPath(anonymised, 'dateOfBirth'))).status).toBe(404);
      const foreign = await seedContact(other.companyId, { dateOfBirth: DATE_OF_BIRTH });
      expect((await as('owner').reveal(fieldPath(foreign, 'dateOfBirth'))).status).toBe(404);
      expect((await as('otherOwner', other.companyId).reveal(fieldPath(id, 'dateOfBirth'))).status).toBe(404);
      const otherDocument = await seedPassport(company.companyId, id, PASSPORT);
      const unrelated = await seedContact(company.companyId);
      expect((await as('owner').reveal(`/api/v1/contacts/${unrelated}/identity-documents/${otherDocument}/reveal`)).status).toBe(404);
    });

    it('refuses ciphertext copied from another contact, without revealing or auditing', async () => {
      const source = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH });
      const target = await seedContact(company.companyId, { dateOfBirth: '2001-01-01' });
      await sql`update contacts set date_of_birth_encrypted = (select date_of_birth_encrypted from contacts where id = ${source}) where id = ${target}`.execute(fx.db);
      const response = await as('owner').reveal(fieldPath(target, 'dateOfBirth'));
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).not.toContain(DATE_OF_BIRTH);
      const audits = await fx.db.selectFrom('auditLogs').select('id').where('entityId', '=', target).where('action', '=', 'contact.sensitive_revealed').execute();
      expect(audits).toHaveLength(0);
    });

    it('fails closed with 503 when no key provider is configured', async () => {
      const id = await seedContact(company.companyId, { dateOfBirth: DATE_OF_BIRTH });
      const disabled = await createTestApp({ KEY_PROVIDER: 'none' });
      try {
        await fx.linkIdentity(company.ownerUserId, `fe-owner-disabled-${company.companyId}`, disabled.idp.provider);
        const token = await disabled.idp.token({ sub: `fe-owner-disabled-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
        const response = await disabled.http
          .post(fieldPath(id, 'dateOfBirth'))
          .auth(token, { type: 'bearer' })
          .set('X-Company-Id', company.companyId)
          .send({ reason: 'Verifying identity for a sale' });
        expect(response.status).toBe(503);
        expect(response.body.type).toMatch(/encryption-unavailable$/);
      } finally {
        await disabled.close();
      }
    });
  });
});
