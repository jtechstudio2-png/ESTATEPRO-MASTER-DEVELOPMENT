import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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

import { MoneyDto, MoneyInput } from '../common/money.js';
import { RefLabelDto } from '../contacts/dto.js';
import { PageDto } from '../properties/dto.js';

export const SERVICE_LEVELS = ['let_only', 'rent_collection', 'fully_managed'] as const;
export const FEE_BASES = ['percent_of_rent_collected', 'percent_of_rent_due', 'fixed_per_period', 'one_off'] as const;
export const PAYOUT_FREQUENCIES = ['on_receipt', 'weekly', 'monthly', 'quarterly'] as const;
export const AGREEMENT_STATUSES = ['draft', 'active', 'suspended', 'ended'] as const;
export const LEASE_TYPES = ['fixed_term', 'periodic'] as const;
export const LEASE_USAGES = ['residential', 'commercial', 'mixed'] as const;
export const RENT_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'semi_annual', 'annual'] as const;
export const LEASE_STATUSES = ['draft', 'pending_signature', 'active', 'periodic', 'notice_given', 'ended', 'closed', 'cancelled'] as const;
/** Leases that are not finished: the default list. */
export const OPEN_LEASE_STATUSES = ['draft', 'pending_signature', 'active', 'periodic', 'notice_given', 'ended'] as const;
export const LEASE_PARTY_ROLES = ['tenant', 'co_tenant', 'occupant', 'guarantor', 'landlord', 'landlord_agent'] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const REASON_GUIDANCE = 'Kept on the record. Do not type identity or bank numbers';

// ------------------------------------------------------------------ agreements

export class CreateAgreementBody {
  @ApiProperty({ format: 'uuid', description: 'The landlord (a contact)' }) @IsUUID() landlordContactId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() propertyId!: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'One unit; omit for the whole property' }) @IsOptional() @IsUUID() unitId?: string;
  @ApiProperty({ enum: SERVICE_LEVELS }) @IsIn(SERVICE_LEVELS) serviceLevel!: (typeof SERVICE_LEVELS)[number];
  @ApiProperty({ example: 'GHS', description: 'Currency of the fee, limits and float' }) @Matches(/^[A-Z]{3}$/) currencyCode!: string;
  @ApiProperty({ enum: FEE_BASES }) @IsIn(FEE_BASES) feeBasis!: (typeof FEE_BASES)[number];
  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: 'Required for percentage fees' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100)
  feePercent?: number;
  @ApiPropertyOptional({ type: MoneyInput, description: 'Required for fixed and one-off fees' }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) feeFixed?: MoneyInput;
  @ApiPropertyOptional({ type: MoneyInput, description: 'Repairs above this need the landlord\'s approval' })
  @IsOptional() @ValidateNested() @Type(() => MoneyInput)
  expenseApprovalLimit?: MoneyInput;
  @ApiPropertyOptional({ type: MoneyInput, description: 'Kept back for repairs (default 0)' }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) floatAmount?: MoneyInput;
  @ApiPropertyOptional({ enum: PAYOUT_FREQUENCIES, default: 'monthly' }) @IsOptional() @IsIn(PAYOUT_FREQUENCIES) payoutFrequency?: (typeof PAYOUT_FREQUENCIES)[number];
  @ApiPropertyOptional({ minimum: 1, maximum: 31 }) @IsOptional() @IsInt() @Min(1) @Max(31) payoutDay?: number;
  @ApiProperty({ example: '2026-12-01' }) @Matches(DATE) startDate!: string;
  @ApiPropertyOptional({ example: '2027-11-30' }) @IsOptional() @Matches(DATE) endDate?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 3650 }) @IsOptional() @IsInt() @Min(0) @Max(3650) noticePeriodDays?: number;
}

