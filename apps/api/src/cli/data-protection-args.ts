/**
 * Arguments of the data-protection command (ADR-007 E5–E6, runbook
 * docs/runbooks/DATA-PROTECTION-RUNBOOK.md). Kept apart from the command so
 * the parsing rules are unit-tested.
 */
export type DataProtectionCommand =
  | { command: 'rotate-key'; companyId: string; purpose: 'field' | 'lookup'; trigger: 'compromise' | 'request'; reason: string; by: string }
  | { command: 'rotation-status'; companyId: string }
  | { command: 'erase-contact'; companyId: string; contactId: string; reference: string; by: string }
  | { command: 'shred-company'; companyId: string; confirm: string; reference: string; by: string }
  | { command: 'replay-ledger'; dryRun: boolean };

export const USAGE = `Usage: pnpm --filter @estatepro/api data-protection <command> [options]

  rotate-key       --company <uuid> --purpose field|lookup --trigger compromise|request --reason "<text>" --by "<operator>"
  rotation-status  --company <uuid>
  erase-contact    --company <uuid> --contact <uuid> --reference <ticket> --by "<operator>"
  shred-company    --company <uuid> --confirm <company-slug> --reference <ticket> --by "<operator>"
  replay-ledger    [--dry-run]

Environment: DATABASE_URL (runtime role), PLATFORM_DATABASE_URL (platform role),
KEY_PROVIDER and its settings (rotate-key), STORAGE_* and ERASURE_LEDGER_BUCKET
(erase-contact, shred-company, replay-ledger).`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLAGS = new Set(['dry-run']);

export function parseDataProtectionArgs(argv: readonly string[]): DataProtectionCommand {
  const [command, ...rest] = argv;
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument "${token}".`);
    const name = token.slice(2);
    if (FLAGS.has(name)) {
      options.set(name, 'true');
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
    if (options.has(name)) throw new Error(`--${name} is given twice.`);
    options.set(name, value);
    i += 1;
  }
  const take = (allowed: readonly string[]): void => {
    for (const key of options.keys()) if (!allowed.includes(key)) throw new Error(`--${key} is not an option of ${command}.`);
  };
  const required = (name: string): string => {
    const value = options.get(name)?.trim();
    if (!value) throw new Error(`--${name} is required.`);
    return value;
  };
  const uuid = (name: string): string => {
    const value = required(name);
    if (!UUID.test(value)) throw new Error(`--${name} must be a UUID.`);
    return value.toLowerCase();
  };
  const oneOf = <T extends string>(name: string, values: readonly T[]): T => {
    const value = required(name);
    if (!values.includes(value as T)) throw new Error(`--${name} must be one of: ${values.join(', ')}.`);
    return value as T;
  };

  switch (command) {
    case 'rotate-key':
      take(['company', 'purpose', 'trigger', 'reason', 'by']);
      return {
        command,
        companyId: uuid('company'),
        purpose: oneOf('purpose', ['field', 'lookup'] as const),
        trigger: oneOf('trigger', ['compromise', 'request'] as const),
        reason: required('reason'),
        by: required('by'),
      };
    case 'rotation-status':
      take(['company']);
      return { command, companyId: uuid('company') };
    case 'erase-contact':
      take(['company', 'contact', 'reference', 'by']);
      return { command, companyId: uuid('company'), contactId: uuid('contact'), reference: required('reference'), by: required('by') };
    case 'shred-company':
      take(['company', 'confirm', 'reference', 'by']);
      return { command, companyId: uuid('company'), confirm: required('confirm'), reference: required('reference'), by: required('by') };
    case 'replay-ledger':
      take(['dry-run']);
      return { command, dryRun: options.get('dry-run') === 'true' };
    case undefined:
      throw new Error('Give a command.');
    default:
      throw new Error(`Unknown command "${command}".`);
  }
}
