import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { KycQueueContactDto } from '../contacts/kyc.dto.js';
import { RefLabelDto } from '../contacts/dto.js';
import { PageDto } from '../properties/dto.js';

export const REQUEST_TYPES = ['access', 'erasure'] as const;
export const REQUEST_STATUSES = ['received', 'verifying', 'in_progress', 'completed', 'refused', 'withdrawn'] as const;
export const OPEN_REQUEST_STATUSES = ['received', 'verifying', 'in_progress'] as const;
export const REQUEST_CHANNELS = ['email', 'phone', 'in_person', 'post', 'web_form', 'other'] as const;
export const IDENTITY_METHODS = ['documents_seen', 'known_contact_details', 'email_confirmation', 'other'] as const;
export const EVIDENCE_KINDS = ['request', 'identity', 'correspondence', 'response', 'other'] as const;
export const EVENT_TYPES = [
  'created', 'status_changed', 'assigned', 'identity_verified', 'due_extended',
  'evidence_added', 'access_report_generated', 'erasure_carried_out', 'erasure_blocked',
] as const;
/** Statuses a member can move a request to directly; completing an erasure is done by carrying it out. */
export const SETTABLE_STATUSES = ['verifying', 'in_progress', 'completed', 'refused', 'withdrawn'] as const;

/** Days from receipt to the due date (one month; decision G3-D3, pending #20 per market). */
export const RESPONSE_DAYS = 30;
/** How far a due date can be extended beyond the original (decision G3-D3). */
export const MAX_EXTENSION_DAYS = 60;

export type RequestType = (typeof REQUEST_TYPES)[number];
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------------ requests

export class CreatePrivacyRequestBody {
  @ApiProperty({ format: 'uuid', description: 'The person the request is about' }) @IsUUID() contactId!: string;
  @ApiProperty({ enum: REQUEST_TYPES }) @IsIn(REQUEST_TYPES) requestType!: RequestType;
  @ApiProperty({ enum: REQUEST_CHANNELS }) @IsIn(REQUEST_CHANNELS) channel!: (typeof REQUEST_CHANNELS)[number];
  @ApiProperty({ format: 'date', description: 'When the request reached the company (not in the future); the due date counts from it' })
  @Matches(DATE)
  receivedOn!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'Member who handles it (must be allowed to manage requests)' })
  @ValidateIf(notNull) @IsUUID()
  assignedTo?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 1000,
    description: 'Summary of the request as received, recorded as the first evidence entry. Do not copy ID or bank numbers.',
  })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000)
  summary?: string | null;
}

export class AssignPrivacyRequestBody {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) @ValidateIf(notNull) @IsUUID() assignedTo!: string | null;
}

export class VerifyIdentityBody {
  @ApiProperty({ enum: IDENTITY_METHODS }) @IsIn(IDENTITY_METHODS) method!: (typeof IDENTITY_METHODS)[number];
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000, description: 'What was seen or confirmed (recorded as identity evidence). No document numbers.' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000)
  note?: string | null;
}

export class ChangePrivacyRequestStatusBody {
  @ApiProperty({ enum: SETTABLE_STATUSES }) @IsIn(SETTABLE_STATUSES) status!: (typeof SETTABLE_STATUSES)[number];
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000, description: 'Required when refusing or recording a withdrawal' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000)
  note?: string | null;
}

export class ExtendPrivacyRequestBody {
  @ApiProperty({ format: 'date', description: `New due date: after the current one, at most ${MAX_EXTENSION_DAYS} days after it` })
  @Matches(DATE)
  extendedDueOn!: string;
  @ApiProperty({ minLength: 10, maxLength: 500, description: 'Why more time is needed (told to the requester)' })
  @Transform(trim) @IsString() @MinLength(10) @MaxLength(500)
  reason!: string;
}

export class AddEvidenceBody {
  @ApiProperty({ enum: EVIDENCE_KINDS }) @IsIn(EVIDENCE_KINDS) kind!: (typeof EVIDENCE_KINDS)[number];
  @ApiProperty({ minLength: 3, maxLength: 1000, description: 'What was received or sent. Do not copy ID or bank numbers.' })
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000)
  summary!: string;
  @ApiProperty({ format: 'date' }) @Matches(DATE) receivedOn!: string;
}

