import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
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

export const PAYMENT_STATUSES = ['pending', 'cleared', 'bounced', 'refunded', 'voided'] as const;
export const UNWIND_ACTIONS = ['bounce', 'refund', 'void'] as const;
export const IMPORT_LINE_STATUSES = ['matched', 'unmatched', 'duplicate', 'error', 'imported', 'queued'] as const;
export const PLAN_STATUSES = ['active', 'completed', 'broken', 'cancelled'] as const;
export const ARREARS_BUCKETS = ['1-30', '31-60', '61-90', '90+'] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;

// ----------------------------------------------------------------- receipts (RP-1, RP-2)

export class RecordPaymentBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() payerContactId!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: 'The payer is a party of this lease' })
  @IsOptional()
  @ValidateIf(notNull)
  @IsUUID()
  leaseId?: string | null;
  @ApiProperty({ format: 'uuid', description: 'The receipt\'s currency is the account\'s' }) @IsUUID() bankAccountId!: string;
  @ApiProperty({ description: 'Picklist payment_method' }) @IsString() @MaxLength(50) methodCode!: string;
  @ApiProperty({ type: MoneyInput }) @ValidateNested() @Type(() => MoneyInput) amount!: MoneyInput;
  @ApiProperty() @Matches(DATE) receivedOn!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 50 }) @IsOptional() @ValidateIf(notNull) @IsString() @MaxLength(50) instrumentNumber?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Cheque date: a cheque dated after today stays pending until cleared' })
  @IsOptional()
  @ValidateIf(notNull)
  @Matches(DATE)
  instrumentDate?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 }) @IsOptional() @ValidateIf(notNull) @IsString() @MaxLength(100) instrumentBank?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000, description: 'No identity or bank numbers' })
  @IsOptional()
  @ValidateIf(notNull)
  @IsString()
  @MaxLength(1000)
  notes?: string | null;
}

export class PaymentDto {
  @ApiProperty() id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ type: RefLabelDto }) payer!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto, nullable: true }) lease!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto }) bankAccount!: RefLabelDto;
  @ApiProperty() methodCode!: string;
  @ApiProperty({ type: MoneyDto }) amount!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) allocated!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Cleared receipts only; zero otherwise' }) unallocated!: MoneyDto;
  @ApiProperty() receivedOn!: string;
  @ApiProperty({ type: String, nullable: true }) valueDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) instrumentNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) instrumentDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) instrumentBank!: string | null;
  @ApiProperty({ enum: PAYMENT_STATUSES }) status!: string;
  @ApiProperty({ type: String, nullable: true }) statusReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ description: 'Recorded from a bank file' }) imported!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class PaymentPageDto {
  @ApiProperty({ type: [PaymentDto] }) data!: PaymentDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class ClearPaymentBody {
  @ApiProperty({ description: 'The day the funds are available' }) @Matches(DATE) valueDate!: string;
}

export class UnwindPaymentBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiProperty({ description: 'The date of the reversals, in an open period' }) @Matches(DATE) on!: string;
}

export class UnwindResultDto {
  @ApiProperty({ type: PaymentDto }) payment!: PaymentDto;
  @ApiProperty({ description: 'Allocations reversed; the charges are owed again' }) reversed!: number;
}

// ----------------------------------------------------------------- allocation (RP-4)

export class AllocationLineInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID() rentChargeId!: string;
  @ApiProperty({ type: MoneyInput }) @ValidateNested() @Type(() => MoneyInput) amount!: MoneyInput;
}

