-- =============================================================================
-- EstatePro · Migration 0023 · Requirements, identity documents and KYC
-- (Phase 5 milestone C2)
-- =============================================================================
-- 1. Requirement areas and matching helpers (CRM-03, wireframes B-1 and B-2,
--    approved matching rule D4).
-- 2. "Not suitable" listings for a requirement (verification gap G2).
-- 3. Identity documents: edit history columns, archive, and protection of
--    verified documents (CRM-09, wireframe C-5).
-- 4. KYC checks: who recorded a check, the document examined, the reviewer's
--    reason, and protection of signed-off checks (CRM-09, wireframe SE-1).
-- Identity numbers stay encrypted (ADR-007); nothing here reads them.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Requirement areas and matching helpers
-- -----------------------------------------------------------------------------
-- requirements.locations holds up to ten areas; a listing is inside the
-- requirement's area when it is inside any of them. An empty list means
-- "anywhere". The API validates each area before writing:
--   {"kind":"locality","locality":"East Legon","adminArea1":"Greater Accra"|null}
--   {"kind":"radius","latitude":5.63,"longitude":-0.17,"radiusMetres":2000}
--   {"kind":"polygon","points":[[lng,lat],…,[lng,lat]]}   closed ring
ALTER TABLE requirements
  ADD CONSTRAINT requirements_locations_array CHECK (jsonb_typeof(locations) = 'array' AND jsonb_array_length(locations) <= 10),
  ADD CONSTRAINT requirements_bedrooms_range CHECK (max_bedrooms IS NULL OR min_bedrooms IS NULL OR max_bedrooms >= min_bedrooms),
  ADD CONSTRAINT requirements_rent_priced_per_period
    CHECK (requirement_type = 'buy' OR (min_price IS NULL AND max_price IS NULL) OR rent_frequency IS NOT NULL),
  ADD CONSTRAINT requirements_notes_length CHECK (char_length(notes) <= 2000),
  ADD COLUMN created_by uuid,
  ADD CONSTRAINT requirements_created_by_fkey FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id);
CREATE INDEX requirements_created_by_fk_idx ON requirements (company_id, created_by) WHERE created_by IS NOT NULL;
-- Register (B-1): newest first within a status.
CREATE INDEX requirements_register_idx ON requirements (company_id, status, updated_at DESC, id DESC);

-- Whether a point and its address are inside a requirement's areas.
CREATE FUNCTION app.requirement_area_covers(areas jsonb, locality text, admin_area text, location geography)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_array_length(areas) = 0 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(areas) AS a(area)
     WHERE CASE a.area ->> 'kind'
             WHEN 'locality' THEN
               lower(locality) = lower(a.area ->> 'locality')
               AND (a.area ->> 'adminArea1' IS NULL OR lower(admin_area) = lower(a.area ->> 'adminArea1'))
             WHEN 'radius' THEN
               location IS NOT NULL AND ST_DWithin(
                 location,
                 ST_SetSRID(ST_MakePoint((a.area ->> 'longitude')::float8, (a.area ->> 'latitude')::float8), 4326)::geography,
                 (a.area ->> 'radiusMetres')::float8)
             WHEN 'polygon' THEN
               location IS NOT NULL AND ST_Covers(
                 ST_SetSRID(ST_GeomFromGeoJSON(jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array(a.area -> 'points'))), 4326),
                 location::geometry)
             ELSE false
           END)
$$;

-- A rent expressed per another period, for comparing a listing's rent with a
-- budget (for example 72,000 a year is 6,000 a month). Exact arithmetic on
-- numeric; weeks convert through 52 weeks a year.
CREATE FUNCTION app.rent_per_period(amount numeric, from_frequency text, to_frequency text)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT amount * f.per_year / t.per_year
    FROM (VALUES ('weekly', 52::numeric), ('monthly', 12), ('quarterly', 4), ('semi_annual', 2), ('annual', 1)) AS f (code, per_year),
         (VALUES ('weekly', 52::numeric), ('monthly', 12), ('quarterly', 4), ('semi_annual', 2), ('annual', 1)) AS t (code, per_year)
   WHERE f.code = from_frequency AND t.code = to_frequency
$$;

-- The price a budget is compared with: the sale price, or the rent per year.
-- Budgets are converted the same way (requirements.comparable_*), so the
-- comparison is exact: periods convert by whole-number multiples only.
-- The whole-unit copies (*_floor, bigint) give the index a range it may use
-- under row-level security (bigint comparison is leakproof, numeric is not);
-- the exact numeric comparison is then applied to that narrower range.
ALTER TABLE listings
  ADD COLUMN comparable_price numeric(21,4) GENERATED ALWAYS AS (
    CASE WHEN rent_frequency IS NULL THEN price ELSE app.rent_per_period(price, rent_frequency, 'annual') END) STORED,
  ADD COLUMN comparable_price_floor bigint GENERATED ALWAYS AS (
    floor(CASE WHEN rent_frequency IS NULL THEN price ELSE app.rent_per_period(price, rent_frequency, 'annual') END)::bigint) STORED;
