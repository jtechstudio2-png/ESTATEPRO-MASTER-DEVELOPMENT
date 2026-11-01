-- =============================================================================
-- EstatePro · Migration 0019 · Location search, property notes, key register
-- (Phase 4 M5)
-- =============================================================================
-- ADR-006 (L-D1..L-D10):
--   L-D1  addresses.location: a geography point calculated from latitude and
--         longitude, indexed per company.
--   L-D2  every stored location is confirmed by a user; geocode_source records
--         how the point was found, geocode_accuracy how precise it is.
--   L-D5  no (0, 0); country bounds for the application's boundary check.
--   L-D6  property_note.* permissions.
--   L-D7  property_note_revisions keeps earlier note text (never the audit log).
--   L-D8  tenant-visible notes reference a unit of the same property.
--   L-D9  properties.internal_notes moves into pinned notes and is deprecated.
--   L-D10 key register: current holder on key_sets, append-only movements,
--         key.* permissions.
-- Requires PostGIS 3. On managed PostgreSQL a privileged role may need to run
-- the CREATE EXTENSION statement separately; it is idempotent.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- -----------------------------------------------------------------------------
-- Countries: bounding boxes for the coordinate check (L-D5). Data, not code:
-- a new market adds its own box.
-- -----------------------------------------------------------------------------
ALTER TABLE countries
  ADD COLUMN bounds_south  numeric(9,6)  CHECK (bounds_south BETWEEN -90 AND 90),
  ADD COLUMN bounds_west   numeric(9,6)  CHECK (bounds_west BETWEEN -180 AND 180),
  ADD COLUMN bounds_north  numeric(9,6)  CHECK (bounds_north BETWEEN -90 AND 90),
  ADD COLUMN bounds_east   numeric(9,6)  CHECK (bounds_east BETWEEN -180 AND 180),
  ADD CONSTRAINT countries_bounds_check CHECK (
    (bounds_south IS NULL AND bounds_west IS NULL AND bounds_north IS NULL AND bounds_east IS NULL)
    OR (bounds_south < bounds_north AND bounds_west < bounds_east));
COMMENT ON COLUMN countries.bounds_south IS 'Bounding box of the country (with a small margin), used to reject misplaced coordinates.';

-- Mainland and islands with a margin of about 5 km.
UPDATE countries SET bounds_south = 4.650000,  bounds_west = -3.310000, bounds_north = 11.220000, bounds_east = 1.250000  WHERE code = 'GH';
UPDATE countries SET bounds_south = 24.400000, bounds_west = 50.700000, bounds_north = 26.200000, bounds_east = 51.700000 WHERE code = 'QA';
UPDATE countries SET bounds_south = 49.800000, bounds_west = -8.700000, bounds_north = 60.900000, bounds_east = 1.800000  WHERE code = 'GB';

-- -----------------------------------------------------------------------------
-- Addresses: provenance, accuracy and the spatial point (L-D1, L-D2, L-D5)
-- -----------------------------------------------------------------------------
ALTER TABLE addresses
  ADD COLUMN geocode_accuracy text         CHECK (geocode_accuracy IN ('rooftop', 'street', 'postcode', 'locality')),
  ADD COLUMN geocoded_at      timestamptz,
  ADD COLUMN location_stale   boolean      NOT NULL DEFAULT false,
  ADD COLUMN location         geography(Point, 4326) GENERATED ALWAYS AS (
    CASE WHEN latitude IS NULL OR longitude IS NULL THEN NULL
         ELSE ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)::geography
    END) STORED;

-- Coordinates entered before M5 were typed in by a person.
UPDATE addresses SET geocode_source = 'manual_pin', geocoded_at = updated_at
 WHERE latitude IS NOT NULL AND geocode_source IS NULL;
UPDATE addresses SET geocode_source = NULL WHERE latitude IS NULL;

