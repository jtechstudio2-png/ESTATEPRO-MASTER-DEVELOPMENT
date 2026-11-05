import { ApiProperty } from '@nestjs/swagger';

import { RefLabelDto } from '../contacts/dto.js';

export class PreviewBasisDto {
  @ApiProperty({ enum: ['ownership', 'management_agreement'] }) type!: string;
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'null: the whole property' }) unitId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Ownership share, e.g. "100.0000"' }) sharePercent!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Ownership type or management service level' }) kind!: string | null;
  @ApiProperty({ format: 'date' }) from!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) until!: string | null;
}

export class PreviewUnitDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() label!: string;
}

export class PreviewListingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() title!: string;
  @ApiProperty() status!: string;
  @ApiProperty() isPublished!: boolean;
  @ApiProperty({ format: 'uuid' }) unitId!: string;
}

export class PreviewPropertyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ description: 'Access is judged in this time zone' }) timezone!: string;
  @ApiProperty({ type: [PreviewBasisDto] }) basis!: PreviewBasisDto[];
  @ApiProperty({ type: [PreviewUnitDto] }) units!: PreviewUnitDto[];
  @ApiProperty({ type: [PreviewListingDto] }) listings!: PreviewListingDto[];
}

export class PortalPreviewDto {
  @ApiProperty({ type: RefLabelDto }) contact!: RefLabelDto;
  @ApiProperty({ enum: ['landlord'] }) portal!: string;
  @ApiProperty({ description: 'The contact has an active landlord role' }) hasLandlordRole!: boolean;
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
  @ApiProperty({ type: [PreviewPropertyDto] }) properties!: PreviewPropertyDto[];
  @ApiProperty({ type: [String], description: 'What the landlord would not see (English)' }) notVisible!: string[];
  @ApiProperty({
    enum: ['other_owners', 'tenant_buyer_contacts', 'staff_records', 'protected_details'],
    isArray: true,
    description: 'The same list as codes, in the same order, for translated screens',
  })
  notVisibleCodes!: string[];
  @ApiProperty({ description: 'Only properties you may view are listed here' }) limitedToYourAccess!: boolean;
}
