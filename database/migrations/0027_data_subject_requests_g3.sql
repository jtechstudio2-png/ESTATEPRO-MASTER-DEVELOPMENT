-- =============================================================================
-- EstatePro · Migration 0027 · Data-subject request register (Phase 5, gap G3)
-- =============================================================================
-- A company's register of requests from people about their personal data:
-- access (a copy of what we hold) and erasure (ADR-007 §8). Each request has
-- a reference, a contact, the date it reached us and a due date, an assignee,
-- an identity check, evidence, an outcome and an append-only history. While an
-- erasure request is open the contact cannot be merged (wireframe C-4).
--
-- Lifecycle:
--   received → verifying → in_progress → completed
--        └──────────┴───────────┴──────→ refused | withdrawn
-- Work starts (in_progress) only once the requester's identity is verified.
-- Completed, refused and withdrawn are final.
--
-- The register is kept after an erasure: it is the record that the request
-- was handled. It holds the contact link (an erased contact shows as "Erased
-- contact"), dates, statuses and short evidence summaries.
-- =============================================================================

INSERT INTO permissions (key, module, description, is_sensitive) VALUES
  ('privacy.view',   'crm', 'View data-subject requests (access and erasure)', false),
  ('privacy.manage', 'crm', 'Log data-subject requests, verify identity, assign, record evidence and close them', false),
  ('privacy.fulfil', 'crm', 'Carry out an erasure and produce access reports, which include protected details', true);

INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT r.id, g.permission_key, 'all'
  FROM (VALUES
          ('company_owner', 'privacy.view'),
          ('company_owner', 'privacy.manage'),
          ('company_owner', 'privacy.fulfil'),
          ('office_admin',  'privacy.view'),
          ('office_admin',  'privacy.manage')
       ) AS g (role_key, permission_key)
  JOIN roles r ON r.key = g.role_key AND r.company_id IS NULL
ON CONFLICT DO NOTHING;

-- References DSR-0001, … for new and existing companies.
CREATE OR REPLACE FUNCTION app.provision_company_defaults(p_company_id uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO number_sequences (company_id, sequence_key, prefix)
  VALUES (p_company_id, 'contact', 'CON'), (p_company_id, 'property', 'PRP'), (p_company_id, 'unit', 'UNT'),
         (p_company_id, 'listing', 'LST'), (p_company_id, 'lead', 'LEA'), (p_company_id, 'deal', 'DEA'),
         (p_company_id, 'sale', 'SAL'), (p_company_id, 'management_agreement', 'MGA'),
         (p_company_id, 'lease', 'LSE'), (p_company_id, 'payment', 'RCT'), (p_company_id, 'work_order', 'WO'),
         (p_company_id, 'inspection', 'INS'), (p_company_id, 'finance_transaction', 'FIN'),
         (p_company_id, 'statement', 'STM'), (p_company_id, 'payout', 'PAY'),
         (p_company_id, 'privacy_request', 'DSR')
  ON CONFLICT DO NOTHING;
$$;
INSERT INTO number_sequences (company_id, sequence_key, prefix)
SELECT id, 'privacy_request', 'DSR' FROM companies
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Requests
-- -----------------------------------------------------------------------------
CREATE TABLE data_subject_requests (
  id                          uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id                  uuid         NOT NULL REFERENCES companies (id),
  reference                   text         NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 40),
  contact_id                  uuid         NOT NULL,
  request_type                text         NOT NULL CHECK (request_type IN ('access', 'erasure')),
  status                      text         NOT NULL DEFAULT 'received'
                                           CHECK (status IN ('received', 'verifying', 'in_progress', 'completed', 'refused', 'withdrawn')),
  channel                     text         NOT NULL CHECK (channel IN ('email', 'phone', 'in_person', 'post', 'web_form', 'other')),
  received_on                 date         NOT NULL,
  due_on                      date         NOT NULL,
  extended_due_on             date,
  extension_reason            text         CHECK (char_length(extension_reason) BETWEEN 10 AND 500),
  assigned_to                 uuid,
  identity_verified_at        timestamptz,
  identity_verified_by        uuid,
  identity_method             text         CHECK (identity_method IN ('documents_seen', 'known_contact_details', 'email_confirmation', 'other')),
  outcome_note                text         CHECK (char_length(outcome_note) BETWEEN 3 AND 1000),
  access_export_id            uuid,
  erasure_ledger_entry_id     uuid,
  closed_at                   timestamptz,
  closed_by                   uuid,
  created_by                  uuid         NOT NULL,
  created_at                  timestamptz  NOT NULL DEFAULT now(),
  updated_at                  timestamptz  NOT NULL DEFAULT now(),
  version                     integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, assigned_to) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, identity_verified_by) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, closed_by) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, access_export_id) REFERENCES export_jobs (company_id, id),
  CONSTRAINT dsr_due_after_receipt CHECK (due_on >= received_on),
  CONSTRAINT dsr_extension_complete CHECK ((extended_due_on IS NULL) = (extension_reason IS NULL) AND (extended_due_on IS NULL OR extended_due_on > due_on)),
  CONSTRAINT dsr_identity_complete CHECK (
    (identity_verified_at IS NULL) = (identity_verified_by IS NULL) AND (identity_verified_at IS NULL) = (identity_method IS NULL)),
  CONSTRAINT dsr_work_needs_identity CHECK (status NOT IN ('in_progress', 'completed') OR identity_verified_at IS NOT NULL),
  CONSTRAINT dsr_closed_complete CHECK (
    (status IN ('completed', 'refused', 'withdrawn')) = (closed_at IS NOT NULL) AND (closed_at IS NULL) = (closed_by IS NULL)),
  CONSTRAINT dsr_refusal_reasoned CHECK (status NOT IN ('refused', 'withdrawn') OR outcome_note IS NOT NULL),
  CONSTRAINT dsr_erasure_completed_by_service CHECK (request_type <> 'erasure' OR status <> 'completed' OR erasure_ledger_entry_id IS NOT NULL),
  CONSTRAINT dsr_ledger_only_for_erasure CHECK (erasure_ledger_entry_id IS NULL OR request_type = 'erasure'),
  CONSTRAINT dsr_report_only_for_access CHECK (access_export_id IS NULL OR request_type = 'access')
);
CREATE INDEX dsr_open_idx ON data_subject_requests (company_id, coalesce(extended_due_on, due_on)) WHERE closed_at IS NULL;
CREATE INDEX dsr_contact_idx ON data_subject_requests (company_id, contact_id);
CREATE INDEX dsr_assigned_idx ON data_subject_requests (company_id, assigned_to) WHERE closed_at IS NULL;
CREATE INDEX dsr_created_idx ON data_subject_requests (company_id, created_at DESC, id DESC);
CREATE TRIGGER data_subject_requests_touch BEFORE UPDATE ON data_subject_requests FOR EACH ROW EXECUTE FUNCTION app.touch_row();