ALTER TABLE addresses
  ADD CONSTRAINT addresses_geocode_source_check
    CHECK (geocode_source IN ('manual_pin', 'geocoder', 'postcode_centroid', 'import')),
  ADD CONSTRAINT addresses_geocode_pair_check
    CHECK ((latitude IS NULL) = (geocode_source IS NULL) AND (latitude IS NULL) = (geocoded_at IS NULL)),
  ADD CONSTRAINT addresses_accuracy_needs_point_check CHECK (geocode_accuracy IS NULL OR latitude IS NOT NULL),
  ADD CONSTRAINT addresses_stale_needs_point_check CHECK (NOT location_stale OR latitude IS NOT NULL),
  ADD CONSTRAINT addresses_not_null_island_check CHECK (NOT (latitude = 0 AND longitude = 0));

COMMENT ON COLUMN addresses.location IS 'Calculated from latitude/longitude (ADR-006 L-D1). Never written by the application.';
COMMENT ON COLUMN addresses.location_stale IS 'The address text changed after the point was confirmed; the point should be checked.';

CREATE INDEX addresses_location_gist_idx ON addresses USING gist (company_id, location) WHERE location IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Units: composite key so notes and key sets can require "unit of this property"
-- -----------------------------------------------------------------------------
ALTER TABLE units ADD CONSTRAINT units_company_property_id_key UNIQUE (company_id, property_id, id);

-- -----------------------------------------------------------------------------
-- Property notes (L-D6 to L-D9)
-- -----------------------------------------------------------------------------
ALTER TABLE property_notes
  ALTER COLUMN created_by DROP NOT NULL,
  ADD COLUMN source           text         NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'migrated')),
  ADD COLUMN category         text         NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'access', 'viewing', 'maintenance', 'legal', 'owner')),
  ADD COLUMN updated_by       uuid,
  ADD COLUMN pinned_at        timestamptz,
  ADD COLUMN archived_at      timestamptz,
  ADD COLUMN archived_by      uuid,
  ADD COLUMN archived_reason  text         CHECK (char_length(archived_reason) BETWEEN 1 AND 500),
  ADD COLUMN redacted_at      timestamptz,
  ADD COLUMN redacted_by      uuid,
  ADD CONSTRAINT property_notes_company_id_id_key UNIQUE (company_id, id),
  ADD CONSTRAINT property_notes_body_length_check CHECK (char_length(body) BETWEEN 1 AND 10000),
  ADD CONSTRAINT property_notes_author_check CHECK (created_by IS NOT NULL OR source = 'migrated'),
  ADD CONSTRAINT property_notes_pinned_check CHECK (is_pinned = (pinned_at IS NOT NULL)),
  ADD CONSTRAINT property_notes_archived_check CHECK ((archived_at IS NULL) = (archived_reason IS NULL)),
  ADD CONSTRAINT property_notes_tenant_unit_check CHECK (visibility <> 'tenant' OR unit_id IS NOT NULL),
  ADD CONSTRAINT property_notes_updated_by_fkey FOREIGN KEY (company_id, updated_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT property_notes_archived_by_fkey FOREIGN KEY (company_id, archived_by) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT property_notes_redacted_by_fkey FOREIGN KEY (company_id, redacted_by) REFERENCES company_memberships (company_id, id),
  DROP CONSTRAINT property_notes_company_id_unit_id_fkey,
  ADD CONSTRAINT property_notes_unit_of_property_fkey
    FOREIGN KEY (company_id, property_id, unit_id) REFERENCES units (company_id, property_id, id);

COMMENT ON COLUMN property_notes.body IS 'Plain text. Previous text is in property_note_revisions; never copied into audit_logs (L-D7).';

CREATE INDEX property_notes_list_idx ON property_notes (company_id, property_id, created_at DESC, id DESC) WHERE archived_at IS NULL;
CREATE INDEX property_notes_pinned_idx ON property_notes (company_id, property_id) WHERE is_pinned AND archived_at IS NULL;

-- Earlier text of each note. The application may add rows but not change or
-- remove them; redaction goes through app.redact_property_note().
CREATE TABLE property_note_revisions (
  company_id     uuid         NOT NULL,
  note_id        uuid         NOT NULL,
  revision       integer      NOT NULL CHECK (revision >= 1),   -- the note version this text belonged to
  body           text         NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  written_by     uuid,                                         -- author of this text (null for migrated notes)
  written_at     timestamptz  NOT NULL,
  superseded_by  uuid,
  superseded_at  timestamptz  NOT NULL DEFAULT now(),
  redacted_at    timestamptz,
  PRIMARY KEY (company_id, note_id, revision),
  FOREIGN KEY (company_id, note_id) REFERENCES property_notes (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, written_by) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, superseded_by) REFERENCES company_memberships (company_id, id)
);

