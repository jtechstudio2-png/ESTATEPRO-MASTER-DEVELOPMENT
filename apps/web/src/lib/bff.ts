import { ApiError, NetworkError, problemFromResponse } from './problem';

let csrfToken: string | null = null;

/** Raised once per 401 from the BFF; the app providers decide what to do (sign in, or keep the page). */
export const SESSION_ENDED_EVENT = 'estatepro:session-ended';

/** Set once by the app providers from the server-rendered session (never stored in the browser). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export interface BffOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Record version for If-Match (ADR-003 §4). */
  version?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface BffResponse<T> {
  data: T;
  /** Version from the ETag header, when the response has one. */
  version: number | null;
  status: number;
}

/** Path below /bff (e.g. "properties?limit=50"). */
export async function bffRequest<T>(path: string, options: BffOptions = {}): Promise<BffResponse<T>> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken !== null) headers['x-csrf-token'] = csrfToken;
  if (options.version !== undefined) headers['if-match'] = `"${options.version}"`;
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`/bff/${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new NetworkError();
  }
  if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
  if (!response.ok) throw await problemFromResponse(response);
  const etag = response.headers.get('etag');
  const match = etag !== null ? /^"(\d+)"$/.exec(etag) : null;
  const data = response.status === 204 ? (null as T) : ((await response.json()) as T);
  return { data, version: match?.[1] !== undefined ? Number(match[1]) : null, status: response.status };
}

export async function bff<T>(path: string, options: BffOptions = {}): Promise<T> {
  return (await bffRequest<T>(path, options)).data;
}

/** A fresh Idempotency-Key for one create attempt; reuse it when retrying that same attempt. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Builds a query string from defined values; arrays become comma lists (ADR-003 §6). */
export function query(params: Record<string, string | number | boolean | string[] | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
}

export { ApiError };
