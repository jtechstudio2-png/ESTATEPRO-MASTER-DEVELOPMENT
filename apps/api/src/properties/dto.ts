import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
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

import { AddressDto, AddressInput } from '../reference/address.js';

export const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
/** Optional in PATCH: undefined = unchanged, null = clear (where the field allows it). */
export const provided = (_object: unknown, value: unknown): boolean => value !== undefined && value !== null;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const LAND_AREA_UNITS = ['sqm', 'sqft', 'acre', 'hectare', 'plot'] as const;
export const FLOOR_AREA_UNITS = ['sqm', 'sqft'] as const;

export class LandAreaInput {
  @ApiProperty({ minimum: 0.0001, maximum: 1_000_000_000 }) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1_000_000_000) value!: number;
  @ApiProperty({ enum: LAND_AREA_UNITS, description: '"plot" is kept as entered; it has no fixed size in square metres' })
  @IsIn(LAND_AREA_UNITS)
  unit!: (typeof LAND_AREA_UNITS)[number];
}

export class FloorAreaInput {
  @ApiProperty({ minimum: 0.0001, maximum: 10_000_000 }) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(10_000_000) value!: number;
  @ApiProperty({ enum: FLOOR_AREA_UNITS }) @IsIn(FLOOR_AREA_UNITS) unit!: (typeof FLOOR_AREA_UNITS)[number];
}

class PropertyFieldsBase {
  @ApiPropertyOptional({ description: 'Building or estate name' })
  @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200)
  name?: string | null;

  @ApiPropertyOptional({ description: 'Tenure code from the "tenure" picklist for the property’s country' })
  @ValidateIf(provided) @Matches(/^[a-z0-9][a-z0-9_]*$/)
  tenureCode?: string | null;

  @ApiPropertyOptional({ format: 'date' }) @ValidateIf(provided) @Matches(DATE) tenureExpiresOn?: string | null;
  @ApiPropertyOptional({ description: 'Land registry / title number' })
  @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100)
  titleReference?: string | null;

  @ApiPropertyOptional({ minimum: 1000, maximum: 2200 }) @ValidateIf(provided) @IsInt() @Min(1000) @Max(2200) yearBuilt?: number | null;
  @ApiPropertyOptional({ minimum: 0, maximum: 300 }) @ValidateIf(provided) @IsInt() @Min(0) @Max(300) floorsCount?: number | null;

  @ApiPropertyOptional({ type: LandAreaInput })
  @ValidateIf(provided) @ValidateNested() @Type(() => LandAreaInput)
  landArea?: LandAreaInput | null;

  @ApiPropertyOptional({ description: 'Under a management agreement' }) @ValidateIf(provided) @IsBoolean() isManaged?: boolean;

  @ApiPropertyOptional() @ValidateIf(provided) @IsString() @MaxLength(10_000) internalNotes?: string | null;

  @ApiPropertyOptional({ description: 'Defaults to the office jurisdiction when in the same country' })
  @ValidateIf(provided) @Matches(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/)
  jurisdictionCode?: string;

  @ApiPropertyOptional({ description: 'IANA time zone; defaults to the office (same country) or the country default', example: 'Africa/Accra' })
  @ValidateIf(provided) @IsString() @MaxLength(64)
  timezone?: string;
}

export class CreatePropertyBody extends PropertyFieldsBase {
  @ApiProperty({ format: 'uuid' }) @IsUUID() propertyTypeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() officeId!: string;
  @ApiProperty({ type: AddressInput }) @ValidateNested() @Type(() => AddressInput) address!: AddressInput;

  @ApiPropertyOptional({ description: 'Also create the single "Whole property" unit (houses, plots)', default: false })
  @ValidateIf(provided) @IsBoolean()
  createWholePropertyUnit?: boolean;
}

export class UpdatePropertyBody extends PropertyFieldsBase {
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(provided) @IsUUID() propertyTypeId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(provided) @IsUUID() officeId?: string;
  @ApiPropertyOptional({ type: AddressInput, description: 'Replaces the whole address' })
  @ValidateIf(provided) @ValidateNested() @Type(() => AddressInput)
  address?: AddressInput;
}

export class ArchiveBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class RefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class AreaDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Square metres; null for units with no fixed size (plot)' }) sqm!: number | null;
  @ApiProperty() value!: number;
  @ApiProperty() unit!: string;
}

export class PropertyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'PRP-2026-000001' }) reference!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: RefDto }) propertyType!: RefDto;
  @ApiProperty({ type: RefDto }) office!: RefDto;
  @ApiProperty() jurisdictionCode!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty({ type: AddressDto }) address!: AddressDto;
  @ApiProperty({ type: String, nullable: true }) tenureCode!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) tenureExpiresOn!: string | null;
  @ApiProperty({ type: String, nullable: true }) titleReference!: string | null;
  @ApiProperty({ type: Number, nullable: true }) yearBuilt!: number | null;
  @ApiProperty({ type: Number, nullable: true }) floorsCount!: number | null;
  @ApiProperty({ type: AreaDto, nullable: true }) landArea!: AreaDto | null;
  @ApiProperty() isManaged!: boolean;
  @ApiProperty({ type: String, nullable: true }) internalNotes!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Company custom fields (read-only in Phase 4)' })
  customFields!: Record<string, unknown>;
  @ApiProperty({ description: 'Units that are not archived' }) unitCount!: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedReason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}

