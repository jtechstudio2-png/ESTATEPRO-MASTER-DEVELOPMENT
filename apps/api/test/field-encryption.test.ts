import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '../src/common/request-context.js';
import { loadConfig } from '../src/config/config.js';
import { contactWithinScope } from '../src/contacts/contact-access.js';
import { createKeyProvider } from '../src/crypto/crypto.module.js';
import { decryptField, encryptField, type FieldBinding, FieldDecryptionError, keyVersionOf } from '../src/crypto/field-cipher.js';
import { DisabledKeyProvider, KeyUnavailableError, LocalKeyProvider } from '../src/crypto/key-provider.js';
import { lastCharacters, lookupHash, normaliseIdentifier } from '../src/crypto/lookup-hash.js';
import { sensitiveLogPaths, SENSITIVE_FIELDS } from '../src/crypto/sensitive-fields.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://app@localhost/estatepro',
  AUTH_DATABASE_URL: 'postgres://auth@localhost/estatepro',
  OIDC_ISSUER: 'https://idp.example/',
  OIDC_AUDIENCE: 'api',
  OIDC_JWKS_URL: 'https://idp.example/jwks',
  OIDC_PROVIDER: 'example-idp',
  STORAGE_BUCKET: 'estatepro-media',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
};
const ROOT_KEY = randomBytes(32).toString('base64');

const place: FieldBinding = {
  companyId: '0190a1b2-0000-7000-8000-000000000001',
  table: 'contacts',
  column: 'date_of_birth_encrypted',
  rowId: '0190a1b2-0000-7000-8000-0000000000aa',
};

describe('field cipher (ADR-007 §4.3)', () => {
  const key = randomBytes(32);

  it('round-trips text, including non-Latin scripts', () => {
    for (const value of ['1984-02-29', 'GHA-123456789-0', 'رقم ١٢٣٤', '']) {
      if (value === '') continue;
      expect(decryptField(key, place, encryptField(key, 1, place, value))).toBe(value);
    }
  });

  it('writes the format and key version in the header, and a fresh nonce every time', () => {
    const a = encryptField(key, 7, place, 'same value');
    const b = encryptField(key, 7, place, 'same value');
    expect(a[0]).toBe(0x01);
    expect(keyVersionOf(a)).toBe(7);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(5, 17).equals(b.subarray(5, 17))).toBe(false);
    expect(a.toString('utf8')).not.toContain('same value');
  });

  it('refuses ciphertext moved to another row, column, table or company (authenticated data)', () => {
    const ciphertext = encryptField(key, 1, place, '1984-02-29');
    for (const moved of [
      { ...place, rowId: '0190a1b2-0000-7000-8000-0000000000bb' },
      { ...place, column: 'tax_number_encrypted' },
      { ...place, table: 'identity_documents' },
      { ...place, companyId: '0190a1b2-0000-7000-8000-000000000002' },
    ]) {
      expect(() => decryptField(key, moved, ciphertext)).toThrow(FieldDecryptionError);
    }
  });

  it('refuses tampered, truncated or unknown-format ciphertext and the wrong key, without echoing the value', () => {
    const ciphertext = encryptField(key, 1, place, 'secret-value');
    const tampered = Buffer.from(ciphertext);
    tampered[20] = tampered[20]! ^ 0x01;
    const wrongFormat = Buffer.from(ciphertext);
    wrongFormat[0] = 0x02;
    const attempts = [
      () => decryptField(key, place, tampered),
      () => decryptField(key, place, ciphertext.subarray(0, 20)),
      () => decryptField(key, place, wrongFormat),
      () => decryptField(randomBytes(32), place, ciphertext),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(FieldDecryptionError);
      try {
        attempt();
      } catch (error) {
        expect((error as Error).message).not.toContain('secret-value');
      }
    }
  });

  it('rejects bad keys, versions and bindings', () => {
    expect(() => encryptField(randomBytes(16), 1, place, 'x')).toThrow('32 bytes');
    expect(() => encryptField(key, 0, place, 'x')).toThrow('key version');
    expect(() => encryptField(key, 1, { ...place, rowId: 'a|b' }, 'x')).toThrow('binding');
    expect(() => encryptField(key, 1, { ...place, table: '' }, 'x')).toThrow('binding');
  });
});

describe('lookup hashes (ADR-007 §4.4)', () => {
  it('normalise case and separators so formatting does not matter', () => {
    expect(normaliseIdentifier(' gha-123 456.789/0 ')).toBe('GHA1234567890');
    const key = randomBytes(32);
    expect(lookupHash(key, 'identity_number', 'GHA-123456789-0').equals(lookupHash(key, 'identity_number', 'gha 1234567890'))).toBe(true);
  });

  it('differ per company key and per purpose', () => {
    const value = 'P1234567';
    const companyA = randomBytes(32);
    const companyB = randomBytes(32);
    expect(lookupHash(companyA, 'identity_number', value).equals(lookupHash(companyB, 'identity_number', value))).toBe(false);
    expect(lookupHash(companyA, 'identity_number', value).equals(lookupHash(companyA, 'tax_number', value))).toBe(false);
    expect(lookupHash(companyA, 'identity_number', value)).toHaveLength(32);
  });

  it('refuse empty identifiers and keep only the last characters for display', () => {
    expect(() => lookupHash(randomBytes(32), 'tax_number', ' - ')).toThrow('empty');
    expect(lastCharacters('GHA-123456789-0')).toBe('7890');
    expect(lastCharacters('A1')).toBe('A1');
  });
});

