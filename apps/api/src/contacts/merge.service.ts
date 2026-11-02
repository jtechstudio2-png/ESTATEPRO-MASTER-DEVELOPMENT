import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { SensitiveDataService } from '../crypto/sensitive-data.service.js';
import type { Tx } from '../database/database.module.js';
import { ContactsService } from './contacts.service.js';
import { MERGE_FIELDS, type MergeBody, type MergeField, type MergePreviewDto, type MergeResultDto } from './dto.js';

type ContactRecord = NonNullable<Awaited<ReturnType<MergeService['lock']>>>;

/** Plain columns a person picks between, by API field name. */
const PLAIN_COLUMNS: Partial<Record<MergeField, string>> = {
  displayName: 'displayName',
  displayNameLocal: 'displayNameLocal',
  givenName: 'givenName',
  familyName: 'familyName',
  otherNames: 'otherNames',
  title: 'title',
  organisationName: 'organisationName',
  primaryEmail: 'primaryEmail',
  primaryPhone: 'primaryPhoneE164',
  preferredLocaleCode: 'preferredLocaleCode',
  preferredChannel: 'preferredChannel',
  nationalityCountryCode: 'nationalityCountryCode',
  residenceCountryCode: 'residenceCountryCode',
  officeId: 'officeId',
  ownerMembershipId: 'ownerMembershipId',
  sourceCode: 'sourceCode',
  notes: 'notes',
};

const BLOCKING_TABLE_LABELS: Record<string, string> = {
  contact_payment_accounts: 'payout accounts',
  ledger_entries: 'ledger entries',
  payments: 'receipts',
  payouts: 'payouts',
  statements: 'landlord statements',
  finance_transactions: 'financial transactions',
  supplier_invoices: 'supplier invoices',
  lease_parties: 'leases',
  management_agreements: 'management agreements',
};

/**
 * Contact merge (CRM-02, wireframe C-4). A merge is always an explicit request
 * by a member with contact.merge on both contacts; nothing merges
 * automatically. The person chooses, field by field, which value survives;
 * every reference moves to the kept contact through app.merge_contact_references
 * (migration 0022); financial and contractual records block the merge. The
 * merged contact stays as an archived record pointing to the kept one, so
 * history and audit remain intact.
 */
