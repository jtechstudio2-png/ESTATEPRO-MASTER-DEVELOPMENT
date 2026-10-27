import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
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

import { PageDto, provided, trim } from '../properties/dto.js';
import { LINK_MEDIA_TYPES, MAX_FLOOR_PLANS_PER_LISTING, MAX_PHOTOS_PER_LISTING, UPLOAD_MEDIA_TYPES } from './media-rules.js';

export class CreateUploadBody {
  @ApiProperty({ format: 'uuid' }) @IsUUID() propertyId!: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Unit the media belongs to; omit for the whole property' })
  @ValidateIf(provided) @IsUUID()
  unitId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Add to this listing once processed (needs listing.update)' })
  @ValidateIf(provided) @IsUUID()
  listingId?: string;
  @ApiProperty({ enum: UPLOAD_MEDIA_TYPES }) @IsIn(UPLOAD_MEDIA_TYPES) mediaType!: (typeof UPLOAD_MEDIA_TYPES)[number];
  @ApiProperty({ maxLength: 200 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) fileName!: string;
  @ApiProperty({ example: 'image/jpeg' }) @IsString() @MaxLength(100) contentType!: string;
  @ApiProperty({ minimum: 1, description: 'Exact size in bytes' }) @IsInt() @Min(1) @Max(1_000_000_000) size!: number;
  @ApiProperty({ description: 'SHA-256 of the file, hex' }) @Matches(/^[0-9a-f]{64}$/) sha256!: string;
}

export class UploadTicketDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Signed URL; send the file with PUT and exactly the given headers' }) uploadUrl!: string;
  @ApiProperty({ enum: ['PUT'] }) method!: 'PUT';
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) headers!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class CreateLinkBody {
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(provided) @IsUUID() unitId?: string;
  @ApiProperty({ enum: LINK_MEDIA_TYPES }) @IsIn(LINK_MEDIA_TYPES) mediaType!: (typeof LINK_MEDIA_TYPES)[number];
  @ApiProperty({ description: 'YouTube or Vimeo (video), Matterport (virtual tour)' }) @IsString() @MaxLength(500) url!: string;
  @ApiPropertyOptional({ maxLength: 300 }) @ValidateIf(provided) @Transform(trim) @IsString() @MaxLength(300) caption?: string | null;
  @ApiPropertyOptional({ maxLength: 250 }) @ValidateIf(provided) @Transform(trim) @IsString() @MaxLength(250) altText?: string | null;
}

export class UpdateMediaBody {
  @ApiPropertyOptional({ maxLength: 300 }) @ValidateIf(provided) @Transform(trim) @IsString() @MaxLength(300) caption?: string | null;
  @ApiPropertyOptional({ maxLength: 250, description: 'Text alternative (WCAG 2.2 AA)' })
  @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(250)
  altText?: string | null;
  @ApiPropertyOptional({ maxLength: 80 }) @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) roomLabel?: string | null;
  @ApiPropertyOptional({ maxLength: 60 }) @ValidateIf(provided) @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) floorLabel?: string | null;
  @ApiPropertyOptional({ minimum: 0, maximum: 10_000, description: 'Order in the property gallery' })
  @ValidateIf(provided) @IsInt() @Min(0) @Max(10_000)
  sortOrder?: number;
}

export class ReasonBody {
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class LegalHoldBody {
  @ApiProperty() @IsBoolean() hold!: boolean;
  @ApiProperty({ minLength: 3, maxLength: 500 }) @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class ListingMediaItemInput {
  @ApiProperty({ format: 'uuid' }) @IsUUID() mediaId!: string;
  @ApiPropertyOptional({ default: false }) @ValidateIf(provided) @IsBoolean() isCover?: boolean;
}

export class ListingMediaBody {
  @ApiProperty({ type: [ListingMediaItemInput], description: 'The full gallery in display order' })
  @IsArray() @ArrayMaxSize(MAX_PHOTOS_PER_LISTING + MAX_FLOOR_PLANS_PER_LISTING + 20) @ArrayUnique((item: ListingMediaItemInput) => item.mediaId)
  @ValidateNested({ each: true }) @Type(() => ListingMediaItemInput)
  items!: ListingMediaItemInput[];
}

// ----------------------------------------------------------------------------- responses

export class MediaUrlsDto {
  @ApiPropertyOptional() thumb?: string;
  @ApiPropertyOptional() small?: string;
  @ApiPropertyOptional() medium?: string;
  @ApiPropertyOptional() large?: string;
  @ApiPropertyOptional({ description: 'PDF download (attachment)' }) download?: string;
  @ApiPropertyOptional({ description: 'External video or tour' }) external?: string;
}

export class MediaDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) propertyId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) unitId!: string | null;
  @ApiProperty({ enum: ['photo', 'video', 'floor_plan', 'virtual_tour', 'site_plan', 'brochure'] }) mediaType!: string;
  @ApiProperty({ enum: ['pending', 'ready', 'failed', 'rejected'] }) processingStatus!: string;
  @ApiProperty({ type: String, nullable: true }) rejectionReason!: string | null;
  @ApiProperty({ type: String, nullable: true }) originalFilename!: string | null;
  @ApiProperty({ type: String, nullable: true }) mimeType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({ type: Number, nullable: true }) pageCount!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Bytes stored (master and sizes)' }) storedBytes!: number | null;
  @ApiProperty({ type: String, nullable: true, enum: ['youtube', 'vimeo', 'matterport'] }) externalProvider!: string | null;
  @ApiProperty({ type: String, nullable: true }) caption!: string | null;
  @ApiProperty({ type: String, nullable: true }) altText!: string | null;
  @ApiProperty({ type: String, nullable: true }) roomLabel!: string | null;
  @ApiProperty({ type: String, nullable: true }) floorLabel!: string | null;
  @ApiProperty() sortOrder!: number;
  @ApiProperty({ type: MediaUrlsDto, description: 'Signed URLs, valid for a short time' }) urls!: MediaUrlsDto;
  @ApiProperty() legalHold!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'Permanent deletion date for archived media' })
  purgeAfter!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty() version!: number;
}

export class MediaPageDto {
  @ApiProperty({ type: [MediaDto] }) data!: MediaDto[];
  @ApiProperty({ type: PageDto }) page!: PageDto;
}

export class ListingMediaDto extends MediaDto {
  @ApiProperty() position!: number;
  @ApiProperty() isCover!: boolean;
}

export class ListingGalleryDto {
  @ApiProperty({ type: [ListingMediaDto] }) data!: ListingMediaDto[];
  @ApiProperty({ description: 'Listing version (ETag) after the change' }) listingVersion!: number;
}

export class StorageUsageDto {
  @ApiProperty({ type: String, nullable: true, example: 'starter' }) planCode!: string | null;
  @ApiProperty({ type: Number, nullable: true }) limitBytes!: number | null;
  @ApiProperty() usedBytes!: number;
  @ApiProperty() reservedBytes!: number;
}
