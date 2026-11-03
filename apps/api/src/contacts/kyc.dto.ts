import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { RefLabelDto } from './dto.js';

export const CHECK_TYPES = ['identity', 'address', 'source_of_funds', 'sanctions_pep', 'company_ownership'] as const;
export const CHECK_STATUSES = ['pending', 'in_review', 'verified', 'failed', 'expired'] as const;
export const OPEN_CHECK_STATUSES = ['pending', 'in_review'] as const;
export const RISK_RATINGS = ['low', 'medium', 'high'] as const;

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Letters, digits and the separators printed on documents. */
const DOCUMENT_NUMBER = /^[\p{L}\p{N}][\p{L}\p{N} \-./]*$/u;

// ------------------------------------------------------------ identity documents

export class CreateIdentityDocumentBody {
  @ApiProperty({ example: 'ghana_card', description: 'Code from the id_document_type picklist for the issuing country' })
  @Matches(/^[a-z][a-z0-9_]*$/)
  documentTypeCode!: string;
  @ApiProperty({ example: 'GH' }) @Matches(/^[A-Z]{2}$/) issuingCountryCode!: string;
  @ApiProperty({
    minLength: 3,
    maxLength: 40,
    description: 'Document number. Encrypted at rest; never returned (reveal needs contact.view_sensitive and a recent second factor).',
  })
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(40) @Matches(DOCUMENT_NUMBER)
  documentNumber!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' }) @ValidateIf(notNull) @Matches(DATE) issuedOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' }) @ValidateIf(notNull) @Matches(DATE) expiresOn?: string | null;
  @ApiPropertyOptional({ description: 'Record the document even though another contact has the same number' })
  @IsOptional() @IsBoolean()
  confirmNotDuplicate?: boolean;
}

export class UpdateIdentityDocumentBody {
  @ApiPropertyOptional({ example: 'passport' }) @IsOptional() @Matches(/^[a-z][a-z0-9_]*$/) documentTypeCode?: string;
  @ApiPropertyOptional({ example: 'GH' }) @IsOptional() @Matches(/^[A-Z]{2}$/) issuingCountryCode?: string;
  @ApiPropertyOptional({ minLength: 3, maxLength: 40, description: 'A corrected number (re-encrypted)' })
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(40) @Matches(DOCUMENT_NUMBER)
  documentNumber?: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' }) @ValidateIf(notNull) @Matches(DATE) issuedOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' }) @ValidateIf(notNull) @Matches(DATE) expiresOn?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() confirmNotDuplicate?: boolean;
}

export class ArchiveIdentityDocumentBody {
  @ApiProperty({ minLength: 3, maxLength: 500, example: 'Replaced by a renewed passport' })
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}

export class VerificationDto {
  @ApiProperty({ format: 'date-time' }) at!: string;
  @ApiProperty({ type: RefLabelDto }) by!: RefLabelDto;
}

export class IdentityDocumentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() documentTypeCode!: string;
  @ApiProperty() issuingCountryCode!: string;
  @ApiProperty({ example: '4821', description: 'Last characters of the number, for recognising the document' }) numberLast4!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) issuedOn!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) expiresOn!: string | null;
  @ApiProperty({ description: 'The expiry date has passed' }) expired!: boolean;
  @ApiProperty({ type: VerificationDto, nullable: true, description: 'Set when an identity check using this document is signed off as verified' })
  verified!: VerificationDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedReason!: string | null;
  @ApiProperty({ description: 'You may correct this document (kyc.manage; not verified or archived)' }) canEdit!: boolean;
  @ApiProperty({ description: 'You may reveal the number (contact.view_sensitive, with a recent second factor)' }) canReveal!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

// --------------------------------------------------------------------- KYC checks

export class CreateKycCheckBody {
  @ApiProperty({ enum: CHECK_TYPES }) @IsIn(CHECK_TYPES) checkType!: (typeof CHECK_TYPES)[number];
  @ApiPropertyOptional({ enum: OPEN_CHECK_STATUSES, default: 'pending' }) @IsOptional() @IsIn(OPEN_CHECK_STATUSES) status?: 'pending' | 'in_review';
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'The identity document examined' })
  @ValidateIf(notNull) @IsUUID()
  identityDocumentId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100, description: 'Who ran the check, if not your company' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  provider?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200)
  providerReference?: string | null;
  @ApiPropertyOptional({ enum: RISK_RATINGS, nullable: true }) @ValidateIf(notNull) @IsIn(RISK_RATINGS) riskRating?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date', description: 'When the result should be renewed' })
  @ValidateIf(notNull) @Matches(DATE)
  expiresOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: 'Do not record ID or bank numbers here' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000)
  notes?: string | null;
}

export class UpdateKycCheckBody {
  @ApiPropertyOptional({ enum: OPEN_CHECK_STATUSES }) @IsOptional() @IsIn(OPEN_CHECK_STATUSES) status?: 'pending' | 'in_review';
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' }) @ValidateIf(notNull) @IsUUID() identityDocumentId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  provider?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200)
  providerReference?: string | null;
  @ApiPropertyOptional({ enum: RISK_RATINGS, nullable: true }) @ValidateIf(notNull) @IsIn(RISK_RATINGS) riskRating?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' }) @ValidateIf(notNull) @Matches(DATE) expiresOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000)
  notes?: string | null;
}

export class ApproveKycCheckBody {
  @ApiProperty({ enum: RISK_RATINGS, description: 'Required when signing off a check as verified' }) @IsIn(RISK_RATINGS) riskRating!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date', description: 'When the check should be renewed' })
  @ValidateIf(notNull) @Matches(DATE)
  expiresOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 3, maxLength: 1000 })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000)
  reason?: string | null;
}

export class RejectKycCheckBody {
  @ApiProperty({ minLength: 3, maxLength: 1000, example: 'Name on the passport does not match the sale contract' })
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000)
  reason!: string;
  @ApiPropertyOptional({ enum: RISK_RATINGS, nullable: true }) @ValidateIf(notNull) @IsIn(RISK_RATINGS) riskRating?: string | null;
}

export class KycDocumentRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() documentTypeCode!: string;
  @ApiProperty() numberLast4!: string;
}

export class KycCheckDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: CHECK_TYPES }) checkType!: string;
  @ApiProperty({ enum: CHECK_STATUSES, description: 'A verified check past its expiry date reads as expired' }) status!: string;
  @ApiProperty({ enum: RISK_RATINGS, nullable: true }) riskRating!: string | null;
  @ApiProperty({ type: String, nullable: true }) provider!: string | null;
  @ApiProperty({ type: String, nullable: true }) providerReference!: string | null;
  @ApiProperty({ type: KycDocumentRefDto, nullable: true }) identityDocument!: KycDocumentRefDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) recordedBy!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) reviewedBy!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) reviewedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) expiresOn!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The reviewer’s reason' }) decisionReason!: string | null;
  @ApiProperty({ description: 'You may edit this open check (kyc.manage)' }) canEdit!: boolean;
  @ApiProperty({ description: 'You may sign this open check off (kyc.approve)' }) canDecide!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}
