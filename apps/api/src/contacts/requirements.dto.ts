import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
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

import { AMOUNT, MoneyDto } from '../common/money.js';
import { PageDto } from '../properties/dto.js';
import { NextFollowUpDto, RefLabelDto } from './dto.js';

export const REQUIREMENT_TYPES = ['buy', 'rent'] as const;
export const REQUIREMENT_STATUSES = ['active', 'paused', 'fulfilled', 'cancelled'] as const;
export const RENT_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'semi_annual', 'annual'] as const;
export const FINANCING_STATUSES = ['cash', 'mortgage_approved', 'mortgage_in_progress', 'not_started', 'not_applicable'] as const;
export const AREA_KINDS = ['locality', 'radius', 'polygon'] as const;
export const MAX_AREAS = 10;

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[a-z][a-z0-9_]*$/;

/**
 * One area of a requirement. A listing is inside the requirement's area when
 * it is inside any of its areas; no areas means anywhere.
 *   locality  the address locality (and optionally region), case-insensitive
 *   radius    within radiusMetres (1 m – 50 km) of a point
 *   polygon   inside a drawn shape of 3–100 points ([longitude, latitude])
 */
export class RequirementAreaInput {
  @ApiProperty({ enum: AREA_KINDS }) @IsIn(AREA_KINDS) kind!: (typeof AREA_KINDS)[number];
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120, example: 'East Legon' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(120)
  locality?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120, example: 'Greater Accra' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(120)
  adminArea1?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, example: 5.6355 }) @ValidateIf(notNull) @IsNumber({ allowNaN: false, allowInfinity: false }) latitude?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, example: -0.1617 }) @ValidateIf(notNull) @IsNumber({ allowNaN: false, allowInfinity: false }) longitude?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 50_000 }) @ValidateIf(notNull) @IsInt() radiusMetres?: number | null;
  @ApiPropertyOptional({ type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[longitude, latitude] pairs' })
  @ValidateIf(notNull) @IsArray() @ArrayMaxSize(101)
  points?: number[][] | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80, description: 'Name shown for a map area, e.g. "Near the school"' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(80)
  label?: string | null;
}

class RequirementFields {
  @ApiPropertyOptional({ type: String, nullable: true, example: '900000', description: 'Lowest price, in the requirement currency (rent: per rentFrequency)' })
  @ValidateIf(notNull) @Matches(AMOUNT)
  minPrice?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: '1200000' })
  @ValidateIf(notNull) @Matches(AMOUNT)
  maxPrice?: string | null;
  @ApiPropertyOptional({ enum: RENT_FREQUENCIES, nullable: true, description: 'Rent requirements with a budget: the period the budget is for' })
  @ValidateIf(notNull) @IsIn(RENT_FREQUENCIES)
  rentFrequency?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 50 }) @ValidateIf(notNull) @IsInt() @Min(0) @Max(50) minBedrooms?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 50 }) @ValidateIf(notNull) @IsInt() @Min(0) @Max(50) maxBedrooms?: number | null;
  @ApiPropertyOptional({ type: [String], description: 'Property or unit types wanted (ids from the property types list)' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ArrayUnique() @IsUUID('all', { each: true })
  propertyTypeIds?: string[];
  @ApiPropertyOptional({ type: [RequirementAreaInput], maxItems: MAX_AREAS })
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_AREAS) @ValidateNested({ each: true }) @Type(() => RequirementAreaInput)
  areas?: RequirementAreaInput[];
  @ApiPropertyOptional({ type: [String], description: 'Codes from the "feature" picklist; listings with more of them rank higher' })
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ArrayUnique() @Matches(CODE, { each: true })
  mustHaveFeatures?: string[];
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' }) @ValidateIf(notNull) @Matches(DATE) moveBy?: string | null;
  @ApiPropertyOptional({ enum: FINANCING_STATUSES, nullable: true }) @ValidateIf(notNull) @IsIn(FINANCING_STATUSES) financingStatus?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: 'Do not record ID or bank numbers here' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000)
  notes?: string | null;
}

export class CreateRequirementBody extends RequirementFields {
  @ApiProperty({ enum: REQUIREMENT_TYPES }) @IsIn(REQUIREMENT_TYPES) requirementType!: (typeof REQUIREMENT_TYPES)[number];
  @ApiProperty({ example: 'GHS', description: 'ISO 4217; listings in other currencies never match' }) @Matches(/^[A-Z]{3}$/) currencyCode!: string;
  @ApiPropertyOptional({ enum: ['active', 'paused'], default: 'active' }) @IsOptional() @IsIn(['active', 'paused']) status?: 'active' | 'paused';
}

