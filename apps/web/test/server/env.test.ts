// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { loadEnv } from '@/server/env';

const base = {
  WEB_ORIGIN: 'https://app.estatepro.test/',
  API_BASE_URL: 'https://api.estatepro.test/',
  WEB_DATABASE_URL: 'postgres://web@db/estatepro',
  WEB_SESSION_KEY: Buffer.alloc(32, 1).toString('base64'),
  OIDC_ISSUER: 'https://id.estatepro.test',
  OIDC_CLIENT_ID: 'estatepro-web',
};

describe('web configuration', () => {
  it('applies defaults and trims trailing slashes', () => {
    const env = loadEnv(base);
    expect(env.WEB_ORIGIN).toBe('https://app.estatepro.test');
    expect(env.API_BASE_URL).toBe('https://api.estatepro.test');
    expect(env.SESSION_IDLE_MINUTES).toBe(120);
    expect(env.OIDC_ALLOW_INSECURE).toBe(false);
    expect(env.MAP_TILES_URL).toBe('');
  });

  it('rejects a session key that is not 32 bytes', () => {
    expect(() => loadEnv({ ...base, WEB_SESSION_KEY: 'c2hvcnQ=' })).toThrow(/WEB_SESSION_KEY: Must be 32 bytes/);
  });

  it('in production, allows plain http only on this machine', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', WEB_ORIGIN: 'http://app.estatepro.test' })).toThrow(/WEB_ORIGIN: Must be https/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', OIDC_ISSUER: 'http://id.estatepro.test', OIDC_ALLOW_INSECURE: 'true' })).toThrow(/OIDC_ALLOW_INSECURE/);
    const local = loadEnv({ ...base, NODE_ENV: 'production', WEB_ORIGIN: 'http://127.0.0.1:3100', OIDC_ISSUER: 'http://localhost:3202', OIDC_ALLOW_INSECURE: 'true' });
    expect(local.OIDC_ALLOW_INSECURE).toBe(true);
  });
});
