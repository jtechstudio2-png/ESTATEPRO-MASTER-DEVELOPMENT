// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionState: { current: Record<string, unknown> | null } = { current: null };
vi.mock('@/server/session', () => ({ currentSession: () => Promise.resolve(sessionState.current) }));
vi.mock('@/server/env', () => ({ env: () => ({ WEB_ORIGIN: 'https://app.estatepro.test', API_BASE_URL: 'https://api.estatepro.test' }) }));

const bff = await import('@/app/bff/[...path]/route');
const csrfRoute = await import('@/app/auth/csrf/route');

const fetchMock = vi.fn<typeof fetch>();
const params = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const signedIn = { csrfToken: 'tok', companyId: 'c1', tokens: { accessToken: 'access-1' } };

beforeEach(() => {
  sessionState.current = { ...signedIn };
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('BFF proxy', () => {
  it('forwards reads with the access token, company and allowed headers only', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json', etag: '"4"', 'set-cookie': 'x=1', 'x-internal': 'y' } }));
    const response = await bff.GET(new Request('https://app.estatepro.test/bff/properties?q=osu', { headers: { accept: 'application/json', cookie: 'sid=1', 'if-match': '"3"' } }), params('properties'));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.estatepro.test/api/v1/properties?q=osu');
    expect(init?.headers).toEqual({ authorization: 'Bearer access-1', 'x-company-id': 'c1', accept: 'application/json', 'if-match': '"3"' });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"4"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-internal')).toBeNull();
  });

  it('refuses bad paths, no session, a missing company and writes without CSRF', async () => {
    expect((await bff.GET(new Request('https://app.estatepro.test/bff/x'), params('..', 'admin'))).status).toBe(404);
    expect((await bff.GET(new Request('https://app.estatepro.test/bff/x'), params('properties', '.'))).status).toBe(404);
    expect((await bff.GET(new Request('https://app.estatepro.test/bff/x'), params('a b'))).status).toBe(404);
    expect((await bff.GET(new Request('https://app.estatepro.test/bff/x'), params())).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    sessionState.current = null;
    const unauthenticated = await bff.GET(new Request('https://app.estatepro.test/bff/properties'), params('properties'));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('content-type')).toBe('application/problem+json');
    sessionState.current = { ...signedIn, companyId: null };
    expect((await bff.GET(new Request('https://app.estatepro.test/bff/properties'), params('properties'))).status).toBe(409);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    expect((await bff.GET(new Request('https://app.estatepro.test/bff/me'), params('me'))).status).toBe(200);
    expect(fetchMock.mock.calls[0]![1]!.headers).not.toHaveProperty('x-company-id');
    sessionState.current = { ...signedIn };
    const forged = await bff.POST(new Request('https://app.estatepro.test/bff/properties', { method: 'POST', headers: { origin: 'https://evil.test', 'x-csrf-token': 'tok' }, body: '{}' }), params('properties'));
    expect(forged.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards writes with their body, limits the size and maps Location', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"id":"p1"}', { status: 201, headers: { location: '/api/v1/properties/p1' } }));
    const write = (body: string) =>
      new Request('https://app.estatepro.test/bff/properties', { method: 'POST', headers: { origin: 'https://app.estatepro.test', 'x-csrf-token': 'tok', 'content-type': 'application/json', 'idempotency-key': 'k1' }, body });
    const created = await bff.POST(write('{"name":"Osu"}'), params('properties'));
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe('/bff/properties/p1');
    expect(new TextDecoder().decode(fetchMock.mock.calls[0]![1]!.body as ArrayBuffer)).toBe('{"name":"Osu"}');
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'idempotency-key': 'k1', 'content-type': 'application/json' });
    expect((await bff.POST(write('x'.repeat(1_000_001)), params('properties'))).status).toBe(413);
  });

  it('passes 204 through and reports an unreachable API', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const deleted = await bff.DELETE(new Request('https://app.estatepro.test/bff/x', { method: 'DELETE', headers: { 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'tok' } }), params('saved-views', 'v1'));
    expect(deleted.status).toBe(204);
    expect(fetchMock.mock.calls[0]![1]!).not.toHaveProperty('body');
    fetchMock.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'));
    expect((await bff.GET(new Request('https://app.estatepro.test/bff/properties'), params('properties'))).status).toBe(502);
  });
});

describe('CSRF token refresh (X-3)', () => {
  it('returns the current token and company, never cached', async () => {
    const response = await csrfRoute.GET(new Request('https://app.estatepro.test/auth/csrf', { headers: { 'sec-fetch-site': 'same-origin' } }));
    expect(await response.json()).toEqual({ csrfToken: 'tok', companyId: 'c1' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses cross-site requests and signed-out users', async () => {
    expect((await csrfRoute.GET(new Request('https://app.estatepro.test/auth/csrf', { headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403);
    sessionState.current = null;
    expect((await csrfRoute.GET(new Request('https://app.estatepro.test/auth/csrf'))).status).toBe(401);
  });
});
