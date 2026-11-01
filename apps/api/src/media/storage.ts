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

export class S3Storage implements StoragePort {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: { endpoint?: string | undefined; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean },
  ) {
    this.client = new S3Client({
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // R2 and other S3-compatible stores do not all support the newer default checksums on presigned PUTs.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  static fromConfig(config: AppConfig): S3Storage {
    return new S3Storage(config.STORAGE_BUCKET, {
      endpoint: config.STORAGE_ENDPOINT,
      region: config.STORAGE_REGION,
      accessKeyId: config.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
      forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
    });
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
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
    } catch (error) {
      if (error instanceof NotFound || (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)) return null;
      throw error;
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await result.Body!.transformToByteArray();
    if (bytes.byteLength > maxBytes) throw new Error(`Object ${key} is larger than ${maxBytes} bytes`);
    return Buffer.from(bytes);
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async remove(keys: string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += 1000) {
      const batch = keys.slice(start, start + 1000);
      if (batch.length === 0) continue;
      const result = await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }),
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

/** RFC 6266 attachment header with an ASCII fallback and a UTF-8 name. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
