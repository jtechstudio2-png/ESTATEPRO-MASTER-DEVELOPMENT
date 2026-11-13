-- =============================================================================
-- EstatePro · Migration 0029 · Deterministic history ordering (#15, P6-0)
-- =============================================================================
-- History and audit rows were ordered by their timestamp, then by UUIDv7 id.
-- PostgreSQL's now() is the same for every row of a transaction and UUIDv7 is
-- ordered only to the millisecond, so rows written together (an offer accepted,
-- its deal stage, the listing status and their audit rows) could be read back
-- in either order, and the order could change between reads.
--
-- Every history and audit stream now carries `entry_no`, an insertion-order
-- number from a per-table sequence. Readers sort by (time, entry_no), and
-- keyset cursors carry entry_no as the tie-breaker. The activity timeline has
-- had this since migration 0024; this migration extends it to every stream,
-- including the sales-pipeline histories (deal stage history and offers)
-- before they hold any data.
--
-- Existing rows are numbered in the order users see today (time, then id), so
-- no history changes order on upgrade. The append-only guards are switched off
-- only for that numbering, inside this migration's transaction.
-- =============================================================================

CREATE FUNCTION app.add_entry_no(p_table regclass, p_time text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  seq text := p_table::text || '_entry_no_seq';
  top bigint;
  grantee text;
BEGIN
  EXECUTE format('ALTER TABLE %s ADD COLUMN entry_no bigint', p_table);
  EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', p_table);
  EXECUTE format(
    'UPDATE %1$s t SET entry_no = o.n
       FROM (SELECT id, row_number() OVER (ORDER BY %2$I, id) AS n FROM %1$s) o
      WHERE t.id = o.id', p_table, p_time);
  EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', p_table);
  EXECUTE format('CREATE SEQUENCE %I OWNED BY %s.entry_no', seq, p_table);
  EXECUTE format('SELECT max(entry_no) FROM %s', p_table) INTO top;
  IF top IS NOT NULL THEN
    PERFORM setval(seq, top);
  END IF;
  EXECUTE format('ALTER TABLE %s ALTER COLUMN entry_no SET DEFAULT nextval(%L)', p_table, seq);
  EXECUTE format('ALTER TABLE %s ALTER COLUMN entry_no SET NOT NULL', p_table);
  -- Every role that may insert rows needs the sequence (estatepro_app, estatepro_platform,
  -- and estatepro_auth for sign-in audit events).
  FOR grantee IN
    SELECT DISTINCT g.grantee FROM information_schema.role_table_grants g
     WHERE g.table_schema = 'public' AND g.table_name = p_table::text AND g.privilege_type = 'INSERT'
       AND g.grantee <> current_user AND g.grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('GRANT USAGE ON SEQUENCE %I TO %I', seq, grantee);
  END LOOP;
  EXECUTE format('COMMENT ON COLUMN %s.entry_no IS %L', p_table,
    'Insertion order (#15): breaks ties between rows written at the same time, so this history never reorders.');
END
$$;

SELECT app.add_entry_no('audit_logs', 'occurred_at');
SELECT app.add_entry_no('outbox_events', 'occurred_at');
SELECT app.add_entry_no('listing_status_history', 'changed_at');
SELECT app.add_entry_no('listing_price_history', 'changed_at');
SELECT app.add_entry_no('key_movements', 'occurred_at');
SELECT app.add_entry_no('lead_status_history', 'changed_at');
SELECT app.add_entry_no('lead_assignments', 'assigned_at');
SELECT app.add_entry_no('data_subject_request_events', 'occurred_at');
SELECT app.add_entry_no('data_subject_request_evidence', 'recorded_at');
SELECT app.add_entry_no('consents', 'captured_at');
SELECT app.add_entry_no('kyc_checks', 'created_at');
SELECT app.add_entry_no('deal_stage_history', 'changed_at');
SELECT app.add_entry_no('offers', 'submitted_at');

DROP FUNCTION app.add_entry_no(regclass, text);

-- An insertion number never changes, whoever updates the row: a changed number
-- would reorder the history (for consents, it would change which consent is in
-- force). Some streams are updatable by the runtime roles for other columns, so
-- this is a trigger rather than a column privilege.
CREATE FUNCTION app.entry_no_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the insertion number of % rows never changes (#15)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['activities', 'audit_logs', 'outbox_events', 'listing_status_history', 'listing_price_history',
                           'key_movements', 'lead_status_history', 'lead_assignments', 'data_subject_request_events',
                           'data_subject_request_evidence', 'consents', 'kyc_checks', 'deal_stage_history', 'offers']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF entry_no ON %I FOR EACH ROW
                      WHEN (OLD.entry_no IS DISTINCT FROM NEW.entry_no) EXECUTE FUNCTION app.entry_no_fixed()',
                   t || '_entry_no_fixed', t);
  END LOOP;
END
$$;

-- Each number is used once (audit_logs is partitioned by time, so its
-- uniqueness rests on the sequence alone).
CREATE UNIQUE INDEX outbox_events_entry_no_idx ON outbox_events (entry_no);
CREATE UNIQUE INDEX listing_status_history_entry_no_idx ON listing_status_history (entry_no);
CREATE UNIQUE INDEX listing_price_history_entry_no_idx ON listing_price_history (entry_no);
CREATE UNIQUE INDEX key_movements_entry_no_idx ON key_movements (entry_no);
CREATE UNIQUE INDEX lead_status_history_entry_no_idx ON lead_status_history (entry_no);
CREATE UNIQUE INDEX lead_assignments_entry_no_idx ON lead_assignments (entry_no);
CREATE UNIQUE INDEX dsr_events_entry_no_idx ON data_subject_request_events (entry_no);
CREATE UNIQUE INDEX dsr_evidence_entry_no_idx ON data_subject_request_evidence (entry_no);
CREATE UNIQUE INDEX consents_entry_no_idx ON consents (entry_no);
CREATE UNIQUE INDEX kyc_checks_entry_no_idx ON kyc_checks (entry_no);
CREATE UNIQUE INDEX deal_stage_history_entry_no_idx ON deal_stage_history (entry_no);
CREATE UNIQUE INDEX offers_entry_no_idx ON offers (entry_no);

-- Read paths sort by (time, entry_no): the indexes end with it.
DROP INDEX audit_logs_entity_idx;
CREATE INDEX audit_logs_entity_idx ON audit_logs (company_id, entity_type, entity_id, occurred_at DESC, entry_no DESC);
DROP INDEX outbox_events_unpublished_idx;
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (entry_no) WHERE published_at IS NULL;
DROP INDEX listing_status_history_idx;
CREATE INDEX listing_status_history_idx ON listing_status_history (company_id, listing_id, changed_at, entry_no);
DROP INDEX listing_price_history_idx;
CREATE INDEX listing_price_history_idx ON listing_price_history (company_id, listing_id, changed_at, entry_no);
DROP INDEX key_movements_key_idx;
CREATE INDEX key_movements_key_idx ON key_movements (company_id, key_set_id, occurred_at DESC, entry_no DESC);
DROP INDEX lead_status_history_lead_idx;
CREATE INDEX lead_status_history_lead_idx ON lead_status_history (company_id, lead_id, changed_at, entry_no);
DROP INDEX lead_assignments_lead_idx;
CREATE INDEX lead_assignments_lead_idx ON lead_assignments (company_id, lead_id, assigned_at, entry_no);
DROP INDEX dsr_events_request_idx;
CREATE INDEX dsr_events_request_idx ON data_subject_request_events (company_id, request_id, occurred_at, entry_no);
DROP INDEX dsr_evidence_request_idx;
CREATE INDEX dsr_evidence_request_idx ON data_subject_request_evidence (company_id, request_id, recorded_at, entry_no);
DROP INDEX consents_contact_idx;
CREATE INDEX consents_contact_idx ON consents (company_id, contact_id, purpose, channel, captured_at DESC, entry_no DESC);
DROP INDEX kyc_checks_contact_idx;
CREATE INDEX kyc_checks_contact_idx ON kyc_checks (company_id, contact_id, check_type, created_at DESC, entry_no DESC);
DROP INDEX deal_stage_history_idx;
CREATE INDEX deal_stage_history_idx ON deal_stage_history (company_id, deal_id, changed_at, entry_no);
DROP INDEX offers_deal_idx;
CREATE INDEX offers_deal_idx ON offers (company_id, deal_id, submitted_at, entry_no);
