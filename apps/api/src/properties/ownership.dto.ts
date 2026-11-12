import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsNumber, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

import { RefLabelDto } from '../contacts/dto.js';
import { DATE, trim } from './dto.js';

export const OWNERSHIP_TYPES = ['legal_owner', 'beneficial_owner', 'leaseholder', 'developer'] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;

export class AddOwnershipBody {
  @ApiProperty({ format: 'uuid', description: 'The owner (a contact the member can see)' }) @IsUUID() ownerContactId!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'A unit of this property; omit or null for the whole property' })
  @ValidateIf(notNull) @IsUUID()
  unitId?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0.0001, maximum: 100, default: 100, description: 'Share in percent; current shares of one type for the same unit (or the whole property) add up to at most 100' })
  @ValidateIf(notNull) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(100)
  sharePercent?: number | null;
  @ApiPropertyOptional({ enum: OWNERSHIP_TYPES, nullable: true, default: 'legal_owner' }) @ValidateIf(notNull) @IsIn(OWNERSHIP_TYPES) ownershipType?: OwnershipType | null;
  @ApiProperty({ format: 'date', description: 'First day of ownership (not in the future, in the property time zone)' }) @Matches(DATE) effectiveFrom!: string;
}

export class EndOwnershipBody {
  @ApiProperty({ format: 'date', description: 'Last day of ownership: after the start date, not in the future' }) @Matches(DATE) effectiveTo!: string;
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Why the ownership ended (for example: sold, transferred, recorded in error)' })
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}

export class OwnershipOwnerDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['person', 'organisation'] }) contactType!: string;
  @ApiProperty({ type: Boolean, nullable: true, description: 'Identity verified now (issue #18); null when the member cannot see identity checks' })
  identityVerified!: boolean | null;
}

export class OwnershipUnitDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() unitLabel!: string;
}

export class OwnershipDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: OwnershipUnitDto, nullable: true, description: 'Null for the whole property' }) unit!: OwnershipUnitDto | null;
  @ApiProperty({ type: OwnershipOwnerDto, nullable: true, description: 'Null when the member cannot see the owner contact' }) owner!: OwnershipOwnerDto | null;
  @ApiProperty() sharePercent!: number;
  @ApiProperty({ enum: OWNERSHIP_TYPES }) ownershipType!: OwnershipType;
  @ApiProperty({ format: 'date' }) effectiveFrom!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date', description: 'Last day of ownership (inclusive)' }) effectiveTo!: string | null;
  @ApiProperty({ description: 'Owner today, in the property time zone' }) current!: boolean;
  @ApiProperty({ type: RefLabelDto, nullable: true }) createdBy!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: RefLabelDto, nullable: true }) endedBy!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) endedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) endReason!: string | null;
}

export class OwnershipListDto {
  @ApiProperty({ type: [OwnershipDto], description: 'Current records first, then ended ones (most recent first)' }) data!: OwnershipDto[];
  @ApiProperty({ description: 'The member may add and end ownership records for this property' }) canManage!: boolean;
}
