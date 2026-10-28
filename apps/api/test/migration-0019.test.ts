import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Upgrading an existing database to migration 0019 (ADR-006): data written
 * before M5 must survive. Builds a database at 0018, adds pre-M5 rows using
 * the database test fixtures, then applies 0019.
 */
const DATABASE = 'estatepro_upgrade_0019_test';
const ROOT = join(import.meta.dirname, '..', '..', '..', 'database');
const PROPERTY = 'a7000000-0000-0000-0000-000000000001';
const ADDRESS = 'a2000000-0000-0000-0000-000000000001';

/** psql meta-commands (\set, \echo) are not SQL. */
const sqlOf = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('\\'))
    .join('\n');

describe('migration 0019 on existing data', () => {
  let db: pg.Client;

  beforeAll(async () => {
    const serverUrl = new URL(inject('databaseUrls').admin);
    const server = new pg.Client({ connectionString: serverUrl.toString() });
    await server.connect();
    await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${DATABASE}`);
    await server.end();

    serverUrl.pathname = `/${DATABASE}`;
    db = new pg.Client({ connectionString: serverUrl.toString() });
    await db.connect();
    const migrations = readdirSync(join(ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort();
    for (const file of migrations.filter((name) => name < '0019')) await db.query(sqlOf(join(ROOT, 'migrations', file)));
    await db.query(sqlOf(join(ROOT, 'tests', '00_fixtures.sql')));

    // Pre-M5 data: free-text internal notes and coordinates without provenance.
    await db.query(`UPDATE properties SET internal_notes = '  Alarm panel is behind the kitchen door.  ' WHERE id = $1`, [PROPERTY]);
    await db.query(`UPDATE properties SET internal_notes = '   ' WHERE id <> $1`, [PROPERTY]);
    await db.query(`UPDATE addresses SET latitude = 5.556, longitude = -0.1969 WHERE id = $1`, [ADDRESS]);

    await db.query(sqlOf(join(ROOT, 'migrations', '0019_location_notes_keys.sql')));
  }, 120_000);

  afterAll(async () => {
    await db.end();
    const server = new pg.Client({ connectionString: inject('databaseUrls').admin });
    await server.connect();
    await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server.end();
  });

  it('moves internal notes into pinned internal notes and empties the old column (L-D9)', async () => {
    const notes = await db.query(
      `SELECT property_id, body, visibility, is_pinned, pinned_at IS NOT NULL AS has_pin_time, source, category FROM property_notes`,
    );
    expect(notes.rows).toEqual([
      {
        property_id: PROPERTY,
        body: 'Alarm panel is behind the kitchen door.',
        visibility: 'internal',
        is_pinned: true,
        has_pin_time: true,
        source: 'migrated',
        category: 'general',
      },
    ]);
    const leftover = await db.query(`SELECT count(*)::int AS n FROM properties WHERE internal_notes IS NOT NULL`);
    expect(leftover.rows[0].n).toBe(0);
    const comment = await db.query(`SELECT col_description('properties'::regclass, attnum) AS text FROM pg_attribute
      WHERE attrelid = 'properties'::regclass AND attname = 'internal_notes'`);
    expect(comment.rows[0].text).toMatch(/Deprecated/);
  });

  it('records existing coordinates as typed in by a person and calculates their spatial point (L-D1, L-D2)', async () => {
    const address = await db.query(
      `SELECT geocode_source, geocoded_at IS NOT NULL AS confirmed, round(ST_Y(location::geometry)::numeric, 4) AS lat
         FROM addresses WHERE id = $1`,
      [ADDRESS],
    );
    expect(address.rows[0]).toEqual({ geocode_source: 'manual_pin', confirmed: true, lat: '5.5560' });
    const unmapped = await db.query(`SELECT count(*)::int AS n FROM addresses WHERE latitude IS NULL AND (geocode_source IS NOT NULL OR location IS NOT NULL)`);
    expect(unmapped.rows[0].n).toBe(0);
  });
});
