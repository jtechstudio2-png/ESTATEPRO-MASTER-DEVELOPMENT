// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/env', () => ({ env: () => ({ WEB_ORIGIN: 'https://app.estatepro.test' }) }));

const { csrfValid } = await import('@/server/csrf');
const session = { csrfToken: 'token-123' } as Parameters<typeof csrfValid>[1];

function request(headers: Record<string, string>) {
  return new Request('https://app.estatepro.test/bff/properties', { method: 'POST', headers });
}

describe('CSRF check on writes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts our origin with the session token', () => {
    expect(csrfValid(request({ origin: 'https://app.estatepro.test', 'x-csrf-token': 'token-123' }), session)).toBe(true);
    expect(csrfValid(request({ 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'token-123' }), session)).toBe(true);
  });

  it('refuses another origin, a missing or wrong token, and a cross-site request without Origin', () => {
    expect(csrfValid(request({ origin: 'https://evil.test', 'x-csrf-token': 'token-123' }), session)).toBe(false);
    expect(csrfValid(request({ origin: 'https://app.estatepro.test' }), session)).toBe(false);
    expect(csrfValid(request({ origin: 'https://app.estatepro.test', 'x-csrf-token': 'token-124' }), session)).toBe(false);
    expect(csrfValid(request({ 'sec-fetch-site': 'cross-site', 'x-csrf-token': 'token-123' }), session)).toBe(false);
  });
});
