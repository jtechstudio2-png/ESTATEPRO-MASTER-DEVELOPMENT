import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
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

export const DEAL_TYPES = ['sale', 'letting'] as const;
export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;
export const STAGE_CLASSES = ['lead', 'qualification', 'viewing', 'negotiation', 'offer_accepted', 'contract', 'closed_won', 'closed_lost'] as const;
/** Stages a member moves a deal to by hand; later stages follow offers, exchange, completion and losing (§4.3). */
export const MANUAL_STAGE_CLASSES = ['lead', 'qualification', 'viewing', 'negotiation'] as const;
export const PARTY_ROLES = ['buyer', 'seller', 'tenant', 'landlord', 'guarantor', 'buyer_lawyer', 'seller_lawyer', 'lender', 'other_agent', 'other'] as const;
export const AGENT_ROLES = ['lister', 'seller_agent', 'co_agent', 'referrer'] as const;
export const SALE_STATUSES = ['pending', 'exchanged', 'completed', 'fallen_through', 'rescinded'] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const notNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const NOTE_GUIDANCE = 'Kept on the record, never in audit. Do not type identity or bank numbers';

// ---------------------------------------------------------------- requests

export class CreateDealBody {
  @ApiProperty({ enum: DEAL_TYPES }) @IsIn(DEAL_TYPES) dealType!: (typeof DEAL_TYPES)[number];
  @ApiProperty({ format: 'uuid', description: 'The buyer or tenant applicant' }) @IsUUID() primaryContactId!: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'A live listing of the matching type (sale for sales, rent for lettings); needed before offers' })
  @IsOptional() @IsUUID()
  listingId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: "Default: the listing's office, else your first office" }) @IsOptional() @IsUUID() officeId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'The responsible agent (default: you); someone else is a manager action' })
  @IsOptional() @IsUUID()
  ownerMembershipId?: string;
  @ApiPropertyOptional({ type: MoneyInput, description: 'Expected price, or rent per year; default from the listing' })
  @IsOptional() @ValidateNested() @Type(() => MoneyInput)
  expectedValue?: MoneyInput;
  @ApiPropertyOptional({ type: MoneyInput, description: 'Expected agency income' }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) expectedFee?: MoneyInput;
  @ApiPropertyOptional({ example: '2027-03-31' }) @IsOptional() @Matches(DATE) expectedCloseDate?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 100, description: "Overrides the stage's probability in the forecast" })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  probabilityOverride?: number;
  @ApiPropertyOptional({ description: 'Picklist "lead_source" (walk-in, referral, …)' }) @IsOptional() @IsString() @MaxLength(60) sourceCode?: string;
}

export class ConvertLeadBody {
  @ApiPropertyOptional({ format: 'uuid', description: "Default: the lead's listing" }) @IsOptional() @IsUUID() listingId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: "Default: the lead's assignee, else you" }) @IsOptional() @IsUUID() ownerMembershipId?: string;
  @ApiPropertyOptional({ type: MoneyInput }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) expectedValue?: MoneyInput;
  @ApiPropertyOptional({ example: '2027-03-31' }) @IsOptional() @Matches(DATE) expectedCloseDate?: string;
}

export class UpdateDealBody {
  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Only before any offer is recorded on the deal' })
  @IsOptional() @ValidateIf(notNull) @IsUUID()
  listingId?: string | null;
  @ApiPropertyOptional({ type: MoneyInput, nullable: true }) @IsOptional() @ValidateIf(notNull) @ValidateNested() @Type(() => MoneyInput) expectedValue?: MoneyInput | null;
  @ApiPropertyOptional({ type: MoneyInput, nullable: true }) @IsOptional() @ValidateIf(notNull) @ValidateNested() @Type(() => MoneyInput) expectedFee?: MoneyInput | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: '2027-03-31' }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) expectedCloseDate?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 100 })
  @IsOptional() @ValidateIf(notNull) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)
  probabilityOverride?: number | null;
}

export class MoveStageBody {
  @ApiProperty({ format: 'uuid', description: 'A stage of the deal\'s pipeline: lead, qualification, viewing or negotiation (the life cycle decides which)' })
  @IsUUID()
  stageId!: string;
  @ApiPropertyOptional({ maxLength: 500, description: NOTE_GUIDANCE }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class ReassignDealBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() ownerMembershipId!: string;
  @ApiPropertyOptional({ maxLength: 500, description: NOTE_GUIDANCE }) @IsOptional() @Transform(trim) @IsString() @MaxLength(500) note?: string;
}

export class DealAgentInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID() membershipId!: string;
  @ApiProperty({ enum: AGENT_ROLES }) @IsIn(AGENT_ROLES) agentRole!: (typeof AGENT_ROLES)[number];
  @ApiProperty({ minimum: 0, maximum: 100, description: 'Share of the credit, up to 4 decimal places' })
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100)
  splitPercent!: number;
}

export class SetDealAgentsBody {
  @ApiProperty({ type: [DealAgentInput], description: 'The whole list; splits add up to 100 %. An empty list clears it (the owner has all the credit)' })
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => DealAgentInput)
  agents!: DealAgentInput[];
}

