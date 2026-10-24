import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { FieldError } from '../common/problem.js';
import type { Tx } from '../database/database.module.js';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

/** International address (Phase 2 `addresses`); country-specific parts go in localComponents. */
export class AddressInput {
  @ApiProperty({ example: 'GH', description: 'ISO 3166-1 alpha-2' })
  @Matches(/^[A-Z]{2}$/)
  countryCode!: string;

  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) addressLine1?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) addressLine2?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) addressLine3?: string;
  @ApiPropertyOptional({ description: 'Neighbourhood or district' })
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) dependentLocality?: string;
  @ApiPropertyOptional({ description: 'City, town or post town' })
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) locality?: string;
  @ApiPropertyOptional({ description: 'County, district or municipality' })
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) adminArea2?: string;
  @ApiPropertyOptional({ description: 'Region, state or emirate' })
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(120) adminArea1?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(20) postalCode?: string;

  @ApiPropertyOptional({
    description: 'Country-specific parts, e.g. {"digital_address": "GA-123-4567"} (GH) or {"zone_number": "66", …} (QA)',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  localComponents?: Record<string, string>;

  @ApiPropertyOptional({ minimum: -90, maximum: 90 }) @IsOptional() @IsLatitude() latitude?: number;
  @ApiPropertyOptional({ minimum: -180, maximum: 180 }) @IsOptional() @IsLongitude() longitude?: number;
}

export class AddressDto {
  @ApiProperty() countryCode!: string;
  @ApiProperty({ type: String, nullable: true }) addressLine1!: string | null;
  @ApiProperty({ type: String, nullable: true }) addressLine2!: string | null;
  @ApiProperty({ type: String, nullable: true }) addressLine3!: string | null;
  @ApiProperty({ type: String, nullable: true }) dependentLocality!: string | null;
  @ApiProperty({ type: String, nullable: true }) locality!: string | null;
  @ApiProperty({ type: String, nullable: true }) adminArea2!: string | null;
  @ApiProperty({ type: String, nullable: true }) adminArea1!: string | null;
  @ApiProperty({ type: String, nullable: true }) postalCode!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) localComponents!: Record<string, string>;
  @ApiProperty({ type: String, nullable: true }) formatted!: string | null;
  @ApiProperty({ type: Number, nullable: true }) latitude!: number | null;
  @ApiProperty({ type: Number, nullable: true }) longitude!: number | null;
}

interface FieldRule {
  label?: string;
  required?: boolean;
  hidden?: boolean;
  pattern?: string;
}

interface LocalComponentRule {
  key: string;
  label: string;
  required?: boolean;
  pattern?: string;
}

interface AddressFormat {
  locality?: FieldRule;
  admin_area_1?: FieldRule;
  admin_area_2?: FieldRule;
  postal_code?: FieldRule;
  local_components?: LocalComponentRule[];
}

export interface NormalisedAddress {
  countryCode: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  dependentLocality: string | null;
  locality: string | null;
  adminArea2: string | null;
  adminArea1: string | null;
  postalCode: string | null;
  localComponents: Record<string, string>;
  formatted: string;
  latitude: number | null;
  longitude: number | null;
}

const FIELD_MAP: Array<[keyof AddressFormat, 'locality' | 'adminArea1' | 'adminArea2' | 'postalCode']> = [
  ['locality', 'locality'],
  ['admin_area_1', 'adminArea1'],
  ['admin_area_2', 'adminArea2'],
  ['postal_code', 'postalCode'],
];

/**
 * Validates an address against `countries.address_format` and normalises it
 * (postcode case and spacing, formatted single line). Returns field errors
 * prefixed with `prefix`, or the normalised address.
 */
