import { Global, Module } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { CompanyKeysService } from './company-keys.service.js';
import { DisabledKeyProvider, KEY_PROVIDER, type KeyProvider, LocalKeyProvider } from './key-provider.js';
import { SensitiveDataService } from './sensitive-data.service.js';

export function createKeyProvider(config: AppConfig): KeyProvider {
  switch (config.KEY_PROVIDER) {
    case 'local':
      // Configuration validation guarantees the key exists and is refused in production.
      return new LocalKeyProvider(config.FIELD_ENCRYPTION_LOCAL_ROOT_KEY ?? '');
    case 'none':
      return new DisabledKeyProvider();
  }
}

/** Field encryption (ADR-007): key provider, company keys and the sensitive-data service. */
@Global()
@Module({
  providers: [
    { provide: KEY_PROVIDER, inject: [APP_CONFIG], useFactory: createKeyProvider },
    CompanyKeysService,
    SensitiveDataService,
  ],
  exports: [CompanyKeysService, SensitiveDataService],
})
export class CryptoModule {}
