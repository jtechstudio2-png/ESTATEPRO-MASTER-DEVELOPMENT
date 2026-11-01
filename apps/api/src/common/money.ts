import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

/**
 * Money on the wire (ADR-003 §5): `{ "amount": "6000.00", "currency": "GHS" }`.
 * The amount is a decimal string; arithmetic uses scaled integers, never floats.
 */
export const AMOUNT = /^\d{1,15}(\.\d{1,4})?$/;

export class MoneyInput {
  @ApiProperty({ example: '6000.00', description: 'Decimal string; at most the currency’s minor units' }) @Matches(AMOUNT) amount!: string;
  @ApiProperty({ example: 'GHS', description: 'ISO 4217' }) @Matches(/^[A-Z]{3}$/) currency!: string;
}

export class MoneyDto {
  @ApiProperty({ example: '6000.00' }) amount!: string;
  @ApiProperty({ example: 'GHS' }) currency!: string;
}

const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);

/** Decimal string → integer in 1/10,000ths (the database scale, numeric(19,4)). */
export function toScaled(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * FACTOR + BigInt(fraction.padEnd(SCALE, '0').slice(0, SCALE));
}

/** Significant decimal places of a decimal string ("10.50" → 1). */
export function decimalPlaces(value: string): number {
  const fraction = value.split('.')[1] ?? '';
  return fraction.replace(/0+$/, '').length;
}

/** A stored amount formatted to the currency's minor units (half-up). */
export function formatAmount(stored: string, minorUnits: number): string {
  const divisor = 10n ** BigInt(SCALE - minorUnits);
  const units = (toScaled(stored) + divisor / 2n) / divisor;
  if (minorUnits === 0) return units.toString();
  const text = units.toString().padStart(minorUnits + 1, '0');
  return `${text.slice(0, -minorUnits)}.${text.slice(-minorUnits)}`;
}

export function toMoney(stored: string, currency: string, minorUnits: number): MoneyDto {
  return { amount: formatAmount(stored, minorUnits), currency };
}