describe('key providers (ADR-007 §4.5)', () => {
  it('local provider wraps a fresh 32-byte key that only unwraps for the same company and purpose', async () => {
    const provider = new LocalKeyProvider(ROOT_KEY);
    const context = { companyId: place.companyId, purpose: 'field' as const };
    const generated = await provider.generateDataKey(context);
    expect(generated.plaintext).toHaveLength(32);
    expect(generated.wrapped.includes(generated.plaintext)).toBe(false);
    expect(generated.keyRef).toMatch(/^local:[0-9a-f]{16}$/);
    expect((await provider.unwrap(generated.wrapped, generated.keyRef, context)).equals(generated.plaintext)).toBe(true);
    await expect(provider.unwrap(generated.wrapped, generated.keyRef, { ...context, purpose: 'lookup' })).rejects.toThrow(KeyUnavailableError);
    await expect(provider.unwrap(generated.wrapped, generated.keyRef, { ...context, companyId: '0190a1b2-0000-7000-8000-000000000002' })).rejects.toThrow(KeyUnavailableError);
  });

  it('local provider refuses keys wrapped by a different root key', async () => {
    const generated = await new LocalKeyProvider(ROOT_KEY).generateDataKey({ companyId: place.companyId, purpose: 'field' });
    const other = new LocalKeyProvider(randomBytes(32).toString('base64'));
    await expect(other.unwrap(generated.wrapped, generated.keyRef, { companyId: place.companyId, purpose: 'field' })).rejects.toThrow('different root key');
  });

  it('with no provider configured, every key operation fails closed', async () => {
    const provider = createKeyProvider(loadConfig(BASE_ENV));
    expect(provider).toBeInstanceOf(DisabledKeyProvider);
    await expect(provider.generateDataKey({ companyId: place.companyId, purpose: 'field' })).rejects.toThrow(KeyUnavailableError);
    await expect(provider.unwrap(Buffer.alloc(40), 'x', { companyId: place.companyId, purpose: 'field' })).rejects.toThrow(KeyUnavailableError);
  });
});

describe('key provider configuration', () => {
  it('accepts the local provider with a 32-byte base64 root key outside production', () => {
    const config = loadConfig({ ...BASE_ENV, KEY_PROVIDER: 'local', FIELD_ENCRYPTION_LOCAL_ROOT_KEY: ROOT_KEY });
    expect(createKeyProvider(config)).toBeInstanceOf(LocalKeyProvider);
    expect(config.FIELD_KEY_CACHE_TTL_SECONDS).toBe(300);
    expect(config.REVEAL_STEP_UP_MAX_AGE_SECONDS).toBe(300);
  });

  it('refuses the local provider in production', () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: 'production', KEY_PROVIDER: 'local', FIELD_ENCRYPTION_LOCAL_ROOT_KEY: ROOT_KEY })).toThrow(
      /KEY_PROVIDER: The local key provider is for development and tests only/,
    );
  });

  it('refuses a missing or wrong-sized root key', () => {
    expect(() => loadConfig({ ...BASE_ENV, KEY_PROVIDER: 'local' })).toThrow(/FIELD_ENCRYPTION_LOCAL_ROOT_KEY/);
    expect(() => loadConfig({ ...BASE_ENV, KEY_PROVIDER: 'local', FIELD_ENCRYPTION_LOCAL_ROOT_KEY: randomBytes(16).toString('base64') })).toThrow(
      /FIELD_ENCRYPTION_LOCAL_ROOT_KEY/,
    );
  });

  it('keeps the key cache within the 5-minute limit', () => {
    expect(() => loadConfig({ ...BASE_ENV, FIELD_KEY_CACHE_TTL_SECONDS: '301' })).toThrow(/FIELD_KEY_CACHE_TTL_SECONDS/);
  });
});

describe('sensitive field register (ADR-007 §3)', () => {
  it('lists each encrypted column once, with unique hash columns', () => {
    const columns = SENSITIVE_FIELDS.map((field) => `${field.table}.${field.column}`);
    expect(new Set(columns).size).toBe(columns.length);
    for (const field of SENSITIVE_FIELDS) expect(field.column).toMatch(/_encrypted$/);
  });

  it('redacts every plaintext field name from logs at any depth', () => {
    const paths = sensitiveLogPaths();
    for (const field of SENSITIVE_FIELDS) {
      expect(paths).toContain(field.apiName);
      expect(paths).toContain(`*.${field.apiName}`);
    }
    expect(paths).toContain('req.body');
  });
});

describe('contact record scope for protected details', () => {
  const ctx = { membershipId: 'm-1', officeIds: ['office-a'] } as unknown as TenantContext;

  it('allows all, office and owner scopes only for matching contacts', () => {
    expect(contactWithinScope('all', ctx, { officeId: null, ownerMembershipId: null })).toBe(true);
    expect(contactWithinScope('office', ctx, { officeId: 'office-a', ownerMembershipId: null })).toBe(true);
    expect(contactWithinScope('office', ctx, { officeId: 'office-b', ownerMembershipId: 'm-1' })).toBe(false);
    expect(contactWithinScope('office', ctx, { officeId: null, ownerMembershipId: null })).toBe(false);
    expect(contactWithinScope('own', ctx, { officeId: 'office-b', ownerMembershipId: 'm-1' })).toBe(true);
    expect(contactWithinScope('own', ctx, { officeId: 'office-a', ownerMembershipId: 'm-2' })).toBe(false);
    expect(contactWithinScope('own', ctx, { officeId: 'office-a', ownerMembershipId: null })).toBe(false);
  });

  it('matches nothing for scopes that do not apply to contacts', () => {
    for (const scope of ['team', 'linked', 'assigned'] as const) {
      expect(contactWithinScope(scope, ctx, { officeId: 'office-a', ownerMembershipId: 'm-1' })).toBe(false);
    }
  });
});
