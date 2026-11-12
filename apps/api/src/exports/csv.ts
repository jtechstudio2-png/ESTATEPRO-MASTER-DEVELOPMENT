/**
 * CSV writing (RFC 4180) for exports. Cells that a spreadsheet would read as
 * a formula (starting with =, +, -, @, tab or carriage return) are prefixed
 * with an apostrophe, so an exported value can never run in the recipient's
 * spreadsheet (OWASP "CSV injection"). A byte-order mark lets spreadsheet
 * programs read UTF-8 (Arabic names) correctly.
 */
export type CsvValue = string | number | boolean | Date | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: CsvValue[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

export function csvDocument(header: string[], rows: CsvValue[][]): Buffer {
  return Buffer.from(`﻿${csvLine(header)}${rows.map(csvLine).join('')}`, 'utf8');
}
