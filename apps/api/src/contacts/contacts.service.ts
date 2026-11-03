import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService, diffForAudit } from '../audit/audit.service.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { PermissionScope, TenantContext } from '../common/request-context.js';
import { keysetCondition, type Page, type ParsedListQuery, sortValueSql, toPage } from '../common/list-query.js';
import { SensitiveDataService } from '../crypto/sensitive-data.service.js';
import type { Tx } from '../database/database.module.js';
import { recordSystemActivity } from '../crm/system-activity.js';
import { nextReference } from '../properties/properties.service.js';
import { checkPicklistCode } from '../reference/picklists.js';
import { contactScopeSql, contactWithinScope, scopeFor } from './contact-access.js';
import type {
  AddMethodBody,
  AddRelationshipBody,
  ConsentDto,
  ConsentInput,
  ContactDto,
  ContactSummaryDto,
  CreateContactBody,
  EndRelationshipBody,
  MethodDto,
  UpdateContactBody,
  UpdateMethodBody,
} from './dto.js';
import { DuplicatesService } from './duplicates.service.js';
import { isEmail, maskPhone, normaliseEmail, normaliseMethod, normalisePhone, searchNormalise } from './identifiers.js';

export type ContactSortField = 'displayName' | 'createdAt' | 'updatedAt';

/** Columns written from request fields without transformation. */
const PLAIN_FIELDS = [
  'displayName', 'displayNameLocal', 'givenName', 'familyName', 'otherNames', 'title', 'organisationName',
  'preferredLocaleCode', 'preferredChannel', 'nationalityCountryCode', 'residenceCountryCode', 'sourceCode', 'notes',
] as const;

/** Never compared or written to audit change sets: ciphertext, hashes and generated columns. */
const NOT_AUDITED = new Set(['dateOfBirthEncrypted', 'taxNumberEncrypted', 'taxNumberHash', 'organisationRegNumberEncrypted', 'searchVector', 'version', 'updatedAt']);

type ContactRow = Awaited<ReturnType<ContactsService['loadRow']>>;

/**
 * Contacts (CRM-01, CRM-02, CRM-08; wireframes C-1 to C-6). One record per
 * person or organisation; buyer, seller, landlord and tenant are roles.
 * Protected values (ADR-007) are written through SensitiveDataService and
 * never returned: responses carry masked metadata to members with kyc.view.
 */
@Injectable()
export class ContactsService {
  constructor(
    private readonly sensitive: SensitiveDataService,
    private readonly audit: AuditService,
    private readonly duplicates: DuplicatesService,
  ) {}

  // ----------------------------------------------------------------- reading

  async list(tx: Tx, ctx: TenantContext, scope: PermissionScope, query: ParsedListQuery<ContactSortField>): Promise<Page<ContactSummaryDto>> {
    const sortColumn = sql.ref(`c.${query.sort.field}`);
    let qb = tx
      .selectFrom('contacts as c')
      .leftJoin('offices as o', (join) => join.onRef('o.companyId', '=', 'c.companyId').onRef('o.id', '=', 'c.officeId'))
      .leftJoin('companyMemberships as m', (join) => join.onRef('m.companyId', '=', 'c.companyId').onRef('m.id', '=', 'c.ownerMembershipId'))
      .leftJoin('users as u', 'u.id', 'm.userId')
      .select((eb) => [
        'c.id', 'c.reference', 'c.contactType', 'c.displayName', 'c.displayNameLocal', 'c.primaryPhoneE164', 'c.officeId', 'o.name as officeName',
        'c.ownerMembershipId', 'u.displayName as ownerName', 'c.archivedAt', 'c.updatedAt',
        eb
          .selectFrom('contactRelationships as r')
          .select(sql<string[]>`coalesce(array_agg(r.relationship_type order by r.relationship_type), '{}')`.as('roles'))
          .whereRef('r.companyId', '=', 'c.companyId')
          .whereRef('r.contactId', '=', 'c.id')
          .where('r.status', '=', 'active')
          .as('roles'),
        sortValueSql(sortColumn, query.sort.kind).as('cursorValue'),
      ])
      .where('c.mergedIntoContactId', 'is', null)
      .where(contactScopeSql(scope, ctx, 'c', 'read'));

    const filters = query.filters;
    const archived = filters['archived'] ?? 'false';
    if (archived === 'false') qb = qb.where('c.archivedAt', 'is', null);
    if (archived === 'true') qb = qb.where('c.archivedAt', 'is not', null);
    const relationship = filters['relationship'];
    if (Array.isArray(relationship)) {
      qb = qb.where((eb) =>
        eb.exists(
          eb
            .selectFrom('contactRelationships as fr')
            .select('fr.id')
            .whereRef('fr.companyId', '=', 'c.companyId')
            .whereRef('fr.contactId', '=', 'c.id')
            .where('fr.status', '=', 'active')
            .where('fr.relationshipType', 'in', relationship),
        ),
      );
    }
    for (const [filter, column] of [
      ['officeId', 'c.officeId'],
      ['ownerMembershipId', 'c.ownerMembershipId'],
      ['sourceCode', 'c.sourceCode'],
      ['contactType', 'c.contactType'],
    ] as const) {
      const values = filters[filter];
      if (Array.isArray(values)) qb = qb.where(column, 'in', values);
    }
    if (query.q !== null) qb = qb.where(searchCondition(query.q));
    if (query.cursor) qb = qb.where(keysetCondition(sortColumn, 'c.id', query.sort, query.cursor));

    const rows = await qb.orderBy(sortColumn, query.sort.direction).orderBy('c.id', query.sort.direction).limit(query.limit + 1).execute();
    // Sellers view (SE-1): the latest identity check, only where the member has kyc.view on the contact.
    const kycVisible = rows.slice(0, query.limit).filter((row) => canUse(ctx, 'kyc.view', row)).map((row) => row.id);
    const identityChecks = await latestIdentityChecks(tx, kycVisible);
    return toPage(rows, query.limit, (row) => row.cursorValue, (row) => row.id, (row) => ({
      id: row.id,
      reference: row.reference,
      contactType: row.contactType,
      displayName: row.displayName,
      displayNameLocal: row.displayNameLocal,
      roles: row.roles ?? [],
      primaryPhoneMasked: maskPhone(row.primaryPhoneE164),
      owner: row.ownerMembershipId !== null ? { id: row.ownerMembershipId, name: row.ownerName ?? '' } : null,
      office: row.officeId !== null ? { id: row.officeId, name: row.officeName ?? '' } : null,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      identityCheck: kycVisible.includes(row.id) ? (identityChecks.get(row.id) ?? { status: 'none', reviewedAt: null }) : null,
    }));
  }

