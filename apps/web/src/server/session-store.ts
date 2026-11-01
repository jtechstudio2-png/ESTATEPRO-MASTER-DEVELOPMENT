import 'server-only';

import type pg from 'pg';

import { open, seal, sha256 } from './crypto';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
}

export interface StoredSession {
  idHash: Buffer;
  subject: string;
  tokens: SessionTokens;
  accessExpiresAt: Date;
  csrfToken: string;
  companyId: string | null;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  expiresAt: Date;
}

interface SessionRow {
  id_hash: Buffer;
  subject: string;
  token_ciphertext: Buffer;
  access_expires_at: Date;
  csrf_token: string;
  selected_company_id: string | null;
  last_seen_at: Date;
  idle_expires_at: Date;
  expires_at: Date;
}

/** Re-extend the idle timeout at most once a minute per session. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Server-side sessions (migration 0020, W-D9). The table holds the SHA-256 of
 * the session id and the tokens sealed with AES-256-GCM, bound to that hash so
 * a sealed blob cannot be moved to another session.
 */
export class SessionStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly key: Buffer,
    private readonly idleMinutes: number,
    private readonly absoluteHours: number,
  ) {}

  async create(sessionId: string, subject: string, tokens: SessionTokens, accessExpiresAt: Date, csrfToken: string, now = new Date()): Promise<void> {
    const idHash = sha256(sessionId);
    const expiresAt = new Date(now.getTime() + this.absoluteHours * 3_600_000);
    const idle = new Date(Math.min(now.getTime() + this.idleMinutes * 60_000, expiresAt.getTime()));
    await this.pool.query('DELETE FROM web_sessions WHERE expires_at < $1 OR idle_expires_at < $1', [now]);
    await this.pool.query(
      `INSERT INTO web_sessions (id_hash, subject, token_ciphertext, access_expires_at, csrf_token, created_at, last_seen_at, idle_expires_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
      [idHash, subject, this.sealTokens(idHash, tokens), accessExpiresAt, csrfToken, now, idle, expiresAt],
    );
  }

  /** The live session for a cookie value, or null (unknown, expired or undecryptable). */
  async find(sessionId: string, now = new Date()): Promise<StoredSession | null> {
    const idHash = sha256(sessionId);
    const { rows } = await this.pool.query<SessionRow>('SELECT * FROM web_sessions WHERE id_hash = $1', [idHash]);
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at <= now || row.idle_expires_at <= now) {
      await this.pool.query('DELETE FROM web_sessions WHERE id_hash = $1', [idHash]);
      return null;
    }
    const session = this.toSession(row);
    if (session === null) return null;
    if (now.getTime() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
      const idle = new Date(Math.min(now.getTime() + this.idleMinutes * 60_000, row.expires_at.getTime()));
      await this.pool.query('UPDATE web_sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id_hash = $1', [idHash, now, idle]);
      session.lastSeenAt = now;
      session.idleExpiresAt = idle;
    }
    return session;
  }

  async selectCompany(sessionId: string, companyId: string | null): Promise<void> {
    await this.pool.query('UPDATE web_sessions SET selected_company_id = $2 WHERE id_hash = $1', [sha256(sessionId), companyId]);
  }

  /**
   * Replaces the tokens under a row lock: `refresh` runs only if the stored
   * access token still expires before `staleBefore`, so concurrent requests
   * refresh once (rotating refresh tokens are single-use).
   */
  async refreshTokens(
    sessionId: string,
    staleBefore: Date,
    refresh: (current: SessionTokens) => Promise<{ tokens: SessionTokens; accessExpiresAt: Date }>,
  ): Promise<StoredSession | null> {
    const idHash = sha256(sessionId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<SessionRow>('SELECT * FROM web_sessions WHERE id_hash = $1 FOR UPDATE', [idHash]);
      const row = rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      let session = this.toSession(row);
      if (session === null) {
        await client.query('ROLLBACK');
        return null;
      }
      if (row.access_expires_at < staleBefore) {
        const next = await refresh(session.tokens);
        await client.query('UPDATE web_sessions SET token_ciphertext = $2, access_expires_at = $3 WHERE id_hash = $1', [
          idHash,
          this.sealTokens(idHash, next.tokens),
          next.accessExpiresAt,
        ]);
        session = { ...session, tokens: next.tokens, accessExpiresAt: next.accessExpiresAt };
      }
      await client.query('COMMIT');
      return session;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async destroy(sessionId: string): Promise<void> {
    await this.pool.query('DELETE FROM web_sessions WHERE id_hash = $1', [sha256(sessionId)]);
  }

  private sealTokens(idHash: Buffer, tokens: SessionTokens): Buffer {
    return seal(this.key, JSON.stringify(tokens), idHash.toString('hex'));
  }

  private toSession(row: SessionRow): StoredSession | null {
    const plain = open(this.key, row.token_ciphertext, row.id_hash.toString('hex'));
    if (plain === null) return null;
    return {
      idHash: row.id_hash,
      subject: row.subject,
      tokens: JSON.parse(plain) as SessionTokens,
      accessExpiresAt: row.access_expires_at,
      csrfToken: row.csrf_token,
      companyId: row.selected_company_id,
      lastSeenAt: row.last_seen_at,
      idleExpiresAt: row.idle_expires_at,
      expiresAt: row.expires_at,
    };
  }
}
