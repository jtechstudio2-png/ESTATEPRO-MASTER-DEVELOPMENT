-- =============================================================================
-- EstatePro · Migration 0020 · Web sessions (Phase 4 M6, decision W-D9)
-- =============================================================================
-- The staff web app is a backend-for-frontend: it completes the OIDC code flow
-- on the server and keeps the identity provider's tokens here. The browser only
-- holds a random session id in an HttpOnly cookie; this table stores its
-- SHA-256 hash, never the id itself. Tokens are encrypted by the web app
-- (AES-256-GCM, WEB_SESSION_KEY) before they reach the database.
--
-- Platform-level table: no company data, no RLS. Only the web app's own role
-- (estatepro_web) may read or write it; the API roles have no access.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'estatepro_web') THEN
    CREATE ROLE estatepro_web NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

CREATE TABLE web_sessions (
  id_hash              bytea        PRIMARY KEY CHECK (octet_length(id_hash) = 32),
  subject              text         NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  token_ciphertext     bytea        NOT NULL,
  access_expires_at    timestamptz  NOT NULL,
  csrf_token           text         NOT NULL CHECK (char_length(csrf_token) >= 32),
  selected_company_id  uuid         REFERENCES companies (id) ON DELETE SET NULL,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  last_seen_at         timestamptz  NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz  NOT NULL,
  expires_at           timestamptz  NOT NULL,
  CHECK (idle_expires_at <= expires_at)
);
CREATE INDEX web_sessions_expires_idx ON web_sessions (expires_at);
CREATE INDEX web_sessions_subject_idx ON web_sessions (subject);

COMMENT ON TABLE web_sessions IS 'Server-side sessions of the staff web app (W-D9). id_hash = SHA-256 of the cookie value.';

REVOKE ALL ON web_sessions FROM PUBLIC;
REVOKE ALL ON web_sessions FROM estatepro_app, estatepro_auth, estatepro_platform;
GRANT USAGE ON SCHEMA public TO estatepro_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON web_sessions TO estatepro_web;