  /** One contact as the member may see it; 404 outside the member's read scope. */
  async get(tx: Tx, ctx: TenantContext, id: string): Promise<ContactDto> {
    const row = await this.loadRow(tx, id);
    if (!row || !(await this.canRead(tx, ctx, row))) throw Problems.notFound();
    return this.toDto(tx, ctx, row);
  }

  async loadRow(tx: Tx, id: string) {
    return tx
      .selectFrom('contacts as c')
      .leftJoin('offices as o', (join) => join.onRef('o.companyId', '=', 'c.companyId').onRef('o.id', '=', 'c.officeId'))
      .leftJoin('companyMemberships as m', (join) => join.onRef('m.companyId', '=', 'c.companyId').onRef('m.id', '=', 'c.ownerMembershipId'))
      .leftJoin('users as u', 'u.id', 'm.userId')
      .selectAll('c')
      .select(['o.name as officeName', 'u.displayName as ownerName'])
      .where('c.id', '=', id)
      .executeTakeFirst();
  }

  async canRead(tx: Tx, ctx: TenantContext, row: { id: string; officeId: string | null; ownerMembershipId: string | null }): Promise<boolean> {
    const scope = scopeFor(ctx, 'contact.view');
    if (scope === null) return false;
    if (contactWithinScope(scope, ctx, row)) return true;
    if (scope !== 'own') return false;
    const viaAssignment = await tx
      .selectFrom('contacts as c')
      .select('c.id')
      .where('c.id', '=', row.id)
      .where(contactScopeSql('own', ctx, 'c', 'read'))
      .executeTakeFirst();
    return viaAssignment !== undefined;
  }

  /** Throws 404 when the member cannot see the contact, 403 when they can see it but the permission's scope does not cover it. */
  async assertWrite(tx: Tx, ctx: TenantContext, row: { id: string; officeId: string | null; ownerMembershipId: string | null }, permission: string): Promise<void> {
    if (!(await this.canRead(tx, ctx, row))) throw Problems.notFound();
    const scope = scopeFor(ctx, permission);
    if (scope === null || !contactWithinScope(scope, ctx, row)) throw Problems.forbidden();
  }

