import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { contactScopeSql, scopeFor } from '../contacts/contact-access.js';
import { leadScopeSql } from '../crm/lead-access.js';
import type { Tx } from '../database/database.module.js';
import { STORAGE, type StoragePort } from '../media/storage.js';
import { csvDocument, type CsvValue } from './csv.js';
import { type ContactExportBody, EXPORT_LIFETIME_HOURS, type ExportDownloadDto, type ExportJobDto, type LeadExportBody, MAX_EXPORT_ROWS } from './dto.js';

const DOWNLOAD_LINK_SECONDS = 300;

const CONTACT_COLUMNS = [
  'reference', 'contact_type', 'display_name', 'display_name_local', 'roles', 'primary_phone', 'primary_email', 'preferred_channel',
  'preferred_locale', 'office', 'owner', 'source', 'marketing_consent', 'created_at', 'updated_at',
];
const LEAD_COLUMNS = [
  'reference', 'received_at', 'status', 'lead_type', 'source', 'source_detail', 'campaign', 'contact_reference', 'contact_name',
  'contact_phone', 'contact_email', 'listing_reference', 'office', 'assigned_to', 'first_response_at', 'next_action_at', 'lost_reason',
];

/**
 * Contact and lead exports (CA-16). Exports are sensitive (`contact.export`,
 * `lead.export`): each one states its purpose, respects the requester's
 * scope, never contains protected (C3) values, enquiry messages or notes,
 * and is audited when created and each time it is downloaded. Files expire
 * after 24 hours; only the requester can download them.
 */
@Injectable()
export class ExportsService {
  constructor(
    @Inject(STORAGE) private readonly storage: StoragePort,
    private readonly audit: AuditService,
  ) {}

