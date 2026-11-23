import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { MoneyDto, MoneyInput } from '../common/money.js';
import { RefLabelDto } from '../contacts/dto.js';
import { PageDto } from '../properties/dto.js';
import { ArrearsStepDto, ArrearsStepInput } from './receipts.dto.js';

export const CHARGE_TYPES = ['rent', 'service_charge', 'deposit', 'fee', 'utility', 'late_fee', 'repair_recharge', 'other'] as const;
/** Types a person adds (RC-2): the schedule creates rent; deposits are L4. Late fees are added by a person, never computed (L3-D10). */
export const MANUAL_CHARGE_TYPES = ['service_charge', 'utility', 'repair_recharge', 'fee', 'late_fee', 'other'] as const;
export const CHARGE_STATUSES = ['scheduled', 'posted', 'waived', 'cancelled'] as const;
export const REVIEW_METHODS = ['fixed_increase', 'percentage', 'index_linked', 'market', 'negotiated'] as const;
export const REVIEW_STATUSES = ['scheduled', 'proposed', 'agreed', 'applied', 'disputed', 'cancelled'] as const;
export const REVIEW_ACTIONS = ['propose', 'agree', 'dispute', 'cancel', 'edit'] as const;
/** The highest lead time for charges, in days (a quarter ahead). */
export const MAX_LEAD_DAYS = 90;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;

// ----------------------------------------------------------------- settings (ST-2)

export class LettingsSettingsDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Charges are created this many days before they are due (P7-D6). Not set: the rent schedule is idle (W7-D7)' })
  chargeLeadDays!: number | null;
  @ApiProperty({ description: 'Activation needs the signed lease (P7-D5); on unless turned off' }) requireSignedLease!: boolean;
  @ApiProperty({ type: [ArrearsStepDto], description: 'The company\'s arrears steps (P7-D10), in increasing days; empty: the workflow is idle (W7-D7)' })
  arrearsSteps!: ArrearsStepDto[];
  @ApiProperty({ type: [String], description: "The company's default inspection areas (IN-2), offered when a unit has no earlier inspection; none until set" })
  inspectionAreas!: string[];
}

export class LettingsSettingsBody {
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: MAX_LEAD_DAYS })
  @ValidateIf(notNull)
  @IsInt()
  @Min(0)
  @Max(MAX_LEAD_DAYS)
  chargeLeadDays!: number | null;

  @ApiProperty() @IsBoolean() requireSignedLease!: boolean;

  @ApiPropertyOptional({ type: [ArrearsStepInput], maxItems: 10, description: 'Replaces the steps; leave out to keep them' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ArrearsStepInput)
  arrearsSteps?: ArrearsStepInput[];

  @ApiPropertyOptional({ type: [String], maxItems: 50, description: 'Replaces the default inspection areas; leave out to keep them' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(100, { each: true })
  inspectionAreas?: string[];
}

// ----------------------------------------------------------------- charges

export class ChargeBalanceDto {
  @ApiProperty({ type: MoneyDto, description: 'Amount plus tax' }) total!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Sum of adjustments (negative: credits)' }) adjustments!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Net allocated from receipts' }) paid!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Total + adjustments − paid (posted charges; zero otherwise)' }) outstanding!: MoneyDto;
}

export class RentChargeDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: RefLabelDto }) lease!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto, nullable: true }) tenant!: RefLabelDto | null;
  @ApiProperty({ enum: CHARGE_TYPES }) chargeType!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: String, nullable: true }) periodStart!: string | null;
  @ApiProperty({ type: String, nullable: true }) periodEnd!: string | null;
  @ApiProperty() dueDate!: string;
  @ApiProperty({ type: MoneyDto }) amount!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) tax!: MoneyDto;
  @ApiProperty({ type: String, nullable: true }) taxCodeId!: string | null;
  @ApiProperty({ type: ChargeBalanceDto }) balance!: ChargeBalanceDto;
  @ApiProperty({ enum: CHARGE_STATUSES }) status!: string;
  @ApiProperty({ type: String, nullable: true }) waivedReason!: string | null;
  @ApiProperty({ enum: ['schedule', 'manual', 'import', 'automation'] }) source!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) postedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class CurrencyTotalDto {
  @ApiProperty() currency!: string;
  @ApiProperty() count!: number;
  @ApiProperty({ type: MoneyDto }) total!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) outstanding!: MoneyDto;
}

