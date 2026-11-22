import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

import { RefLabelDto } from '../contacts/dto.js';
import { trim } from '../properties/dto.js';

/** Records a document can be uploaded for in L1 (W7-A1); later milestones add their own. */
export const DOCUMENT_ENTITY_TYPES = ['lease', 'management_agreement'] as const;
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'failed'] as const;

export class CreateDocumentUploadBody {
  @ApiProperty({ enum: DOCUMENT_ENTITY_TYPES }) @IsIn(DOCUMENT_ENTITY_TYPES) entityType!: (typeof DOCUMENT_ENTITY_TYPES)[number];
  @ApiProperty({ format: 'uuid' }) @IsUUID() entityId!: string;
  @ApiProperty({ maxLength: 200, description: 'Shown in lists. Do not type identity or bank numbers' })
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(200)
  title!: string;
  @ApiProperty({ description: 'Picklist "document_type" (lease, management_agreement, notice, …)' }) @IsString() @MaxLength(60) documentTypeCode!: string;
  @ApiPropertyOptional({ default: false, description: 'The signed copy (a lease or agreement is activated only with a signed, clean document)' })
  @IsOptional() @IsBoolean()
  isSigned?: boolean;
  @ApiProperty({ maxLength: 200 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) fileName!: string;
  @ApiProperty({ enum: DOCUMENT_MIME_TYPES }) @IsString() @MaxLength(100) contentType!: string;
  @ApiProperty({ minimum: 1, description: 'Exact size in bytes' }) @IsInt() @Min(1) @Max(1_000_000_000) size!: number;
  @ApiProperty({ description: 'SHA-256 of the file, hex' }) @Matches(/^[0-9a-f]{64}$/) sha256!: string;
}

export class DocumentUploadTicketDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Signed URL; send the file with PUT and exactly the given headers' }) uploadUrl!: string;
  @ApiProperty({ enum: ['PUT'] }) method!: 'PUT';
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) headers!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class DocumentLinkDto {
  @ApiProperty({ enum: DOCUMENT_ENTITY_TYPES }) entityType!: string;
  @ApiProperty({ format: 'uuid' }) entityId!: string;
}

export class DocumentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() documentTypeCode!: string;
  @ApiProperty() category!: string;
  @ApiProperty({ enum: SCAN_STATUSES, description: 'Only clean documents can be downloaded or used to activate a record' }) scanStatus!: string;
  @ApiProperty() fileName!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() isSigned!: boolean;
  @ApiProperty() versionNo!: number;
  @ApiProperty({ type: RefLabelDto, nullable: true }) uploadedBy!: RefLabelDto | null;
  @ApiProperty({ format: 'date-time' }) uploadedAt!: string;
  @ApiProperty({ type: [DocumentLinkDto] }) links!: DocumentLinkDto[];
}

export class DocumentListDto {
  @ApiProperty({ type: [DocumentDto] }) data!: DocumentDto[];
}

export class DocumentDownloadDto {
  @ApiProperty({ description: 'Short-lived signed URL' }) url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
