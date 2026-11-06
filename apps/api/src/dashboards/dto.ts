import { ApiProperty } from '@nestjs/swagger';

import { RefLabelDto } from '../contacts/dto.js';

export class DashboardScopeDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'Office filter, or null for everything in your scope' }) officeId!: string | null;
  @ApiProperty({ description: 'IANA time zone used for "today" and "this week"' }) timezone!: string;
  @ApiProperty({ format: 'date-time' }) from!: string;
  @ApiProperty({ format: 'date-time' }) to!: string;
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
}

export class FollowUpCountsDto {
  @ApiProperty() overdue!: number;
  @ApiProperty({ description: 'Due later today' }) today!: number;
  @ApiProperty({ description: 'Due from now to the end of this week (Monday to Sunday)' }) thisWeek!: number;
  @ApiProperty({ enum: ['mine', 'team'] }) view!: string;
}

export class WaitingLeadDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() contactName!: string;
  @ApiProperty() sourceCode!: string;
  @ApiProperty({ type: RefLabelDto, nullable: true }) assignedTo!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) receivedAt!: string;
  @ApiProperty({ type: Boolean, nullable: true, description: 'Past the response target (null when none is set)' }) overdue!: boolean | null;
}

export class WaitingLeadsDto {
  @ApiProperty() total!: number;
  @ApiProperty({ type: [WaitingLeadDto], description: 'Oldest first, at most 10' }) items!: WaitingLeadDto[];
}

export class LeadStatusCountsDto {
  @ApiProperty() new!: number;
  @ApiProperty() contacted!: number;
  @ApiProperty() qualified!: number;
  @ApiProperty() unqualified!: number;
  @ApiProperty() lost!: number;
}

export class ResponseRowDto {
  @ApiProperty() leads!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Median minutes to first response, of answered leads' }) medianFirstResponseMinutes!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Leads answered within the target (null when none is set); base is `leads`' }) withinTarget!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Percentage of `leads`, one decimal' }) withinTargetPercent!: number | null;
  @ApiProperty() qualified!: number;
}

export class AgentResponseRowDto extends ResponseRowDto {
  @ApiProperty({ type: RefLabelDto }) assignee!: RefLabelDto;
}

export class SourceRowDto extends ResponseRowDto {
  @ApiProperty() sourceCode!: string;
}

export class RequirementCountsDto {
  @ApiProperty() buy!: number;
  @ApiProperty() rent!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Active requirements no published listing of the company matches, as of the last check (null without listing.view)' })
  noMatch!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Requirements added or changed since the last check (checked every 15 minutes)' }) noMatchPending!: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Oldest check in this count' }) noMatchCheckedAt!: string | null;
}

export class CrmDashboardDto {
  @ApiProperty({ type: DashboardScopeDto }) scope!: DashboardScopeDto;
  @ApiProperty({ type: Number, nullable: true, description: 'Company response target in minutes; null shows "SLA not set"' }) responseTargetMinutes!: number | null;
  @ApiProperty({ type: WaitingLeadsDto }) newNotContacted!: WaitingLeadsDto;
  @ApiProperty({ type: FollowUpCountsDto }) followUps!: FollowUpCountsDto;
  @ApiProperty({ type: LeadStatusCountsDto, description: 'Leads received in the period' }) leadsByStatus!: LeadStatusCountsDto;
  @ApiProperty({ type: [AgentResponseRowDto], nullable: true, description: 'Per assignee; null for members who only see their own leads' }) responseTimes!: AgentResponseRowDto[] | null;
  @ApiProperty({ type: [SourceRowDto] }) leadsBySource!: SourceRowDto[];
  @ApiProperty({ type: RequirementCountsDto, nullable: true, description: 'null without contact.view' }) requirements!: RequirementCountsDto | null;
}

export class AttentionItemDto {
  @ApiProperty({ example: 'unassigned_leads' }) code!: string;
  @ApiProperty() count!: number;
  @ApiProperty() message!: string;
  @ApiProperty({ type: String, nullable: true, description: 'API path of the list behind the number; null where that list is not built yet (invitations, imports, agent profiles)' })
  link!: string | null;
}

export class UsersAccessDto {
  @ApiProperty() pendingInvitations!: number;
  @ApiProperty() expiredInvitations!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Not available: second factors are held by the identity provider (ADR-001)' }) usersWithoutRequiredMfa!: number | null;
  @ApiProperty({ description: 'Agent licences expiring within 60 days' }) agentLicencesExpiring!: number;
}

