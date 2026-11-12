-- =============================================================================
-- EstatePro · Migration 0025 · Dashboards, landlord visibility and exports
-- (Phase 5 milestone C4)
-- =============================================================================
-- 1. Landlord visibility resolver (issue #12, landlord part): which units,
--    properties and listings a landlord contact is linked to, through current
--    ownerships and active management agreements. "Current" is judged in each
--    property's own time zone, so access ends the day after an ownership's
--    last day there. Phase 5 uses it for the staff preview (wireframe LL-1);
--    the landlord portal (Phase 7) will use the same functions.
-- 2. Exports (CA-16): what was exported, how many rows, when it expires,
--    and that the file is never edited after it is written.
-- 3. Indexes for the dashboard panels (CA-14).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Landlord visibility resolver
-- -----------------------------------------------------------------------------
-- One row per unit the contact may see, with the record that grants it.
-- SECURITY INVOKER: row-level security still limits it to the caller's company.
CREATE FUNCTION app.landlord_unit_access(p_contact uuid)
RETURNS TABLE (property_id uuid, unit_id uuid, basis text, basis_id uuid)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT o.property_id, u.id, 'ownership'::text, o.id
    FROM property_ownerships o
    JOIN properties p ON p.company_id = o.company_id AND p.id = o.property_id
    JOIN units u ON u.company_id = o.company_id AND u.property_id = o.property_id AND (o.unit_id IS NULL OR u.id = o.unit_id)
   WHERE o.owner_contact_id = p_contact
     AND o.effective_from <= (now() AT TIME ZONE p.timezone)::date
     AND (o.effective_to IS NULL OR o.effective_to >= (now() AT TIME ZONE p.timezone)::date)
  UNION ALL
  SELECT m.property_id, u.id, 'management_agreement'::text, m.id
    FROM management_agreements m
    JOIN properties p ON p.company_id = m.company_id AND p.id = m.property_id
    JOIN units u ON u.company_id = m.company_id AND u.property_id = m.property_id AND (m.unit_id IS NULL OR u.id = m.unit_id)
   WHERE m.landlord_contact_id = p_contact
     AND m.status = 'active'
     AND m.start_date <= (now() AT TIME ZONE p.timezone)::date
     AND (m.end_date IS NULL OR m.end_date >= (now() AT TIME ZONE p.timezone)::date)
$$;
COMMENT ON FUNCTION app.landlord_unit_access(uuid) IS
  'Issue #12: units a landlord contact is linked to (current ownership or active management agreement, in the property time zone).';

CREATE FUNCTION app.landlord_property_ids(p_contact uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT DISTINCT property_id FROM app.landlord_unit_access(p_contact)
$$;

CREATE FUNCTION app.landlord_listing_ids(p_contact uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT l.id FROM listings l
   WHERE l.unit_id IN (SELECT unit_id FROM app.landlord_unit_access(p_contact)) AND l.archived_at IS NULL
$$;

CREATE INDEX property_ownerships_owner_all_idx ON property_ownerships (company_id, owner_contact_id, effective_from);
CREATE INDEX management_agreements_landlord_all_idx ON management_agreements (company_id, landlord_contact_id, status);

-- -----------------------------------------------------------------------------
-- 1b. Faster requirement matching (found by the C4 dashboard performance test)
-- -----------------------------------------------------------------------------
-- The exact area test (app.requirement_area_covers) reads the areas JSON for
-- every candidate listing. These generated columns let matching rule most
-- listings out first with a cheap comparison, and run the exact test only on
-- likely matches. The result is unchanged: the exact test still decides.
CREATE FUNCTION app.requirement_area_localities(areas jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT lower(a ->> 'locality')), '{}')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(areas) = 'array' THEN areas ELSE '[]' END) AS e(a) WHERE a ->> 'kind' = 'locality'
$$;

-- Bounding box (in degrees) around every radius and drawn area, widened by
-- 1 % so it always contains the exact shape; null when there are none.
CREATE FUNCTION app.requirement_area_bbox(areas jsonb) RETURNS geometry
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ST_SetSRID(ST_Extent(g)::geometry, 4326) FROM (
    SELECT CASE a ->> 'kind'
             WHEN 'radius' THEN ST_MakeEnvelope(
               (a ->> 'longitude')::float8 - (a ->> 'radiusMetres')::float8 * 1.01 / (111320 * greatest(cos(radians((a ->> 'latitude')::float8)), 0.01)),
               (a ->> 'latitude')::float8  - (a ->> 'radiusMetres')::float8 * 1.01 / 110574,
               (a ->> 'longitude')::float8 + (a ->> 'radiusMetres')::float8 * 1.01 / (111320 * greatest(cos(radians((a ->> 'latitude')::float8)), 0.01)),
               (a ->> 'latitude')::float8  + (a ->> 'radiusMetres')::float8 * 1.01 / 110574, 4326)
             WHEN 'polygon' THEN ST_Envelope(ST_SetSRID(ST_GeomFromGeoJSON(jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array(a -> 'points'))), 4326))
           END AS g
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(areas) = 'array' THEN areas ELSE '[]' END) AS e(a)
     WHERE a ->> 'kind' IN ('radius', 'polygon')) shapes
$$;

ALTER TABLE requirements
  ADD COLUMN area_anywhere    boolean  GENERATED ALWAYS AS (locations = '[]'::jsonb) STORED,
  ADD COLUMN area_localities  text[]   GENERATED ALWAYS AS (app.requirement_area_localities(locations)) STORED,
  ADD COLUMN area_bbox        geometry GENERATED ALWAYS AS (app.requirement_area_bbox(locations)) STORED;
