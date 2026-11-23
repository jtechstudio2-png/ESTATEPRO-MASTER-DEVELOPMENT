import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { RefLabelDto } from '../contacts/dto.js';
import { PageDto } from '../properties/dto.js';

export const INSPECTION_TYPES = ['move_in', 'move_out', 'periodic', 'pre_listing', 'maintenance', 'safety'] as const;
export const INSPECTION_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;
export const OVERALL_CONDITIONS = ['excellent', 'good', 'fair', 'poor'] as const;
export const ITEM_CONDITIONS = ['new', 'good', 'fair', 'poor', 'damaged', 'missing', 'not_applicable'] as const;
export const CLEANLINESS = ['clean', 'acceptable', 'dirty'] as const;
export const MAX_INSPECTION_ITEMS = 300;

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const NOTES_GUIDANCE = 'Erased with the tenant (ADR-009). Do not type identity or bank numbers';

// ----------------------------------------------------------------- requests (IN-1 to IN-3)

export class ScheduleInspectionBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() propertyId!: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'The unit inspected (required with a lease)' }) @IsOptional() @IsUUID() unitId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Required for move-in and move-out inspections' }) @IsOptional() @IsUUID() leaseId?: string;
  @ApiProperty({ enum: INSPECTION_TYPES }) @IsIn(INSPECTION_TYPES) inspectionType!: (typeof INSPECTION_TYPES)[number];
  @ApiProperty({ example: '2027-01-02T10:00:00Z' }) @IsISO8601({ strict: true }) scheduledAt!: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'The member carrying it out' }) @IsOptional() @IsUUID() inspectorMembershipId?: string;
}

export class UpdateInspectionBody {
  @ApiPropertyOptional({ enum: ['start'], description: 'start: scheduled → in progress (the inspector becomes you if none)' }) @IsOptional() @IsIn(['start']) action?: 'start';
  @ApiPropertyOptional({ description: 'While scheduled' }) @IsOptional() @IsISO8601({ strict: true }) scheduledAt?: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'While scheduled' }) @IsOptional() @ValidateIf(notNull) @IsUUID() inspectorMembershipId?: string | null;
  @ApiPropertyOptional({ enum: OVERALL_CONDITIONS, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsIn(OVERALL_CONDITIONS) overallCondition?: (typeof OVERALL_CONDITIONS)[number] | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000, description: NOTES_GUIDANCE }) @IsOptional() @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(4000) summary?: string | null;
}

export class InspectionItemInput {
  @ApiPropertyOptional({ format: 'uuid', description: 'An existing item (kept with its photos); left out: a new item' }) @IsOptional() @IsUUID() id?: string;
  @ApiProperty({ maxLength: 100, example: 'Kitchen' }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) area!: string;
  @ApiProperty({ maxLength: 100, example: 'Oven' }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) item!: string;
  @ApiPropertyOptional({ enum: ITEM_CONDITIONS, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsIn(ITEM_CONDITIONS) conditionCode?: (typeof ITEM_CONDITIONS)[number] | null;
  @ApiPropertyOptional({ enum: CLEANLINESS, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsIn(CLEANLINESS) cleanliness?: (typeof CLEANLINESS)[number] | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: NOTES_GUIDANCE }) @IsOptional() @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000) notes?: string | null;
  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() actionRequired?: boolean;
}

/** The whole list of items, in order: items left out are removed (with their photo links). */
export class InspectionItemsBody {
  @ApiProperty({ type: [InspectionItemInput], maxItems: MAX_INSPECTION_ITEMS })
  @IsArray()
  @ArrayMaxSize(MAX_INSPECTION_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => InspectionItemInput)
  items!: InspectionItemInput[];
}

export class InspectionPhotoBody {
  @ApiProperty({ format: 'uuid', description: 'A JPEG or PNG uploaded to the inspection (document type inspection_photo); it may still be scanning' }) @IsUUID() documentId!: string;
  @ApiPropertyOptional({ maxLength: 200, description: 'Photos of people are discouraged. Do not type identity or bank numbers' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  caption?: string;
}

export class CompleteInspectionBody {
  @ApiPropertyOptional({ format: 'uuid', description: 'A report uploaded to the inspection and scanned clean (optional)' }) @IsOptional() @IsUUID() reportDocumentId?: string;
}

export class TenantAcknowledgementBody {
  @ApiProperty({ example: '2027-01-03T09:30:00Z', description: 'When the tenant acknowledged the report (not in the future, not before completion)' })
  @IsISO8601({ strict: true })
  acknowledgedAt!: string;
}

export class CancelInspectionBody {
  @ApiProperty({ minLength: 3, maxLength: 500, description: NOTES_GUIDANCE }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

// ----------------------------------------------------------------- responses

export class InspectionPhotoDto {
  @ApiProperty({ type: RefLabelDto }) document!: RefLabelDto;
  @ApiProperty({ type: String, nullable: true }) caption!: string | null;
  @ApiProperty({ enum: ['pending', 'clean', 'infected', 'failed'] }) scanStatus!: string;
}

export class InspectionItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() area!: string;
  @ApiProperty() item!: string;
  @ApiProperty({ enum: ITEM_CONDITIONS, nullable: true }) conditionCode!: string | null;
  @ApiProperty({ enum: CLEANLINESS, nullable: true }) cleanliness!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty() actionRequired!: boolean;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ enum: ITEM_CONDITIONS, nullable: true, description: "Move-out inspections: the same item's condition at move-in" }) moveInCondition!: string | null;
  @ApiProperty({ enum: CLEANLINESS, nullable: true }) moveInCleanliness!: string | null;
  @ApiProperty({ type: [InspectionPhotoDto] }) photos!: InspectionPhotoDto[];
}

export class InspectionSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: INSPECTION_TYPES }) inspectionType!: string;
  @ApiProperty({ enum: INSPECTION_STATUSES }) status!: string;
  @ApiProperty({ type: RefLabelDto }) property!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto, nullable: true }) unit!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) lease!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) scheduledAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) completedAt!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) inspector!: RefLabelDto | null;
  @ApiProperty({ enum: OVERALL_CONDITIONS, nullable: true }) overallCondition!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class InspectionPageDto {
  @ApiProperty({ type: [InspectionSummaryDto] }) data!: InspectionSummaryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class InspectionDto extends InspectionSummaryDto {
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) summary!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) tenantSignedAt!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) reportDocument!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true }) cancelledReason!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true, description: 'Move-out inspections: the completed move-in inspection compared' }) moveIn!: RefLabelDto | null;
  @ApiProperty({ type: [InspectionItemDto] }) items!: InspectionItemDto[];
  @ApiProperty({ description: 'Photos still being scanned: the inspection is finished once there are none (IN-2)' }) pendingPhotos!: number;
  @ApiProperty({ description: 'You may change it now (an inspection in progress is changed by its inspector)' }) canEdit!: boolean;
  @ApiProperty({ type: RefLabelDto, nullable: true }) createdBy!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}
