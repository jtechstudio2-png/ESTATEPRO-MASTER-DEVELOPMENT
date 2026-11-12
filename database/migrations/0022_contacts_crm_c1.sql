-- =============================================================================
-- EstatePro · Migration 0022 · Contacts API (Phase 5 milestone C1)
-- =============================================================================
-- 1. Archive reason and actor for contacts (wireframe C-2).
-- 2. Search that treats Arabic spelling variants alike (verification gap G5).
-- 3. Contact merge (wireframe C-4, CRM-02): a register that classifies every
--    column referencing contacts, and a function that moves references from
--    the merged contact to the kept one. Merges are only ever requested by a
--    person; nothing here merges automatically.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Archive reason
-- -----------------------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN archived_reason text CHECK (char_length(archived_reason) BETWEEN 3 AND 500),
  ADD COLUMN archived_by     uuid,
  ADD CONSTRAINT contacts_archived_by_fkey FOREIGN KEY (company_id, archived_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT contacts_archive_reason_complete CHECK (archived_at IS NOT NULL OR (archived_reason IS NULL AND archived_by IS NULL)),
  ADD CONSTRAINT contacts_merged_are_archived CHECK (merged_into_contact_id IS NULL OR archived_at IS NOT NULL);

-- -----------------------------------------------------------------------------
-- 2. Search normalisation (G5)
-- -----------------------------------------------------------------------------
-- Lower case; Arabic diacritics (harakat, superscript alef) and tatweel removed;
-- alef variants → ا, alef maqsura → ي, ta marbuta → ه, hamza carriers → bare
-- letters. The API applies the same rules to search text.
CREATE FUNCTION app.search_normalise(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT translate(
           regexp_replace(lower(value), '[ً-ٰٟـ]', '', 'g'),
           'أإآٱىةؤئ',
           'اااايهوي')
$$;

DROP INDEX contacts_search_idx;
ALTER TABLE contacts DROP COLUMN search_vector;
ALTER TABLE contacts ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', app.search_normalise(
    coalesce(display_name, '') || ' ' || coalesce(display_name_local, '') || ' ' ||
    coalesce(organisation_name, '') || ' ' || coalesce(primary_email::text, '') || ' ' ||
    coalesce(primary_phone_e164, '') || ' ' || coalesce(reference, '')))) STORED;
CREATE INDEX contacts_search_idx ON contacts USING gin (search_vector);
CREATE INDEX contacts_name_local_trgm_idx ON contacts USING gin (app.search_normalise(display_name_local) gin_trgm_ops)
  WHERE display_name_local IS NOT NULL;
