import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { systemContext, type TenantContext } from '../common/request-context.js';
import type { AppConfig } from '../config/config.js';
import type { Db, Tx } from '../database/database.module.js';
import { CompanyKeysService, type KeyPurpose } from './company-keys.service.js';
import { decryptField, encryptField, keyVersionOf } from './field-cipher.js';
import { KeyUnavailableError, type KeyProvider } from './key-provider.js';
import { lookupHash } from './lookup-hash.js';
import { SENSITIVE_FIELDS, type SensitiveFieldSpec } from './sensitive-fields.js';

/** Why a rotation was started (ADR-007 §10). */
export type RotationTrigger = 'scheduled' | 'compromise' | 'request';

export interface StartRotation {
  companyId: string;
  purpose: KeyPurpose;
  trigger: RotationTrigger;
  reason: string;
  requestedBy: string;
}

export interface RotationState {
  id: string;
  companyId: string;
  purpose: KeyPurpose;
  fromVersion: number;
  toVersion: number;
  status: 'rewriting' | 'settling' | 'completed';
  pass: number;
  rowsRewritten: number;
  settleUntil: Date | null;
}

export class RotationError extends Error {}

const BATCH_SIZE = 200;

/** Columns a field-key rotation re-encrypts: every register entry of a table with company rows. */
export function fieldColumns(): readonly SensitiveFieldSpec[] {
  return SENSITIVE_FIELDS.filter((field) => field.firstWrittenIn !== 'not-used');
}

/** Columns a lookup-key rotation re-hashes. */
export function lookupColumns(): readonly (SensitiveFieldSpec & { lookup: NonNullable<SensitiveFieldSpec['lookup']> })[] {
  return SENSITIVE_FIELDS.filter((field): field is SensitiveFieldSpec & { lookup: NonNullable<SensitiveFieldSpec['lookup']> } => field.lookup !== undefined);
}

/**
 * Data-key rotation (ADR-007 §10, stage E5). Runs as the platform role, one
 * company at a time, and never holds a plaintext value longer than one row.
 *
 *   start      adds version n+1 as the active key and keeps n for decryption
 *   rewriting  moves every value (field key) or hash (lookup key) onto n+1 in
 *              batches; resumable from the stored cursor, idempotent per row
 *   settling   waits KEY_ROTATION_SETTLE_SECONDS for requests that read key n
 *              before the switch; field values written with n are caught by a
 *              final check, lookup hashes by a second pass
 *   completed  key n is destroyed (wrapped key erased) once nothing uses it
 *
 * Every step is audited in the company's audit log, without key material.
 */
export class KeyRotationService {
  private readonly keys: CompanyKeysService;

  constructor(
    private readonly db: Db,
    private readonly provider: KeyProvider,
    private readonly config: AppConfig,
    private readonly audit: AuditService = new AuditService(),
  ) {
    this.keys = new CompanyKeysService(provider, config);
  }

