import { sql } from 'kysely';

import type { Db } from '../database/database.module.js';

/**
 * PostgreSQL-backed job queue (ADR-005 M-D6) on `scheduled_jobs`. Claims use
 * FOR UPDATE SKIP LOCKED so several workers never take the same job. This
 * handle uses the estatepro_platform role and touches only `scheduled_jobs`;
 * job handlers do their work in tenant transactions (row-level security).
 */
export interface ClaimedJob {
  id: string;
  companyId: string;
  jobType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

export const LOCK_SECONDS = 300;

export class JobQueue {
  constructor(private readonly db: Db) {}

  async claim(jobTypes: readonly string[], limit: number): Promise<ClaimedJob[]> {
    if (jobTypes.length === 0) return [];
    const { rows } = await sql<ClaimedJob & { runAt: Date }>`
      update scheduled_jobs j
         set status = 'running', attempts = j.attempts + 1, locked_until = now() + make_interval(secs => ${LOCK_SECONDS})
       where j.id in (
         select id from scheduled_jobs
          where status = 'pending' and run_at <= now() and job_type = any(${[...jobTypes]}::text[])
          order by run_at
          limit ${limit}
          for update skip locked)
      returning j.id, j.company_id as "companyId", j.job_type as "jobType", j.payload, j.attempts, j.max_attempts as "maxAttempts", j.run_at as "runAt"`.execute(this.db);
    // UPDATE … RETURNING does not keep the claim order: run jobs oldest first (ids are time-ordered).
    return rows
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || (a.id < b.id ? -1 : 1))
      .map(({ runAt: _runAt, ...job }) => job);
  }

  async complete(id: string): Promise<void> {
    await sql`update scheduled_jobs set status = 'done', completed_at = now(), locked_until = null, last_error = null where id = ${id}`.execute(this.db);
  }

  /** Retries with exponential back-off (30 s, 1 min, 2 min, … capped at 1 h) or fails for good. */
  async retryOrFail(job: ClaimedJob, error: string): Promise<'retry' | 'failed'> {
    const message = error.slice(0, 2_000);
    if (job.attempts >= job.maxAttempts) {
      await sql`update scheduled_jobs set status = 'failed', locked_until = null, last_error = ${message}, completed_at = now() where id = ${job.id}`.execute(this.db);
      return 'failed';
    }
    const delay = Math.min(30 * 2 ** (job.attempts - 1), 3_600);
    await sql`update scheduled_jobs
                 set status = 'pending', locked_until = null, last_error = ${message}, run_at = now() + make_interval(secs => ${delay})
               where id = ${job.id}`.execute(this.db);
    return 'retry';
  }

  /** Jobs of a crashed worker become claimable again once their lock expires. */
  async releaseExpiredLocks(): Promise<number> {
    const result = await sql`update scheduled_jobs set status = 'pending', locked_until = null
                               where status = 'running' and locked_until < now()`.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }

  /** Enqueues once per idempotency key (a re-run of the scheduler is harmless). */
  async enqueue(companyId: string, jobType: string, key: string, payload: Record<string, unknown> = {}): Promise<boolean> {
    const result = await sql`
      insert into scheduled_jobs (company_id, job_type, local_due, timezone, run_at, idempotency_key, payload)
      values (${companyId}::uuid, ${jobType}, now() at time zone 'UTC', 'UTC', now(), ${key}, ${JSON.stringify(payload)}::jsonb)
      on conflict (company_id, idempotency_key) do nothing`.execute(this.db);
    return Number(result.numAffectedRows ?? 0) > 0;
  }
}
