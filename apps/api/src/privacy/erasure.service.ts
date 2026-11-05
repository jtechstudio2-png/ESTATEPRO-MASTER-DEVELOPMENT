import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { systemContext } from '../common/request-context.js';
import type { Db, TenantDb, Tx } from '../database/database.module.js';
import { type ErasureLedger, type LedgerEntry, REQUEST_REFERENCE } from './erasure-ledger.js';

/** Why an erasure was refused; codes are stable for callers. */
export class ErasureError extends Error {
  constructor(
    readonly code: 'not_found' | 'merged' | 'blocked' | 'invalid_request' | 'company_not_closed',
    message: string,
    readonly blockers: string[] = [],
  ) {
    super(message);
    this.name = 'ErasureError';
  }
}

export interface ErasureRequest {
  /** Ticket or case number of the verified request (never the person's name). */
  requestReference: string;
  /** The operator carrying it out. */
  requestedBy: string;
}

export interface ContactErasureResult {
  alreadyErased: boolean;
  erasedContactIds: string[];
  /** Rows changed per table; no personal data. */
  counts: Record<string, number>;
  ledgerKey: string | null;
}

export interface ReplaySummary {
  entries: number;
  contactsErased: number;
  contactsAlreadyErased: number;
  contactsMissing: number;
  keysDestroyed: number;
  failures: { entryId: string; detail: string }[];
}

/**
 * Erasure and crypto-shredding (ADR-007 §8, stage E6).
 *
 * - `eraseContact` anonymises a person in one tenant transaction
 *   (app.erase_contact) and writes the ledger entry before it commits: an
 *   erasure is never committed without its ledger entry.
 * - `shredCompany` destroys every data key of a closed company, which makes
 *   all its protected values unreadable everywhere, backups included once the
 *   root key can no longer unwrap the copies they hold.
 * - `replay` re-applies the ledger after a restore (runbook §3).
 */
