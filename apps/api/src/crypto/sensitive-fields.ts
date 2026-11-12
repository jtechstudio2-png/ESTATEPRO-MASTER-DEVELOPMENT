import type { LookupPurpose } from './lookup-hash.js';

/**
 * The register of every field-encrypted column (ADR-007 §3). A catalogue test
 * fails when the database has an *_encrypted column that is not listed here,
 * or when any index includes one, so encrypted data cannot be added or indexed
 * by accident.
 */
export interface SensitiveFieldSpec {
  table: string;
  /** Database column holding the ciphertext. */
  column: string;
  /** Name of the plaintext value in API requests and responses. Redacted from logs. */
  apiName: string;
  /** Data class (ADR-007 §2). */
  dataClass: 'C3' | 'C4';
  /** Keyed hash for exact-match lookup, where approved. */
  lookup?: { purpose: LookupPurpose; hashColumn: string };
  /** Column holding the last characters for display, where approved. */
  last4Column?: string;
  /** Phase in which the API starts writing the field. */
  firstWrittenIn: 'phase-5' | 'phase-7' | 'phase-9' | 'phase-12' | 'not-used';
}

export const SENSITIVE_FIELDS: readonly SensitiveFieldSpec[] = [
  { table: 'contacts', column: 'date_of_birth_encrypted', apiName: 'dateOfBirth', dataClass: 'C3', firstWrittenIn: 'phase-5' },
  {
    table: 'contacts',
    column: 'tax_number_encrypted',
    apiName: 'taxNumber',
    dataClass: 'C3',
    lookup: { purpose: 'tax_number', hashColumn: 'tax_number_hash' },
    last4Column: 'tax_number_last4',
    firstWrittenIn: 'phase-5',
  },
  {
    table: 'contacts',
    column: 'organisation_reg_number_encrypted',
    apiName: 'organisationRegNumber',
    dataClass: 'C3',
    firstWrittenIn: 'phase-5',
  },
  {
    table: 'identity_documents',
    column: 'number_encrypted',
    apiName: 'documentNumber',
    dataClass: 'C3',
    lookup: { purpose: 'identity_number', hashColumn: 'number_hash' },
    last4Column: 'number_last4',
    firstWrittenIn: 'phase-5',
  },
  { table: 'contact_payment_accounts', column: 'account_number_encrypted', apiName: 'accountNumber', dataClass: 'C3', last4Column: 'last4', firstWrittenIn: 'phase-7' },
  { table: 'contact_payment_accounts', column: 'routing_encrypted', apiName: 'routingCode', dataClass: 'C3', firstWrittenIn: 'phase-7' },
  { table: 'bank_accounts', column: 'account_number_encrypted', apiName: 'accountNumber', dataClass: 'C3', last4Column: 'last4', firstWrittenIn: 'phase-9' },
  { table: 'webhook_endpoints', column: 'secret_encrypted', apiName: 'signingSecret', dataClass: 'C4', firstWrittenIn: 'phase-12' },
  // MFA is held by the identity provider (ADR-001); the column stays unused.
  { table: 'mfa_factors', column: 'secret_encrypted', apiName: 'mfaSecret', dataClass: 'C4', firstWrittenIn: 'not-used' },
];

/** Contact fields that can be revealed through the API (ADR-007 §9). */
export const REVEALABLE_CONTACT_FIELDS = {
  dateOfBirth: 'date_of_birth_encrypted',
  taxNumber: 'tax_number_encrypted',
  organisationRegNumber: 'organisation_reg_number_encrypted',
} as const;
export type RevealableContactField = keyof typeof REVEALABLE_CONTACT_FIELDS;

/**
 * Log redaction paths: every plaintext API name, at any depth pino supports,
 * plus request bodies (never logged today; redacted in case a serializer adds them).
 */
export function sensitiveLogPaths(): string[] {
  const names = [...new Set(SENSITIVE_FIELDS.map((field) => field.apiName))];
  return ['req.body', 'res.body', ...names.flatMap((name) => [name, `*.${name}`, `*.*.${name}`])];
}
