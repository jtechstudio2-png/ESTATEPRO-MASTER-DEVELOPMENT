/**
 * RFC 9457 problem details as returned by the API (ADR-003 §7). The UI maps
 * every error through these helpers (UI checklist §7); screens never parse
 * error text themselves.
 */
export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: FieldError[];
  conflictingResource?: { type: string; id: string };
}

const PREFIX = 'urn:estatepro:problem:';

export class ApiError extends Error {
  readonly problem: Problem;
  /** Seconds from a Retry-After header (429). */
  readonly retryAfter: number | null;

  constructor(problem: Problem, retryAfter: number | null = null) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.problem = problem;
    this.retryAfter = retryAfter;
  }

  get status(): number {
    return this.problem.status;
  }

  /** The problem code, e.g. "validation-failed", "publish-blocked". */
  get code(): string {
    return this.problem.type.startsWith(PREFIX) ? this.problem.type.slice(PREFIX.length) : this.problem.type;
  }

  get fieldErrors(): FieldError[] {
    return this.problem.errors ?? [];
  }
}

/** Errors raised before any HTTP response (offline, DNS, aborted). */
export class NetworkError extends Error {
  constructor(message = 'network') {
    super(message);
    this.name = 'NetworkError';
  }
}

export function isProblem(value: unknown): value is Problem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Problem).type === 'string' &&
    typeof (value as Problem).title === 'string' &&
    typeof (value as Problem).status === 'number'
  );
}

/** Builds an ApiError from any failed response, even one without a problem body. */
export async function problemFromResponse(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const retry = response.headers.get('retry-after');
  const retryAfter = retry !== null && /^\d+$/.test(retry) ? Number(retry) : null;
  if (isProblem(body)) return new ApiError(body, retryAfter);
  return new ApiError({ type: `${PREFIX}http-${response.status}`, title: response.statusText || 'Request failed', status: response.status }, retryAfter);
}

/** Field errors keyed by field path, for forms (first message per field). */
export function errorsByField(errors: FieldError[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const error of errors) result[error.field] ??= error.message;
  return result;
}
