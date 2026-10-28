import { type RawBuilder, sql } from 'kysely';

import { type FieldError, Problems } from './problem.js';

/**
 * List query parsing shared by every collection endpoint (ADR-003 §6):
 * limit, opaque cursor, single-field sort and allow-listed filters.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SortValueKind = 'text' | 'timestamp' | 'numeric';

export interface SortSpec<F extends string> {
  allowed: Record<F, SortValueKind>;
  default: { field: F; direction: 'asc' | 'desc' };
}

export interface ParsedSort<F extends string> {
  field: F;
  direction: 'asc' | 'desc';
  kind: SortValueKind;
}

export interface Cursor {
  /** Sort value of the last row (ISO string for timestamps). */
  v: string;
  /** Id of the last row (tie-breaker). */
  id: string;
}

export interface Page<T> {
  data: T[];
  page: { limit: number; nextCursor: string | null };
}

export type FilterKind =
  | { type: 'uuid'; multi?: boolean }
  | { type: 'enum'; values: readonly string[]; multi?: boolean }
  | { type: 'code'; pattern: RegExp; multi?: boolean }
  | { type: 'boolean' }
  | { type: 'archived' }
  | { type: 'range'; pattern: RegExp };

export type FilterSpec = Record<string, FilterKind>;

export interface RangeValue {
  gte?: string;
  lte?: string;
}

export type ParsedFilters = Record<string, string[] | boolean | 'false' | 'true' | 'all' | RangeValue | undefined>;

export interface ListQueryInput {
  limit?: unknown;
  cursor?: unknown;
  sort?: unknown;
  filter?: unknown;
  q?: unknown;
}

export interface ParsedListQuery<F extends string> {
  limit: number;
  cursor: Cursor | null;
  sort: ParsedSort<F>;
  filters: ParsedFilters;
  q: string | null;
}

export function parseListQuery<F extends string>(
  input: ListQueryInput,
  sortSpec: SortSpec<F>,
  filterSpec: FilterSpec,
): ParsedListQuery<F> {
  const errors: FieldError[] = [];

  let limit = DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    const parsed = typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit) ? Number(input.limit) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      errors.push({ field: 'limit', code: 'range', message: `Use a whole number from 1 to ${MAX_LIMIT}.` });
    } else {
      limit = parsed;
    }
  }

  let sort: ParsedSort<F> = { ...sortSpec.default, kind: sortSpec.allowed[sortSpec.default.field] };
  if (input.sort !== undefined) {
    const raw = typeof input.sort === 'string' ? input.sort : '';
    const direction = raw.startsWith('-') ? 'desc' : 'asc';
    const field = (raw.startsWith('-') ? raw.slice(1) : raw) as F;
    if (!Object.hasOwn(sortSpec.allowed, field)) {
      errors.push({
        field: 'sort',
        code: 'unknown-sort',
        message: `Sort by one of: ${Object.keys(sortSpec.allowed).join(', ')} (prefix with - for descending).`,
      });
    } else {
      sort = { field, direction, kind: sortSpec.allowed[field] };
    }
  }

  let cursor: Cursor | null = null;
  if (input.cursor !== undefined) {
    cursor = decodeCursor(input.cursor, sort.kind);
    if (cursor === null) errors.push({ field: 'cursor', code: 'invalid', message: 'The cursor is not valid for this list.' });
  }

  let q: string | null = null;
  if (input.q !== undefined) {
    const text = typeof input.q === 'string' ? input.q.trim() : '';
    if (text.length < 2 || text.length > 100) {
      errors.push({ field: 'q', code: 'length', message: 'Search text must be 2 to 100 characters.' });
    } else {
      q = text;
    }
  }

  const filters = parseFilters(input.filter, filterSpec, errors);

  if (errors.length > 0) throw Problems.validation(errors);
  return { limit, cursor, sort, filters, q };
}

