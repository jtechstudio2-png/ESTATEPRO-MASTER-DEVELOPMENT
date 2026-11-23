import { sql } from 'kysely';

import type { Db } from '../../src/database/database.module.js';

/**
 * Lets the database settle after a bulk seed, before requests are measured:
 * a checkpoint, then up to three minutes for running autovacuum workers to
 * finish. Performance files that write about a million rows otherwise leave
 * disk work that lands on the next file's measurements (L4 report §3).
 */
export async function settleDatabase(admin: Db): Promise<void> {
  await sql`checkpoint`.execute(admin);
  for (let waited = 0; waited < 180; waited += 2) {
    const busy = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where backend_type = 'autovacuum worker'`.execute(admin);
    if (busy.rows[0]!.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** The tables a large performance seed fills, cleared first to last (children before parents). */
const BULK_TABLES = [
  'payment_allocations', 'rent_charge_adjustments', 'payments', 'rent_charges', 'rent_reviews', 'arrears_actions', 'payment_plans',
  'inspection_item_documents', 'inspection_items', 'inspections', 'deposit_deductions', 'deposits', 'tasks', 'audit_logs', 'outbox_events',
] as const;

/**
 * Removes a large performance file's bulk money and inspection rows when it
 * finishes, so the next file measures the single-company volume it states
 * rather than its own plus every earlier file's (L4 report §3 finding 7). Row
 * triggers are off (session_replication_role): the rows are test data of one
 * company and the append-only rules are covered by the SQL suites.
 */
export async function dropCompanyBulk(admin: Db, companyId: string): Promise<void> {
  await admin.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    for (const table of BULK_TABLES) await sql`delete from ${sql.table(table)} where company_id = ${companyId}::uuid`.execute(tx);
  });
  await sql`vacuum analyze ${sql.join(BULK_TABLES.map((table) => sql.table(table)))}`.execute(admin);
  await settleDatabase(admin);
}