COMMENT ON COLUMN listings.comparable_price IS 'Sale price, or rent per year; for requirement matching (decision D4). Never written by the application.';

ALTER TABLE requirements
  ADD COLUMN comparable_min_price numeric(21,4) GENERATED ALWAYS AS (
    CASE WHEN rent_frequency IS NULL THEN min_price ELSE app.rent_per_period(min_price, rent_frequency, 'annual') END) STORED,
  ADD COLUMN comparable_max_price numeric(21,4) GENERATED ALWAYS AS (
    CASE WHEN rent_frequency IS NULL THEN max_price ELSE app.rent_per_period(max_price, rent_frequency, 'annual') END) STORED,
  ADD COLUMN comparable_min_floor bigint GENERATED ALWAYS AS (
    floor(coalesce(CASE WHEN rent_frequency IS NULL THEN min_price ELSE app.rent_per_period(min_price, rent_frequency, 'annual') END, 0))::bigint) STORED,
  ADD COLUMN comparable_max_floor bigint GENERATED ALWAYS AS (
    floor(coalesce(CASE WHEN rent_frequency IS NULL THEN max_price ELSE app.rent_per_period(max_price, rent_frequency, 'annual') END,
                   9223372036854775807))::bigint) STORED;
COMMENT ON COLUMN requirements.comparable_min_price IS 'Budget bounds in the terms of listings.comparable_price (rent per year). Never written by the application.';

-- Candidate listings for matching: published, not archived, by type, currency and price.
CREATE INDEX listings_matching_idx ON listings (company_id, listing_type, currency_code, comparable_price_floor)
  WHERE is_published AND archived_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2. Listings marked "not suitable" for a requirement (G2)
-- -----------------------------------------------------------------------------
CREATE TABLE requirement_exclusions (
  id              uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id      uuid         NOT NULL,
  requirement_id  uuid         NOT NULL,
  listing_id      uuid         NOT NULL,
  reason          text         NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  excluded_by     uuid,
  excluded_at     timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, requirement_id, listing_id),
  FOREIGN KEY (company_id, requirement_id) REFERENCES requirements (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id),
  FOREIGN KEY (company_id, excluded_by) REFERENCES company_memberships (company_id, id)
);
COMMENT ON TABLE requirement_exclusions IS 'Listings a person marked "not suitable" for a requirement; they no longer appear as matches (wireframe B-2, gap G2).';
CREATE INDEX requirement_exclusions_listing_id_fk_idx ON requirement_exclusions (company_id, listing_id);
CREATE INDEX requirement_exclusions_excluded_by_fk_idx ON requirement_exclusions (company_id, excluded_by) WHERE excluded_by IS NOT NULL;

ALTER TABLE requirement_exclusions ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON requirement_exclusions FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
-- Exclusions are added or removed, never edited.
GRANT SELECT, INSERT, DELETE ON requirement_exclusions TO estatepro_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON requirement_exclusions TO estatepro_platform;

-- -----------------------------------------------------------------------------
-- 3. Identity documents
-- -----------------------------------------------------------------------------
ALTER TABLE identity_documents
  ADD COLUMN created_by       uuid,
  ADD COLUMN updated_at       timestamptz  NOT NULL DEFAULT now(),
  ADD COLUMN version          integer      NOT NULL DEFAULT 1,
  ADD COLUMN archived_at      timestamptz,
  ADD COLUMN archived_by      uuid,
  ADD COLUMN archived_reason  text CHECK (char_length(archived_reason) BETWEEN 3 AND 500),
  ADD CONSTRAINT identity_documents_created_by_fkey FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT identity_documents_archived_by_fkey FOREIGN KEY (company_id, archived_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT identity_documents_archive_complete
    CHECK ((archived_at IS NULL) = (archived_reason IS NULL) AND (archived_at IS NOT NULL OR archived_by IS NULL)),
  ADD CONSTRAINT identity_documents_dates CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on > issued_on),
  ADD CONSTRAINT identity_documents_verified_complete CHECK ((verified_at IS NULL) = (verified_by IS NULL)),
  ADD CONSTRAINT identity_documents_hash_length CHECK (octet_length(number_hash) = 32);
