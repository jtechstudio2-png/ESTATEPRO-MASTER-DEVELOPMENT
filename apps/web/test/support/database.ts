import type pg from 'pg';

/**
 * Drops a throwaway test database once its connections have closed. A
 * forced drop could cut a connection that is still closing and raise an
 * error outside any test.
 */
export async function dropDatabase(admin: pg.Client, database: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1', [database]);
    if (rows[0]!.count === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
}