export class UpdateRequirementBody extends RequirementFields {
  @ApiPropertyOptional({ enum: REQUIREMENT_STATUSES }) @IsOptional() @IsIn(REQUIREMENT_STATUSES) status?: (typeof REQUIREMENT_STATUSES)[number];
  @ApiPropertyOptional({ example: 'GHS' }) @IsOptional() @Matches(/^[A-Z]{3}$/) currencyCode?: string;
}

export class ExcludeListingBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() listingId!: string;
  @ApiProperty({ minLength: 3, maxLength: 500, example: 'Too far from the children’s school' })
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500)
  reason!: string;
}

export class RequirementAreaDto {
  @ApiProperty({ enum: AREA_KINDS }) kind!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) locality?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) adminArea1?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) latitude?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) longitude?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) radiusMetres?: number | null;
  @ApiPropertyOptional({ type: 'array', items: { type: 'array', items: { type: 'number' } }, nullable: true }) points?: number[][] | null;
  @ApiPropertyOptional({ type: String, nullable: true }) label?: string | null;
}

export class RequirementDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: RefLabelDto, description: 'The contact; name is its display name' }) contact!: RefLabelDto;
  @ApiProperty({ enum: REQUIREMENT_TYPES }) requirementType!: string;
  @ApiProperty({ enum: REQUIREMENT_STATUSES }) status!: string;
  @ApiProperty({ example: 'GHS' }) currencyCode!: string;
  @ApiProperty({ type: MoneyDto, nullable: true }) minPrice!: MoneyDto | null;
  @ApiProperty({ type: MoneyDto, nullable: true }) maxPrice!: MoneyDto | null;
  @ApiProperty({ enum: RENT_FREQUENCIES, nullable: true }) rentFrequency!: string | null;
  @ApiProperty({ type: Number, nullable: true }) minBedrooms!: number | null;
  @ApiProperty({ type: Number, nullable: true }) maxBedrooms!: number | null;
  @ApiProperty({ type: [String] }) propertyTypeIds!: string[];
  @ApiProperty({ type: [RequirementAreaDto] }) areas!: RequirementAreaDto[];
  @ApiProperty({ type: [String] }) mustHaveFeatures!: string[];
  @ApiProperty({ type: String, nullable: true, format: 'date' }) moveBy!: string | null;
  @ApiProperty({ enum: FINANCING_STATUSES, nullable: true }) financingStatus!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: Number, nullable: true, maximum: 100, description: 'Published listings matching now, at most 100 (null without listing.view)' })
  matchCount!: number | null;
  @ApiProperty({ description: 'More than 100 listings match (show "100+"); the matches endpoint gives the exact total' }) matchCountCapped!: boolean;
  @ApiPropertyOptional({ type: NextFollowUpDto, nullable: true, description: 'Register (B-1) only: the contact\'s next open follow-up among those you may see' })
  nextFollowUp?: NextFollowUpDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}

export class RequirementPageDto {
  @ApiProperty({ type: [RequirementDto] }) data!: RequirementDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class MatchBreakdownDto {
  @ApiProperty({ type: [String], description: 'Wanted features the listing has' }) featuresMatched!: string[];
  @ApiProperty({ type: [String], description: 'Wanted features the listing lacks' }) featuresMissing!: string[];
  @ApiProperty({ type: Boolean, nullable: true, description: 'Listing is one of the wanted types (null when no types were given)' }) propertyTypeMatched!: boolean | null;
  @ApiProperty({ type: Boolean, nullable: true, description: 'Bedrooms within the maximum (null when no maximum was given)' }) withinMaxBedrooms!: boolean | null;
}

export class RequirementMatchDto {
  @ApiProperty({ format: 'uuid' }) listingId!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: ['sale', 'rent'] }) listingType!: string;
  @ApiProperty({ type: MoneyDto }) price!: MoneyDto;
  @ApiProperty({ enum: RENT_FREQUENCIES, nullable: true }) rentFrequency!: string | null;
  @ApiProperty({ type: Number, nullable: true }) bedrooms!: number | null;
  @ApiProperty({ type: String, nullable: true }) locality!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) publishedAt!: string | null;
  @ApiProperty({ description: 'Ranking points: one per wanted feature, one for a wanted type, one for bedrooms within the maximum' }) score!: number;
  @ApiProperty({ type: MatchBreakdownDto }) breakdown!: MatchBreakdownDto;
}

export class RequirementMatchesDto {
  @ApiProperty({ type: [RequirementMatchDto] }) data!: RequirementMatchDto[];
  @ApiProperty({ description: 'All matching listings (data holds the best `limit`)' }) total!: number;
  @ApiProperty({ type: [String], description: 'The rules applied (decision D4)' }) rules!: string[];
}

export class RequirementExclusionDto {
  @ApiProperty({ format: 'uuid' }) listingId!: string;
  @ApiProperty() listingReference!: string;
  @ApiProperty() listingTitle!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ type: RefLabelDto, nullable: true }) excludedBy!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) excludedAt!: string;
}
