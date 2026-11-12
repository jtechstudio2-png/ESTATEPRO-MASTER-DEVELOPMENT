import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import { SensitiveDataService } from '../crypto/sensitive-data.service.js';
import { REVEALABLE_CONTACT_FIELDS, type RevealableContactField } from '../crypto/sensitive-fields.js';
import type { Tx } from '../database/database.module.js';
import { contactWithinScope } from './contact-access.js';

export interface RevealRequest {
  scope: PermissionScope;
  reason: string;
  /** When the member last authenticated with a second factor (step-up), for the audit log. */
  stepUpAt: Date;
}

/**
 * Reveals one protected value of one contact (ADR-007 §9). The reveal and its
 * audit entry happen in one transaction: if the audit entry cannot be written,
 * nothing is revealed. The audit entry never contains the value.
 */
@Injectable()
export class ContactSensitiveService {
  constructor(
    private readonly sensitive: SensitiveDataService,
    private readonly audit: AuditService,
  ) {}

  async revealContactField(tx: Tx, ctx: TenantContext, contactId: string, field: RevealableContactField, request: RevealRequest): Promise<string> {
    const column = REVEALABLE_CONTACT_FIELDS[field];
    const contact = await tx
      .selectFrom('contacts')
      .select(['id', 'officeId', 'ownerMembershipId', 'isAnonymised', 'dateOfBirthEncrypted', 'taxNumberEncrypted', 'organisationRegNumberEncrypted'])
      .where('id', '=', contactId)
      .executeTakeFirst();
    if (!contact) throw Problems.notFound();
    if (!contactWithinScope(request.scope, ctx, contact)) throw Problems.forbidden();
    if (contact.isAnonymised) throw Problems.notFound('This contact has been anonymised. No protected details are kept.');

    const ciphertext = {
      date_of_birth_encrypted: contact.dateOfBirthEncrypted,
      tax_number_encrypted: contact.taxNumberEncrypted,
      organisation_reg_number_encrypted: contact.organisationRegNumberEncrypted,
    }[column];
    if (ciphertext === null) throw Problems.notFound('No value is recorded for this detail.');

    const value = await this.sensitive.open(tx, ctx, { table: 'contacts', column, rowId: contact.id }, ciphertext);
    await this.recordReveal(tx, ctx, contact.id, field, request, {});
    return value;
  }

  async revealIdentityDocumentNumber(tx: Tx, ctx: TenantContext, contactId: string, documentId: string, request: RevealRequest): Promise<string> {
    const document = await tx
      .selectFrom('identityDocuments as d')
      .innerJoin('contacts as c', (join) => join.onRef('c.companyId', '=', 'd.companyId').onRef('c.id', '=', 'd.contactId'))
      .select(['d.id', 'd.numberEncrypted', 'c.id as contactId', 'c.officeId', 'c.ownerMembershipId', 'c.isAnonymised'])
      .where('d.id', '=', documentId)
      .where('d.contactId', '=', contactId)
      .executeTakeFirst();
    if (!document) throw Problems.notFound();
    if (!contactWithinScope(request.scope, ctx, document)) throw Problems.forbidden();
    if (document.isAnonymised || document.numberEncrypted === null) throw Problems.notFound('This contact has been anonymised. No protected details are kept.');

    const value = await this.sensitive.open(tx, ctx, { table: 'identity_documents', column: 'number_encrypted', rowId: document.id }, document.numberEncrypted);
    await this.recordReveal(tx, ctx, document.contactId, 'documentNumber', request, { identityDocumentId: document.id });
    return value;
  }

  private async recordReveal(
    tx: Tx,
    ctx: TenantContext,
    contactId: string,
    field: string,
    request: RevealRequest,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(tx, ctx, {
      action: 'contact.sensitive_revealed',
      entityType: 'contact',
      entityId: contactId,
      metadata: { field, reason: request.reason, stepUpAt: request.stepUpAt.toISOString(), ...extra },
    });
  }
}