@Injectable()
export class MergeService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly sensitive: SensitiveDataService,
    private readonly audit: AuditService,
  ) {}

  async preview(tx: Tx, ctx: TenantContext, keepId: string, mergeId: string): Promise<MergePreviewDto> {
    const [keep, merge] = await Promise.all([this.contacts.loadRow(tx, keepId), this.contacts.loadRow(tx, mergeId)]);
    if (!keep || !merge) throw Problems.notFound();
    await this.contacts.assertWrite(tx, ctx, keep, 'contact.merge');
    await this.contacts.assertWrite(tx, ctx, merge, 'contact.merge');
    const [keepDto, mergeDto, keepRefs, mergeRefs, blockers] = await Promise.all([
      this.contacts.toDto(tx, ctx, keep),
      this.contacts.toDto(tx, ctx, merge),
      this.referenceCounts(tx, keepId),
      this.referenceCounts(tx, mergeId),
      this.blockers(tx, keep, merge),
    ]);
    return {
      keep: { contact: keepDto, references: keepRefs },
      merge: { contact: mergeDto, references: mergeRefs },
      blockers,
      choosableFields: [...MERGE_FIELDS],
    };
  }

  async merge(tx: Tx, ctx: TenantContext, keepId: string, expectedKeepVersion: number, body: MergeBody): Promise<MergeResultDto> {
    if (keepId === body.mergeContactId) throw Problems.businessRule('A contact cannot be merged into itself.');
    // Lock in id order so two opposite merges cannot deadlock.
    const [first, second] = [keepId, body.mergeContactId].sort();
    const locked = new Map<string, ContactRecord>();
    for (const id of [first!, second!]) {
      const row = await this.lock(tx, id);
      if (!row) throw Problems.notFound();
      locked.set(id, row);
    }
    const keep = locked.get(keepId)!;
    const merge = locked.get(body.mergeContactId)!;
    await this.contacts.assertWrite(tx, ctx, keep, 'contact.merge');
    await this.contacts.assertWrite(tx, ctx, merge, 'contact.merge');
    if (keep.version !== expectedKeepVersion || merge.version !== Number(body.mergeVersion)) throw Problems.preconditionFailed();

    const blockers = await this.blockers(tx, keep, merge);
    if (blockers.length > 0) throw Problems.businessRule(`These contacts cannot be merged: ${blockers.join(' ')}`);

    const choices = this.validateChoices(body.fields ?? {});
    const patch = await this.chosenValues(tx, ctx, keep, merge, choices);

    const consentsBefore = [...(await this.contacts.currentConsents(tx, keep.id)), ...(await this.contacts.currentConsents(tx, merge.id))];
    const { rows } = await sql<{ moved: Record<string, number> }>`select app.merge_contact_references(${keep.id}::uuid, ${merge.id}::uuid) as moved`.execute(tx);
    const moved = rows[0]?.moved ?? {};

    await tx
      .updateTable('contacts')
      .set({ mergedIntoContactId: keep.id, archivedAt: sql<Date>`now()`, archivedReason: `Merged into ${keep.reference ?? keep.id}`, archivedBy: ctx.system ? null : ctx.membershipId })
      .where('id', '=', merge.id)
      .execute();
    await tx
      .updateTable('contacts')
      .set(Object.keys(patch).length > 0 ? patch : { updatedAt: sql<Date>`now()` })
      .where('id', '=', keep.id)
      .execute();
    const updated = await tx.selectFrom('contacts').select(['primaryEmail', 'primaryPhoneE164']).where('id', '=', keep.id).executeTakeFirstOrThrow();
    await this.contacts.syncPrimaryMethod(tx, ctx, keep.id, 'email', updated.primaryEmail);
    await this.contacts.syncPrimaryMethod(tx, ctx, keep.id, 'mobile', updated.primaryPhoneE164);

    // A withdrawal on either contact stays in force after the merge (wireframe C-4).
    const consentsAfter = await this.contacts.currentConsents(tx, keep.id);
    const reinstated: string[] = [];
    for (const current of consentsAfter) {
      const withdrawn = consentsBefore.find((before) => before.purpose === current.purpose && before.channel === current.channel && before.status === 'withdrawn');
      if (current.status === 'granted' && withdrawn) {
        await this.contacts.insertConsent(
          tx,
          ctx,
          keep.id,
          {
            purpose: current.purpose as 'marketing',
            channel: (current.channel ?? 'any') as 'any',
            status: 'withdrawn',
            capturedVia: 'web_form',
            evidence: `Merge of ${merge.reference ?? merge.id}: withdrawn there on ${withdrawn.capturedAt.slice(0, 10)}`,
          },
          'merge',
        );
        reinstated.push(`${current.purpose}/${current.channel ?? 'any'}`);
      }
    }

    const fieldsFromMerge = Object.entries(choices).filter(([, side]) => side === 'merge').map(([field]) => field);
    await this.audit.record(tx, ctx, {
      action: 'contact.merged',
      entityType: 'contact',
      entityId: keep.id,
      metadata: { mergedContactId: merge.id, mergedReference: merge.reference, fieldsFromMergedContact: fieldsFromMerge, moved, withdrawalsKept: reinstated },
    });
    await this.audit.record(tx, ctx, {
      action: 'contact.merged_into',
      entityType: 'contact',
      entityId: merge.id,
      metadata: { keptContactId: keep.id, keptReference: keep.reference },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'contact.merged',
      aggregateType: 'contact',
      aggregateId: keep.id,
      payload: { keptContactId: keep.id, mergedContactId: merge.id },
    });
    return { contact: await this.contacts.get(tx, ctx, keep.id), moved };
  }

  async lock(tx: Tx, id: string) {
    return tx.selectFrom('contacts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  }

  private async blockers(
    tx: Tx,
    keep: { id: string; contactType: string; mergedIntoContactId: string | null; isAnonymised: boolean; archivedAt: Date | null },
    merge: { id: string; contactType: string; mergedIntoContactId: string | null; isAnonymised: boolean },
  ): Promise<string[]> {
    const reasons: string[] = [];
    if (keep.id === merge.id) reasons.push('A contact cannot be merged into itself.');
    if (keep.mergedIntoContactId !== null || merge.mergedIntoContactId !== null) reasons.push('One of the contacts was already merged into another contact.');
    if (keep.isAnonymised || merge.isAnonymised) reasons.push('Anonymised contacts cannot be merged.');
    if (keep.archivedAt !== null && keep.mergedIntoContactId === null) reasons.push('The contact to keep is archived. Restore it first.');
    if (keep.contactType !== merge.contactType) reasons.push('A person and an organisation cannot be merged.');
    const { rows } = await sql<{ blockers: string[] }>`select app.contact_merge_blockers(${merge.id}::uuid) as blockers`.execute(tx);
    const financial = rows[0]?.blockers ?? [];
    if (financial.length > 0) {
      reasons.push(`The contact to merge has ${financial.map((table) => BLOCKING_TABLE_LABELS[table] ?? table).join(', ')}; financial and contractual records are never moved to another contact.`);
    }
    const portal = await tx
      .selectFrom('companyMemberships')
      .select((eb) => eb.fn.count<string>('contactId').distinct().as('n'))
      .where('contactId', 'in', [keep.id, merge.id])
      .where('status', 'in', ['invited', 'active'])
      .executeTakeFirstOrThrow();
    if (Number(portal.n) > 1) reasons.push('Both contacts have portal access. End one portal membership first.');
    return reasons;
  }

  private validateChoices(fields: Record<string, unknown>): Partial<Record<MergeField, 'keep' | 'merge'>> {
    const errors = Object.entries(fields)
      .filter(([field, side]) => !(MERGE_FIELDS as readonly string[]).includes(field) || (side !== 'keep' && side !== 'merge'))
      .map(([field]) => ({ field: `fields.${field}`, code: 'invalid', message: 'Choose "keep" or "merge" for a known field.' }));
    if (errors.length > 0) throw Problems.validation(errors);
    return fields;
  }

  /** Values to write on the kept contact for the fields taken from the merged one. */
  private async chosenValues(
    tx: Tx,
    ctx: TenantContext,
    keep: ContactRecord,
    merge: ContactRecord,
    choices: Partial<Record<MergeField, 'keep' | 'merge'>>,
  ): Promise<Record<string, unknown>> {
    const patch: Record<string, unknown> = {};
    const isPerson = keep.contactType === 'person';
    for (const [field, side] of Object.entries(choices) as [MergeField, 'keep' | 'merge'][]) {
      if (side !== 'merge') continue;
      const column = PLAIN_COLUMNS[field];
      if (column !== undefined) {
        patch[column] = (merge as Record<string, unknown>)[column];
        continue;
      }
      if (!isPerson) {
        if (field === 'taxNumber') patch['taxNumber'] = merge.taxNumber;
        if (field === 'organisationRegNumber') patch['organisationRegNumber'] = merge.organisationRegNumber;
        continue;
      }
      // Protected values are bound to their row (ADR-007): re-encrypt for the kept contact.
      const reseal = async (column: string, ciphertext: Buffer | null): Promise<Buffer | null> => {
        if (ciphertext === null) return null;
        const value = await this.sensitive.open(tx, ctx, { table: 'contacts', column, rowId: merge.id }, ciphertext);
        return this.sensitive.seal(tx, ctx, { table: 'contacts', column, rowId: keep.id }, value);
      };
      if (field === 'dateOfBirth') patch['dateOfBirthEncrypted'] = await reseal('date_of_birth_encrypted', merge.dateOfBirthEncrypted);
      if (field === 'taxNumber') {
        patch['taxNumberEncrypted'] = await reseal('tax_number_encrypted', merge.taxNumberEncrypted);
        patch['taxNumberHash'] = merge.taxNumberHash;
        patch['taxNumberLast4'] = merge.taxNumberLast4;
      }
      if (field === 'organisationRegNumber') {
        patch['organisationRegNumberEncrypted'] = await reseal('organisation_reg_number_encrypted', merge.organisationRegNumberEncrypted);
      }
    }
    if (patch['displayName'] === null) delete patch['displayName'];
    const emailAfter = 'primaryEmail' in patch ? patch['primaryEmail'] : keep.primaryEmail;
    const phoneAfter = 'primaryPhoneE164' in patch ? patch['primaryPhoneE164'] : keep.primaryPhoneE164;
    if (emailAfter === null && phoneAfter === null) {
      throw Problems.businessRule('The merged contact would have neither a mobile number nor an email address. Keep at least one.');
    }
    if (!isPerson && patch['organisationName'] === null) delete patch['organisationName'];
    return patch;
  }

  private async referenceCounts(tx: Tx, contactId: string): Promise<Record<string, number>> {
    const { rows } = await sql<{ counts: Record<string, number> }>`select app.contact_reference_counts(${contactId}::uuid) as counts`.execute(tx);
    return rows[0]?.counts ?? {};
  }
}
