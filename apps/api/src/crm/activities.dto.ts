import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { RefLabelDto } from '../contacts/dto.js';

/** Types a person logs (A-2); system entries are written by the server. */
export const LOGGABLE_TYPES = ['call', 'email', 'sms', 'whatsapp', 'meeting', 'note'] as const;
export const ACTIVITY_TYPES = [...LOGGABLE_TYPES, 'viewing', 'offer', 'status_change', 'document', 'portal', 'system'] as const;
export const DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export const LINK_TYPES = ['contact', 'lead', 'listing', 'property'] as const;
/** Hours after logging during which the author may edit an activity (decision D5). */
export const EDIT_WINDOW_HOURS = 24;

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class ActivityLinkInput {
  @ApiProperty({ enum: LINK_TYPES }) @IsIn(LINK_TYPES) entityType!: (typeof LINK_TYPES)[number];
  @ApiProperty({ format: 'uuid' }) @IsUUID() entityId!: string;
}

class ActivityContent {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(200) subject?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 10000, description: 'Do not record ID or bank numbers here' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(10000)
  body?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 86400 }) @ValidateIf(notNull) @IsInt() @Min(0) @Max(86400) durationSeconds?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Code from the activity_outcome picklist' })
  @ValidateIf(notNull) @Matches(/^[a-z][a-z0-9_]*$/)
  outcomeCode?: string | null;
}

export class LogActivityBody extends ActivityContent {
  @ApiProperty({ enum: LOGGABLE_TYPES }) @IsIn(LOGGABLE_TYPES) activityType!: (typeof LOGGABLE_TYPES)[number];
  @ApiPropertyOptional({ enum: DIRECTIONS, description: 'Required for calls and messages; notes are internal' }) @IsOptional() @IsIn(DIRECTIONS) direction?: (typeof DIRECTIONS)[number];
  @ApiPropertyOptional({ format: 'date-time', description: 'When it happened (default now)' }) @IsOptional() @IsISO8601({ strict: true }) occurredAt?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Who made the call or held the meeting (default you)' }) @IsOptional() @IsUUID() performedBy?: string;
  @ApiProperty({ type: [ActivityLinkInput], description: 'At least one contact or lead; a lead also links its contact' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ActivityLinkInput)
  links!: ActivityLinkInput[];
}

export class EditActivityBody extends ActivityContent {
  @ApiPropertyOptional({ enum: DIRECTIONS }) @IsOptional() @IsIn(DIRECTIONS) direction?: (typeof DIRECTIONS)[number];
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsISO8601({ strict: true }) occurredAt?: string;
}

export class ArchiveActivityBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class ActivityLinkDto {
  @ApiProperty({ enum: LINK_TYPES }) entityType!: string;
  @ApiProperty({ format: 'uuid' }) entityId!: string;
  @ApiProperty({ description: 'Contact name, lead or listing reference' }) label!: string;
}

export class ActivityRevisionDto {
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ type: String, nullable: true }) subject!: string | null;
  @ApiProperty({ type: String, nullable: true }) body!: string | null;
  @ApiProperty({ type: String, nullable: true }) outcomeCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) direction!: string | null;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ type: Number, nullable: true }) durationSeconds!: number | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) editedBy!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) editedAt!: string;
}

export class ActivityDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ACTIVITY_TYPES }) activityType!: string;
  @ApiProperty({ enum: DIRECTIONS, nullable: true }) direction!: string | null;
  @ApiProperty({ type: String, nullable: true }) subject!: string | null;
  @ApiProperty({ type: String, nullable: true }) body!: string | null;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ type: Number, nullable: true }) durationSeconds!: number | null;
  @ApiProperty({ type: String, nullable: true }) outcomeCode!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) performedBy!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true, description: 'Who logged it' }) createdBy!: RefLabelDto | null;
  @ApiProperty({ type: [ActivityLinkDto] }) links!: ActivityLinkDto[];
  @ApiProperty({ description: 'Written by the system; never edited or archived' }) isSystem!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) editedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) editableUntil!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedReason!: string | null;
  @ApiProperty({ description: 'You wrote it and the edit window is open (D5)' }) canEdit!: boolean;
  @ApiProperty() canArchive!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class ActivityDetailDto extends ActivityDto {
  @ApiProperty({ type: [ActivityRevisionDto], description: 'Earlier versions, oldest first' }) revisions!: ActivityRevisionDto[];
}

export class ActivityPageDto {
  @ApiProperty({ type: [ActivityDto] }) data!: ActivityDto[];
  @ApiProperty({ type: Object, description: '{ limit, nextCursor }' }) page!: { limit: number; nextCursor: string | null };
}