export class DealPartyBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() contactId!: string;
  @ApiProperty({ enum: PARTY_ROLES }) @IsIn(PARTY_ROLES) partyRole!: (typeof PARTY_ROLES)[number];
}

export class UpdateMilestoneBody {
  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-12-15' }) @IsOptional() @ValidateIf(notNull) @Matches(DATE) dueDate?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000, description: NOTE_GUIDANCE })
  @IsOptional() @ValidateIf(notNull) @Transform(trim) @IsString() @MaxLength(2000)
  notes?: string | null;
}

export class CompleteMilestoneBody {
  @ApiPropertyOptional({ maxLength: 2000, description: NOTE_GUIDANCE }) @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) notes?: string;
}

export class ExchangeBody {
  @ApiProperty({ example: '2026-11-14', description: 'The day contracts were signed (not in the future)' }) @Matches(DATE) contractSignedOn!: string;
  @ApiPropertyOptional({ example: '2027-01-31' }) @IsOptional() @Matches(DATE) completionDueOn?: string;
  @ApiPropertyOptional({ type: MoneyInput, description: "Default: the deal's expected fee" }) @IsOptional() @ValidateNested() @Type(() => MoneyInput) agencyFee?: MoneyInput;
}

export class CompleteBody {
  @ApiProperty({ example: '2027-01-31', description: 'The completion day (not in the future, not before contracts)' }) @Matches(DATE) completedOn!: string;
  @ApiPropertyOptional({ maxLength: 120, description: 'Land registry or title reference' })
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(120)
  titleTransferRef?: string;
  @ApiPropertyOptional({ default: true, description: 'P6-D8: end the current ownership records of the unit and record the buyers as owners from the completion day' })
  @IsOptional() @IsBoolean()
  transferOwnership?: boolean;
}

export class LoseDealBody {
  @ApiProperty({ description: 'Picklist "lost_reason"' }) @IsString() @MaxLength(60) lostReasonCode!: string;
  @ApiPropertyOptional({ maxLength: 2000, description: `${NOTE_GUIDANCE}. Becomes the fall-through reason of an exchanged sale` })
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(2000)
  notes?: string;
}

// ---------------------------------------------------------------- responses

export class DealStageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: STAGE_CLASSES }) stageClass!: string;
  @ApiProperty() sortOrder!: number;
}

export class DealListingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() title!: string;
  @ApiProperty() status!: string;
}

export class DealSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: DEAL_TYPES }) dealType!: string;
  @ApiProperty({ type: DealStageDto }) stage!: DealStageDto;
  @ApiProperty({ enum: DEAL_STATUSES }) status!: string;
  @ApiProperty({ type: DealListingDto, nullable: true }) listing!: DealListingDto | null;
  @ApiProperty({ type: RefLabelDto }) primaryContact!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto }) office!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto, description: 'The responsible agent' }) owner!: RefLabelDto;
  @ApiProperty({ type: MoneyDto, nullable: true }) expectedValue!: MoneyDto | null;
  @ApiProperty({ type: MoneyDto, nullable: true, description: 'Expected value × probability (open deals)' }) weightedValue!: MoneyDto | null;
  @ApiProperty({ description: 'Percent: the override, else the stage\'s probability' }) probability!: number;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) expectedCloseDate!: string | null;
  @ApiProperty({ format: 'date-time' }) stageEnteredAt!: string;
  @ApiProperty({ description: 'Open longer in this stage than the stage allows (SAL-06)' }) stalled!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) closedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class DealSummaryPageDto {
  @ApiProperty({ type: [DealSummaryDto] }) data!: DealSummaryDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class DealPartyDto {
  @ApiProperty({ type: RefLabelDto }) contact!: RefLabelDto;
  @ApiProperty({ enum: PARTY_ROLES }) partyRole!: string;
  @ApiProperty() isPrimary!: boolean;
  @ApiProperty({ type: Boolean, nullable: true, description: 'Identity verified (null when you cannot see identity checks)' }) identityVerified!: boolean | null;
}

export class DealAgentDto {
  @ApiProperty({ type: RefLabelDto }) member!: RefLabelDto;
  @ApiProperty({ enum: AGENT_ROLES }) agentRole!: string;
  @ApiProperty() splitPercent!: number;
}

export class DealMilestoneDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() isRequired!: boolean;
  @ApiProperty({ description: 'Completes itself when the identities are verified (P6-D7)' }) automatic!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) dueDate!: string | null;
  @ApiProperty({ description: 'Open and past its due date' }) overdue!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) completedAt!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true }) completedBy!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
}

