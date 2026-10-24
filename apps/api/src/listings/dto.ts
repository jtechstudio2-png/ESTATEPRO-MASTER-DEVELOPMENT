import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { MoneyDto, MoneyInput } from '../common/money.js';
import { DATE, PageDto, provided, trim } from '../properties/dto.js';

export const LISTING_TYPES = ['sale', 'rent'] as const;
export const LISTING_STATUSES = ['draft', 'available', 'reserved', 'under_contract', 'sold', 'rented', 'withdrawn', 'expired'] as const;
export const RENT_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'semi_annual', 'annual'] as const;
export const SERVICE_CHARGE_FREQUENCIES = ['monthly', 'quarterly', 'semi_annual', 'annual'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

const PERCENT = /^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/;
const CODE = /^[a-z0-9][a-z0-9_]*$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export class FeeTermsInput {
  @ApiProperty({ enum: ['percentage', 'fixed'] }) @IsIn(['percentage', 'fixed']) basis!: 'percentage' | 'fixed';
  @ApiPropertyOptional({ description: 'Percentage of the price, for basis "percentage" (e.g. "2.5")' })
  @ValidateIf((o: FeeTermsInput) => o.basis === 'percentage') @Matches(PERCENT)
  rate?: string;
  @ApiPropertyOptional({ type: MoneyInput, description: 'For basis "fixed"; in the listing currency' })
  @ValidateIf((o: FeeTermsInput) => o.basis === 'fixed') @ValidateNested() @Type(() => MoneyInput)
  amount?: MoneyInput;
  @ApiProperty({ description: 'Whether the fee includes tax (VAT)' }) @IsBoolean() taxInclusive!: boolean;
}

class ListingFieldsBase {
  @ApiPropertyOptional({ description: 'Code from the "price_qualifier" picklist' }) @ValidateIf(provided) @Matches(CODE) priceQualifierCode?: string | null;
  @ApiPropertyOptional({ enum: RENT_FREQUENCIES, description: 'Rentals only' }) @ValidateIf(provided) @IsIn(RENT_FREQUENCIES) rentFrequency?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 520, description: 'Rentals only: rent periods payable in advance (up to 10 years of weekly periods)' })
  @ValidateIf(provided) @IsInt() @Min(0) @Max(520)
  advanceRentPeriods?: number | null;
  @ApiPropertyOptional({ type: MoneyInput, nullable: true, description: 'Rentals only; in the listing currency' })
  @ValidateIf(provided) @ValidateNested() @Type(() => MoneyInput)
  deposit?: MoneyInput | null;
  @ApiPropertyOptional({ type: MoneyInput, nullable: true, description: 'Rentals only; in the listing currency' })
  @ValidateIf(provided) @ValidateNested() @Type(() => MoneyInput)
  serviceCharge?: MoneyInput | null;
  @ApiPropertyOptional({ enum: SERVICE_CHARGE_FREQUENCIES, description: 'Rentals only' })
  @ValidateIf(provided) @IsIn(SERVICE_CHARGE_FREQUENCIES)
  serviceChargeFrequency?: string | null;
  @ApiPropertyOptional({ minimum: 1, maximum: 600, description: 'Rentals only' }) @ValidateIf(provided) @IsInt() @Min(1) @Max(600) minTermMonths?: number | null;
  @ApiPropertyOptional({ format: 'date' }) @ValidateIf(provided) @Matches(DATE) availableFrom?: string | null;
  @ApiPropertyOptional({ description: 'Code from the "mandate_type" picklist' }) @ValidateIf(provided) @Matches(CODE) mandateTypeCode?: string | null;
  @ApiPropertyOptional({ format: 'date' }) @ValidateIf(provided) @Matches(DATE) mandateSignedOn?: string | null;
  @ApiPropertyOptional({ format: 'date' }) @ValidateIf(provided) @Matches(DATE) mandateExpiresOn?: string | null;
  @ApiPropertyOptional({ type: FeeTermsInput, nullable: true, description: 'Agreed agency fee (staff only)' })
  @ValidateIf(provided) @ValidateNested() @Type(() => FeeTermsInput)
  feeTerms?: FeeTermsInput | null;
  @ApiPropertyOptional({ maxLength: 10_000, description: 'Plain text in the default language' })
  @ValidateIf(provided) @IsString() @MaxLength(10_000)
  description?: string | null;
  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to the property’s office' }) @ValidateIf(provided) @IsUUID() officeId?: string;
}

