import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { CreateContactBody, RefLabelDto } from '../contacts/dto.js';
import { PageDto } from '../properties/dto.js';

export const LEAD_TYPES = ['buy', 'rent', 'sell', 'let', 'valuation', 'management', 'other'] as const;
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost'] as const;
/** Statuses a person may set (converting creates a deal, Phase 6). */
export const SETTABLE_STATUSES = ['contacted', 'qualified', 'unqualified', 'lost'] as const;
export const OPEN_STATUSES = ['new', 'contacted', 'qualified'] as const;

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const CODE = /^[a-z][a-z0-9_]*$/;

export class CreateLeadBody {
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'An existing contact; or give `contact` to create one (duplicate check applies)' })
  @ValidateIf(notNull) @IsUUID()
  contactId?: string | null;
  @ApiPropertyOptional({ type: CreateContactBody, description: 'A new contact (needs contact.create)' })
  @ValidateIf(notNull) @ValidateNested() @Type(() => CreateContactBody)
  contact?: CreateContactBody | null;
  @ApiProperty({ enum: LEAD_TYPES }) @IsIn(LEAD_TYPES) leadType!: (typeof LEAD_TYPES)[number];
  @ApiProperty({ example: 'walk_in', description: 'Code from the lead_source picklist' }) @Matches(CODE) sourceCode!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200, description: 'Portal name, referrer or campaign detail' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(200)
  sourceDetail?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(200) campaign?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'The listing the enquiry is about' }) @ValidateIf(notNull) @IsUUID() listingId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'A requirement of the same contact' }) @ValidateIf(notNull) @IsUUID() requirementId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000, description: 'The enquiry as received' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(4000)
  message?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'Defaults to you; someone else needs lead.assign (decision D6); null leaves it unassigned for the office inbox (managers)' })
  @ValidateIf(notNull) @IsUUID()
  assignedTo?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' }) @ValidateIf(notNull) @IsUUID() officeId?: string | null;
  @ApiPropertyOptional({ format: 'date-time', description: 'When the enquiry arrived (default now)' }) @IsOptional() @IsISO8601({ strict: true }) receivedAt?: string;
}

export class UpdateLeadBody {
  @ApiPropertyOptional({ enum: LEAD_TYPES }) @IsOptional() @IsIn(LEAD_TYPES) leadType?: (typeof LEAD_TYPES)[number];
  @ApiPropertyOptional() @IsOptional() @Matches(CODE) sourceCode?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(200) sourceDetail?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(200) campaign?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' }) @ValidateIf(notNull) @IsUUID() listingId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' }) @ValidateIf(notNull) @IsUUID() requirementId?: string | null;
  @ApiPropertyOptional({ format: 'uuid', description: 'Move the lead to another office within your scope' }) @IsOptional() @IsUUID() officeId?: string;
}

export class ChangeLeadStatusBody {
  @ApiProperty({ enum: SETTABLE_STATUSES }) @IsIn(SETTABLE_STATUSES) status!: (typeof SETTABLE_STATUSES)[number];
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Code from the lost_reason picklist; required for lost' }) @ValidateIf(notNull) @Matches(CODE) lostReasonCode?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000, description: 'Required when marking unqualified or reopening' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(3) @MaxLength(1000)
  note?: string | null;
}

export class AssignLeadBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() assignedTo!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(1000) note?: string | null;
}

export class ArchiveLeadBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class CrmSettingsBody {
  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 10080, description: 'Minutes to the first response to a new lead (decision D3); null = not set' })
  @ValidateIf(notNull) @IsInt() @Min(1) @Max(10080)
  leadResponseMinutes!: number | null;
}

export class CrmSettingsDto {
  @ApiProperty({ type: Number, nullable: true, description: 'null: no response target set ("SLA not set")' }) leadResponseMinutes!: number | null;
}

export class LeadContactDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Partly masked' }) primaryPhoneMasked!: string | null;
}

export class LeadListingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() title!: string;
}

export class LeadResponseDto {
  @ApiProperty({ format: 'date-time' }) dueAt!: string;
  @ApiProperty({ description: 'Not yet answered and past the target' }) overdue!: boolean;
  @ApiProperty({ description: 'Answered after the target' }) late!: boolean;
}

export class LeadSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ type: LeadContactDto }) contact!: LeadContactDto;
  @ApiProperty({ enum: LEAD_TYPES }) leadType!: string;
  @ApiProperty({ enum: LEAD_STATUSES }) status!: string;
  @ApiProperty() sourceCode!: string;
  @ApiProperty({ type: String, nullable: true }) sourceDetail!: string | null;
  @ApiProperty({ type: LeadListingDto, nullable: true }) listing!: LeadListingDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) office!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) assignedTo!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true, description: 'First line of the enquiry, at most 120 characters' }) messagePreview!: string | null;
  @ApiProperty({ format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) firstResponseAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) nextActionAt!: string | null;
  @ApiProperty({ type: LeadResponseDto, nullable: true, description: 'null when the company has no response target' }) response!: LeadResponseDto | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Shown only with its breakdown; no scoring rules exist in Phase 5 (D7)' }) score!: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class LeadPageDto {
  @ApiProperty({ type: [LeadSummaryDto] }) data!: LeadSummaryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class LeadStatusChangeDto {
  @ApiProperty({ type: String, nullable: true, enum: LEAD_STATUSES }) fromStatus!: string | null;
  @ApiProperty({ enum: LEAD_STATUSES }) toStatus!: string;
  @ApiProperty({ format: 'date-time' }) changedAt!: string;
  @ApiProperty({ type: RefLabelDto, nullable: true }) changedBy!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

export class LeadAssignmentDto {
  @ApiProperty({ type: RefLabelDto }) assignedTo!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto, nullable: true }) assignedBy!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) assignedAt!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

export class ScoreRuleDto {
  @ApiProperty() rule!: string;
  @ApiProperty() points!: number;
}

export class LeadAccessDto {
  @ApiProperty() canEdit!: boolean;
  @ApiProperty() canAssign!: boolean;
  @ApiProperty({ description: 'Reopen an unqualified or lost lead (managers, lead.assign)' }) canReopen!: boolean;
  @ApiProperty({ enum: SETTABLE_STATUSES, isArray: true, description: 'Statuses you may move this lead to now' }) nextStatuses!: string[];
}

export class LeadDto extends LeadSummaryDto {
  @ApiProperty({ type: String, nullable: true }) campaign!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) requirementId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The enquiry as received' }) message!: string | null;
  @ApiProperty({ type: String, nullable: true }) lostReasonCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedReason!: string | null;
  @ApiProperty({ type: [ScoreRuleDto], description: 'Rule → points; empty when there is no score (CRM-07)' }) scoreBreakdown!: ScoreRuleDto[];
  @ApiProperty({ type: [LeadStatusChangeDto] }) statusHistory!: LeadStatusChangeDto[];
  @ApiProperty({ type: [LeadAssignmentDto] }) assignments!: LeadAssignmentDto[];
  @ApiProperty({ type: LeadAccessDto }) access!: LeadAccessDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}
