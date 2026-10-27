import { pino } from 'pino';

import { loadConfig } from '../config/config.js';
import { createWorker } from './create-worker.js';

/**
 * Worker process: `node dist/worker/main.js`. Same configuration as the API
 * plus PLATFORM_DATABASE_URL and CLAMAV_HOST. Stops cleanly on SIGTERM/SIGINT
 * after the job in progress.
 */
const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: 'estatepro-worker' } });
const { worker, close } = createWorker(config, {
  info: (message, fields) => log.info(fields ?? {}, message),
  warn: (message, fields) => log.warn(fields ?? {}, message),
  error: (message, fields) => log.error(fields ?? {}, message),
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'stopping');
    worker.stop();
  });
}

await worker.start();
await close();
