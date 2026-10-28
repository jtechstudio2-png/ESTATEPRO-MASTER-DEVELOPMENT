import 'server-only';

import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Public origin of the web app, e.g. https://app.estatepro.example (no trailing slash). */
    WEB_ORIGIN: z.url().transform((value) => value.replace(/\/$/, '')),
    /** The EstatePro API, reached server-side only. */
    API_BASE_URL: z.url().transform((value) => value.replace(/\/$/, '')),
    /** Session store: the estatepro_web role (migration 0020). */
    WEB_DATABASE_URL: z.url(),
    /** 32 random bytes, base64: encrypts tokens at rest (AES-256-GCM). */
    WEB_SESSION_KEY: z.string().refine((value) => Buffer.from(value, 'base64').length === 32, 'Must be 32 bytes, base64-encoded.'),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(120),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
    OIDC_ISSUER: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    /** Omit for a public client (PKCE only). */
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_SCOPES: z.string().default('openid profile email offline_access'),
    /** Some providers need the API audience in the authorisation request. */
    OIDC_AUDIENCE: z.string().min(1).optional(),
    /** Allow an http:// issuer (local development and tests only). */
    OIDC_ALLOW_INSECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    /** Self-hosted vector tiles (ADR-006 L-D3): a PMTiles URL, plus glyphs; empty = plain background map. */
    MAP_TILES_URL: z.string().default(''),
    MAP_GLYPHS_URL: z.string().default(''),
  })
  .superRefine((env, issues) => {
    if (env.NODE_ENV === 'production' && env.OIDC_ALLOW_INSECURE) {
      issues.addIssue({ code: 'custom', path: ['OIDC_ALLOW_INSECURE'], message: 'Not allowed in production.' });
    }
    if (env.NODE_ENV === 'production' && !env.WEB_ORIGIN.startsWith('https://')) {
      issues.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'Must be https in production.' });
    }
  });

export type WebEnv = z.infer<typeof schema>;

let cached: WebEnv | null = null;

export function loadEnv(source: Record<string, string | undefined> = process.env): WebEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid web configuration:\n  ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ')}`);
  }
  return result.data;
}

export function env(): WebEnv {
  cached ??= loadEnv();
  return cached;
}