CREATE INDEX identity_documents_created_by_fk_idx ON identity_documents (company_id, created_by) WHERE created_by IS NOT NULL;
CREATE INDEX identity_documents_archived_by_fk_idx ON identity_documents (company_id, archived_by) WHERE archived_by IS NOT NULL;
CREATE TRIGGER identity_documents_touch BEFORE UPDATE ON identity_documents FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- A verified document is evidence: its identifying details never change.
-- It may still be archived, and a contact merge may move it.
CREATE FUNCTION app.identity_documents_verified_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.verified_at IS NOT NULL AND (
       NEW.document_type_code, NEW.issuing_country_code, NEW.number_encrypted, NEW.number_hash, NEW.number_last4,
       NEW.issued_on, NEW.expires_on, NEW.verified_at, NEW.verified_by, NEW.document_id, NEW.created_by
     ) IS DISTINCT FROM (
       OLD.document_type_code, OLD.issuing_country_code, OLD.number_encrypted, OLD.number_hash, OLD.number_last4,
       OLD.issued_on, OLD.expires_on, OLD.verified_at, OLD.verified_by, OLD.document_id, OLD.created_by
     ) THEN
    RAISE EXCEPTION 'identity document % is verified and cannot be changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER identity_documents_verified_guard BEFORE UPDATE ON identity_documents
  FOR EACH ROW EXECUTE FUNCTION app.identity_documents_verified_guard();

-- Identity evidence is kept for the retention period (Phase 1 §14.5); the
-- runtime role archives, never deletes.
REVOKE DELETE ON identity_documents FROM estatepro_app;

-- -----------------------------------------------------------------------------
-- 4. KYC checks
-- -----------------------------------------------------------------------------
ALTER TABLE kyc_checks
  ADD COLUMN recorded_by           uuid,
  ADD COLUMN identity_document_id  uuid,
  ADD COLUMN decision_reason       text CHECK (char_length(decision_reason) BETWEEN 3 AND 1000),
  ADD CONSTRAINT kyc_checks_recorded_by_fkey FOREIGN KEY (company_id, recorded_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT kyc_checks_identity_document_fkey FOREIGN KEY (company_id, identity_document_id) REFERENCES identity_documents (company_id, id),
  ADD CONSTRAINT kyc_checks_verified_rated CHECK (status <> 'verified' OR risk_rating IS NOT NULL),
  ADD CONSTRAINT kyc_checks_failed_reasoned CHECK (status <> 'failed' OR decision_reason IS NOT NULL),
  ADD CONSTRAINT kyc_checks_notes_length CHECK (char_length(notes) <= 2000);
CREATE INDEX kyc_checks_recorded_by_fk_idx ON kyc_checks (company_id, recorded_by) WHERE recorded_by IS NOT NULL;
CREATE INDEX kyc_checks_identity_document_id_fk_idx ON kyc_checks (company_id, identity_document_id) WHERE identity_document_id IS NOT NULL;
-- Latest check of each type per contact (record and Sellers view).
DROP INDEX kyc_checks_contact_idx;
CREATE INDEX kyc_checks_contact_idx ON kyc_checks (company_id, contact_id, check_type, created_at DESC, id DESC);

-- A signed-off check (verified or failed) is a record of a decision: it never
-- changes. A new check is recorded instead. A contact merge may move it.
CREATE FUNCTION app.kyc_checks_decided_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('verified', 'failed') AND (
       NEW.check_type, NEW.status, NEW.risk_rating, NEW.provider, NEW.provider_reference, NEW.reviewed_by, NEW.reviewed_at,
       NEW.expires_on, NEW.notes, NEW.deal_id, NEW.recorded_by, NEW.identity_document_id, NEW.decision_reason
     ) IS DISTINCT FROM (
       OLD.check_type, OLD.status, OLD.risk_rating, OLD.provider, OLD.provider_reference, OLD.reviewed_by, OLD.reviewed_at,
       OLD.expires_on, OLD.notes, OLD.deal_id, OLD.recorded_by, OLD.identity_document_id, OLD.decision_reason
     ) THEN
    RAISE EXCEPTION 'KYC check % is signed off and cannot be changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER kyc_checks_decided_guard BEFORE UPDATE ON kyc_checks
  FOR EACH ROW EXECUTE FUNCTION app.kyc_checks_decided_guard();

REVOKE DELETE ON kyc_checks FROM estatepro_app;

GRANT EXECUTE ON FUNCTION app.requirement_area_covers(jsonb, text, text, geography) TO estatepro_app, estatepro_platform;
GRANT EXECUTE ON FUNCTION app.rent_per_period(numeric, text, text) TO estatepro_app, estatepro_platform;
