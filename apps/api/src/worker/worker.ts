import { sql } from 'kysely';

import type { AuditService } from '../audit/audit.service.js';
import type { KeyRotationService } from '../crypto/key-rotation.service.js';
import { systemContext } from '../common/request-context.js';
import type { Db, TenantDb } from '../database/database.module.js';
import { refreshRequirementMatches } from '../dashboards/dashboards.service.js';
import { expireExports } from '../exports/exports.service.js';
import type { ListingsService } from '../listings/listings.service.js';
import type { MediaProcessor } from '../media/media-processor.js';
import { ARCHIVE_RETENTION_DAYS, MEDIA_PROCESS_JOB, purgeMedia } from '../media/media.service.js';
import type { StoragePort } from '../media/storage.js';
import type { ClaimedJob, JobQueue } from './queue.js';

export const JOBS = {
  mediaProcess: MEDIA_PROCESS_JOB,
  listingExpire: 'listing.expire',
  uploadCleanup: 'upload.cleanup',
  mediaTimeout: 'media.timeout',
  mediaPurge: 'media.purge',
  storageReconcile: 'storage.reconcile',
  exportExpire: 'export.expire',
  requirementMatchRefresh: 'requirement.match_refresh',
  keyRotate: 'key.rotate',
} as const;

/** Batches (of 200 rows) one key-rotation job handles before handing over to a follow-up job. */
const ROTATION_BATCHES_PER_JOB = 50;

/** Pending media older than this with no live job is marked failed. */
const PROCESSING_TIMEOUT_MINUTES = 30;
const PURGE_BATCH = 100;

export interface WorkerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface WorkerDeps {
  platformDb: Db;
  tenantDb: TenantDb;
  queue: JobQueue;
  storage: StoragePort;
  processor: MediaProcessor;
  listings: ListingsService;
  audit: AuditService;
  rotation: KeyRotationService;
  logger: WorkerLogger;
}

export interface TickResult {
  enqueued: number;
  processed: number;
  failed: number;
}

/**
 * The background worker (verification report §9). `runOnce` performs one
 * scheduler pass and drains due jobs; `start` repeats it until stopped.
 */
