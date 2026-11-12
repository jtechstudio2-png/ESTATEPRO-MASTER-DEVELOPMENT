import { createHmac } from 'node:crypto';

/**
 * Keyed lookup hashes for exact-match search on encrypted identifiers
 * (ADR-007 §4.4). The key is per company, so the same identifier hashes
 * differently in every company. Only high-entropy identifiers are hashed:
 * never dates of birth or phone numbers, which could be brute-forced.
 */
export type LookupPurpose = 'identity_number' | 'tax_number' | 'account_number';

/**
 * Identifier normalisation: case and separators do not change an identity,
 * tax or account number ("GHA-123 456 789-0" equals "gha1234567890").
 */
export function normaliseIdentifier(value: string): string {
  return value.normalize('NFKC').toUpperCase().replace(/[\s\-./_]/g, '');
}

export function lookupHash(key: Buffer, purpose: LookupPurpose, value: string): Buffer {
  if (key.length !== 32) throw new Error('Lookup keys are 32 bytes.');
  const normalised = normaliseIdentifier(value);
  if (normalised.length === 0) throw new Error('Cannot hash an empty identifier.');
  return createHmac('sha256', key).update(`${purpose}:${normalised}`, 'utf8').digest();
}

/** The last characters of a normalised identifier, for display ("ends in 4821"). */
export function lastCharacters(value: string, count = 4): string {
  const normalised = normaliseIdentifier(value);
  return normalised.slice(-Math.min(count, normalised.length));
}
