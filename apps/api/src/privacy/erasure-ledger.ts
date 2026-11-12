import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import type { AppConfig } from '../config/config.js';

/**
 * The erasure ledger (ADR-007 §8, stage E6): an append-only record of every
 * erasure and key destruction, kept in its own bucket outside the database
 * backup set (object lock in production, runbook §2). After any restore it is
 * replayed before the database serves traffic, so erased people and closed
 * companies stay erased. Entries hold identifiers and times only, never
 * personal data.
 */
export type LedgerEntry =
  | {
      type: 'contact_erasure';
      id: string;
      at: string;
      companyId: string;
      /** The contact and every record merged into it. */
      contactIds: string[];
      requestReference: string;
      requestedBy: string;
    }
  | {
      type: 'company_shred';
      id: string;
      at: string;
      companyId: string;
      /** Key versions destroyed, per purpose. */
      keys: { purpose: 'field' | 'lookup'; version: number }[];
      requestReference: string;
      requestedBy: string;
    };

export const LEDGER_PREFIX = 'erasure-ledger/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A ticket or case number of the request, never the person's name. */
export const REQUEST_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

export class LedgerError extends Error {}

export class ErasureLedger {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  static fromConfig(config: AppConfig): ErasureLedger {
    if (!config.ERASURE_LEDGER_BUCKET) throw new LedgerError('ERASURE_LEDGER_BUCKET is not set: erasure needs the ledger.');
    return new ErasureLedger(
      new S3Client({
        ...(config.STORAGE_ENDPOINT ? { endpoint: config.STORAGE_ENDPOINT } : {}),
        region: config.STORAGE_REGION,
        forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
        credentials: { accessKeyId: config.STORAGE_ACCESS_KEY_ID, secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      }),
      config.ERASURE_LEDGER_BUCKET,
    );
  }

  /** Object keys sort by time, so a listing replays in order. */
  static keyFor(entry: LedgerEntry): string {
    return `${LEDGER_PREFIX}${entry.at.slice(0, 7)}/${entry.at}-${entry.type}-${entry.id}.json`;
  }

  async append(entry: LedgerEntry): Promise<string> {
    validate(entry);
    const key = ErasureLedger.keyFor(entry);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: JSON.stringify(entry), ContentType: 'application/json' }),
    );
    return key;
  }

  /** Every entry, oldest first. */
  async entries(): Promise<LedgerEntry[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: LEDGER_PREFIX, ContinuationToken: token }));
      for (const object of page.Contents ?? []) if (object.Key?.endsWith('.json')) keys.push(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    keys.sort();
    const entries: LedgerEntry[] = [];
    for (const key of keys) {
      const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const text = (await object.Body?.transformToString('utf8')) ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LedgerError(`Ledger entry ${key} is not valid JSON.`);
      }
      validate(parsed, key);
      entries.push(parsed);
    }
    return entries;
  }

  destroy(): void {
    this.client.destroy();
  }
}

function validate(value: unknown, key = 'new entry'): asserts value is LedgerEntry {
  const entry = value as Partial<Record<string, unknown>>;
  const fail = (what: string): never => {
    throw new LedgerError(`Ledger entry ${key}: ${what}.`);
  };
  if (typeof entry !== 'object' || entry === null) fail('not an object');
  if (typeof entry.id !== 'string' || !UUID.test(entry.id)) fail('id must be a UUID');
  if (typeof entry.companyId !== 'string' || !UUID.test(entry.companyId)) fail('companyId must be a UUID');
  if (typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))) fail('at must be a timestamp');
  if (typeof entry.requestReference !== 'string' || !REQUEST_REFERENCE.test(entry.requestReference)) fail('requestReference is not a reference');
  if (typeof entry.requestedBy !== 'string' || entry.requestedBy.length < 1 || entry.requestedBy.length > 200) fail('requestedBy is required');
  if (entry.type === 'contact_erasure') {
    if (!Array.isArray(entry.contactIds) || entry.contactIds.length === 0 || !entry.contactIds.every((id) => typeof id === 'string' && UUID.test(id))) {
      fail('contactIds must be UUIDs');
    }
  } else if (entry.type === 'company_shred') {
    if (!Array.isArray(entry.keys) || !entry.keys.every((k) => typeof k === 'object' && k !== null && ['field', 'lookup'].includes((k as { purpose: string }).purpose) && Number.isInteger((k as { version: number }).version))) {
      fail('keys must list purpose and version');
    }
  } else {
    fail('unknown type');
  }
}
