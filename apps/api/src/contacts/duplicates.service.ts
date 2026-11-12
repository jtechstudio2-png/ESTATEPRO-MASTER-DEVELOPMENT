import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { SensitiveDataService } from '../crypto/sensitive-data.service.js';
import type { Tx } from '../database/database.module.js';
import { contactScopeSql, scopeFor } from './contact-access.js';
import type { DuplicateCandidateDto, DuplicateCheckBody } from './dto.js';
import { isEmail, normaliseEmail, normalisePhone, PHONE_METHOD_TYPES } from './identifiers.js';

export interface DuplicateKeys {
  /** Normalised (lower-case) email. */
  email: string | null;
  /** E.164 phone number. */
  phone: string | null;
  /** Plain tax number of a person; matched by keyed hash, never stored here. */
  taxNumber: string | null;
  /** Keyed hash of an identity document number (identity documents, C2). */
  identityNumberHash?: Buffer | null;
}

const MAX_CANDIDATES = 10;

/**
 * Duplicate detection (CRM-02, wireframe C-3). Matches on normalised email,
 * E.164 phone (primary or any phone method) and the keyed hash of a person's
 * tax number. Only reports candidates: merging is always a separate, explicit
 * request by a person (C-4). Candidates outside the member's read scope are
 * reported without any detail, so the check never discloses other people's
 * contacts.
 */
@Injectable()
export class DuplicatesService {
  constructor(
    private readonly sensitive: SensitiveDataService,
    private readonly audit: AuditService,
  ) {}

  async find(tx: Tx, ctx: TenantContext, keys: DuplicateKeys, excludeContactId?: string): Promise<DuplicateCandidateDto[]> {
    const taxHash = keys.taxNumber ? await this.sensitive.hash(tx, ctx, 'tax_number', keys.taxNumber) : null;
    const identityHash = keys.identityNumberHash ?? null;
    if (keys.email === null && keys.phone === null && taxHash === null && identityHash === null) return [];
    const scope = scopeFor(ctx, 'contact.view');
    const visibleSql = scope === null ? sql<boolean>`false` : contactScopeSql(scope, ctx, 'c', 'read');
    const phoneTypes = [...PHONE_METHOD_TYPES];

    const rows = await tx
      .selectFrom('contacts as c')
      .leftJoin('companyMemberships as m', (join) => join.onRef('m.companyId', '=', 'c.companyId').onRef('m.id', '=', 'c.ownerMembershipId'))
      .leftJoin('users as u', 'u.id', 'm.userId')
      .select([
        'c.id',
        'c.reference',
        'c.displayName',
        'c.archivedAt',
        'u.displayName as ownerName',
        visibleSql.as('visible'),
        sql<boolean>`${keys.email !== null} and (c.primary_email = ${keys.email}::citext or exists (
            select 1 from contact_methods cm where cm.company_id = c.company_id and cm.contact_id = c.id
               and cm.method_type = 'email' and cm.normalised = ${keys.email}))`.as('matchEmail'),
        sql<boolean>`${keys.phone !== null} and (c.primary_phone_e164 = ${keys.phone} or exists (
            select 1 from contact_methods cm where cm.company_id = c.company_id and cm.contact_id = c.id
               and cm.method_type = any(${phoneTypes}::text[]) and cm.normalised = ${keys.phone}))`.as('matchPhone'),
        sql<boolean>`${taxHash !== null} and c.tax_number_hash = ${taxHash}`.as('matchTax'),
        sql<boolean>`${identityHash !== null} and exists (select 1 from identity_documents d where d.company_id = c.company_id
            and d.contact_id = c.id and d.number_hash = ${identityHash} and d.archived_at is null)`.as('matchIdentity'),
      ])
      .where('c.mergedIntoContactId', 'is', null)
      .where('c.isAnonymised', '=', false)
      .$if(excludeContactId !== undefined, (qb) => qb.where('c.id', '<>', excludeContactId!))
      // Candidate ids from indexed lookups only; match flags are then computed for at most ten rows.
      .where(sql<boolean>`c.id in (${sql.join(this.candidateArms(ctx, keys.email, keys.phone, taxHash, identityHash, phoneTypes), sql` union `)})`)
      .orderBy('c.archivedAt', 'desc')
      .orderBy('c.updatedAt', 'desc')
      .limit(MAX_CANDIDATES)
      .execute();

    return rows.map((row) => {
      const matchedOn = [
        row.matchEmail ? 'email' : null,
        row.matchPhone ? 'phone' : null,
        row.matchTax ? 'tax_number' : null,
        row.matchIdentity ? 'identity_document' : null,
      ].filter(
        (value): value is string => value !== null,
      );
      return row.visible
        ? { visible: true, id: row.id, reference: row.reference, displayName: row.displayName, ownerName: row.ownerName, archived: row.archivedAt !== null, matchedOn }
        : { visible: false, id: null, reference: null, displayName: null, ownerName: null, archived: false, matchedOn };
    });
  }