export class PropertySummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: RefDto }) propertyType!: RefDto;
  @ApiProperty({ type: RefDto }) office!: RefDto;
  @ApiProperty() countryCode!: string;
  @ApiProperty({ type: String, nullable: true }) locality!: string | null;
  @ApiProperty({ type: String, nullable: true }) formattedAddress!: string | null;
  @ApiProperty() unitCount!: number;
  @ApiProperty() isManaged!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class PageDto {
  @ApiProperty() limit!: number;
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class PropertyPageDto {
  @ApiProperty({ type: [PropertySummaryDto] }) data!: PropertySummaryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

// ----------------------------------------------------------------------------- units

class UnitFieldsBase {
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(provided) @IsUUID() unitTypeId?: string | null;
  @ApiPropertyOptional() @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(40) floorLabel?: string | null;
  @ApiPropertyOptional({ minimum: 0, maximum: 100 }) @ValidateIf(provided) @IsInt() @Min(0) @Max(100) bedrooms?: number | null;
  @ApiPropertyOptional({ minimum: 0, maximum: 100, multipleOf: 0.5 })
  @ValidateIf(provided) @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(100)
  bathrooms?: number | null;
  @ApiPropertyOptional({ minimum: 0, maximum: 100 }) @ValidateIf(provided) @IsInt() @Min(0) @Max(100) receptionRooms?: number | null;
  @ApiPropertyOptional({ type: FloorAreaInput }) @ValidateIf(provided) @ValidateNested() @Type(() => FloorAreaInput) floorArea?: FloorAreaInput | null;
  @ApiPropertyOptional({ minimum: 0, maximum: 10000 }) @ValidateIf(provided) @IsInt() @Min(0) @Max(10_000) parkingSpaces?: number | null;
  @ApiPropertyOptional({ description: 'Code from the "furnishing" picklist' }) @ValidateIf(provided) @Matches(/^[a-z0-9][a-z0-9_]*$/) furnishingCode?: string | null;
  @ApiPropertyOptional({ description: 'Energy rating where the market uses one (e.g. EPC band)' })
  @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(10)
  energyRating?: string | null;
  @ApiPropertyOptional({ type: [String], description: 'Codes from the "feature" picklist; replaces the full set' })
  @ValidateIf(provided) @IsArray() @ArrayMaxSize(60) @ArrayUnique() @Matches(/^[a-z0-9][a-z0-9_]*$/, { each: true })
  featureCodes?: string[];
}

export class CreateUnitBody extends UnitFieldsBase {
  @ApiProperty({ example: 'Flat 3B' }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) unitLabel!: string;
  @ApiPropertyOptional({ default: false }) @ValidateIf(provided) @IsBoolean() isWholeProperty?: boolean;
}

export class UpdateUnitBody extends UnitFieldsBase {
  @ApiPropertyOptional() @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) unitLabel?: string;
}

export class UnitDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'UNT-2026-000001' }) reference!: string;
  @ApiProperty({ format: 'uuid' }) propertyId!: string;
  @ApiProperty() unitLabel!: string;
  @ApiProperty({ type: RefDto, nullable: true }) unitType!: RefDto | null;
  @ApiProperty() isWholeProperty!: boolean;
  @ApiProperty({ type: String, nullable: true }) floorLabel!: string | null;
  @ApiProperty({ type: Number, nullable: true }) bedrooms!: number | null;
  @ApiProperty({ type: Number, nullable: true }) bathrooms!: number | null;
  @ApiProperty({ type: Number, nullable: true }) receptionRooms!: number | null;
  @ApiProperty({ type: AreaDto, nullable: true }) floorArea!: AreaDto | null;
  @ApiProperty({ type: Number, nullable: true }) parkingSpaces!: number | null;
  @ApiProperty({ type: String, nullable: true }) furnishingCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) energyRating!: string | null;
  @ApiProperty({ enum: ['available', 'under_maintenance', 'owner_occupied', 'unavailable'] }) availability!: string;
  @ApiProperty({ type: String, nullable: true }) availabilityNote!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) availabilityUntil!: string | null;
  @ApiProperty({ type: [String] }) featureCodes!: string[];
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}

export const UNIT_AVAILABILITY = ['available', 'under_maintenance', 'owner_occupied', 'unavailable'] as const;

export class UnitAvailabilityBody {
  @ApiProperty({ enum: UNIT_AVAILABILITY, description: '"under_maintenance" blocks new viewings and lettings without changing listing status' })
  @IsIn(UNIT_AVAILABILITY)
  availability!: (typeof UNIT_AVAILABILITY)[number];

  @ApiPropertyOptional({ maxLength: 500 }) @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) note?: string | null;
  @ApiPropertyOptional({ format: 'date', description: 'Expected end of the restriction' }) @ValidateIf(provided) @Matches(DATE) until?: string | null;
}

export class UnitPageDto {
  @ApiProperty({ type: [UnitDto] }) data!: UnitDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}