export class ErasureService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly platformDb: Db,
    private readonly ledger: ErasureLedger,
    private readonly audit: AuditService = new AuditService(),
  ) {}

  async eraseContact(companyId: string, contactId: string, request: ErasureRequest): Promise<ContactErasureResult> {
    validateRequest(request);
    return this.tenantDb.run({ companyId, userId: '' }, async (tx) => {
      const outcome = await this.eraseInTransaction(tx, companyId, contactId);
      if (outcome.alreadyErased) return { ...outcome, ledgerKey: null };
      const entry: LedgerEntry = {
        type: 'contact_erasure',
        id: randomUUID(),
        at: new Date().toISOString(),
        companyId,
        contactIds: outcome.erasedContactIds,
        requestReference: request.requestReference,
        requestedBy: request.requestedBy,
      };
      await this.audit.record(tx, systemContext(companyId, `erasure:${entry.id}`), {
        action: 'contact.erased',
        entityType: 'contact',
        entityId: contactId,
        metadata: { ledgerEntryId: entry.id, requestReference: request.requestReference, requestedBy: request.requestedBy, counts: outcome.counts, erasedContactIds: outcome.erasedContactIds },
      });
      // Written before the commit: if the ledger is unreachable, nothing is erased and the operator retries.
      const ledgerKey = await this.ledger.append(entry);
      return { ...outcome, ledgerKey };
    });
  }

  private async eraseInTransaction(tx: Tx, companyId: string, contactId: string): Promise<Omit<ContactErasureResult, 'ledgerKey'>> {
    const contact = await tx.selectFrom('contacts').select(['id', 'isAnonymised', 'mergedIntoContactId']).where('id', '=', contactId).executeTakeFirst();
    if (!contact) throw new ErasureError('not_found', `Contact ${contactId} does not exist in company ${companyId}.`);
    if (contact.isAnonymised) return { alreadyErased: true, erasedContactIds: [], counts: {} };
    if (contact.mergedIntoContactId !== null) {
      throw new ErasureError('merged', `Contact ${contactId} was merged into ${contact.mergedIntoContactId}; erase that contact (its merged records are erased with it).`);
    }
    const { rows } = await sql<{ blockers: string[] }>`select app.contact_erasure_blockers(${contactId}::uuid) as blockers`.execute(tx);
    const blockers = rows[0]?.blockers ?? [];
    if (blockers.length > 0) {
      throw new ErasureError('blocked', `Contact ${contactId} cannot be erased: ${blockers.join(', ')}. Records the law requires us to keep, or not a person.`, blockers);
    }
    const result = await sql<{ result: Record<string, unknown> }>`select app.erase_contact(${contactId}::uuid) as result`.execute(tx);
    const { erasedContactIds, alreadyErased, ...counts } = result.rows[0]?.result ?? {};
    return {
      alreadyErased: alreadyErased === true,
      erasedContactIds: Array.isArray(erasedContactIds) ? (erasedContactIds as string[]) : [],
      counts: Object.fromEntries(Object.entries(counts).map(([table, n]) => [table, Number(n)])),
    };
  }

  /**
   * Destroys every key of a cancelled company (crypto-shredding). The company
   * slug must be given again as confirmation. Irreversible.
   */
  async shredCompany(companyId: string, confirmSlug: string, request: ErasureRequest): Promise<{ keysDestroyed: number; ledgerKey: string }> {
    validateRequest(request);
    return this.platformDb.transaction().execute(async (tx) => {
      const company = await tx.selectFrom('companies').select(['slug', 'status']).where('id', '=', companyId).forUpdate().executeTakeFirst();
      if (!company) throw new ErasureError('not_found', `Company ${companyId} does not exist.`);
      if (company.slug !== confirmSlug) throw new ErasureError('invalid_request', 'The confirmation does not match the company slug.');
      if (company.status !== 'cancelled') {
        throw new ErasureError('company_not_closed', `Company ${company.slug} is ${company.status}; only a cancelled company's keys are destroyed.`);
      }
      const keys = await destroyKeys(tx, companyId);
      const entry: LedgerEntry = {
        type: 'company_shred',
        id: randomUUID(),
        at: new Date().toISOString(),
        companyId,
        keys,
        requestReference: request.requestReference,
        requestedBy: request.requestedBy,
      };
      await this.audit.record(tx, systemContext(companyId, `shred:${entry.id}`), {
        action: 'company.keys_destroyed',
        entityType: 'company',
        entityId: companyId,
        metadata: { ledgerEntryId: entry.id, requestReference: request.requestReference, requestedBy: request.requestedBy, keys },
      });
      const ledgerKey = await this.ledger.append(entry);
      return { keysDestroyed: keys.length, ledgerKey };
    });
  }

  /**
   * Re-applies every ledger entry (after a restore, before serving traffic).
   * Idempotent; a contact missing from the restored database is counted, not
   * an error. `dryRun` reports without changing anything.
   */
  async replay(options: { dryRun?: boolean } = {}): Promise<ReplaySummary> {
    const summary: ReplaySummary = { entries: 0, contactsErased: 0, contactsAlreadyErased: 0, contactsMissing: 0, keysDestroyed: 0, failures: [] };
    for (const entry of await this.ledger.entries()) {
      summary.entries += 1;
      try {
        if (entry.type === 'company_shred') {
          summary.keysDestroyed += await this.platformDb.transaction().execute(async (tx) => {
            const remaining = await tx.selectFrom('companyDataKeys').select('version').where('companyId', '=', entry.companyId).where('status', '<>', 'destroyed').execute();
            if (options.dryRun || remaining.length === 0) return remaining.length;
            return (await destroyKeys(tx, entry.companyId)).length;
          });
          continue;
        }
        for (const contactId of entry.contactIds) {
          const outcome = await this.tenantDb.run({ companyId: entry.companyId, userId: '' }, async (tx) => {
            const contact = await tx.selectFrom('contacts').select(['isAnonymised', 'mergedIntoContactId']).where('id', '=', contactId).executeTakeFirst();
            if (!contact) return 'missing' as const;
            if (contact.isAnonymised) return 'already' as const;
            // Records merged into another are erased with the contact they were merged into.
            if (contact.mergedIntoContactId !== null && entry.contactIds.includes(contact.mergedIntoContactId)) return 'with-root' as const;
            if (options.dryRun) return 'erased' as const;
            const result = await this.eraseInTransaction(tx, entry.companyId, contactId);
            await this.audit.record(tx, systemContext(entry.companyId, `replay:${entry.id}`), {
              action: 'contact.erasure_replayed',
              entityType: 'contact',
              entityId: contactId,
              metadata: { ledgerEntryId: entry.id, counts: result.counts },
            });
            return 'erased' as const;
          });
          if (outcome === 'missing') summary.contactsMissing += 1;
          else if (outcome === 'already') summary.contactsAlreadyErased += 1;
          else if (outcome === 'erased') summary.contactsErased += 1;
        }
      } catch (error) {
        summary.failures.push({ entryId: entry.id, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return summary;
  }
}

async function destroyKeys(tx: Tx, companyId: string): Promise<{ purpose: 'field' | 'lookup'; version: number }[]> {
  const destroyed = await tx
    .updateTable('companyDataKeys')
    .set({ status: 'destroyed', wrappedKey: null, destroyedAt: sql`now()`, retiredAt: sql`coalesce(retired_at, now())` })
    .where('companyId', '=', companyId)
    .where('status', '<>', 'destroyed')
    .returning(['purpose', 'version'])
    .execute();
  return destroyed.map((row) => ({ purpose: row.purpose as 'field' | 'lookup', version: row.version })).sort((a, b) => a.purpose.localeCompare(b.purpose) || a.version - b.version);
}

function validateRequest(request: ErasureRequest): void {
  if (!REQUEST_REFERENCE.test(request.requestReference)) {
    throw new ErasureError('invalid_request', 'The request reference must be a ticket or case number (letters, digits, . _ / -; up to 64 characters).');
  }
  if (request.requestedBy.trim().length === 0 || request.requestedBy.length > 200) throw new ErasureError('invalid_request', 'Say who carries out the erasure.');
}
