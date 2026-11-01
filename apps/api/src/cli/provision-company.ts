import { createKysely } from '../database/database.module.js';
import { ProvisioningError, ProvisioningService } from '../provisioning/provisioning.service.js';
import { parseProvisionArgs, USAGE } from './provision-company-args.js';

async function main(): Promise<number> {
  const url = process.env['PLATFORM_DATABASE_URL'];
  if (!url) {
    process.stderr.write(`PLATFORM_DATABASE_URL is not set.\n\n${USAGE}\n`);
    return 2;
  }
  let input;
  try {
    input = parseProvisionArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  const db = createKysely(url, 1, 'estatepro-provision-company');
  try {
    const result = await new ProvisioningService(db).provisionCompany(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ProvisioningError) {
      process.stderr.write(`Provisioning failed: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main();
