import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsObject,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { PageDto } from '../properties/dto.js';

export const CONTACT_TYPES = ['person', 'organisation'] as const;
export const RELATIONSHIP_TYPES = ['buyer', 'seller', 'landlord', 'tenant', 'applicant', 'guarantor', 'supplier', 'developer', 'investor', 'other'] as const;
export const CHANNELS = ['email', 'phone', 'sms', 'whatsapp', 'post'] as const;
export const METHOD_TYPES = ['email', 'phone', 'mobile', 'whatsapp', 'fax', 'website', 'other'] as const;
export const CONSENT_PURPOSES = ['marketing', 'property_alerts', 'data_processing', 'third_party_sharing', 'portal_terms'] as const;
export const CONSENT_CHANNELS = ['email', 'sms', 'whatsapp', 'phone', 'post', 'any'] as const;
export const LAWFUL_BASES = ['consent', 'contract', 'legal_obligation', 'legitimate_interest'] as const;
export const CAPTURED_VIA = ['web_form', 'portal', 'verbal', 'paper', 'import', 'email'] as const;

const provided = (_object: unknown, value: unknown) => value !== undefined;
const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ConsentInput {
  @ApiProperty({ enum: CONSENT_PURPOSES }) @IsIn(CONSENT_PURPOSES) purpose!: (typeof CONSENT_PURPOSES)[number];
  @ApiProperty({ enum: CONSENT_CHANNELS }) @IsIn(CONSENT_CHANNELS) channel!: (typeof CONSENT_CHANNELS)[number];
  @ApiProperty({ enum: ['granted', 'withdrawn'] }) @IsIn(['granted', 'withdrawn']) status!: 'granted' | 'withdrawn';
  @ApiPropertyOptional({ enum: LAWFUL_BASES, description: 'Required when granted' })
  @ValidateIf(notNull) @IsIn(LAWFUL_BASES)
  lawfulBasis?: (typeof LAWFUL_BASES)[number] | null;
  @ApiProperty({ enum: CAPTURED_VIA }) @IsIn(CAPTURED_VIA) capturedVia!: (typeof CAPTURED_VIA)[number];
  @ApiPropertyOptional({ maxLength: 500, description: 'Where the evidence is, e.g. "signed form, file 2026/031"' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(500)
  evidence?: string | null;
  @ApiPropertyOptional({ format: 'date-time', description: 'When it was given (defaults to now; never in the future)' })
  @ValidateIf(provided) @IsISO8601({ strict: true })
  capturedAt?: string;
}

/** Fields shared by create and update. Null clears a value on update. */
class ContactFieldsBase {
  @ApiPropertyOptional({ maxLength: 200 }) @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) displayName?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200, description: 'Name in its own script, e.g. Arabic' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200)
  displayNameLocal?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) givenName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) familyName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) otherNames?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 50 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(50) title?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) organisationName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 50, description: 'Persons: stored encrypted and never returned (reveal only). Organisations: public register number' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(50)
  organisationRegNumber?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 50, description: 'Persons: stored encrypted and never returned (reveal only). Organisations: public tax number' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(50)
  taxNumber?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date', description: 'Stored encrypted and never returned (reveal only)' })
  @ValidateIf(notNull) @Matches(DATE)
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 254 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(254) primaryEmail?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 30, description: 'Any format; national numbers use the office country' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(30)
  primaryPhone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'en' }) @ValidateIf(notNull) @IsString() @MaxLength(10) preferredLocaleCode?: string | null;
  @ApiPropertyOptional({ enum: CHANNELS, nullable: true }) @ValidateIf(notNull) @IsIn(CHANNELS) preferredChannel?: (typeof CHANNELS)[number] | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'GH' }) @ValidateIf(notNull) @Matches(/^[A-Z]{2}$/) nationalityCountryCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'GH' }) @ValidateIf(notNull) @Matches(/^[A-Z]{2}$/) residenceCountryCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' }) @ValidateIf(notNull) @IsUUID() officeId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'Responsible staff member' }) @ValidateIf(notNull) @IsUUID() ownerMembershipId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Picklist lead_source' }) @ValidateIf(notNull) @IsString() @MaxLength(60) sourceCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000, description: 'Do not record ID or bank numbers here (ADR-007)' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(4000)
  notes?: string | null;

  @ApiPropertyOptional({ description: 'Save even though possible duplicates were found (the choice is audited)' })
  @IsOptional() @IsBoolean()
  confirmNotDuplicate?: boolean;
}

