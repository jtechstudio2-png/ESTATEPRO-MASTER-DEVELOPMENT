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
