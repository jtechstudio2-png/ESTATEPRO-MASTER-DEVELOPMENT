import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { RefLabelDto } from '../contacts/dto.js';
import { PageDto } from '../properties/dto.js';

/** Types a person schedules (F-1); renewal, arrears and inspection tasks come from later phases. */
export const SCHEDULABLE_TASK_TYPES = ['follow_up', 'call', 'email', 'viewing_feedback', 'document_chase', 'other'] as const;
export const TASK_TYPES = ['follow_up', 'call', 'email', 'viewing_feedback', 'document_chase', 'renewal', 'arrears', 'inspection', 'other'] as const;
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export const TASK_ENTITY_TYPES = ['contact', 'lead'] as const;

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class TaskAboutInput {
  @ApiProperty({ enum: TASK_ENTITY_TYPES }) @IsIn(TASK_ENTITY_TYPES) entityType!: (typeof TASK_ENTITY_TYPES)[number];
  @ApiProperty({ format: 'uuid' }) @IsUUID() entityId!: string;
}

export class CreateTaskBody {
  @ApiProperty({ minLength: 1, maxLength: 200, example: 'Call back about East Legon options' }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000) description?: string | null;
  @ApiPropertyOptional({ enum: SCHEDULABLE_TASK_TYPES, default: 'follow_up' }) @IsOptional() @IsIn(SCHEDULABLE_TASK_TYPES) taskType?: (typeof SCHEDULABLE_TASK_TYPES)[number];
  @ApiPropertyOptional({ enum: PRIORITIES, default: 'normal' }) @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @ApiProperty({ format: 'date-time', description: 'Quick picks (later today, tomorrow) are computed by the client in the office timezone' })
  @IsISO8601({ strict: true })
  dueAt!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time', description: 'In-app reminder time; not after dueAt' }) @ValidateIf(notNull) @IsISO8601({ strict: true }) remindAt?: string | null;
  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to you; someone else is a manager action (lead.assign, decision D6)' }) @IsOptional() @IsUUID() assignedTo?: string;
  @ApiPropertyOptional({ type: TaskAboutInput, nullable: true, description: 'The contact or lead it is about (one record, gap G4)' })
  @ValidateIf(notNull) @ValidateNested() @Type(() => TaskAboutInput)
  about?: TaskAboutInput | null;
}

export class UpdateTaskBody {
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000) description?: string | null;
  @ApiPropertyOptional({ enum: SCHEDULABLE_TASK_TYPES }) @IsOptional() @IsIn(SCHEDULABLE_TASK_TYPES) taskType?: (typeof SCHEDULABLE_TASK_TYPES)[number];
  @ApiPropertyOptional({ enum: PRIORITIES }) @IsOptional() @IsIn(PRIORITIES) priority?: (typeof PRIORITIES)[number];
  @ApiPropertyOptional({ format: 'date-time', description: 'Reschedule' }) @IsOptional() @IsISO8601({ strict: true }) dueAt?: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' }) @ValidateIf(notNull) @IsISO8601({ strict: true }) remindAt?: string | null;
}

export class ReassignTaskBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() assignedTo!: string;
}

export class CancelTaskBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class TaskAboutDto {
  @ApiProperty({ enum: TASK_ENTITY_TYPES }) entityType!: string;
  @ApiProperty({ format: 'uuid' }) entityId!: string;
  @ApiProperty({ description: 'Contact name, or lead reference and contact name' }) label!: string;
}

export class TaskDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: TASK_TYPES }) taskType!: string;
  @ApiProperty({ enum: PRIORITIES }) priority!: string;
  @ApiProperty({ enum: TASK_STATUSES }) status!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) dueAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) remindAt!: string | null;
  @ApiProperty({ description: 'Open and past its due time' }) overdue!: boolean;
  @ApiProperty({ description: 'Open and its reminder time has come (in-app reminder)' }) reminderDue!: boolean;
  @ApiProperty({ type: RefLabelDto }) assignedTo!: RefLabelDto;
  @ApiProperty({ type: TaskAboutDto, nullable: true }) about!: TaskAboutDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) createdBy!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) completedAt!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) completedBy!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) cancelledAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason!: string | null;
  @ApiProperty({ description: 'You may edit, reschedule, complete or cancel it' }) canEdit!: boolean;
  @ApiProperty({ description: 'You may give it to someone else (managers, D6)' }) canReassign!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class TaskPageDto {
  @ApiProperty({ type: [TaskDto] }) data!: TaskDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}
