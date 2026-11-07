import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Logger } from '@nestjs/common';

import type { AppConfig } from '../config/config.js';

export const STORAGE = Symbol('STORAGE');

export interface StoredObject {
  size: number;
  contentType: string | null;
}

/**
 * Provider-agnostic object storage (ADR-005 M-D1). Keys are always generated
 * by the server and prefixed by company (or "quarantine/<company>").
 */
export interface StoragePort {
  /** Signed PUT bound to the content type and exact length. */
  signUpload(key: string, contentType: string, contentLength: number, ttlSeconds: number): Promise<string>;
  signDownload(key: string, ttlSeconds: number, options?: { downloadName?: string }): Promise<string>;
  head(key: string): Promise<StoredObject | null>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  write(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export type StorageOperation = 'head' | 'read' | 'write' | 'remove';
/**
 * timeout: no answer within the connection or request timeout (after retries);
 * retry_exhausted: a retry-safe failure (throttling, 5xx, network) on every attempt;
 * client_error: refused for a reason a retry cannot fix (4xx: credentials, bucket, request).
 */
export type StorageOutcome = 'success' | 'timeout' | 'retry_exhausted' | 'client_error';

/** Every storage failure surfaces as this (issue #14): the API answers 503, the worker retries the job. */
export class StorageError extends Error {
  constructor(
    readonly operation: StorageOperation,
    readonly outcome: Exclude<StorageOutcome, 'success'>,
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(`Object storage ${operation} failed (${outcome.replace('_', ' ')}, ${attempts} attempt${attempts === 1 ? '' : 's'}).`, options);
    this.name = 'StorageError';
  }

  /** Worth trying again later (outage), as opposed to a configuration or request problem. */
  get transient(): boolean {
    return this.outcome !== 'client_error';
  }
}

export interface StorageOperationStats {
  calls: number;
  outcomes: Record<StorageOutcome, number>;
  /** Extra attempts made by the retry policy. */
  retries: number;
  totalMs: number;
  maxMs: number;
}

/**
 * In-process counters and latency per operation and outcome (issue #14). They
 * are logged on every failure and exposed through {@link S3Storage.metrics};
 * shipping them to the monitoring system comes with #28.
 */
export class StorageMetrics {
  private readonly stats = new Map<StorageOperation, StorageOperationStats>();

  record(operation: StorageOperation, outcome: StorageOutcome, durationMs: number, attempts: number): void {
    const entry = this.stats.get(operation) ?? { calls: 0, outcomes: { success: 0, timeout: 0, retry_exhausted: 0, client_error: 0 }, retries: 0, totalMs: 0, maxMs: 0 };
    entry.calls += 1;
    entry.outcomes[outcome] += 1;
    entry.retries += Math.max(attempts - 1, 0);
    entry.totalMs += durationMs;
    entry.maxMs = Math.max(entry.maxMs, durationMs);
    this.stats.set(operation, entry);
  }

  snapshot(): Partial<Record<StorageOperation, StorageOperationStats>> {
    return Object.fromEntries([...this.stats].map(([operation, entry]) => [operation, { ...entry, outcomes: { ...entry.outcomes } }]));
  }
}

export interface StorageClientLimits {
  /** Time to establish the TCP/TLS connection. */
  connectTimeoutMs: number;
  /** Time without a response (or between data) before the attempt is abandoned. */
  requestTimeoutMs: number;
  /** Attempts in total, including the first ("standard" retry mode: exponential backoff with jitter, retry-safe errors only). */
  maxAttempts: number;
}

const logger = new Logger('Storage');

export class S3Storage implements StoragePort {
  private readonly client: S3Client;
  readonly metrics = new StorageMetrics();

  constructor(
    private readonly bucket: string,
    options: { endpoint?: string | undefined; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean },
    limits: StorageClientLimits = { connectTimeoutMs: 3_000, requestTimeoutMs: 30_000, maxAttempts: 3 },
  ) {
    this.client = new S3Client({
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // R2 and other S3-compatible stores do not all support the newer default checksums on presigned PUTs.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // Issue #14: never wait without bound on a stalled or unreachable store.
      // throwOnRequestTimeout: without it this SDK only logs a warning and keeps waiting.
      requestHandler: { connectionTimeout: limits.connectTimeoutMs, requestTimeout: limits.requestTimeoutMs, throwOnRequestTimeout: true },
      maxAttempts: limits.maxAttempts,
      retryMode: 'standard',
    });
  }

  static fromConfig(config: AppConfig): S3Storage {
    return new S3Storage(
      config.STORAGE_BUCKET,
      {
        endpoint: config.STORAGE_ENDPOINT,
        region: config.STORAGE_REGION,
        accessKeyId: config.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
        forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
      },
      { connectTimeoutMs: config.STORAGE_CONNECT_TIMEOUT_MS, requestTimeoutMs: config.STORAGE_REQUEST_TIMEOUT_MS, maxAttempts: config.STORAGE_MAX_ATTEMPTS },
    );
  }

  /** Runs one storage operation, records its outcome and turns any failure into a StorageError. */
  private async call<T>(operation: StorageOperation, work: () => Promise<T>, absent?: (error: unknown) => boolean): Promise<T> {
    const started = Date.now();
    try {
      const result = await work();
      this.metrics.record(operation, 'success', Date.now() - started, 1);
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      if (absent?.(error)) {
        this.metrics.record(operation, 'success', durationMs, attemptsOf(error));
        throw error;
      }
      const outcome = classify(error);
      const attempts = attemptsOf(error);
      this.metrics.record(operation, outcome, durationMs, attempts);
      logger.warn({ operation, outcome, attempts, durationMs, error: error instanceof Error ? error.name : 'unknown' }, 'object storage call failed');
      throw new StorageError(operation, outcome, attempts, { cause: error });
    }
  }

  signUpload(key: string, contentType: string, contentLength: number, ttlSeconds: number): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: contentLength });
    return getSignedUrl(this.client, command, {
      expiresIn: ttlSeconds,
      // Sign the headers so the upload must match the declared type and size.
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  signDownload(key: string, ttlSeconds: number, options: { downloadName?: string } = {}): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.downloadName ? { ResponseContentDisposition: contentDisposition(options.downloadName) } : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }

  async head(key: string): Promise<StoredObject | null> {
    const missing = (error: unknown) => error instanceof NotFound || (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404);
    try {
      const result = await this.call('head', () => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })), missing);
      return { size: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer> {
    const bytes = await this.call('read', async () => {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return result.Body!.transformToByteArray();
    });
    if (bytes.byteLength > maxBytes) throw new Error(`Object ${key} is larger than ${maxBytes} bytes`);
    return Buffer.from(bytes);
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.call('write', () => this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType })));
  }

  async remove(keys: string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += 1000) {
      const batch = keys.slice(start, start + 1000);
      if (batch.length === 0) continue;
      const result = await this.call('remove', () =>
        this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } })),
      );
      // Already-deleted keys are not errors (S3 reports success for missing keys).
      if (result.Errors && result.Errors.length > 0) {
        throw new Error(`Could not delete ${result.Errors.length} object(s): ${result.Errors[0]?.Code ?? 'unknown'}`);
      }
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}

function attemptsOf(error: unknown): number {
  const metadata = (error as { $metadata?: { attempts?: number } } | null)?.$metadata;
  return typeof metadata?.attempts === 'number' && metadata.attempts > 0 ? metadata.attempts : 1;
}

/** Sorts a failed call into an outcome (issue #14). */
export function classify(error: unknown): Exclude<StorageOutcome, 'success'> {
  const candidate = error as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } } | null;
  const name = candidate?.name ?? '';
  const code = candidate?.code ?? '';
  if (name === 'TimeoutError' || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'RequestTimeout'].includes(code) || /timed? ?out/i.test(candidate?.message ?? '')) return 'timeout';
  const status = candidate?.$metadata?.httpStatusCode;
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) return 'client_error';
  return 'retry_exhausted';
}

/** RFC 6266 attachment header with an ASCII fallback and a UTF-8 name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