  async exportContacts(tx: Tx, ctx: TenantContext, body: ContactExportBody): Promise<ExportJobDto> {
    const scope = scopeFor(ctx, 'contact.export')!;
    await this.checkOffice(tx, ctx, body.officeId, scope);
    const { rows } = await sql<{
      reference: string | null;
      contactType: string;
      displayName: string;
      displayNameLocal: string | null;
      roles: string[] | null;
      primaryPhoneE164: string | null;
      primaryEmail: string | null;
      preferredChannel: string | null;
      preferredLocaleCode: string | null;
      officeName: string | null;
      ownerName: string | null;
      sourceCode: string | null;
      marketing: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>`
      select c.reference, c.contact_type, c.display_name, c.display_name_local,
             (select array_agg(r.relationship_type order by r.relationship_type) from contact_relationships r
               where r.contact_id = c.id and r.status = 'active') as roles,
             c.primary_phone_e164, c.primary_email::text as primary_email, c.preferred_channel, c.preferred_locale_code,
             o.name as office_name, u.display_name as owner_name, c.source_code,
             (select string_agg(coalesce(s.channel, 'any') || ':' || s.status, '; ' order by s.channel)
                from (select distinct on (s.channel) s.channel, s.status from consents s
                       where s.contact_id = c.id and s.purpose = 'marketing' order by s.channel, s.captured_at desc, s.entry_no desc) s) as marketing,
             c.created_at, c.updated_at
        from contacts c
        left join offices o on o.id = c.office_id
        left join company_memberships m on m.id = c.owner_membership_id
        left join users u on u.id = m.user_id
       where c.merged_into_contact_id is null and c.archived_at is null and not c.is_anonymised
         and ${contactScopeSql(scope, ctx, 'c', 'write')}
         ${body.officeId ? sql`and c.office_id = ${body.officeId}::uuid` : sql``}
         ${body.contactType ? sql`and c.contact_type = ${body.contactType}` : sql``}
         ${body.relationships?.length ? sql`and exists (select 1 from contact_relationships r where r.contact_id = c.id and r.status = 'active' and r.relationship_type = any(${body.relationships}::text[]))` : sql``}
         ${body.excludeMarketingWithdrawn ? sql`and exists (select 1 from (select distinct on (s.channel) s.status from consents s where s.contact_id = c.id and s.purpose = 'marketing' order by s.channel, s.captured_at desc, s.entry_no desc) latest where latest.status = 'granted')` : sql``}
       order by c.display_name, c.id
       limit ${MAX_EXPORT_ROWS + 1}`.execute(tx);
    this.checkSize(rows.length);
    const csv = csvDocument(
      CONTACT_COLUMNS,
      rows.map((row): CsvValue[] => [
        row.reference, row.contactType, row.displayName, row.displayNameLocal, (row.roles ?? []).join(' '), row.primaryPhoneE164, row.primaryEmail,
        row.preferredChannel, row.preferredLocaleCode, row.officeName, row.ownerName, row.sourceCode, row.marketing ?? 'none', row.createdAt, row.updatedAt,
      ]),
    );
    return this.store(tx, ctx, 'contacts', body as unknown as Record<string, unknown>, csv, rows.length, 'contact.exported');
  }

  async exportLeads(tx: Tx, ctx: TenantContext, body: LeadExportBody): Promise<ExportJobDto> {
    const scope = scopeFor(ctx, 'lead.export')!;
    await this.checkOffice(tx, ctx, body.officeId, scope);
    const errors: FieldError[] = [];
    const from = parseInstant(body.receivedFrom, 'receivedFrom', errors);
    const to = parseInstant(body.receivedTo, 'receivedTo', errors);
    if (errors.length > 0) throw Problems.validation(errors);
    const { rows } = await sql<{
      reference: string;
      receivedAt: Date;
      status: string;
      leadType: string;
      sourceCode: string;
      sourceDetail: string | null;
      campaign: string | null;
      contactReference: string | null;
      contactName: string;
      contactPhone: string | null;
      contactEmail: string | null;
      listingReference: string | null;
      officeName: string | null;
      assigneeName: string | null;
      firstResponseAt: Date | null;
      nextActionAt: Date | null;
      lostReasonCode: string | null;
    }>`
      select l.reference, l.received_at, l.status, l.lead_type, l.source_code, l.source_detail, l.campaign,
             c.reference as contact_reference, c.display_name as contact_name, c.primary_phone_e164 as contact_phone, c.primary_email::text as contact_email,
             li.reference as listing_reference, o.name as office_name, u.display_name as assignee_name,
             l.first_response_at, l.next_action_at, l.lost_reason_code
        from leads l
        join contacts c on c.id = l.contact_id
        left join listings li on li.id = l.listing_id
        left join offices o on o.id = l.office_id
        left join company_memberships m on m.id = l.assigned_to
        left join users u on u.id = m.user_id
       where l.archived_at is null and ${leadScopeSql(scope, ctx, 'l')}
         ${body.officeId ? sql`and l.office_id = ${body.officeId}::uuid` : sql``}
         ${body.statuses?.length ? sql`and l.status = any(${body.statuses}::text[])` : sql``}
         ${body.leadTypes?.length ? sql`and l.lead_type = any(${body.leadTypes}::text[])` : sql``}
         ${from ? sql`and l.received_at >= ${from}` : sql``}
         ${to ? sql`and l.received_at < ${to}` : sql``}
       order by l.received_at desc, l.id
       limit ${MAX_EXPORT_ROWS + 1}`.execute(tx);
    this.checkSize(rows.length);
    const csv = csvDocument(
      LEAD_COLUMNS,
      rows.map((row): CsvValue[] => [
        row.reference, row.receivedAt, row.status, row.leadType, row.sourceCode, row.sourceDetail, row.campaign, row.contactReference, row.contactName,
        row.contactPhone, row.contactEmail, row.listingReference, row.officeName, row.assigneeName, row.firstResponseAt, row.nextActionAt, row.lostReasonCode,
      ]),
    );
    return this.store(tx, ctx, 'leads', body as unknown as Record<string, unknown>, csv, rows.length, 'lead.exported');
  }

  /** Your exports; members who manage users see everyone's (the admin dashboard's list). */
  async list(tx: Tx, ctx: TenantContext): Promise<ExportJobDto[]> {
    assertExportAccess(ctx);
    await this.expireDue(tx, ctx);
    let qb = this.query(tx).orderBy('e.createdAt', 'desc').orderBy('e.id', 'desc').limit(100);
    if (scopeFor(ctx, 'user.manage') === null) qb = qb.where('e.requestedBy', '=', ctx.membershipId);
    return (await qb.execute()).map((row) => this.toDto(ctx, row));
  }

  async get(tx: Tx, ctx: TenantContext, id: string): Promise<ExportJobDto> {
    assertExportAccess(ctx);
    await this.expireDue(tx, ctx);
    const row = await this.query(tx).where('e.id', '=', id).executeTakeFirst();
    if (!row || (row.requestedBy !== ctx.membershipId && scopeFor(ctx, 'user.manage') === null)) throw Problems.notFound();
    return this.toDto(ctx, row);
  }

  /** A short-lived link for the requester; each download is audited. */
  async download(tx: Tx, ctx: TenantContext, id: string): Promise<ExportDownloadDto> {
    assertExportAccess(ctx);
    await this.expireDue(tx, ctx);
    const job = await tx.selectFrom('exportJobs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!job || (job.requestedBy !== ctx.membershipId && scopeFor(ctx, 'user.manage') === null)) throw Problems.notFound();
    if (job.requestedBy !== ctx.membershipId) throw Problems.forbidden('Only the person who requested an export can download it.');
    if (job.status !== 'completed' || job.storageKey === null) throw Problems.businessRule('This export has expired. Request a new one.');
    const url = await this.storage.signDownload(job.storageKey, DOWNLOAD_LINK_SECONDS, { downloadName: job.fileName ?? 'export.csv' });
    await tx.updateTable('exportJobs').set({ downloadCount: sql<number>`download_count + 1` }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'export.downloaded', entityType: 'export', entityId: id, metadata: { exportType: job.exportType, rows: job.rowCount } });
    return { url, linkExpiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000).toISOString() };
  }