/** Drafts change every field; an active or suspended agreement only the operational ones (migration 0036). */
export class UpdateAgreementBody {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() landlordContactId?: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) @IsOptional() @ValidateIf(notNull) @IsUUID() unitId?: string | null;
  @ApiPropertyOptional({ enum: SERVICE_LEVELS }) @IsOptional() @IsIn(SERVICE_LEVELS) serviceLevel?: (typeof SERVICE_LEVELS)[number];
  @ApiPropertyOptional({ example: 'GHS' }) @IsOptional() @Matches(/^[A-Z]{3}$/) currencyCode?: string;
  @ApiPropertyOptional({ enum: FEE_BASES }) @IsOptional() @IsIn(FEE_BASES) feeBasis?: (typeof FEE_BASES)[number];
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 100 })
  @IsOptional() @ValidateIf(notNull) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100)
  feePercent?: number | null;
  @ApiPropertyOptional({ type: MoneyInput, nullable: true }) @IsOptional() @ValidateIf(notNull) @ValidateNested() @Type(() => MoneyInput) feeFixed?: MoneyInput | null;
  @ApiPropertyOptional({ type: MoneyInput, nullable: true }) @IsOptional() @ValidateIf(notNull) @ValidateNested() @Type(() => MoneyInput) expenseApprovalLimit?: MoneyInput | null;
  @ApiPropertyOptional({ type: MoneyInput }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) floatAmount?: MoneyInput;
  @ApiPropertyOptional({ enum: PAYOUT_FREQUENCIES }) @IsOptional() @IsIn(PAYOUT_FREQUENCIES) payoutFrequency?: (typeof PAYOUT_FREQUENCIES)[number];
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 31 }) @IsOptional() @ValidateIf(notNull) @IsInt() @Min(1) @Max(31) payoutDay?: number | null;
  @ApiPropertyOptional({ example: '2026-12-01' }) @IsOptional() @Matches(DATE) startDate?: string;
  @ApiPropertyOptional({ type: String, nullable: true, example: '2027-11-30' }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) endDate?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsInt() @Min(0) @Max(3650) noticePeriodDays?: number | null;
}

export class ActivateAgreementBody {
  @ApiProperty({ format: 'uuid', description: 'The signed agreement, uploaded to this agreement and scanned clean' }) @IsUUID() documentId!: string;
}

export class EndAgreementBody {
  @ApiProperty({ example: '2027-11-30', description: 'The last day of the instruction' }) @Matches(DATE) endDate!: string;
}

export class FeeDto {
  @ApiProperty({ enum: FEE_BASES }) basis!: string;
  @ApiProperty({ type: Number, nullable: true }) percent!: number | null;
  @ApiProperty({ type: MoneyDto, nullable: true }) fixed!: MoneyDto | null;
}

export class AgreementDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: AGREEMENT_STATUSES }) status!: string;
  @ApiProperty({ type: RefLabelDto }) landlord!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto }) property!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto, nullable: true, description: 'Null: the whole property' }) unit!: RefLabelDto | null;
  @ApiProperty({ enum: SERVICE_LEVELS }) serviceLevel!: string;
  @ApiProperty() currencyCode!: string;
  @ApiProperty({ type: FeeDto, description: 'Recorded only; fees are charged with Finance (Phase 9, P7-D2)' }) fee!: FeeDto;
  @ApiProperty({ type: MoneyDto, nullable: true }) expenseApprovalLimit!: MoneyDto | null;
  @ApiProperty({ type: MoneyDto }) floatAmount!: MoneyDto;
  @ApiProperty({ enum: PAYOUT_FREQUENCIES }) payoutFrequency!: string;
  @ApiProperty({ type: Number, nullable: true }) payoutDay!: number | null;
  @ApiProperty() startDate!: string;
  @ApiProperty({ type: String, nullable: true }) endDate!: string | null;
  @ApiProperty({ type: Number, nullable: true }) noticePeriodDays!: number | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) document!: RefLabelDto | null;
  @ApiProperty({ description: 'Leases under this agreement that are not closed or cancelled' }) liveLeases!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}