  async toDto(tx: Tx, ctx: TenantContext, row: NonNullable<ContactRow>): Promise<ContactDto> {
    const [relationships, methods, consents] = await Promise.all([
      tx.selectFrom('contactRelationships').selectAll().where('contactId', '=', row.id).orderBy('startedOn').orderBy('id').execute(),
      tx.selectFrom('contactMethods').selectAll().where('contactId', '=', row.id).orderBy('isPrimary', 'desc').orderBy('methodType').orderBy('createdAt').execute(),
      this.currentConsents(tx, row.id),
    ]);
    const isOrganisation = row.contactType === 'organisation';
    const access = {
      canEdit: canUse(ctx, 'contact.update', row) && row.archivedAt === null,
      canArchive: canUse(ctx, 'contact.archive', row),
      canMerge: canUse(ctx, 'contact.merge', row) && row.mergedIntoContactId === null,
      canReveal: canUse(ctx, 'contact.view_sensitive', row),
    };
    const dto: ContactDto = {
      id: row.id,
      reference: row.reference,
      contactType: row.contactType,
      displayName: row.displayName,
      displayNameLocal: row.displayNameLocal,
      givenName: row.givenName,
      familyName: row.familyName,
      otherNames: row.otherNames,
      title: row.title,
      organisationName: row.organisationName,
      organisationRegNumber: isOrganisation ? row.organisationRegNumber : null,
      taxNumber: isOrganisation ? row.taxNumber : null,
      primaryEmail: row.primaryEmail,
      primaryPhone: row.primaryPhoneE164,
      preferredLocaleCode: row.preferredLocaleCode,
      preferredChannel: row.preferredChannel,
      nationalityCountryCode: row.nationalityCountryCode,
      residenceCountryCode: row.residenceCountryCode,
      office: row.officeId !== null ? { id: row.officeId, name: row.officeName ?? '' } : null,
      owner: row.ownerMembershipId !== null ? { id: row.ownerMembershipId, name: row.ownerName ?? '' } : null,
      sourceCode: row.sourceCode,
      notes: row.notes,
      relationships: relationships.map((r) => ({
        id: r.id,
        relationshipType: r.relationshipType,
        status: r.status,
        startedOn: r.startedOn,
        endedOn: r.endedOn,
      })),
      methods: methods.map(toMethodDto),
      consents,
      isAnonymised: row.isAnonymised,
      mergedIntoContactId: row.mergedIntoContactId,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      archivedReason: row.archivedReason,
      access,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
    // Permission-based visibility (wireframe C-5): masked metadata needs kyc.view on the contact.
    if (canUse(ctx, 'kyc.view', row) && !isOrganisation) {
      dto.protected = {
        dateOfBirth: { recorded: row.dateOfBirthEncrypted !== null, last4: null },
        taxNumber: { recorded: row.taxNumberEncrypted !== null, last4: row.taxNumberLast4 },
        organisationRegNumber: { recorded: row.organisationRegNumberEncrypted !== null, last4: null },
      };
    }
    return dto;
  }

  // ----------------------------------------------------------------- writing

  async create(tx: Tx, ctx: TenantContext, scope: PermissionScope, body: CreateContactBody): Promise<ContactDto> {
    const errors: FieldError[] = [];
    const officeId = await this.resolveOffice(tx, ctx, scope, body.officeId, errors);
    const ownerMembershipId = await this.resolveOwner(tx, ctx, scope, body.ownerMembershipId === undefined ? ctx.membershipId : body.ownerMembershipId, errors);
    const callingCode = await this.callingCode(tx, ctx, officeId);
    const isPerson = body.contactType === 'person';

    const primaryEmail = body.primaryEmail ? this.email(body.primaryEmail, errors) : null;
    const primaryPhone = body.primaryPhone ? this.phone(body.primaryPhone, callingCode, errors) : null;
    if (!body.primaryEmail && !body.primaryPhone) {
      errors.push({ field: 'primaryPhone', code: 'required', message: 'Enter a mobile number or an email address.' });
    }
    if (body.contactType === 'organisation' && !body.organisationName) {
      errors.push({ field: 'organisationName', code: 'required', message: 'Enter the organisation’s name.' });
    }
    if (!isPerson && body.dateOfBirth) errors.push({ field: 'dateOfBirth', code: 'not-applicable', message: 'Organisations have no date of birth.' });
    if (body.dateOfBirth) checkBirthDate(body.dateOfBirth, errors);
    await this.checkReferences(tx, ctx, body, officeId, errors);
    if (body.consents) checkConsents(body.consents, 'consents', errors);
    if (errors.length > 0) throw Problems.validation(errors);

    const candidates = await this.duplicates.find(tx, ctx, { email: primaryEmail, phone: primaryPhone, taxNumber: isPerson ? (body.taxNumber ?? null) : null });
    if (candidates.length > 0 && body.confirmNotDuplicate !== true) throw Problems.possibleDuplicates(candidates);

    const id = await newId(tx);
    const reference = await nextReference(tx, ctx, 'contact');
    const protectedColumns = await this.protectedColumns(tx, ctx, id, isPerson, body);
    await tx
      .insertInto('contacts')
      .values({
        id,
        companyId: ctx.companyId,
        reference,
        contactType: body.contactType,
        displayName: body.displayName,
        displayNameLocal: body.displayNameLocal ?? null,
        givenName: body.givenName ?? null,
        familyName: body.familyName ?? null,
        otherNames: body.otherNames ?? null,
        title: body.title ?? null,
        organisationName: body.organisationName ?? null,
        primaryEmail,
        primaryPhoneE164: primaryPhone,
        preferredLocaleCode: body.preferredLocaleCode ?? null,
        preferredChannel: body.preferredChannel ?? null,
        nationalityCountryCode: body.nationalityCountryCode ?? null,
        residenceCountryCode: body.residenceCountryCode ?? null,
        officeId,
        ownerMembershipId,
        sourceCode: body.sourceCode ?? null,
        notes: body.notes ?? null,
        createdBy: ctx.system ? null : ctx.membershipId,
        ...protectedColumns,
      })
      .execute();
    if (primaryEmail !== null) await this.insertMethod(tx, ctx, id, 'email', primaryEmail, primaryEmail, true, null);
    if (primaryPhone !== null) await this.insertMethod(tx, ctx, id, 'mobile', primaryPhone, primaryPhone, true, null);
    for (const type of body.relationships ?? []) {
      await tx.insertInto('contactRelationships').values({ companyId: ctx.companyId, contactId: id, relationshipType: type }).execute();
    }
    for (const consent of body.consents ?? []) await this.insertConsent(tx, ctx, id, consent);

    await this.audit.record(tx, ctx, {
      action: 'contact.created',
      entityType: 'contact',
      entityId: id,
      metadata: {
        reference,
        relationships: body.relationships ?? [],
        protectedFields: protectedFieldNames(body),
        ...(candidates.length > 0 ? { confirmedNotDuplicateOf: candidates.map((c) => c.id ?? 'outside-scope'), confirmedNotDuplicate: true } : {}),
      },
    });
    await this.audit.emit(tx, ctx, { eventType: 'contact.created', aggregateType: 'contact', aggregateId: id, payload: { contactId: id, reference } });
    return this.get(tx, ctx, id);
  }

  async update(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, body: UpdateContactBody): Promise<ContactDto> {
    const current = await tx.selectFrom('contacts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    await this.assertWrite(tx, ctx, current, 'contact.update');
    assertEditable(current);
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();

    const errors: FieldError[] = [];
    const isPerson = current.contactType === 'person';
    const writeScope = scopeFor(ctx, 'contact.update') ?? 'own';
    const patch: Record<string, unknown> = {};
    for (const field of PLAIN_FIELDS) if (body[field] !== undefined) patch[field] = body[field];
    if (body.displayName === null) errors.push({ field: 'displayName', code: 'required', message: 'A contact needs a display name.' });

    if (body.officeId !== undefined) patch['officeId'] = await this.resolveOffice(tx, ctx, writeScope, body.officeId, errors, true);
    if (body.ownerMembershipId !== undefined) patch['ownerMembershipId'] = await this.resolveOwner(tx, ctx, writeScope, body.ownerMembershipId, errors);
    const callingCode = await this.callingCode(tx, ctx, (patch['officeId'] as string | null | undefined) ?? current.officeId);
    if (body.primaryEmail !== undefined) patch['primaryEmail'] = body.primaryEmail === null ? null : this.email(body.primaryEmail, errors);
    if (body.primaryPhone !== undefined) patch['primaryPhoneE164'] = body.primaryPhone === null ? null : this.phone(body.primaryPhone, callingCode, errors);
    const emailAfter = patch['primaryEmail'] !== undefined ? patch['primaryEmail'] : current.primaryEmail;
    const phoneAfter = patch['primaryPhoneE164'] !== undefined ? patch['primaryPhoneE164'] : current.primaryPhoneE164;
    if (emailAfter === null && phoneAfter === null) errors.push({ field: 'primaryPhone', code: 'required', message: 'Keep a mobile number or an email address.' });
    if (!isPerson && body.organisationName === null) errors.push({ field: 'organisationName', code: 'required', message: 'Enter the organisation’s name.' });
    if (!isPerson && body.dateOfBirth) errors.push({ field: 'dateOfBirth', code: 'not-applicable', message: 'Organisations have no date of birth.' });
    if (body.dateOfBirth) checkBirthDate(body.dateOfBirth, errors);
    await this.checkReferences(tx, ctx, body, (patch['officeId'] as string | null | undefined) ?? current.officeId, errors);
    if (errors.length > 0) throw Problems.validation(errors);

    const emailChanged = patch['primaryEmail'] !== undefined && patch['primaryEmail'] !== current.primaryEmail;
    const phoneChanged = patch['primaryPhoneE164'] !== undefined && patch['primaryPhoneE164'] !== current.primaryPhoneE164;
    const taxForCheck = isPerson && typeof body.taxNumber === 'string' ? body.taxNumber : null;
    let candidates: Awaited<ReturnType<DuplicatesService['find']>> = [];
    if (emailChanged || phoneChanged || taxForCheck !== null) {
      candidates = await this.duplicates.find(
        tx,
        ctx,
        { email: emailChanged ? (patch['primaryEmail'] as string | null) : null, phone: phoneChanged ? (patch['primaryPhoneE164'] as string | null) : null, taxNumber: taxForCheck },
        id,
      );
      if (candidates.length > 0 && body.confirmNotDuplicate !== true) throw Problems.possibleDuplicates(candidates);
    }

    Object.assign(patch, await this.protectedColumns(tx, ctx, id, isPerson, body));
    const effective = Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => !sameValue((current as Record<string, unknown>)[key], value)),
    );
    const protectedChanged = protectedFieldNames(body);
    if (Object.keys(effective).length === 0 && protectedChanged.length === 0) return this.get(tx, ctx, id);

    const updated = await tx
      .updateTable('contacts')
      .set(Object.keys(effective).length > 0 ? effective : { updatedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (emailChanged) await this.syncPrimaryMethod(tx, ctx, id, 'email', updated.primaryEmail);
    if (phoneChanged) await this.syncPrimaryMethod(tx, ctx, id, 'mobile', updated.primaryPhoneE164);

    const changes = auditChanges(current, updated);
    for (const name of protectedChanged) changes[name] = { old: '[protected]', new: body[name as 'dateOfBirth'] === null ? null : '[protected]' };
    await this.audit.record(tx, ctx, {
      action: 'contact.updated',
      entityType: 'contact',
      entityId: id,
      changes: Object.keys(changes).length > 0 ? changes : null,
      metadata: candidates.length > 0 ? { confirmedNotDuplicateOf: candidates.map((c) => c.id ?? 'outside-scope'), confirmedNotDuplicate: true } : {},
    });
    await this.audit.emit(tx, ctx, { eventType: 'contact.updated', aggregateType: 'contact', aggregateId: id, payload: { contactId: id } });
    return this.get(tx, ctx, id);
  }

  async archive(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number, reason: string): Promise<ContactDto> {
    const current = await tx.selectFrom('contacts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    await this.assertWrite(tx, ctx, current, 'contact.archive');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.mergedIntoContactId !== null) throw Problems.businessRule('This contact was merged into another contact.');
    if (current.archivedAt !== null) throw Problems.businessRule('This contact is already archived.');

    const openLeads = await tx
      .selectFrom('leads')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('contactId', '=', id)
      .where('status', 'in', ['new', 'contacted', 'qualified'])
      .where('archivedAt', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(openLeads.n) > 0) throw Problems.businessRule(`This contact has ${openLeads.n} open lead(s). Close or reassign them before archiving.`);
    const portal = await tx.selectFrom('companyMemberships').select('id').where('contactId', '=', id).where('status', 'in', ['invited', 'active']).executeTakeFirst();
    if (portal) throw Problems.businessRule('This contact has portal access. End the portal membership before archiving.');

    await tx
      .updateTable('contacts')
      .set({ archivedAt: sql<Date>`now()`, archivedReason: reason, archivedBy: ctx.system ? null : ctx.membershipId })
      .where('id', '=', id)
      .execute();
    await this.audit.record(tx, ctx, { action: 'contact.archived', entityType: 'contact', entityId: id, metadata: { reason } });
    await this.audit.emit(tx, ctx, { eventType: 'contact.archived', aggregateType: 'contact', aggregateId: id, payload: { contactId: id } });
    return this.get(tx, ctx, id);
  }

  async restore(tx: Tx, ctx: TenantContext, id: string, expectedVersion: number): Promise<ContactDto> {
    const current = await tx.selectFrom('contacts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    await this.assertWrite(tx, ctx, current, 'contact.archive');
    if (current.version !== expectedVersion) throw Problems.preconditionFailed();
    if (current.mergedIntoContactId !== null) throw Problems.businessRule('A merged contact cannot be restored. Open the contact it was merged into.');
    if (current.archivedAt === null) throw Problems.businessRule('This contact is not archived.');
    await tx.updateTable('contacts').set({ archivedAt: null, archivedReason: null, archivedBy: null }).where('id', '=', id).execute();
    await this.audit.record(tx, ctx, { action: 'contact.restored', entityType: 'contact', entityId: id });
    await this.audit.emit(tx, ctx, { eventType: 'contact.restored', aggregateType: 'contact', aggregateId: id, payload: { contactId: id } });
    return this.get(tx, ctx, id);
  }

  // ---------------------------------------------------------- contact methods

  async addMethod(tx: Tx, ctx: TenantContext, contactId: string, body: AddMethodBody): Promise<ContactDto> {
    const contact = await this.lockForEdit(tx, ctx, contactId);
    const callingCode = await this.callingCode(tx, ctx, contact.officeId);
    const normalised = normaliseMethod(body.methodType, body.value, callingCode);
    if (normalised === null) {
      throw Problems.validation([{ field: 'value', code: 'invalid', message: `This is not a valid ${body.methodType} value.` }]);
    }
    const existing = await tx
      .selectFrom('contactMethods')
      .select('id')
      .where('contactId', '=', contactId)
      .where('methodType', '=', body.methodType)
      .where('normalised', '=', normalised)
      .executeTakeFirst();
    if (existing) throw Problems.conflict('This contact already has this value.', { type: 'contact_method', id: existing.id });
    const stored = body.methodType === 'email' || ['phone', 'mobile', 'whatsapp', 'fax'].includes(body.methodType) ? normalised : body.value;
    const methodId = await this.insertMethod(tx, ctx, contactId, body.methodType, stored, normalised, body.isPrimary ?? false, body.label ?? null);
    if (body.isPrimary) await this.makePrimary(tx, ctx, contactId, methodId);
    await this.touch(tx, contactId);
    await this.audit.record(tx, ctx, { action: 'contact.method_added', entityType: 'contact', entityId: contactId, metadata: { methodId, methodType: body.methodType } });
    return this.get(tx, ctx, contactId);
  }

  async updateMethod(tx: Tx, ctx: TenantContext, contactId: string, methodId: string, body: UpdateMethodBody): Promise<ContactDto> {
    await this.lockForEdit(tx, ctx, contactId);
    const method = await tx.selectFrom('contactMethods').selectAll().where('id', '=', methodId).where('contactId', '=', contactId).executeTakeFirst();
    if (!method) throw Problems.notFound();
    const patch: Record<string, unknown> = {};
    if (body.label !== undefined) patch['label'] = body.label;
    if (body.optedOut !== undefined) patch['optedOutAt'] = body.optedOut ? (method.optedOutAt ?? sql<Date>`now()`) : null;
    if (body.verified !== undefined) patch['verifiedAt'] = body.verified ? (method.verifiedAt ?? sql<Date>`now()`) : null;
    if (Object.keys(patch).length > 0) await tx.updateTable('contactMethods').set(patch).where('id', '=', methodId).execute();
    if (body.isPrimary === true && !method.isPrimary) await this.makePrimary(tx, ctx, contactId, methodId);
    if (body.isPrimary === false && method.isPrimary) throw Problems.businessRule('Choose another primary value instead of unsetting this one.');
    await this.touch(tx, contactId);
    await this.audit.record(tx, ctx, {
      action: 'contact.method_updated',
      entityType: 'contact',
      entityId: contactId,
      metadata: { methodId, ...(body.optedOut !== undefined ? { optedOut: body.optedOut } : {}), ...(body.isPrimary ? { isPrimary: true } : {}), ...(body.verified !== undefined ? { verified: body.verified } : {}) },
    });
    return this.get(tx, ctx, contactId);
  }

  async removeMethod(tx: Tx, ctx: TenantContext, contactId: string, methodId: string): Promise<ContactDto> {
    const contact = await this.lockForEdit(tx, ctx, contactId);
    const method = await tx.selectFrom('contactMethods').selectAll().where('id', '=', methodId).where('contactId', '=', contactId).executeTakeFirst();
    if (!method) throw Problems.notFound();
    if (method.isPrimary) {
      const column = method.methodType === 'email' ? 'primaryEmail' : method.methodType === 'mobile' || method.methodType === 'phone' ? 'primaryPhoneE164' : null;
      if (column !== null) {
        const other = column === 'primaryEmail' ? contact.primaryPhoneE164 : contact.primaryEmail;
        if (other === null) throw Problems.businessRule('A contact keeps at least a mobile number or an email address. Add another first.');
        await tx.updateTable('contacts').set({ [column]: null }).where('id', '=', contactId).execute();
      }
    }
    await tx.deleteFrom('contactMethods').where('id', '=', methodId).execute();
    await this.touch(tx, contactId);
    await this.audit.record(tx, ctx, { action: 'contact.method_removed', entityType: 'contact', entityId: contactId, metadata: { methodId, methodType: method.methodType } });
    return this.get(tx, ctx, contactId);
  }

  // ------------------------------------------------------------ relationships

  async addRelationship(tx: Tx, ctx: TenantContext, contactId: string, body: AddRelationshipBody): Promise<ContactDto> {
    await this.lockForEdit(tx, ctx, contactId);
    const active = await tx
      .selectFrom('contactRelationships')
      .select('id')
      .where('contactId', '=', contactId)
      .where('relationshipType', '=', body.relationshipType)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (active) throw Problems.conflict(`This contact is already an active ${body.relationshipType}.`, { type: 'contact_relationship', id: active.id });
    const inserted = await tx
      .insertInto('contactRelationships')
      .values({ companyId: ctx.companyId, contactId, relationshipType: body.relationshipType })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.touch(tx, contactId);
    await this.audit.record(tx, ctx, { action: 'contact.relationship_added', entityType: 'contact', entityId: contactId, metadata: { relationshipId: inserted.id, relationshipType: body.relationshipType } });
    return this.get(tx, ctx, contactId);
  }

  async endRelationship(tx: Tx, ctx: TenantContext, contactId: string, relationshipId: string, body: EndRelationshipBody): Promise<ContactDto> {
    await this.lockForEdit(tx, ctx, contactId);
    const relationship = await tx.selectFrom('contactRelationships').selectAll().where('id', '=', relationshipId).where('contactId', '=', contactId).executeTakeFirst();
    if (!relationship) throw Problems.notFound();
    if (relationship.status !== 'active') throw Problems.businessRule('This role has already ended.');
    const endedOn = body.endedOn ?? new Date().toISOString().slice(0, 10);
    if (endedOn < relationship.startedOn) {
      throw Problems.validation([{ field: 'endedOn', code: 'before-start', message: 'A role cannot end before it started.' }]);
    }
    await tx.updateTable('contactRelationships').set({ status: 'inactive', endedOn }).where('id', '=', relationshipId).execute();
    await this.touch(tx, contactId);
    await this.audit.record(tx, ctx, {
      action: 'contact.relationship_ended',
      entityType: 'contact',
      entityId: contactId,
      metadata: { relationshipId, relationshipType: relationship.relationshipType, endedOn },
    });
    return this.get(tx, ctx, contactId);
  }

  // ------------------------------------------------------------------ consent

  async consentHistory(tx: Tx, ctx: TenantContext, contactId: string): Promise<ConsentDto[]> {
    const row = await this.loadRow(tx, contactId);
    if (!row || !(await this.canRead(tx, ctx, row))) throw Problems.notFound();
    const rows = await tx.selectFrom('consents').selectAll().where('contactId', '=', contactId).orderBy('capturedAt', 'desc').orderBy('id', 'desc').limit(500).execute();
    return rows.map(toConsentDto);
  }

  async recordConsent(tx: Tx, ctx: TenantContext, contactId: string, body: ConsentInput): Promise<ConsentDto[]> {
    await this.lockForEdit(tx, ctx, contactId, { allowArchived: true });
    const errors: FieldError[] = [];
    checkConsents([body], null, errors);
    if (errors.length > 0) throw Problems.validation(errors);
    await this.insertConsent(tx, ctx, contactId, body);
    await this.touch(tx, contactId);
    return this.consentHistory(tx, ctx, contactId);
  }

  /** The latest record per purpose and channel: what is in force now. */
  async currentConsents(tx: Tx, contactId: string): Promise<ConsentDto[]> {
    const rows = await tx
      .selectFrom('consents')
      .selectAll()
      .distinctOn(['purpose', 'channel'])
      .where('contactId', '=', contactId)
      .orderBy('purpose')
      .orderBy('channel')
      .orderBy('capturedAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toConsentDto);
  }

  async insertConsent(tx: Tx, ctx: TenantContext, contactId: string, consent: ConsentInput, capturedVia?: string): Promise<void> {
    const inserted = await tx
      .insertInto('consents')
      .values({
        companyId: ctx.companyId,
        contactId,
        purpose: consent.purpose,
        channel: consent.channel,
        status: consent.status,
        lawfulBasis: consent.status === 'granted' ? (consent.lawfulBasis ?? null) : null,
        capturedVia: capturedVia ?? consent.capturedVia,
        evidence: consent.evidence ?? null,
        capturedBy: ctx.system ? null : ctx.membershipId,
        ...(consent.capturedAt !== undefined ? { capturedAt: new Date(consent.capturedAt) } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'contact.consent_recorded',
      entityType: 'contact',
      entityId: contactId,
      metadata: { consentId: inserted.id, purpose: consent.purpose, channel: consent.channel, status: consent.status, capturedVia: capturedVia ?? consent.capturedVia },
    });
    // The timeline shows consent changes as system entries (wireframe A-1).
    await recordSystemActivity(tx, ctx, {
      activityType: 'system',
      subject: `Consent ${consent.status}: ${consent.purpose.replace(/_/g, ' ')} (${consent.channel ?? 'any'}) via ${(capturedVia ?? consent.capturedVia).replace(/_/g, ' ')}`,
      links: [{ entityType: 'contact', entityId: contactId }],
    });
  }

  // ------------------------------------------------------------------ helpers

  /** Contact row locked for a sub-resource change, after access checks. */
  private async lockForEdit(tx: Tx, ctx: TenantContext, id: string, options: { allowArchived?: boolean } = {}) {
    const current = await tx.selectFrom('contacts').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!current) throw Problems.notFound();
    await this.assertWrite(tx, ctx, current, 'contact.update');
    if (!options.allowArchived) assertEditable(current);
    else if (current.isAnonymised || current.mergedIntoContactId !== null) assertEditable(current);
    return current;
  }

  /** Bumps the contact's version so its ETag changes with its methods, roles and consents. */
  private async touch(tx: Tx, id: string): Promise<void> {
    await tx.updateTable('contacts').set({ updatedAt: sql<Date>`now()` }).where('id', '=', id).execute();
  }

  async insertMethod(tx: Tx, ctx: TenantContext, contactId: string, type: string, value: string, normalised: string, isPrimary: boolean, label: string | null): Promise<string> {
    const inserted = await tx
      .insertInto('contactMethods')
      .values({ companyId: ctx.companyId, contactId, methodType: type, value, normalised, isPrimary, label })
      .returning('id')
      .executeTakeFirstOrThrow();
    return inserted.id;
  }

  /** One primary per method type; the contact's primary email and phone follow the primary method. */
  private async makePrimary(tx: Tx, ctx: TenantContext, contactId: string, methodId: string): Promise<void> {
    const method = await tx.selectFrom('contactMethods').selectAll().where('id', '=', methodId).executeTakeFirstOrThrow();
    const sameClass = method.methodType === 'email' ? ['email'] : method.methodType === 'mobile' || method.methodType === 'phone' ? ['mobile', 'phone'] : [method.methodType];
    await tx.updateTable('contactMethods').set({ isPrimary: false }).where('contactId', '=', contactId).where('methodType', 'in', sameClass).where('id', '<>', methodId).execute();
    await tx.updateTable('contactMethods').set({ isPrimary: true }).where('id', '=', methodId).execute();
    if (method.methodType === 'email') await tx.updateTable('contacts').set({ primaryEmail: method.normalised }).where('id', '=', contactId).execute();
    if (method.methodType === 'mobile' || method.methodType === 'phone') {
      await tx.updateTable('contacts').set({ primaryPhoneE164: method.normalised }).where('id', '=', contactId).execute();
    }
    void ctx;
  }

  /** After the primary email or phone changed on the contact: keep the methods list in step. */
  async syncPrimaryMethod(tx: Tx, ctx: TenantContext, contactId: string, type: 'email' | 'mobile', value: string | null): Promise<void> {
    const sameClass = type === 'email' ? ['email'] : ['mobile', 'phone'];
    await tx.updateTable('contactMethods').set({ isPrimary: false }).where('contactId', '=', contactId).where('methodType', 'in', sameClass).execute();
    if (value === null) return;
    const existing = await tx
      .selectFrom('contactMethods')
      .select('id')
      .where('contactId', '=', contactId)
      .where('methodType', 'in', sameClass)
      .where('normalised', '=', value)
      .executeTakeFirst();
    if (existing) await tx.updateTable('contactMethods').set({ isPrimary: true }).where('id', '=', existing.id).execute();
    else await this.insertMethod(tx, ctx, contactId, type, value, value, true, null);
  }

  /** Encrypted columns for the protected fields present in the body (ADR-007). */
  private async protectedColumns(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    isPerson: boolean,
    body: Pick<CreateContactBody, 'dateOfBirth' | 'taxNumber' | 'organisationRegNumber'>,
  ): Promise<Record<string, unknown>> {
    const columns: Record<string, unknown> = {};
    const place = (column: string) => ({ table: 'contacts', column, rowId: id });
    if (isPerson) {
      if (body.dateOfBirth !== undefined) {
        columns['dateOfBirthEncrypted'] = body.dateOfBirth === null ? null : await this.sensitive.seal(tx, ctx, place('date_of_birth_encrypted'), body.dateOfBirth);
      }
      if (body.taxNumber !== undefined) {
        if (body.taxNumber === null) Object.assign(columns, { taxNumberEncrypted: null, taxNumberHash: null, taxNumberLast4: null });
        else {
          const value = await this.sensitive.protectIdentifier(tx, ctx, place('tax_number_encrypted'), 'tax_number', body.taxNumber);
          Object.assign(columns, { taxNumberEncrypted: value.encrypted, taxNumberHash: value.hash, taxNumberLast4: value.last4 });
        }
      }
      if (body.organisationRegNumber !== undefined) {
        columns['organisationRegNumberEncrypted'] =
          body.organisationRegNumber === null ? null : await this.sensitive.seal(tx, ctx, place('organisation_reg_number_encrypted'), body.organisationRegNumber);
      }
    } else {
      if (body.taxNumber !== undefined) columns['taxNumber'] = body.taxNumber;
      if (body.organisationRegNumber !== undefined) columns['organisationRegNumber'] = body.organisationRegNumber;
    }
    return columns;
  }

  private async resolveOffice(
    tx: Tx,
    ctx: TenantContext,
    scope: PermissionScope,
    requested: string | null | undefined,
    errors: FieldError[],
    isUpdate = false,
  ): Promise<string | null> {
    let officeId = requested === undefined ? (ctx.officeIds.length === 1 ? (ctx.officeIds[0] ?? null) : null) : requested;
    if (officeId === null) {
      if (scope === 'office') errors.push({ field: 'officeId', code: 'required', message: 'Choose one of your offices.' });
      return null;
    }
    const office = await tx.selectFrom('offices').select(['id', 'archivedAt']).where('id', '=', officeId).executeTakeFirst();
    if (!office || office.archivedAt !== null) {
      errors.push({ field: 'officeId', code: 'not-found', message: 'This office does not exist or is archived.' });
      officeId = null;
    } else if ((scope === 'office' || scope === 'own') && !ctx.officeIds.includes(office.id) && !(isUpdate && scope === 'own')) {
      throw Problems.forbidden('You can only place contacts in your own offices.');
    }
    return officeId;
  }

  private async resolveOwner(tx: Tx, ctx: TenantContext, scope: PermissionScope, requested: string | null, errors: FieldError[]): Promise<string | null> {
    if (requested === null || requested === '') return null;
    if (scope === 'own' && requested !== ctx.membershipId) throw Problems.forbidden('You can only make yourself responsible for a contact.');
    const member = await tx
      .selectFrom('companyMemberships')
      .select(['id', 'status', 'membershipType'])
      .where('id', '=', requested)
      .executeTakeFirst();
    if (!member || member.status !== 'active' || member.membershipType !== 'staff') {
      errors.push({ field: 'ownerMembershipId', code: 'not-found', message: 'Choose an active staff member.' });
      return null;
    }
    return member.id;
  }

  /** Calling code of the office's country, else the company's headquarters country. */
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

  private email(value: string, errors: FieldError[]): string | null {
    if (!isEmail(value)) {
      errors.push({ field: 'primaryEmail', code: 'invalid', message: 'Enter an email address like name@example.com.' });
      return null;
    }
    return normaliseEmail(value);
  }

  private phone(value: string, callingCode: string | null, errors: FieldError[]): string | null {
    const normalised = normalisePhone(value, callingCode);
    if (normalised === null) errors.push({ field: 'primaryPhone', code: 'invalid', message: 'Enter a phone number, with the country code if it is from another country.' });
    return normalised;
  }

  private async checkReferences(
    tx: Tx,
    ctx: TenantContext,
    body: Partial<Pick<CreateContactBody, 'preferredLocaleCode' | 'nationalityCountryCode' | 'residenceCountryCode' | 'sourceCode'>>,
    officeId: string | null,
    errors: FieldError[],
  ): Promise<void> {
    if (body.preferredLocaleCode) {
      const locale = await tx.selectFrom('locales').select('code').where('code', '=', body.preferredLocaleCode).executeTakeFirst();
      if (!locale) errors.push({ field: 'preferredLocaleCode', code: 'unknown-code', message: 'This language is not supported.' });
    }
    for (const field of ['nationalityCountryCode', 'residenceCountryCode'] as const) {
      const code = body[field];
      if (code) {
        const country = await tx.selectFrom('countries').select('code').where('code', '=', code).executeTakeFirst();
        if (!country) errors.push({ field, code: 'unknown-code', message: 'Choose a country from the list.' });
      }
    }
    if (body.sourceCode) {
      const country = officeId
        ? await tx.selectFrom('offices').select('countryCode').where('id', '=', officeId).executeTakeFirst()
        : await tx.selectFrom('companies').select('headquartersCountryCode as countryCode').where('id', '=', ctx.companyId).executeTakeFirst();
      const error = await checkPicklistCode(tx, 'lead_source', body.sourceCode, country?.countryCode ?? '', 'sourceCode');
      if (error) errors.push(error);
    }
  }
}

// --------------------------------------------------------------------- helpers

/**
 * The latest identity check of each contact, with its effective status
 * (a verified check past its expiry date reads as expired).
 */
export async function latestIdentityChecks(tx: Tx, contactIds: string[]): Promise<Map<string, { status: string; reviewedAt: string | null }>> {
  const result = new Map<string, { status: string; reviewedAt: string | null }>();
  if (contactIds.length === 0) return result;
  const { rows } = await sql<{ contactId: string; status: string; reviewedAt: Date | null }>`
    select distinct on (k.contact_id) k.contact_id, ${effectiveKycStatusSql('k')} as status, k.reviewed_at
      from kyc_checks k
     where k.contact_id = any(${contactIds}::uuid[]) and k.check_type = 'identity'
     order by k.contact_id, k.created_at desc, k.id desc`.execute(tx);
  for (const row of rows) result.set(row.contactId, { status: row.status, reviewedAt: row.reviewedAt?.toISOString() ?? null });
  return result;
}

/** Stored status, except that a verified check past its expiry date is expired. */
export function effectiveKycStatusSql(alias: string) {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<string>`case when ${column('status')} = 'verified' and ${column('expiresOn')} < current_date then 'expired' else ${column('status')} end`;
}

function canUse(ctx: TenantContext, permission: string, row: { officeId: string | null; ownerMembershipId: string | null }): boolean {
  const scope = scopeFor(ctx, permission);
  return scope !== null && contactWithinScope(scope, ctx, row);
}

export function assertEditable(row: { archivedAt: Date | null; isAnonymised: boolean; mergedIntoContactId: string | null }): void {
  if (row.mergedIntoContactId !== null) throw Problems.businessRule('This contact was merged into another contact. Edit that contact instead.');
  if (row.isAnonymised) throw Problems.businessRule('This contact has been anonymised and cannot be edited.');
  if (row.archivedAt !== null) throw Problems.businessRule('Archived contacts cannot be edited. Restore the contact first.');
}

function checkBirthDate(value: string, errors: FieldError[]): void {
  const date = new Date(`${value}T00:00:00Z`);
  const valid = !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  if (!valid || value < '1900-01-01' || date.getTime() > Date.now()) {
    errors.push({ field: 'dateOfBirth', code: 'invalid', message: 'Enter a real date of birth, not in the future.' });
  }
}

function checkConsents(consents: ConsentInput[], prefix: string | null, errors: FieldError[]): void {
  consents.forEach((consent, index) => {
    const field = (name: string) => (prefix === null ? name : `${prefix}[${index}].${name}`);
    if (consent.status === 'granted' && !consent.lawfulBasis) {
      errors.push({ field: field('lawfulBasis'), code: 'required', message: 'Record the lawful basis for this consent.' });
    }
    if (consent.status === 'withdrawn' && consent.lawfulBasis) {
      errors.push({ field: field('lawfulBasis'), code: 'not-applicable', message: 'A withdrawal has no lawful basis.' });
    }
    if (consent.capturedAt !== undefined && new Date(consent.capturedAt).getTime() > Date.now() + 60_000) {
      errors.push({ field: field('capturedAt'), code: 'in-future', message: 'Consent cannot be recorded for a future time.' });
    }
  });
}

function protectedFieldNames(body: Partial<Pick<CreateContactBody, 'dateOfBirth' | 'taxNumber' | 'organisationRegNumber'>>): string[] {
  return (['dateOfBirth', 'taxNumber', 'organisationRegNumber'] as const).filter((name) => body[name] !== undefined);
}

function auditChanges(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { old: unknown; new: unknown }> {
  const strip = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !NOT_AUDITED.has(key)));
  return diffForAudit(strip(before), strip(after)) ?? {};
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return false;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export async function newId(tx: Tx): Promise<string> {
  const { rows } = await sql<{ id: string }>`select app.uuid_v7() as id`.execute(tx);
  const id = rows[0]?.id;
  if (id === undefined) throw Problems.internal();
  return id;
}

/**
 * Search as one id list built from indexed lookups (full-text, trigram name
 * and native-script name, reference prefix, phone digits), so a search over
 * a large register never evaluates subqueries per contact.
 */
function searchCondition(q: string) {
  const normalised = searchNormalise(q);
  const digits = q.replace(/[^0-9]/g, '');
  const arms = [
    sql`select id from contacts where search_vector @@ plainto_tsquery('simple', ${normalised})`,
    sql`select id from contacts where display_name ilike ${`%${escapeLike(q)}%`}`,
    sql`select id from contacts where display_name_local is not null and app.search_normalise(display_name_local) like ${`%${escapeLike(normalised)}%`}`,
  ];
  if (/^[a-z]{2,6}-/i.test(q)) arms.push(sql`select id from contacts where reference ilike ${`${escapeLike(q)}%`}`);
  if (digits.length >= 6) arms.push(sql`select contact_id as id from contact_methods where normalised like ${`%${digits.replace(/^0+/, '')}%`}`);
  return sql<boolean>`c.id in (${sql.join(arms, sql` union `)})`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function toMethodDto(row: { id: string; methodType: string; value: string; label: string | null; isPrimary: boolean; verifiedAt: Date | null; optedOutAt: Date | null }): MethodDto {
  return {
    id: row.id,
    methodType: row.methodType,
    value: row.value,
    label: row.label,
    isPrimary: row.isPrimary,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    optedOutAt: row.optedOutAt?.toISOString() ?? null,
  };
}

export function toConsentDto(row: {
  id: string;
  purpose: string;
  channel: string | null;
  status: string;
  lawfulBasis: string | null;
  capturedAt: Date;
  capturedVia: string;
  evidence: string | null;
  capturedBy: string | null;
}): ConsentDto {
  return {
    id: row.id,
    purpose: row.purpose,
    channel: row.channel,
    status: row.status,
    lawfulBasis: row.lawfulBasis,
    capturedAt: row.capturedAt.toISOString(),
    capturedVia: row.capturedVia,
    evidence: row.evidence,
    capturedByMembershipId: row.capturedBy,
  };
}