export class DealStageChangeDto {
  @ApiProperty({ type: DealStageDto, nullable: true }) fromStage!: DealStageDto | null;
  @ApiProperty({ type: DealStageDto }) toStage!: DealStageDto;
  @ApiProperty({ format: 'date-time' }) changedAt!: string;
  @ApiProperty({ type: RefLabelDto, nullable: true }) changedBy!: RefLabelDto | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

export class DealAssignmentDto {
  @ApiProperty({ type: RefLabelDto, nullable: true }) from!: RefLabelDto | null;
  @ApiProperty({ type: RefLabelDto }) to!: RefLabelDto;
  @ApiProperty({ type: RefLabelDto, nullable: true }) assignedBy!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) assignedAt!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
}

export class DealOfferRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: MoneyDto }) amount!: MoneyDto;
  @ApiProperty({ type: String, nullable: true }) rentFrequency!: string | null;
  @ApiProperty({ type: RefLabelDto }) offeredBy!: RefLabelDto;
}

export class DealSaleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: SALE_STATUSES }) status!: string;
  @ApiProperty({ type: MoneyDto }) agreedPrice!: MoneyDto;
  @ApiProperty({ type: MoneyDto, nullable: true }) agencyFee!: MoneyDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) contractSignedOn!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) completionDueOn!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) completedOn!: string | null;
  @ApiProperty({ type: String, nullable: true }) titleTransferRef!: string | null;
  @ApiProperty({ type: String, nullable: true }) fallenThroughReason!: string | null;
}

export class DealIdentityDto {
  @ApiProperty({ description: 'P6-D6: buyers are verified before contracts (sales where the jurisdiction requires it)' }) required!: boolean;
  @ApiProperty({ type: [String], format: 'uuid', description: 'Buyers whose identity is not verified (empty when you cannot see identity checks)' })
  unverifiedBuyerIds!: string[];
}

export class DealAccessDto {
  @ApiProperty() canEdit!: boolean;
  @ApiProperty({ type: [DealStageDto], description: 'Stages you can move it to by hand now' }) nextStages!: DealStageDto[];
  @ApiProperty({ description: 'Reassign and set agents (managers)' }) canReassign!: boolean;
  @ApiProperty() canExchange!: boolean;
  @ApiProperty() canComplete!: boolean;
  @ApiProperty() canLose!: boolean;
}

export class DealDto extends DealSummaryDto {
  @ApiProperty({ type: MoneyDto, nullable: true }) expectedFee!: MoneyDto | null;
  @ApiProperty({ type: Number, nullable: true }) probabilityOverride!: number | null;
  @ApiProperty({ type: String, nullable: true }) sourceCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) lostReasonCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) lostNotes!: string | null;
  @ApiProperty({ type: RefLabelDto, nullable: true, description: 'The lead it was converted from' }) lead!: RefLabelDto | null;
  @ApiProperty({ type: [DealPartyDto] }) parties!: DealPartyDto[];
  @ApiProperty({ type: [DealAgentDto] }) agents!: DealAgentDto[];
  @ApiProperty({ type: [DealMilestoneDto] }) milestones!: DealMilestoneDto[];
  @ApiProperty({ type: [DealStageChangeDto] }) stageHistory!: DealStageChangeDto[];
  @ApiProperty({ type: [DealAssignmentDto] }) assignments!: DealAssignmentDto[];
  @ApiProperty({ type: DealOfferRefDto, nullable: true }) acceptedOffer!: DealOfferRefDto | null;
  @ApiProperty({ type: DealSaleDto, nullable: true }) sale!: DealSaleDto | null;
  @ApiProperty({ type: DealIdentityDto }) identity!: DealIdentityDto;
  @ApiProperty({ type: DealAccessDto }) access!: DealAccessDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() version!: number;
}

export class PipelineTotalDto {
  @ApiProperty() currency!: string;
  @ApiProperty() count!: number;
  @ApiProperty({ type: MoneyDto }) expectedValue!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) weightedValue!: MoneyDto;
}

export class PipelineColumnDto {
  @ApiProperty({ type: DealStageDto }) stage!: DealStageDto;
  @ApiProperty() count!: number;
  @ApiProperty() stalledCount!: number;
  @ApiProperty({ type: [PipelineTotalDto], description: 'Per currency (never converted)' }) totals!: PipelineTotalDto[];
}

export class PipelineDto {
  @ApiProperty({ enum: DEAL_TYPES }) dealType!: string;
  @ApiProperty({ type: [PipelineColumnDto], description: 'Every active stage in order, open deals only; cards come from GET /deals?filter[stageId]=…' })
  columns!: PipelineColumnDto[];
}

export class ForecastMonthDto {
  @ApiProperty({ example: '2026-12' }) month!: string;
  @ApiProperty({ type: [PipelineTotalDto] }) totals!: PipelineTotalDto[];
}

export class ForecastDto {
  @ApiProperty({ enum: DEAL_TYPES }) dealType!: string;
  @ApiProperty({ type: [ForecastMonthDto], description: 'Open deals by expected close month' }) months!: ForecastMonthDto[];
  @ApiProperty({ type: [PipelineTotalDto], description: 'Open deals expected to close before the first month' }) overdue!: PipelineTotalDto[];
  @ApiProperty({ type: [PipelineTotalDto], description: 'Open deals with no expected close date' }) undated!: PipelineTotalDto[];
}