  /** Marks expired exports and deletes their files (also run by the worker). */
  async expireDue(tx: Tx, ctx: TenantContext): Promise<number> {
    return expireExports(tx, ctx, this.storage, this.audit);
  }

  // ----------------------------------------------------------------- helpers

  private async store(
    tx: Tx,
    ctx: TenantContext,
    exportType: 'contacts' | 'leads',
    parameters: Record<string, unknown>,
    csv: Buffer,
    rowCount: number,
    action: string,
  ): Promise<ExportJobDto> {
    const job = await this.storeFile(tx, ctx, { exportType, format: 'csv', contentType: 'text/csv; charset=utf-8', body: csv, rowCount, parameters });
    await this.audit.record(tx, ctx, {
      action,
      entityType: 'export',
      entityId: job.id,
      metadata: { rows: rowCount, purpose: parameters['purpose'], filters: { ...parameters, purpose: undefined } },
    });
    return job;
  }

  /**
   * Stores a finished file as an export job: written before the job is marked
   * complete, expires after EXPORT_LIFETIME_HOURS, downloadable only by the
   * member who made it (each download audited). The caller audits the creation.
   */
  async storeFile(
    tx: Tx,
    ctx: TenantContext,
    file: { exportType: 'contacts' | 'leads' | 'subject_access'; format: 'csv' | 'json'; contentType: string; body: Buffer; rowCount: number; parameters: Record<string, unknown> },
  ): Promise<ExportJobDto> {
    const job = await tx
      .insertInto('exportJobs')
      .values({ companyId: ctx.companyId, exportType: file.exportType, format: file.format, parameters: JSON.stringify(file.parameters), status: 'running', requestedBy: ctx.membershipId })
      .returning(['id', 'createdAt'])
      .executeTakeFirstOrThrow();
    const stamp = job.createdAt.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const fileName = `${file.exportType.replace('_', '-')}-${stamp}.${file.format}`;
    const storageKey = `exports/${ctx.companyId}/${job.id}.${file.format}`;
    // The file is written before the job is marked complete. If the transaction
    // fails afterwards, no job points at the object, so it can never be
    // downloaded; a storage lifecycle rule on exports/ (deployment checklist)
    // removes such objects.
    await this.storage.write(storageKey, file.body, file.contentType);
    await tx
      .updateTable('exportJobs')
      .set({
        status: 'completed',
        storageKey,
        fileName,
        rowCount: file.rowCount,
        finishedAt: sql<Date>`now()`,
        expiresAt: sql<Date>`now() + make_interval(hours => ${EXPORT_LIFETIME_HOURS})`,
      })
      .where('id', '=', job.id)
      .execute();
    await this.audit.emit(tx, ctx, { eventType: 'export.completed', aggregateType: 'export', aggregateId: job.id, payload: { exportId: job.id, exportType: file.exportType, rows: file.rowCount } });
    return this.get(tx, ctx, job.id);
  }

