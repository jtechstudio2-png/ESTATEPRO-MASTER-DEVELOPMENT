import { describe, expect, it } from 'vitest';

import { encodeCursor, encodeEntryCursor, type FilterSpec, keysetEntryCondition, MAX_LIMIT, parseListQuery, type SortSpec, toEntryPage, toPage } from '../src/common/list-query.js';
import { ProblemError } from '../src/common/problem.js';

const SORT: SortSpec<'name' | 'createdAt'> = {
  allowed: { name: 'text', createdAt: 'timestamp' },
  default: { field: 'createdAt', direction: 'desc' },
};

const FILTERS: FilterSpec = {
  officeId: { type: 'uuid', multi: true },
  status: { type: 'enum', values: ['draft', 'available'], multi: true },
  countryCode: { type: 'code', pattern: /^[A-Z]{2}$/ },
  isManaged: { type: 'boolean' },
  archived: { type: 'archived' },
  price: { type: 'range', pattern: /^\d+(\.\d{1,2})?$/ },
};

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function errorsOf(input: Parameters<typeof parseListQuery>[0]): string[] {
  try {
    parseListQuery(input, SORT, FILTERS);
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    const errors = (error as ProblemError).extras.errors ?? [];
    return errors.map((item) => `${item.field}:${item.code}`);
  }
  return [];
}

describe('parseListQuery', () => {
  it('applies defaults', () => {
    expect(parseListQuery({}, SORT, FILTERS)).toEqual({
      limit: 50,
      cursor: null,
      sort: { field: 'createdAt', direction: 'desc', kind: 'timestamp' },
      filters: {},
      q: null,
    });
  });

  it('parses limit, sort, search text and every filter type', () => {
    const parsed = parseListQuery(
      {
        limit: '25',
        sort: '-name',
        q: '  osu  ',
        filter: {
          officeId: `${ID.toUpperCase()}, ${ID}`,
          status: 'draft,available',
          countryCode: 'GH',
          isManaged: 'false',
          archived: 'all',
          price: { gte: '100', lte: '250.50' },
        },
      },
      SORT,
      FILTERS,
    );
    expect(parsed).toMatchObject({
      limit: 25,
      sort: { field: 'name', direction: 'desc', kind: 'text' },
      q: 'osu',
      filters: {
        officeId: [ID, ID],
        status: ['draft', 'available'],
        countryCode: ['GH'],
        isManaged: false,
        archived: 'all',
        price: { gte: '100', lte: '250.50' },
      },
    });
    expect(parseListQuery({ sort: 'name', filter: { isManaged: 'true' } }, SORT, FILTERS)).toMatchObject({
      sort: { direction: 'asc' },
      filters: { isManaged: true },
    });
  });

  it('rejects out-of-range limits, unknown sorts and bad search text', () => {
    expect(errorsOf({ limit: '0' })).toEqual(['limit:range']);
    expect(errorsOf({ limit: String(MAX_LIMIT + 1) })).toEqual(['limit:range']);
    expect(errorsOf({ limit: '1e2' })).toEqual(['limit:range']);
    expect(errorsOf({ limit: ['10'] })).toEqual(['limit:range']);
    expect(errorsOf({ sort: '-price' })).toEqual(['sort:unknown-sort']);
    expect(errorsOf({ sort: ['name'] })).toEqual(['sort:unknown-sort']);
    expect(errorsOf({ q: ' a ' })).toEqual(['q:length']);
    expect(errorsOf({ q: 'x'.repeat(101) })).toEqual(['q:length']);
    expect(errorsOf({ q: ['osu'] })).toEqual(['q:length']);
  });

  it('rejects malformed and unknown filters', () => {
    expect(errorsOf({ filter: 'officeId' })).toEqual(['filter:invalid']);
    expect(errorsOf({ filter: ['x'] })).toEqual(['filter:invalid']);
    expect(errorsOf({ filter: { colour: 'blue' } })).toEqual(['filter[colour]:unknown-filter']);
    expect(errorsOf({ filter: { officeId: 'not-a-uuid' } })).toEqual(['filter[officeId]:invalid']);
    expect(errorsOf({ filter: { officeId: [ID, ID] } })).toEqual(['filter[officeId]:invalid']);
    expect(errorsOf({ filter: { officeId: Array.from({ length: 51 }, () => ID).join(',') } })).toEqual(['filter[officeId]:invalid']);
    expect(errorsOf({ filter: { status: 'sold' } })).toEqual(['filter[status]:invalid']);
    expect(errorsOf({ filter: { countryCode: 'gh' } })).toEqual(['filter[countryCode]:invalid']);
    expect(errorsOf({ filter: { isManaged: 'yes' } })).toEqual(['filter[isManaged]:invalid']);
    expect(errorsOf({ filter: { archived: 'only' } })).toEqual(['filter[archived]:invalid']);
    expect(errorsOf({ filter: { price: '100' } })).toEqual(['filter[price]:invalid']);
    expect(errorsOf({ filter: { price: ['100'] } })).toEqual(['filter[price]:invalid']);
    expect(errorsOf({ filter: { price: { gt: '1', lte: 'ten', gte: ['1'] } } })).toEqual([
      'filter[price][gt]:invalid',
      'filter[price][lte]:invalid',
      'filter[price][gte]:invalid',
    ]);
  });

  it('round-trips cursors and rejects tampered ones', () => {
    const at = new Date('2026-10-01T09:30:00.123Z');
    const parsed = parseListQuery({ cursor: encodeCursor(at, ID) }, SORT, FILTERS);
    expect(parsed.cursor).toEqual({ v: at.toISOString(), id: ID });
    expect(parseListQuery({ sort: 'name', cursor: encodeCursor('Osu Court', ID) }, SORT, FILTERS).cursor).toEqual({ v: 'Osu Court', id: ID });

    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    expect(errorsOf({ cursor: encodeCursor('not a date', ID) })).toEqual(['cursor:invalid']);
    expect(errorsOf({ cursor: encodeCursor('2026-10-01', 'nope') })).toEqual(['cursor:invalid']);
    expect(errorsOf({ cursor: encode({ v: 1, id: ID }) })).toEqual(['cursor:invalid']);
    expect(errorsOf({ cursor: encode('text') })).toEqual(['cursor:invalid']);
    expect(errorsOf({ cursor: encode(null) })).toEqual(['cursor:invalid']);
    expect(errorsOf({ cursor: 'not-json' })).toEqual(['cursor:invalid']);
    expect(errorsOf({ cursor: '' })).toEqual(['cursor:invalid']);
    expect(errorsOf({ cursor: 'a'.repeat(1001) })).toEqual(['cursor:invalid']);
    expect(errorsOf({ cursor: [encodeCursor(at, ID)] })).toEqual(['cursor:invalid']);
  });

  it('reports every problem at once', () => {
    expect(errorsOf({ limit: '500', sort: 'colour', q: 'a', filter: { colour: 'x' } })).toEqual([
      'limit:range',
      'sort:unknown-sort',
      'q:length',
      'filter[colour]:unknown-filter',
    ]);
  });
});

