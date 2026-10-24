import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import type { Tx } from '../database/database.module.js';
import { registerConstraintMessages } from './db-errors.js';
import { Problems } from './problem.js';
import type { TenantContext } from './request-context.js';

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,255}$/;

registerConstraintMessages({
  idempotency_keys_pkey: 'A request with this Idempotency-Key is already being processed. Retry shortly.',
});

export interface StoredResponse<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotent creates (ADR-003 §4). Runs inside the caller's tenant
 * transaction, so the key, the created record and the stored response commit
 * together. The same key with the same request replays the first response;
 * with a different request it is rejected.
 */
@Injectable()
export class IdempotencyService {
  async run<T>(
    tx: Tx,
    ctx: TenantContext,
    key: string | undefined,
    request: { method: string; path: string; body: unknown },
    handler: () => Promise<{ status: number; body: T }>,
  ): Promise<StoredResponse<T>> {
    if (key === undefined) return { ...(await handler()), replayed: false };
    if (!KEY_PATTERN.test(key)) {
      throw Problems.validation([
        { field: 'Idempotency-Key', code: 'invalid', message: 'Use 8–255 characters: letters, digits, ".", "_", ":" or "-".' },
      ]);
    }

    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest();

    await tx
      .deleteFrom('idempotencyKeys')
      .where('companyId', '=', ctx.companyId)
      .where('key', '=', key)
      .where('expiresAt', '<=', sql<Date>`now()`)
      .execute();

    const existing = await tx
      .selectFrom('idempotencyKeys')
      .select(['requestHash', 'responseStatus', 'responseBody'])
      .where('companyId', '=', ctx.companyId)
      .where('key', '=', key)
      .forUpdate()
      .executeTakeFirst();

    if (existing) {
      if (!existing.requestHash.equals(requestHash)) throw Problems.idempotencyKeyReused();
      if (existing.responseStatus !== null) {
        return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
      }
    }

    await tx
      .insertInto('idempotencyKeys')
      .values({
        companyId: ctx.companyId,
        key,
        requestMethod: request.method,
        requestPath: request.path,
        requestHash,
      })
      .execute();

    const result = await handler();
    await tx
      .updateTable('idempotencyKeys')
      .set({ responseStatus: result.status, responseBody: JSON.stringify(result.body) })
      .where('companyId', '=', ctx.companyId)
      .where('key', '=', key)
      .execute();
    return { ...result, replayed: false };
  }
}
