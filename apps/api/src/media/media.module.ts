import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency.service.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { S3Storage, STORAGE } from './storage.js';

@Injectable()
class StorageLifecycle implements OnModuleDestroy {
  constructor(@Inject(STORAGE) private readonly storage: S3Storage) {}

  onModuleDestroy(): void {
    this.storage.destroy();
  }
}

@Module({
  controllers: [MediaController],
  providers: [
    MediaService,
    IdempotencyService,
    StorageLifecycle,
    { provide: STORAGE, inject: [APP_CONFIG], useFactory: (config: AppConfig) => S3Storage.fromConfig(config) },
  ],
  exports: [MediaService, STORAGE],
})
export class MediaModule {}
