import { loadConfig } from '../config/config.js';
import { createKeyProvider } from '../crypto/crypto.module.js';
import { KeyRotationService, RotationError } from '../crypto/key-rotation.service.js';
import { createKysely, TenantDb } from '../database/database.module.js';
import { ErasureLedger, LedgerError } from '../privacy/erasure-ledger.js';
import { ErasureError, ErasureService } from '../privacy/erasure.service.js';
import { parseDataProtectionArgs, USAGE } from './data-protection-args.js';

/**
 * Operator command for key rotation, erasure, company shredding and ledger
 * replay (ADR-007 E5–E6). Every action is audited in the company's audit log;
 * erasures and shredding are also written to the erasure ledger.
 */
async function main(): Promise<number> {
  let input;
  try {
    input = parseDataProtectionArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  const config = loadConfig();
  if (!config.PLATFORM_DATABASE_URL) {
    process.stderr.write('PLATFORM_DATABASE_URL is not set.\n');
    return 2;
  }
  const appDb = createKysely(config.DATABASE_URL, 2, 'estatepro-data-protection');
  const platformDb = createKysely(config.PLATFORM_DATABASE_URL, 2, 'estatepro-data-protection-platform');
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  try {
    if (input.command === 'rotate-key' || input.command === 'rotation-status') {
      const rotation = new KeyRotationService(platformDb, createKeyProvider(config), config);
      try {
        if (input.command === 'rotation-status') {
          out(await rotation.open(input.companyId));
          return 0;
        }
        const started = await rotation.start({ companyId: input.companyId, purpose: input.purpose, trigger: input.trigger, reason: input.reason, requestedBy: input.by });
        // Move the values now; the worker finishes after the settle period.
        let state = started;
        while (state.status === 'rewriting') state = await rotation.step(started.id, { maxBatches: 100 });
        out(state);
        return 0;
      } finally {
        rotation.close();
      }
    }

    const ledger = ErasureLedger.fromConfig(config);
    try {
      const erasure = new ErasureService(new TenantDb(appDb), platformDb, ledger);
      switch (input.command) {
        case 'erase-contact':
          out(await erasure.eraseContact(input.companyId, input.contactId, { requestReference: input.reference, requestedBy: input.by }));
          return 0;
        case 'shred-company':
          out(await erasure.shredCompany(input.companyId, input.confirm, { requestReference: input.reference, requestedBy: input.by }));
          return 0;
        case 'replay-ledger': {
          const summary = await erasure.replay({ dryRun: input.dryRun });
          out(summary);
          return summary.failures.length === 0 ? 0 : 1;
        }
      }
    } finally {
      ledger.destroy();
    }
  } catch (error) {
    if (error instanceof RotationError || error instanceof ErasureError || error instanceof LedgerError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await Promise.all([appDb.destroy(), platformDb.destroy()]);
  }
}

process.exitCode = await main();
