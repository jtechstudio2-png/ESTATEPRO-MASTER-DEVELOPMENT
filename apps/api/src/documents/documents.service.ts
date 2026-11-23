import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { ProblemError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { Tx } from '../database/database.module.js';
import { assertLettingsRecord, type LettingsEntity } from '../lettings/lettings-access.js';
import { documentMaxBytes } from './document-rules.js';
import { normaliseFileName, releaseReservation, reserveStorage } from '../media/media.service.js';
import { STORAGE, type StoragePort } from '../media/storage.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { type CreateDocumentUploadBody, CSV_MIME, DOCUMENT_MIME_TYPES, type DocumentDownloadDto, type DocumentDto, type DocumentUploadTicketDto } from './documents.dto.js';

export const DOCUMENT_SCAN_JOB = 'document.scan';

/** Category of a document type (migration 0011 categories). */
const CATEGORY: Record<string, string> = {
  agency_agreement: 'legal',
  management_agreement: 'legal',
  lease: 'legal',
  sale_agreement: 'legal',
  notice: 'correspondence',
  title_deed: 'property',
  site_plan: 'property',
  building_permit: 'property',
  identity: 'identity',
  proof_of_address: 'identity',
  proof_of_funds: 'financial',
  invoice: 'financial',
  receipt: 'financial',
  bank_statement: 'financial',
  inspection_report: 'compliance',
  inspection_photo: 'media',
  safety_certificate: 'compliance',
  insurance: 'compliance',
};

/**
 * Documents (verification report W7-A1, approved for L1). A file is uploaded
 * straight to private storage with a signed URL, confirmed, then scanned by
 * the worker; only a clean file can be downloaded or used to activate a lease
 * or agreement (migration 0036). Versions never change once recorded
 * (migration 0011). Access follows the record the document belongs to.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createUpload(tx: Tx, ctx: TenantContext, body: CreateDocumentUploadBody): Promise<DocumentUploadTicketDto> {
    await assertLettingsRecord(tx, ctx, body.entityType, body.entityId, 'change');
    const mime = body.contentType.toLowerCase();
    if (!(DOCUMENT_MIME_TYPES as readonly string[]).includes(mime)) {
      throw Problems.validation([{ field: 'contentType', code: 'unsupported', message: `Accepted: ${DOCUMENT_MIME_TYPES.join(', ')}.` }]);
    }
    if ((mime === CSV_MIME) !== (body.entityType === 'bank_account' && body.documentTypeCode === 'bank_statement')) {
      throw Problems.validation([{ field: 'contentType', code: 'unsupported', message: 'CSV files are bank statements of a bank account; a bank statement is a CSV file.' }]);
    }
    if (body.size > documentMaxBytes(mime)) {
      throw Problems.validation([{ field: 'size', code: 'too-large', message: `Files of this type can be at most ${documentMaxBytes(mime) / (1024 * 1024)} MB.` }]);
    }
    const country = await this.entityCountry(tx, body.entityType, body.entityId);
    const typeError = await checkPicklistCode(tx, 'document_type', body.documentTypeCode, country, 'documentTypeCode');
    if (typeError) throw Problems.validation([typeError]);

    await reserveStorage(tx, ctx.companyId, body.size);
    const id = randomUUID();
    // The key is final from the start: versions never change (migration 0011); the file is unusable until scanned clean.
    const storageKey = `${ctx.companyId}/documents/${id}`;
    const expiresAt = new Date(Date.now() + this.config.MEDIA_UPLOAD_URL_TTL_SECONDS * 1000);
    await tx
      .insertInto('documentUploadSessions')
      .values({
        id,
        companyId: ctx.companyId,
        entityType: body.entityType,
        entityId: body.entityId,
        title: body.title,
        documentTypeCode: body.documentTypeCode,
        category: CATEGORY[body.documentTypeCode] ?? 'other',
        isSigned: body.isSigned ?? false,
        fileName: normaliseFileName(body.fileName),
        declaredMime: mime,
        declaredSize: body.size,
        sha256: Buffer.from(body.sha256, 'hex'),
        storageKey,
        expiresAt: new Date(expiresAt.getTime() + 55 * 60 * 1000),
        createdBy: ctx.membershipId,
      })
      .execute();
    const uploadUrl = await this.storage.signUpload(storageKey, mime, body.size, this.config.MEDIA_UPLOAD_URL_TTL_SECONDS);
    return { id, uploadUrl, method: 'PUT', headers: { 'Content-Type': mime, 'Content-Length': String(body.size) }, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Records the document and its first version (scan pending) and queues the
   * scan. Returns a ProblemError instead of throwing when the upload must be
   * cancelled, so the cancellation and released quota are committed.
   */
  async confirmUpload(tx: Tx, ctx: TenantContext, sessionId: string): Promise<DocumentDto | ProblemError> {
    const session = await tx.selectFrom('documentUploadSessions').selectAll().where('id', '=', sessionId).forUpdate().executeTakeFirst();
    if (!session) throw Problems.notFound();
    await assertLettingsRecord(tx, ctx, session.entityType as LettingsEntity, session.entityId, 'change');
    if (session.createdBy !== ctx.membershipId) throw Problems.forbidden('Only the person who started this upload can confirm it.');
    if (session.status === 'confirmed' && session.documentId) return this.get(tx, ctx, session.documentId);
    if (session.status !== 'pending') throw Problems.businessRule('This upload was cancelled or has expired. Start a new upload.');
    if (session.expiresAt.getTime() < Date.now()) throw Problems.businessRule('This upload has expired. Start a new upload.');

    const stored = await this.storage.head(session.storageKey);
    if (!stored) throw Problems.businessRule('The file has not been uploaded yet. Upload it with the signed URL, then confirm.');
    if (stored.size !== Number(session.declaredSize)) {
      await this.storage.remove([session.storageKey]);
      await tx.updateTable('documentUploadSessions').set({ status: 'cancelled' }).where('id', '=', session.id).execute();
      await releaseReservation(tx, ctx.companyId, Number(session.declaredSize));
      return Problems.businessRule('The uploaded file does not match the declared size. Start a new upload.');
    }

    const documentId = randomUUID();
    const versionId = randomUUID();
    await tx
      .insertInto('documents')
      .values({ id: documentId, companyId: ctx.companyId, title: session.title, documentTypeCode: session.documentTypeCode, category: session.category, confidentiality: 'restricted', createdBy: ctx.membershipId })
      .execute();
    await tx
      .insertInto('documentVersions')
      .values({
        id: versionId,
        companyId: ctx.companyId,
        documentId,
        versionNo: 1,
        storageKey: session.storageKey,
        fileName: session.fileName,
        mimeType: session.declaredMime,
        sizeBytes: session.declaredSize,
        checksumSha256: session.sha256,
        isSigned: session.isSigned,
        uploadedBy: ctx.membershipId,
      })
      .execute();
    await tx.updateTable('documents').set({ currentVersionId: versionId }).where('id', '=', documentId).execute();
    await tx.insertInto('documentLinks').values({ companyId: ctx.companyId, documentId, entityType: session.entityType, entityId: session.entityId, linkedBy: ctx.membershipId }).execute();
    await tx.updateTable('documentUploadSessions').set({ status: 'confirmed', documentId }).where('id', '=', session.id).execute();
    await tx
      .insertInto('scheduledJobs')
      .values({
        companyId: ctx.companyId,
        jobType: DOCUMENT_SCAN_JOB,
        entityType: 'document',
        entityId: documentId,
        localDue: sql<Date>`(now() at time zone 'UTC')`,
        timezone: 'UTC',
        runAt: sql<Date>`now()`,
        idempotencyKey: `${DOCUMENT_SCAN_JOB}:${versionId}`,
        payload: JSON.stringify({ documentId, versionId }),
      })
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'document.uploaded',
      entityType: 'document',
      entityId: documentId,
      metadata: { versionId, entityType: session.entityType, entityId: session.entityId, documentTypeCode: session.documentTypeCode, isSigned: session.isSigned, size: Number(session.declaredSize), mimeType: session.declaredMime },
    });
    await this.audit.emit(tx, ctx, { eventType: 'document.uploaded', aggregateType: 'document', aggregateId: documentId, payload: { documentId, entityType: session.entityType, entityId: session.entityId } });
    return this.get(tx, ctx, documentId);
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<DocumentDto> {
    const [document] = await this.rows(tx, { id });
    if (!document) throw Problems.notFound();
    await this.assertVisible(tx, ctx, document.links);
    return document;
  }

  /** Documents of one lease or agreement, newest first. */
  async listFor(tx: Tx, ctx: TenantContext, entityType: LettingsEntity, entityId: string): Promise<DocumentDto[]> {
    await assertLettingsRecord(tx, ctx, entityType, entityId, 'view');
    return this.rows(tx, { entityType, entityId });
  }

  /** A short-lived link to a clean document; the download is audited. */
  async download(tx: Tx, ctx: TenantContext, id: string): Promise<DocumentDownloadDto> {
    const document = await this.get(tx, ctx, id);
    if (document.scanStatus !== 'clean') {
      throw Problems.businessRule(document.scanStatus === 'pending' ? 'This document is still being checked. Try again in a moment.' : 'This document did not pass the security scan and cannot be downloaded.');
    }
    const version = await tx
      .selectFrom('documents as d')
      .innerJoin('documentVersions as v', 'v.id', 'd.currentVersionId')
      .select(['v.storageKey', 'v.fileName', 'v.id'])
      .where('d.id', '=', id)
      .executeTakeFirstOrThrow();
    const ttl = this.config.MEDIA_DOWNLOAD_URL_TTL_SECONDS;
    const url = await this.storage.signDownload(version.storageKey, ttl, { downloadName: version.fileName });
    await this.audit.record(tx, ctx, { action: 'document.downloaded', entityType: 'document', entityId: id, metadata: { versionId: version.id } });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  /** The document must belong to the record and be clean (checked here for a clear answer; the database checks again). */
  async assertUsable(tx: Tx, documentId: string, entityType: LettingsEntity, entityId: string, field: string): Promise<void> {
    await this.assertClean(tx, documentId, entityType, entityId, field, true);
  }

  /** The document belongs to the record and passed the scan (photos and evidence need no signature). */
  async assertClean(tx: Tx, documentId: string, entityType: LettingsEntity, entityId: string, field: string, signed = false): Promise<void> {
    const row = await tx
      .selectFrom('documents as d')
      .innerJoin('documentVersions as v', 'v.id', 'd.currentVersionId')
      .select(['v.scanStatus', 'v.isSigned'])
      .where('d.id', '=', documentId)
      .where((eb) => eb.exists(eb.selectFrom('documentLinks as k').select('k.documentId').whereRef('k.documentId', '=', 'd.id').where('k.entityType', '=', entityType).where('k.entityId', '=', entityId)))
      .executeTakeFirst();
    if (!row) throw Problems.validation([{ field, code: 'not-found', message: 'Upload the document to this record first.' }]);
    if (row.scanStatus === 'pending') throw Problems.validation([{ field, code: 'scan-pending', message: 'The document is still being checked. Try again in a moment.' }]);
    if (row.scanStatus !== 'clean') throw Problems.validation([{ field, code: 'scan-failed', message: 'The document did not pass the security scan. Upload it again.' }]);
    if (signed && !row.isSigned) throw Problems.validation([{ field, code: 'not-signed', message: 'Upload the signed copy.' }]);
  }

  private async assertVisible(tx: Tx, ctx: TenantContext, links: Array<{ entityType: string; entityId: string }>): Promise<void> {
    for (const link of links) {
      try {
        await assertLettingsRecord(tx, ctx, link.entityType as LettingsEntity, link.entityId, 'view');
        return;
      } catch (error) {
        if (!(error instanceof ProblemError) || error.status !== 404) throw error;
      }
    }
    throw Problems.notFound();
  }

  private async rows(tx: Tx, filter: { id?: string; entityType?: string; entityId?: string }): Promise<DocumentDto[]> {
    let query = tx
      .selectFrom('documents as d')
      .innerJoin('documentVersions as v', 'v.id', 'd.currentVersionId')
      .leftJoin('companyMemberships as m', 'm.id', 'v.uploadedBy')
      .leftJoin('users as u', 'u.id', 'm.userId')
      .select(['d.id', 'd.title', 'd.documentTypeCode', 'd.category', 'v.scanStatus', 'v.fileName', 'v.mimeType', 'v.sizeBytes', 'v.isSigned', 'v.versionNo', 'v.uploadedBy', 'u.displayName as uploadedByName', 'v.uploadedAt'])
      .where('d.archivedAt', 'is', null);
    if (filter.id) query = query.where('d.id', '=', filter.id);
    if (filter.entityType && filter.entityId) {
      const { entityType, entityId } = filter;
      query = query.where((eb) =>
        eb.exists(eb.selectFrom('documentLinks as k').select('k.documentId').whereRef('k.documentId', '=', 'd.id').where('k.entityType', '=', entityType).where('k.entityId', '=', entityId)),
      );
    }
    const rows = await query.orderBy('v.uploadedAt', 'desc').orderBy('d.id', 'desc').execute();
    if (rows.length === 0) return [];
    const links = await tx.selectFrom('documentLinks').select(['documentId', 'entityType', 'entityId']).where('documentId', 'in', rows.map((row) => row.id)).orderBy('entityType').execute();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      documentTypeCode: row.documentTypeCode,
      category: row.category,
      scanStatus: row.scanStatus,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      isSigned: row.isSigned,
      versionNo: row.versionNo,
      uploadedBy: row.uploadedBy ? { id: row.uploadedBy, name: row.uploadedByName ?? '' } : null,
      uploadedAt: row.uploadedAt.toISOString(),
      links: links.filter((link) => link.documentId === row.id).map((link) => ({ entityType: link.entityType, entityId: link.entityId })),
    }));
  }

  /** The country of the record's office, for country-specific picklist values. */
  private async entityCountry(tx: Tx, entityType: LettingsEntity, entityId: string): Promise<string> {
    if (entityType === 'bank_account') {
      return (await tx.selectFrom('bankAccounts').select('countryCode').where('id', '=', entityId).executeTakeFirstOrThrow()).countryCode;
    }
    if (entityType === 'inspection') {
      const inspection = await tx
        .selectFrom('inspections as i')
        .innerJoin('properties as p', 'p.id', 'i.propertyId')
        .innerJoin('offices as o', 'o.id', 'p.officeId')
        .select('o.countryCode')
        .where('i.id', '=', entityId)
        .executeTakeFirstOrThrow();
      return inspection.countryCode;
    }
    const row =
      entityType === 'lease'
        ? await tx
            .selectFrom('leases as l')
            .innerJoin('units as u', 'u.id', 'l.unitId')
            .innerJoin('properties as p', 'p.id', 'u.propertyId')
            .innerJoin('offices as o', 'o.id', 'p.officeId')
            .select('o.countryCode')
            .where('l.id', '=', entityId)
            .executeTakeFirstOrThrow()
        : await tx
            .selectFrom('managementAgreements as a')
            .innerJoin('properties as p', 'p.id', 'a.propertyId')
            .innerJoin('offices as o', 'o.id', 'p.officeId')
            .select('o.countryCode')
            .where('a.id', '=', entityId)
            .executeTakeFirstOrThrow();
    return row.countryCode;
  }
}