export class CreateListingBody extends ListingFieldsBase {
  @ApiProperty({ format: 'uuid' }) @IsUUID() unitId!: string;
  @ApiProperty({ enum: LISTING_TYPES }) @IsIn(LISTING_TYPES) listingType!: (typeof LISTING_TYPES)[number];
  @ApiProperty({ type: MoneyInput, description: 'Asking price or periodic rent; its currency is the listing currency' })
  @ValidateNested() @Type(() => MoneyInput)
  price!: MoneyInput;
  @ApiProperty({ minLength: 3, maxLength: 200, description: 'Title in the default language' })
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200)
  title!: string;
  @ApiPropertyOptional({ description: 'Defaults to the office locale' }) @ValidateIf(provided) @Matches(LOCALE) defaultLocaleCode?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Defaults to the caller' }) @ValidateIf(provided) @IsUUID() agentMembershipId?: string;
}

export class UpdateListingBody extends ListingFieldsBase {
  @ApiPropertyOptional({ type: MoneyInput, description: 'A different currency is allowed on drafts only' })
  @ValidateIf(provided) @ValidateNested() @Type(() => MoneyInput)
  price?: MoneyInput;
  @ApiPropertyOptional({ minLength: 3, maxLength: 200, description: 'Title in the default language' })
  @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(3) @MaxLength(200)
  title?: string;
  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Required when a live listing’s price is reduced' })
  @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500)
  priceChangeReason?: string;
}

export class ListingStatusBody {
  @ApiProperty({ enum: LISTING_STATUSES }) @IsIn(LISTING_STATUSES) toStatus!: ListingStatus;
  @ApiPropertyOptional({ minLength: 3, maxLength: 500, description: 'Required for withdrawn, expired and fell-through changes' })
  @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500)
  reason?: string;
}

export class AssignAgentBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() agentMembershipId!: string;
  @ApiPropertyOptional({ maxLength: 500 }) @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason?: string;
}

export class RelistBody {
  @ApiPropertyOptional({ format: 'uuid', description: 'Agent for the new listing; defaults to the previous agent (agents always get themselves)' })
  @ValidateIf(provided) @IsUUID()
  agentMembershipId?: string;
}

export class TranslationBody {
  @ApiProperty({ minLength: 3, maxLength: 200 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @ApiPropertyOptional({ maxLength: 10_000 }) @ValidateIf(provided) @IsString() @MaxLength(10_000) description?: string | null;
}

export class ListingSettingsBody {
  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 100, description: 'Price reductions above this percentage need manager approval; null = off' })
  @ValidateIf((o: ListingSettingsBody) => o.priceReductionApprovalPercent !== null) @IsInt() @Min(1) @Max(100)
  priceReductionApprovalPercent!: number | null;
  @ApiProperty({ description: 'Listings cannot be published until seller KYC is verified' }) @IsBoolean() requireSellerKyc!: boolean;
}

// ----------------------------------------------------------------------------- responses

export class ListingSettingsDto {
  @ApiProperty({ type: Number, nullable: true }) priceReductionApprovalPercent!: number | null;
  @ApiProperty() requireSellerKyc!: boolean;
}

export class FeeTermsDto {
  @ApiProperty({ enum: ['percentage', 'fixed'] }) basis!: 'percentage' | 'fixed';
  @ApiPropertyOptional() rate?: string;
  @ApiPropertyOptional({ type: MoneyDto }) amount?: MoneyDto;
  @ApiProperty() taxInclusive!: boolean;
}

