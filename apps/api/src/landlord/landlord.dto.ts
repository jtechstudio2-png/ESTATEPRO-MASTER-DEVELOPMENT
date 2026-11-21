import { ApiProperty } from '@nestjs/swagger';

import { MoneyDto } from '../common/money.js';

/** What a landlord never sees in these views (readiness report §6), as codes for translated screens. */
export const LANDLORD_NOT_SHOWN = [
  'buyer_contact_details',
  'internal_notes',
  'activities',
  'commission_fees_splits',
  'documents',
  'other_parties',
  'attendee_identities',
  'unshared_feedback',
  'activity_before_link',
] as const;

export class LandlordListingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: ['sale', 'rent'] }) listingType!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: String, nullable: true }) propertyName!: string | null;
  @ApiProperty() unitLabel!: string;
  @ApiProperty({ description: 'Time zone of the property (dates and times below are judged in it)' }) timezone!: string;
  @ApiProperty({ format: 'date', description: 'Activity from this day is shown: when your current link to the unit began' }) visibleSince!: string;
  @ApiProperty({ type: Number, nullable: true, description: 'Open offers (null without offer access)' }) openOffers!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Scheduled or confirmed viewings from now on (null without viewing access)' }) upcomingViewings!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Open deals (null without deal access)' }) openDeals!: number | null;
}

export class LandlordOfferDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['from_buyer', 'from_seller'] }) direction!: string;
  @ApiProperty({ description: 'The buyer or tenant by name only (never contact details)' }) offeredByName!: string;
  @ApiProperty({ type: MoneyDto }) amount!: MoneyDto;
  @ApiProperty({ type: String, nullable: true }) rentFrequency!: string | null;
  @ApiProperty({ type: String, nullable: true }) conditions!: string | null;
  @ApiProperty({ type: String, nullable: true }) financingCode!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty({ format: 'date-time' }) submittedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) respondedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The offer this one answers' }) parentOfferId!: string | null;
}

export class LandlordMilestoneDto {
  @ApiProperty() name!: string;
  @ApiProperty() done!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) dueDate!: string | null;
}

export class LandlordDealDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: "The stage's name as the company calls it" }) stageName!: string;
  @ApiProperty({ description: 'Stage class code, for translated screens' }) stageClass!: string;
  @ApiProperty({ enum: ['open', 'won', 'lost'] }) status!: string;
  @ApiProperty({ type: [LandlordMilestoneDto], description: 'The progress checklist (name, done or not, due date)' }) milestones!: LandlordMilestoneDto[];
}

export class LandlordViewingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) scheduledStart!: string;
  @ApiProperty({ format: 'date-time' }) scheduledEnd!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty({ enum: ['in_person', 'virtual', 'open_house'] }) viewingType!: string;
  @ApiProperty({ enum: ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'] }) status!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Once completed' }) outcome!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Only where the agent shared it with the landlord' }) feedback!: string | null;
}

export class LandlordListingViewDto {
  @ApiProperty({ type: LandlordListingDto }) listing!: LandlordListingDto;
  @ApiProperty({ type: [LandlordOfferDto], nullable: true, description: 'Newest first; null without offer access' }) offers!: LandlordOfferDto[] | null;
  @ApiProperty({ type: [LandlordDealDto], nullable: true, description: 'null without deal access' }) deals!: LandlordDealDto[] | null;
  @ApiProperty({ type: [LandlordViewingDto], nullable: true, description: 'Newest first; null without viewing access' }) viewings!: LandlordViewingDto[] | null;
  @ApiProperty({ enum: LANDLORD_NOT_SHOWN, isArray: true, description: 'What these views never show' }) notShown!: string[];
}

export class LandlordListingsDto {
  @ApiProperty({ type: [LandlordListingDto] }) data!: LandlordListingDto[];
}

export class LandlordPreviewDto extends LandlordListingViewDto {
  @ApiProperty({ format: 'uuid', description: 'The landlord contact previewed' }) contactId!: string;
  @ApiProperty({ description: 'Only what you may see yourself is listed; the landlord may see more' }) limitedToYourAccess!: boolean;
}