-- Register sorts (keyset paging) and phone search by any part of a number.
CREATE INDEX contacts_company_updated_idx ON contacts (company_id, updated_at DESC, id DESC) WHERE merged_into_contact_id IS NULL;
CREATE INDEX contacts_company_created_idx ON contacts (company_id, created_at DESC, id DESC) WHERE merged_into_contact_id IS NULL;
CREATE INDEX contacts_company_name_idx ON contacts (company_id, display_name, id) WHERE merged_into_contact_id IS NULL;
CREATE INDEX contact_methods_normalised_trgm_idx ON contact_methods USING gin (normalised gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- 3. Contact merge
-- -----------------------------------------------------------------------------
-- How each column that references a contact is treated when two contacts are
-- merged. A catalogue test fails when a foreign key to contacts is missing here.
--   repoint  move the reference to the kept contact
--   history  leave it on the merged contact (append-only history); readers
--            follow contacts.merged_into_contact_id
--   block    the merge is refused while the merged contact has such rows
--            (financial and contractual records are never re-attributed)
--   self     contacts.merged_into_contact_id itself
CREATE TABLE contact_reference_columns (
  table_name   text  NOT NULL,
  column_name  text  NOT NULL,
  handling     text  NOT NULL CHECK (handling IN ('repoint', 'history', 'block', 'self')),
  reason       text  NOT NULL,
  PRIMARY KEY (table_name, column_name)
);
COMMENT ON TABLE contact_reference_columns IS 'Merge handling for every column that references contacts (wireframe C-4). Platform reference data.';

INSERT INTO contact_reference_columns (table_name, column_name, handling, reason) VALUES
  ('contact_relationships',   'contact_id',             'repoint', 'Roles move to the kept contact; duplicates of an active role are ended'),
  ('contact_methods',         'contact_id',             'repoint', 'Contact methods move; exact duplicates are folded into the kept method'),
  ('contact_links',           'contact_id',             'repoint', 'Links move; duplicate and self links are removed'),
  ('contact_links',           'related_contact_id',     'repoint', 'Links move; duplicate and self links are removed'),
  ('consents',                'contact_id',             'repoint', 'Consent history moves; a withdrawal on either contact stays in force'),
  ('requirements',            'contact_id',             'repoint', 'Buyer and tenant requirements move'),
  ('leads',                   'contact_id',             'repoint', 'Leads move'),
  ('identity_documents',      'contact_id',             'repoint', 'Identity evidence moves (values are bound to the document row, not the contact)'),
  ('kyc_checks',              'contact_id',             'repoint', 'Identity checks move'),
  ('property_ownerships',     'owner_contact_id',       'repoint', 'Ownership records describe the same person'),
  ('key_sets',                'holder_contact_id',      'repoint', 'Current key holder'),
  ('viewing_attendees',       'contact_id',             'repoint', 'Viewing attendance; duplicates removed'),
  ('deals',                   'primary_contact_id',     'repoint', 'Sales pipeline (Phase 6)'),
  ('deal_parties',            'contact_id',             'repoint', 'Deal parties; duplicates removed'),
  ('developments',            'developer_contact_id',   'repoint', 'Developer of a development'),
  ('document_shares',         'shared_with_contact_id', 'repoint', 'Documents shared with the person'),
  ('invitations',             'contact_id',             'repoint', 'Pending portal invitations'),
  ('company_memberships',     'contact_id',             'repoint', 'Portal access; refused when both contacts have one'),
  ('maintenance_requests',    'reported_by_contact_id', 'repoint', 'Repair reporter'),
  ('maintenance_requests',    'approved_by_contact_id', 'repoint', 'Repair approver'),
  ('maintenance_assignments', 'supplier_contact_id',    'repoint', 'Supplier on a work order'),
  ('maintenance_quotes',      'supplier_contact_id',    'repoint', 'Supplier quotes'),
  ('planned_maintenance',     'supplier_contact_id',    'repoint', 'Planned maintenance supplier'),
  ('key_movements',           'holder_contact_id',      'history', 'Key movements are append-only'),
  ('message_deliveries',      'recipient_contact_id',   'history', 'Delivery records are evidence of what was sent to whom'),
  ('document_versions',       'uploaded_by_contact_id', 'history', 'Document versions are immutable'),
  ('maintenance_updates',     'author_contact_id',      'history', 'Work-order updates are a timeline'),
  ('offers',                  'offered_by_contact_id',  'history', 'Offer history is immutable (Phase 1 journey 7.1)'),
  ('contact_payment_accounts','contact_id',             'block',   'Payout accounts are verified per person; re-attribution needs finance review'),
  ('ledger_entries',          'contact_id',             'block',   'Posted ledger entries are never re-attributed'),
  ('payments',                'payer_contact_id',       'block',   'Receipts are financial records'),
  ('payouts',                 'payee_contact_id',       'block',   'Payouts are financial records'),
  ('statements',              'landlord_contact_id',    'block',   'Issued statements are financial records'),
  ('finance_transactions',    'counterparty_contact_id','block',   'Financial records'),
  ('supplier_invoices',       'supplier_contact_id',    'block',   'Financial records'),
  ('lease_parties',           'contact_id',             'block',   'Lease parties are contractual'),
  ('management_agreements',   'landlord_contact_id',    'block',   'Management agreements are contractual'),
  ('contacts',                'merged_into_contact_id', 'self',    'Earlier merges into the merged contact are pointed at the kept contact');

-- Polymorphic references (entity_type = 'contact') handled by the merge function.
-- activity_links, tasks and document_links; audit_logs are never rewritten.

REVOKE ALL ON contact_reference_columns FROM PUBLIC;
GRANT SELECT ON contact_reference_columns TO estatepro_app, estatepro_platform;

-- Moves every 'repoint' reference and polymorphic link from p_merge to p_keep
-- in the current company, resolving uniqueness conflicts. Runs with the
-- caller's rights, so row-level security limits it to the caller's company.
-- Returns the number of rows moved per table. Field choices, protected values
-- and consent precedence are handled by the API in the same transaction.
CREATE FUNCTION app.merge_contact_references(p_keep uuid, p_merge uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  company uuid := app.current_company_id();
  ref record;
  moved jsonb := '{}'::jsonb;
  n bigint;
BEGIN
  IF company IS NULL THEN
    RAISE EXCEPTION 'merge_contact_references: no company context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_keep = p_merge THEN
    RAISE EXCEPTION 'merge_contact_references: a contact cannot be merged into itself' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM contacts WHERE company_id = company AND id IN (p_keep, p_merge) HAVING count(*) = 2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge_contact_references: both contacts must belong to the current company' USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Conflicts first: rows that would duplicate a unique key on the kept contact.
  UPDATE contact_relationships SET status = 'inactive', ended_on = current_date
   WHERE company_id = company AND contact_id = p_merge AND status = 'active'
     AND relationship_type IN (SELECT relationship_type FROM contact_relationships
                                WHERE company_id = company AND contact_id = p_keep AND status = 'active');
  UPDATE contact_methods k SET
         verified_at  = coalesce(k.verified_at, m.verified_at),
         opted_out_at = CASE WHEN k.opted_out_at IS NULL THEN m.opted_out_at
                             WHEN m.opted_out_at IS NULL THEN k.opted_out_at
                             ELSE least(k.opted_out_at, m.opted_out_at) END
    FROM contact_methods m
   WHERE k.company_id = company AND m.company_id = company
     AND k.contact_id = p_keep AND m.contact_id = p_merge
     AND k.method_type = m.method_type AND k.normalised = m.normalised;
  DELETE FROM contact_methods m
   WHERE m.company_id = company AND m.contact_id = p_merge
     AND EXISTS (SELECT 1 FROM contact_methods k WHERE k.company_id = company AND k.contact_id = p_keep
                    AND k.method_type = m.method_type AND k.normalised = m.normalised);
  UPDATE contact_methods SET is_primary = false WHERE company_id = company AND contact_id = p_merge;
  DELETE FROM contact_links WHERE company_id = company
     AND ((contact_id = p_merge AND related_contact_id = p_keep) OR (contact_id = p_keep AND related_contact_id = p_merge));
  DELETE FROM contact_links m WHERE m.company_id = company AND m.contact_id = p_merge
     AND EXISTS (SELECT 1 FROM contact_links k WHERE k.company_id = company AND k.contact_id = p_keep
                    AND k.related_contact_id = m.related_contact_id AND k.link_type = m.link_type);
  DELETE FROM contact_links m WHERE m.company_id = company AND m.related_contact_id = p_merge
     AND EXISTS (SELECT 1 FROM contact_links k WHERE k.company_id = company AND k.related_contact_id = p_keep
                    AND k.contact_id = m.contact_id AND k.link_type = m.link_type);
  DELETE FROM viewing_attendees m WHERE m.company_id = company AND m.contact_id = p_merge
     AND EXISTS (SELECT 1 FROM viewing_attendees k WHERE k.company_id = company AND k.contact_id = p_keep AND k.viewing_id = m.viewing_id);
  DELETE FROM deal_parties m WHERE m.company_id = company AND m.contact_id = p_merge
     AND EXISTS (SELECT 1 FROM deal_parties k WHERE k.company_id = company AND k.contact_id = p_keep
                    AND k.deal_id = m.deal_id AND k.party_role = m.party_role);

  FOR ref IN SELECT table_name, column_name FROM contact_reference_columns WHERE handling IN ('repoint', 'self') ORDER BY table_name, column_name LOOP
    EXECUTE format('UPDATE %I SET %I = $1 WHERE company_id = $2 AND %I = $3', ref.table_name, ref.column_name, ref.column_name)
      USING p_keep, company, p_merge;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      moved := moved || jsonb_build_object(ref.table_name || '.' || ref.column_name, n);
    END IF;
  END LOOP;

  -- Polymorphic links.
  DELETE FROM activity_links m WHERE m.company_id = company AND m.entity_type = 'contact' AND m.entity_id = p_merge
     AND EXISTS (SELECT 1 FROM activity_links k WHERE k.company_id = company AND k.activity_id = m.activity_id
                    AND k.entity_type = 'contact' AND k.entity_id = p_keep);
  UPDATE activity_links SET entity_id = p_keep WHERE company_id = company AND entity_type = 'contact' AND entity_id = p_merge;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN moved := moved || jsonb_build_object('activity_links.entity_id', n); END IF;
  UPDATE tasks SET entity_id = p_keep WHERE company_id = company AND entity_type = 'contact' AND entity_id = p_merge;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN moved := moved || jsonb_build_object('tasks.entity_id', n); END IF;
  DELETE FROM document_links m WHERE m.company_id = company AND m.entity_type = 'contact' AND m.entity_id = p_merge
     AND EXISTS (SELECT 1 FROM document_links k WHERE k.company_id = company AND k.document_id = m.document_id
                    AND k.entity_type = 'contact' AND k.entity_id = p_keep);
  UPDATE document_links SET entity_id = p_keep WHERE company_id = company AND entity_type = 'contact' AND entity_id = p_merge;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN moved := moved || jsonb_build_object('document_links.entity_id', n); END IF;

  RETURN moved;
END;
$$;
GRANT EXECUTE ON FUNCTION app.merge_contact_references(uuid, uuid) TO estatepro_app;

-- Rows that prevent a merge: one entry per 'block' table that holds rows for the contact.
CREATE FUNCTION app.contact_merge_blockers(p_contact uuid) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  company uuid := app.current_company_id();
  ref record;
  found_rows boolean;
  blockers text[] := '{}';
BEGIN
  FOR ref IN SELECT table_name, column_name FROM contact_reference_columns WHERE handling = 'block' ORDER BY table_name LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE company_id = $1 AND %I = $2)', ref.table_name, ref.column_name)
      INTO found_rows USING company, p_contact;
    IF found_rows THEN blockers := blockers || ref.table_name; END IF;
  END LOOP;
  RETURN blockers;
END;
$$;
GRANT EXECUTE ON FUNCTION app.contact_merge_blockers(uuid) TO estatepro_app;

-- How many rows reference a contact, per table and column (merge preview, wireframe C-4).
CREATE FUNCTION app.contact_reference_counts(p_contact uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  company uuid := app.current_company_id();
  ref record;
  n bigint;
  counts jsonb := '{}'::jsonb;
BEGIN
  FOR ref IN SELECT table_name, column_name FROM contact_reference_columns WHERE handling <> 'self' ORDER BY table_name, column_name LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE company_id = $1 AND %I = $2', ref.table_name, ref.column_name) INTO n USING company, p_contact;
    IF n > 0 THEN counts := counts || jsonb_build_object(ref.table_name || '.' || ref.column_name, n); END IF;
  END LOOP;
  SELECT count(*) INTO n FROM activity_links WHERE company_id = company AND entity_type = 'contact' AND entity_id = p_contact;
  IF n > 0 THEN counts := counts || jsonb_build_object('activity_links.entity_id', n); END IF;
  SELECT count(*) INTO n FROM tasks WHERE company_id = company AND entity_type = 'contact' AND entity_id = p_contact;
  IF n > 0 THEN counts := counts || jsonb_build_object('tasks.entity_id', n); END IF;
  SELECT count(*) INTO n FROM document_links WHERE company_id = company AND entity_type = 'contact' AND entity_id = p_contact;
  IF n > 0 THEN counts := counts || jsonb_build_object('document_links.entity_id', n); END IF;
  RETURN counts;
END;
$$;
GRANT EXECUTE ON FUNCTION app.contact_reference_counts(uuid) TO estatepro_app;
