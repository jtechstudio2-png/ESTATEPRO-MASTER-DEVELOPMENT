-- =============================================================================
-- EstatePro · Migration 0001 · Roles, extensions and shared helper functions
-- =============================================================================
-- Database roles
--   estatepro_owner     Owns all objects. Used only by the migration runner.
--   estatepro_app       Runtime role for the API and workers. Subject to RLS.
--   estatepro_platform  Platform console and cross-company maintenance jobs.
--                       BYPASSRLS. Never used to serve customer requests.
-- Role creation needs CREATEROLE. On managed PostgreSQL a DBA may run this block
-- separately; it is idempotent.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'estatepro_app') THEN
    CREATE ROLE estatepro_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'estatepro_platform') THEN
    CREATE ROLE estatepro_platform NOLOGIN BYPASSRLS;
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_bytes, digest
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy name search
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraints mixing = and &&

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO estatepro_app, estatepro_platform;
GRANT USAGE ON SCHEMA public TO estatepro_app, estatepro_platform;

-- -----------------------------------------------------------------------------
-- UUIDv7: time-ordered identifiers (RFC 9562). Better index locality than v4,
-- still not guessable. Replace with the built-in uuidv7() on PostgreSQL 18+.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  ts_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  b bytea := gen_random_bytes(16);
BEGIN
  b := set_byte(b, 0, ((ts_ms >> 40) & 255)::int);
  b := set_byte(b, 1, ((ts_ms >> 32) & 255)::int);
  b := set_byte(b, 2, ((ts_ms >> 24) & 255)::int);
  b := set_byte(b, 3, ((ts_ms >> 16) & 255)::int);
  b := set_byte(b, 4, ((ts_ms >> 8) & 255)::int);
  b := set_byte(b, 5, (ts_ms & 255)::int);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);   -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);   -- RFC variant
  RETURN encode(b, 'hex')::uuid;
END
$$;

-- -----------------------------------------------------------------------------
-- Request context. The API sets these with SET LOCAL inside each transaction:
--   SET LOCAL app.company_id = '<uuid>';  SET LOCAL app.user_id = '<uuid>';
-- When unset, current_company_id() is NULL and every RLS policy denies access.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_company_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- -----------------------------------------------------------------------------
-- updated_at + optimistic-lock version, attached to every table that has both
-- columns (see migration 0013).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;

-- Rejects UPDATE and DELETE. Used for append-only tables.
CREATE OR REPLACE FUNCTION app.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- Once a row reaches a posted/locked state, only the listed columns may change.
-- TG_ARGV[0]: status column, TG_ARGV[1]: comma-separated locked statuses,
-- TG_ARGV[2]: comma-separated columns that may still change.
CREATE OR REPLACE FUNCTION app.freeze_when_posted() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  status_col text := TG_ARGV[0];
  locked text[] := string_to_array(TG_ARGV[1], ',');
  mutable text[] := string_to_array(TG_ARGV[2], ',') || ARRAY['updated_at', 'version'];
  old_j jsonb := to_jsonb(OLD);
  new_j jsonb := to_jsonb(NEW);
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF old_j ->> status_col = ANY (locked) THEN
      RAISE EXCEPTION '% row % is % and cannot be deleted', TG_TABLE_NAME, OLD.id, old_j ->> status_col
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF old_j ->> status_col = ANY (locked) THEN
    FOREACH col IN ARRAY mutable LOOP
      old_j := old_j - col;
      new_j := new_j - col;
    END LOOP;
    IF old_j IS DISTINCT FROM new_j THEN
      RAISE EXCEPTION '% row % is % and cannot be edited; post a reversal instead',
        TG_TABLE_NAME, OLD.id, to_jsonb(OLD) ->> status_col
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------
-- Shared configuration tables (property types, roles, templates, …) hold
-- platform defaults (company_id IS NULL) and company-specific rows. Foreign-key
-- checks bypass RLS, so this trigger stops a company referencing another
-- company's private configuration row.
-- TG_ARGV[0]: referenced table, TG_ARGV[1]: referencing column.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.enforce_shared_reference() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  ref_id uuid := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
  ref_company uuid;
  found boolean;
BEGIN
  IF ref_id IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT true, company_id FROM %I WHERE id = $1', TG_ARGV[0])
    INTO found, ref_company USING ref_id;
  IF found AND ref_company IS NOT NULL AND ref_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION '%.% references a % row that belongs to another company',
      TG_TABLE_NAME, TG_ARGV[1], TG_ARGV[0]
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