export class AgreementPageDto {
  @ApiProperty({ type: [AgreementDto] }) data!: AgreementDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

// ---------------------------------------------------------------------- leases

export class LeasePartyInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID() contactId!: string;
  @ApiProperty({ enum: LEASE_PARTY_ROLES }) @IsIn(LEASE_PARTY_ROLES) partyRole!: (typeof LEASE_PARTY_ROLES)[number];
  @ApiPropertyOptional({ default: false, description: 'One primary tenant per lease' }) @IsOptional() @IsBoolean() isPrimary?: boolean;
  @ApiPropertyOptional({ minimum: 0.0001, maximum: 100, description: 'Share of the rent (tenants and co-tenants); not required to total 100 % (W7-D5)' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(100)
  liabilityShare?: number;
  @ApiPropertyOptional({ default: true, description: 'Grants nothing until the contact accepts a portal invitation (L5)' }) @IsOptional() @IsBoolean() portalAccess?: boolean;
}

class LeaseTermsFields {
  @ApiPropertyOptional({ format: 'uuid', description: 'The agreement that covers the unit (required to collect rent for a collected service level)' })
  @IsOptional() @IsUUID()
  managementAgreementId?: string;
  @ApiProperty({ enum: LEASE_TYPES }) @IsIn(LEASE_TYPES) leaseType!: (typeof LEASE_TYPES)[number];
  @ApiPropertyOptional({ enum: LEASE_USAGES, default: 'residential' }) @IsOptional() @IsIn(LEASE_USAGES) usage?: (typeof LEASE_USAGES)[number];
  @ApiProperty({ example: '2026-12-01' }) @Matches(DATE) startDate!: string;
  @ApiPropertyOptional({ example: '2027-11-30', description: 'Required for fixed-term leases' }) @IsOptional() @Matches(DATE) endDate?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 31 }) @IsOptional() @IsInt() @Min(1) @Max(31) rentDueDay?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 120, default: 1, description: 'Periods paid at signing (charged by the rent schedule, L2)' })
  @IsOptional() @IsInt() @Min(0) @Max(120)
  advancePeriods?: number;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() prorateFirstPeriod?: boolean;
  @ApiPropertyOptional({ type: MoneyInput, description: 'In the rent currency; recorded when received (L4)' }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) deposit?: MoneyInput;
  @ApiPropertyOptional({ minimum: 0, maximum: 3650 }) @IsOptional() @IsInt() @Min(0) @Max(3650) noticePeriodDays?: number;
  @ApiPropertyOptional({ example: '2027-05-31' }) @IsOptional() @Matches(DATE) breakClauseDate?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 3650 }) @IsOptional() @IsInt() @Min(0) @Max(3650) breakNoticeDays?: number;
  @ApiPropertyOptional({ example: '2027-12-01' }) @IsOptional() @Matches(DATE) nextRentReviewDate?: string;
  @ApiPropertyOptional({ example: 'en-GH' }) @IsOptional() @IsString() @MaxLength(20) governingLocaleCode?: string;
}

export class CreateLeaseBody extends LeaseTermsFields {
  @ApiProperty({ format: 'uuid' }) @IsUUID() unitId!: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'The rent listing of the unit; it becomes rented on activation (P7-D4)' }) @IsOptional() @IsUUID() listingId?: string;
  @ApiProperty({ type: MoneyInput, description: 'Rent per period' }) @ValidateNested() @Type(() => MoneyInput) rent!: MoneyInput;
  @ApiProperty({ enum: RENT_FREQUENCIES }) @IsIn(RENT_FREQUENCIES) rentFrequency!: (typeof RENT_FREQUENCIES)[number];
  @ApiProperty({ type: [LeasePartyInput], description: 'One primary tenant. Without a landlord party, the unit\'s current legal owners are added as landlords' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => LeasePartyInput)
  parties!: LeasePartyInput[];
}

/** A letting deal at "terms agreed" (P7-D4): unit, listing, rent and parties come from the deal and its accepted offer. */
export class LeaseFromDealBody extends LeaseTermsFields {
  @ApiPropertyOptional({ type: [LeasePartyInput], description: 'Added to the deal\'s tenants (co-tenants, occupants, guarantors, landlords)' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => LeasePartyInput)
  extraParties?: LeasePartyInput[];
}

/** Draft and pending-signature leases only (terms are fixed once active, migration 0036). */
export class UpdateLeaseBody {
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) @IsOptional() @ValidateIf(notNull) @IsUUID() managementAgreementId?: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) @IsOptional() @ValidateIf(notNull) @IsUUID() listingId?: string | null;
  @ApiPropertyOptional({ enum: LEASE_TYPES }) @IsOptional() @IsIn(LEASE_TYPES) leaseType?: (typeof LEASE_TYPES)[number];
  @ApiPropertyOptional({ enum: LEASE_USAGES }) @IsOptional() @IsIn(LEASE_USAGES) usage?: (typeof LEASE_USAGES)[number];
  @ApiPropertyOptional() @IsOptional() @Matches(DATE) startDate?: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) endDate?: string | null;
  @ApiPropertyOptional({ type: MoneyInput }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) rent?: MoneyInput;
  @ApiPropertyOptional({ enum: RENT_FREQUENCIES }) @IsOptional() @IsIn(RENT_FREQUENCIES) rentFrequency?: (typeof RENT_FREQUENCIES)[number];
  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsInt() @Min(1) @Max(31) rentDueDay?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(120) advancePeriods?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() prorateFirstPeriod?: boolean;
  @ApiPropertyOptional({ type: MoneyInput, nullable: true }) @IsOptional() @ValidateIf(notNull) @ValidateNested() @Type(() => MoneyInput) deposit?: MoneyInput | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsInt() @Min(0) @Max(3650) noticePeriodDays?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) breakClauseDate?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsInt() @Min(0) @Max(3650) breakNoticeDays?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) nextRentReviewDate?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsString() @MaxLength(20) governingLocaleCode?: string | null;
}

