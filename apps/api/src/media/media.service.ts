import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { type Selectable, sql } from 'kysely';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { registerConstraintMessages } from '../common/db-errors.js';
import { keysetCondition, type Page, type ParsedListQuery, sortValueSql, toPage } from '../common/list-query.js';
import { ProblemError, Problems } from '../common/problem.js';
import { actingMembership, type TenantContext } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { Tx } from '../database/database.module.js';
import type { PropertyMedia } from '../database/schema.js';
import { hasListingPermission } from '../listings/listing-access.js';
import { isTerminal } from '../listings/listing-rules.js';
import { assertPropertyAccess } from '../properties/property-access.js';
import type {
  CreateLinkBody,
  CreateUploadBody,
  LegalHoldBody,
  ListingGalleryDto,
  ListingMediaBody,
  MediaDto,
  MediaUrlsDto,
  StorageUsageDto,
  UpdateMediaBody,
  UploadTicketDto,
} from './dto.js';
import {
  allowedMimeTypes,
  MAX_FLOOR_PLANS_PER_LISTING,
  MAX_PHOTOS_PER_LISTING,
  maxBytesFor,
  parseExternalLink,
  PDF_MIME,
  VARIANTS,
} from './media-rules.js';
import { STORAGE, type StoragePort } from './storage.js';

registerConstraintMessages({
  listing_media_one_cover_idx: 'A listing can have only one cover image.',
});

export type MediaRow = Selectable<PropertyMedia>;
export type MediaSortField = 'sortOrder' | 'createdAt';

/** Archived media stays recoverable this long (ADR-005 M-D8). */
export const ARCHIVE_RETENTION_DAYS = 90;
export const MEDIA_PROCESS_JOB = 'media.process';

/** Per-item storage detail kept in property_media.derivatives. */
export interface StoredFile {
  key: string;
  bytes: number;
  width: number;
  height: number;
  contentType: string;
}
export interface Derivatives {
  master?: StoredFile;
  variants?: Partial<Record<(typeof VARIANTS)[number]['name'], StoredFile>>;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // --------------------------------------------------------------------------- quota

  async storageUsage(tx: Tx, ctx: TenantContext): Promise<StorageUsageDto> {
    const plan = await planLimit(tx);
    const usage = await tx.selectFrom('storageUsage').select(['bytesUsed', 'bytesReserved']).where('companyId', '=', ctx.companyId).executeTakeFirst();
    return {
      planCode: plan?.planCode ?? null,
      limitBytes: plan?.limitBytes ?? null,
      usedBytes: Number(usage?.bytesUsed ?? 0),
      reservedBytes: Number(usage?.bytesReserved ?? 0),
    };
  }

  // --------------------------------------------------------------------------- uploads

