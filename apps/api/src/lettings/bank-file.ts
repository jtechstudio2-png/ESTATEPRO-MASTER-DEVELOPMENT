import { createHash } from 'node:crypto';

/**
 * EstatePro CSV v1 (P7-D7; docs/phase-7/BANK-FILE-FORMAT.md): UTF-8,
 * comma-separated, RFC 4180 quoting, one header row naming the columns
 * `date`, `amount`, `currency`, `reference` and optionally `description` and
 * `transaction_id` (any order, any case). One receipt per line: the date as
 * YYYY-MM-DD, the amount as a positive decimal with a full stop and no
 * thousands separators, the currency as its ISO code. At most 5,000 lines.
 */
export const BANK_FILE_FORMAT = 'estatepro_csv_v1';
export const MAX_BANK_FILE_LINES = 5_000;
const REQUIRED = ['date', 'amount', 'currency', 'reference'] as const;
const AMOUNT = /^\d{1,15}(\.\d{1,4})?$/;

export interface BankFileLine {
  lineNo: number;
  date: string | null;
  amount: string | null;
  currency: string | null;
  reference: string | null;
  description: string | null;
  transactionId: string | null;
  error: { code: string; message: string } | null;
}

export class BankFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** RFC 4180 records (quoted fields may hold commas, quotes and line breaks). */
export function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (ch === ',') {
      record.push(field);
      field = '';
      atStart = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      atStart = true;
    } else {
      field += ch;
      atStart = false;
    }
  }
  if (quoted) throw new BankFileError('unclosed-quote', 'A quoted field is not closed.');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0]!.trim() === ''));
}

function realDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Parses a bank file; lines in error are returned with their error (they are not imported). */
export function parseBankFile(content: Buffer): BankFileLine[] {
  const text = content.toString('utf-8').replace(/^﻿/, '');
  const records = csvRecords(text);
  if (records.length === 0) throw new BankFileError('empty', 'The file has no header row.');
  const header = records[0]!.map((name) => name.trim().toLowerCase());
  const missing = REQUIRED.filter((name) => !header.includes(name));
  if (missing.length > 0) throw new BankFileError('missing-columns', `The header row lacks: ${missing.join(', ')}.`);
  const rows = records.slice(1);
  if (rows.length === 0) throw new BankFileError('no-lines', 'The file has no lines.');
  if (rows.length > MAX_BANK_FILE_LINES) throw new BankFileError('too-many-lines', `At most ${MAX_BANK_FILE_LINES} lines per file.`);
  const at = (row: string[], name: string) => {
    const index = header.indexOf(name);
    const value = index >= 0 ? row[index]?.trim() ?? '' : '';
    return value === '' ? null : value;
  };
  return rows.map((row, index) => {
    const line: BankFileLine = {
      lineNo: index + 1,
      date: at(row, 'date'),
      amount: at(row, 'amount'),
      currency: at(row, 'currency')?.toUpperCase() ?? null,
      reference: at(row, 'reference')?.slice(0, 200) ?? null,
      description: at(row, 'description')?.slice(0, 500) ?? null,
      transactionId: at(row, 'transaction_id')?.slice(0, 100) ?? null,
      error: null,
    };
    if (row.length !== header.length) line.error = { code: 'columns', message: `The line has ${row.length} fields; the header has ${header.length}.` };
    else if (!line.date || !realDate(line.date)) line.error = { code: 'bad-date', message: 'The date is not a real date (YYYY-MM-DD).' };
    else if (!line.amount || !AMOUNT.test(line.amount)) line.error = { code: 'bad-amount', message: 'The amount is not a positive decimal such as 6000.00.' };
    else if (/^0+(\.0+)?$/.test(line.amount)) line.error = { code: 'bad-amount', message: 'The amount is zero.' };
    else if (!line.currency || !/^[A-Z]{3}$/.test(line.currency)) line.error = { code: 'bad-currency', message: 'The currency is not an ISO code such as GHS.' };
    if (line.error) {
      line.date = line.date && realDate(line.date) ? line.date : null;
      line.amount = line.amount && AMOUNT.test(line.amount) ? line.amount : null;
    }
    return line;
  });
}

/**
 * A stable key per line, so a file imported twice adds nothing: the bank's
 * transaction id when the file has one, otherwise the line's content with its
 * occurrence number among identical lines of the file.
 */
export function lineKeys(bankAccountId: string, lines: readonly BankFileLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    if (line.transactionId) return `bankfile:${bankAccountId}:id:${line.transactionId}`;
    const content = [line.date, line.amount, line.currency, line.reference, line.description].map((v) => v ?? '').join('\u001f');
    const occurrence = (seen.get(content) ?? 0) + 1;
    seen.set(content, occurrence);
    const digest = createHash('sha256').update(`${content}\u001f${occurrence}`).digest('hex');
    return `bankfile:${bankAccountId}:${digest}`;
  });
}

/** Lease references named in a line's texts (e.g. LSE-2026-000031), upper-cased. */
export function referenceTokens(...texts: Array<string | null>): string[] {
  const tokens = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? '').toUpperCase().matchAll(/[A-Z]{2,6}-\d{4}-\d{3,10}/g)) tokens.add(match[0]);
  }
  return [...tokens];
}