export class ListingUnitDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() unitLabel!: string;
  @ApiProperty({ type: Number, nullable: true }) bedrooms!: number | null;
  @ApiProperty({ enum: ['available', 'under_maintenance', 'owner_occupied', 'unavailable'] }) availability!: string;
}

export class ListingPropertyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) formattedAddress!: string | null;
}

export class ListingOfficeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class ListingAgentDto {
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty() displayName!: string;
}

export class TranslationDto {
  @ApiProperty() localeCode!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['manual', 'ai_draft', 'translation_service'] }) source!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class ListingSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'LST-2026-000001' }) reference!: string;
  @ApiProperty({ enum: LISTING_TYPES }) listingType!: string;
  @ApiProperty({ enum: LISTING_STATUSES }) status!: string;
  @ApiProperty() isPublished!: boolean;
  @ApiProperty({ type: MoneyDto }) price!: MoneyDto;
  @ApiProperty({ type: String, nullable: true, enum: RENT_FREQUENCIES }) rentFrequency!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty({ type: ListingUnitDto }) unit!: ListingUnitDto;
  @ApiProperty({ type: ListingPropertyDto }) property!: ListingPropertyDto;
  @ApiProperty({ type: ListingOfficeDto }) office!: ListingOfficeDto;
  @ApiProperty({ type: ListingAgentDto }) agent!: ListingAgentDto;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) listedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class ListingDto extends ListingSummaryDto {
  @ApiProperty({ type: String, nullable: true }) priceQualifierCode!: string | null;
  @ApiProperty({ type: Number, nullable: true }) advanceRentPeriods!: number | null;
  @ApiProperty({ type: MoneyDto, nullable: true }) deposit!: MoneyDto | null;
  @ApiProperty({ type: MoneyDto, nullable: true }) serviceCharge!: MoneyDto | null;
  @ApiProperty({ type: String, nullable: true }) serviceChargeFrequency!: string | null;
  @ApiProperty({ type: Number, nullable: true }) minTermMonths!: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) availableFrom!: string | null;
  @ApiProperty({ type: String, nullable: true }) mandateTypeCode!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) mandateSignedOn!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) mandateExpiresOn!: string | null;
  @ApiProperty({ type: FeeTermsDto, nullable: true, description: 'Only for staff who may edit the listing' }) feeTerms!: FeeTermsDto | null;
  @ApiProperty() defaultLocaleCode!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: [TranslationDto] }) translations!: TranslationDto[];
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) publishedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) closedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class ListingPageDto {
  @ApiProperty({ type: [ListingSummaryDto] }) data!: ListingSummaryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class StatusHistoryEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) fromStatus!: string | null;
  @ApiProperty() toStatus!: string;
  @ApiProperty({ format: 'date-time' }) changedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) changedByMembershipId!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

export class StatusHistoryPageDto {
  @ApiProperty({ type: [StatusHistoryEntryDto] }) data!: StatusHistoryEntryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class PriceHistoryEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: MoneyDto, nullable: true }) oldPrice!: MoneyDto | null;
  @ApiProperty({ type: MoneyDto }) newPrice!: MoneyDto;
  @ApiProperty({ format: 'date-time' }) changedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) changedByMembershipId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) approvedByMembershipId!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

export class PriceHistoryPageDto {
  @ApiProperty({ type: [PriceHistoryEntryDto] }) data!: PriceHistoryEntryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class HistoryEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ example: 'listing.updated' }) action!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) actorMembershipId!: string | null;
  @ApiProperty({ type: String, nullable: true }) actorName!: string | null;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true, description: '{"field": {"old": …, "new": …}}' })
  changes!: Record<string, unknown> | null;
  @ApiProperty({ type: 'object', additionalProperties: true }) metadata!: Record<string, unknown>;
}

export class HistoryPageDto {
  @ApiProperty({ type: [HistoryEntryDto] }) data!: HistoryEntryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}