export class UpdateLeasePartyBody {
  @ApiPropertyOptional({ type: Number, nullable: true }) @IsOptional() @ValidateIf(notNull) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(100) liabilityShare?: number | null;
  @ApiPropertyOptional({ description: 'The only change allowed once the lease is active' }) @IsOptional() @IsBoolean() portalAccess?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimary?: boolean;
}

export class ActivateLeaseBody {
  @ApiPropertyOptional({ format: 'uuid', description: 'The signed lease, uploaded to this lease and scanned clean (required unless the company turned the rule off, P7-D5)' })
  @IsOptional() @IsUUID()
  documentId?: string;
  @ApiProperty({ example: '2026-11-28', description: 'The day the lease was signed (not in the future)' }) @Matches(DATE) signedOn!: string;
  @ApiPropertyOptional({ example: '2026-12-01', description: 'Default: the start date' }) @IsOptional() @Matches(DATE) moveInDate?: string;
}

export class CancelLeaseBody {
  @ApiProperty({ minLength: 3, maxLength: 500, description: REASON_GUIDANCE }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class LeasePartyDto {
  @ApiProperty({ type: RefLabelDto }) contact!: RefLabelDto;
  @ApiProperty({ enum: LEASE_PARTY_ROLES }) partyRole!: string;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty({ type: Number, nullable: true }) liabilityShare!: number | null;
  @ApiProperty() portalAccess!: boolean;
}

export class LeaseSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: LEASE_STATUSES }) status!: string;
  @ApiProperty({ type: RefLabelDto }) unit!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto }) property!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto, nullable: true }) primaryTenant!: RefLabelDto | null;
  @ApiProperty({ type: MoneyDto }) rent!: MoneyDto;
  @ApiProperty({ enum: RENT_FREQUENCIES }) rentFrequency!: string;
  @ApiProperty({ enum: LEASE_TYPES }) leaseType!: string;
  @ApiProperty() startDate!: string;
  @ApiProperty({ type: String, nullable: true }) endDate!: string | null;
  @ApiProperty() renewalStatus!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class LeasePageDto {
  @ApiProperty({ type: [LeaseSummaryDto] }) data!: LeaseSummaryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class LeaseDto extends LeaseSummaryDto {
  @ApiProperty() jurisdictionCode!: string;
  @ApiProperty({ enum: LEASE_USAGES }) usage!: string;
  @ApiProperty({ type: Number, nullable: true }) rentDueDay!: number | null;
  @ApiProperty() advancePeriods!: number;
  @ApiProperty() prorateFirstPeriod!: boolean;
  @ApiProperty({ type: MoneyDto, nullable: true }) deposit!: MoneyDto | null;
  @ApiProperty({ type: Number, nullable: true }) noticePeriodDays!: number | null;
  @ApiProperty({ type: String, nullable: true }) breakClauseDate!: string | null;
  @ApiProperty({ type: Number, nullable: true }) breakNoticeDays!: number | null;
  @ApiProperty({ type: String, nullable: true }) nextRentReviewDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) governingLocaleCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) moveInDate!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) signedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Why the lease was cancelled or ended' }) endedReason!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) managementAgreement!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) listing!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) deal!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) previousLease!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true, description: 'The renewal drawn up from this lease (not cancelled), L4' }) renewalLease!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true }) moveOutDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) noticeGivenOn!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['tenant', 'landlord', 'agent'] }) noticeGivenBy!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) document!: RefLabelDto | null;
  @ApiProperty({ type: [LeasePartyDto] }) parties!: LeasePartyDto[];
  @ApiProperty({ description: 'No reviewed legal rules exist for this jurisdiction: limits are not enforced (P7-D3)' }) rulesNotReviewed!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'First day rent is charged from (L2); set at activation, or once for an imported lease' }) rentScheduleFrom!: string | null;
  @ApiProperty({ type: MoneyDto, description: 'The rent in force today (from the start date until then): applied rent reviews included' }) currentRent!: MoneyDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}
