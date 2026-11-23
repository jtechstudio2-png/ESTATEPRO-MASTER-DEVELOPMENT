import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { MoneyDto, MoneyInput } from '../common/money.js';
import { RefLabelDto } from '../contacts/dto.js';

export const HOLDER_TYPES = ['agent', 'landlord', 'protection_scheme', 'government_body', 'other'] as const;
export const DEPOSIT_STATUSES = ['expected', 'held', 'protected', 'return_pending', 'partially_returned', 'returned', 'forfeited', 'disputed'] as const;
export const DEDUCTION_STATUSES = ['proposed', 'agreed', 'disputed', 'adjudicated', 'withdrawn'] as const;
export const DEDUCTION_ACTIONS = ['agree', 'dispute', 'adjudicate', 'withdraw', 'attach_evidence'] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

// ----------------------------------------------------------------- requests (DP-1)

/** Registers the lease's deposit, or changes how it is held. Fields left out are kept. */
export class DepositBody {
  @ApiProperty({ enum: HOLDER_TYPES }) @IsIn(HOLDER_TYPES) holderType!: (typeof HOLDER_TYPES)[number];
  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid', description: "The agency's account holding it (required when the agent holds it), in the lease's currency" })
  @IsOptional()
  @ValidateIf(notNull)
  @IsUUID()
  holdingAccountId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 200 }) @IsOptional() @ValidateIf(notNull) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) schemeName?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Only where no reviewed jurisdiction rule exists (P7-D11); with a rule it follows from the date received',
  })
  @IsOptional()
  @ValidateIf(notNull)
  @Matches(DATE)
  protectionDeadline?: string | null;
  @ApiPropertyOptional({ description: 'When the agency does not collect the deposit (let only): the day it was received. Otherwise the receipt that pays the deposit charge records it' })
  @IsOptional()
  @Matches(DATE)
  receivedOn?: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'The day the return is due (entered; no rule is applied)' }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) returnDueBy?: string | null;
}

export class ProtectionBody {
  @ApiProperty({ maxLength: 200 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) schemeName!: string;
  @ApiProperty({ maxLength: 100 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) schemeReference!: string;
  @ApiProperty({ example: '2026-12-15', description: 'Not in the future, not before the deposit was received' }) @Matches(DATE) protectedOn!: string;
}

export class DeductionBody {
  @ApiProperty({ description: 'Picklist deposit_deduction_reason' }) @IsString() @MaxLength(50) reasonCode!: string;
  @ApiProperty({ maxLength: 500, description: 'Erased with the tenant (ADR-009). Do not type identity or bank numbers' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;
  @ApiProperty({ type: MoneyInput, description: "In the deposit's currency" }) @ValidateNested() @Type(() => MoneyInput) amount!: MoneyInput;
  @ApiPropertyOptional({ format: 'uuid', description: 'A clean document of the lease or of one of its inspections (move-out report, photo)' })
  @IsOptional()
  @IsUUID()
  evidenceDocumentId?: string;
}

export class DeductionDecisionBody {
  @ApiProperty({ enum: DEDUCTION_ACTIONS, description: 'proposed → agree, dispute, withdraw, attach_evidence; disputed → agree, adjudicate, withdraw' })
  @IsIn(DEDUCTION_ACTIONS)
  action!: (typeof DEDUCTION_ACTIONS)[number];
  @ApiPropertyOptional({ type: MoneyInput, description: 'adjudicate: the amount decided (at most the amount claimed)' }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) settledAmount?: MoneyInput;
  @ApiPropertyOptional({ format: 'uuid', description: 'attach_evidence: the document' }) @IsOptional() @IsUUID() evidenceDocumentId?: string;
}

export class ReturnDepositBody {
  @ApiProperty({ example: '2027-01-10', description: 'The day the money was returned (not in the future). The payment itself is made outside EstatePro until payouts (Phase 9)' })
  @Matches(DATE)
  returnedOn!: string;
}

// ----------------------------------------------------------------- responses

export class DeductionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reasonCode!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ type: MoneyDto }) amount!: MoneyDto;
  @ApiProperty({ type: MoneyDto, nullable: true, description: 'Agreed (the amount) or adjudicated (the amount decided)' }) settledAmount!: MoneyDto | null;
  @ApiProperty({ enum: DEDUCTION_STATUSES }) status!: string;
  @ApiProperty({ type: RefLabelDto, nullable: true }) evidenceDocument!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) createdBy!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: RefLabelDto, nullable: true }) decidedBy!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty() version!: number;
}

export class ProtectionRuleDto {
  @ApiProperty({ description: 'A reviewed protection period exists for the jurisdiction (P7-D3, P7-D11)' }) reviewed!: boolean;
  @ApiProperty({ type: Number, nullable: true }) days!: number | null;
  @ApiProperty({ type: Boolean, nullable: true, description: 'Protection is required (reviewed value), or null when no reviewed value exists' }) required!: boolean | null;
  @ApiProperty({ type: String, nullable: true, description: 'The source of the reviewed value' }) source!: string | null;
}

export class DepositDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: RefLabelDto }) lease!: RefLabelDto;
  @ApiProperty({ enum: DEPOSIT_STATUSES }) status!: string;
  @ApiProperty({ type: MoneyDto }) amount!: MoneyDto;
  @ApiProperty({ enum: HOLDER_TYPES }) holderType!: string;
  @ApiProperty({ type: RefLabelDto, nullable: true }) holdingAccount!: RefLabelDto | null;
  @ApiProperty({ description: 'The agency collects it: a deposit charge is raised and the receipt that pays it in full makes the deposit held' }) collected!: boolean;
  @ApiProperty({ type: MoneyDto, nullable: true, description: 'What is still owed on the deposit charge' }) chargeOutstanding!: MoneyDto | null;
  @ApiProperty({ type: String, nullable: true }) receivedOn!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true, description: 'The receipt that paid the deposit charge in full' }) receivedPayment!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true }) schemeName!: string | null;
  @ApiProperty({ type: String, nullable: true }) schemeReference!: string | null;
  @ApiProperty({ type: String, nullable: true }) protectionDeadline!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['jurisdiction', 'entered'] }) protectionDeadlineSource!: string | null;
  @ApiProperty({ description: 'Held, not protected, and the deadline has passed' }) protectionOverdue!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) protectedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) returnDueBy!: string | null;
  @ApiProperty({ type: [DeductionDto] }) deductions!: DeductionDto[];
  @ApiProperty({ type: MoneyDto, description: 'Agreed and adjudicated deductions' }) settledDeductions!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'The deposit less its settled deductions' }) toReturn!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) returnedAmount!: MoneyDto;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) returnedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}

export class LeaseDepositDto {
  @ApiProperty({ type: DepositDto, nullable: true }) deposit!: DepositDto | null;
  @ApiProperty({ type: MoneyDto, nullable: true, description: "The deposit the lease's terms name" }) agreed!: MoneyDto | null;
  @ApiProperty({ type: ProtectionRuleDto }) protectionRule!: ProtectionRuleDto;
}
