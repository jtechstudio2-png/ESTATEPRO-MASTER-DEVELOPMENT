-- =============================================================================
-- EstatePro · Migration 0028 · Ownership records and seller identity (Phase 5, P5-H)
-- =============================================================================
-- Ownership records (property "Ownership" tab, LL-1 "add ownership") become
-- a maintained history: who recorded each one and who ended it, and why.
-- A record is never rewritten or deleted by the application: it is ended
-- (effective_to, the last day of ownership) and a new one is added. The owner
-- may still change through a contact merge (repoint, migration 0022).
--
-- Issue #18: the listing publish rule checks that every current owner of the
-- listed unit has a verified identity. Besides the company setting
-- (listing.require_seller_kyc), the rule can be switched on per jurisdiction
-- through jurisdiction_settings. The definition defaults to off; no
-- jurisdiction values are set here (legal review, issue #20).
-- =============================================================================

ALTER TABLE property_ownerships
  ADD COLUMN created_by  uuid,
  ADD COLUMN ended_by    uuid,
  ADD COLUMN ended_at    timestamptz,
  ADD COLUMN end_reason  text CHECK (end_reason IS NULL OR char_length(end_reason) BETWEEN 3 AND 500),
  ADD FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id),
  ADD FOREIGN KEY (company_id, ended_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT property_ownerships_end_recorded CHECK ((ended_by IS NULL AND ended_at IS NULL) OR effective_to IS NOT NULL);

-- What was owned, by whom, from when, stays as recorded. Ending sets
-- effective_to once (with who and why); evidence can be attached once.
CREATE FUNCTION app.property_ownerships_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.company_id, NEW.property_id, NEW.unit_id, NEW.share_percent, NEW.ownership_type, NEW.effective_from, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.company_id, OLD.property_id, OLD.unit_id, OLD.share_percent, OLD.ownership_type, OLD.effective_from, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION 'ownership record % cannot be rewritten; end it and record a new one', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.effective_to IS NOT NULL AND (NEW.effective_to, NEW.ended_by, NEW.ended_at, NEW.end_reason)
       IS DISTINCT FROM (OLD.effective_to, OLD.ended_by, OLD.ended_at, OLD.end_reason) THEN
    RAISE EXCEPTION 'ownership record % has already ended', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.evidence_document_id IS NOT NULL AND NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id THEN
    RAISE EXCEPTION 'the evidence of ownership record % cannot be replaced', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER property_ownerships_guard BEFORE UPDATE ON property_ownerships
  FOR EACH ROW EXECUTE FUNCTION app.property_ownerships_guard();
REVOKE DELETE ON property_ownerships FROM estatepro_app;

COMMENT ON COLUMN property_ownerships.effective_to IS
  'Last day of ownership (inclusive), as app.landlord_unit_access reads it. NULL = still owned.';

-- Current owners of a unit on a date in the property''s time zone: whole-property
-- records and records for that unit. SECURITY INVOKER (row-level security applies).
CREATE FUNCTION app.unit_current_owners(p_unit uuid)
RETURNS TABLE (ownership_id uuid, owner_contact_id uuid)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT o.id, o.owner_contact_id
    FROM units u
    JOIN properties p ON p.company_id = u.company_id AND p.id = u.property_id
    JOIN property_ownerships o ON o.company_id = u.company_id AND o.property_id = u.property_id
                              AND (o.unit_id IS NULL OR o.unit_id = u.id)
   WHERE u.id = p_unit
     AND o.effective_from <= (now() AT TIME ZONE p.timezone)::date
     AND (o.effective_to IS NULL OR o.effective_to >= (now() AT TIME ZONE p.timezone)::date)
$$;
GRANT EXECUTE ON FUNCTION app.unit_current_owners(uuid) TO estatepro_app;

INSERT INTO jurisdiction_setting_definitions (key, data_type, description, default_value) VALUES
  ('listing_owner_identity_required', 'boolean',
   'Listings cannot be published until every current owner of the unit has a verified identity (issue #18)', 'false');