describe('toPage', () => {
  const rows = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ];

  it('returns a cursor for the last row only when more rows exist', () => {
    const page = toPage(rows, 2, (row) => row.name, (row) => row.id, (row) => row.name);
    expect(page.data).toEqual(['A', 'B']);
    expect(JSON.parse(Buffer.from(page.page.nextCursor!, 'base64url').toString('utf8'))).toEqual({ v: 'B', id: 'b' });
    expect(toPage(rows, 3, (row) => row.name, (row) => row.id, (row) => row.name).page).toEqual({ limit: 3, nextCursor: null });
    expect(toPage([], 3, (row: { id: string }) => row.id, (row) => row.id, (row) => row).data).toEqual([]);
  });
});

describe('history cursors (#15)', () => {
  const HISTORY: SortSpec<'changedAt'> = { allowed: { changedAt: 'timestamp' }, default: { field: 'changedAt', direction: 'asc' } };
  const at = '2026-11-12T09:00:00.123456+00:00';

  it('carries the insertion number and reads it back', () => {
    const cursor = encodeEntryCursor(at, '42');
    expect(parseListQuery({ cursor }, HISTORY, {}, 'entry').cursor).toEqual({ v: at, id: '', n: '42' });
  });

  it('refuses a record-list cursor, a missing or malformed number, and a bad time', () => {
    const refused = (cursor: string) => {
      try {
        parseListQuery({ cursor }, HISTORY, {}, 'entry');
        return null;
      } catch (error) {
        return (error as ProblemError).extras.errors?.[0];
      }
    };
    expect(refused(encodeCursor(new Date(at), '0b7c1f4e-1111-4222-8333-944455556666'))).toMatchObject({ field: 'cursor', code: 'invalid' });
    expect(refused(Buffer.from(JSON.stringify({ v: at, n: '4x' })).toString('base64url'))).toMatchObject({ code: 'invalid' });
    expect(refused(Buffer.from(JSON.stringify({ v: at, n: '1'.repeat(20) })).toString('base64url'))).toMatchObject({ code: 'invalid' });
    expect(refused(Buffer.from(JSON.stringify({ v: 'yesterday', n: '4' })).toString('base64url'))).toMatchObject({ code: 'invalid' });
    // A history cursor is not accepted by a record list either.
    expect(() => parseListQuery({ cursor: encodeEntryCursor(at, '4') }, HISTORY, {})).toThrow(ProblemError);
  });

  it('pages with the insertion number of the last row', () => {
    const rows = [
      { t: at, n: '7' },
      { t: at, n: '8' },
      { t: at, n: '9' },
    ];
    const page = toEntryPage(rows, 2, (row) => row.t, (row) => row.n, (row) => row.n);
    expect(page.data).toEqual(['7', '8']);
    expect(JSON.parse(Buffer.from(page.page.nextCursor!, 'base64url').toString('utf8'))).toEqual({ v: at, n: '8' });
    expect(toEntryPage(rows, 3, (row) => row.t, (row) => row.n, (row) => row).page.nextCursor).toBeNull();
  });

  it('builds a (time, entry_no) keyset condition in the sort direction', () => {
    const parsed = parseListQuery({ cursor: encodeEntryCursor(at, '8'), sort: '-changedAt' }, HISTORY, {}, 'entry');
    expect(keysetEntryCondition('h.changedAt', 'h.entryNo', parsed.sort, parsed.cursor!)).toBeDefined();
  });
});
