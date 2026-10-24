import { type ProblemError, Problems } from './problem.js';

/**
 * Human-readable explanations for named database constraints. Modules register
 * the constraints their endpoints can hit, so users get a specific message
 * instead of a constraint name (internal names are never sent to clients).
 */
const constraintMessages = new Map<string, string>();

export function registerConstraintMessages(messages: Record<string, string>): void {
  for (const [constraint, message] of Object.entries(messages)) {
    constraintMessages.set(constraint, message);
  }
}

interface PostgresError {
  code: string;
  constraint?: string;
  message: string;
}

export function isPostgresError(error: unknown): error is PostgresError {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('severity' in error)) return false;
  const { code } = error;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/** Maps a PostgreSQL error to a problem, or returns null when it is unexpected (→ 500). */
export function problemFromPostgresError(error: PostgresError): ProblemError | null {
  const known = error.constraint !== undefined ? constraintMessages.get(error.constraint) : undefined;
  switch (error.code) {
    case '23505': // unique_violation
    case '23P01': // exclusion_violation
      return Problems.conflict(known ?? 'A record with the same unique values already exists.');
    case '23514': // check_violation (constraints and rule triggers)
    case '23503': // foreign_key_violation
    case '23502': // not_null_violation
      return Problems.businessRule(known ?? 'The request breaks a data rule and was not saved.');
    case '22001': // string_data_right_truncation
    case '22003': // numeric_value_out_of_range
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '22P02': // invalid_text_representation
      return Problems.businessRule(known ?? 'A value is outside the allowed range or format.');
    case '42501': // insufficient_privilege: RLS violation or a protecting trigger
      return error.message.includes('row-level security')
        ? Problems.forbidden()
        : Problems.businessRule(known ?? 'This record cannot be changed in its current state.');
    case '40001': // serialization_failure
    case '40P01': // deadlock_detected
      return Problems.conflict('The record was changed at the same time by another request. Try again.');
    default:
      return null;
  }
}
