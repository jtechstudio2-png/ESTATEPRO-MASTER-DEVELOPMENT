import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const commaList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Number of reverse proxies in front of the API (for the client IP in audit logs). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  /** Connection for request handling. The role must be estatepro_app (subject to RLS). */
  DATABASE_URL: z.url(),
  /** Connection for identity resolution. The role must be estatepro_auth. */
  AUTH_DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),

  /** OIDC issuer exactly as it appears in the `iss` claim. */
  OIDC_ISSUER: z.string().min(1),
  /** Expected `aud` value of access tokens issued for the EstatePro API. */
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_JWKS_URL: z.url(),
  /** Stored in external_identities.provider for identities from this IdP. */
  OIDC_PROVIDER: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** `amr` values accepted as proof of multi-factor authentication. */
  OIDC_MFA_AMR_VALUES: commaList.default(['mfa', 'otp', 'hwk', 'swk', 'fido']),
  /** Maximum age of `auth_time` for permissions flagged as sensitive (step-up). */
  STEP_UP_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),

  /**
   * Object storage (ADR-005 M-D1): any S3-compatible service. Cloudflare R2:
   * https://<account>.r2.cloudflarestorage.com with region "auto"; AWS S3:
   * leave STORAGE_ENDPOINT unset and give the bucket's region.
   */
  STORAGE_ENDPOINT: z.url().optional(),
  STORAGE_REGION: z.string().min(1).default('auto'),
  STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  /** Path-style addressing (needed by some S3-compatible services, e.g. SeaweedFS). */
  STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  /** Lifetime of signed upload (PUT) and download (GET) URLs. */
  MEDIA_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(300),
  MEDIA_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),

  /** Malware scanner (clamd). Required by the worker; the API never scans. */
  CLAMAV_HOST: z.string().min(1).optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  /** Connection with the estatepro_platform role (BYPASSRLS): worker queue claims and discovery only. */
  PLATFORM_DATABASE_URL: z.url().optional(),

  /**
   * Address suggestions (ADR-006 L-D2). Suggestions only: a user confirms every
   * stored location. "none" disables the suggestions endpoint; pins still work.
   */
  GEOCODER_PROVIDER: z.enum(['none', 'mapbox']).default('none'),
  /** Mapbox token with permanent geocoding enabled (results may be stored). */
  MAPBOX_ACCESS_TOKEN: z.string().min(1).optional(),
  MAPBOX_API_URL: z.url().default('https://api.mapbox.com'),
  GEOCODER_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  /** Per company, per API instance. */
  GEOCODER_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
  /** Map endpoints, per member, per API instance. */
  MAP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(240),
  /** Upper bound for one location search query (statement_timeout). */
  SEARCH_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),

  /**
   * Field encryption key provider (ADR-007 E-D6). "none": protected fields can
   * be neither written nor revealed (fail closed). "local": root key from
   * FIELD_ENCRYPTION_LOCAL_ROOT_KEY, for development and tests only; refused
   * when NODE_ENV=production. A cloud KMS adapter is added with issue #28.
   */
  KEY_PROVIDER: z.enum(['none', 'local']).default('none'),
  /** 32 random bytes, base64. Development and tests only. */
  FIELD_ENCRYPTION_LOCAL_ROOT_KEY: z.string().optional(),
  /** How long an unwrapped company key stays in memory (ADR-007 §4.5: at most 5 minutes). */
  FIELD_KEY_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(300).default(300),
  FIELD_KEY_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(100_000).default(1_000),
  /** Step-up freshness for revealing a protected value (ADR-007 §9: 5 minutes). */
  REVEAL_STEP_UP_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
}).superRefine((config, issues) => {
  if (config.KEY_PROVIDER === 'local') {
    if (config.NODE_ENV === 'production') {
      issues.addIssue({ code: 'custom', path: ['KEY_PROVIDER'], message: 'The local key provider is for development and tests only. Configure a KMS provider.' });
    }
    const key = config.FIELD_ENCRYPTION_LOCAL_ROOT_KEY;
    if (key === undefined || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32) {
      issues.addIssue({ code: 'custom', path: ['FIELD_ENCRYPTION_LOCAL_ROOT_KEY'], message: 'Required with KEY_PROVIDER=local: 32 random bytes, base64.' });
    }
  }
  if (config.GEOCODER_PROVIDER === 'mapbox' && config.MAPBOX_ACCESS_TOKEN === undefined) {
    issues.addIssue({ code: 'custom', path: ['MAPBOX_ACCESS_TOKEN'], message: 'Required when GEOCODER_PROVIDER is mapbox.' });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