function parseFilters(raw: unknown, spec: FilterSpec, errors: FieldError[]): ParsedFilters {
  const result: ParsedFilters = {};
  if (raw === undefined) return result;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push({ field: 'filter', code: 'invalid', message: 'Use filter[name]=value.' });
    return result;
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const kind = spec[key];
    const field = `filter[${key}]`;
    if (kind === undefined) {
      errors.push({ field, code: 'unknown-filter', message: 'This filter is not supported.' });
      continue;
    }

    if (kind.type === 'range') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push({ field, code: 'invalid', message: `Use ${field}[gte]=… and/or ${field}[lte]=….` });
        continue;
      }
      const range: RangeValue = {};
      for (const [bound, boundValue] of Object.entries(value as Record<string, unknown>)) {
        if ((bound !== 'gte' && bound !== 'lte') || typeof boundValue !== 'string' || !kind.pattern.test(boundValue)) {
          errors.push({ field: `${field}[${bound}]`, code: 'invalid', message: 'This range bound is not valid.' });
          continue;
        }
        range[bound] = boundValue;
      }
      result[key] = range;
      continue;
    }

    if (typeof value !== 'string') {
      errors.push({ field, code: 'invalid', message: 'This filter takes a single text value.' });
      continue;
    }

    if (kind.type === 'boolean') {
      if (value !== 'true' && value !== 'false') {
        errors.push({ field, code: 'invalid', message: 'Use true or false.' });
        continue;
      }
      result[key] = value === 'true';
      continue;
    }

    if (kind.type === 'archived') {
      if (value !== 'false' && value !== 'true' && value !== 'all') {
        errors.push({ field, code: 'invalid', message: 'Use false, true or all.' });
        continue;
      }
      result[key] = value;
      continue;
    }

    const values = kind.multi ? value.split(',').map((item) => item.trim()) : [value.trim()];
    const valid = values.every((item) => {
      if (kind.type === 'uuid') return UUID.test(item);
      if (kind.type === 'enum') return kind.values.includes(item);
      return kind.pattern.test(item);
    });
    if (values.length === 0 || values.length > 50 || !valid) {
      const hint = kind.type === 'enum' ? ` Allowed: ${kind.values.join(', ')}.` : '';
      errors.push({ field, code: 'invalid', message: `This filter value is not valid.${hint}` });
      continue;
    }
    result[key] = kind.type === 'uuid' ? values.map((item) => item.toLowerCase()) : values;
  }
  return result;
}

export function encodeCursor(sortValue: string | Date, id: string): string {
  const v = sortValue instanceof Date ? sortValue.toISOString() : sortValue;
  return Buffer.from(JSON.stringify({ v, id } satisfies Cursor)).toString('base64url');
}

function decodeCursor(raw: unknown, kind: SortValueKind): Cursor | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1000) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { v, id } = decoded as Record<string, unknown>;
    if (typeof v !== 'string' || typeof id !== 'string' || !UUID.test(id)) return null;
    if (kind === 'timestamp' && Number.isNaN(Date.parse(v))) return null;
    if (kind === 'numeric' && !/^-?\d{1,20}(\.\d{1,10})?$/.test(v)) return null;
    return { v, id };
  } catch {
    return null;
  }
}

/** Builds the page envelope; `rows` must hold limit + 1 rows when more exist. */
export function toPage<R, T>(
  rows: R[],
  limit: number,
  sortValue: (row: R) => string | Date,
  id: (row: R) => string,
  map: (row: R) => T,
): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    data: pageRows.map(map),
    page: {
      limit,
      nextCursor: hasMore && last !== undefined ? encodeCursor(sortValue(last), id(last)) : null,
    },
  };
}

/**
 * SQL helpers for keyset pagination. The sort value is selected as text so a
 * timestamp keeps its microseconds (a JavaScript Date would drop them and
 * repeat or skip rows across pages).
 */
export function sortValueSql(column: string | RawBuilder<unknown>, kind: SortValueKind): RawBuilder<string> {
  const target = typeof column === 'string' ? sql.ref(column) : column;
  return kind === 'text' ? sql<string>`${target}` : sql<string>`(${target})::text`;
}

/** `column` is a column name, or an expression for computed sorts such as distance. */
export function keysetCondition(
  column: string | RawBuilder<unknown>,
  idColumn: string,
  sort: ParsedSort<string>,
  cursor: Cursor,
): RawBuilder<boolean> {
  const target = typeof column === 'string' ? sql.ref(column) : column;
  const operator = sort.direction === 'asc' ? sql.raw('>') : sql.raw('<');
  const value =
    sort.kind === 'timestamp' ? sql`${cursor.v}::timestamptz` : sort.kind === 'numeric' ? sql`${cursor.v}::numeric` : sql`${cursor.v}`;
  return sql<boolean>`(${target}, ${sql.ref(idColumn)}) ${operator} (${value}, ${cursor.id}::uuid)`;
}
