// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { open, randomToken, safeEqual, seal, sha256 } from '@/server/crypto';
import { safeReturnTo } from '@/server/return-to';

describe('token sealing', () => {
  const key = randomBytes(32);

  it('opens what it sealed, for the same context only', () => {
    const sealed = seal(key, 'access-token', 'session:1');
    expect(open(key, sealed, 'session:1')).toBe('access-token');
    expect(open(key, sealed, 'session:2')).toBeNull();
    expect(open(randomBytes(32), sealed, 'session:1')).toBeNull();
  });

  it('detects tampering and short input', () => {
    const sealed = seal(key, 'access-token', 'ctx');
    sealed[14] = sealed[14]! ^ 0xff;
    expect(open(key, sealed, 'ctx')).toBeNull();
    expect(open(key, Buffer.alloc(10), 'ctx')).toBeNull();
  });

  it('makes random tokens, hashes and compares in constant time', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
    expect(sha256('abc').toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('same', 'diff')).toBe(false);
    expect(safeEqual('short', 'longer value')).toBe(false);
  });
});

describe('return path after sign-in', () => {
  it('allows only same-origin app paths', () => {
    expect(safeReturnTo('/properties?q=osu')).toBe('/properties?q=osu');
    for (const bad of [null, undefined, '', 'https://evil.test', '//evil.test', '/\\evil.test', '/auth/logout', '/bff/me', `/${'a'.repeat(2001)}`]) {
      expect(safeReturnTo(bad)).toBe('/');
    }
  });
});
