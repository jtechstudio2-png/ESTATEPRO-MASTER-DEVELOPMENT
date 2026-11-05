import { describe, expect, it } from 'vitest';

import { parseDataProtectionArgs, USAGE } from '../src/cli/data-protection-args.js';
import { fieldColumns, lookupColumns } from '../src/crypto/key-rotation.service.js';

const COMPANY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const CONTACT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

describe('data-protection command arguments (ADR-007 E5–E6)', () => {
  it('parses every command', () => {
    expect(parseDataProtectionArgs(['rotate-key', '--company', COMPANY.toUpperCase(), '--purpose', 'field', '--trigger', 'compromise', '--reason', 'Laptop lost', '--by', 'Ops'])).toEqual({
      command: 'rotate-key',
      companyId: COMPANY,
      purpose: 'field',
      trigger: 'compromise',
      reason: 'Laptop lost',
      by: 'Ops',
    });
    expect(parseDataProtectionArgs(['rotation-status', '--company', COMPANY])).toEqual({ command: 'rotation-status', companyId: COMPANY });
    expect(parseDataProtectionArgs(['erase-contact', '--company', COMPANY, '--contact', CONTACT, '--reference', 'DSR-1', '--by', 'DPO'])).toEqual({
      command: 'erase-contact',
      companyId: COMPANY,
      contactId: CONTACT,
      reference: 'DSR-1',
      by: 'DPO',
    });
    expect(parseDataProtectionArgs(['shred-company', '--company', COMPANY, '--confirm', 'accra-homes', '--reference', 'CLOSE-1', '--by', 'Ops'])).toMatchObject({
      command: 'shred-company',
      confirm: 'accra-homes',
    });
    expect(parseDataProtectionArgs(['replay-ledger'])).toEqual({ command: 'replay-ledger', dryRun: false });
    expect(parseDataProtectionArgs(['replay-ledger', '--dry-run'])).toEqual({ command: 'replay-ledger', dryRun: true });
  });

  it('refuses incomplete, unknown or malformed arguments', () => {
    expect(() => parseDataProtectionArgs([])).toThrow(/Give a command/);
    expect(() => parseDataProtectionArgs(['drop-everything'])).toThrow(/Unknown command/);
    expect(() => parseDataProtectionArgs(['rotation-status', '--company', 'not-a-uuid'])).toThrow(/UUID/);
    expect(() => parseDataProtectionArgs(['rotation-status'])).toThrow(/--company is required/);
    expect(() => parseDataProtectionArgs(['rotation-status', '--company'])).toThrow(/needs a value/);
    expect(() => parseDataProtectionArgs(['rotation-status', '--company', COMPANY, '--company', COMPANY])).toThrow(/twice/);
    expect(() => parseDataProtectionArgs(['rotation-status', COMPANY])).toThrow(/Unexpected argument/);
    expect(() => parseDataProtectionArgs(['rotation-status', '--company', COMPANY, '--purpose', 'field'])).toThrow(/not an option/);
    expect(() => parseDataProtectionArgs(['rotate-key', '--company', COMPANY, '--purpose', 'master', '--trigger', 'request', '--reason', 'x', '--by', 'y'])).toThrow(/one of/);
    expect(() => parseDataProtectionArgs(['rotate-key', '--company', COMPANY, '--purpose', 'field', '--trigger', 'scheduled', '--reason', 'x', '--by', 'y'])).toThrow(/one of/);
    expect(() => parseDataProtectionArgs(['erase-contact', '--company', COMPANY, '--contact', CONTACT, '--reference', '  ', '--by', 'y'])).toThrow(/required/);
    expect(USAGE).toContain('replay-ledger');
  });

  it('rotates every protected column of company data, and re-hashes only the looked-up ones', () => {
    expect(fieldColumns().map((field) => `${field.table}.${field.column}`)).toContain('identity_documents.number_encrypted');
    expect(fieldColumns().some((field) => field.table === 'mfa_factors')).toBe(false);
    expect(lookupColumns().map((field) => field.lookup.hashColumn).sort()).toEqual(['number_hash', 'tax_number_hash']);
  });
});