export class DueDateWindowDto {
  @ApiProperty() gte!: string;
  @ApiProperty() lte!: string;
}

export class RentChargePageDto {
  @ApiProperty({ type: [RentChargeDto] }) data!: RentChargeDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
  @ApiProperty({ type: [CurrencyTotalDto], description: 'Per currency over every charge the filters match (never summed across currencies)' })
  totals!: CurrencyTotalDto[];
  @ApiProperty({ type: DueDateWindowDto, nullable: true, description: 'With no due-date or lease filter: the month applied (this month, company time zone)' })
  dueDateWindow!: DueDateWindowDto | null;
}

export class CreateChargeBody {
  @ApiProperty({ enum: MANUAL_CHARGE_TYPES }) @IsIn(MANUAL_CHARGE_TYPES) chargeType!: string;
  @ApiProperty({ minLength: 1, maxLength: 200 }) @IsString() @MinLength(1) @MaxLength(200) description!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) periodStart?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) periodEnd?: string | null;
  @ApiProperty() @Matches(DATE) dueDate!: string;
  @ApiProperty({ type: MoneyInput, description: 'Before tax; in the lease currency' }) @ValidateNested() @Type(() => MoneyInput) amount!: MoneyInput;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Tax computed from the code\'s components in force on the due date' })
  @IsOptional()
  @ValidateIf(notNull)
  @IsUUID()
  taxCodeId?: string | null;
  @ApiProperty({ enum: ['post', 'schedule'], description: 'Post now, or schedule: posted on the due date by the rent job' })
  @IsIn(['post', 'schedule'])
  when!: 'post' | 'schedule';
}

export class ReasonBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class AdjustmentBody {
  @ApiProperty({ enum: ['credit', 'debit'], description: 'Credit reduces what is owed; debit adds to it' }) @IsIn(['credit', 'debit']) direction!: 'credit' | 'debit';
  @ApiProperty({ type: MoneyInput, description: 'Positive; in the charge currency' }) @ValidateNested() @Type(() => MoneyInput) amount!: MoneyInput;
  @ApiProperty({ description: 'In an open financial period' }) @Matches(DATE) adjustedOn!: string;
  @ApiProperty({ minLength: 3, maxLength: 500 }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty({ description: 'A member who holds rent.manage for this lease (W7-D2)' }) @IsUUID() approvedBy!: string;
}

export class AdjustmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() rentChargeId!: string;
  @ApiProperty({ type: MoneyDto, description: 'Signed: negative is a credit' }) amount!: MoneyDto;
  @ApiProperty() adjustedOn!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ type: RefLabelDto }) approvedBy!: RefLabelDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AdjustmentPreviewDto {
  @ApiProperty({ type: ChargeBalanceDto }) before!: ChargeBalanceDto;
  @ApiProperty({ type: ChargeBalanceDto }) after!: ChargeBalanceDto;
}

export class AdjustmentResultDto {
  @ApiProperty({ type: AdjustmentDto }) adjustment!: AdjustmentDto;
  @ApiProperty({ type: RentChargeDto }) charge!: RentChargeDto;
}

// ----------------------------------------------------------------- ledger (RL-1)

export const LEDGER_KINDS = ['charge', 'payment', 'reversal', 'adjustment'] as const;

