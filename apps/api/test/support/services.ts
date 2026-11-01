import { inject } from 'vitest';

/**
 * Root key for the local key provider in tests (ADR-007). Fixed so that every
 * test app in a run unwraps the same company keys. Never used outside tests.
 */
export const TEST_FIELD_ENCRYPTION_ROOT_KEY = Buffer.alloc(32, 7).toString('base64');

/** Storage, scanner, platform-database and key-provider settings for tests (see global-setup). */
export function testServiceEnv(): Record<string, string> {
  const services = inject('testServices');
  return {
    STORAGE_ENDPOINT: services.storageEndpoint,
    STORAGE_REGION: 'us-east-1',
    STORAGE_BUCKET: services.storageBucket,
    STORAGE_ACCESS_KEY_ID: services.storageAccessKeyId,
    STORAGE_SECRET_ACCESS_KEY: services.storageSecretAccessKey,
    STORAGE_FORCE_PATH_STYLE: 'true',
    CLAMAV_HOST: services.clamavHost,
    CLAMAV_PORT: String(services.clamavPort),
    PLATFORM_DATABASE_URL: inject('databaseUrls').platform,
    KEY_PROVIDER: 'local',
    FIELD_ENCRYPTION_LOCAL_ROOT_KEY: TEST_FIELD_ENCRYPTION_ROOT_KEY,
  };
}