COMMENT ON TABLE data_subject_requests IS
  'Data-subject requests (gap G3): access and erasure, with lifecycle, due date, assignee, identity check and outcome. Kept after an erasure as the record of handling.';

-- Status moves forward only; closed requests are final; the type, contact and
-- receipt date never change; a due date is extended once.
CREATE FUNCTION app.data_subject_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.company_id, NEW.reference, NEW.contact_id, NEW.request_type, NEW.received_on, NEW.due_on, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.company_id, OLD.reference, OLD.contact_id, OLD.request_type, OLD.received_on, OLD.due_on, OLD.created_by, OLD.created_at) THEN
    -- A merge moves an access request (or a closed erasure request) to the kept contact.
    IF NOT (NEW.contact_id IS DISTINCT FROM OLD.contact_id
            AND (NEW.company_id, NEW.reference, NEW.request_type, NEW.received_on, NEW.due_on, NEW.created_by, NEW.created_at)
                IS NOT DISTINCT FROM (OLD.company_id, OLD.reference, OLD.request_type, OLD.received_on, OLD.due_on, OLD.created_by, OLD.created_at)) THEN
      RAISE EXCEPTION 'data-subject request %: reference, type, contact and receipt cannot change', OLD.reference USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.closed_at IS NOT NULL AND (to_jsonb(NEW) - 'contact_id' - 'updated_at' - 'version') <> (to_jsonb(OLD) - 'contact_id' - 'updated_at' - 'version') THEN
    RAISE EXCEPTION 'data-subject request % is closed', OLD.reference USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'received' AND NEW.status IN ('verifying', 'in_progress', 'refused', 'withdrawn'))
    OR (OLD.status = 'verifying' AND NEW.status IN ('in_progress', 'refused', 'withdrawn'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'refused', 'withdrawn'))) THEN
    RAISE EXCEPTION 'data-subject request %: status cannot go from % to %', OLD.reference, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.extended_due_on IS NOT NULL AND NEW.extended_due_on IS DISTINCT FROM OLD.extended_due_on THEN
    RAISE EXCEPTION 'data-subject request %: the due date has already been extended', OLD.reference USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.identity_verified_at IS NOT NULL AND (NEW.identity_verified_at, NEW.identity_verified_by, NEW.identity_method)
     IS DISTINCT FROM (OLD.identity_verified_at, OLD.identity_verified_by, OLD.identity_method) THEN
    RAISE EXCEPTION 'data-subject request %: identity verification cannot be changed', OLD.reference USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.erasure_ledger_entry_id IS NOT NULL AND NEW.erasure_ledger_entry_id IS DISTINCT FROM OLD.erasure_ledger_entry_id THEN
    RAISE EXCEPTION 'data-subject request %: the erasure record cannot change', OLD.reference USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER data_subject_requests_guard BEFORE UPDATE ON data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION app.data_subject_requests_guard();
