import { describe, expect, it } from 'vitest';

import { BankFileError, csvRecords, lineKeys, MAX_BANK_FILE_LINES, parseBankFile, referenceTokens } from '../src/lettings/bank-file.js';

const file = (text: string) => Buffer.from(text, 'utf-8');

/** EstatePro CSV v1 (P7-D7): parsing, line errors, stable keys and reference matching. */
describe('bank file (EstatePro CSV v1)', () => {
  it('reads RFC 4180 records: quotes, doubled quotes, embedded commas and line breaks, CRLF', () => {
    expect(csvRecords('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', 'z'],
    ]);
    expect(csvRecords('a,b')).toEqual([['a', 'b']]);
    expect(() => csvRecords('a,"b')).toThrow(BankFileError);
  });

  it('needs a header with the required columns and at least one line', () => {
    const code = (text: string) => {
      try {
        parseBankFile(file(text));
        return null;
      } catch (error) {
        return (error as BankFileError).code;
      }
    };
    expect(code('')).toBe('empty');
    expect(code('date,amount,currency\n2026-01-01,1.00,GHS\n')).toBe('missing-columns');
    expect(code('date,amount,currency,reference\n')).toBe('no-lines');
    const many = ['date,amount,currency,reference', ...Array.from({ length: MAX_BANK_FILE_LINES + 1 }, () => '2026-01-01,1.00,GHS,R')].join('\n');
    expect(code(many)).toBe('too-many-lines');
  });

  it('reports each line\'s error and keeps the good lines (columns in any order and case, a byte-order mark)', () => {
    const lines = parseBankFile(
      file(
        '﻿Reference,CURRENCY,Amount,Date,Transaction_ID\n' +
          'LSE-2026-000001,ghs,6000.00,2026-02-02,T1\n' +
          'X,GHS,6000.00,2026-02-30,T2\n' +
          'X,GHS,6,000,2026-02-02,T3\n' +
          'X,GHS,0.00,2026-02-02,T4\n' +
          'X,GH,1.00,2026-02-02,T5\n' +
          'X,GHS,1.00\n' +
          'X,GHS,abc,2026-02-02,T7\n',
      ),
    );
    expect(lines.map((line) => [line.lineNo, line.error?.code ?? null])).toEqual([
      [1, null], [2, 'bad-date'], [3, 'columns'], [4, 'bad-amount'], [5, 'bad-currency'], [6, 'columns'], [7, 'bad-amount'],
    ]);
    expect(lines[0]).toMatchObject({ date: '2026-02-02', amount: '6000.00', currency: 'GHS', reference: 'LSE-2026-000001', transactionId: 'T1', description: null });
    expect(lines[1]).toMatchObject({ date: null, amount: '6000.00' });
    expect(lines[6]).toMatchObject({ amount: null });
  });

  it('keys lines by the bank\'s transaction id, or by content and occurrence', () => {
    const lines = parseBankFile(file('date,amount,currency,reference,transaction_id\n2026-01-01,1.00,GHS,R,\n2026-01-01,1.00,GHS,R,\n2026-01-01,1.00,GHS,R,T9\n'));
    const keys = lineKeys('acc', lines);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[2]).toBe('bankfile:acc:id:T9');
    expect(lineKeys('acc', lines)).toEqual(keys);
    expect(lineKeys('other', lines)[0]).not.toBe(keys[0]);
  });

  it('finds lease references in a line\'s texts', () => {
    expect(referenceTokens('rent lse-2026-000031 jan', null, 'and LSE-2026-000031, LSE-2025-000112')).toEqual(['LSE-2026-000031', 'LSE-2025-000112']);
    expect(referenceTokens('JAN RENT FLAT2')).toEqual([]);
  });
});