export class CreateContactBody extends ContactFieldsBase {
  @ApiProperty({ enum: CONTACT_TYPES }) @IsIn(CONTACT_TYPES) contactType!: (typeof CONTACT_TYPES)[number];
  @ApiProperty({ maxLength: 200 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) declare displayName: string;

  @ApiPropertyOptional({ enum: RELATIONSHIP_TYPES, isArray: true }) @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(10) @IsIn(RELATIONSHIP_TYPES, { each: true })
  relationships?: (typeof RELATIONSHIP_TYPES)[number][];

  @ApiPropertyOptional({ type: [ConsentInput] }) @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ConsentInput)
  consents?: ConsentInput[];
}

export class UpdateContactBody extends ContactFieldsBase {}

export class ArchiveContactBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class DuplicateCheckBody {
  @ApiPropertyOptional({ maxLength: 254 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(254) primaryEmail?: string | null;
  @ApiPropertyOptional({ maxLength: 30 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(30) primaryPhone?: string | null;
  @ApiPropertyOptional({ maxLength: 50, description: 'Tax number of a person (matched by keyed hash)' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(50)
  taxNumber?: string | null;
  @ApiPropertyOptional({ format: 'uuid', description: 'Office whose country completes national phone numbers' }) @ValidateIf(notNull) @IsUUID() officeId?: string | null;
  @ApiPropertyOptional({ format: 'uuid', description: 'Contact being edited (excluded from the results)' }) @ValidateIf(notNull) @IsUUID() excludeContactId?: string | null;
}

export class AddMethodBody {
  @ApiProperty({ enum: METHOD_TYPES }) @IsIn(METHOD_TYPES) methodType!: (typeof METHOD_TYPES)[number];
  @ApiProperty({ maxLength: 500 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) value!: string;
  @ApiPropertyOptional({ maxLength: 60 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) label?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class UpdateMethodBody {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) label?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
  @ApiPropertyOptional({ description: 'The person asked not to be contacted this way' }) @IsOptional() @IsBoolean() optedOut?: boolean;
  @ApiPropertyOptional({ description: 'The value was confirmed with the person' }) @IsOptional() @IsBoolean() verified?: boolean;
}

export class AddRelationshipBody {
  @ApiProperty({ enum: RELATIONSHIP_TYPES }) @IsIn(RELATIONSHIP_TYPES) relationshipType!: (typeof RELATIONSHIP_TYPES)[number];
}

export class EndRelationshipBody {
  @ApiPropertyOptional({ format: 'date', description: 'Defaults to today' }) @ValidateIf(provided) @Matches(DATE) endedOn?: string;
}

export const MERGE_FIELDS = [
  'displayName', 'displayNameLocal', 'givenName', 'familyName', 'otherNames', 'title', 'organisationName',
  'organisationRegNumber', 'taxNumber', 'dateOfBirth', 'primaryEmail', 'primaryPhone', 'preferredLocaleCode',
  'preferredChannel', 'nationalityCountryCode', 'residenceCountryCode', 'officeId', 'ownerMembershipId', 'sourceCode', 'notes',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export class MergeBody {
  @ApiProperty({ format: 'uuid', description: 'The contact merged into this one (it is archived and points here)' }) @IsUUID() mergeContactId!: string;
  @ApiProperty({ description: 'Version of the merged contact, as shown in the preview' }) @IsInt() @Min(1) mergeVersion!: number;
  @ApiPropertyOptional({
    description: `For each field, whose value to keep: "keep" (default) or "merge". Fields: ${MERGE_FIELDS.join(', ')}`,
    example: { primaryEmail: 'merge' },
  })
  @IsOptional() @IsObject()
  fields?: Partial<Record<MergeField, 'keep' | 'merge'>>;
}

// ---------------------------------------------------------------------- output

export class RefLabelDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class RelationshipDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: RELATIONSHIP_TYPES }) relationshipType!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: string;
  @ApiProperty({ format: 'date' }) startedOn!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) endedOn!: string | null;
}

export class MethodDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: METHOD_TYPES }) methodType!: string;
  @ApiProperty() value!: string;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) verifiedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) optedOutAt!: string | null;
}

export class ConsentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: CONSENT_PURPOSES }) purpose!: string;
  @ApiProperty({ enum: CONSENT_CHANNELS, nullable: true, type: String }) channel!: string | null;
  @ApiProperty({ enum: ['granted', 'withdrawn'] }) status!: string;
  @ApiProperty({ enum: LAWFUL_BASES, nullable: true, type: String }) lawfulBasis!: string | null;
  @ApiProperty({ format: 'date-time' }) capturedAt!: string;
  @ApiProperty({ enum: [...CAPTURED_VIA, 'merge'], description: '"merge": recorded when a merge kept a withdrawal in force' }) capturedVia!: string;
  @ApiProperty({ type: String, nullable: true }) evidence!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) capturedByMembershipId!: string | null;
}

