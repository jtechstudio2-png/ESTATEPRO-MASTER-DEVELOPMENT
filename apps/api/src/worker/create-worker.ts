import { AuditService } from '../audit/audit.service.js';
import type { AppConfig } from '../config/config.js';
import { createKeyProvider } from '../crypto/crypto.module.js';
import { KeyRotationService } from '../crypto/key-rotation.service.js';
import { createKysely, TenantDb } from '../database/database.module.js';
import { ListingSettingsService } from '../listings/listing-settings.service.js';
import { ListingsService } from '../listings/listings.service.js';
import { MediaProcessor } from '../media/media-processor.js';
import { ClamAvScanner, type MalwareScanner } from '../media/scanner.js';
import { S3Storage } from '../media/storage.js';
import { JobQueue } from './queue.js';
import { Worker, type WorkerLogger } from './worker.js';

export class WorkerConfigError extends Error {}

/** Builds a worker and everything it needs from configuration; `close` releases connections. */
export function createWorker(
  config: AppConfig,
  logger: WorkerLogger,
  overrides: { scanner?: MalwareScanner; now?: () => Date; scheduleEveryMs?: number } = {},
): { worker: Worker; close: () => Promise<void> } {
  if (!config.PLATFORM_DATABASE_URL) throw new WorkerConfigError('PLATFORM_DATABASE_URL is required by the worker.');
  if (!config.CLAMAV_HOST && !overrides.scanner) throw new WorkerConfigError('CLAMAV_HOST is required by the worker.');

  const appDb = createKysely(config.DATABASE_URL, config.DATABASE_POOL_MAX, 'estatepro-worker');
  const platformDb = createKysely(config.PLATFORM_DATABASE_URL, 2, 'estatepro-worker-queue');
  const storage = S3Storage.fromConfig(config);
  const scanner = overrides.scanner ?? new ClamAvScanner(config.CLAMAV_HOST!, config.CLAMAV_PORT, config.CLAMAV_TIMEOUT_MS);
  const audit = new AuditService();
  const tenantDb = new TenantDb(appDb);
  const rotation = new KeyRotationService(platformDb, createKeyProvider(config), config, audit);
  const worker = new Worker(
    {
      platformDb,
      tenantDb,
      queue: new JobQueue(platformDb),
      storage,
      processor: new MediaProcessor(tenantDb, storage, scanner, audit),
      listings: new ListingsService(audit, new ListingSettingsService(audit), config),
      audit,
      rotation,
      logger,
    },
    { ...(overrides.now ? { now: overrides.now } : {}), ...(overrides.scheduleEveryMs !== undefined ? { scheduleEveryMs: overrides.scheduleEveryMs } : {}) },
  );
  return {
    worker,
    close: async () => {
      storage.destroy();
      rotation.close();
      await Promise.all([appDb.destroy(), platformDb.destroy()]);
    },
  };
}
