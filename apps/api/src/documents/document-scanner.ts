import { sql } from 'kysely';

import type { AuditService } from '../audit/audit.service.js';
import { systemContext } from '../common/request-context.js';
import type { TenantDb } from '../database/database.module.js';
import { maxBytesFor } from '../media/media-rules.js';
import { releaseReservation } from '../media/media.service.js';
import { sha256, sniffMime } from '../media/processing.js';
import type { MalwareScanner } from '../media/scanner.js';
import type { StoragePort } from '../media/storage.js';
import { DOCUMENT_MIME_TYPES } from './documents.dto.js';

export type ScanOutcome = 'clean' | 'infected' | 'failed' | 'skipped';

/**
 * Checks a confirmed document version (W7-A1): size, checksum, malware scan
 * (fail closed: a scanner outage throws so the queue retries), and that the
 * content is the declared type. The result is recorded once (migration 0036).
 * A rejected file is deleted at once; the version row stays as the record.
 */
export class DocumentScanner {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly storage: StoragePort,
    private readonly scanner: MalwareScanner,
    private readonly audit: AuditService,
  ) {}

  async scan(companyId: string, versionId: string, requestId: string): Promise<ScanOutcome> {
    const scope = { companyId, userId: '' };
    const version = await this.tenantDb.run(scope, (tx) =>
      tx.selectFrom('documentVersions').select(['id', 'documentId', 'storageKey', 'mimeType', 'sizeBytes', 'checksumSha256', 'scanStatus']).where('id', '=', versionId).executeTakeFirst(),
    );
    if (!version || version.scanStatus !== 'pending') return 'skipped';
    const declaredSize = Number(version.sizeBytes);

    let verdict: { status: 'clean' } | { status: 'infected' | 'failed'; code: string; signature?: string };
    const stored = await this.storage.head(version.storageKey);
    if (!stored || stored.size !== declaredSize || stored.size > maxBytesFor(version.mimeType)) {
      verdict = { status: 'failed', code: stored ? 'size-mismatch' : 'missing' };
    } else {
      const content = await this.storage.read(version.storageKey, maxBytesFor(version.mimeType));
      if (!sha256(content).equals(Buffer.from(version.checksumSha256))) {
        verdict = { status: 'failed', code: 'checksum-mismatch' };
      } else {
        const result = await this.scanner.scan(content);
        if (!result.clean) {
          verdict = { status: 'infected', code: 'malware', signature: result.signature };
        } else {
          const sniffed = await sniffMime(content);
          verdict =
            sniffed === version.mimeType && (DOCUMENT_MIME_TYPES as readonly string[]).includes(sniffed)
              ? { status: 'clean' }
              : { status: 'failed', code: 'type-mismatch' };
        }
      }
    }
    if (verdict.status !== 'clean') await this.storage.remove([version.storageKey]);
    return this.record(companyId, versionId, requestId, verdict);
  }

  /** Marks a version that could not be scanned after every retry as failed. */
  async fail(companyId: string, versionId: string, requestId: string): Promise<void> {
    await this.record(companyId, versionId, requestId, { status: 'failed', code: 'scan-unavailable' });
  }

  private async record(
    companyId: string,
    versionId: string,
    requestId: string,
    verdict: { status: 'clean' } | { status: 'infected' | 'failed'; code: string; signature?: string },
  ): Promise<ScanOutcome> {
    const ctx = systemContext(companyId, requestId);
    return this.tenantDb.run({ companyId, userId: '' }, async (tx) => {
      const current = await tx.selectFrom('documentVersions').select(['documentId', 'scanStatus', 'sizeBytes']).where('id', '=', versionId).forUpdate().executeTakeFirst();
      if (!current || current.scanStatus !== 'pending') return 'skipped' as const;
      const bytes = Number(current.sizeBytes);
      await tx.updateTable('documentVersions').set({ scanStatus: verdict.status }).where('id', '=', versionId).execute();
      if (verdict.status === 'clean') {
        await tx
          .updateTable('storageUsage')
          .set({ bytesUsed: sql`bytes_used + ${bytes}`, bytesReserved: sql`greatest(bytes_reserved - ${bytes}, 0)`, updatedAt: sql`now()` })
          .where('companyId', '=', companyId)
          .execute();
      } else {
        await releaseReservation(tx, companyId, bytes);
      }
      await this.audit.record(tx, ctx, {
        action: verdict.status === 'clean' ? 'document.scanned' : 'document.rejected',
        entityType: 'document',
        entityId: current.documentId,
        metadata: { versionId, scanStatus: verdict.status, ...(verdict.status === 'clean' ? {} : { code: verdict.code, ...(verdict.signature ? { signature: verdict.signature } : {}) }) },
      });
      await this.audit.emit(tx, ctx, {
        eventType: verdict.status === 'clean' ? 'document.scanned' : 'document.rejected',
        aggregateType: 'document',
        aggregateId: current.documentId,
        payload: { documentId: current.documentId, versionId, scanStatus: verdict.status },
      });
      return verdict.status;
    });
  }
}