-- Redaction (erasure requests): replaces the text of a note and of all its
-- revisions. Runs with the owner's rights because the application role cannot
-- update revisions; it only touches rows of the caller's company.
CREATE OR REPLACE FUNCTION app.redact_property_note(p_note_id uuid, p_by uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  company uuid := app.current_company_id();
BEGIN
  IF company IS NULL THEN
    RAISE EXCEPTION 'no company in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE property_notes
     SET body = '[Redacted]', redacted_at = now(), redacted_by = p_by, updated_by = p_by
   WHERE company_id = company AND id = p_note_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'note not found' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE property_note_revisions
     SET body = '[Redacted]', redacted_at = now()
   WHERE company_id = company AND note_id = p_note_id AND redacted_at IS NULL;
END
$$;
REVOKE ALL ON FUNCTION app.redact_property_note(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redact_property_note(uuid, uuid) TO estatepro_app;

-- L-D9: internal_notes becomes a pinned internal note; the column is emptied
-- (one copy of the text) and dropped in a later migration.
INSERT INTO property_notes (company_id, property_id, body, visibility, is_pinned, pinned_at, created_by, source, category)
SELECT company_id, id, left(btrim(internal_notes), 10000), 'internal', true, now(), created_by, 'migrated', 'general'
  FROM properties
 WHERE internal_notes IS NOT NULL AND btrim(internal_notes) <> '';
UPDATE properties SET internal_notes = NULL WHERE internal_notes IS NOT NULL;
COMMENT ON COLUMN properties.internal_notes IS 'Deprecated (ADR-006 L-D9): moved to property_notes; not used by the API; to be dropped.';

-- -----------------------------------------------------------------------------
-- Key register (L-D10)
-- -----------------------------------------------------------------------------
ALTER TABLE key_sets
  ADD COLUMN holder_membership_id  uuid,
  ADD COLUMN holder_contact_id     uuid,
  ADD COLUMN checked_out_at        timestamptz,
  ADD COLUMN due_back_at           timestamptz,
  ADD COLUMN retired_at            timestamptz,
  ADD COLUMN created_by            uuid,
  ADD COLUMN updated_at            timestamptz  NOT NULL DEFAULT now(),
  ADD COLUMN version               integer      NOT NULL DEFAULT 1,
  ADD CONSTRAINT key_sets_label_length_check CHECK (char_length(label) BETWEEN 1 AND 60),
  ADD CONSTRAINT key_sets_description_length_check CHECK (char_length(description) <= 500),
  ADD CONSTRAINT key_sets_out_check CHECK ((status = 'checked_out') = (checked_out_at IS NOT NULL)),
  ADD CONSTRAINT key_sets_holder_check CHECK (
    CASE WHEN status = 'checked_out'
         THEN (holder_membership_id IS NULL) <> (holder_contact_id IS NULL)
         ELSE holder_membership_id IS NULL AND holder_contact_id IS NULL AND due_back_at IS NULL END),
  ADD CONSTRAINT key_sets_retired_check CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  ADD CONSTRAINT key_sets_holder_membership_fkey FOREIGN KEY (company_id, holder_membership_id) REFERENCES company_memberships (company_id, id),
  ADD CONSTRAINT key_sets_holder_contact_fkey FOREIGN KEY (company_id, holder_contact_id) REFERENCES contacts (company_id, id),
  ADD CONSTRAINT key_sets_created_by_fkey FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id),
  DROP CONSTRAINT key_sets_company_id_unit_id_fkey,
  ADD CONSTRAINT key_sets_unit_of_property_fkey
    FOREIGN KEY (company_id, property_id, unit_id) REFERENCES units (company_id, property_id, id),
  -- A tag number can be reused once its key set is retired.
  DROP CONSTRAINT key_sets_company_id_label_key;
CREATE UNIQUE INDEX key_sets_label_idx ON key_sets (company_id, label) WHERE retired_at IS NULL;
CREATE INDEX key_sets_out_idx ON key_sets (company_id, due_back_at) WHERE status = 'checked_out';
CREATE INDEX key_sets_holder_membership_id_fk_idx ON key_sets (company_id, holder_membership_id) WHERE holder_membership_id IS NOT NULL;
CREATE INDEX key_sets_holder_contact_id_fk_idx ON key_sets (company_id, holder_contact_id) WHERE holder_contact_id IS NOT NULL;
CREATE TRIGGER key_sets_touch BEFORE UPDATE ON key_sets FOR EACH ROW EXECUTE FUNCTION app.touch_row();

ALTER TABLE key_movements
  ADD COLUMN note text CHECK (char_length(note) BETWEEN 1 AND 500),
  ADD CONSTRAINT key_movements_recorded_by_fkey FOREIGN KEY (company_id, recorded_by) REFERENCES company_memberships (company_id, id);
CREATE INDEX key_movements_holder_membership_id_fk_idx ON key_movements (company_id, holder_membership_id) WHERE holder_membership_id IS NOT NULL;
CREATE TRIGGER key_movements_append_only BEFORE UPDATE OR DELETE ON key_movements
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- -----------------------------------------------------------------------------
-- Permissions (ADR-006 grant tables)
-- -----------------------------------------------------------------------------
INSERT INTO permissions (key, module, description, is_sensitive) VALUES
  ('property_note.view',   'properties', 'View property notes', false),
  ('property_note.create', 'properties', 'Add property notes and edit your own', false),
  ('property_note.manage', 'properties', 'Edit, archive and redact any property note; share notes with landlords or tenants', true),
  ('key.view',             'properties', 'View the key register', false),
  ('key.issue',            'properties', 'Check keys out and in; report keys lost or found', false),
  ('key.manage',           'properties', 'Add, edit and retire key sets', false);

INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT r.id, g.permission_key, g.scope
  FROM (VALUES
          ('company_owner',    'property_note.view',   'all'),
          ('company_owner',    'property_note.create', 'all'),
          ('company_owner',    'property_note.manage', 'all'),
          ('company_owner',    'key.view',             'all'),
          ('company_owner',    'key.issue',            'all'),
          ('company_owner',    'key.manage',           'all'),
          ('office_admin',     'property_note.view',   'all'),
          ('office_admin',     'property_note.create', 'all'),
          ('office_admin',     'property_note.manage', 'all'),
          ('office_admin',     'key.view',             'all'),
          ('office_admin',     'key.issue',            'all'),
          ('office_admin',     'key.manage',           'all'),
          ('sales_manager',    'property_note.view',   'office'),
          ('sales_manager',    'property_note.create', 'office'),
          ('sales_manager',    'property_note.manage', 'office'),
          ('sales_manager',    'key.view',             'office'),
          ('sales_manager',    'key.issue',            'office'),
          ('sales_manager',    'key.manage',           'office'),
          ('property_manager', 'property_note.view',   'office'),
          ('property_manager', 'property_note.create', 'office'),
          ('property_manager', 'property_note.manage', 'office'),
          ('property_manager', 'key.view',             'office'),
          ('property_manager', 'key.issue',            'office'),
          ('property_manager', 'key.manage',           'office'),
          ('agent',            'property_note.view',   'office'),
          ('agent',            'property_note.create', 'office'),
          ('agent',            'key.view',             'office'),
          ('agent',            'key.issue',            'office'),
          ('accountant',       'property_note.view',   'all')
       ) AS g (role_key, permission_key, scope)
  JOIN roles r ON r.key = g.role_key AND r.company_id IS NULL;

-- -----------------------------------------------------------------------------
-- Security for the new table (same isolation rule as 0013)
-- -----------------------------------------------------------------------------
ALTER TABLE property_note_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON property_note_revisions FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT ON property_note_revisions TO estatepro_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON property_note_revisions TO estatepro_platform;