-- Matching from an area. Under row-level security PostgreSQL only uses an
-- index for leakproof comparisons (text and float8 are; lower() and the
-- PostGIS operators are not), so the search keys are stored plainly.
ALTER TABLE addresses
  ADD COLUMN locality_key  text    GENERATED ALWAYS AS (lower(locality)) STORED,
  ADD COLUMN latitude_f    float8  GENERATED ALWAYS AS (latitude::float8) STORED,
  ADD COLUMN longitude_f   float8  GENERATED ALWAYS AS (longitude::float8) STORED;
CREATE INDEX addresses_locality_key_idx ON addresses (company_id, locality_key) WHERE locality_key IS NOT NULL;
CREATE INDEX addresses_lat_lng_idx ON addresses (company_id, latitude_f, longitude_f) WHERE latitude_f IS NOT NULL;
ALTER TABLE requirements
  ADD COLUMN area_west   float8 GENERATED ALWAYS AS (ST_XMin(app.requirement_area_bbox(locations))) STORED,
  ADD COLUMN area_south  float8 GENERATED ALWAYS AS (ST_YMin(app.requirement_area_bbox(locations))) STORED,
  ADD COLUMN area_east   float8 GENERATED ALWAYS AS (ST_XMax(app.requirement_area_bbox(locations))) STORED,
  ADD COLUMN area_north  float8 GENERATED ALWAYS AS (ST_YMax(app.requirement_area_bbox(locations))) STORED;
COMMENT ON COLUMN requirements.area_bbox IS 'Prefilter for matching; the exact test is app.requirement_area_covers. Never written by the application.';

-- Whether each active requirement has at least one match, refreshed by the
-- worker (the CRM dashboard's "no match" count). Kept apart from requirements
-- so a refresh never changes a requirement's version or update time.
CREATE TABLE requirement_match_status (
  company_id      uuid         NOT NULL,
  requirement_id  uuid         NOT NULL,
  has_match       boolean      NOT NULL,
  checked_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, requirement_id),
  FOREIGN KEY (company_id, requirement_id) REFERENCES requirements (company_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE requirement_match_status IS 'Derived: refreshed every 15 minutes by the worker job requirement.match_refresh (decision D4 rules).';
ALTER TABLE requirement_match_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON requirement_match_status FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON requirement_match_status TO estatepro_app, estatepro_platform;

-- -----------------------------------------------------------------------------
-- 2. Exports
-- -----------------------------------------------------------------------------
ALTER TABLE export_jobs
  ADD COLUMN file_name        text,
  ADD COLUMN failure_reason   text CHECK (char_length(failure_reason) <= 500),
  ADD COLUMN download_count   integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  ADD CONSTRAINT export_jobs_completed_has_file CHECK (status <> 'completed' OR (storage_key IS NOT NULL AND row_count IS NOT NULL AND expires_at IS NOT NULL AND finished_at IS NOT NULL)),
  ADD CONSTRAINT export_jobs_failed_has_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL);
CREATE INDEX export_jobs_company_created_idx ON export_jobs (company_id, created_at DESC, id DESC);
CREATE INDEX export_jobs_requester_created_idx ON export_jobs (company_id, requested_by, created_at DESC);

-- What was exported and by whom stays on record: the file expires, the job row does not.
CREATE FUNCTION app.export_jobs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'expired') AND (
       NEW.export_type, NEW.format, NEW.parameters, NEW.storage_key, NEW.row_count, NEW.requested_by, NEW.created_at, NEW.file_name, NEW.failure_reason
     ) IS DISTINCT FROM (
       OLD.export_type, OLD.format, OLD.parameters, OLD.storage_key, OLD.row_count, OLD.requested_by, OLD.created_at, OLD.file_name, OLD.failure_reason
     ) THEN
    RAISE EXCEPTION 'export % is finished and cannot be changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('failed', 'expired') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'export % is %', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER export_jobs_guard BEFORE UPDATE ON export_jobs FOR EACH ROW EXECUTE FUNCTION app.export_jobs_guard();
REVOKE DELETE ON export_jobs FROM estatepro_app;

-- -----------------------------------------------------------------------------
-- 3. Dashboard indexes
-- -----------------------------------------------------------------------------
CREATE INDEX contacts_without_owner_idx ON contacts (company_id, office_id)
  WHERE owner_membership_id IS NULL AND merged_into_contact_id IS NULL AND archived_at IS NULL;
CREATE INDEX consents_withdrawn_idx ON consents (company_id, captured_at DESC) WHERE status = 'withdrawn';
CREATE INDEX kyc_checks_expiry_idx ON kyc_checks (company_id, expires_on) WHERE status = 'verified' AND expires_on IS NOT NULL;
CREATE INDEX audit_logs_action_time_idx ON audit_logs (company_id, action, occurred_at DESC);
CREATE INDEX leads_office_received_idx ON leads (company_id, office_id, received_at DESC) WHERE archived_at IS NULL;
CREATE INDEX lead_status_history_to_idx ON lead_status_history (company_id, to_status, changed_at);

GRANT EXECUTE ON FUNCTION app.landlord_unit_access(uuid), app.landlord_property_ids(uuid), app.landlord_listing_ids(uuid),
  app.requirement_area_localities(jsonb), app.requirement_area_bbox(jsonb) TO estatepro_app, estatepro_platform;