export class CarryOutErasureBody {
  @ApiProperty({ example: 'ERASE', description: 'Type ERASE to confirm; erasure cannot be undone' })
  @IsString() @IsIn(['ERASE'])
  confirm!: 'ERASE';
}

export class GenerateAccessReportBody {
  @ApiPropertyOptional({ description: 'Unused; present so the request has a body' }) @IsOptional() @IsString() @MaxLength(1) note?: string;
}

// --------------------------------------------------------------------- views

export class PrivacyRequestSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: REQUEST_TYPES }) requestType!: RequestType;
  @ApiProperty({ enum: REQUEST_STATUSES }) status!: RequestStatus;
  @ApiProperty({ enum: REQUEST_CHANNELS }) channel!: string;
  @ApiProperty({ type: KycQueueContactDto }) contact!: KycQueueContactDto;
  @ApiProperty({ format: 'date' }) receivedOn!: string;
  @ApiProperty({ format: 'date', description: 'The due date in force (extended if it was extended)' }) dueOn!: string;
  @ApiProperty({ description: 'Open and past its due date' }) overdue!: boolean;
  @ApiProperty({ type: Number, nullable: true, description: 'Days until the due date (negative when overdue); null once closed' }) daysLeft!: number | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) assignedTo!: RefLabelDto | null;
  @ApiProperty({ description: 'The requester\'s identity has been verified' }) identityVerified!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) closedAt!: string | null;
  @ApiProperty() version!: number;
}

export class PrivacyRequestPageDto {
  @ApiProperty({ type: [PrivacyRequestSummaryDto] }) data!: PrivacyRequestSummaryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class PrivacyRequestEventDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: EVENT_TYPES }) eventType!: (typeof EVENT_TYPES)[number];
  @ApiProperty({ enum: REQUEST_STATUSES, nullable: true }) fromStatus!: RequestStatus | null;
  @ApiProperty({ enum: REQUEST_STATUSES, nullable: true }) toStatus!: RequestStatus | null;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Codes and ids only (assignee, method, new due date, counts, blocker codes)' })
  detail!: Record<string, unknown>;
  @ApiProperty({ type: RefLabelDto, nullable: true }) actor!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
}

export class PrivacyRequestEvidenceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: EVIDENCE_KINDS }) kind!: (typeof EVIDENCE_KINDS)[number];
  @ApiProperty() summary!: string;
  @ApiProperty({ format: 'date' }) receivedOn!: string;
  @ApiProperty({ type: RefLabelDto }) recordedBy!: RefLabelDto;
  @ApiProperty({ format: 'date-time' }) recordedAt!: string;
}

export class AccessReportDto {
  @ApiProperty({ format: 'uuid', description: 'Export id: download with POST /api/v1/exports/{id}/download (the member who generated it, within 24 hours)' })
  exportId!: string;
  @ApiProperty({ enum: ['completed', 'expired'] }) status!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty() canDownload!: boolean;
}

export class PrivacyRequestDto extends PrivacyRequestSummaryDto {
  @ApiProperty({ format: 'date', description: 'The original due date' }) originalDueOn!: string;
  @ApiProperty({ type: String, nullable: true }) extensionReason!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) identityVerifiedAt!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) identityVerifiedBy!: RefLabelDto | null;
  @ApiProperty({ enum: IDENTITY_METHODS, nullable: true }) identityMethod!: string | null;
  @ApiProperty({ type: String, nullable: true }) outcomeNote!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) closedBy!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto }) createdBy!: RefLabelDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Erasure ledger entry, once carried out' }) erasureLedgerEntryId!: string | null;
  @ApiProperty({ type: AccessReportDto, nullable: true }) accessReport!: AccessReportDto | null;
  @ApiProperty({ type: [String], description: 'For an open erasure request: why the person cannot be erased now (codes)' })
  erasureBlockers!: string[];
  @ApiProperty({ type: [PrivacyRequestEvidenceDto] }) evidence!: PrivacyRequestEvidenceDto[];
  @ApiProperty({ type: [PrivacyRequestEventDto] }) history!: PrivacyRequestEventDto[];
  @ApiProperty({ type: [String], enum: SETTABLE_STATUSES, description: 'Statuses this member can move the request to now' })
  nextStatuses!: (typeof SETTABLE_STATUSES)[number][];
  @ApiProperty() canManage!: boolean;
  @ApiProperty({ description: 'Can carry out the erasure or generate the access report now' }) canFulfil!: boolean;
}

export class AssignableMemberDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}
