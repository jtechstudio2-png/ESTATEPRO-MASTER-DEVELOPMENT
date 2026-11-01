// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { middleware } from '@/middleware';

afterEach(() => vi.unstubAllEnvs());

describe('content security policy', () => {
  it('sets a nonce-based policy that allows only our origin, media and tiles', () => {
    vi.stubEnv('MEDIA_ORIGIN', 'https://media.estatepro.test');
    vi.stubEnv('MAP_TILES_ORIGIN', 'https://tiles.estatepro.test');
    vi.stubEnv('OIDC_ISSUER', 'https://id.estatepro.test');
    vi.stubEnv('NODE_ENV', 'production');
    const response = middleware(new NextRequest('https://app.estatepro.test/properties?q=osu'));
    const policy = response.headers.get('content-security-policy')!;
    expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic'(;|$)/);
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain("img-src 'self' data: blob: https://media.estatepro.test https://tiles.estatepro.test");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("form-action 'self' https://id.estatepro.test");
    expect(response.headers.get('x-middleware-request-x-pathname')).toBe('/properties?q=osu');
  });

  it('allows eval only in development and changes the nonce per request', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const first = middleware(new NextRequest('https://app.estatepro.test/')).headers.get('content-security-policy')!;
    const second = middleware(new NextRequest('https://app.estatepro.test/')).headers.get('content-security-policy')!;
    expect(first).toContain("'unsafe-eval'");
    expect(first).not.toBe(second);
  });
});
