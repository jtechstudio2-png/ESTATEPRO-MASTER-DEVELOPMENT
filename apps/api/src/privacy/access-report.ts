import { sql } from 'kysely';

import type { TenantContext } from '../common/request-context.js';
import type { SensitiveDataService } from '../crypto/sensitive-data.service.js';
import type { Tx } from '../database/database.module.js';

/**
 * The access report for a data-subject access request (gap G3): everything
 * the company holds about one person, in one JSON document, including the
 * protected values (decrypted for this purpose only; the generation is
 * audited and needs privacy.fulfil with a recent second factor). Records
 * merged into the person are included. Internal keys, hashes and ciphertext
 * are never included.
 */
export interface AccessReport {
  format: 'estatepro.subject-access-report';
  formatVersion: 1;
  generatedAt: string;
  request: { reference: string; receivedOn: string };
  notes: string[];
  person: Record<string, unknown>;
  protectedDetails: { dateOfBirth: string | null; taxNumber: string | null; registrationNumber: string | null };
  mergedRecords: Record<string, unknown>[];
  contactMethods: Record<string, unknown>[];
  roles: Record<string, unknown>[];
  consents: Record<string, unknown>[];
  identityDocuments: Record<string, unknown>[];
  identityChecks: Record<string, unknown>[];
  requirements: Record<string, unknown>[];
  leads: Record<string, unknown>[];
  activities: Record<string, unknown>[];
  followUps: Record<string, unknown>[];
  privacyRequests: Record<string, unknown>[];
}

export interface AccessReportResult {
  report: AccessReport;
  /** Rows included, for the export record. */
  rowCount: number;
  /** Which protected values were decrypted into the report (for the audit row). */
  protectedFields: string[];
}

