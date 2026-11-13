import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { RefLabelDto } from '../contacts/dto.js';
import { PageDto } from '../properties/dto.js';

export const VIEWING_TYPES = ['in_person', 'virtual', 'open_house'] as const;
export const VIEWING_STATUSES = ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled'] as const;
export const VIEWING_OUTCOMES = ['interested', 'not_interested', 'second_viewing', 'offer_expected', 'offer_made'] as const;
export const ATTENDANCES = ['expected', 'attended', 'absent'] as const;

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

// ---------------------------------------------------------------- requests

export class BookViewingBody {
  @ApiProperty({ format: 'uuid', description: 'A live listing (available, reserved or under contract)' }) @IsUUID() listingId!: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Who conducts it; defaults to you. Someone else is a manager action (office or company scope)' })
  @IsOptional() @IsUUID()
  agentMembershipId?: string;
  @ApiPropertyOptional({ enum: VIEWING_TYPES, default: 'in_person' }) @IsOptional() @IsIn(VIEWING_TYPES) viewingType?: (typeof VIEWING_TYPES)[number];
  @ApiProperty({ format: 'date-time', description: 'Start; shown in the property time zone' }) @IsISO8601({ strict: true }) scheduledStart!: string;
  @ApiProperty({ format: 'date-time', description: 'End; after the start, at most 8 hours later' }) @IsISO8601({ strict: true }) scheduledEnd!: string;
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: 10,
    description: 'Contacts attending. At least one, except for an open house; defaults to the lead\'s contact when a lead is given',
  })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ArrayUnique() @IsUUID('all', { each: true })
  attendeeContactIds?: string[];
  @ApiPropertyOptional({ format: 'uuid', description: 'The lead it comes from (moves a new lead to contacted)' }) @IsOptional() @IsUUID() leadId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'The open deal it belongs to (moves the deal to the viewing stage if earlier)' }) @IsOptional() @IsUUID() dealId?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300, description: 'Where to meet. Do not type identity or bank numbers' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(300)
  meetingPoint?: string | null;
  @ApiPropertyOptional({ default: false, description: 'Already confirmed with the attendees' }) @IsOptional() @IsBoolean() confirmed?: boolean;
}

export class RescheduleViewingBody {
  @ApiProperty({ format: 'date-time' }) @IsISO8601({ strict: true }) scheduledStart!: string;
  @ApiProperty({ format: 'date-time' }) @IsISO8601({ strict: true }) scheduledEnd!: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'A different agent for the new time (manager action)' }) @IsOptional() @IsUUID() agentMembershipId?: string;
  @ApiPropertyOptional({ maxLength: 500, description: 'Why it moved' }) @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason?: string;
}

export class CancelViewingBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class AttendanceInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID() contactId!: string;
  @ApiProperty({ enum: ['attended', 'absent'] }) @IsIn(['attended', 'absent']) attendance!: 'attended' | 'absent';
}

export class RecordOutcomeBody {
  @ApiProperty({ enum: VIEWING_OUTCOMES }) @IsIn(VIEWING_OUTCOMES) outcome!: (typeof VIEWING_OUTCOMES)[number];
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: 'Final once recorded (P6-D3). Do not type identity or bank numbers' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000)
  feedback?: string | null;
  @ApiPropertyOptional({ type: [AttendanceInput], description: 'Who came; attendees not listed are recorded as attended' })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => AttendanceInput)
  attendance?: AttendanceInput[];
  @ApiPropertyOptional({ default: false, description: 'Share the feedback with the landlord (can be decided later)' }) @IsOptional() @IsBoolean() shareFeedback?: boolean;
}

export class NoShowBody {
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) note?: string;
}

export class FeedbackSharingBody {
  @ApiProperty({ description: 'Whether the landlord may see the feedback' }) @IsBoolean() shared!: boolean;
}

export class ViewingKeyCheckOutBody {
  @ApiProperty({ format: 'uuid', description: 'A key set of the viewing\'s property (and unit, when the set is for one unit)' }) @IsUUID() keySetId!: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'An attendee taking the keys; omit for the viewing\'s agent' }) @IsOptional() @IsUUID() contactId?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Defaults to one hour after the viewing ends' }) @IsOptional() @IsISO8601({ strict: true }) dueBackAt?: string;
}

// ---------------------------------------------------------------- responses

export class ViewingListingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: ['sale', 'rent'] }) listingType!: string;
}

export class ViewingPlaceDto {
  @ApiProperty({ format: 'uuid' }) propertyId!: string;
  @ApiProperty() propertyName!: string;
  @ApiProperty({ format: 'uuid' }) unitId!: string;
  @ApiProperty() unitLabel!: string;
}

export class ViewingRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
}

export class ViewingAttendeeDto {
  @ApiProperty({ type: RefLabelDto }) contact!: RefLabelDto;
  @ApiProperty({ enum: ATTENDANCES }) attendance!: string;
}

export class ViewingConflictDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) scheduledStart!: string;
  @ApiProperty({ format: 'date-time' }) scheduledEnd!: string;
  @ApiProperty({ type: RefLabelDto }) agent!: RefLabelDto;
}

export class ViewingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: ViewingListingDto }) listing!: ViewingListingDto;
  @ApiProperty({ type: ViewingPlaceDto }) place!: ViewingPlaceDto;
  @ApiProperty({ type: RefLabelDto }) agent!: RefLabelDto;
  @ApiProperty({ type: ViewingRefDto, nullable: true }) lead!: ViewingRefDto | null;
  @ApiProperty({ type: ViewingRefDto, nullable: true }) deal!: ViewingRefDto | null;
  @ApiProperty({ enum: VIEWING_TYPES }) viewingType!: string;
  @ApiProperty({ enum: VIEWING_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) scheduledStart!: string;
  @ApiProperty({ format: 'date-time' }) scheduledEnd!: string;
  @ApiProperty({ description: 'The property time zone (IANA), for showing the time with its zone name' }) timezone!: string;
  @ApiProperty({ type: String, nullable: true }) meetingPoint!: string | null;
  @ApiProperty({ type: [ViewingAttendeeDto] }) attendees!: ViewingAttendeeDto[];
  @ApiProperty({ enum: VIEWING_OUTCOMES, nullable: true }) outcome!: string | null;
  @ApiProperty({ type: String, nullable: true }) feedback!: string | null;
  @ApiProperty({ description: 'The landlord may see the feedback (#5, S4)' }) feedbackShared!: boolean;
  @ApiProperty({ type: String, nullable: true }) cancelledReason!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) rescheduledToId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) rescheduledFromId!: string | null;
  @ApiProperty({ description: 'Live and its time has passed: record an outcome or a no-show ("viewings needing feedback")' }) needsOutcome!: boolean;
  @ApiProperty({ type: [ViewingConflictDto], description: 'Other live viewings of the same unit at an overlapping time (a warning, not a refusal)' })
  unitConflicts!: ViewingConflictDto[];
  @ApiProperty({ description: 'You may confirm, reschedule, cancel and record it' }) canManage!: boolean;
  @ApiProperty({ type: RefLabelDto, nullable: true }) createdBy!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class ViewingPageDto {
  @ApiProperty({ type: [ViewingDto] }) data!: ViewingDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}
