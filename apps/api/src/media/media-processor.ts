import { sql } from 'kysely';

import type { AuditService } from '../audit/audit.service.js';
import { systemContext, type TenantContext } from '../common/request-context.js';
import type { TenantDb, Tx } from '../database/database.module.js';
import { type Derivatives, releaseReservation, type StoredFile } from './media.service.js';
import { allowedMimeTypes, isPlan, MAX_FLOOR_PLANS_PER_LISTING, MAX_PHOTOS_PER_LISTING, maxBytesFor, PDF_MIME, type UploadMediaType } from './media-rules.js';
import { ContentRejected, processImage, processPdf, type ProcessedMedia, sha256, sniffMime } from './processing.js';
import type { MalwareScanner } from './scanner.js';
import type { StoragePort } from './storage.js';

export type ProcessOutcome = 'ready' | 'rejected' | 'failed' | 'skipped';

/**
 * Turns a confirmed upload into stored media (verification report §2.1 step 4):
 * size and checksum check, malware scan (fail closed), content sniffing,
 * decode and re-encode, write master and sizes, delete the raw upload.
 * Content problems reject the file for good; infrastructure problems throw so
 * the queue retries.
 */
export class MediaProcessor {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly storage: StoragePort,
    private readonly scanner: MalwareScanner,
    private readonly audit: AuditService,
  ) {}

  async process(companyId: string, mediaId: string, requestId: string): Promise<ProcessOutcome> {
    const ctx = systemContext(companyId, requestId);
    const scope = { companyId, userId: '' };
    const state = await this.tenantDb.run(scope, async (tx) => {
      const media = await tx.selectFrom('propertyMedia').selectAll().where('id', '=', mediaId).executeTakeFirst();
      if (!media || media.processingStatus !== 'pending' || !media.storageKey) return null;
      const session = await tx.selectFrom('uploadSessions').selectAll().where('mediaId', '=', mediaId).executeTakeFirst();
      return session ? { media, session } : null;
    });
    if (!state) return 'skipped';
    const { media, session } = state;
    const declaredSize = Number(session.declaredSize);
    const rawKey = media.storageKey!;

    let processed: ProcessedMedia;
    let sniffed: string;
    try {
      const stored = await this.storage.head(rawKey);
      if (!stored) throw new ContentRejected('missing', 'The uploaded file could not be found.');
      if (stored.size !== declaredSize || stored.size > maxBytesFor(session.declaredMime)) {
        throw new ContentRejected('size-mismatch', 'The uploaded file does not match the declared size.');
      }
      const content = await this.storage.read(rawKey, maxBytesFor(session.declaredMime));
      if (!sha256(content).equals(Buffer.from(session.sha256))) {
        throw new ContentRejected('checksum-mismatch', 'The uploaded file does not match its checksum.');
      }
      const verdict = await this.scanner.scan(content);
      if (!verdict.clean) {
        await this.reject(ctx, media.id, rawKey, declaredSize, 'malware', 'This file was blocked by the security scan.', { signature: verdict.signature });
        return 'rejected';
      }
      sniffed = (await sniffMime(content)) ?? 'unknown';
      if (sniffed !== session.declaredMime || !allowedMimeTypes(session.mediaType as UploadMediaType).includes(sniffed)) {
        throw new ContentRejected('type-mismatch', 'The file content does not match its declared type.');
      }
      processed = sniffed === PDF_MIME ? await processPdf(content) : await processImage(content, isPlan(session.mediaType));
    } catch (error) {
      if (error instanceof ContentRejected) {
        await this.reject(ctx, media.id, rawKey, declaredSize, error.code, error.message);
        return 'rejected';
      }
      throw error;
    }

    // Deterministic keys: a retry after a partial failure overwrites the same objects.
    const prefix = `${companyId}/media/${media.id}`;
    const masterKey = `${prefix}/master.${processed.master.extension}`;
    await this.storage.write(masterKey, processed.master.buffer, processed.master.contentType);
    const derivatives: Derivatives = {
      master: file(masterKey, processed.master),
      variants: {},
    };
    for (const variant of processed.variants) {
      const key = `${prefix}/${variant.name}-${variant.hash}.webp`;
      await this.storage.write(key, variant.buffer, variant.contentType);
      derivatives.variants![variant.name] = file(key, variant);
    }
    const storedBytes = processed.master.buffer.length + processed.variants.reduce((sum, variant) => sum + variant.buffer.length, 0);

    const outcome = await this.tenantDb.run(scope, async (tx) => {
      const current = await tx.selectFrom('propertyMedia').select(['processingStatus']).where('id', '=', media.id).forUpdate().executeTakeFirst();
      if (!current || current.processingStatus !== 'pending') return 'skipped' as const;
      await tx
        .updateTable('propertyMedia')
        .set({
          processingStatus: 'ready',
          storageKey: masterKey,
          mimeType: sniffed,
          sizeBytes: storedBytes,
          widthPx: processed.width,
          heightPx: processed.height,
          pageCount: processed.pageCount,
          derivatives: JSON.stringify(derivatives),
          processedAt: new Date(),
        })
        .where('id', '=', media.id)
        .execute();
      await tx
        .updateTable('storageUsage')
        .set({
          bytesUsed: sql`bytes_used + ${storedBytes}`,
          bytesReserved: sql`greatest(bytes_reserved - ${declaredSize}, 0)`,
          updatedAt: sql`now()`,
        })
        .where('companyId', '=', companyId)
        .execute();
      if (session.listingId) await this.attachToListing(tx, ctx, session.listingId, media.id, session.mediaType);
      await this.audit.record(tx, ctx, {
        action: 'media.processed',
        entityType: 'media',
        entityId: media.id,
        metadata: { mimeType: sniffed, width: processed.width, height: processed.height, pageCount: processed.pageCount, storedBytes },
      });
      await this.audit.emit(tx, ctx, { eventType: 'media.processed', aggregateType: 'media', aggregateId: media.id, payload: { mediaId: media.id } });
      return 'ready' as const;
    });
    // The raw upload is never kept (M-D3).
    await this.storage.remove([rawKey]);
    return outcome;
  }

  /** Marks media that could not be processed after every retry as failed. */
  async fail(companyId: string, mediaId: string, requestId: string, reason: string): Promise<void> {
    const ctx = systemContext(companyId, requestId);
    await this.tenantDb.run({ companyId, userId: '' }, async (tx) => {
      const media = await tx.selectFrom('propertyMedia').select(['processingStatus', 'storageKey']).where('id', '=', mediaId).forUpdate().executeTakeFirst();
      if (!media || media.processingStatus !== 'pending') return;
      const session = await tx.selectFrom('uploadSessions').select(['declaredSize']).where('mediaId', '=', mediaId).executeTakeFirst();
      await tx.updateTable('propertyMedia').set({ processingStatus: 'failed', rejectionReason: reason }).where('id', '=', mediaId).execute();
      if (session) await releaseReservation(tx, companyId, Number(session.declaredSize));
      await this.audit.record(tx, ctx, { action: 'media.failed', entityType: 'media', entityId: mediaId, metadata: { reason } });
      if (media.storageKey?.startsWith('quarantine/')) await this.storage.remove([media.storageKey]);
    });
  }

  private async reject(
    ctx: TenantContext,
    mediaId: string,
    rawKey: string,
    declaredSize: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    // Rejected files are deleted at once; the audit entry keeps what is needed (policy §5).
    await this.storage.remove([rawKey]);
    await this.tenantDb.run({ companyId: ctx.companyId, userId: '' }, async (tx) => {
      const current = await tx.selectFrom('propertyMedia').select(['processingStatus']).where('id', '=', mediaId).forUpdate().executeTakeFirst();
      if (!current || current.processingStatus !== 'pending') return;
      await tx.updateTable('propertyMedia').set({ processingStatus: 'rejected', rejectionReason: message }).where('id', '=', mediaId).execute();
      await releaseReservation(tx, ctx.companyId, declaredSize);
      await this.audit.record(tx, ctx, { action: 'media.rejected', entityType: 'media', entityId: mediaId, metadata: { code, ...extra } });
      await this.audit.emit(tx, ctx, { eventType: 'media.rejected', aggregateType: 'media', aggregateId: mediaId, payload: { mediaId, code } });
    });
  }

  /** Appends processed media to the listing it was uploaded for, if the listing still accepts it. */
  private async attachToListing(tx: Tx, ctx: TenantContext, listingId: string, mediaId: string, mediaType: string): Promise<void> {
    const listing = await tx.selectFrom('listings').select(['status', 'archivedAt']).where('id', '=', listingId).forUpdate().executeTakeFirst();
    if (!listing || listing.archivedAt !== null || ['sold', 'rented', 'withdrawn', 'expired'].includes(listing.status)) return;
    const counts = await tx
      .selectFrom('listingMedia as lm')
      .innerJoin('propertyMedia as m', 'm.id', 'lm.mediaId')
      .select([
        sql<number>`count(*) filter (where m.media_type = 'photo')::int`.as('photos'),
        sql<number>`count(*) filter (where m.media_type = 'floor_plan')::int`.as('plans'),
        sql<number>`count(*) filter (where lm.is_cover)::int`.as('covers'),
        sql<number>`coalesce(max(lm.sort_order) + 1, 0)::int`.as('next'),
      ])
      .where('lm.listingId', '=', listingId)
      .executeTakeFirstOrThrow();
    if ((mediaType === 'photo' && counts.photos >= MAX_PHOTOS_PER_LISTING) || (mediaType === 'floor_plan' && counts.plans >= MAX_FLOOR_PLANS_PER_LISTING)) return;
    const isCover = mediaType === 'photo' && counts.covers === 0;
    await tx.insertInto('listingMedia').values({ companyId: ctx.companyId, listingId, mediaId, sortOrder: counts.next, isCover }).execute();
    await tx.updateTable('listings').set({ updatedAt: sql<Date>`now()` }).where('id', '=', listingId).execute();
    await this.audit.record(tx, ctx, { action: 'listing.media_added', entityType: 'listing', entityId: listingId, metadata: { mediaId, isCover } });
  }
}

function file(key: string, output: { buffer: Buffer; width: number; height: number; contentType: string }): StoredFile {
  return { key, bytes: output.buffer.length, width: output.width, height: output.height, contentType: output.contentType };
}