  private candidateArms(ctx: TenantContext, email: string | null, phone: string | null, taxHash: Buffer | null, identityHash: Buffer | null, phoneTypes: string[]) {
    const company = ctx.companyId;
    const arms = [];
    if (email !== null) {
      arms.push(sql`select id from contacts where company_id = ${company}::uuid and primary_email = ${email}::citext`);
      arms.push(sql`select contact_id from contact_methods where company_id = ${company}::uuid and method_type = 'email' and normalised = ${email}`);
    }
    if (phone !== null) {
      arms.push(sql`select id from contacts where company_id = ${company}::uuid and primary_phone_e164 = ${phone}`);
      arms.push(sql`select contact_id from contact_methods where company_id = ${company}::uuid and method_type = any(${phoneTypes}::text[]) and normalised = ${phone}`);
    }
    if (taxHash !== null) arms.push(sql`select id from contacts where company_id = ${company}::uuid and tax_number_hash = ${taxHash}`);
    if (identityHash !== null) {
      arms.push(sql`select contact_id from identity_documents where company_id = ${company}::uuid and number_hash = ${identityHash} and archived_at is null`);
    }
    return arms;
  }

  /** The duplicate-check endpoint (wireframe C-3): normalises input, finds candidates, audits the check without its values. */
  async check(tx: Tx, ctx: TenantContext, body: DuplicateCheckBody): Promise<DuplicateCandidateDto[]> {
    const errors: FieldError[] = [];
    let email: string | null = null;
    let phone: string | null = null;
    if (body.primaryEmail) {
      if (isEmail(body.primaryEmail)) email = normaliseEmail(body.primaryEmail);
      else errors.push({ field: 'primaryEmail', code: 'invalid', message: 'Enter an email address like name@example.com.' });
    }
    if (body.primaryPhone) {
      phone = normalisePhone(body.primaryPhone, await this.callingCode(tx, ctx, body.officeId ?? null));
      if (phone === null) errors.push({ field: 'primaryPhone', code: 'invalid', message: 'Enter a phone number, with the country code if it is from another country.' });
    }
    if (!body.primaryEmail && !body.primaryPhone && !body.taxNumber) {
      errors.push({ field: 'primaryPhone', code: 'required', message: 'Enter a phone number, an email address or a tax number to check.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);

    const candidates = await this.find(tx, ctx, { email, phone, taxNumber: body.taxNumber ?? null }, body.excludeContactId ?? undefined);
    await this.audit.record(tx, ctx, {
      action: 'contact.duplicate_check',
      entityType: 'company',
      entityId: ctx.companyId,
      metadata: {
        checked: [email !== null ? 'email' : null, phone !== null ? 'phone' : null, body.taxNumber ? 'tax_number' : null].filter((value) => value !== null),
        candidates: candidates.length,
        outsideScope: candidates.filter((candidate) => !candidate.visible).length,
      },
    });
    return candidates;
  }

  private async callingCode(tx: Tx, ctx: TenantContext, officeId: string | null): Promise<string | null> {
    const row = officeId
      ? await tx.selectFrom('offices as o').innerJoin('countries as k', 'k.code', 'o.countryCode').select('k.phoneCountryCode').where('o.id', '=', officeId).executeTakeFirst()
      : await tx
          .selectFrom('companies as co')
          .innerJoin('countries as k', 'k.code', 'co.headquartersCountryCode')
          .select('k.phoneCountryCode')
          .where('co.id', '=', ctx.companyId)
          .executeTakeFirst();
    return row?.phoneCountryCode ?? null;
  }
}