export class LedgerEntryDto {
  @ApiProperty() date!: string;
  @ApiProperty({ enum: LEDGER_KINDS }) kind!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: MoneyDto, nullable: true, description: 'Charges (posted) add to the balance' }) charge!: MoneyDto | null;
  @ApiProperty({ type: MoneyDto, nullable: true, description: 'Allocated receipts reduce it; reversals are negative' }) paid!: MoneyDto | null;
  @ApiProperty({ type: MoneyDto, nullable: true, description: 'Signed adjustment' }) adjustment!: MoneyDto | null;
  @ApiProperty({ type: MoneyDto }) balance!: MoneyDto;
  @ApiProperty({ description: 'False for waived or cancelled charges: shown, not counted' }) counted!: boolean;
  @ApiProperty({ type: String, nullable: true, enum: CHARGE_STATUSES }) chargeStatus!: string | null;
  @ApiProperty({ type: String, nullable: true }) rentChargeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) paymentId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Receipt reference' }) paymentReference!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Shown to members who may see contacts' }) payerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) adjustmentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) approvedByName!: string | null;
}

export class AgeingDto {
  @ApiProperty({ type: MoneyDto }) outstanding!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Due on the day (not yet late)' }) current!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) days1To30!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) days31To60!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) days61To90!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) daysOver90!: MoneyDto;
}

export class LedgerDto {
  @ApiProperty({ type: RefLabelDto }) lease!: RefLabelDto;
  @ApiProperty() currency!: string;
  @ApiProperty() asOf!: string;
  @ApiProperty({ type: [LedgerEntryDto] }) entries!: LedgerEntryDto[];
  @ApiProperty({ type: AgeingDto, description: 'Readiness §5.4 buckets, days past due as of the date' }) ageing!: AgeingDto;
  @ApiProperty({ type: [RentChargeDto], description: 'Posted charges due after the date (created ahead by the lead time)' }) upcoming!: RentChargeDto[];
}

// ----------------------------------------------------------------- rent reviews (RR-1)

export class RentReviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() leaseId!: string;
  @ApiProperty() reviewDate!: string;
  @ApiProperty({ enum: REVIEW_METHODS }) method!: string;
  @ApiProperty({ type: MoneyDto }) current!: MoneyDto;
  @ApiProperty({ type: MoneyDto, nullable: true }) proposed!: MoneyDto | null;
  @ApiProperty({ type: MoneyDto, nullable: true }) agreed!: MoneyDto | null;
  @ApiProperty({ type: String, nullable: true }) effectiveFrom!: string | null;
  @ApiProperty({ enum: REVIEW_STATUSES }) status!: string;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'When the "review due" notice went to the outbox (delivery in Phase 12)' })
  dueNotifiedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class RentReviewListDto {
  @ApiProperty({ type: [RentReviewDto] }) data!: RentReviewDto[];
}

export class ScheduleReviewBody {
  @ApiProperty() @Matches(DATE) reviewDate!: string;
  @ApiProperty({ enum: REVIEW_METHODS }) @IsIn(REVIEW_METHODS) method!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @ValidateIf(notNull) @IsString() @MaxLength(2000) notes?: string | null;
}

export class UpdateReviewBody {
  @ApiProperty({ enum: REVIEW_ACTIONS, description: 'edit (date, method, notes, while open and not agreed), propose, agree, dispute, cancel' })
  @IsIn(REVIEW_ACTIONS)
  action!: (typeof REVIEW_ACTIONS)[number];
  @ApiPropertyOptional() @IsOptional() @Matches(DATE) reviewDate?: string;
  @ApiPropertyOptional({ enum: REVIEW_METHODS }) @IsOptional() @IsIn(REVIEW_METHODS) method?: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 }) @IsOptional() @ValidateIf(notNull) @IsString() @MaxLength(2000) notes?: string | null;
  @ApiPropertyOptional({ type: MoneyInput, description: 'propose' }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) proposed?: MoneyInput;
  @ApiPropertyOptional({ type: MoneyInput, description: 'agree' }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) agreed?: MoneyInput;
  @ApiPropertyOptional({ description: 'agree: when the new rent applies' }) @IsOptional() @Matches(DATE) effectiveFrom?: string;
}

export class RentScheduleBody {
  @ApiProperty({ description: 'First day rent is charged from (an imported live lease); fixed once set' }) @Matches(DATE) from!: string;
}