export class OfficeFlowRowDto {
  @ApiProperty({ type: RefLabelDto, nullable: true, description: 'null: leads without an office' }) office!: RefLabelDto | null;
  @ApiProperty() newLeads!: number;
  @ApiProperty() unassigned!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Not answered and past the target (null when none is set)' }) noResponsePastTarget!: number | null;
}

export class LeadFlowDto {
  @ApiProperty() days!: number;
  @ApiProperty({ type: Number, nullable: true }) responseTargetMinutes!: number | null;
  @ApiProperty({ type: [OfficeFlowRowDto] }) offices!: OfficeFlowRowDto[];
}

export class DataQualityDto {
  @ApiProperty({ description: 'Phone, email or identity numbers shared by more than one active contact' }) possibleDuplicateGroups!: number;
  @ApiProperty() contactsWithoutOwner!: number;
  @ApiProperty({ description: 'Identity documents expiring within 30 days' }) identityDocumentsExpiring!: number;
  @ApiProperty({ description: 'Verified checks due for renewal within 30 days' }) identityChecksExpiring!: number;
}

export class PrivacyDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Open access and erasure requests (gap G3); null without privacy.view' }) dataSubjectRequestsOpen!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Open requests past their due date; null without privacy.view' }) dataSubjectRequestsOverdue!: number | null;
  @ApiProperty({ description: 'Marketing consents withdrawn in the last 7 days' }) marketingWithdrawals!: number;
  @ApiProperty({ description: 'Protected details revealed in the last 7 days' }) sensitiveReveals!: number;
  @ApiProperty({ description: 'Contact and lead exports in the last 7 days' }) exports!: number;
}

export class ExportJobSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() exportType!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: Number, nullable: true }) rowCount!: number | null;
  @ApiProperty({ type: RefLabelDto }) requestedBy!: RefLabelDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ImportsExportsDto {
  @ApiProperty({ type: [ExportJobSummaryDto], description: 'Latest 5' }) recentExports!: ExportJobSummaryDto[];
  @ApiProperty({ description: 'Imports that failed in the last 30 days' }) failedImports!: number;
}

export class UsageDto {
  @ApiProperty() used!: number;
  @ApiProperty({ type: Number, nullable: true }) limit!: number | null;
}

export class AccountDto {
  @ApiProperty({ type: UsageDto, description: 'Active staff members of the subscription seats' }) users!: UsageDto;
  @ApiProperty({ type: UsageDto, description: 'Bytes' }) storage!: UsageDto;
  @ApiProperty() supportAccessGrantsOpen!: number;
}

export class AdminDashboardDto {
  @ApiProperty({ type: DashboardScopeDto }) scope!: DashboardScopeDto;
  @ApiProperty({ type: [AttentionItemDto], description: 'Most urgent first, at most 5' }) needsAttention!: AttentionItemDto[];
  @ApiProperty({ type: UsersAccessDto }) usersAndAccess!: UsersAccessDto;
  @ApiProperty({ type: LeadFlowDto }) leadFlow!: LeadFlowDto;
  @ApiProperty({ type: DataQualityDto }) dataQuality!: DataQualityDto;
  @ApiProperty({ type: PrivacyDto }) privacy!: PrivacyDto;
  @ApiProperty({ type: ImportsExportsDto }) importsExports!: ImportsExportsDto;
  @ApiProperty({ type: AccountDto }) account!: AccountDto;
}

export class DayItemDto {
  @ApiProperty({ enum: ['follow_up', 'new_lead'] }) kind!: string;
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time', description: 'Due time, or when the lead arrived' }) at!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Contact name, or lead reference and contact name' }) about!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['contact', 'lead'] }) aboutType!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) aboutId!: string | null;
  @ApiProperty() overdue!: boolean;
  @ApiProperty({ type: Number, nullable: true, description: 'Follow-ups: the version for If-Match (Done, Reschedule)' }) version!: number | null;
}

export class WaitingOnMeDto {
  @ApiProperty() newLeadsAssigned!: number;
  @ApiProperty() overdueFollowUps!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Past the response target without a reply (null when none is set)' }) leadsPastTarget!: number | null;
}

export class MyDayDto {
  @ApiProperty() timezone!: string;
  @ApiProperty({ format: 'date' }) date!: string;
  @ApiProperty({ type: [DayItemDto], description: 'Overdue first, then by time' }) today!: DayItemDto[];
  @ApiProperty({ description: 'Follow-ups due later this week' }) laterThisWeek!: number;
  @ApiProperty({ type: WaitingOnMeDto }) waitingOnMe!: WaitingOnMeDto;
  @ApiProperty({ type: LeadStatusCountsDto, description: 'My open and closed leads (not archived)' }) myLeadsByStatus!: LeadStatusCountsDto;
}