export class AllocateBody {
  @ApiProperty({ type: [AllocationLineInput], minItems: 1, maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AllocationLineInput)
  lines!: AllocationLineInput[];
  @ApiProperty({ description: 'In an open period' }) @Matches(DATE) allocatedOn!: string;
}

export class AllocationDto {
  @ApiProperty() id!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty() paymentReference!: string;
  @ApiProperty() rentChargeId!: string;
  @ApiProperty() chargeDescription!: string;
  @ApiProperty({ type: MoneyDto, description: 'Negative for a reversal' }) amount!: MoneyDto;
  @ApiProperty() allocatedOn!: string;
  @ApiProperty({ type: String, nullable: true }) reversalOfId!: string | null;
  @ApiProperty({ description: 'This allocation has been reversed' }) reversed!: boolean;
}

export class SuggestedLineDto {
  @ApiProperty() rentChargeId!: string;
  @ApiProperty({ type: RefLabelDto }) lease!: RefLabelDto;
  @ApiProperty() description!: string;
  @ApiProperty() dueDate!: string;
  @ApiProperty({ type: MoneyDto }) outstanding!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Suggested, oldest due first; not applied (P7-D8)' }) suggested!: MoneyDto;
}

export class AllocationViewDto {
  @ApiProperty({ type: PaymentDto }) payment!: PaymentDto;
  @ApiProperty({ type: [AllocationDto] }) allocations!: AllocationDto[];
  @ApiProperty({ type: [SuggestedLineDto], description: 'Outstanding charges of the receipt\'s lease (or the payer\'s leases), in its currency, oldest due first' })
  suggestion!: SuggestedLineDto[];
}

export class ReverseAllocationBody {
  @ApiProperty({ description: 'In an open period' }) @Matches(DATE) on!: string;
}

// ----------------------------------------------------------------- bank-file import (RP-3)

export class CheckImportBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() bankAccountId!: string;
  @ApiProperty({ format: 'uuid', description: 'A clean bank statement document of the account (text/csv, EstatePro CSV v1)' }) @IsUUID() documentId!: string;
}

export class ImportLineDto {
  @ApiProperty() id!: string;
  @ApiProperty() lineNo!: number;
  @ApiProperty({ type: String, nullable: true }) date!: string | null;
  @ApiProperty({ type: MoneyDto, nullable: true }) amount!: MoneyDto | null;
  @ApiProperty({ type: String, nullable: true }) reference!: string | null;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: String, nullable: true }) transactionId!: string | null;
  @ApiProperty({ enum: IMPORT_LINE_STATUSES }) status!: string;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) lease!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) payer!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true }) paymentId!: string | null;
  @ApiProperty() version!: number;
}

export class ImportSummaryDto {
  @ApiProperty() lines!: number;
  @ApiProperty() matched!: number;
  @ApiProperty() unmatched!: number;
  @ApiProperty() duplicate!: number;
  @ApiProperty() error!: number;
  @ApiProperty() imported!: number;
  @ApiProperty() queued!: number;
}

export class PaymentImportDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: RefLabelDto }) bankAccount!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto }) document!: RefLabelDto;
  @ApiProperty() format!: string;
  @ApiProperty({ enum: ['checked', 'committed', 'cancelled'] }) status!: string;
  @ApiProperty({ type: ImportSummaryDto }) summary!: ImportSummaryDto;
  @ApiProperty({ type: [ImportLineDto] }) lines!: ImportLineDto[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class ImportChoiceInput {
  @ApiProperty() @IsInt() @Min(1) lineNo!: number;
  @ApiProperty({ format: 'uuid' }) @IsUUID() payerContactId!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' }) @IsOptional() @ValidateIf(notNull) @IsUUID() leaseId?: string | null;
}

export class CommitImportBody {
  @ApiProperty({ type: [ImportChoiceInput], description: 'Payers chosen for unmatched lines; other unmatched lines wait in the queue' })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => ImportChoiceInput)
  choices!: ImportChoiceInput[];
}

export class MatchLineBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() payerContactId!: string;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' }) @IsOptional() @ValidateIf(notNull) @IsUUID() leaseId?: string | null;
}

export class ImportLinePageDto {
  @ApiProperty({ type: [ImportLineDto] }) data!: ImportLineDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

// ----------------------------------------------------------------- arrears (AR-1, AR-2)

export class ArrearsStepInput {
  @ApiProperty({ description: 'Picklist arrears_action' }) @IsString() @MaxLength(50) actionCode!: string;
  @ApiProperty({ minimum: 1, maximum: 365, description: 'Days past the oldest unpaid due date' }) @IsInt() @Min(1) @Max(365) afterDays!: number;
}

export class ArrearsStepDto {
  @ApiProperty() actionCode!: string;
  @ApiProperty() afterDays!: number;
}

export class ArrearsRowDto {
  @ApiProperty({ type: RefLabelDto }) lease!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto, nullable: true }) tenant!: RefLabelDto | null;
  @ApiProperty() currency!: string;
  @ApiProperty({ type: MoneyDto }) outstanding!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) days1To30!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) days31To60!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) days61To90!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) daysOver90!: MoneyDto;
  @ApiProperty() oldestDueDate!: string;
  @ApiProperty() daysPastDue!: number;
  @ApiProperty({ type: String, nullable: true }) lastActionCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextActionDate!: string | null;
  @ApiProperty({ description: 'An active payment plan pauses the workflow' }) planActive!: boolean;
}

