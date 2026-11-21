import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { MoneyDto, MoneyInput } from '../common/money.js';
import { RefLabelDto } from '../contacts/dto.js';
import { PageDto } from '../properties/dto.js';

export const OFFER_DIRECTIONS = ['from_buyer', 'from_seller'] as const;
export const OFFER_STATUSES = ['submitted', 'countered', 'accepted', 'rejected', 'withdrawn', 'expired'] as const;
export const RENT_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'semi_annual', 'annual'] as const;

const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

// ---------------------------------------------------------------- requests

export class RecordOfferBody {
  @ApiProperty({ format: 'uuid', description: 'An open deal with a listing' }) @IsUUID() dealId!: string;
  @ApiProperty({ format: 'uuid', description: 'Who makes the offer: a buyer or tenant on the deal, or (from the seller) a current owner or a seller or landlord on the deal' })
  @IsUUID()
  offeredByContactId!: string;
  @ApiPropertyOptional({ enum: OFFER_DIRECTIONS, default: 'from_buyer' }) @IsOptional() @IsIn(OFFER_DIRECTIONS) direction?: (typeof OFFER_DIRECTIONS)[number];
  @ApiProperty({ type: MoneyInput, description: 'In the deal\'s currency' }) @ValidateNested() @Type(() => MoneyInput) amount!: MoneyInput;
  @ApiPropertyOptional({ enum: RENT_FREQUENCIES, description: 'Lettings only (required for them)' }) @IsOptional() @IsIn(RENT_FREQUENCIES) rentFrequency?: (typeof RENT_FREQUENCIES)[number];
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: 'Never changes once recorded. Do not type identity or bank numbers' })
  @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000)
  conditions?: string | null;
  @ApiPropertyOptional({ description: 'Picklist "financing": cash, mortgage, part_exchange, developer_plan' }) @IsOptional() @IsString() @MaxLength(60) financingCode?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'When the offer lapses if not answered (the worker marks it expired)' }) @IsOptional() @IsISO8601({ strict: true }) expiresAt?: string;
}

export class CounterOfferBody {
  @ApiProperty({ format: 'uuid', description: 'Who counters (the other side of the offer being answered)' }) @IsUUID() offeredByContactId!: string;
  @ApiProperty({ type: MoneyInput }) @ValidateNested() @Type(() => MoneyInput) amount!: MoneyInput;
  @ApiPropertyOptional({ enum: RENT_FREQUENCIES }) @IsOptional() @IsIn(RENT_FREQUENCIES) rentFrequency?: (typeof RENT_FREQUENCIES)[number];
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000) conditions?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) financingCode?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsISO8601({ strict: true }) expiresAt?: string;
}

export class OfferReasonBody {
  @ApiPropertyOptional({ maxLength: 500, description: 'Why (kept on the timeline). Required to withdraw an accepted offer' })
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(500)
  reason?: string;
}

// ---------------------------------------------------------------- responses

export class OfferRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
}

export class OfferListingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ description: 'The listing\'s status now' }) status!: string;
}

export class OfferDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: OfferRefDto }) deal!: OfferRefDto;
  @ApiProperty({ type: OfferListingDto }) listing!: OfferListingDto;
  @ApiProperty({ type: RefLabelDto }) offeredBy!: RefLabelDto;
  @ApiProperty({ enum: OFFER_DIRECTIONS }) direction!: string;
  @ApiProperty({ type: MoneyDto }) amount!: MoneyDto;
  @ApiProperty({ enum: RENT_FREQUENCIES, nullable: true }) rentFrequency!: string | null;
  @ApiProperty({ type: String, nullable: true }) conditions!: string | null;
  @ApiProperty({ type: String, nullable: true }) financingCode!: string | null;
  @ApiProperty({ enum: OFFER_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) respondedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The offer this one answers' }) parentOfferId!: string | null;
  @ApiProperty({ type: [String], description: 'Counter-offers answering this one' }) counterOfferIds!: string[];
  @ApiProperty({ description: 'Another offer on this listing is accepted (P6-D4: this one stays recorded)' }) otherOfferAccepted!: boolean;
  @ApiProperty({ type: RefLabelDto }) recordedBy!: RefLabelDto;
  @ApiProperty({ description: 'You may counter, reject or withdraw it' }) canManage!: boolean;
  @ApiProperty({ description: 'You may accept it (offer.accept, P6-D4)' }) canAccept!: boolean;
  @ApiProperty() version!: number;
}

export class OfferPageDto {
  @ApiProperty({ type: [OfferDto] }) data!: OfferDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}