  private checkSize(rows: number): void {
    if (rows > MAX_EXPORT_ROWS) {
      throw Problems.businessRule(`This export would have more than ${MAX_EXPORT_ROWS.toLocaleString('en')} rows. Narrow it by office, role or date.`);
    }
  }

  private async checkOffice(tx: Tx, ctx: TenantContext, officeId: string | undefined, scope: string): Promise<void> {
    if (officeId === undefined) return;
    const office = await tx.selectFrom('offices').select('id').where('id', '=', officeId).executeTakeFirst();
    if (!office || (scope !== 'all' && !ctx.officeIds.includes(officeId))) {
      throw Problems.validation([{ field: 'officeId', code: 'out-of-scope', message: 'Choose one of your offices.' }]);
    }
  }

  private query(tx: Tx) {
    return tx
      .selectFrom('exportJobs as e')
      .innerJoin('companyMemberships as m', 'm.id', 'e.requestedBy')
      .innerJoin('users as u', 'u.id', 'm.userId')
      .select(['e.id', 'e.exportType', 'e.format', 'e.status', 'e.rowCount', 'e.fileName', 'e.parameters', 'e.requestedBy', 'u.displayName', 'e.createdAt', 'e.expiresAt', 'e.downloadCount']);
  }

  private toDto(ctx: TenantContext, row: Awaited<ReturnType<ReturnType<ExportsService['query']>['executeTakeFirstOrThrow']>>): ExportJobDto {
    return {
      id: row.id,
      exportType: row.exportType,
      format: row.format,
      status: row.status,
      rowCount: row.rowCount,
      fileName: row.fileName,
      parameters: row.parameters as Record<string, unknown>,
      requestedBy: { id: row.requestedBy, name: row.displayName },
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      downloadCount: row.downloadCount,
      canDownload: row.status === 'completed' && row.requestedBy === ctx.membershipId,
    };
  }
}

/** Expires finished exports past their time and deletes the files. */
export async function expireExports(tx: Tx, ctx: TenantContext, storage: StoragePort, audit: AuditService): Promise<number> {
  const expired = await tx
    .updateTable('exportJobs')
    .set({ status: 'expired' })
    .where('status', '=', 'completed')
    .where('expiresAt', '<=', sql<Date>`now()`)
    .returning(['id', 'storageKey', 'exportType'])
    .execute();
  if (expired.length === 0) return 0;
  await storage.remove(expired.map((row) => row.storageKey).filter((key): key is string => key !== null));
  for (const row of expired) {
    await audit.record(tx, ctx, { action: 'export.expired', entityType: 'export', entityId: row.id, metadata: { exportType: row.exportType } });
  }
  return expired.length;
}

/** Exports are for members who may export, those who oversee users (admin dashboard), and access reports' makers. */
function assertExportAccess(ctx: TenantContext): void {
  if (!['contact.export', 'lead.export', 'user.manage', 'privacy.fulfil'].some((permission) => scopeFor(ctx, permission) !== null)) {
    throw Problems.forbidden('Your role does not include exports.');
  }
}

function parseInstant(value: string | undefined, field: string, errors: FieldError[]): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    errors.push({ field, code: 'invalid', message: 'Use a date and time such as 2026-11-01T00:00:00Z.' });
    return null;
  }
  return date;
}