export async function validateAddress(
  tx: Tx,
  input: AddressInput,
  prefix = 'address',
): Promise<{ errors: FieldError[]; address: NormalisedAddress | null }> {
  const errors: FieldError[] = [];
  const country = await tx
    .selectFrom('countries')
    .select(['code', 'name', 'addressFormat'])
    .where('code', '=', input.countryCode)
    .where('isActive', '=', true)
    .executeTakeFirst();
  if (!country) {
    return {
      errors: [{ field: `${prefix}.countryCode`, code: 'unsupported', message: 'This country is not supported.' }],
      address: null,
    };
  }
  const format = (country.addressFormat ?? {}) as AddressFormat;

  let postalCode = input.postalCode ?? null;
  if (postalCode !== null) postalCode = postalCode.toUpperCase().replace(/\s+/g, ' ');

  const values: Record<string, string | null> = {
    locality: input.locality ?? null,
    adminArea1: input.adminArea1 ?? null,
    adminArea2: input.adminArea2 ?? null,
    postalCode,
  };

  for (const [formatKey, inputKey] of FIELD_MAP) {
    const rule = format[formatKey];
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) continue;
    const value = values[inputKey] ?? null;
    const label = rule.label ?? inputKey;
    if (rule.hidden && value !== null) {
      errors.push({ field: `${prefix}.${inputKey}`, code: 'not-used', message: `${label} is not used for ${country.name} addresses.` });
    } else if (rule.required && value === null) {
      errors.push({ field: `${prefix}.${inputKey}`, code: 'required', message: `${label} is required for ${country.name} addresses.` });
    } else if (rule.pattern && value !== null && !new RegExp(rule.pattern).test(value)) {
      errors.push({ field: `${prefix}.${inputKey}`, code: 'format', message: `${label} is not in the expected format.` });
    }
  }

  const componentRules = format.local_components ?? [];
  const supplied = input.localComponents ?? {};
  const localComponents: Record<string, string> = {};
  for (const [key, raw] of Object.entries(supplied)) {
    const rule = componentRules.find((candidate) => candidate.key === key);
    if (!rule) {
      errors.push({ field: `${prefix}.localComponents.${key}`, code: 'unknown-field', message: `This address part is not used for ${country.name}.` });
      continue;
    }
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > 60) {
      errors.push({ field: `${prefix}.localComponents.${key}`, code: 'invalid', message: `${rule.label} must be 1–60 characters.` });
      continue;
    }
    const value = raw.trim().toUpperCase();
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
      errors.push({ field: `${prefix}.localComponents.${key}`, code: 'format', message: `${rule.label} is not in the expected format.` });
      continue;
    }
    localComponents[key] = value;
  }
  for (const rule of componentRules) {
    if (rule.required && supplied[rule.key] === undefined) {
      errors.push({ field: `${prefix}.localComponents.${rule.key}`, code: 'required', message: `${rule.label} is required for ${country.name} addresses.` });
    }
  }

  if (input.addressLine1 === undefined && Object.keys(supplied).length === 0) {
    errors.push({
      field: `${prefix}.addressLine1`,
      code: 'required',
      message: 'Enter the street address or the local address reference.',
    });
  }
  if ((input.latitude === undefined) !== (input.longitude === undefined)) {
    errors.push({ field: `${prefix}.latitude`, code: 'pair', message: 'Give both latitude and longitude, or neither.' });
  }

  if (errors.length > 0) return { errors, address: null };

  const componentText = componentRules
    .filter((rule) => localComponents[rule.key] !== undefined)
    .map((rule) => `${rule.label} ${localComponents[rule.key]}`);
  const formatted = [
    input.addressLine1,
    input.addressLine2,
    input.addressLine3,
    ...componentText,
    input.dependentLocality,
    input.locality,
    input.adminArea2,
    input.adminArea1,
    postalCode,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(', ');

  return {
    errors: [],
    address: {
      countryCode: input.countryCode,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      addressLine3: input.addressLine3 ?? null,
      dependentLocality: input.dependentLocality ?? null,
      locality: input.locality ?? null,
      adminArea2: input.adminArea2 ?? null,
      adminArea1: input.adminArea1 ?? null,
      postalCode,
      localComponents,
      formatted,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
    },
  };
}

export function toAddressDto(row: {
  countryCode: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  dependentLocality: string | null;
  locality: string | null;
  adminArea2: string | null;
  adminArea1: string | null;
  postalCode: string | null;
  localComponents: unknown;
  formatted: string | null;
  latitude: string | null;
  longitude: string | null;
}): AddressDto {
  return {
    countryCode: row.countryCode,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    addressLine3: row.addressLine3,
    dependentLocality: row.dependentLocality,
    locality: row.locality,
    adminArea2: row.adminArea2,
    adminArea1: row.adminArea1,
    postalCode: row.postalCode,
    localComponents: (row.localComponents ?? {}) as Record<string, string>,
    formatted: row.formatted,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
  };
}