export class ArrearsTotalDto {
  @ApiProperty() currency!: string;
  @ApiProperty() leases!: number;
  @ApiProperty({ type: MoneyDto }) outstanding!: MoneyDto;
}

export class ArrearsPageDto {
  @ApiProperty() asOf!: string;
  @ApiProperty({ type: [ArrearsRowDto] }) data!: ArrearsRowDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
  @ApiProperty({ type: [ArrearsTotalDto], description: 'Per currency over every lease the filters match' }) totals!: ArrearsTotalDto[];
}

export class ArrearsActionBody {
  @ApiProperty({ description: 'Picklist arrears_action' }) @IsString() @MaxLength(50) actionCode!: string;
  @ApiProperty() @Matches(DATE) actionDate!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: 'No identity or bank numbers' })
  @IsOptional()
  @ValidateIf(notNull)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) nextActionDate?: string | null;
}

export class ArrearsActionDto {
  @ApiProperty() id!: string;
  @ApiProperty() actionCode!: string;
  @ApiProperty() actionDate!: string;
  @ApiProperty({ type: MoneyDto, nullable: true }) arrears!: MoneyDto | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextActionDate!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) performedBy!: RefLabelDto | null;
  @ApiProperty({ enum: ['manual', 'automation'] }) source!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class InstalmentInput {
  @ApiProperty() @Matches(DATE) dueDate!: string;
  @ApiProperty({ type: MoneyInput }) @ValidateNested() @Type(() => MoneyInput) amount!: MoneyInput;
}

export class PaymentPlanBody {
  @ApiProperty({ type: [InstalmentInput], minItems: 1, maxItems: 60 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => InstalmentInput)
  instalments!: InstalmentInput[];
  @ApiProperty() @Matches(DATE) agreedOn!: string;
}

export class ClosePlanBody {
  @ApiProperty({ enum: ['completed', 'broken', 'cancelled'] }) @IsIn(['completed', 'broken', 'cancelled']) status!: 'completed' | 'broken' | 'cancelled';
  @ApiProperty() @Matches(DATE) closedOn!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 }) @IsOptional() @ValidateIf(notNull) @IsString() @MaxLength(500) reason?: string | null;
}

export class InstalmentDto {
  @ApiProperty() dueDate!: string;
  @ApiProperty({ type: MoneyDto }) amount!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Cumulative amount due by this date' }) dueToDate!: MoneyDto;
}

export class PaymentPlanDto {
  @ApiProperty() id!: string;
  @ApiProperty() leaseId!: string;
  @ApiProperty({ type: MoneyDto }) total!: MoneyDto;
  @ApiProperty({ type: [InstalmentDto] }) instalments!: InstalmentDto[];
  @ApiProperty() agreedOn!: string;
  @ApiProperty({ enum: PLAN_STATUSES }) status!: string;
  @ApiProperty({ type: MoneyDto, description: 'Allocated to the lease\'s charges since the plan was agreed' }) paidSinceAgreed!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'Instalments due by today' }) dueToDate!: MoneyDto;
  @ApiProperty({ description: 'Active and paid less than is due by today' }) behind!: boolean;
  @ApiProperty({ type: String, nullable: true }) closedOn!: string | null;
  @ApiProperty({ type: String, nullable: true }) closedReason!: string | null;
  @ApiProperty() version!: number;
}

export class LeaseArrearsDto {
  @ApiProperty({ type: RefLabelDto }) lease!: RefLabelDto;
  @ApiProperty() asOf!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ type: MoneyDto }) outstanding!: MoneyDto;
  @ApiProperty({ type: String, nullable: true }) oldestDueDate!: string | null;
  @ApiProperty() daysPastDue!: number;
  @ApiProperty({ type: [ArrearsStepDto], description: 'The company\'s steps (ST-2); empty when not set' }) steps!: ArrearsStepDto[];
  @ApiProperty({ type: ArrearsStepDto, nullable: true, description: 'The step the arrears have reached' }) currentStep!: ArrearsStepDto | null;
  @ApiProperty({ type: [ArrearsActionDto] }) actions!: ArrearsActionDto[];
  @ApiProperty({ type: [PaymentPlanDto] }) plans!: PaymentPlanDto[];
}
