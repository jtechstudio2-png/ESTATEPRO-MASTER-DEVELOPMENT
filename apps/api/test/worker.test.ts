import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createKysely, type Db } from '../src/database/database.module.js';
import { S3Storage } from '../src/media/storage.js';
import { createWorker, WorkerConfigError } from '../src/worker/create-worker.js';
import { JobQueue } from '../src/worker/queue.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('worker infrastructure', () => {
  let t: TestApp;
  let fx: Fixtures;
  let platform: Db;
  let companyId: string;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    platform = createKysely(inject('databaseUrls').platform, 1, 'estatepro-worker-test');
    companyId = (await fx.company()).companyId;
  });

  afterAll(async () => {
    await platform.destroy();
    await fx.close();
    await t.close();
  });

  it('refuses to start without its queue connection or scanner', () => {
    expect(() => createWorker({ ...t.config, PLATFORM_DATABASE_URL: undefined }, silent)).toThrow(WorkerConfigError);
    expect(() => createWorker({ ...t.config, CLAMAV_HOST: undefined }, silent)).toThrow(/CLAMAV_HOST/);
  });

  it('claims nothing for no job types, enqueues once per key and backs off retries', async () => {
    const queue = new JobQueue(platform);
    expect(await queue.claim([], 10)).toEqual([]);
    expect(await queue.enqueue(companyId, 'test.job', 'test.job:1', { n: 1 })).toBe(true);
    expect(await queue.enqueue(companyId, 'test.job', 'test.job:1', { n: 2 })).toBe(false);
    const [job] = await queue.claim(['test.job'], 5);
    expect(job).toMatchObject({ companyId, jobType: 'test.job', payload: { n: 1 }, attempts: 1 });
    expect(await queue.claim(['test.job'], 5)).toEqual([]);
    expect(await queue.retryOrFail(job!, 'x'.repeat(3_000))).toBe('retry');
    const row = await fx.db.selectFrom('scheduledJobs').selectAll().where('id', '=', job!.id).executeTakeFirstOrThrow();
    expect(row.lastError).toHaveLength(2_000);
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 25_000);

    // A crashed worker's lock expires and the job becomes claimable again.
    await fx.db.updateTable('scheduledJobs').set({ status: 'running', lockedUntil: new Date(Date.now() - 1_000) }).where('id', '=', job!.id).execute();
    expect(await queue.releaseExpiredLocks()).toBe(1);
    await fx.db.updateTable('scheduledJobs').set({ runAt: new Date() }).where('id', '=', job!.id).execute();
    const [again] = await queue.claim(['test.job'], 5);
    expect(again!.attempts).toBe(2);
    await queue.complete(again!.id);
    expect((await fx.db.selectFrom('scheduledJobs').select('status').where('id', '=', job!.id).executeTakeFirstOrThrow()).status).toBe('done');
  });

  it('retries a failing job, then fails it for good, and keeps running after a failed pass', async () => {
    const { worker, close } = createWorker(t.config, silent, { scheduleEveryMs: 60_000 });
    try {
      // A payload the media handler cannot process: the job is retried, then failed, and the pass continues.
      const queue = new JobQueue(platform);
      await queue.enqueue(companyId, 'media.process', 'broken-payload', { mediaId: 'not-a-uuid' });
      await fx.db.updateTable('scheduledJobs').set({ maxAttempts: 2 }).where('idempotencyKey', '=', 'broken-payload').execute();
      expect((await worker.runOnce()).failed).toBe(1);
      const retrying = await fx.db.selectFrom('scheduledJobs').selectAll().where('idempotencyKey', '=', 'broken-payload').executeTakeFirstOrThrow();
      expect(retrying).toMatchObject({ status: 'pending', attempts: 1 });
      await fx.db.updateTable('scheduledJobs').set({ runAt: new Date() }).where('id', '=', retrying.id).execute();
      expect((await worker.runOnce()).failed).toBe(1);
      expect((await fx.db.selectFrom('scheduledJobs').select('status').where('id', '=', retrying.id).executeTakeFirstOrThrow()).status).toBe('failed');
    } finally {
      await close();
    }

    const broken = createWorker({ ...t.config, PLATFORM_DATABASE_URL: 'postgres://nobody:wrong@127.0.0.1:5432/nowhere' }, silent, { scheduleEveryMs: 0 });
    try {
      const running = broken.worker.start(5);
      await new Promise((resolve) => setTimeout(resolve, 100));
      broken.worker.stop();
      await running;
    } finally {
      await broken.close();
    }
  });

  it('releases a job for retry when object storage is unreachable, leaving its work undone (issue #14)', async () => {
    // A port nothing listens on: every storage call is refused after the configured attempts.
    const { createServer } = await import('node:net');
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const closedPort = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const { membershipId } = await fx.member(companyId, { roleKey: 'office_admin' });
    const exportJob = await fx.db
      .insertInto('exportJobs')
      .values({ companyId, exportType: 'contacts', format: 'csv', requestedBy: membershipId, status: 'completed', storageKey: `${companyId}/exports/outage.csv`, rowCount: 1, finishedAt: new Date(), expiresAt: new Date(Date.now() - 1_000) })
      .returning('id')
      .executeTakeFirstOrThrow();
    const queue = new JobQueue(platform);
    await queue.enqueue(companyId, 'export.expire', 'export.expire:outage');

    const outage = { ...t.config, STORAGE_ENDPOINT: `http://127.0.0.1:${closedPort}`, STORAGE_CONNECT_TIMEOUT_MS: 200, STORAGE_REQUEST_TIMEOUT_MS: 300, STORAGE_MAX_ATTEMPTS: 2 };
    const { worker, close } = createWorker(outage, silent, { scheduleEveryMs: 60_000 });
    try {
      const started = Date.now();
      expect((await worker.runOnce()).failed).toBeGreaterThanOrEqual(1);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await close();
    }
    const job = await fx.db.selectFrom('scheduledJobs').selectAll().where('idempotencyKey', '=', 'export.expire:outage').executeTakeFirstOrThrow();
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job.lastError).toMatch(/Object storage remove failed \(retry exhausted, 2 attempts\)/);
    // The expiry ran in the same transaction as the failed removal: it is rolled back, so the retry finds the export again.
    expect((await fx.db.selectFrom('exportJobs').select('status').where('id', '=', exportJob.id).executeTakeFirstOrThrow()).status).toBe('completed');
    await fx.db.deleteFrom('scheduledJobs').where('id', '=', job.id).execute();
    await fx.db.updateTable('exportJobs').set({ status: 'expired' }).where('id', '=', exportJob.id).execute();
  });

  it('treats a missing object as absent and surfaces other storage errors', async () => {
    const storage = S3Storage.fromConfig(t.config);
    try {
      expect(await storage.head(`${companyId}/does-not-exist`)).toBeNull();
      await storage.remove([]);
      await storage.write(`${companyId}/tmp/a.txt`, Buffer.from('hello'), 'text/plain');
      expect(await storage.head(`${companyId}/tmp/a.txt`)).toEqual({ size: 5, contentType: 'text/plain' });
      await expect(storage.read(`${companyId}/tmp/a.txt`, 2)).rejects.toThrow(/larger than 2 bytes/);
      await storage.remove([`${companyId}/tmp/a.txt`, `${companyId}/tmp/never-existed.txt`]);
    } finally {
      storage.destroy();
    }
    const denied = S3Storage.fromConfig({ ...t.config, STORAGE_SECRET_ACCESS_KEY: 'wrong-secret' });
    try {
      await expect(denied.head(`${companyId}/x`)).rejects.toBeTruthy();
    } finally {
      denied.destroy();
    }
  });
});