CREATE TRIGGER data_subject_requests_no_delete BEFORE DELETE ON data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- -----------------------------------------------------------------------------
-- History (the request's own audit trail, shown on the request) and evidence
-- -----------------------------------------------------------------------------
CREATE TABLE data_subject_request_events (
  id            uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id    uuid         NOT NULL REFERENCES companies (id),
  request_id    uuid         NOT NULL,
  event_type    text         NOT NULL CHECK (event_type IN (
                               'created', 'status_changed', 'assigned', 'identity_verified', 'due_extended',
                               'evidence_added', 'access_report_generated', 'erasure_carried_out', 'erasure_blocked')),
  from_status   text,
  to_status     text,
  detail        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  actor         uuid,
  occurred_at   timestamptz  NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, request_id) REFERENCES data_subject_requests (company_id, id),
  FOREIGN KEY (company_id, actor) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX dsr_events_request_idx ON data_subject_request_events (company_id, request_id, occurred_at, id);
CREATE TRIGGER data_subject_request_events_append_only BEFORE UPDATE OR DELETE ON data_subject_request_events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TABLE data_subject_request_evidence (
  id            uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id    uuid         NOT NULL REFERENCES companies (id),
  request_id    uuid         NOT NULL,
  kind          text         NOT NULL CHECK (kind IN ('request', 'identity', 'correspondence', 'response', 'other')),
  summary       text         NOT NULL CHECK (char_length(summary) BETWEEN 3 AND 1000),
  received_on   date         NOT NULL,
  recorded_by   uuid         NOT NULL,
  recorded_at   timestamptz  NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, request_id) REFERENCES data_subject_requests (company_id, id),
  FOREIGN KEY (company_id, recorded_by) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX dsr_evidence_request_idx ON data_subject_request_evidence (company_id, request_id, recorded_at, id);
CREATE TRIGGER data_subject_request_evidence_append_only BEFORE UPDATE OR DELETE ON data_subject_request_evidence
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
COMMENT ON TABLE data_subject_request_evidence IS
  'What the company received or sent for a request (the request itself, identity proof seen, correspondence, the response). Append-only; a correction is a new entry.';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['data_subject_requests', 'data_subject_request_events', 'data_subject_request_evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I FOR ALL TO estatepro_app USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO estatepro_app', t);
    EXECUTE format('GRANT SELECT ON %I TO estatepro_platform', t);
  END LOOP;
END $$;
GRANT UPDATE ON data_subject_requests TO estatepro_app;

-- A request follows its contact through a merge (wireframe C-4); an open
-- erasure request blocks the merge in the API.
INSERT INTO contact_reference_columns (table_name, column_name, handling, reason) VALUES
  ('data_subject_requests', 'contact_id', 'repoint', 'Requests move to the kept contact; a merge is refused while an erasure request is open');

-- Open erasure requests about either contact (the merge preview and the merge refuse them).
CREATE FUNCTION app.contact_open_erasure_requests(p_contact uuid) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(reference ORDER BY reference), '{}')
    FROM data_subject_requests
   WHERE company_id = app.current_company_id() AND contact_id = p_contact
     AND request_type = 'erasure' AND closed_at IS NULL
$$;
GRANT EXECUTE ON FUNCTION app.contact_open_erasure_requests(uuid) TO estatepro_app;