export async function buildAccessReport(
  tx: Tx,
  ctx: TenantContext,
  sensitive: SensitiveDataService,
  contactId: string,
  request: { reference: string; receivedOn: string },
): Promise<AccessReportResult> {
  const subjects = (
    await tx.selectFrom('contacts').select('id').where((eb) => eb.or([eb('id', '=', contactId), eb('mergedIntoContactId', '=', contactId)])).execute()
  ).map((row) => row.id);
  const contacts = await tx
    .selectFrom('contacts as c')
    .leftJoin('addresses as a', (join) => join.onRef('a.companyId', '=', 'c.companyId').onRef('a.id', '=', 'c.addressId'))
    .select([
      'c.id', 'c.reference', 'c.contactType', 'c.displayName', 'c.displayNameLocal', 'c.givenName', 'c.familyName', 'c.otherNames', 'c.title',
      'c.organisationName', 'c.primaryEmail', 'c.primaryPhoneE164', 'c.preferredLocaleCode', 'c.preferredChannel', 'c.nationalityCountryCode',
      'c.residenceCountryCode', 'c.sourceCode', 'c.notes', 'c.customFields', 'c.isAnonymised', 'c.mergedIntoContactId', 'c.archivedAt',
      'c.createdAt', 'c.updatedAt', 'c.dateOfBirthEncrypted', 'c.taxNumberEncrypted', 'c.organisationRegNumberEncrypted', 'a.formatted as address',
    ])
    .where('c.id', 'in', subjects)
    .orderBy('c.createdAt')
    .execute();
  const main = contacts.find((row) => row.id === contactId);
  if (!main) throw new Error(`contact ${contactId} not found`);

  const protectedFields: string[] = [];
  const open = async (column: string, value: Buffer | null, field: string): Promise<string | null> => {
    if (value === null) return null;
    protectedFields.push(field);
    return sensitive.open(tx, ctx, { table: 'contacts', column, rowId: contactId }, value);
  };
  const protectedDetails = {
    dateOfBirth: await open('date_of_birth_encrypted', main.dateOfBirthEncrypted, 'dateOfBirth'),
    taxNumber: await open('tax_number_encrypted', main.taxNumberEncrypted, 'taxNumber'),
    registrationNumber: await open('organisation_reg_number_encrypted', main.organisationRegNumberEncrypted, 'organisationRegNumber'),
  };
  const person = (row: (typeof contacts)[number]) => ({
    reference: row.reference,
    contactType: row.contactType,
    displayName: row.displayName,
    displayNameLocal: row.displayNameLocal,
    givenName: row.givenName,
    familyName: row.familyName,
    otherNames: row.otherNames,
    title: row.title,
    organisationName: row.organisationName,
    email: row.primaryEmail,
    phone: row.primaryPhoneE164,
    preferredLanguage: row.preferredLocaleCode,
    preferredChannel: row.preferredChannel,
    nationality: row.nationalityCountryCode,
    countryOfResidence: row.residenceCountryCode,
    address: row.address,
    source: row.sourceCode,
    notes: row.notes,
    customFields: row.customFields,
    anonymised: row.isAnonymised,
    archivedAt: iso(row.archivedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });

  const contactMethods = await tx
    .selectFrom('contactMethods')
    .select(['methodType', 'value', 'label', 'isPrimary', 'optedOutAt', 'createdAt'])
    .where('contactId', 'in', subjects)
    .orderBy('createdAt')
    .execute();
  const roles = await tx.selectFrom('contactRelationships').select(['relationshipType', 'status', 'startedOn', 'endedOn']).where('contactId', 'in', subjects).execute();
  const consents = await tx
    .selectFrom('consents')
    .select(['purpose', 'channel', 'status', 'lawfulBasis', 'capturedAt', 'capturedVia', 'evidence'])
    .where('contactId', 'in', subjects)
    .orderBy('capturedAt')
    .orderBy('entryNo')
    .execute();

  const documentRows = await tx
    .selectFrom('identityDocuments')
    .select(['id', 'documentTypeCode', 'issuingCountryCode', 'numberEncrypted', 'issuedOn', 'expiresOn', 'verifiedAt', 'archivedAt', 'erasedAt', 'createdAt'])
    .where('contactId', 'in', subjects)
    .orderBy('createdAt')
    .execute();
  const identityDocuments: Record<string, unknown>[] = [];
  for (const document of documentRows) {
    let number: string | null = null;
    if (document.numberEncrypted !== null) {
      number = await sensitive.open(tx, ctx, { table: 'identity_documents', column: 'number_encrypted', rowId: document.id }, document.numberEncrypted);
      protectedFields.push('documentNumber');
    }
    identityDocuments.push({
      type: document.documentTypeCode,
      issuingCountry: document.issuingCountryCode,
      number,
      issuedOn: document.issuedOn,
      expiresOn: document.expiresOn,
      verifiedAt: iso(document.verifiedAt),
      archivedAt: iso(document.archivedAt),
      erasedAt: iso(document.erasedAt),
    });
  }
  const identityChecks = await tx
    .selectFrom('kycChecks')
    .select(['checkType', 'status', 'riskRating', 'provider', 'reviewedAt', 'expiresOn', 'notes', 'decisionReason', 'createdAt'])
    .where('contactId', 'in', subjects)
    .orderBy('createdAt')
    .orderBy('entryNo')
    .execute();
  const requirements = await tx
    .selectFrom('requirements')
    .select(['requirementType', 'status', 'currencyCode', 'minPrice', 'maxPrice', 'rentFrequency', 'minBedrooms', 'maxBedrooms', 'moveBy', 'financingStatus', 'notes', 'createdAt'])
    .where('contactId', 'in', subjects)
    .orderBy('createdAt')
    .execute();
  const leadRows = await tx
    .selectFrom('leads')
    .select(['id', 'reference', 'leadType', 'status', 'sourceCode', 'sourceDetail', 'campaign', 'message', 'receivedAt', 'lostReasonCode'])
    .where('contactId', 'in', subjects)
    .orderBy('receivedAt')
    .execute();
  const leadIds = leadRows.map((row) => row.id);
  const { rows: activities } = await sql<Record<string, unknown>>`
    select a.activity_type as "type", a.direction, a.subject, a.body, a.occurred_at as "occurredAt", a.outcome_code as "outcome"
      from activities a
     where a.archived_at is null and exists (
       select 1 from activity_links l where l.activity_id = a.id
          and ((l.entity_type = 'contact' and l.entity_id = any(${subjects}::uuid[]))
            or (l.entity_type = 'lead' and l.entity_id = any(${leadIds.length > 0 ? leadIds : [contactId]}::uuid[]))))
     order by a.occurred_at, a.entry_no`.execute(tx);
  const followUps = await tx
    .selectFrom('tasks')
    .select(['title', 'description', 'taskType', 'status', 'dueAt', 'completedAt'])
    .where((eb) =>
      eb.or([
        eb.and([eb('entityType', '=', 'contact'), eb('entityId', 'in', subjects)]),
        ...(leadIds.length > 0 ? [eb.and([eb('entityType', '=', 'lead'), eb('entityId', 'in', leadIds)])] : []),
      ]),
    )
    .orderBy('dueAt')
    .execute();
  const privacyRequests = await tx
    .selectFrom('dataSubjectRequests')
    .select(['reference', 'requestType', 'status', 'receivedOn', 'closedAt'])
    .where('contactId', 'in', subjects)
    .orderBy('receivedOn')
    .execute();

  const leads = leadRows.map(({ id: _id, receivedAt, ...lead }) => ({ ...lead, receivedAt: iso(receivedAt) }));
  const report: AccessReport = {
    format: 'estatepro.subject-access-report',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    request,
    notes: [
      'This report lists the personal data the company holds about you in its property management system, including records merged into yours.',
      'Records the company keeps in other systems (accounts, email, documents) are reported separately.',
    ],
    person: person(main),
    protectedDetails,
    mergedRecords: contacts.filter((row) => row.id !== contactId).map(person),
    contactMethods: contactMethods.map(stamp),
    roles: roles.map(stamp),
    consents: consents.map(stamp),
    identityDocuments,
    identityChecks: identityChecks.map(stamp),
    requirements: requirements.map(stamp),
    leads,
    activities: activities.map(stamp),
    followUps: followUps.map(stamp),
    privacyRequests: privacyRequests.map(stamp),
  };
  const rowCount =
    contacts.length + contactMethods.length + roles.length + consents.length + identityDocuments.length + identityChecks.length + requirements.length +
    leads.length + activities.length + followUps.length + privacyRequests.length;
  return { report, rowCount, protectedFields: [...new Set(protectedFields)] };
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Dates as ISO strings; everything else as stored. */
function stamp<T extends object>(row: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}
