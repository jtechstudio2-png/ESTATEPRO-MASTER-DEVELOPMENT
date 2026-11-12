-- =============================================================================
-- EstatePro · Migration 0026 · Key rotation and erasure (Phase 5, ADR-007 E5–E6)
-- =============================================================================
-- E5  Data-key rotation (ADR-007 §10). A rotation adds key version n+1, moves
--     every protected value (field key) or lookup hash (lookup key) of the
--     company onto it in resumable batches, waits for in-flight requests to
--     settle, checks that nothing still uses version n and then destroys it.
--     `key_rotations` records the progress; the work runs as the platform role.
--
-- E6  Erasure (ADR-007 §8). `app.erase_contact` anonymises a person: names,
--     contact details and protected values are removed, free text about them
--     is replaced with "[Erased]" (including history and audit change values,
--     whose rows and keys are kept), contact methods and the address are
--     removed. Rows that other records need (identity documents, KYC checks,
--     consents, leads, activities) stay, without personal data. Records that
--     the law requires us to keep (financial and contractual rows) block it.
--
-- History tables are append-only. Their guards now allow exactly two changes,
-- and only inside functions that run with the owner's rights (never the
-- runtime role): replacing text with "[Erased]" during an erasure, and
-- re-encrypting a value under a newer key during a rotation.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- The data-key version in the header of a field ciphertext (ADR-007 §4.3:
-- byte 0 format 0x01, bytes 1–4 key version, big-endian). NULL if not one.
CREATE FUNCTION app.ciphertext_key_version(p_value bytea) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_value IS NULL OR octet_length(p_value) < 5 OR get_byte(p_value, 0) <> 1 THEN NULL
    ELSE (get_byte(p_value, 1)::bigint << 24) | (get_byte(p_value, 2)::bigint << 16)
       | (get_byte(p_value, 3)::bigint << 8) | get_byte(p_value, 4)::bigint
  END
$$;

-- A maintenance role: one that bypasses row-level security (the platform
-- role, superusers) or owns the app schema (the migration owner, which is
-- the current user inside SECURITY DEFINER functions). The runtime roles
-- (estatepro_app, estatepro_auth, estatepro_web) are never maintenance roles.
CREATE FUNCTION app.maintenance_role() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls))
      OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname = 'app' AND n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
$$;

-- True while app.erase_contact runs: a transaction-local flag that only
-- counts for a maintenance role (inside the SECURITY DEFINER function the
-- current user is its owner). The runtime role setting the flag gains nothing.
CREATE FUNCTION app.erasure_in_progress() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.erasure', true), '') = 'on' AND app.maintenance_role()
$$;