  async start(input: StartRotation, requestId = `rotation:${input.companyId}`): Promise<RotationState> {
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500) throw new RotationError('Give a reason of 3 to 500 characters.');
    if (input.purpose === 'lookup' && input.trigger === 'scheduled') {
      throw new RotationError('Lookup keys are rotated only on suspected compromise (ADR-007 E-D7).');
    }
    const id = await this.db.transaction().execute(async (tx) => {
      const ctx = systemContext(input.companyId, requestId);
      const open = await tx
        .selectFrom('keyRotations')
        .select('id')
        .where('companyId', '=', input.companyId)
        .where('purpose', '=', input.purpose)
        .where('status', '<>', 'completed')
        .executeTakeFirst();
      if (open) throw new RotationError(`A ${input.purpose} key rotation is already in progress (${open.id}).`);
      const current = await tx
        .selectFrom('companyDataKeys')
        .select(['version'])
        .where('companyId', '=', input.companyId)
        .where('purpose', '=', input.purpose)
        .where('status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw new RotationError(`The company has no active ${input.purpose} key: nothing has been encrypted yet.`);

      const generated = await this.provider.generateDataKey({ companyId: input.companyId, purpose: input.purpose });
      try {
        await tx
          .updateTable('companyDataKeys')
          .set({ status: 'decrypt_only', retiredAt: sql`now()` })
          .where('companyId', '=', input.companyId)
          .where('purpose', '=', input.purpose)
          .where('version', '=', current.version)
          .execute();
        await tx
          .insertInto('companyDataKeys')
          .values({ companyId: input.companyId, purpose: input.purpose, version: current.version + 1, wrappedKey: generated.wrapped, kmsKeyRef: generated.keyRef })
          .execute();
      } finally {
        generated.plaintext.fill(0);
      }
      const row = await tx
        .insertInto('keyRotations')
        .values({
          companyId: input.companyId,
          purpose: input.purpose,
          fromVersion: current.version,
          toVersion: current.version + 1,
          triggerType: input.trigger,
          reason,
          requestedBy: input.requestedBy,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(tx, ctx, {
        action: 'key.rotation_started',
        entityType: 'company',
        entityId: input.companyId,
        metadata: { rotationId: row.id, purpose: input.purpose, fromVersion: current.version, toVersion: current.version + 1, trigger: input.trigger, reason, requestedBy: input.requestedBy },
      });
      return row.id;
    });
    return this.state(id);
  }

  /** Field-key rotations due by age (yearly, ADR-007 E-D7), for the scheduler. */
  async dueCompanies(now: Date): Promise<string[]> {
    const { rows } = await sql<{ companyId: string }>`
      select k.company_id as "companyId" from company_data_keys k
       where k.purpose = 'field' and k.status = 'active'
         and k.created_at < ${now}::timestamptz - make_interval(days => ${this.config.KEY_ROTATION_MAX_AGE_DAYS})
         and not exists (select 1 from key_rotations r where r.company_id = k.company_id and r.purpose = 'field' and r.status <> 'completed')
       order by k.created_at
       limit 100`.execute(this.db);
    return rows.map((row) => row.companyId);
  }

  /** Starts the yearly field-key rotation if it is still due (the scheduler may run twice). */
  async startScheduledIfDue(companyId: string, now: Date, requestId?: string): Promise<RotationState | null> {
    const due = await sql<{ due: boolean }>`
      select exists (
        select 1 from company_data_keys k
         where k.company_id = ${companyId}::uuid and k.purpose = 'field' and k.status = 'active'
           and k.created_at < ${now}::timestamptz - make_interval(days => ${this.config.KEY_ROTATION_MAX_AGE_DAYS})
           and not exists (select 1 from key_rotations r where r.company_id = k.company_id and r.purpose = 'field' and r.status <> 'completed')
      ) as due`.execute(this.db);
    if (!due.rows[0]?.due) return null;
    return this.start({ companyId, purpose: 'field', trigger: 'scheduled', reason: `Yearly rotation (key older than ${this.config.KEY_ROTATION_MAX_AGE_DAYS} days)`, requestedBy: 'worker' }, requestId);
  }

  /** Companies with a rotation in progress, for the scheduler. */
  async openCompanies(): Promise<string[]> {
    const rows = await this.db.selectFrom('keyRotations').select('companyId').distinct().where('status', '<>', 'completed').execute();
    return rows.map((row) => row.companyId);
  }

  async open(companyId: string): Promise<RotationState[]> {
    const rows = await this.db.selectFrom('keyRotations').select('id').where('companyId', '=', companyId).where('status', '<>', 'completed').orderBy('startedAt').execute();
    return Promise.all(rows.map((row) => this.state(row.id)));
  }

  async state(id: string): Promise<RotationState> {
    const row = await this.db.selectFrom('keyRotations').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new RotationError(`Rotation ${id} does not exist.`);
    return {
      id: row.id,
      companyId: row.companyId,
      purpose: row.purpose as KeyPurpose,
      fromVersion: row.fromVersion,
      toVersion: row.toVersion,
      status: row.status as RotationState['status'],
      pass: row.pass,
      rowsRewritten: Number(row.rowsRewritten),
      settleUntil: row.settleUntil,
    };
  }

  /**
   * Advances a rotation by up to `maxBatches` batches (each its own
   * transaction) and returns its state. Safe to call repeatedly and from
   * several workers: each batch locks the rotation row.
   */
  async step(id: string, options: { maxBatches?: number; now?: () => Date } = {}): Promise<RotationState> {
    const now = options.now ?? (() => new Date());
    for (let batch = 0; batch < (options.maxBatches ?? 50); batch += 1) {
      const progressed = await this.db.transaction().execute((tx) => this.advance(tx, id, now()));
      if (!progressed) break;
    }
    return this.state(id);
  }

  /** One unit of work; false when there is nothing to do right now. */
  private async advance(tx: Tx, id: string, now: Date): Promise<boolean> {
    const rotation = await tx.selectFrom('keyRotations').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!rotation || rotation.status === 'completed') return false;
    // Re-encryption is not an edit: rows keep their version and update time (app.touch_row).
    await sql`select set_config('app.key_rotation', 'on', true)`.execute(tx);
    const purpose = rotation.purpose as KeyPurpose;
    const ctx = systemContext(rotation.companyId, `rotation:${id}`);
    const columns = purpose === 'field' ? fieldColumns() : lookupColumns();

    if (rotation.status === 'settling') {
      if (rotation.settleUntil && rotation.settleUntil > now) return false;
      if (purpose === 'field') {
        const remaining = await this.valuesOnOlderKeys(tx, rotation.companyId, rotation.toVersion);
        if (remaining > 0) {
          // Written with the old key after the scan passed them: scan again.
          await tx.updateTable('keyRotations').set({ status: 'rewriting', cursorField: 0, cursorRowId: null }).where('id', '=', id).execute();
          return true;
        }
        await this.finish(tx, ctx, rotation);
        return false;
      }
      if (rotation.pass === 1) {
        // Hashes written with the old lookup key during pass 1 are replaced by pass 2.
        await tx.updateTable('keyRotations').set({ status: 'rewriting', pass: 2, cursorField: 0, cursorRowId: null }).where('id', '=', id).execute();
        return true;
      }
      await this.finish(tx, ctx, rotation);
      return false;
    }

    // rewriting
    const field = columns[rotation.cursorField];
    if (!field) {
      const settleUntil = new Date(now.getTime() + this.config.KEY_ROTATION_SETTLE_SECONDS * 1000);
      await tx.updateTable('keyRotations').set({ status: 'settling', settleUntil }).where('id', '=', id).execute();
      return this.config.KEY_ROTATION_SETTLE_SECONDS === 0;
    }
    const rewritten =
      purpose === 'field'
        ? await this.reencryptBatch(tx, ctx, field, rotation.cursorRowId, rotation.toVersion)
        : await this.rehashBatch(tx, ctx, field as SensitiveFieldSpec & { lookup: NonNullable<SensitiveFieldSpec['lookup']> }, rotation.cursorRowId, rotation.toVersion);
    await tx
      .updateTable('keyRotations')
      .set(
        rewritten.lastId === null
          ? { cursorField: rotation.cursorField + 1, cursorRowId: null, rowsRewritten: sql`rows_rewritten + ${rewritten.count}`, lastError: null }
          : { cursorRowId: rewritten.lastId, rowsRewritten: sql`rows_rewritten + ${rewritten.count}`, lastError: null },
      )
      .where('id', '=', id)
      .execute();
    return true;
  }

  /** Re-encrypts one batch of a column; lastId is null when the column is done. */
  private async reencryptBatch(
    tx: Tx,
    ctx: TenantContext,
    field: SensitiveFieldSpec,
    afterId: string | null,
    toVersion: number,
  ): Promise<{ count: number; lastId: string | null }> {
    const { rows } = await sql<{ id: string; value: Buffer }>`
      select id, ${sql.ref(field.column)} as value from ${sql.table(field.table)}
       where company_id = ${ctx.companyId}::uuid and ${sql.ref(field.column)} is not null
         and (${afterId}::uuid is null or id > ${afterId}::uuid)
       order by id limit ${BATCH_SIZE} for update`.execute(tx);
    if (rows.length === 0) return { count: 0, lastId: null };
    const target = await this.keys.version(tx, ctx, 'field', toVersion);
    const oldKeys = new Map<number, Buffer>();
    let count = 0;
    try {
      for (const row of rows) {
        const version = keyVersionOf(row.value);
        if (version >= toVersion) continue;
        let oldKey = oldKeys.get(version);
        if (!oldKey) {
          oldKey = await this.keys.version(tx, ctx, 'field', version);
          oldKeys.set(version, oldKey);
        }
        const binding = { companyId: ctx.companyId, table: field.table, column: field.column, rowId: row.id };
        const reencrypted = encryptField(target, toVersion, binding, decryptField(oldKey, binding, row.value));
        await sql`update ${sql.table(field.table)} set ${sql.ref(field.column)} = ${reencrypted}
                   where company_id = ${ctx.companyId}::uuid and id = ${row.id}::uuid`.execute(tx);
        count += 1;
      }
    } finally {
      target.fill(0);
      for (const key of oldKeys.values()) key.fill(0);
    }
    return { count, lastId: rows.length < BATCH_SIZE ? null : rows[rows.length - 1]!.id };
  }

  /** Recomputes one batch of lookup hashes with the new lookup key. */
  private async rehashBatch(
    tx: Tx,
    ctx: TenantContext,
    field: SensitiveFieldSpec & { lookup: NonNullable<SensitiveFieldSpec['lookup']> },
    afterId: string | null,
    toVersion: number,
  ): Promise<{ count: number; lastId: string | null }> {
    const { rows } = await sql<{ id: string; value: Buffer; hash: Buffer | null }>`
      select id, ${sql.ref(field.column)} as value, ${sql.ref(field.lookup.hashColumn)} as hash from ${sql.table(field.table)}
       where company_id = ${ctx.companyId}::uuid and ${sql.ref(field.column)} is not null
         and (${afterId}::uuid is null or id > ${afterId}::uuid)
       order by id limit ${BATCH_SIZE} for update`.execute(tx);
    if (rows.length === 0) return { count: 0, lastId: null };
    const lookupKey = await this.keys.version(tx, ctx, 'lookup', toVersion);
    const fieldKeys = new Map<number, Buffer>();
    let count = 0;
    try {
      for (const row of rows) {
        const version = keyVersionOf(row.value);
        let fieldKey = fieldKeys.get(version);
        if (!fieldKey) {
          fieldKey = await this.keys.version(tx, ctx, 'field', version);
          fieldKeys.set(version, fieldKey);
        }
        const binding = { companyId: ctx.companyId, table: field.table, column: field.column, rowId: row.id };
        const hash = lookupHash(lookupKey, field.lookup.purpose, decryptField(fieldKey, binding, row.value));
        if (row.hash?.equals(hash)) continue;
        await sql`update ${sql.table(field.table)} set ${sql.ref(field.lookup.hashColumn)} = ${hash}
                   where company_id = ${ctx.companyId}::uuid and id = ${row.id}::uuid`.execute(tx);
        count += 1;
      }
    } finally {
      lookupKey.fill(0);
      for (const key of fieldKeys.values()) key.fill(0);
    }
    return { count, lastId: rows.length < BATCH_SIZE ? null : rows[rows.length - 1]!.id };
  }

  /** Field values of the company still encrypted with a key older than `version`. */
  async valuesOnOlderKeys(tx: Tx | Db, companyId: string, version: number): Promise<number> {
    let total = 0;
    for (const field of fieldColumns()) {
      const { rows } = await sql<{ n: string }>`
        select count(*)::text as n from ${sql.table(field.table)}
         where company_id = ${companyId}::uuid and ${sql.ref(field.column)} is not null
           and app.ciphertext_key_version(${sql.ref(field.column)}) < ${version}`.execute(tx);
      total += Number(rows[0]?.n ?? 0);
    }
    return total;
  }

  private async finish(
    tx: Tx,
    ctx: TenantContext,
    rotation: { id: string; companyId: string; purpose: string; fromVersion: number; toVersion: number; rowsRewritten: string | number | bigint },
  ): Promise<void> {
    const destroyed = await tx
      .updateTable('companyDataKeys')
      .set({ status: 'destroyed', wrappedKey: null, destroyedAt: sql`now()` })
      .where('companyId', '=', rotation.companyId)
      .where('purpose', '=', rotation.purpose)
      .where('version', '=', rotation.fromVersion)
      .where('status', '=', 'decrypt_only')
      .executeTakeFirst();
    if (Number(destroyed.numUpdatedRows) !== 1) throw new KeyUnavailableError(`key version ${rotation.fromVersion} was not in decrypt-only state`);
    await tx.updateTable('keyRotations').set({ status: 'completed', completedAt: sql`now()`, settleUntil: null }).where('id', '=', rotation.id).execute();
    await this.audit.record(tx, ctx, {
      action: 'key.destroyed',
      entityType: 'company',
      entityId: rotation.companyId,
      metadata: { rotationId: rotation.id, purpose: rotation.purpose, version: rotation.fromVersion },
    });
    await this.audit.record(tx, ctx, {
      action: 'key.rotation_completed',
      entityType: 'company',
      entityId: rotation.companyId,
      metadata: { rotationId: rotation.id, purpose: rotation.purpose, fromVersion: rotation.fromVersion, toVersion: rotation.toVersion, rowsRewritten: Number(rotation.rowsRewritten) },
    });
  }

  /** Overwrites cached key material (shutdown, tests). */
  close(): void {
    this.keys.clear();
  }
}
