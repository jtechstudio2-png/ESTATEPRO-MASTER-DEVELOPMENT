import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { keysetCondition, type Page, type ParsedListQuery, sortValueSql, toPage } from '../common/list-query.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { SensitiveDataService } from '../crypto/sensitive-data.service.js';
import type { Tx } from '../database/database.module.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { contactScopeSql, contactWithinScope, scopeFor } from './contact-access.js';
import { assertEditable, ContactsService, effectiveKycStatusSql, newId } from './contacts.service.js';
import { DuplicatesService } from './duplicates.service.js';
import {
  type ApproveKycCheckBody,
  type CreateIdentityDocumentBody,
  type CreateKycCheckBody,
  type IdentityDocumentDto,
  type KycCheckDto,
  type KycQueueItemDto,
  OPEN_CHECK_STATUSES,
  type RejectKycCheckBody,
  type UpdateIdentityDocumentBody,
  type UpdateKycCheckBody,
} from './kyc.dto.js';

interface ContactAccessRow {
  id: string;
  officeId: string | null;
  ownerMembershipId: string | null;
}

/**
 * Identity documents and KYC/AML checks (CRM-09; wireframes C-5 and SE-1).
 * The company performs the regulated check; EstatePro records the evidence,
 * the outcome and who signed it off.
 *
 *   kyc.view     see documents (masked) and checks
 *   kyc.manage   record and correct documents and open checks
 *   kyc.approve  sign a check off as verified or failed
 *
 * Each permission applies in its own scope; for agents ("own") that is the
 * contacts they are responsible for (decision D1 widens contact reading
 * only). Document numbers are encrypted (ADR-007) and matched by keyed hash;
 * revealing one stays with the existing reveal endpoint (contact.view_sensitive
 * and a recent second factor). Signed-off checks and verified documents are
 * evidence: the database refuses changes to them.
 */