  async createUpload(tx: Tx, ctx: TenantContext, body: CreateUploadBody): Promise<UploadTicketDto> {
    const property = await this.loadProperty(tx, body.propertyId);
    if (!property) throw Problems.validation([{ field: 'propertyId', code: 'not-found', message: 'This property does not exist or you cannot see it.' }]);
    if (body.listingId !== undefined) {
      await assertPropertyAccess(tx, ctx, property, 'property.view');
      await this.assertListingForProperty(tx, ctx, body.listingId, property.id);
    } else {
      await assertPropertyAccess(tx, ctx, property, 'property.update');
    }
    if (property.archivedAt !== null) throw Problems.businessRule('Archived properties cannot receive new media.');
    if (body.unitId !== undefined) await this.assertUnit(tx, body.unitId, property.id);

    const mime = body.contentType.toLowerCase();
    if (!allowedMimeTypes(body.mediaType).includes(mime)) {
      throw Problems.validation([
        { field: 'contentType', code: 'unsupported', message: `Accepted for ${body.mediaType.replace('_', ' ')}: ${allowedMimeTypes(body.mediaType).join(', ')}.` },
      ]);
    }
    if (body.size > maxBytesFor(mime)) {
      throw Problems.validation([{ field: 'size', code: 'too-large', message: `Files of this type can be at most ${maxBytesFor(mime) / (1024 * 1024)} MB.` }]);
    }

    await this.reserve(tx, ctx, body.size);
    const id = randomUUID();
    const quarantineKey = `quarantine/${ctx.companyId}/${id}`;
    const expiresAt = new Date(Date.now() + this.config.MEDIA_UPLOAD_URL_TTL_SECONDS * 1000);
    await tx
      .insertInto('uploadSessions')
      .values({
        id,
        companyId: ctx.companyId,
        propertyId: property.id,
        unitId: body.unitId ?? null,
        listingId: body.listingId ?? null,
        mediaType: body.mediaType,
        fileName: normaliseFileName(body.fileName),
        declaredMime: mime,
        declaredSize: body.size,
        sha256: Buffer.from(body.sha256, 'hex'),
        quarantineKey,
        // The confirmation window outlives the URL so a slow upload can still be confirmed.
        expiresAt: new Date(expiresAt.getTime() + 55 * 60 * 1000),
        createdBy: ctx.membershipId,
      })
      .execute();
    const uploadUrl = await this.storage.signUpload(quarantineKey, mime, body.size, this.config.MEDIA_UPLOAD_URL_TTL_SECONDS);
    return {
      id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': mime, 'Content-Length': String(body.size) },
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Returns a ProblemError instead of throwing when the upload must be
   * cancelled, so the cancellation and released quota are committed.
   */
  async confirmUpload(tx: Tx, ctx: TenantContext, sessionId: string): Promise<MediaDto | ProblemError> {
    const session = await tx.selectFrom('uploadSessions').selectAll().where('id', '=', sessionId).forUpdate().executeTakeFirst();
    if (!session) throw Problems.notFound();
    const property = await this.loadProperty(tx, session.propertyId);
    if (!property) throw Problems.notFound();
    await assertPropertyAccess(tx, ctx, property, session.listingId ? 'property.view' : 'property.update');
    if (session.createdBy !== ctx.membershipId) throw Problems.forbidden('Only the person who started this upload can confirm it.');
    if (session.status === 'confirmed' && session.mediaId) return this.get(tx, ctx, session.mediaId);
    if (session.status !== 'pending') throw Problems.businessRule('This upload was cancelled or has expired. Start a new upload.');
    if (session.expiresAt.getTime() < Date.now()) throw Problems.businessRule('This upload has expired. Start a new upload.');

    const stored = await this.storage.head(session.quarantineKey);
    if (!stored) throw Problems.businessRule('The file has not been uploaded yet. Upload it with the signed URL, then confirm.');
    if (stored.size !== Number(session.declaredSize)) {
      await this.storage.remove([session.quarantineKey]);
      await tx.updateTable('uploadSessions').set({ status: 'cancelled' }).where('id', '=', session.id).execute();
      await releaseReservation(tx, ctx.companyId, Number(session.declaredSize));
      return Problems.businessRule('The uploaded file does not match the declared size. Start a new upload.');
    }

    const mediaId = randomUUID();
    const next = await tx
      .selectFrom('propertyMedia')
      .select(sql<number>`coalesce(max(sort_order) + 1, 0)::int`.as('n'))
      .where('propertyId', '=', property.id)
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('propertyMedia')
      .values({
        id: mediaId,
        companyId: ctx.companyId,
        propertyId: property.id,
        unitId: session.unitId,
        mediaType: session.mediaType,
        storageKey: session.quarantineKey,
        mimeType: session.declaredMime,
        sizeBytes: session.declaredSize,
        checksumSha256: session.sha256,
        originalFilename: session.fileName,
        sortOrder: next.n,
        processingStatus: 'pending',
        uploadedBy: ctx.membershipId,
      })
      .execute();
    await tx.updateTable('uploadSessions').set({ status: 'confirmed', mediaId }).where('id', '=', session.id).execute();
    await enqueueProcessing(tx, ctx.companyId, mediaId, session.id);
    await this.audit.record(tx, ctx, {
      action: 'media.uploaded',
      entityType: 'media',
      entityId: mediaId,
      metadata: { propertyId: property.id, unitId: session.unitId, listingId: session.listingId, mediaType: session.mediaType, fileName: session.fileName, size: Number(session.declaredSize) },
    });
    await this.audit.emit(tx, ctx, { eventType: 'media.uploaded', aggregateType: 'media', aggregateId: mediaId, payload: { mediaId, propertyId: property.id } });
    return this.get(tx, ctx, mediaId);
  }

  // --------------------------------------------------------------------------- reads

  async list(tx: Tx, ctx: TenantContext, propertyId: string, query: ParsedListQuery<MediaSortField>): Promise<Page<MediaDto>> {
    const property = await this.loadProperty(tx, propertyId);
    if (!property) throw Problems.notFound();
    await assertPropertyAccess(tx, ctx, property, 'property.view');

    const sortColumn = `m.${query.sort.field}`;
    let qb = tx
      .selectFrom('propertyMedia as m')
      .selectAll('m')
      .select(sortValueSql(sortColumn, query.sort.kind).as('cursorValue'))
      .where('m.propertyId', '=', propertyId);
    const archived = query.filters['archived'] ?? 'false';
    if (archived === 'false') qb = qb.where('m.archivedAt', 'is', null);
    if (archived === 'true') qb = qb.where('m.archivedAt', 'is not', null);
    const types = query.filters['mediaType'];
    if (Array.isArray(types)) qb = qb.where('m.mediaType', 'in', types);
    const statuses = query.filters['processingStatus'];
    if (Array.isArray(statuses)) qb = qb.where('m.processingStatus', 'in', statuses);
    const units = query.filters['unitId'];
    if (Array.isArray(units)) qb = qb.where('m.unitId', 'in', units);
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'm.id', query.sort, query.cursor));
    const rows = await qb.orderBy(sql.ref(sortColumn), query.sort.direction).orderBy('m.id', query.sort.direction).limit(query.limit + 1).execute();

    const page = toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => row);
    return { data: await Promise.all(page.data.map((row) => this.toDto(row))), page: page.page };
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<MediaDto> {
    const row = await this.loadVisibleMedia(tx, ctx, id, 'property.view');
    return this.toDto(row);
  }

