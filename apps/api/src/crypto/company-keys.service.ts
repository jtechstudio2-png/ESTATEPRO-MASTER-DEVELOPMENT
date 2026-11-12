import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import type { TenantContext } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { Tx } from '../database/database.module.js';
import { KEY_PROVIDER, type KeyProvider, KeyUnavailableError, type WrapContext } from './key-provider.js';

export type KeyPurpose = WrapContext['purpose'];

export interface CompanyKey {
  version: number;
  key: Buffer;
}

interface CacheEntry {
  key: Buffer;
  expiresAt: number;
}

/**
 * Company data keys (ADR-007 §4). Reads wrapped keys inside the caller's
 * tenant transaction (so row-level security limits them to that company),
 * unwraps them with the key provider and keeps the result in a small,
 * time-limited in-memory cache. A company's first key is created on first use.
 */
@Injectable()
export class CompanyKeysService implements OnModuleDestroy {
  private readonly logger = new Logger(CompanyKeysService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @Inject(KEY_PROVIDER) private readonly provider: KeyProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The key to encrypt or hash new values with. The returned buffer belongs to
   * the caller, who should overwrite it (fill(0)) when done. Creates the
   * company's first key if there is none.
   */
  async active(tx: Tx, ctx: TenantContext, purpose: KeyPurpose): Promise<CompanyKey> {
    let row = await this.activeRow(tx, ctx, purpose);
    if (!row) {
      const generated = await this.provider.generateDataKey({ companyId: ctx.companyId, purpose });
      try {
        await tx
          .insertInto('companyDataKeys')
          .values({ companyId: ctx.companyId, purpose, version: 1, wrappedKey: generated.wrapped, kmsKeyRef: generated.keyRef })
          .onConflict((conflict) => conflict.doNothing())
          .execute();
      } finally {
        generated.plaintext.fill(0);
      }
      // Another request may have created the key first: always use the stored one.
      row = await this.activeRow(tx, ctx, purpose);
      if (!row) throw new KeyUnavailableError('the company key could not be created');
    }
    return { version: row.version, key: await this.unwrapped(ctx.companyId, purpose, row) };
  }

  /** A specific key version, for decrypting values written with it. Destroyed keys are unavailable. */
  async version(tx: Tx, ctx: TenantContext, purpose: KeyPurpose, version: number): Promise<Buffer> {
    const cached = this.fromCache(cacheKey(ctx.companyId, purpose, version));
    if (cached) return Buffer.from(cached);
    const row = await tx
      .selectFrom('companyDataKeys')
      .select(['version', 'wrappedKey', 'kmsKeyRef', 'status'])
      .where('companyId', '=', ctx.companyId)
      .where('purpose', '=', purpose)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!row || row.status === 'destroyed' || row.wrappedKey === null) {
      throw new KeyUnavailableError(`key version ${version} is not available`);
    }
    return this.unwrapped(ctx.companyId, purpose, { version: row.version, wrappedKey: row.wrappedKey, kmsKeyRef: row.kmsKeyRef });
  }

  /** Empties the cache and overwrites cached key material (shutdown, tests). */
  clear(): void {
    for (const entry of this.cache.values()) entry.key.fill(0);
    this.cache.clear();
  }

  onModuleDestroy(): void {
    this.clear();
  }

  private async activeRow(
    tx: Tx,
    ctx: TenantContext,
    purpose: KeyPurpose,
  ): Promise<{ version: number; wrappedKey: Buffer; kmsKeyRef: string } | undefined> {
    const row = await tx
      .selectFrom('companyDataKeys')
      .select(['version', 'wrappedKey', 'kmsKeyRef'])
      .where('companyId', '=', ctx.companyId)
      .where('purpose', '=', purpose)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.wrappedKey === null) throw new KeyUnavailableError('the active key has no key material');
    return { version: row.version, wrappedKey: row.wrappedKey, kmsKeyRef: row.kmsKeyRef };
  }

  private async unwrapped(
    companyId: string,
    purpose: KeyPurpose,
    row: { version: number; wrappedKey: Buffer; kmsKeyRef: string },
  ): Promise<Buffer> {
    const id = cacheKey(companyId, purpose, row.version);
    const cached = this.fromCache(id);
    if (cached) return Buffer.from(cached);
    let key: Buffer;
    try {
      key = await this.provider.unwrap(row.wrappedKey, row.kmsKeyRef, { companyId, purpose });
    } catch (error) {
      // Logged without key material or company data beyond the id.
      this.logger.error({ companyId, purpose, version: row.version, provider: this.provider.name }, (error as Error).message);
      throw error instanceof KeyUnavailableError ? error : new KeyUnavailableError('the key provider failed');
    }
    if (this.remember(id, key)) return Buffer.from(key);
    return key;
  }

  private fromCache(id: string): Buffer | undefined {
    const entry = this.cache.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      entry.key.fill(0);
      this.cache.delete(id);
      return undefined;
    }
    // Refresh the position for least-recently-used eviction, not the expiry.
    this.cache.delete(id);
    this.cache.set(id, entry);
    return entry.key;
  }

  /** Caches the key; returns false when caching is off. Callers always get their own copy of cached keys. */
  private remember(id: string, key: Buffer): boolean {
    const ttlMs = this.config.FIELD_KEY_CACHE_TTL_SECONDS * 1000;
    if (ttlMs === 0) return false;
    while (this.cache.size >= this.config.FIELD_KEY_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.get(oldest)?.key.fill(0);
      this.cache.delete(oldest);
    }
    this.cache.set(id, { key, expiresAt: Date.now() + ttlMs });
    return true;
  }
}

function cacheKey(companyId: string, purpose: KeyPurpose, version: number): string {
  return `${companyId}:${purpose}:${version}`;
}
