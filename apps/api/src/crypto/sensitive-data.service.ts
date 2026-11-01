import { Injectable } from '@nestjs/common';

import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { CompanyKeysService } from './company-keys.service.js';
import { decryptField, encryptField, type FieldBinding, FieldDecryptionError, keyVersionOf } from './field-cipher.js';
import { KeyUnavailableError } from './key-provider.js';
import { lastCharacters, lookupHash, type LookupPurpose } from './lookup-hash.js';

/** Column values for a protected identifier: ciphertext, lookup hash and display suffix. */
export interface ProtectedIdentifier {
  encrypted: Buffer;
  hash: Buffer;
  last4: string;
}

/**
 * The only way API code writes or reads field-encrypted values (ADR-007 E3).
 * Callers pass where the value lives (company, table, column, row); the
 * service picks the company key, binds the ciphertext to that place and maps
 * key and integrity failures to safe problem responses that never contain
 * the value.
 */
@Injectable()
export class SensitiveDataService {
  constructor(private readonly keys: CompanyKeysService) {}

  /** Encrypts a value for one column of one row. */
  async seal(tx: Tx, ctx: TenantContext, place: Omit<FieldBinding, 'companyId'>, plaintext: string): Promise<Buffer> {
    if (plaintext.length === 0) throw new Error('Protected values cannot be empty; store NULL instead.');
    return this.guard(async () => {
      const active = await this.keys.active(tx, ctx, 'field');
      try {
        return encryptField(active.key, active.version, { ...place, companyId: ctx.companyId }, plaintext);
      } finally {
        active.key.fill(0);
      }
    });
  }

  /** Decrypts a value read from one column of one row. */
  async open(tx: Tx, ctx: TenantContext, place: Omit<FieldBinding, 'companyId'>, ciphertext: Buffer): Promise<string> {
    return this.guard(async () => {
      const key = await this.keys.version(tx, ctx, 'field', keyVersionOf(ciphertext));
      try {
        return decryptField(key, { ...place, companyId: ctx.companyId }, ciphertext);
      } finally {
        key.fill(0);
      }
    });
  }

  /** Keyed lookup hash, for exact-match search and duplicate detection. */
  async hash(tx: Tx, ctx: TenantContext, purpose: LookupPurpose, value: string): Promise<Buffer> {
    return this.guard(async () => {
      const active = await this.keys.active(tx, ctx, 'lookup');
      try {
        return lookupHash(active.key, purpose, value);
      } finally {
        active.key.fill(0);
      }
    });
  }

  /** Ciphertext, hash and last characters for an identifier column group (ID, tax or account number). */
  async protectIdentifier(
    tx: Tx,
    ctx: TenantContext,
    place: Omit<FieldBinding, 'companyId'>,
    purpose: LookupPurpose,
    value: string,
  ): Promise<ProtectedIdentifier> {
    return {
      encrypted: await this.seal(tx, ctx, place, value),
      hash: await this.hash(tx, ctx, purpose, value),
      last4: lastCharacters(value),
    };
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof KeyUnavailableError) throw Problems.encryptionUnavailable();
      if (error instanceof FieldDecryptionError) {
        throw Problems.businessRule('This protected value cannot be read. It may have been damaged; contact support.');
      }
      throw error;
    }
  }
}