  // --------------------------------------------------------------------------- edits

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateMediaBody): Promise<MediaDto> {
    const current = await this.loadVisibleMedia(tx, ctx, id, 'property.update', true);
    if (current.archivedAt !== null) throw Problems.businessRule('Archived media cannot be edited. Restore it first.');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (body.sortOrder === null) throw Problems.validation([{ field: 'sortOrder', code: 'required', message: 'The order cannot be cleared.' }]);

    const patch: Record<string, unknown> = {};
    for (const field of ['caption', 'altText', 'roomLabel', 'floorLabel', 'sortOrder'] as const) {
      if (body[field] !== undefined && body[field] !== current[field]) patch[field] = body[field];
    }
    if (Object.keys(patch).length === 0) return this.toDto(current);
    const updated = await tx.updateTable('propertyMedia').set(patch).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, { action: 'media.updated', entityType: 'media', entityId: id, changes: diffForAudit(current, updated) });
    return this.toDto(updated);
  }

  async createLink(tx: Tx, ctx: TenantContext, propertyId: string, body: CreateLinkBody): Promise<MediaDto> {
    const property = await this.loadProperty(tx, propertyId);
    if (!property) throw Problems.notFound();
    await assertPropertyAccess(tx, ctx, property, 'property.update');
    if (property.archivedAt !== null) throw Problems.businessRule('Archived properties cannot receive new media.');
    if (body.unitId !== undefined) await this.assertUnit(tx, body.unitId, property.id);
    const link = parseExternalLink(body.url, body.mediaType);
    if (!link) {
      throw Problems.validation([
        {
          field: 'url',
          code: 'unsupported',
          message: body.mediaType === 'video' ? 'Use a YouTube or Vimeo video link.' : 'Use a Matterport tour link (my.matterport.com/show/?m=…).',
        },
      ]);
    }
    const next = await tx
      .selectFrom('propertyMedia')
      .select(sql<number>`coalesce(max(sort_order) + 1, 0)::int`.as('n'))
      .where('propertyId', '=', property.id)
      .executeTakeFirstOrThrow();
    const row = await tx
      .insertInto('propertyMedia')
      .values({
        companyId: ctx.companyId,
        propertyId: property.id,
        unitId: body.unitId ?? null,
        mediaType: body.mediaType,
        externalUrl: link.url,
        externalProvider: link.provider,
        caption: body.caption ?? null,
        altText: body.altText ?? null,
        sortOrder: next.n,
        processingStatus: 'ready',
        processedAt: new Date(),
        uploadedBy: ctx.membershipId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, { action: 'media.linked', entityType: 'media', entityId: row.id, metadata: { propertyId: property.id, provider: link.provider, url: link.url } });
    return this.toDto(row);
  }

  // --------------------------------------------------------------------------- archive, restore, erasure, hold

  async archive(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<MediaDto> {
    const current = await this.loadVisibleMedia(tx, ctx, id, 'property.archive', true);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt !== null) throw Problems.businessRule('This media is already archived.');

    const removed = await tx.deleteFrom('listingMedia').where('mediaId', '=', id).returning('listingId').execute();
    const listingIds = removed.map((row) => row.listingId);
    if (listingIds.length > 0) await touchListings(tx, listingIds);
    const updated = await tx.updateTable('propertyMedia').set({ archivedAt: new Date() }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, { action: 'media.archived', entityType: 'media', entityId: id, metadata: { reason, removedFromListings: listingIds } });
    return this.toDto(updated);
  }

  async restore(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<MediaDto> {
    const current = await this.loadVisibleMedia(tx, ctx, id, 'property.archive', true);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt === null) throw Problems.businessRule('This media is not archived.');
    const updated = await tx.updateTable('propertyMedia').set({ archivedAt: null }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, { action: 'media.restored', entityType: 'media', entityId: id });
    return this.toDto(updated);
  }

  /** Immediate erasure (policy §7.3): archived first, never under legal hold, company-wide archive grant only. */
  async purgeNow(tx: Tx, ctx: TenantContext, id: string, reason: string): Promise<void> {
    const current = await this.loadVisibleMedia(tx, ctx, id, 'property.archive', true);
    if (ctx.permissions.get('property.archive')?.scope !== 'all') {
      throw Problems.forbidden('Only the company owner or an office administrator can permanently delete media.');
    }
    if (current.archivedAt === null) throw Problems.businessRule('Archive the media before deleting it permanently.');
    if (current.legalHold) throw Problems.businessRule('This media is under legal hold and cannot be deleted.');
    await purgeMedia(tx, ctx, this.storage, this.audit, current, { reason, requestedBy: ctx.membershipId });
  }

  async setLegalHold(tx: Tx, ctx: TenantContext, id: string, body: LegalHoldBody): Promise<MediaDto> {
    const current = await this.loadVisibleMedia(tx, ctx, id, 'property.archive', true);
    if (ctx.permissions.get('property.archive')?.scope !== 'all') {
      throw Problems.forbidden('Only the company owner or an office administrator can manage legal holds.');
    }
    if (current.legalHold === body.hold) return this.toDto(current);
    const updated = await tx
      .updateTable('propertyMedia')
      .set(
        body.hold
          ? { legalHold: true, legalHoldReason: body.reason, legalHoldSetBy: ctx.membershipId, legalHoldSetAt: new Date() }
          : { legalHold: false, legalHoldReason: null, legalHoldSetBy: null, legalHoldSetAt: null },
      )
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: body.hold ? 'media.legal_hold_set' : 'media.legal_hold_released',
      entityType: 'media',
      entityId: id,
      metadata: { reason: body.reason },
    });
    return this.toDto(updated);
  }

  // --------------------------------------------------------------------------- listing galleries (M-D5)

  async listingGallery(tx: Tx, ctx: TenantContext, listingId: string): Promise<ListingGalleryDto> {
    const listing = await tx.selectFrom('listings').select(['id', 'officeId', 'agentMembershipId', 'version']).where('id', '=', listingId).executeTakeFirst();
    if (!listing || !hasListingPermission(ctx, listing, 'listing.view')) throw Problems.notFound();
    return { data: await this.galleryItems(tx, listingId), listingVersion: listing.version };
  }

  async setListingGallery(tx: Tx, ctx: TenantContext, listingId: string, expectedVersion: number, body: ListingMediaBody): Promise<ListingGalleryDto> {
    const listing = await tx
      .selectFrom('listings as l')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .select(['l.id', 'l.officeId', 'l.agentMembershipId', 'l.version', 'l.status', 'l.archivedAt', 'l.unitId', 'u.propertyId'])
      .where('l.id', '=', listingId)
      .forUpdate('l')
      .executeTakeFirst();
    if (!listing || !hasListingPermission(ctx, listing, 'listing.view')) throw Problems.notFound();
    if (!hasListingPermission(ctx, listing, 'listing.update')) throw Problems.forbidden('Your role does not allow this action on this listing.');
    if (listing.archivedAt !== null || isTerminal(listing.status)) throw Problems.businessRule('Closed or archived listings cannot be edited.');
    if (listing.version !== expectedVersion) throw Problems.preconditionFailed();

    const ids = body.items.map((item) => item.mediaId);
    const media = ids.length === 0
      ? []
      : await tx
          .selectFrom('propertyMedia')
          .select(['id', 'propertyId', 'unitId', 'mediaType', 'processingStatus', 'archivedAt'])
          .where('id', 'in', ids)
          .execute();
    const byId = new Map(media.map((row) => [row.id, row]));
    const errors = body.items.flatMap((item, index) => {
      const row = byId.get(item.mediaId);
      const field = `items[${index}].mediaId`;
      if (!row || row.propertyId !== listing.propertyId || (row.unitId !== null && row.unitId !== listing.unitId)) {
        return [{ field, code: 'not-found', message: 'This media does not belong to the listing’s property or unit.' }];
      }
      if (row.archivedAt !== null) return [{ field, code: 'archived', message: 'Archived media cannot be shown on a listing.' }];
      if (row.processingStatus !== 'ready') return [{ field, code: 'not-ready', message: 'This media is still processing or was rejected.' }];
      if (item.isCover && row.mediaType !== 'photo') return [{ field, code: 'invalid-cover', message: 'Only a photo can be the cover.' }];
      return [];
    });
    if (body.items.filter((item) => item.isCover).length > 1) {
      errors.push({ field: 'items', code: 'one-cover', message: 'Choose one cover image.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    const count = (type: string) => body.items.filter((item) => byId.get(item.mediaId)!.mediaType === type).length;
    if (count('photo') > MAX_PHOTOS_PER_LISTING) {
      throw Problems.validation([{ field: 'items', code: 'limit', message: `A listing can show at most ${MAX_PHOTOS_PER_LISTING} photos.` }]);
    }
    if (count('floor_plan') > MAX_FLOOR_PLANS_PER_LISTING) {
      throw Problems.validation([{ field: 'items', code: 'limit', message: `A listing can show at most ${MAX_FLOOR_PLANS_PER_LISTING} floor plans.` }]);
    }

    // Without an explicit cover, the first photo is the cover.
    const coverId = body.items.find((item) => item.isCover)?.mediaId ?? body.items.find((item) => byId.get(item.mediaId)!.mediaType === 'photo')?.mediaId;
    const before = await tx.selectFrom('listingMedia').select(['mediaId', 'isCover']).where('listingId', '=', listingId).orderBy('sortOrder').execute();
    const unchanged =
      before.length === ids.length && before.every((row, index) => row.mediaId === ids[index] && row.isCover === (row.mediaId === coverId));
    if (unchanged) return { data: await this.galleryItems(tx, listingId), listingVersion: listing.version };

    await tx.deleteFrom('listingMedia').where('listingId', '=', listingId).execute();
    if (ids.length > 0) {
      await tx
        .insertInto('listingMedia')
        .values(ids.map((mediaId, index) => ({ companyId: ctx.companyId, listingId, mediaId, sortOrder: index, isCover: mediaId === coverId, addedBy: actingMembership(ctx) })))
        .execute();
    }
    const touched = await tx.updateTable('listings').set({ updatedAt: sql<Date>`now()` }).where('id', '=', listingId).returning('version').executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'listing.media_updated',
      entityType: 'listing',
      entityId: listingId,
      changes: { media: { old: before.map((row) => row.mediaId), new: ids }, coverMediaId: { old: before.find((row) => row.isCover)?.mediaId ?? null, new: coverId ?? null } },
    });
    await this.audit.emit(tx, ctx, { eventType: 'listing.updated', aggregateType: 'listing', aggregateId: listingId, payload: { listingId, media: true } });
    return { data: await this.galleryItems(tx, listingId), listingVersion: touched.version };
  }

  // --------------------------------------------------------------------------- helpers

  private async galleryItems(tx: Tx, listingId: string) {
    const rows = await tx
      .selectFrom('listingMedia as lm')
      .innerJoin('propertyMedia as m', 'm.id', 'lm.mediaId')
      .selectAll('m')
      .select(['lm.sortOrder as position', 'lm.isCover'])
      .where('lm.listingId', '=', listingId)
      .orderBy('lm.sortOrder')
      .execute();
    return Promise.all(rows.map(async (row) => ({ ...(await this.toDto(row)), position: row.position, isCover: row.isCover })));
  }

  private async reserve(tx: Tx, ctx: TenantContext, bytes: number): Promise<void> {
    const plan = await planLimit(tx);
    if (!plan) throw new ProblemError(403, 'quota-exceeded', 'Storage not available', 'Your company has no active plan with media storage.');
    await tx.insertInto('storageUsage').values({ companyId: ctx.companyId }).onConflict((oc) => oc.column('companyId').doNothing()).execute();
    const usage = await tx.selectFrom('storageUsage').select(['bytesUsed', 'bytesReserved']).where('companyId', '=', ctx.companyId).forUpdate().executeTakeFirstOrThrow();
    if (Number(usage.bytesUsed) + Number(usage.bytesReserved) + bytes > plan.limitBytes) {
      throw new ProblemError(
        403,
        'quota-exceeded',
        'Storage quota exceeded',
        `This upload would exceed your plan’s ${formatGb(plan.limitBytes)} of media storage. Archive unused media or upgrade your plan.`,
      );
    }
    await tx
      .updateTable('storageUsage')
      .set({ bytesReserved: sql`bytes_reserved + ${bytes}`, updatedAt: sql`now()` })
      .where('companyId', '=', ctx.companyId)
      .execute();
  }

  private async loadProperty(tx: Tx, id: string) {
    return tx.selectFrom('properties').select(['id', 'officeId', 'createdBy', 'archivedAt']).where('id', '=', id).executeTakeFirst();
  }

  private async assertUnit(tx: Tx, unitId: string, propertyId: string): Promise<void> {
    const unit = await tx.selectFrom('units').select(['propertyId', 'archivedAt']).where('id', '=', unitId).executeTakeFirst();
    if (!unit || unit.propertyId !== propertyId) {
      throw Problems.validation([{ field: 'unitId', code: 'not-found', message: 'This unit does not belong to the property.' }]);
    }
    if (unit.archivedAt !== null) throw Problems.businessRule('Archived units cannot receive new media.');
  }

  private async assertListingForProperty(tx: Tx, ctx: TenantContext, listingId: string, propertyId: string): Promise<void> {
    const listing = await tx
      .selectFrom('listings as l')
      .innerJoin('units as u', 'u.id', 'l.unitId')
      .select(['l.officeId', 'l.agentMembershipId', 'l.status', 'l.archivedAt', 'u.propertyId'])
      .where('l.id', '=', listingId)
      .executeTakeFirst();
    if (!listing || !hasListingPermission(ctx, listing, 'listing.view') || listing.propertyId !== propertyId) {
      throw Problems.validation([{ field: 'listingId', code: 'not-found', message: 'This listing does not exist for the property.' }]);
    }
    if (!hasListingPermission(ctx, listing, 'listing.update')) throw Problems.forbidden('Your role does not allow this action on this listing.');
    if (listing.archivedAt !== null || isTerminal(listing.status)) throw Problems.businessRule('Closed or archived listings cannot receive new media.');
  }

  private async loadVisibleMedia(tx: Tx, ctx: TenantContext, id: string, permission: string, lock = false): Promise<MediaRow> {
    let qb = tx.selectFrom('propertyMedia').selectAll().where('id', '=', id);
    if (lock) qb = qb.forUpdate();
    const row = await qb.executeTakeFirst();
    if (!row) throw Problems.notFound();
    const property = await this.loadProperty(tx, row.propertyId);
    await assertPropertyAccess(tx, ctx, property!, permission);
    return row;
  }

  async toDto(row: MediaRow): Promise<MediaDto> {
    const derivatives = (row.derivatives ?? {}) as Derivatives;
    const ttl = this.config.MEDIA_DOWNLOAD_URL_TTL_SECONDS;
    const urls: MediaUrlsDto = {};
    if (row.externalUrl) {
      urls.external = row.externalUrl;
    } else if (row.processingStatus === 'ready') {
      for (const { name } of VARIANTS) {
        const file = derivatives.variants?.[name];
        if (file) urls[name] = await this.storage.signDownload(file.key, ttl);
      }
      if (row.mimeType === PDF_MIME && derivatives.master) {
        urls.download = await this.storage.signDownload(derivatives.master.key, ttl, { downloadName: row.originalFilename ?? 'document.pdf' });
      }
    }
    return {
      id: row.id,
      propertyId: row.propertyId,
      unitId: row.unitId,
      mediaType: row.mediaType,
      processingStatus: row.processingStatus,
      rejectionReason: row.rejectionReason,
      originalFilename: row.originalFilename,
      mimeType: row.mimeType,
      width: row.widthPx,
      height: row.heightPx,
      pageCount: row.pageCount,
      storedBytes: row.processingStatus === 'ready' && row.sizeBytes !== null ? Number(row.sizeBytes) : null,
      externalProvider: row.externalProvider,
      caption: row.caption,
      altText: row.altText,
      roomLabel: row.roomLabel,
      floorLabel: row.floorLabel,
      sortOrder: row.sortOrder,
      urls,
      legalHold: row.legalHold,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      purgeAfter: row.archivedAt && !row.legalHold ? new Date(row.archivedAt.getTime() + ARCHIVE_RETENTION_DAYS * 86_400_000).toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }
}

// ----------------------------------------------------------------------------- shared with the worker

/** The company's plan storage entitlement (latest live subscription), or null. */
export async function planLimit(tx: Tx): Promise<{ planCode: string; limitBytes: number } | null> {
  const row = await tx
    .selectFrom('subscriptions as s')
    .innerJoin('planEntitlements as e', (join) => join.onRef('e.planCode', '=', 's.planCode').on('e.featureKey', '=', 'storage.bytes'))
    .select(['s.planCode', 'e.limitValue', 'e.isEnabled'])
    .where('s.status', 'in', ['trialing', 'active', 'past_due'])
    .orderBy('s.createdAt', 'desc')
    .executeTakeFirst();
  if (!row || !row.isEnabled || row.limitValue === null) return null;
  return { planCode: row.planCode, limitBytes: Number(row.limitValue) };
}

export async function releaseReservation(tx: Tx, companyId: string, bytes: number): Promise<void> {
  await tx
    .updateTable('storageUsage')
    .set({ bytesReserved: sql`greatest(bytes_reserved - ${bytes}, 0)`, updatedAt: sql`now()` })
    .where('companyId', '=', companyId)
    .execute();
}

export async function enqueueProcessing(tx: Tx, companyId: string, mediaId: string, uploadSessionId: string): Promise<void> {
  await tx
    .insertInto('scheduledJobs')
    .values({
      companyId,
      jobType: MEDIA_PROCESS_JOB,
      entityType: 'media',
      entityId: mediaId,
      localDue: sql<Date>`(now() at time zone 'UTC')`,
      timezone: 'UTC',
      runAt: sql<Date>`now()`,
      idempotencyKey: `${MEDIA_PROCESS_JOB}:${mediaId}`,
      payload: JSON.stringify({ mediaId, uploadSessionId }),
    })
    .onConflict((oc) => oc.columns(['companyId', 'idempotencyKey']).doNothing())
    .execute();
}

/** Every storage key a media item occupies. */
export function storageKeysOf(row: Pick<MediaRow, 'storageKey' | 'derivatives'>): string[] {
  const derivatives = (row.derivatives ?? {}) as Derivatives;
  return [
    ...(row.storageKey ? [row.storageKey] : []),
    ...(derivatives.master ? [derivatives.master.key] : []),
    ...Object.values(derivatives.variants ?? {}).map((file) => file.key),
  ].filter((key, index, all) => all.indexOf(key) === index);
}

/**
 * Permanent deletion (policy §7.2/§7.3): objects first, then the bytes, the
 * listing links and the row; the audit entry keeps the item's metadata.
 */
export async function purgeMedia(
  tx: Tx,
  ctx: TenantContext,
  storage: StoragePort,
  audit: AuditService,
  row: MediaRow,
  details: { reason: string; requestedBy?: string },
): Promise<void> {
  await storage.remove(storageKeysOf(row));
  if (row.processingStatus === 'ready' && row.sizeBytes !== null && !row.externalUrl) {
    await tx
      .updateTable('storageUsage')
      .set({ bytesUsed: sql`greatest(bytes_used - ${Number(row.sizeBytes)}, 0)`, updatedAt: sql`now()` })
      .where('companyId', '=', row.companyId)
      .execute();
  }
  await tx.deleteFrom('propertyMedia').where('id', '=', row.id).execute();
  await audit.record(tx, ctx, {
    action: 'media.purged',
    entityType: 'media',
    entityId: row.id,
    metadata: {
      reason: details.reason,
      ...(details.requestedBy ? { requestedBy: details.requestedBy } : {}),
      propertyId: row.propertyId,
      unitId: row.unitId,
      mediaType: row.mediaType,
      originalFilename: row.originalFilename,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      checksumSha256: row.checksumSha256 ? Buffer.from(row.checksumSha256).toString('hex') : null,
    },
  });
}

export async function touchListings(tx: Tx, listingIds: string[]): Promise<void> {
  await tx.updateTable('listings').set({ updatedAt: sql<Date>`now()` }).where('id', 'in', listingIds).execute();
}

/** Display file names: NFC, no control characters, at most 200 characters. */
export function normaliseFileName(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
  return (cleaned.length > 0 ? cleaned : 'file').slice(0, 200);
}

function formatGb(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1024 ? `${gb / 1024} TB` : `${gb} GB`;
}
