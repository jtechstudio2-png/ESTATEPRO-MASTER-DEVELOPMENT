import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { PageDto } from '../properties/dto.js';

export const KEY_STATUSES = ['in_office', 'checked_out', 'with_owner', 'lost', 'retired'] as const;
export const KEY_MOVEMENTS = ['check_out', 'check_in', 'lost', 'found'] as const;

const provided = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class CreateKeySetBody {
  @ApiProperty({ description: 'Key tag number, unique among active key sets', maxLength: 60 })
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(60)
  label!: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'What the set contains, e.g. "2 front door, 1 gate fob"' })
  @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'A unit of this property' }) @ValidateIf(provided) @IsUUID() unitId?: string;

  @ApiPropertyOptional({ enum: ['in_office', 'with_owner'], default: 'in_office', description: 'Where the keys are when registered' })
  @ValidateIf(provided) @IsIn(['in_office', 'with_owner'])
  status?: 'in_office' | 'with_owner';
}

export class UpdateKeySetBody {
  @ApiPropertyOptional({ maxLength: 60 }) @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) label?: string;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsUUID()
  unitId?: string | null;
}

export class CheckOutBody {
  @ApiPropertyOptional({ format: 'uuid', description: 'Staff member taking the keys (or holderContactId)' })
  @ValidateIf(provided) @IsUUID()
  holderMembershipId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Contact taking the keys, e.g. a contractor (or holderMembershipId)' })
  @ValidateIf(provided) @IsUUID()
  holderContactId?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'When the keys must be back' })
  @ValidateIf(provided) @IsISO8601({ strict: true })
  dueBackAt?: string;

  @ApiPropertyOptional({ maxLength: 500 }) @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) note?: string;
}

export class KeyNoteBody {
  @ApiPropertyOptional({ maxLength: 500 }) @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) note?: string;
}

export class RetireKeySetBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class KeyHolderDto {
  @ApiProperty({ enum: ['member', 'contact'] }) type!: 'member' | 'contact';
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() displayName!: string;
}

export class KeyPropertyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
}

export class KeySetDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: KeyPropertyDto }) property!: KeyPropertyDto;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) unitId!: string | null;
  @ApiProperty() label!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: KEY_STATUSES }) status!: string;
  @ApiProperty({ type: KeyHolderDto, nullable: true }) holder!: KeyHolderDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) checkedOutAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) dueBackAt!: string | null;
  @ApiProperty({ description: 'Checked out and past its due-back time' }) isOverdue!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) retiredAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}

export class KeySetPageDto {
  @ApiProperty({ type: [KeySetDto] }) data!: KeySetDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class KeyMovementDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: KEY_MOVEMENTS }) movement!: string;
  @ApiProperty({ type: KeyHolderDto, nullable: true }) holder!: KeyHolderDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) dueBackAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ type: KeyHolderDto }) recordedBy!: KeyHolderDto;
}

export class KeyMovementPageDto {
  @ApiProperty({ type: [KeyMovementDto] }) data!: KeyMovementDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}
