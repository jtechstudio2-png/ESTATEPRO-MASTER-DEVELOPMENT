import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { RefLabelDto, RELATIONSHIP_TYPES } from '../contacts/dto.js';
import { LEAD_STATUSES, LEAD_TYPES } from '../crm/leads.dto.js';

/** Rows above this need narrower filters (keeps an export a deliberate, reviewable act). */
export const MAX_EXPORT_ROWS = 50_000;
/** Hours an export file stays downloadable. */
export const EXPORT_LIFETIME_HOURS = 24;

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

class ExportPurpose {
  @ApiProperty({ minLength: 5, maxLength: 300, example: 'Quarterly landlord newsletter list for the Osu office' })
  @Transform(trim) @IsString() @MinLength(5) @MaxLength(300)
  purpose!: string;
}

export class ContactExportBody extends ExportPurpose {
  @ApiPropertyOptional({ enum: RELATIONSHIP_TYPES, isArray: true }) @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(10) @IsIn(RELATIONSHIP_TYPES, { each: true })
  relationships?: string[];
  @ApiPropertyOptional({ enum: ['person', 'organisation'] }) @IsOptional() @IsIn(['person', 'organisation']) contactType?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() officeId?: string;
  @ApiPropertyOptional({ description: 'Leave out contacts who withdrew marketing consent on every channel' }) @IsOptional() @IsIn([true, false]) excludeMarketingWithdrawn?: boolean;
}

export class LeadExportBody extends ExportPurpose {
  @ApiPropertyOptional({ enum: LEAD_STATUSES, isArray: true }) @IsOptional() @IsArray() @ArrayUnique() @IsIn(LEAD_STATUSES, { each: true }) statuses?: string[];
  @ApiPropertyOptional({ enum: LEAD_TYPES, isArray: true }) @IsOptional() @IsArray() @ArrayUnique() @IsIn(LEAD_TYPES, { each: true }) leadTypes?: string[];
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() officeId?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Received on or after' }) @IsOptional() @IsString() receivedFrom?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Received before' }) @IsOptional() @IsString() receivedTo?: string;
}

export class ExportJobDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['contacts', 'leads'] }) exportType!: string;
  @ApiProperty({ enum: ['csv'] }) format!: string;
  @ApiProperty({ enum: ['completed', 'failed', 'expired'] }) status!: string;
  @ApiProperty({ type: Number, nullable: true }) rowCount!: number | null;
  @ApiProperty({ type: String, nullable: true }) fileName!: string | null;
  @ApiProperty({ description: 'Filters and purpose, as requested' }) parameters!: Record<string, unknown>;
  @ApiProperty({ type: RefLabelDto }) requestedBy!: RefLabelDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty() downloadCount!: number;
  @ApiProperty({ description: 'Only the person who requested an export can download it, until it expires' }) canDownload!: boolean;
}

export class ExportDownloadDto {
  @ApiProperty({ description: 'Short-lived link to the file. Do not share it.' }) url!: string;
  @ApiProperty({ format: 'date-time' }) linkExpiresAt!: string;
}
