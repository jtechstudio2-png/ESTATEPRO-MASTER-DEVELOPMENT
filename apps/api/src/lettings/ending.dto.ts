import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

import { MoneyDto, MoneyInput } from '../common/money.js';
import { LEASE_TYPES, LeaseDto, RENT_FREQUENCIES } from './lettings.dto.js';

export const NOTICE_GIVERS = ['tenant', 'landlord', 'agent'] as const;
export const RENEWAL_DECISIONS = ['renew', 'not_renewing', 'later'] as const;
export const RENEWAL_STATUSES = ['not_due', 'pending_decision', 'renewing', 'not_renewing', 'renewed'] as const;
export const CLOSE_CONDITIONS = ['balance', 'receipts', 'deposit', 'move_out_inspection'] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const REASON_GUIDANCE = 'Kept on the record. Do not type identity or bank numbers';

// ----------------------------------------------------------------- notice and ending (LS-6)

export class NoticeBody {
  @ApiProperty({ enum: NOTICE_GIVERS }) @IsIn(NOTICE_GIVERS) givenBy!: (typeof NOTICE_GIVERS)[number];
  @ApiProperty({ example: '2026-12-10', description: 'The day notice was given (not in the future)' }) @Matches(DATE) givenOn!: string;
  @ApiPropertyOptional({
    example: '2027-02-28',
    description: "The day the tenancy ends. Default: the given date plus the lease's notice days. Shown against the lease's terms, not enforced as law (P7-D3)",
  })
  @IsOptional()
  @Matches(DATE)
  endsOn?: string;
  @ApiPropertyOptional({ maxLength: 500, description: REASON_GUIDANCE }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason?: string;
}

export class EndLeaseBody {
  @ApiPropertyOptional({ example: '2027-02-28', description: 'The day the tenant moved out (not in the future). Not needed when the lease was renewed' })
  @IsOptional()
  @Matches(DATE)
  moveOutDate?: string;
  @ApiPropertyOptional({ maxLength: 500, description: REASON_GUIDANCE }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason?: string;
}

export class ChargeAfterEndDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: String, nullable: true }) periodStart!: string | null;
  @ApiProperty({ type: String, nullable: true }) periodEnd!: string | null;
  @ApiProperty() dueDate!: string;
  @ApiProperty({ type: MoneyDto }) total!: MoneyDto;
}

export class NoticeResultDto {
  @ApiProperty({ type: LeaseDto }) lease!: LeaseDto;
  @ApiProperty({ description: 'Days between the notice and the end of the tenancy' }) noticeDays!: number;
  @ApiProperty({ type: Number, nullable: true, description: "The lease's notice period, for comparison (not enforced, P7-D3)" }) agreedNoticeDays!: number | null;
  @ApiProperty({
    type: [ChargeAfterEndDto],
    description: 'Charges already raised for days after the new end date: nothing is changed automatically; adjust or cancel them (RC-3, RC-4)',
  })
  chargesAfterEnd!: ChargeAfterEndDto[];
}

export class CloseConditionDto {
  @ApiProperty({ enum: CLOSE_CONDITIONS }) code!: string;
  @ApiProperty() met!: boolean;
  @ApiProperty({ description: 'Closing waits for this condition (the move-out inspection is shown, not required)' }) required!: boolean;
  @ApiProperty({ type: MoneyDto, nullable: true, description: 'balance: what is still owed; receipts: money received and not allocated or not cleared' }) amount!: MoneyDto | null;
  @ApiProperty({ type: String, nullable: true, description: 'deposit: its status; move_out_inspection: its status' }) status!: string | null;
}

export class CloseCheckDto {
  @ApiProperty() canClose!: boolean;
  @ApiProperty({ type: [CloseConditionDto] }) conditions!: CloseConditionDto[];
}

// ----------------------------------------------------------------- renewal (LS-7)

export class RenewalDecisionBody {
  @ApiProperty({ enum: RENEWAL_DECISIONS, description: 'renew and not_renewing close the renewal reminders; later keeps them' })
  @IsIn(RENEWAL_DECISIONS)
  decision!: (typeof RENEWAL_DECISIONS)[number];
}

/** Terms of the renewal lease; anything left out is copied from the current lease. */
export class RenewalLeaseBody {
  @ApiPropertyOptional({ enum: LEASE_TYPES }) @IsOptional() @IsIn(LEASE_TYPES) leaseType?: (typeof LEASE_TYPES)[number];
  @ApiPropertyOptional({ example: '2027-12-31', description: 'Required for a fixed term. The renewal starts the day after the current lease ends' })
  @IsOptional()
  @Matches(DATE)
  endDate?: string;
  @ApiPropertyOptional({ type: MoneyInput, description: 'Default: the rent in force when the current lease ends' }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) rent?: MoneyInput;
  @ApiPropertyOptional({ enum: RENT_FREQUENCIES }) @IsOptional() @IsIn(RENT_FREQUENCIES) rentFrequency?: (typeof RENT_FREQUENCIES)[number];
  @ApiPropertyOptional({ minimum: 1, maximum: 31 }) @IsOptional() @IsInt() @Min(1) @Max(31) rentDueDay?: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 3650 }) @IsOptional() @IsInt() @Min(0) @Max(3650) noticePeriodDays?: number;
  @ApiPropertyOptional({ example: '2027-12-01' }) @IsOptional() @Matches(DATE) nextRentReviewDate?: string;
}
