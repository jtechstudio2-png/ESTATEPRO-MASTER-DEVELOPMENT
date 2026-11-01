import { inject } from 'vitest';

/** Storage, scanner and platform-database settings for tests (see global-setup). */
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
  };
}