export class Worker {
  private stopping = false;
  private lastSchedule = 0;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly options: { batchSize?: number; scheduleEveryMs?: number; now?: () => Date } = {},
  ) {}

  async start(idleMs = 2_000): Promise<void> {
    this.deps.logger.info('worker started');
    while (!this.stopping) {
      try {
        const result = await this.runOnce();
        if (result.processed + result.failed === 0) await sleep(idleMs);
      } catch (error) {
        this.deps.logger.error('worker pass failed', { error: errorMessage(error) });
        await sleep(idleMs);
      }
    }
    this.deps.logger.info('worker stopped');
  }

  stop(): void {
    this.stopping = true;
  }

  async runOnce(): Promise<TickResult> {
    let enqueued = 0;
    const now = this.now();
    if (now.getTime() - this.lastSchedule >= (this.options.scheduleEveryMs ?? 60_000)) {
      enqueued = await this.schedule(now);
      this.lastSchedule = now.getTime();
    }
    await this.deps.queue.releaseExpiredLocks();
    let processed = 0;
    let failed = 0;
    for (;;) {
      const jobs = await this.deps.queue.claim(Object.values(JOBS), this.options.batchSize ?? 10);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        if (await this.execute(job)) processed += 1;
        else failed += 1;
      }
    }
    return { enqueued, processed, failed };
  }

  /**
   * Finds companies with due work (platform role, read-only discovery) and
   * enqueues one job per company and time slot; the key makes it idempotent.
   */
  async schedule(now: Date = this.now()): Promise<number> {
    const db = this.deps.platformDb;
    const hour = now.toISOString().slice(0, 13);
    const quarter = `${hour}:${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, '0')}`;
    const day = now.toISOString().slice(0, 10);
    const discover = async (jobType: string, slot: string, query: ReturnType<typeof sql<{ companyId: string }>>) => {
      const { rows } = await query.execute(db);
      let count = 0;
      for (const { companyId } of rows) {
        if (await this.deps.queue.enqueue(companyId, jobType, `${jobType}:${slot}`)) count += 1;
      }
      return count;
    };

    let enqueued = 0;
    // Coarse UTC filter; the job compares with each property's local date.
    enqueued += await discover(
      JOBS.listingExpire,
      hour,
      sql<{ companyId: string }>`select distinct company_id as "companyId" from listings
        where status in ('available', 'reserved', 'under_contract') and archived_at is null
          and mandate_expires_on < (${now}::timestamptz at time zone 'UTC')::date + 1`,
    );
    enqueued += await discover(
      JOBS.uploadCleanup,
      quarter,
      sql<{ companyId: string }>`select distinct company_id as "companyId" from upload_sessions where status = 'pending' and expires_at < ${now}::timestamptz`,
    );
    enqueued += await discover(
      JOBS.mediaTimeout,
      quarter,
      sql<{ companyId: string }>`select distinct company_id as "companyId" from property_media
        where processing_status = 'pending' and created_at < ${now}::timestamptz - make_interval(mins => ${PROCESSING_TIMEOUT_MINUTES})`,
    );
    enqueued += await discover(
      JOBS.mediaPurge,
      day,
      sql<{ companyId: string }>`select distinct company_id as "companyId" from property_media
        where archived_at < ${now}::timestamptz - make_interval(days => ${ARCHIVE_RETENTION_DAYS}) and not legal_hold`,
    );
    enqueued += await discover(JOBS.storageReconcile, day, sql<{ companyId: string }>`select company_id as "companyId" from storage_usage`);
    // The CRM dashboard's "no match" figure (decision D4 rules), every 15 minutes.
    enqueued += await discover(
      JOBS.requirementMatchRefresh,
      quarter,
      sql<{ companyId: string }>`select distinct company_id as "companyId" from requirements where status = 'active'`,
    );
    // Export files are deleted as soon as they expire (24 hours, CA-16).
    enqueued += await discover(
      JOBS.exportExpire,
      quarter,
      sql<{ companyId: string }>`select distinct company_id as "companyId" from export_jobs where status = 'completed' and expires_at <= ${now}::timestamptz`,
    );

    // Field-key rotation (ADR-007 §10): yearly per company, then every quarter
    // hour while a rotation is in progress (rewriting or settling).
    for (const companyId of await this.deps.rotation.dueCompanies(now)) {
      if (await this.deps.queue.enqueue(companyId, JOBS.keyRotate, `${JOBS.keyRotate}:start:${day}`, { start: 'scheduled' })) enqueued += 1;
    }
    for (const companyId of await this.deps.rotation.openCompanies()) {
      if (await this.deps.queue.enqueue(companyId, JOBS.keyRotate, `${JOBS.keyRotate}:${quarter}`)) enqueued += 1;
    }

    // Global housekeeping: expired idempotency records (not company business data).
    await sql`delete from idempotency_keys where expires_at < ${now}::timestamptz`.execute(db);
    return enqueued;
  }

  private async execute(job: ClaimedJob): Promise<boolean> {
    const requestId = `job:${job.id}`;
    try {
      await this.handle(job, requestId);
      await this.deps.queue.complete(job.id);
      return true;
    } catch (error) {
      const outcome = await this.deps.queue.retryOrFail(job, errorMessage(error));
      this.deps.logger.warn('job failed', { jobId: job.id, jobType: job.jobType, companyId: job.companyId, attempt: job.attempts, outcome, error: errorMessage(error) });
      if (outcome === 'failed' && job.jobType === JOBS.mediaProcess) {
        // One bad job must never stop the pass: a failure here is logged and left to the timeout sweep.
        await this.deps.processor
          .fail(job.companyId, String(job.payload['mediaId']), requestId, 'Processing failed after several attempts. Upload the file again.')
          .catch((failure: unknown) => this.deps.logger.error('could not mark media as failed', { jobId: job.id, error: errorMessage(failure) }));
      }
      return false;
    }
  }

  private async handle(job: ClaimedJob, requestId: string): Promise<void> {
    const { tenantDb, storage, audit, listings, processor } = this.deps;
    const scope = { companyId: job.companyId, userId: '' };
    const ctx = systemContext(job.companyId, requestId);
    switch (job.jobType) {
      case JOBS.mediaProcess:
        await processor.process(job.companyId, String(job.payload['mediaId']), requestId);
        return;

      case JOBS.listingExpire:
        await tenantDb.run(scope, async (tx) => {
          const expired = await listings.expireDue(tx, ctx);
          if (expired.length > 0) this.deps.logger.info('listings expired', { companyId: job.companyId, count: expired.length });
        });
        return;

      case JOBS.uploadCleanup: {
        const keys = await tenantDb.run(scope, async (tx) => {
          const expired = await tx
            .updateTable('uploadSessions')
            .set({ status: 'expired' })
            .where('status', '=', 'pending')
            .where('expiresAt', '<', this.now())
            .returning(['quarantineKey', 'declaredSize'])
            .execute();
          const bytes = expired.reduce((sum, row) => sum + Number(row.declaredSize), 0);
          if (bytes > 0) {
            await tx
              .updateTable('storageUsage')
              .set({ bytesReserved: sql`greatest(bytes_reserved - ${bytes}, 0)`, updatedAt: sql`now()` })
              .where('companyId', '=', job.companyId)
              .execute();
          }
          return expired.map((row) => row.quarantineKey);
        });
        // Anything uploaded but never confirmed (the storage lifecycle rule is the backstop).
        await storage.remove(keys);
        return;
      }

      case JOBS.mediaTimeout: {
        const stuck = await tenantDb.run(scope, (tx) =>
          tx
            .selectFrom('propertyMedia as m')
            .select('m.id')
            .where('m.processingStatus', '=', 'pending')
            .where('m.createdAt', '<', sql<Date>`${this.now()}::timestamptz - make_interval(mins => ${PROCESSING_TIMEOUT_MINUTES})`)
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('scheduledJobs as j')
                    .select('j.id')
                    .where('j.jobType', '=', JOBS.mediaProcess)
                    .whereRef('j.entityId', '=', 'm.id')
                    .where('j.status', 'in', ['pending', 'running']),
                ),
              ),
            )
            .execute(),
        );
        for (const { id } of stuck) await processor.fail(job.companyId, id, requestId, 'Processing did not complete. Upload the file again.');
        return;
      }

      case JOBS.mediaPurge:
        await tenantDb.run(scope, async (tx) => {
          const due = await tx
            .selectFrom('propertyMedia')
            .selectAll()
            .where('archivedAt', '<', sql<Date>`${this.now()}::timestamptz - make_interval(days => ${ARCHIVE_RETENTION_DAYS})`)
            .where('legalHold', '=', false)
            .orderBy('archivedAt')
            .limit(PURGE_BATCH)
            .forUpdate()
            .execute();
          for (const row of due) {
            await purgeMedia(tx, ctx, storage, audit, row, { reason: `Archived for more than ${ARCHIVE_RETENTION_DAYS} days` });
          }
          if (due.length === PURGE_BATCH) await this.deps.queue.enqueue(job.companyId, JOBS.mediaPurge, `${JOBS.mediaPurge}:${job.id}:more`);
        });
        return;

      case JOBS.storageReconcile:
        await tenantDb.run(scope, async (tx) => {
          const actual = await tx
            .selectFrom('propertyMedia')
            .select(sql<string>`coalesce(sum(size_bytes), 0)::text`.as('bytes'))
            .where('processingStatus', '=', 'ready')
            .where('externalUrl', 'is', null)
            .executeTakeFirstOrThrow();
          const reserved = await tx
            .selectFrom('uploadSessions as s')
            .leftJoin('propertyMedia as m', 'm.id', 's.mediaId')
            .select(sql<string>`coalesce(sum(s.declared_size), 0)::text`.as('bytes'))
            .where((eb) => eb.or([eb('s.status', '=', 'pending'), eb.and([eb('s.status', '=', 'confirmed'), eb('m.processingStatus', '=', 'pending')])]))
            .executeTakeFirstOrThrow();
          const current = await tx.selectFrom('storageUsage').select(['bytesUsed', 'bytesReserved']).where('companyId', '=', job.companyId).forUpdate().executeTakeFirst();
          if (!current) return;
          const used = Number(actual.bytes);
          const held = Number(reserved.bytes);
          if (Number(current.bytesUsed) === used && Number(current.bytesReserved) === held) return;
          await tx.updateTable('storageUsage').set({ bytesUsed: used, bytesReserved: held, updatedAt: sql`now()` }).where('companyId', '=', job.companyId).execute();
          await audit.record(tx, ctx, {
            action: 'storage.reconciled',
            entityType: 'company',
            entityId: job.companyId,
            changes: { bytesUsed: { old: Number(current.bytesUsed), new: used }, bytesReserved: { old: Number(current.bytesReserved), new: held } },
          });
          this.deps.logger.warn('storage usage drift corrected', { companyId: job.companyId, used, reserved: held });
        });
        return;

      case JOBS.requirementMatchRefresh:
        await tenantDb.run(scope, async (tx) => {
          await refreshRequirementMatches(tx, ctx);
        });
        return;

      case JOBS.exportExpire:
        await tenantDb.run(scope, async (tx) => {
          const count = await expireExports(tx, ctx, storage, audit);
          if (count > 0) this.deps.logger.info('exports expired', { companyId: job.companyId, count });
        });
        return;

      case JOBS.keyRotate: {
        const { rotation, logger, queue } = this.deps;
        if (job.payload['start'] === 'scheduled') {
          const started = await rotation.startScheduledIfDue(job.companyId, this.now(), requestId);
          if (started) logger.info('key rotation started', { companyId: job.companyId, rotationId: started.id, purpose: started.purpose });
        }
        let more = false;
        for (const open of await rotation.open(job.companyId)) {
          const state = await rotation.step(open.id, { maxBatches: ROTATION_BATCHES_PER_JOB, now: () => this.now() });
          if (state.status === 'completed') logger.info('key rotation completed', { companyId: job.companyId, rotationId: state.id, rows: state.rowsRewritten });
          if (state.status === 'rewriting') more = true;
        }
        if (more) await queue.enqueue(job.companyId, JOBS.keyRotate, `${JOBS.keyRotate}:${job.id}:more`);
        return;
      }

      default:
        throw new Error(`Unknown job type ${job.jobType}`);
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