@Injectable()
export class KycService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly sensitive: SensitiveDataService,
    private readonly duplicates: DuplicatesService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------ identity documents

  async listDocuments(tx: Tx, ctx: TenantContext, contactId: string, includeArchived: boolean): Promise<IdentityDocumentDto[]> {
    const contact = await this.contactFor(tx, ctx, contactId, 'kyc.view');
    const rows = await this.documentQuery(tx)
      .where('d.contactId', '=', contactId)
      .$if(!includeArchived, (qb) => qb.where('d.archivedAt', 'is', null))
      .orderBy('d.createdAt', 'desc')
      .orderBy('d.id', 'desc')
      .execute();
    return rows.map((row) => this.toDocumentDto(ctx, contact, row));
  }

  async addDocument(tx: Tx, ctx: TenantContext, contactId: string, body: CreateIdentityDocumentBody): Promise<IdentityDocumentDto> {
    const contact = await this.editableContact(tx, ctx, contactId, 'kyc.manage');
    const errors: FieldError[] = [];
    await this.checkDocumentFields(tx, body.documentTypeCode, body.issuingCountryCode, body.issuedOn ?? null, body.expiresOn ?? null, body.documentNumber, errors);
    if (errors.length > 0) throw Problems.validation(errors);

    const id = await newId(tx);
    const protectedNumber = await this.sensitive.protectIdentifier(
      tx,
      ctx,
      { table: 'identity_documents', column: 'number_encrypted', rowId: id },
      'identity_number',
      body.documentNumber,
    );
    const confirmed = await this.checkDuplicates(tx, ctx, contactId, protectedNumber.hash, null, body.confirmNotDuplicate === true);
    await tx
      .insertInto('identityDocuments')
      .values({
        id,
        companyId: ctx.companyId,
        contactId,
        documentTypeCode: body.documentTypeCode,
        issuingCountryCode: body.issuingCountryCode,
        numberEncrypted: protectedNumber.encrypted,
        numberHash: protectedNumber.hash,
        numberLast4: protectedNumber.last4,
        issuedOn: body.issuedOn ?? null,
        expiresOn: body.expiresOn ?? null,
        createdBy: ctx.membershipId,
      })
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'contact.identity_document_added',
      entityType: 'contact',
      entityId: contactId,
      metadata: {
        identityDocumentId: id,
        documentTypeCode: body.documentTypeCode,
        issuingCountryCode: body.issuingCountryCode,
        ...(confirmed.length > 0 ? { duplicateConfirmed: confirmed } : {}),
      },
    });
    return this.document(tx, ctx, contact, id);
  }

  async updateDocument(
    tx: Tx,
    ctx: TenantContext,
    contactId: string,
    documentId: string,
    expectedVersion: number,
    body: UpdateIdentityDocumentBody,
  ): Promise<IdentityDocumentDto> {
    const contact = await this.editableContact(tx, ctx, contactId, 'kyc.manage');
    const current = await tx
      .selectFrom('identityDocuments')
      .selectAll()
      .where('id', '=', documentId)
      .where('contactId', '=', contactId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw Problems.notFound();
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.verifiedAt !== null) {
      throw Problems.businessRule('This document is verified and cannot be changed. Archive it and record the new document instead.');
    }
    if (current.archivedAt !== null) throw Problems.businessRule('Archived documents cannot be changed.');

    const next = {
      documentTypeCode: body.documentTypeCode ?? current.documentTypeCode,
      issuingCountryCode: body.issuingCountryCode ?? current.issuingCountryCode,
      issuedOn: body.issuedOn === undefined ? current.issuedOn : body.issuedOn,
      expiresOn: body.expiresOn === undefined ? current.expiresOn : body.expiresOn,
    };
    const errors: FieldError[] = [];
    await this.checkDocumentFields(tx, next.documentTypeCode, next.issuingCountryCode, next.issuedOn, next.expiresOn, body.documentNumber ?? null, errors);
    if (errors.length > 0) throw Problems.validation(errors);

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const key of ['documentTypeCode', 'issuingCountryCode', 'issuedOn', 'expiresOn'] as const) {
      if (next[key] !== current[key]) changes[key] = { old: current[key], new: next[key] };
    }
    let numberColumns = {};
    let confirmed: string[] = [];
    if (body.documentNumber !== undefined) {
      const protectedNumber = await this.sensitive.protectIdentifier(
        tx,
        ctx,
        { table: 'identity_documents', column: 'number_encrypted', rowId: documentId },
        'identity_number',
        body.documentNumber,
      );
      if (!protectedNumber.hash.equals(current.numberHash)) {
        confirmed = await this.checkDuplicates(tx, ctx, contactId, protectedNumber.hash, documentId, body.confirmNotDuplicate === true);
        numberColumns = { numberEncrypted: protectedNumber.encrypted, numberHash: protectedNumber.hash, numberLast4: protectedNumber.last4 };
        changes['documentNumber'] = { old: '[protected]', new: '[protected]' };
      }
    }
    if (Object.keys(changes).length === 0) return this.document(tx, ctx, contact, documentId);
    await tx.updateTable('identityDocuments').set({ ...next, ...numberColumns }).where('id', '=', documentId).execute();
    await this.audit.record(tx, ctx, {
      action: 'contact.identity_document_updated',
      entityType: 'contact',
      entityId: contactId,
      metadata: { identityDocumentId: documentId, changes, ...(confirmed.length > 0 ? { duplicateConfirmed: confirmed } : {}) },
    });
    return this.document(tx, ctx, contact, documentId);
  }

  async archiveDocument(tx: Tx, ctx: TenantContext, contactId: string, documentId: string, expectedVersion: number, reason: string): Promise<IdentityDocumentDto> {
    const contact = await this.editableContact(tx, ctx, contactId, 'kyc.manage');
    const current = await tx
      .selectFrom('identityDocuments')
      .select(['id', 'version', 'archivedAt'])
      .where('id', '=', documentId)
      .where('contactId', '=', contactId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw Problems.notFound();
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.archivedAt !== null) throw Problems.businessRule('This document is already archived.');
    const openChecks = await tx
      .selectFrom('kycChecks')
      .select('id')
      .where('identityDocumentId', '=', documentId)
      .where('status', 'in', ['pending', 'in_review'])
      .executeTakeFirst();
    if (openChecks) throw Problems.businessRule('An open check uses this document. Sign the check off or change its document first.');
    await tx
      .updateTable('identityDocuments')
      .set({ archivedAt: sql<Date>`now()`, archivedBy: ctx.membershipId, archivedReason: reason })
      .where('id', '=', documentId)
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'contact.identity_document_archived',
      entityType: 'contact',
      entityId: contactId,
      metadata: { identityDocumentId: documentId, reason },
    });
    return this.document(tx, ctx, contact, documentId);
  }

  // ------------------------------------------------------------- KYC checks

  async listChecks(tx: Tx, ctx: TenantContext, contactId: string): Promise<KycCheckDto[]> {
    const contact = await this.contactFor(tx, ctx, contactId, 'kyc.view');
    const rows = await this.checkQuery(tx).where('k.contactId', '=', contactId).orderBy('k.createdAt', 'desc').orderBy('k.id', 'desc').execute();
    return rows.map((row) => this.toCheckDto(ctx, contact, row));
  }

  /**
   * The company-wide identity-check queue (SH-1 "Identity checks", C6): open
   * checks by default, oldest first, for contacts within the member's
   * `kyc.view` scope (ownership and offices, never through a lead). Only the
   * last four characters of a document number appear, as on the record.
   */
  async queue(tx: Tx, ctx: TenantContext, query: ParsedListQuery<'createdAt'>): Promise<Page<KycQueueItemDto>> {
    const scope = scopeFor(ctx, 'kyc.view');
    if (scope === null) throw Problems.forbidden();
    const f = query.filters;
    let qb = this.checkQuery(tx)
      .innerJoin('contacts as c', (join) => join.onRef('c.companyId', '=', 'k.companyId').onRef('c.id', '=', 'k.contactId'))
      .select(['c.id as contactId', 'c.displayName as contactName', 'c.reference as contactReference', 'c.officeId as contactOfficeId', 'c.ownerMembershipId as contactOwnerId'])
      .select(sortValueSql('k.createdAt', 'timestamp').as('cursorValue'))
      .where('c.mergedIntoContactId', 'is', null)
      .where('c.archivedAt', 'is', null)
      .where(contactScopeSql(scope, ctx, 'c', 'write'));
    const statuses = Array.isArray(f['status']) ? f['status'] : f['expiring'] === true ? ['verified'] : [...OPEN_CHECK_STATUSES];
    qb = qb.where(sql<boolean>`${effectiveKycStatusSql('k')} = any(${statuses}::text[])`);
    if (Array.isArray(f['checkType'])) qb = qb.where('k.checkType', 'in', f['checkType']);
    // Verified checks due for renewal within 30 days (the admin dashboard's figure).
    if (f['expiring'] === true) qb = qb.where(sql<boolean>`k.expires_on between current_date and current_date + 30`);
    if (query.cursor) qb = qb.where(keysetCondition('k.createdAt', 'k.id', query.sort, query.cursor));
    const rows = await qb.orderBy('k.createdAt', query.sort.direction).orderBy('k.id', query.sort.direction).limit(query.limit + 1).execute();
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => ({
      ...this.toCheckDto(ctx, { id: row.contactId, officeId: row.contactOfficeId, ownerMembershipId: row.contactOwnerId }, row),
      contact: { id: row.contactId, name: row.contactName, reference: row.contactReference },
    }));
  }

  async recordCheck(tx: Tx, ctx: TenantContext, contactId: string, body: CreateKycCheckBody): Promise<KycCheckDto> {
    const contact = await this.editableContact(tx, ctx, contactId, 'kyc.manage');
    const errors: FieldError[] = [];
    if (body.identityDocumentId) await this.checkUsableDocument(tx, contactId, body.identityDocumentId, errors);
    if (body.expiresOn && !isRealDate(body.expiresOn)) errors.push({ field: 'expiresOn', code: 'invalid', message: 'Enter a real date.' });
    if (errors.length > 0) throw Problems.validation(errors);
    const inserted = await tx
      .insertInto('kycChecks')
      .values({
        companyId: ctx.companyId,
        contactId,
        checkType: body.checkType,
        status: body.status ?? 'pending',
        identityDocumentId: body.identityDocumentId ?? null,
        provider: body.provider ?? null,
        providerReference: body.providerReference ?? null,
        riskRating: body.riskRating ?? null,
        expiresOn: body.expiresOn ?? null,
        notes: emptyToNull(body.notes),
        recordedBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'kyc.check_recorded',
      entityType: 'contact',
      entityId: contactId,
      metadata: { kycCheckId: inserted.id, checkType: body.checkType, status: body.status ?? 'pending', identityDocumentId: body.identityDocumentId ?? null },
    });
    return this.check(tx, ctx, contact, inserted.id);
  }

  async updateCheck(tx: Tx, ctx: TenantContext, contactId: string, checkId: string, expectedVersion: number, body: UpdateKycCheckBody): Promise<KycCheckDto> {
    const contact = await this.editableContact(tx, ctx, contactId, 'kyc.manage');
    const current = await this.lockOpenCheck(tx, contactId, checkId, expectedVersion);
    const errors: FieldError[] = [];
    if (body.identityDocumentId) await this.checkUsableDocument(tx, contactId, body.identityDocumentId, errors);
    if (body.expiresOn && !isRealDate(body.expiresOn)) errors.push({ field: 'expiresOn', code: 'invalid', message: 'Enter a real date.' });
    if (errors.length > 0) throw Problems.validation(errors);
    const next = {
      status: body.status ?? current.status,
      identityDocumentId: body.identityDocumentId === undefined ? current.identityDocumentId : body.identityDocumentId,
      provider: body.provider === undefined ? current.provider : body.provider,
      providerReference: body.providerReference === undefined ? current.providerReference : body.providerReference,
      riskRating: body.riskRating === undefined ? current.riskRating : body.riskRating,
      expiresOn: body.expiresOn === undefined ? current.expiresOn : body.expiresOn,
      notes: body.notes === undefined ? current.notes : emptyToNull(body.notes),
    };
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (next[key] !== current[key]) changes[key] = { old: current[key], new: next[key] };
    }
    if (Object.keys(changes).length === 0) return this.check(tx, ctx, contact, checkId);
    await tx.updateTable('kycChecks').set(next).where('id', '=', checkId).execute();
    await this.audit.record(tx, ctx, { action: 'kyc.check_updated', entityType: 'contact', entityId: contactId, metadata: { kycCheckId: checkId, changes } });
    return this.check(tx, ctx, contact, checkId);
  }

  /** Signs a check off as verified (kyc.approve). A verified identity check also verifies its document. */
  async approveCheck(tx: Tx, ctx: TenantContext, contactId: string, checkId: string, expectedVersion: number, body: ApproveKycCheckBody): Promise<KycCheckDto> {
    const contact = await this.editableContact(tx, ctx, contactId, 'kyc.approve');
    const current = await this.lockOpenCheck(tx, contactId, checkId, expectedVersion);
    const errors: FieldError[] = [];
    const expiresOn = body.expiresOn === undefined ? current.expiresOn : body.expiresOn;
    if (expiresOn !== null && (!isRealDate(expiresOn) || expiresOn <= (await today(tx)))) {
      errors.push({ field: 'expiresOn', code: 'in-past', message: 'A verified check must be valid for at least one more day.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);
    if (current.identityDocumentId !== null) {
      const document = await tx
        .selectFrom('identityDocuments')
        .select(['id', 'archivedAt', 'verifiedAt', sql<boolean>`expires_on is not null and expires_on < current_date`.as('expired')])
        .where('id', '=', current.identityDocumentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (document.archivedAt !== null) throw Problems.businessRule('The document for this check is archived. Choose a current document first.');
      if (document.expired) throw Problems.businessRule('The document for this check has expired. Record a current document first.');
      if (current.checkType === 'identity' && document.verifiedAt === null) {
        await tx.updateTable('identityDocuments').set({ verifiedAt: sql<Date>`now()`, verifiedBy: ctx.membershipId }).where('id', '=', document.id).execute();
      }
    }
    await tx
      .updateTable('kycChecks')
      .set({
        status: 'verified',
        riskRating: body.riskRating,
        expiresOn,
        decisionReason: body.reason ?? null,
        reviewedBy: ctx.membershipId,
        reviewedAt: sql<Date>`now()`,
      })
      .where('id', '=', checkId)
      .execute();
    await this.recordDecision(tx, ctx, contactId, current, 'verified', body.riskRating, body.reason ?? null);
    return this.check(tx, ctx, contact, checkId);
  }

  /** Signs a check off as failed, with the reviewer's reason (kyc.approve). */
  async rejectCheck(tx: Tx, ctx: TenantContext, contactId: string, checkId: string, expectedVersion: number, body: RejectKycCheckBody): Promise<KycCheckDto> {
    const contact = await this.editableContact(tx, ctx, contactId, 'kyc.approve');
    const current = await this.lockOpenCheck(tx, contactId, checkId, expectedVersion);
    const riskRating = body.riskRating === undefined ? current.riskRating : body.riskRating;
    await tx
      .updateTable('kycChecks')
      .set({ status: 'failed', riskRating, decisionReason: body.reason, reviewedBy: ctx.membershipId, reviewedAt: sql<Date>`now()` })
      .where('id', '=', checkId)
      .execute();
    await this.recordDecision(tx, ctx, contactId, current, 'failed', riskRating, body.reason);
    return this.check(tx, ctx, contact, checkId);
  }

  // ----------------------------------------------------------------- helpers

  private async recordDecision(
    tx: Tx,
    ctx: TenantContext,
    contactId: string,
    check: { id: string; checkType: string; recordedBy: string | null; identityDocumentId: string | null },
    outcome: 'verified' | 'failed',
    riskRating: string | null,
    reason: string | null,
  ): Promise<void> {
    await this.audit.record(tx, ctx, {
      action: outcome === 'verified' ? 'kyc.check_verified' : 'kyc.check_failed',
      entityType: 'contact',
      entityId: contactId,
      metadata: {
        kycCheckId: check.id,
        checkType: check.checkType,
        riskRating,
        reason,
        identityDocumentId: check.identityDocumentId,
        // Decision C2-D4: the same person may record and sign off; the audit shows when they did.
        reviewerRecordedCheck: check.recordedBy === ctx.membershipId,
      },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'kyc.check_decided',
      aggregateType: 'contact',
      aggregateId: contactId,
      payload: { contactId, kycCheckId: check.id, checkType: check.checkType, outcome },
    });
  }

  /** Contact readable by the member (404) and within the permission's scope (403). */
  private async contactFor(tx: Tx, ctx: TenantContext, contactId: string, permission: string): Promise<ContactAccessRow> {
    const contact = await this.contacts.loadRow(tx, contactId);
    if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) throw Problems.notFound();
    if (!allows(ctx, permission, contact)) throw Problems.forbidden();
    return contact;
  }

  private async editableContact(tx: Tx, ctx: TenantContext, contactId: string, permission: string): Promise<ContactAccessRow> {
    const contact = await tx.selectFrom('contacts').selectAll().where('id', '=', contactId).forUpdate().executeTakeFirst();
    if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) throw Problems.notFound();
    if (!allows(ctx, permission, contact)) throw Problems.forbidden();
    assertEditable(contact);
    return contact;
  }

  private async lockOpenCheck(tx: Tx, contactId: string, checkId: string, expectedVersion: number) {
    const current = await tx.selectFrom('kycChecks').selectAll().where('id', '=', checkId).where('contactId', '=', contactId).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.status !== 'pending' && current.status !== 'in_review') {
      throw Problems.businessRule('This check is signed off and cannot be changed. Record a new check instead.');
    }
    return current;
  }

  private async checkDocumentFields(
    tx: Tx,
    typeCode: string,
    countryCode: string,
    issuedOn: string | null,
    expiresOn: string | null,
    number: string | null,
    errors: FieldError[],
  ): Promise<void> {
    const country = await tx.selectFrom('countries').select('code').where('code', '=', countryCode).executeTakeFirst();
    if (!country) {
      errors.push({ field: 'issuingCountryCode', code: 'unknown-code', message: 'Choose the country that issued the document.' });
    } else {
      const error = await checkPicklistCode(tx, 'id_document_type', typeCode, countryCode, 'documentTypeCode');
      if (error) errors.push({ ...error, message: 'This document type is not issued in that country.' });
    }
    if (number !== null && number.replace(/[\s\-./_]/g, '').length < 3) {
      errors.push({ field: 'documentNumber', code: 'too-short', message: 'Enter the full document number.' });
    }
    const now = await today(tx);
    if (issuedOn !== null && (!isRealDate(issuedOn) || issuedOn > now)) {
      errors.push({ field: 'issuedOn', code: 'invalid', message: 'Enter the real issue date, not in the future.' });
    }
    if (expiresOn !== null && !isRealDate(expiresOn)) errors.push({ field: 'expiresOn', code: 'invalid', message: 'Enter a real date.' });
    if (issuedOn !== null && expiresOn !== null && expiresOn <= issuedOn) {
      errors.push({ field: 'expiresOn', code: 'range', message: 'The expiry date must be after the issue date.' });
    }
  }

  /**
   * The same number on this contact is refused; on other contacts it is a
   * possible duplicate person, reported (never merged) unless confirmed.
   * Returns the ids of confirmed candidates for the audit entry.
   */
  private async checkDuplicates(
    tx: Tx,
    ctx: TenantContext,
    contactId: string,
    hash: Buffer,
    ignoreDocumentId: string | null,
    confirmNotDuplicate: boolean,
  ): Promise<string[]> {
    const sameContact = await tx
      .selectFrom('identityDocuments')
      .select('id')
      .where('contactId', '=', contactId)
      .where('numberHash', '=', hash)
      .where('archivedAt', 'is', null)
      .$if(ignoreDocumentId !== null, (qb) => qb.where('id', '<>', ignoreDocumentId!))
      .executeTakeFirst();
    if (sameContact) throw Problems.conflict('This document number is already recorded for this contact.');
    const candidates = await this.duplicates.find(tx, ctx, { email: null, phone: null, taxNumber: null, identityNumberHash: hash }, contactId);
    if (candidates.length > 0 && !confirmNotDuplicate) throw Problems.possibleDuplicates(candidates);
    return candidates.filter((candidate) => candidate.visible).map((candidate) => candidate.id!);
  }

  private async checkUsableDocument(tx: Tx, contactId: string, documentId: string, errors: FieldError[]): Promise<void> {
    const document = await tx
      .selectFrom('identityDocuments')
      .select(['id', 'archivedAt'])
      .where('id', '=', documentId)
      .where('contactId', '=', contactId)
      .executeTakeFirst();
    if (!document) errors.push({ field: 'identityDocumentId', code: 'not-found', message: 'Choose one of this contact’s documents.' });
    else if (document.archivedAt !== null) errors.push({ field: 'identityDocumentId', code: 'archived', message: 'This document is archived.' });
  }

  private documentQuery(tx: Tx) {
    return tx
      .selectFrom('identityDocuments as d')
      .leftJoin('companyMemberships as vm', 'vm.id', 'd.verifiedBy')
      .leftJoin('users as vu', 'vu.id', 'vm.userId')
      .select([
        'd.id',
        'd.documentTypeCode',
        'd.issuingCountryCode',
        'd.numberLast4',
        'd.issuedOn',
        'd.expiresOn',
        'd.verifiedAt',
        'd.verifiedBy',
        'vu.displayName as verifiedByName',
        'd.archivedAt',
        'd.archivedReason',
        'd.createdAt',
        'd.version',
        sql<boolean>`d.expires_on is not null and d.expires_on < current_date`.as('expired'),
      ]);
  }

  private async document(tx: Tx, ctx: TenantContext, contact: ContactAccessRow, documentId: string): Promise<IdentityDocumentDto> {
    const row = await this.documentQuery(tx).where('d.id', '=', documentId).executeTakeFirstOrThrow();
    return this.toDocumentDto(ctx, contact, row);
  }

  private toDocumentDto(ctx: TenantContext, contact: ContactAccessRow, row: DocumentRow): IdentityDocumentDto {
    return {
      id: row.id,
      documentTypeCode: row.documentTypeCode,
      issuingCountryCode: row.issuingCountryCode,
      numberLast4: row.numberLast4,
      issuedOn: row.issuedOn,
      expiresOn: row.expiresOn,
      expired: row.expired,
      verified: row.verifiedAt !== null && row.verifiedBy !== null ? { at: row.verifiedAt.toISOString(), by: { id: row.verifiedBy, name: row.verifiedByName ?? '' } } : null,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      archivedReason: row.archivedReason,
      canEdit: allows(ctx, 'kyc.manage', contact) && row.verifiedAt === null && row.archivedAt === null,
      canReveal: allows(ctx, 'contact.view_sensitive', contact),
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  private checkQuery(tx: Tx) {
    return tx
      .selectFrom('kycChecks as k')
      .leftJoin('identityDocuments as d', 'd.id', 'k.identityDocumentId')
      .leftJoin('companyMemberships as rm', 'rm.id', 'k.recordedBy')
      .leftJoin('users as ru', 'ru.id', 'rm.userId')
      .leftJoin('companyMemberships as vm', 'vm.id', 'k.reviewedBy')
      .leftJoin('users as vu', 'vu.id', 'vm.userId')
      .select([
        'k.id',
        'k.checkType',
        'k.status as storedStatus',
        effectiveKycStatusSql('k').as('status'),
        'k.riskRating',
        'k.provider',
        'k.providerReference',
        'k.identityDocumentId',
        'd.documentTypeCode',
        'd.numberLast4',
        'k.recordedBy',
        'ru.displayName as recordedByName',
        'k.reviewedBy',
        'vu.displayName as reviewedByName',
        'k.reviewedAt',
        'k.expiresOn',
        'k.notes',
        'k.decisionReason',
        'k.createdAt',
        'k.updatedAt',
        'k.version',
      ]);
  }

  private async check(tx: Tx, ctx: TenantContext, contact: ContactAccessRow, checkId: string): Promise<KycCheckDto> {
    const row = await this.checkQuery(tx).where('k.id', '=', checkId).executeTakeFirstOrThrow();
    return this.toCheckDto(ctx, contact, row);
  }

  private toCheckDto(ctx: TenantContext, contact: ContactAccessRow, row: CheckRow): KycCheckDto {
    const open = row.storedStatus === 'pending' || row.storedStatus === 'in_review';
    return {
      id: row.id,
      checkType: row.checkType,
      status: row.status,
      riskRating: row.riskRating,
      provider: row.provider,
      providerReference: row.providerReference,
      identityDocument:
        row.identityDocumentId !== null ? { id: row.identityDocumentId, documentTypeCode: row.documentTypeCode ?? '', numberLast4: row.numberLast4 ?? '' } : null,
      recordedBy: row.recordedBy !== null ? { id: row.recordedBy, name: row.recordedByName ?? '' } : null,
      reviewedBy: row.reviewedBy !== null ? { id: row.reviewedBy, name: row.reviewedByName ?? '' } : null,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      expiresOn: row.expiresOn,
      notes: row.notes,
      decisionReason: row.decisionReason,
      canEdit: open && allows(ctx, 'kyc.manage', contact),
      canDecide: open && allows(ctx, 'kyc.approve', contact),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }
}

type DocumentRow = Awaited<ReturnType<ReturnType<KycService['documentQuery']>['executeTakeFirstOrThrow']>>;
type CheckRow = Awaited<ReturnType<ReturnType<KycService['checkQuery']>['executeTakeFirstOrThrow']>>;

function allows(ctx: TenantContext, permission: string, contact: ContactAccessRow): boolean {
  const scope = scopeFor(ctx, permission);
  return scope !== null && contactWithinScope(scope, ctx, contact);
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function today(tx: Tx): Promise<string> {
  const { rows } = await sql<{ today: string }>`select current_date::text as today`.execute(tx);
  return rows[0]!.today;
}
