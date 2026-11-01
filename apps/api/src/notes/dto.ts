import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { PageDto } from '../properties/dto.js';

export const NOTE_CATEGORIES = ['general', 'access', 'viewing', 'maintenance', 'legal', 'owner'] as const;
export const NOTE_VISIBILITIES = ['internal', 'landlord', 'tenant'] as const;
export const REDACTION_REASONS = ['erasure_request', 'sensitive_data', 'other'] as const;
export const NOTE_MAX_LENGTH = 10_000;

const provided = (_object: unknown, value: unknown) => value !== undefined;
const trimEnd = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.replace(/\s+$/u, '') : value);

export class CreateNoteBody {
  @ApiProperty({ minLength: 1, maxLength: NOTE_MAX_LENGTH, description: 'Plain text' })
  @Transform(trimEnd) @IsString() @MinLength(1) @MaxLength(NOTE_MAX_LENGTH)
  body!: string;

  @ApiPropertyOptional({ enum: NOTE_CATEGORIES, default: 'general' }) @ValidateIf(provided) @IsIn(NOTE_CATEGORIES) category?: string;

  @ApiPropertyOptional({
    enum: NOTE_VISIBILITIES,
    default: 'internal',
    description: 'landlord and tenant need Manage Notes; tenant needs a unit (ADR-006 L-D8)',
  })
  @ValidateIf(provided) @IsIn(NOTE_VISIBILITIES)
  visibility?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'A unit of this property' }) @ValidateIf(provided) @IsUUID() unitId?: string;
  @ApiPropertyOptional({ default: false }) @ValidateIf(provided) @IsBoolean() isPinned?: boolean;
}

export class UpdateNoteBody {
  @ApiPropertyOptional({ minLength: 1, maxLength: NOTE_MAX_LENGTH })
  @ValidateIf(provided) @Transform(trimEnd) @IsString() @MinLength(1) @MaxLength(NOTE_MAX_LENGTH)
  body?: string;

  @ApiPropertyOptional({ enum: NOTE_CATEGORIES }) @ValidateIf(provided) @IsIn(NOTE_CATEGORIES) category?: string;
  @ApiPropertyOptional({ enum: NOTE_VISIBILITIES }) @ValidateIf(provided) @IsIn(NOTE_VISIBILITIES) visibility?: string;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'null moves the note to the whole property' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsUUID()
  unitId?: string | null;

  @ApiPropertyOptional() @ValidateIf(provided) @IsBoolean() isPinned?: boolean;
}

export class ArchiveNoteBody {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}

export class RedactNoteBody {
  @ApiProperty({ enum: REDACTION_REASONS, description: 'Recorded in the audit log; the note text never is' })
  @IsIn(REDACTION_REASONS)
  reason!: string;
}

export class NoteMemberDto {
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty() displayName!: string;
}

export class NoteDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) propertyId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) unitId!: string | null;
  @ApiProperty({ description: 'Plain text; "[Redacted]" after redaction' }) body!: string;
  @ApiProperty({ enum: NOTE_CATEGORIES }) category!: string;
  @ApiProperty({ enum: NOTE_VISIBILITIES }) visibility!: string;
  @ApiProperty() isPinned!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) pinnedAt!: string | null;
  @ApiProperty({ enum: ['user', 'migrated'], description: 'migrated: moved from the former property internal notes field' })
  source!: string;
  @ApiProperty({ type: NoteMemberDto, nullable: true }) author!: NoteMemberDto | null;
  @ApiProperty({ type: NoteMemberDto, nullable: true }) updatedBy!: NoteMemberDto | null;
  @ApiProperty({ description: 'Earlier versions of the text kept in the history' }) revisionCount!: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedReason!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) redactedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}

export class NotePageDto {
  @ApiProperty({ type: [NoteDto] }) data!: NoteDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class NoteRevisionDto {
  @ApiProperty({ description: 'The note version this text belonged to' }) revision!: number;
  @ApiProperty() body!: string;
  @ApiProperty({ type: NoteMemberDto, nullable: true }) writtenBy!: NoteMemberDto | null;
  @ApiProperty({ format: 'date-time' }) writtenAt!: string;
  @ApiProperty({ format: 'date-time', description: 'When the text was replaced' }) supersededAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) redactedAt!: string | null;
}

export class NoteRevisionPageDto {
  @ApiProperty({ type: [NoteRevisionDto] }) data!: NoteRevisionDto[];
  @ApiProperty({ type: Number, nullable: true, description: 'Pass as ?before= for older revisions' }) nextBefore!: number | null;
}
