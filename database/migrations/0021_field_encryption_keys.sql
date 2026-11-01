-- =============================================================================
-- EstatePro · Migration 0021 · Field encryption keys (Phase 5, ADR-007, #17)
-- =============================================================================
-- Sensitive personal data (class C3) is encrypted by the API with a per-company
-- data key before it reaches the database (envelope encryption). This table
-- holds those keys ONLY in wrapped form: each was encrypted by a root key that
-- never leaves the key management service. Without the root key, a wrapped key
-- (and every value it protects) is unreadable, including in backups.
--
--   purpose 'field'   AES-256-GCM key for *_encrypted columns
--   purpose 'lookup'  HMAC-SHA256 key for *_hash columns (exact-match search)
--
-- Lifecycle: active → decrypt_only → destroyed. One active key per company and
-- purpose. Destroying a key overwrites the wrapped key (crypto-shredding).
-- The runtime role may read its company's keys and create the first key of a
-- company; rotation and destruction run as the platform role (worker job).
-- =============================================================================

CREATE TABLE company_data_keys (
  company_id    uuid         NOT NULL REFERENCES companies (id),
  purpose       text         NOT NULL CHECK (purpose IN ('field', 'lookup')),
  version       integer      NOT NULL CHECK (version >= 1),
  wrapped_key   bytea        CHECK (wrapped_key IS NULL OR octet_length(wrapped_key) BETWEEN 32 AND 4096),
  kms_key_ref   text         NOT NULL CHECK (char_length(kms_key_ref) BETWEEN 1 AND 2048),
  status        text         NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'decrypt_only', 'destroyed')),
  created_at    timestamptz  NOT NULL DEFAULT now(),
  retired_at    timestamptz,
  destroyed_at  timestamptz,
  PRIMARY KEY (company_id, purpose, version),
  CHECK ((status = 'destroyed') = (wrapped_key IS NULL)),
  CHECK ((status = 'destroyed') = (destroyed_at IS NOT NULL)),
  CHECK ((status = 'active') = (retired_at IS NULL))
);
CREATE UNIQUE INDEX company_data_keys_active_idx ON company_data_keys (company_id, purpose) WHERE status = 'active';

COMMENT ON TABLE company_data_keys IS
  'Per-company data keys for field encryption (ADR-007), wrapped by the KMS root key. Never holds a plaintext key.';

-- Keys only move forward, and the key material itself never changes except to
-- be erased on destruction.
CREATE FUNCTION app.company_data_keys_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.purpose <> OLD.purpose OR NEW.version <> OLD.version
     OR NEW.kms_key_ref <> OLD.kms_key_ref OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'company_data_keys: identity and origin of a key cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.wrapped_key IS DISTINCT FROM OLD.wrapped_key AND NEW.wrapped_key IS NOT NULL THEN
    RAISE EXCEPTION 'company_data_keys: key material cannot be replaced' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = NEW.status)
       OR (OLD.status = 'active' AND NEW.status IN ('decrypt_only', 'destroyed'))
       OR (OLD.status = 'decrypt_only' AND NEW.status = 'destroyed')) THEN
    RAISE EXCEPTION 'company_data_keys: status cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_data_keys_guard
  BEFORE UPDATE ON company_data_keys
  FOR EACH ROW EXECUTE FUNCTION app.company_data_keys_guard();

ALTER TABLE company_data_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company_data_keys FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
-- The runtime role creates a company's first keys on first use, and never
-- changes or deletes keys.
CREATE POLICY first_key_only ON company_data_keys AS RESTRICTIVE FOR INSERT TO estatepro_app
  WITH CHECK (version = 1 AND status = 'active');
GRANT SELECT, INSERT ON company_data_keys TO estatepro_app;
GRANT SELECT, INSERT, UPDATE ON company_data_keys TO estatepro_platform;

-- -----------------------------------------------------------------------------
-- Columns for the approved encryption scope (ADR-007 §3, decision E-Q1)
-- -----------------------------------------------------------------------------

-- Identity document numbers are encrypted (number_encrypted) and hashed
-- (number_hash); the last characters are kept for display without decryption.
ALTER TABLE identity_documents
  ADD COLUMN number_last4 text NOT NULL CHECK (char_length(number_last4) BETWEEN 1 AND 4);

-- An individual's tax number and registration number are sensitive personal
-- data (E-Q1): encrypted, with a lookup hash for the tax number. The plain
-- columns remain for organisations, whose numbers are on public registers.
ALTER TABLE contacts
  ADD COLUMN tax_number_encrypted               bytea,
  ADD COLUMN tax_number_hash                    bytea CHECK (tax_number_hash IS NULL OR octet_length(tax_number_hash) = 32),
  ADD COLUMN tax_number_last4                   text  CHECK (char_length(tax_number_last4) BETWEEN 1 AND 4),
  ADD COLUMN organisation_reg_number_encrypted  bytea,
  ADD CONSTRAINT contacts_person_identifiers_encrypted
    CHECK (contact_type = 'organisation' OR (tax_number IS NULL AND organisation_reg_number IS NULL)),
  ADD CONSTRAINT contacts_tax_number_protected_complete
    CHECK ((tax_number_encrypted IS NULL) = (tax_number_hash IS NULL)
       AND (tax_number_encrypted IS NULL) = (tax_number_last4 IS NULL));
CREATE INDEX contacts_tax_number_hash_idx ON contacts (company_id, tax_number_hash) WHERE tax_number_hash IS NOT NULL;

COMMENT ON COLUMN contacts.date_of_birth_encrypted IS 'C3, ADR-007: AES-256-GCM with the company field key. Never hashed (low entropy).';
COMMENT ON COLUMN contacts.tax_number_encrypted IS 'C3, ADR-007: tax number of a person. Organisations use tax_number.';
COMMENT ON COLUMN contacts.organisation_reg_number_encrypted IS 'C3, ADR-007: registration number of a person (e.g. sole trader). Organisations use organisation_reg_number.';
COMMENT ON COLUMN identity_documents.number_encrypted IS 'C3, ADR-007: AES-256-GCM with the company field key.';
COMMENT ON COLUMN identity_documents.number_hash IS 'ADR-007 §4.4: HMAC-SHA256 with the company lookup key, for duplicate detection.';