-- Every string in a JSON document replaced with "[Erased]"; keys, numbers,
-- booleans and nulls kept (audit rows keep what changed and when, not values).
CREATE FUNCTION app.redact_json(p_value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(p_value)
    WHEN 'string' THEN to_jsonb('[Erased]'::text)
    WHEN 'object' THEN coalesce((SELECT jsonb_object_agg(key, app.redact_json(value)) FROM jsonb_each(p_value)), '{}'::jsonb)
    WHEN 'array' THEN coalesce((SELECT jsonb_agg(app.redact_json(value) ORDER BY ordinality) FROM jsonb_array_elements(p_value) WITH ORDINALITY), '[]'::jsonb)
    ELSE p_value
  END
$$;

-- A key rotation re-encrypts values without changing them: the row keeps its
-- version and update time, so nobody editing it meets a false conflict.
-- Only a maintenance role in a transaction marked app.key_rotation = 'on'.
CREATE OR REPLACE FUNCTION app.touch_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.key_rotation', true) = 'on' THEN
    IF app.maintenance_role() THEN
      RETURN NEW;
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- E5: key rotations
-- -----------------------------------------------------------------------------
CREATE TABLE key_rotations (
  id              uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id      uuid         NOT NULL REFERENCES companies (id),
  purpose         text         NOT NULL CHECK (purpose IN ('field', 'lookup')),
  from_version    integer      NOT NULL CHECK (from_version >= 1),
  to_version      integer      NOT NULL,
  trigger_type    text         NOT NULL CHECK (trigger_type IN ('scheduled', 'compromise', 'request')),
  reason          text         NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  requested_by    text         NOT NULL CHECK (char_length(requested_by) BETWEEN 1 AND 200),
  -- rewriting: moving values onto to_version; settling: waiting for requests
  -- that read the old key before the switch; completed: old key destroyed.
  status          text         NOT NULL DEFAULT 'rewriting' CHECK (status IN ('rewriting', 'settling', 'completed')),
  pass            integer      NOT NULL DEFAULT 1 CHECK (pass BETWEEN 1 AND 2),
  -- Position of the batch scan: index into the field register and the last row id.
  cursor_field    integer      NOT NULL DEFAULT 0 CHECK (cursor_field >= 0),
  cursor_row_id   uuid,
  rows_rewritten  bigint       NOT NULL DEFAULT 0 CHECK (rows_rewritten >= 0),
  settle_until    timestamptz,
  started_at      timestamptz  NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  last_error      text,
  CHECK (to_version = from_version + 1),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK (status <> 'settling' OR settle_until IS NOT NULL),
  FOREIGN KEY (company_id, purpose, from_version) REFERENCES company_data_keys (company_id, purpose, version),
  FOREIGN KEY (company_id, purpose, to_version) REFERENCES company_data_keys (company_id, purpose, version)
);
-- One rotation at a time per company and key purpose.
CREATE UNIQUE INDEX key_rotations_open_idx ON key_rotations (company_id, purpose) WHERE status <> 'completed';
CREATE INDEX key_rotations_company_idx ON key_rotations (company_id, started_at DESC);

COMMENT ON TABLE key_rotations IS
  'Data-key rotations (ADR-007 §10, E5). Written by the platform role only; no key material.';

ALTER TABLE key_rotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON key_rotations FOR SELECT TO estatepro_app
  USING (company_id = app.current_company_id());
REVOKE ALL ON key_rotations FROM estatepro_app;
GRANT SELECT ON key_rotations TO estatepro_app;
GRANT SELECT, INSERT, UPDATE ON key_rotations TO estatepro_platform;

-- A destroyed key needs no rotation; the platform role may create later
-- versions (the runtime role still only creates version 1, migration 0021).
-- Nothing to change in company_data_keys itself.

-- -----------------------------------------------------------------------------
-- E6: identity documents can lose their number when the person is erased
-- -----------------------------------------------------------------------------
ALTER TABLE identity_documents
  ALTER COLUMN number_encrypted DROP NOT NULL,
  ALTER COLUMN number_hash DROP NOT NULL,
  ALTER COLUMN number_last4 DROP NOT NULL,
  ADD COLUMN erased_at timestamptz,
  ADD CONSTRAINT identity_documents_number_or_erased CHECK (
    (erased_at IS NULL) = (number_encrypted IS NOT NULL)
    AND (erased_at IS NULL) = (number_hash IS NOT NULL)
    AND (erased_at IS NULL) = (number_last4 IS NOT NULL));
COMMENT ON COLUMN identity_documents.erased_at IS
  'Set when the person was erased (ADR-007 §8): the number, its hash and last characters are gone; type, country and dates stay for the KYC record.';

-- Verified documents cannot change, except (a) re-encryption of the number
-- under a newer field key, or a new lookup hash, by the platform role during
-- a key rotation (maintenance role); (b) erasure of the number by app.erase_contact.
CREATE OR REPLACE FUNCTION app.identity_documents_verified_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  other_unchanged boolean := (NEW.document_type_code, NEW.issuing_country_code, NEW.issued_on, NEW.expires_on,
                              NEW.verified_at, NEW.verified_by, NEW.document_id, NEW.created_by)
                             IS NOT DISTINCT FROM
                             (OLD.document_type_code, OLD.issuing_country_code, OLD.issued_on, OLD.expires_on,
                              OLD.verified_at, OLD.verified_by, OLD.document_id, OLD.created_by);
BEGIN
  IF OLD.verified_at IS NULL OR (
       NEW.document_type_code, NEW.issuing_country_code, NEW.number_encrypted, NEW.number_hash, NEW.number_last4,
       NEW.issued_on, NEW.expires_on, NEW.verified_at, NEW.verified_by, NEW.document_id, NEW.created_by, NEW.erased_at
     ) IS NOT DISTINCT FROM (
       OLD.document_type_code, OLD.issuing_country_code, OLD.number_encrypted, OLD.number_hash, OLD.number_last4,
       OLD.issued_on, OLD.expires_on, OLD.verified_at, OLD.verified_by, OLD.document_id, OLD.created_by, OLD.erased_at
     ) THEN
    RETURN NEW;
  END IF;
  -- (a) rotation: same number, newer key (field) or new hash (lookup); nothing else changes.
  IF app.maintenance_role() AND NOT app.erasure_in_progress() AND other_unchanged
     AND NEW.number_last4 IS NOT DISTINCT FROM OLD.number_last4 AND NEW.erased_at IS NOT DISTINCT FROM OLD.erased_at
     AND NEW.number_encrypted IS NOT NULL AND NEW.number_hash IS NOT NULL
     AND ((NEW.number_hash IS NOT DISTINCT FROM OLD.number_hash
           AND app.ciphertext_key_version(NEW.number_encrypted) > app.ciphertext_key_version(OLD.number_encrypted))
          OR (NEW.number_encrypted IS NOT DISTINCT FROM OLD.number_encrypted)) THEN
    RETURN NEW;
  END IF;
  -- (b) erasure: the number goes, the rest of the record stays.
  IF app.erasure_in_progress() AND other_unchanged AND OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
     AND NEW.number_encrypted IS NULL AND NEW.number_hash IS NULL AND NEW.number_last4 IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'identity document % is verified and cannot be changed', OLD.id USING ERRCODE = 'check_violation';
END;
$$;

-- Signed-off KYC checks cannot change, except that an erasure replaces the
-- reviewer's free text with "[Erased]".
CREATE OR REPLACE FUNCTION app.kyc_checks_decided_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('verified', 'failed') AND (
       NEW.check_type, NEW.status, NEW.risk_rating, NEW.provider, NEW.provider_reference, NEW.reviewed_by, NEW.reviewed_at,
       NEW.expires_on, NEW.notes, NEW.deal_id, NEW.recorded_by, NEW.identity_document_id, NEW.decision_reason
     ) IS DISTINCT FROM (
       OLD.check_type, OLD.status, OLD.risk_rating, OLD.provider, OLD.provider_reference, OLD.reviewed_by, OLD.reviewed_at,
       OLD.expires_on, OLD.notes, OLD.deal_id, OLD.recorded_by, OLD.identity_document_id, OLD.decision_reason
     ) THEN
    IF app.erasure_in_progress()
       AND (NEW.check_type, NEW.status, NEW.risk_rating, NEW.provider, NEW.provider_reference, NEW.reviewed_by, NEW.reviewed_at,
            NEW.expires_on, NEW.deal_id, NEW.recorded_by, NEW.identity_document_id)
           IS NOT DISTINCT FROM
           (OLD.check_type, OLD.status, OLD.risk_rating, OLD.provider, OLD.provider_reference, OLD.reviewed_by, OLD.reviewed_at,
            OLD.expires_on, OLD.deal_id, OLD.recorded_by, OLD.identity_document_id)
       AND NEW.notes IS NOT DISTINCT FROM (CASE WHEN OLD.notes IS NULL THEN NULL ELSE '[Erased]' END)
       AND NEW.decision_reason IS NOT DISTINCT FROM (CASE WHEN OLD.decision_reason IS NULL THEN NULL ELSE '[Erased]' END) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'KYC check % is signed off and cannot be changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Activities: an erasure may replace subject and body of any activity
-- (system, archived or past the edit window) without marking it edited.
CREATE OR REPLACE FUNCTION app.activities_edit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  content_changed boolean := (NEW.activity_type, NEW.direction, NEW.subject, NEW.body, NEW.occurred_at, NEW.duration_seconds,
                              NEW.outcome_code, NEW.performed_by, NEW.external_message_id, NEW.created_by, NEW.created_at)
                             IS DISTINCT FROM
                             (OLD.activity_type, OLD.direction, OLD.subject, OLD.body, OLD.occurred_at, OLD.duration_seconds,
                              OLD.outcome_code, OLD.performed_by, OLD.external_message_id, OLD.created_by, OLD.created_at);
  archive_changed boolean := (NEW.archived_at, NEW.archived_by, NEW.archived_reason) IS DISTINCT FROM (OLD.archived_at, OLD.archived_by, OLD.archived_reason);
BEGIN
  IF app.erasure_in_progress()
     AND (NEW.activity_type, NEW.direction, NEW.occurred_at, NEW.duration_seconds, NEW.outcome_code, NEW.performed_by,
          NEW.external_message_id, NEW.created_by, NEW.created_at, NEW.archived_at, NEW.archived_by, NEW.edited_at)
         IS NOT DISTINCT FROM
         (OLD.activity_type, OLD.direction, OLD.occurred_at, OLD.duration_seconds, OLD.outcome_code, OLD.performed_by,
          OLD.external_message_id, OLD.created_by, OLD.created_at, OLD.archived_at, OLD.archived_by, OLD.edited_at)
     AND NEW.subject IS NOT DISTINCT FROM (CASE WHEN OLD.subject IS NULL THEN NULL ELSE '[Erased]' END)
     AND NEW.body IS NOT DISTINCT FROM (CASE WHEN OLD.body IS NULL THEN NULL ELSE '[Erased]' END)
     AND NEW.archived_reason IS NOT DISTINCT FROM (CASE WHEN OLD.archived_reason IS NULL THEN NULL ELSE '[Erased]' END) THEN
    RETURN NEW;
  END IF;
  IF OLD.is_system AND (content_changed OR archive_changed) THEN
    RAISE EXCEPTION 'system activity % cannot be changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF content_changed AND OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'archived activity % cannot be edited', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF content_changed AND now() > OLD.created_at + interval '24 hours' THEN
    RAISE EXCEPTION 'activity % can no longer be edited (24-hour window)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF archive_changed AND OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'activity % is already archived', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF content_changed THEN
    NEW.edited_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- Append-only history: only an erasure may replace its free text, and only
-- with "[Erased]". Deletes are never allowed.
CREATE FUNCTION app.history_erasure_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  text_columns text[] := TG_ARGV;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  col text;
BEGIN
  IF TG_OP = 'UPDATE' AND app.erasure_in_progress() THEN
    FOREACH col IN ARRAY text_columns LOOP
      IF old_row -> col <> 'null'::jsonb THEN
        old_row := jsonb_set(old_row, ARRAY[col], to_jsonb('[Erased]'::text));
      END IF;
    END LOOP;
    IF new_row = old_row THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER activity_revisions_append_only ON activity_revisions;
CREATE TRIGGER activity_revisions_append_only
  BEFORE UPDATE OR DELETE ON activity_revisions
  FOR EACH ROW EXECUTE FUNCTION app.history_erasure_guard('subject', 'body');

DROP TRIGGER lead_status_history_append_only ON lead_status_history;
CREATE TRIGGER lead_status_history_append_only
  BEFORE UPDATE OR DELETE ON lead_status_history
  FOR EACH ROW EXECUTE FUNCTION app.history_erasure_guard('note');

DROP TRIGGER lead_assignments_append_only ON lead_assignments;
CREATE TRIGGER lead_assignments_append_only
  BEFORE UPDATE OR DELETE ON lead_assignments
  FOR EACH ROW EXECUTE FUNCTION app.history_erasure_guard('note');

-- Audit rows keep actor, action, entity, time and the names of changed
-- fields; an erasure replaces the values with "[Erased]" (app.redact_json).
CREATE FUNCTION app.audit_logs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND app.erasure_in_progress()
     AND (to_jsonb(NEW) - 'changes' - 'metadata') = (to_jsonb(OLD) - 'changes' - 'metadata')
     AND NEW.changes IS NOT DISTINCT FROM app.redact_json(OLD.changes)
     AND NEW.metadata IS NOT DISTINCT FROM app.redact_json(OLD.metadata) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.audit_logs_guard();

-- -----------------------------------------------------------------------------
-- E6: anonymised contacts hold no personal data, and stay anonymised
-- -----------------------------------------------------------------------------
ALTER TABLE contacts ADD CONSTRAINT contacts_anonymised_empty CHECK (
  NOT is_anonymised OR (
    display_name = 'Erased contact' AND display_name_local IS NULL AND given_name IS NULL AND family_name IS NULL
    AND other_names IS NULL AND title IS NULL AND primary_email IS NULL AND primary_phone_e164 IS NULL
    AND nationality_country_code IS NULL AND residence_country_code IS NULL AND date_of_birth_encrypted IS NULL
    AND tax_number_encrypted IS NULL AND organisation_reg_number_encrypted IS NULL AND address_id IS NULL
    AND notes IS NULL AND custom_fields = '{}'::jsonb));

CREATE FUNCTION app.contacts_anonymised_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_anonymised AND NOT NEW.is_anonymised THEN
    RAISE EXCEPTION 'contact % is anonymised and cannot be restored', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contacts_anonymised_guard
  BEFORE UPDATE OF is_anonymised ON contacts
  FOR EACH ROW EXECUTE FUNCTION app.contacts_anonymised_guard();

-- -----------------------------------------------------------------------------
-- E6: erase a person (ADR-007 §8)
-- -----------------------------------------------------------------------------
-- Why erasure is refused: financial or contractual records the law requires us
-- to keep (contact_reference_columns 'block'), or a contact that is not a person.
CREATE FUNCTION app.contact_erasure_blockers(p_contact uuid) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  company uuid := app.current_company_id();
  kind text;
  blockers text[] := '{}';
BEGIN
  SELECT contact_type INTO kind FROM contacts WHERE company_id = company AND id = p_contact;
  IF kind IS NULL THEN
    RETURN blockers;
  END IF;
  IF kind <> 'person' THEN
    blockers := blockers || 'organisation'::text;
  END IF;
  -- Merged-away records of the person are erased with them, so their records count too.
  SELECT blockers || coalesce(array_agg(DISTINCT b), '{}') INTO blockers
    FROM contacts c CROSS JOIN LATERAL unnest(app.contact_merge_blockers(c.id)) AS b
   WHERE c.company_id = company AND (c.id = p_contact OR c.merged_into_contact_id = p_contact);
  RETURN blockers;
END;
$$;
GRANT EXECUTE ON FUNCTION app.contact_erasure_blockers(uuid) TO estatepro_app, estatepro_platform;

-- Erases the contact (and records merged into it) in the caller's company.
-- Returns what was erased as counts per table (no personal data). Idempotent:
-- an anonymised contact returns {"alreadyErased": true}. Runs with the
-- owner's rights so it can redact history; it only touches the caller's company.
CREATE FUNCTION app.erase_contact(p_contact uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  company uuid := app.current_company_id();
  target record;
  blockers text[];
  subjects uuid[];
  lead_ids uuid[];
  activity_ids uuid[];
  touched uuid[] := '{}';
  address_ids uuid[];
  method_ids uuid[];
  n bigint;
  counts jsonb := '{}'::jsonb;
BEGIN
  IF company IS NULL THEN
    RAISE EXCEPTION 'no company in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id, contact_type, is_anonymised, merged_into_contact_id INTO target
    FROM contacts WHERE company_id = company AND id = p_contact FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF target.is_anonymised THEN
    RETURN jsonb_build_object('alreadyErased', true);
  END IF;
  IF target.merged_into_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'contact % was merged; erase the contact it was merged into', p_contact USING ERRCODE = 'check_violation';
  END IF;
  blockers := app.contact_erasure_blockers(p_contact);
  IF cardinality(blockers) > 0 THEN
    RAISE EXCEPTION 'contact % cannot be erased: %', p_contact, array_to_string(blockers, ', ')
      USING ERRCODE = 'check_violation', DETAIL = array_to_string(blockers, ',');
  END IF;

  PERFORM set_config('app.erasure', 'on', true);

  SELECT array_agg(id) INTO subjects FROM contacts
   WHERE company_id = company AND (id = p_contact OR merged_into_contact_id = p_contact);
  PERFORM 1 FROM contacts WHERE company_id = company AND id = ANY (subjects) FOR UPDATE;
  SELECT coalesce(array_agg(id), '{}') INTO lead_ids FROM leads WHERE company_id = company AND contact_id = ANY (subjects);
  SELECT coalesce(array_agg(DISTINCT activity_id), '{}') INTO activity_ids FROM activity_links
   WHERE company_id = company
     AND ((entity_type = 'contact' AND entity_id = ANY (subjects)) OR (entity_type = 'lead' AND entity_id = ANY (lead_ids)));
  touched := subjects || lead_ids || activity_ids;

  -- The person
  SELECT coalesce(array_agg(address_id), '{}') INTO address_ids FROM contacts
   WHERE company_id = company AND id = ANY (subjects) AND address_id IS NOT NULL;
  UPDATE contacts
     SET display_name = 'Erased contact', display_name_local = NULL, given_name = NULL, family_name = NULL,
         other_names = NULL, title = NULL, primary_email = NULL, primary_phone_e164 = NULL,
         nationality_country_code = NULL, residence_country_code = NULL, date_of_birth_encrypted = NULL,
         tax_number_encrypted = NULL, tax_number_hash = NULL, tax_number_last4 = NULL,
         organisation_reg_number_encrypted = NULL, address_id = NULL, notes = NULL, custom_fields = '{}'::jsonb,
         archived_reason = CASE WHEN archived_reason IS NULL THEN NULL ELSE '[Erased]' END,
         is_anonymised = true, version = version + 1
   WHERE company_id = company AND id = ANY (subjects);
  counts := counts || jsonb_build_object('contacts', cardinality(subjects));

  -- Addresses used only by this person are removed; a shared one is kept.
  DELETE FROM addresses a
   WHERE a.company_id = company AND a.id = ANY (address_ids)
     AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = company AND c.address_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.company_id = company AND p.address_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM offices o WHERE o.company_id = company AND o.address_id = a.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('addresses', n); END IF;

  SELECT coalesce(array_agg(id), '{}') INTO method_ids FROM contact_methods WHERE company_id = company AND contact_id = ANY (subjects);
  DELETE FROM contact_methods WHERE company_id = company AND id = ANY (method_ids);
  IF cardinality(method_ids) > 0 THEN counts := counts || jsonb_build_object('contact_methods', cardinality(method_ids)); END IF;
  touched := touched || method_ids;

  -- Records about the person keep their facts and lose personal data.
  UPDATE consents SET evidence = '[Erased]' WHERE company_id = company AND contact_id = ANY (subjects) AND evidence IS NOT NULL;
  UPDATE identity_documents
     SET number_encrypted = NULL, number_hash = NULL, number_last4 = NULL, erased_at = now(),
         archived_reason = CASE WHEN archived_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND contact_id = ANY (subjects) AND erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('identity_documents', n); END IF;
  touched := touched || coalesce((SELECT array_agg(id) FROM identity_documents WHERE company_id = company AND contact_id = ANY (subjects)), '{}');

  UPDATE kyc_checks
     SET notes = CASE WHEN notes IS NULL THEN NULL ELSE '[Erased]' END,
         decision_reason = CASE WHEN decision_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND contact_id = ANY (subjects) AND (notes IS NOT NULL OR decision_reason IS NOT NULL);
  touched := touched || coalesce((SELECT array_agg(id) FROM kyc_checks WHERE company_id = company AND contact_id = ANY (subjects)), '{}');

  UPDATE requirements SET notes = NULL WHERE company_id = company AND contact_id = ANY (subjects) AND notes IS NOT NULL;
  touched := touched || coalesce((SELECT array_agg(id) FROM requirements WHERE company_id = company AND contact_id = ANY (subjects)), '{}');
  UPDATE requirement_exclusions e SET reason = '[Erased]'
    FROM requirements r
   WHERE e.company_id = company AND r.company_id = company AND r.id = e.requirement_id
     AND r.contact_id = ANY (subjects) AND e.reason IS NOT NULL;

  UPDATE leads
     SET message = CASE WHEN message IS NULL THEN NULL ELSE '[Erased]' END,
         source_detail = CASE WHEN source_detail IS NULL THEN NULL ELSE '[Erased]' END,
         custom_fields = '{}'::jsonb,
         archived_reason = CASE WHEN archived_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND id = ANY (lead_ids);
  IF cardinality(lead_ids) > 0 THEN counts := counts || jsonb_build_object('leads', cardinality(lead_ids)); END IF;
  UPDATE lead_status_history SET note = '[Erased]' WHERE company_id = company AND lead_id = ANY (lead_ids) AND note IS NOT NULL;
  UPDATE lead_assignments SET note = '[Erased]' WHERE company_id = company AND lead_id = ANY (lead_ids) AND note IS NOT NULL;

  UPDATE activities
     SET subject = CASE WHEN subject IS NULL THEN NULL ELSE '[Erased]' END,
         body = CASE WHEN body IS NULL THEN NULL ELSE '[Erased]' END,
         archived_reason = CASE WHEN archived_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND id = ANY (activity_ids);
  IF cardinality(activity_ids) > 0 THEN counts := counts || jsonb_build_object('activities', cardinality(activity_ids)); END IF;
  UPDATE activity_revisions
     SET subject = CASE WHEN subject IS NULL THEN NULL ELSE '[Erased]' END,
         body = CASE WHEN body IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND activity_id = ANY (activity_ids) AND (subject IS NOT NULL OR body IS NOT NULL);

  UPDATE tasks
     SET title = '[Erased]',
         description = CASE WHEN description IS NULL THEN NULL ELSE '[Erased]' END,
         cancel_reason = CASE WHEN cancel_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company
     AND ((entity_type = 'contact' AND entity_id = ANY (subjects)) OR (entity_type = 'lead' AND entity_id = ANY (lead_ids)));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('tasks', n); END IF;
  touched := touched || coalesce((SELECT array_agg(id) FROM tasks WHERE company_id = company
     AND ((entity_type = 'contact' AND entity_id = ANY (subjects)) OR (entity_type = 'lead' AND entity_id = ANY (lead_ids)))), '{}');

  -- Audit rows and outbox events about these records keep their shape, not values.
  UPDATE audit_logs
     SET changes = app.redact_json(changes), metadata = app.redact_json(metadata)
   WHERE company_id = company AND entity_id = ANY (touched)
     AND (changes IS DISTINCT FROM app.redact_json(changes) OR metadata IS DISTINCT FROM app.redact_json(metadata));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('audit_logs', n); END IF;
  UPDATE outbox_events SET payload = app.redact_json(payload)
   WHERE company_id = company AND aggregate_id = ANY (touched) AND payload IS DISTINCT FROM app.redact_json(payload);

  PERFORM set_config('app.erasure', 'off', true);
  RETURN counts || jsonb_build_object('erasedContactIds', to_jsonb(subjects));
END;
$$;
REVOKE ALL ON FUNCTION app.erase_contact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.erase_contact(uuid) TO estatepro_app, estatepro_platform;
