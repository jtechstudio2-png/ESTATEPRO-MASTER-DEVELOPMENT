/** Signed decimal strings at the database scale (numeric(19,4)) as integers of 1/10,000ths: no floats in money (ADR-003). */
const FACTOR = 10_000n;

export function scaled(value: string): bigint {
  const text = value.trim();
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const units = BigInt(whole || '0') * FACTOR + BigInt((fraction + '0000').slice(0, 4));
  return negative ? -units : units;
}

export function unscaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / FACTOR}.${(abs % FACTOR).toString().padStart(4, '0')}`;
}
