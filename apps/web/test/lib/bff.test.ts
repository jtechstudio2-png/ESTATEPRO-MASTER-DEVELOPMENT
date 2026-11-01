import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bff, bffRequest, newIdempotencyKey, query, SESSION_ENDED_EVENT, setCsrfToken } from '@/lib/bff';
import { ApiError, NetworkError } from '@/lib/problem';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  setCsrfToken('token-1');
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

describe('BFF client', () => {
  it('sends reads without CSRF and returns the version from the ETag', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'p1' }, { headers: { etag: '"7"' } }));
    const response = await bffRequest<{ id: string }>('properties/p1');
    expect(response).toEqual({ data: { id: 'p1' }, version: 7, status: 200 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/bff/properties/p1');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('sends writes with the CSRF token, If-Match and Idempotency-Key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await bffRequest('key-sets/k1', { method: 'PATCH', body: { label: 'K-1' }, version: 3, idempotencyKey: 'abc' });
    expect(response.data).toBeNull();
    expect(response.version).toBeNull();
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ 'x-csrf-token': 'token-1', 'if-match': '"3"', 'idempotency-key': 'abc', 'content-type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ label: 'K-1' }));
  });

  it('ignores an ETag that is not a version number', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }, { headers: { etag: 'W/"abc"' } }));
    expect((await bffRequest('x')).version).toBeNull();
  });

  it('turns failures into ApiError, and raises the session-ended event on 401', async () => {
    const ended = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    fetchMock.mockResolvedValueOnce(json({ type: 'urn:estatepro:problem:unauthorized', title: 'Unauthorized', status: 401 }, { status: 401 }));
    await expect(bff('me')).rejects.toBeInstanceOf(ApiError);
    expect(ended).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json({ type: 'urn:estatepro:problem:not-found', title: 'Not found', status: 404 }, { status: 404 }));
    await expect(bff('properties/x')).rejects.toMatchObject({ status: 404 });
    expect(ended).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_ENDED_EVENT, ended);
  });

  it('reports network failures, but passes aborts through', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(bff('x')).rejects.toBeInstanceOf(NetworkError);
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    await expect(bff('x', { signal: new AbortController().signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('builds query strings: skips empty values and joins lists', () => {
    expect(query({ q: 'osu', limit: 20, archived: false, empty: '', none: null, missing: undefined, status: ['a', 'b'], blank: [] })).toBe('?q=osu&limit=20&archived=false&status=a%2Cb');
    expect(query({})).toBe('');
    expect(newIdempotencyKey()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