export class ProtectedValueDto {
  @ApiProperty({ description: 'A value is recorded (reveal it with the reveal endpoint)' }) recorded!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Last characters, where stored' }) last4!: string | null;
}

/** Shown only to members with kyc.view on the contact (wireframe C-5). */
export class ContactProtectedDto {
  @ApiProperty({ type: ProtectedValueDto }) dateOfBirth!: ProtectedValueDto;
  @ApiProperty({ type: ProtectedValueDto }) taxNumber!: ProtectedValueDto;
  @ApiProperty({ type: ProtectedValueDto }) organisationRegNumber!: ProtectedValueDto;
}

export class ContactAccessDto {
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canArchive!: boolean;
  @ApiProperty() canMerge!: boolean;
  @ApiProperty() canReveal!: boolean;
}

export class ContactDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty({ enum: CONTACT_TYPES }) contactType!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ type: String, nullable: true }) displayNameLocal!: string | null;
  @ApiProperty({ type: String, nullable: true }) givenName!: string | null;
  @ApiProperty({ type: String, nullable: true }) familyName!: string | null;
  @ApiProperty({ type: String, nullable: true }) otherNames!: string | null;
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ type: String, nullable: true }) organisationName!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Organisations only' }) organisationRegNumber!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Organisations only' }) taxNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) primaryEmail!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'E.164' }) primaryPhone!: string | null;
  @ApiProperty({ type: String, nullable: true }) preferredLocaleCode!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: CHANNELS }) preferredChannel!: string | null;
  @ApiProperty({ type: String, nullable: true }) nationalityCountryCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) residenceCountryCode!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) office!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true, description: 'Responsible staff member (membership id)' }) owner!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true }) sourceCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: [RelationshipDto] }) relationships!: RelationshipDto[];
  @ApiProperty({ type: [MethodDto] }) methods!: MethodDto[];
  @ApiProperty({ type: [ConsentDto], description: 'Current state per purpose and channel' }) consents!: ConsentDto[];
  @ApiPropertyOptional({ type: ContactProtectedDto, description: 'Present only with kyc.view' }) protected?: ContactProtectedDto;
  @ApiProperty() isAnonymised!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Set when this contact was merged into another' }) mergedIntoContactId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedReason!: string | null;
  @ApiProperty({ type: ContactAccessDto }) access!: ContactAccessDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}

export class ContactSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty({ enum: CONTACT_TYPES }) contactType!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ type: String, nullable: true }) displayNameLocal!: string | null;
  @ApiProperty({ enum: RELATIONSHIP_TYPES, isArray: true, description: 'Active roles' }) roles!: string[];
  @ApiProperty({ type: String, nullable: true, description: 'Partly masked for lists' }) primaryPhoneMasked!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) owner!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) office!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class ContactPageDto {
  @ApiProperty({ type: [ContactSummaryDto] }) data!: ContactSummaryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class DuplicateCandidateDto {
  @ApiProperty({ description: 'False when the match is outside your access: no details are shown' }) visible!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) id!: string | null;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty({ type: String, nullable: true }) displayName!: string | null;
  @ApiProperty({ type: String, nullable: true }) ownerName!: string | null;
  @ApiProperty() archived!: boolean;
  @ApiProperty({ enum: ['email', 'phone', 'tax_number'], isArray: true }) matchedOn!: string[];
}

export class DuplicateCheckResultDto {
  @ApiProperty({ type: [DuplicateCandidateDto] }) candidates!: DuplicateCandidateDto[];
}

export class ConsentHistoryDto {
  @ApiProperty({ type: [ConsentDto], description: 'Every consent record, newest first' }) data!: ConsentDto[];
}

export class MergeSideDto {
  @ApiProperty({ type: ContactDto }) contact!: ContactDto;
  @ApiProperty({ description: 'Rows that reference this contact, per table', additionalProperties: { type: 'integer' } })
  references!: Record<string, number>;
}

export class MergePreviewDto {
  @ApiProperty({ type: MergeSideDto }) keep!: MergeSideDto;
  @ApiProperty({ type: MergeSideDto }) merge!: MergeSideDto;
  @ApiProperty({ type: [String], description: 'Reasons the merge cannot go ahead; empty when it can' }) blockers!: string[];
  @ApiProperty({ enum: MERGE_FIELDS, isArray: true }) choosableFields!: string[];
}

export class MergeResultDto {
  @ApiProperty({ type: ContactDto }) contact!: ContactDto;
  @ApiProperty({ description: 'Rows moved to the kept contact, per table', additionalProperties: { type: 'integer' } }) moved!: Record<string, number>;
}
