-- =============================================================================
-- EstatePro · Migration 0024 · Leads, activities and follow-ups
-- (Phase 5 milestone C3)
-- =============================================================================
-- 1. Leads: who created and archived them; allowed status changes enforced in
--    the database; status history and assignment history are append-only
--    (wireframes L-1 to L-4, CRM-06).
-- 2. Activities: author, edit window and revision history (decision D5),
--    archive instead of delete, stable order for same-time entries (gap G6,
--    issue #15), system entries that never change (wireframes A-1, A-2).
-- 3. Follow-ups (tasks): cancellation details, reminder before due, creator
--    (wireframes F-1, F-2; decision D6).
-- 4. Activity outcomes picklist.
-- The response target (decision D3, gap G1) is the company setting
-- crm.lead_response_minutes; it has no default, so nothing is stored here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Leads
-- -----------------------------------------------------------------------------
ALTER TABLE leads
  ADD COLUMN created_by       uuid,
  ADD COLUMN archived_by      uuid,
  ADD COLUMN archived_reason  text CHECK (char_length(archived_reason) BETWEEN 3 AND 500),
  ADD CONSTRAINT leads_created_by_fkey FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT leads_archived_by_fkey FOREIGN KEY (company_id, archived_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT leads_archive_complete CHECK ((archived_at IS NULL) = (archived_reason IS NULL) AND (archived_at IS NOT NULL OR archived_by IS NULL)),
  ADD CONSTRAINT leads_message_length CHECK (char_length(message) <= 4000),
  ADD CONSTRAINT leads_converted_has_deal CHECK (status <> 'converted' OR converted_deal_id IS NOT NULL);
CREATE INDEX leads_created_by_fk_idx ON leads (company_id, created_by) WHERE created_by IS NOT NULL;
CREATE INDEX leads_archived_by_fk_idx ON leads (company_id, archived_by) WHERE archived_by IS NOT NULL;
CREATE INDEX leads_office_id_fk_idx ON leads (company_id, office_id) WHERE office_id IS NOT NULL;
-- Register (L-1): newest first, and per assignee.
CREATE INDEX leads_received_idx ON leads (company_id, received_at DESC, id DESC) WHERE archived_at IS NULL;
CREATE INDEX leads_assignee_received_idx ON leads (company_id, assigned_to, received_at DESC, id DESC) WHERE archived_at IS NULL;

-- Allowed status changes (L-4). Converting creates a deal (Phase 6).
CREATE FUNCTION app.lead_status_change_allowed(from_status text, to_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE from_status
    WHEN 'new'         THEN to_status IN ('contacted', 'qualified', 'unqualified', 'lost', 'converted')
    WHEN 'contacted'   THEN to_status IN ('qualified', 'unqualified', 'lost', 'converted')
    WHEN 'qualified'   THEN to_status IN ('unqualified', 'lost', 'converted')
    WHEN 'unqualified' THEN to_status IN ('contacted', 'qualified')
    WHEN 'lost'        THEN to_status IN ('contacted')
    ELSE false
  END
$$;

CREATE FUNCTION app.leads_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT app.lead_status_change_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'lead % cannot change from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- A lead that is no longer lost keeps no lost reason.
  IF NEW.status <> 'lost' THEN
    NEW.lost_reason_code := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER leads_status_guard BEFORE UPDATE OF status ON leads FOR EACH ROW EXECUTE FUNCTION app.leads_status_guard();

ALTER TABLE lead_status_history
  ADD CONSTRAINT lead_status_history_changed_by_fkey FOREIGN KEY (company_id, changed_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT lead_status_history_note_length CHECK (char_length(note) <= 1000);
CREATE INDEX lead_status_history_changed_by_fk_idx ON lead_status_history (company_id, changed_by) WHERE changed_by IS NOT NULL;
CREATE TRIGGER lead_status_history_append_only BEFORE UPDATE OR DELETE ON lead_status_history
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
REVOKE UPDATE, DELETE ON lead_status_history FROM estatepro_app;

ALTER TABLE lead_assignments
  ADD COLUMN note text CHECK (char_length(note) <= 1000),
  ADD CONSTRAINT lead_assignments_assigned_by_fkey FOREIGN KEY (company_id, assigned_by) REFERENCES company_memberships (company_id, id);
CREATE INDEX lead_assignments_assigned_by_fk_idx ON lead_assignments (company_id, assigned_by) WHERE assigned_by IS NOT NULL;
CREATE TRIGGER lead_assignments_append_only BEFORE UPDATE OR DELETE ON lead_assignments
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
REVOKE UPDATE, DELETE ON lead_assignments FROM estatepro_app;

-- Leads are archived, never deleted, by the application.
REVOKE DELETE ON leads FROM estatepro_app;

-- -----------------------------------------------------------------------------
-- 2. Activities
-- -----------------------------------------------------------------------------
ALTER TABLE activities
  ADD COLUMN entry_no         bigint       GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN created_by       uuid,
  ADD COLUMN updated_at       timestamptz  NOT NULL DEFAULT now(),
  ADD COLUMN version          integer      NOT NULL DEFAULT 1,
  ADD COLUMN edited_at        timestamptz,
  ADD COLUMN archived_at      timestamptz,
  ADD COLUMN archived_by      uuid,
  ADD COLUMN archived_reason  text CHECK (char_length(archived_reason) BETWEEN 3 AND 500),
  ADD COLUMN is_system        boolean      GENERATED ALWAYS AS (activity_type IN ('status_change', 'system')) STORED,
  ADD CONSTRAINT activities_created_by_fkey FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT activities_archived_by_fkey FOREIGN KEY (company_id, archived_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT activities_archive_complete CHECK ((archived_at IS NULL) = (archived_reason IS NULL) AND (archived_at IS NOT NULL OR archived_by IS NULL)),
  ADD CONSTRAINT activities_subject_length CHECK (char_length(subject) <= 200),
  ADD CONSTRAINT activities_body_length CHECK (char_length(body) <= 10000);
COMMENT ON COLUMN activities.entry_no IS 'Insertion order; breaks ties between entries at the same time so timelines never reorder (gap G6, #15).';
CREATE UNIQUE INDEX activities_entry_no_idx ON activities (entry_no);
CREATE INDEX activities_created_by_fk_idx ON activities (company_id, created_by) WHERE created_by IS NOT NULL;
CREATE INDEX activities_archived_by_fk_idx ON activities (company_id, archived_by) WHERE archived_by IS NOT NULL;
CREATE INDEX activities_performed_by_fk_idx ON activities (company_id, performed_by) WHERE performed_by IS NOT NULL;
CREATE INDEX activities_timeline_idx ON activities (company_id, occurred_at DESC, entry_no DESC);
-- Timelines read links by record, then activities by id.
CREATE INDEX activity_links_activity_idx ON activity_links (company_id, activity_id);
CREATE TRIGGER activities_touch BEFORE UPDATE ON activities FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- Previous versions of an edited activity (decision D5: history retained).
CREATE TABLE activity_revisions (
  id                uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id        uuid         NOT NULL,
  activity_id       uuid         NOT NULL,
  revision_no       integer      NOT NULL CHECK (revision_no >= 1),
  subject           text,
  body              text,
  outcome_code      text,
  direction         text,
  occurred_at       timestamptz  NOT NULL,
  duration_seconds  integer,
  edited_by         uuid,
  edited_at         timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, activity_id, revision_no),
  FOREIGN KEY (company_id, activity_id) REFERENCES activities (company_id, id),
  FOREIGN KEY (company_id, edited_by) REFERENCES company_memberships (company_id, id)
);
COMMENT ON TABLE activity_revisions IS 'The content of an activity before each edit (decision D5). Append-only.';
CREATE INDEX activity_revisions_edited_by_fk_idx ON activity_revisions (company_id, edited_by) WHERE edited_by IS NOT NULL;
CREATE TRIGGER activity_revisions_append_only BEFORE UPDATE OR DELETE ON activity_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
ALTER TABLE activity_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON activity_revisions FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT ON activity_revisions TO estatepro_app;
GRANT SELECT, INSERT ON activity_revisions TO estatepro_platform;

-- Content may change only within 24 hours of logging (D5), never for system
-- entries, and never once archived. Archiving itself is allowed (not for
-- system entries).
CREATE FUNCTION app.activities_edit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  content_changed boolean := (NEW.activity_type, NEW.direction, NEW.subject, NEW.body, NEW.occurred_at, NEW.duration_seconds,
                              NEW.outcome_code, NEW.performed_by, NEW.external_message_id, NEW.created_by, NEW.created_at)
                             IS DISTINCT FROM
                             (OLD.activity_type, OLD.direction, OLD.subject, OLD.body, OLD.occurred_at, OLD.duration_seconds,
                              OLD.outcome_code, OLD.performed_by, OLD.external_message_id, OLD.created_by, OLD.created_at);
  archive_changed boolean := (NEW.archived_at, NEW.archived_by, NEW.archived_reason) IS DISTINCT FROM (OLD.archived_at, OLD.archived_by, OLD.archived_reason);
BEGIN
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
END
$$;
CREATE TRIGGER activities_edit_guard BEFORE UPDATE ON activities FOR EACH ROW EXECUTE FUNCTION app.activities_edit_guard();

-- Activities and their links are kept: archive, never delete, in the application.
REVOKE DELETE ON activities FROM estatepro_app;

-- -----------------------------------------------------------------------------
-- 3. Follow-ups (tasks)
-- -----------------------------------------------------------------------------
ALTER TABLE tasks
  ADD COLUMN cancelled_at  timestamptz,
  ADD COLUMN cancelled_by  uuid,
  ADD COLUMN cancel_reason text CHECK (char_length(cancel_reason) BETWEEN 3 AND 500),
  ADD CONSTRAINT tasks_created_by_fkey FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT tasks_cancelled_by_fkey FOREIGN KEY (company_id, cancelled_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT tasks_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  ADD CONSTRAINT tasks_description_length CHECK (char_length(description) <= 2000),
  ADD CONSTRAINT tasks_remind_before_due CHECK (remind_at IS NULL OR due_at IS NULL OR remind_at <= due_at),
  ADD CONSTRAINT tasks_cancel_complete CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  ADD CONSTRAINT tasks_done_complete CHECK ((status = 'done') = (completed_at IS NOT NULL));
CREATE INDEX tasks_created_by_fk_idx ON tasks (company_id, created_by) WHERE created_by IS NOT NULL;
CREATE INDEX tasks_cancelled_by_fk_idx ON tasks (company_id, cancelled_by) WHERE cancelled_by IS NOT NULL;
CREATE INDEX tasks_completed_by_fk_idx ON tasks (company_id, completed_by) WHERE completed_by IS NOT NULL;
-- Team view (F-2) and done list.
CREATE INDEX tasks_open_due_idx ON tasks (company_id, due_at, id) WHERE status = 'open';
CREATE INDEX tasks_assignee_done_idx ON tasks (company_id, assigned_to, completed_at DESC) WHERE status = 'done';
-- Open follow-ups of a lead set its next action (leads.next_action_at).
CREATE INDEX tasks_entity_open_idx ON tasks (company_id, entity_type, entity_id, due_at) WHERE status = 'open';

-- Follow-ups are cancelled or completed, never deleted, by the application.
REVOKE DELETE ON tasks FROM estatepro_app;

-- -----------------------------------------------------------------------------
-- 4. Activity outcomes (A-2)
-- -----------------------------------------------------------------------------
INSERT INTO picklist_values (company_id, list_key, code, label, country_code, sort_order) VALUES
  (NULL, 'activity_outcome', 'interested',          'Interested',                NULL, 1),
  (NULL, 'activity_outcome', 'not_interested',      'Not interested',            NULL, 2),
  (NULL, 'activity_outcome', 'callback_requested',  'Asked to be called back',   NULL, 3),
  (NULL, 'activity_outcome', 'viewing_requested',   'Wants a viewing',           NULL, 4),
  (NULL, 'activity_outcome', 'information_sent',    'Information sent',          NULL, 5),
  (NULL, 'activity_outcome', 'no_answer',           'No answer',                 NULL, 6),
  (NULL, 'activity_outcome', 'left_message',        'Left a message',            NULL, 7),
  (NULL, 'activity_outcome', 'wrong_number',        'Wrong number',              NULL, 8),
  (NULL, 'activity_outcome', 'other',               'Other',                     NULL, 99);

GRANT EXECUTE ON FUNCTION app.lead_status_change_allowed(text, text) TO estatepro_app, estatepro_platform;
