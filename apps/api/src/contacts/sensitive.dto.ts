import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { REVEALABLE_CONTACT_FIELDS } from '../crypto/sensitive-fields.js';

export const REVEALABLE_FIELDS = Object.keys(REVEALABLE_CONTACT_FIELDS) as (keyof typeof REVEALABLE_CONTACT_FIELDS)[];

/** UI hides a revealed value after this many seconds (ADR-007 decision E-Q3). */
export const REVEAL_DISPLAY_SECONDS = 60;

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class RevealBody {
  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    description: 'Why the value is needed (recorded in the audit log). Do not include the value itself.',
    example: 'Verifying identity for the sale of Osu Court, flat 2',
  })
  @Transform(trim) @IsString() @MinLength(10) @MaxLength(500)
  reason!: string;
}

export class RevealedValueDto {
  @ApiProperty({ enum: [...REVEALABLE_FIELDS, 'documentNumber'] }) field!: string;
  @ApiProperty({ description: 'The protected value. Never cache, log or put it in a URL.' }) value!: string;
  @ApiProperty({ format: 'date-time' }) revealedAt!: string;
  @ApiProperty({ description: 'Hide the value after this many seconds', example: REVEAL_DISPLAY_SECONDS }) hideAfterSeconds!: number;
}
