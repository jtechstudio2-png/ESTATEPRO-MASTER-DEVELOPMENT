import { describe, expect, it } from 'vitest';

import { ApiError, errorsByField, isProblem, NetworkError, problemFromResponse } from '@/lib/problem';

describe('problem details', () => {
  it('reads the code, status and field errors of an API problem', () => {
    const error = new ApiError({
      type: 'urn:estatepro:problem:validation-failed',
      title: 'Validation failed',
      status: 422,
      detail: 'Check the fields.',
      errors: [{ field: 'label', code: 'required', message: 'Enter a tag.' }],
    });
    expect(error.code).toBe('validation-failed');
    expect(error.status).toBe(422);
    expect(error.message).toBe('Check the fields.');
    expect(error.fieldErrors).toHaveLength(1);
    expect(new ApiError({ type: 'about:blank', title: 'Gone', status: 410 }).code).toBe('about:blank');
    expect(new ApiError({ type: 'about:blank', title: 'Gone', status: 410 }).fieldErrors).toEqual([]);
  });

  it('builds an ApiError from a problem body and its Retry-After header', async () => {
    const response = new Response(JSON.stringify({ type: 'urn:estatepro:problem:too-many-requests', title: 'Too many requests', status: 429 }), {
      status: 429,
      headers: { 'retry-after': '30', 'content-type': 'application/problem+json' },
    });
    const error = await problemFromResponse(response);
    expect(error.code).toBe('too-many-requests');
    expect(error.retryAfter).toBe(30);
  });

  it('builds an ApiError from a response without a problem body', async () => {
    const error = await problemFromResponse(new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway', headers: { 'retry-after': 'soon' } }));
    expect(error.code).toBe('http-502');
    expect(error.status).toBe(502);
    expect(error.problem.title).toBe('Bad Gateway');
    expect(error.retryAfter).toBeNull();
    const empty = await problemFromResponse(new Response(null, { status: 500 }));
    expect(empty.problem.title).toBe('Request failed');
  });

  it('recognises problems and keeps the first message per field', () => {
    expect(isProblem({ type: 'x', title: 'y', status: 400 })).toBe(true);
    expect(isProblem({ type: 'x', title: 'y' })).toBe(false);
    expect(isProblem(null)).toBe(false);
    expect(errorsByField([
      { field: 'a', code: 'c', message: 'first' },
      { field: 'a', code: 'c', message: 'second' },
      { field: 'b', code: 'c', message: 'other' },
    ])).toEqual({ a: 'first', b: 'other' });
    expect(new NetworkError().name).toBe('NetworkError');
  });
});
