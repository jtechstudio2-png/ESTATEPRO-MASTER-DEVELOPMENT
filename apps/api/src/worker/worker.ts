import { sql } from 'kysely';

import type { AuditService } from '../audit/audit.service.js';
import type { KeyRotationService } from '../crypto/key-rotation.service.js';
import { systemContext } from '../common/request-context.js';
import type { Db, TenantDb } from '../database/database.module.js';
import { MATCH_REFRESH_BATCH, refreshRequirementMatchBatch, removeInactiveMatchStatus } from '../dashboards/dashboards.service.js';
import { expireExports } from '../exports/exports.service.js';
import type { ListingsService } from '../listings/listings.service.js';
import type { DocumentScanner } from '../documents/document-scanner.js';
import { DOCUMENT_SCAN_JOB } from '../documents/documents.service.js';
import { ARREARS_BATCH, arrearsWorkflowBatch } from '../lettings/arrears-workflow.js';
import { ARREARS_STEPS_KEY, arrearsSteps } from '../lettings/arrears.service.js';
import { RENEWAL_BATCH, renewalReminderBatch } from '../lettings/renewal-workflow.js';
import { CHARGE_LEAD_DAYS_KEY, chargeLeadDays, notifyReviewsDue, postRentBatch, postScheduledDue, RENT_POSTING_BATCH } from '../lettings/rent-schedule.js';
import type { MediaProcessor } from '../media/media-processor.js';
import { expireOffers } from '../offers/offers.service.js';
import { ARCHIVE_RETENTION_DAYS, MEDIA_PROCESS_JOB, purgeMedia } from '../media/media.service.js';
import type { StoragePort } from '../media/storage.js';
import { LockLostError, type ClaimedJob, type JobQueue } from './queue.js';

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
  offerExpire: 'offer.expire',
  documentScan: DOCUMENT_SCAN_JOB,
  rentSchedule: 'rent.schedule',
  rentPostDue: 'rent.post_due',
  arrearsWorkflow: 'arrears.workflow',
  leaseRenewals: 'lease.renewals',
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
  documentScanner: DocumentScanner;
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
    private readonly options: { batchSize?: number; scheduleEveryMs?: number; now?: () => Date; jobTypes?: readonly string[] } = {},
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
      const jobs = await this.deps.queue.claim(this.options.jobTypes ?? Object.values(JOBS), this.options.batchSize ?? 10);
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
      sql<{ companyId: string }>`select company_id as "companyId" from upload_sessions where status = 'pending' and expires_at < ${now}::timestamptz
        union select company_id from document_upload_sessions where status = 'pending' and expires_at < ${now}::timestamptz`,
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

    // Open offers past their expiry time (S2), every 15 minutes.
    enqueued += await discover(
      JOBS.offerExpire,
      quarter,
      sql<{ companyId: string }>`select distinct company_id as "companyId" from offers where status = 'submitted' and expires_at <= ${now}::timestamptz`,
    );

    // The rent schedule (P7-D6): daily, for companies with a lead time and scheduled leases.
    enqueued += await discover(
      JOBS.rentSchedule,
      day,
      sql<{ companyId: string }>`select s.company_id as "companyId" from company_settings s
        where s.key = ${CHARGE_LEAD_DAYS_KEY} and s.office_id is null
          and exists (select 1 from leases l where l.company_id = s.company_id and l.rent_schedule_from is not null
                        and l.status in ('active', 'periodic', 'notice_given'))`,
    );
    // Scheduled charges due and rent reviews whose date has come, hourly (each property's local date decides).
    enqueued += await discover(
      JOBS.rentPostDue,
      hour,
      sql<{ companyId: string }>`select company_id as "companyId" from rent_charges
          where status = 'scheduled' and due_date <= (${now}::timestamptz at time zone 'UTC')::date + 1
        union select company_id from rent_reviews
          where status in ('scheduled', 'proposed') and due_notified_at is null and review_date <= (${now}::timestamptz at time zone 'UTC')::date + 1`,
    );

    // The arrears workflow (P7-D10): daily, for companies with arrears steps set.
    enqueued += await discover(
      JOBS.arrearsWorkflow,
      day,
      sql<{ companyId: string }>`select company_id as "companyId" from company_settings where key = ${ARREARS_STEPS_KEY} and office_id is null`,
    );

    // Renewal reminders (readiness §5.6): daily, for companies with fixed-term leases ending within 90 days and no decision.
    enqueued += await discover(
      JOBS.leaseRenewals,
      day,
      sql<{ companyId: string }>`select distinct company_id as "companyId" from leases
        where status = 'active' and lease_type = 'fixed_term' and end_date is not null
          and renewal_status in ('not_due', 'pending_decision')
          and end_date <= (${now}::timestamptz at time zone 'UTC')::date + 91`,
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

  /**
   * Refreshes one company's "no match" status (decision D4) in batches of
   * MATCH_REFRESH_BATCH requirements, one short tenant transaction each (#42).
   * Run as a job, it renews the job's lock after every batch and stops if
   * another worker has taken the job over, so a refresh never runs twice at
   * once. Returns the number of requirements refreshed.
   */
  async refreshRequirementMatches(companyId: string, requestId = `match-refresh:${companyId}`, job?: ClaimedJob): Promise<number> {
    const scope = { companyId, userId: '' };
    const ctx = systemContext(companyId, requestId);
    let afterId: string | null = null;
    let total = 0;
    for (;;) {
      const batch = await this.deps.tenantDb.run(scope, (tx) => refreshRequirementMatchBatch(tx, ctx, afterId));
      total += batch.count;
      if (job && !(await this.deps.queue.renewLock(job))) throw new LockLostError(job.id);
      if (batch.count < MATCH_REFRESH_BATCH || batch.lastId === null) break;
      afterId = batch.lastId;
    }
    await this.deps.tenantDb.run(scope, (tx) => removeInactiveMatchStatus(tx));
    return total;
  }

  /**
   * The daily rent schedule of one company (P7-D6): leases in batches of
   * RENT_SCHEDULE_BATCH, one short tenant transaction each, renewing the job's
   * lock after every batch (#42). Idle while the company has no lead time
   * (W7-D7). Returns the leases looked at and the charges posted.
   */
  async runRentSchedule(companyId: string, requestId = `rent-schedule:${companyId}`, job?: ClaimedJob): Promise<{ leases: number; posted: number }> {
    const scope = { companyId, userId: '' };
    const ctx = systemContext(companyId, requestId);
    const lead = await this.deps.tenantDb.run(scope, (tx) => chargeLeadDays(tx));
    if (lead === null) return { leases: 0, posted: 0 };
    const now = this.now();
    let afterId: string | null = null;
    let leases = 0;
    let posted = 0;
    for (;;) {
      const batch = await this.deps.tenantDb.run(scope, (tx) => postRentBatch(tx, ctx, this.deps.audit, { afterId, leadDays: lead, now }));
      leases += batch.leases;
      posted += batch.posted;
      if (job && !(await this.deps.queue.renewLock(job))) throw new LockLostError(job.id);
      if (batch.lastId === null) break;
      afterId = batch.lastId;
    }
    if (posted > 0) this.deps.logger.info('rent charges posted', { companyId, leases, posted });
    return { leases, posted };
  }

  /** Posts scheduled charges whose due date has come and writes the rent-review-due notices, in batches. */
  async runRentPostDue(companyId: string, requestId = `rent-post-due:${companyId}`, job?: ClaimedJob): Promise<{ charges: number; reviews: number }> {
    const scope = { companyId, userId: '' };
    const ctx = systemContext(companyId, requestId);
    const now = this.now();
    let charges = 0;
    let reviews = 0;
    for (;;) {
      const count = await this.deps.tenantDb.run(scope, (tx) => postScheduledDue(tx, ctx, this.deps.audit, now));
      charges += count;
      if (job && !(await this.deps.queue.renewLock(job))) throw new LockLostError(job.id);
      if (count < RENT_POSTING_BATCH) break;
    }
    for (;;) {
      const count = await this.deps.tenantDb.run(scope, (tx) => notifyReviewsDue(tx, ctx, this.deps.audit, now));
      reviews += count;
      if (job && !(await this.deps.queue.renewLock(job))) throw new LockLostError(job.id);
      if (count < RENT_POSTING_BATCH) break;
    }
    if (charges + reviews > 0) this.deps.logger.info('scheduled charges posted and reviews notified', { companyId, charges, reviews });
    return { charges, reviews };
  }

  /**
   * The daily arrears workflow of one company (P7-D10): leases owing money in
   * batches of ARREARS_BATCH, one tenant transaction each, renewing the job's
   * lock after every batch (#42). Idle while the company has no steps (W7-D7).
   */
  async runArrearsWorkflow(companyId: string, requestId = `arrears-workflow:${companyId}`, job?: ClaimedJob): Promise<{ leases: number; recorded: number }> {
    const scope = { companyId, userId: '' };
    const ctx = systemContext(companyId, requestId);
    const steps = await this.deps.tenantDb.run(scope, (tx) => arrearsSteps(tx));
    if (steps.length === 0) return { leases: 0, recorded: 0 };
    const now = this.now();
    let afterId: string | null = null;
    let leases = 0;
    let recorded = 0;
    for (;;) {
      const batch = await this.deps.tenantDb.run(scope, (tx) => arrearsWorkflowBatch(tx, ctx, this.deps.audit, { afterId, now, steps }));
      leases += batch.leases;
      recorded += batch.recorded;
      if (job && !(await this.deps.queue.renewLock(job))) throw new LockLostError(job.id);
      if (batch.lastId === null || batch.leases < ARREARS_BATCH) break;
      afterId = batch.lastId;
    }
    if (recorded > 0) this.deps.logger.info('arrears steps recorded', { companyId, leases, recorded });
    return { leases, recorded };
  }

  /**
   * The daily renewal reminders of one company (readiness §5.6): leases ending
   * within 90 days without a decision, in batches of RENEWAL_BATCH, one
   * tenant transaction each, renewing the job's lock after every batch (#42).
   */
  async runLeaseRenewals(companyId: string, requestId = `lease-renewals:${companyId}`, job?: ClaimedJob): Promise<{ leases: number; reminded: number; escalated: number }> {
    const scope = { companyId, userId: '' };
    const ctx = systemContext(companyId, requestId);
    const now = this.now();
    let afterId: string | null = null;
    let leases = 0;
    let reminded = 0;
    let escalated = 0;
    for (;;) {
      const batch = await this.deps.tenantDb.run(scope, (tx) => renewalReminderBatch(tx, ctx, this.deps.audit, { afterId, now }));
      leases += batch.leases;
      reminded += batch.reminded;
      escalated += batch.escalated;
      if (job && !(await this.deps.queue.renewLock(job))) throw new LockLostError(job.id);
      if (batch.lastId === null || batch.leases < RENEWAL_BATCH) break;
      afterId = batch.lastId;
    }
    if (reminded > 0) this.deps.logger.info('renewal reminders written', { companyId, leases, reminded, escalated });
    return { leases, reminded, escalated };
  }

  private async execute(job: ClaimedJob): Promise<boolean> {
    const requestId = `job:${job.id}`;
    try {
      await this.handle(job, requestId);
      await this.deps.queue.complete(job.id);
      return true;
    } catch (error) {
      if (error instanceof LockLostError) {
        // Another worker owns the job now: leave its row to that worker.
        this.deps.logger.warn('job lock lost; stopped', { jobId: job.id, jobType: job.jobType, companyId: job.companyId });
        return false;
      }
      const outcome = await this.deps.queue.retryOrFail(job, errorMessage(error));
      this.deps.logger.warn('job failed', { jobId: job.id, jobType: job.jobType, companyId: job.companyId, attempt: job.attempts, outcome, error: errorMessage(error) });
      if (outcome === 'failed' && job.jobType === JOBS.documentScan) {
        await this.deps.documentScanner
          .fail(job.companyId, String(job.payload['versionId']), requestId)
          .catch((failure: unknown) => this.deps.logger.error('could not mark document as failed', { jobId: job.id, error: errorMessage(failure) }));
      }
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

      case JOBS.documentScan:
        await this.deps.documentScanner.scan(job.companyId, String(job.payload['versionId']), requestId);
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
          // Document uploads never confirmed (W7-A1) release their reservation the same way.
          const documents = await tx
            .updateTable('documentUploadSessions')
            .set({ status: 'expired' })
            .where('status', '=', 'pending')
            .where('expiresAt', '<', this.now())
            .returning(['storageKey', 'declaredSize'])
            .execute();
          const documentBytes = documents.reduce((sum, row) => sum + Number(row.declaredSize), 0);
          if (documentBytes > 0) {
            await tx
              .updateTable('storageUsage')
              .set({ bytesReserved: sql`greatest(bytes_reserved - ${documentBytes}, 0)`, updatedAt: sql`now()` })
              .where('companyId', '=', job.companyId)
              .execute();
          }
          return [...expired.map((row) => row.quarantineKey), ...documents.map((row) => row.storageKey)];
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
        await this.refreshRequirementMatches(job.companyId, requestId, job);
        return;

      case JOBS.rentSchedule:
        await this.runRentSchedule(job.companyId, requestId, job);
        return;

      case JOBS.rentPostDue:
        await this.runRentPostDue(job.companyId, requestId, job);
        return;

      case JOBS.arrearsWorkflow:
        await this.runArrearsWorkflow(job.companyId, requestId, job);
        return;

      case JOBS.leaseRenewals:
        await this.runLeaseRenewals(job.companyId, requestId, job);
        return;

      case JOBS.offerExpire:
        await tenantDb.run(scope, async (tx) => {
          const count = await expireOffers(tx, ctx, audit, this.now());
          if (count > 0) this.deps.logger.info('offers expired', { companyId: job.companyId, count });
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
