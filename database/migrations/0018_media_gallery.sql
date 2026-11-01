-- =============================================================================
-- EstatePro · Migration 0018 · Media gallery, uploads, quotas (Phase 4 M4)
-- =============================================================================
-- ADR-005 (M-D1..M-D8) and the Media Ownership and Retention Policy:
--   S-1  listing_media: listings select, order and choose a cover from the
--        property's media; property_media.listing_id is deprecated (M-D5).
--   S-2  property_media gets updated_at/version for If-Match edits.
--   S-3  accessibility, floor-plan and processing columns; legal hold.
--   S-4  storage quotas per plan and a running storage total (M-D4).
--   S-5  upload_sessions: signed upload intents and quota reservations.
-- Background work uses scheduled_jobs as a PostgreSQL-backed queue (M-D6).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- property_media additions
-- -----------------------------------------------------------------------------
ALTER TABLE property_media
  ADD COLUMN updated_at         timestamptz  NOT NULL DEFAULT now(),
  ADD COLUMN version            integer      NOT NULL DEFAULT 1,
  ADD COLUMN alt_text           text         CHECK (char_length(alt_text) <= 250),
  ADD COLUMN original_filename  text         CHECK (char_length(original_filename) <= 200),
  ADD COLUMN page_count         integer      CHECK (page_count > 0),
  ADD COLUMN floor_label        text         CHECK (char_length(floor_label) <= 60),
  ADD COLUMN external_provider  text         CHECK (external_provider IN ('youtube', 'vimeo', 'matterport')),
  ADD COLUMN rejection_reason   text,
  ADD COLUMN processed_at       timestamptz,
  ADD COLUMN legal_hold         boolean      NOT NULL DEFAULT false,
  ADD COLUMN legal_hold_reason  text,
  ADD COLUMN legal_hold_set_by  uuid,
  ADD COLUMN legal_hold_set_at  timestamptz,
  ADD CONSTRAINT property_media_legal_hold_reason CHECK (NOT legal_hold OR legal_hold_reason IS NOT NULL),
  ADD CONSTRAINT property_media_external_provider CHECK ((external_url IS NULL) = (external_provider IS NULL)),
  ADD FOREIGN KEY (company_id, legal_hold_set_by) REFERENCES company_memberships (company_id, id);

COMMENT ON COLUMN property_media.listing_id IS 'Deprecated (ADR-005 M-D5): use listing_media. Always NULL from Phase 4 M4.';

CREATE TRIGGER property_media_touch BEFORE UPDATE ON property_media
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE INDEX property_media_pending_idx ON property_media (company_id, created_at) WHERE processing_status = 'pending';
CREATE INDEX property_media_archived_idx ON property_media (archived_at) WHERE archived_at IS NOT NULL AND NOT legal_hold;

-- -----------------------------------------------------------------------------
-- listing_media: which property media a listing shows, in what order
-- -----------------------------------------------------------------------------
CREATE TABLE listing_media (
  company_id  uuid         NOT NULL,
  listing_id  uuid         NOT NULL,
  media_id    uuid         NOT NULL,
  sort_order  integer      NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_cover    boolean      NOT NULL DEFAULT false,
  added_by    uuid,
  added_at    timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, listing_id, media_id),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, media_id) REFERENCES property_media (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, added_by) REFERENCES company_memberships (company_id, id)
);
CREATE UNIQUE INDEX listing_media_one_cover_idx ON listing_media (company_id, listing_id) WHERE is_cover;
CREATE INDEX listing_media_order_idx ON listing_media (company_id, listing_id, sort_order);
CREATE INDEX listing_media_media_idx ON listing_media (company_id, media_id);

-- -----------------------------------------------------------------------------
-- upload_sessions: a signed upload intent (quota reserved until confirmed)
-- -----------------------------------------------------------------------------
CREATE TABLE upload_sessions (
  id               uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id       uuid         NOT NULL,
  property_id      uuid         NOT NULL,
  unit_id          uuid,
  listing_id       uuid,        -- attach to this listing once processed
  media_type       text         NOT NULL CHECK (media_type IN ('photo', 'floor_plan', 'site_plan', 'brochure')),
  file_name        text         NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  declared_mime    text         NOT NULL,
  declared_size    bigint       NOT NULL CHECK (declared_size > 0),
  sha256           bytea        NOT NULL CHECK (octet_length(sha256) = 32),
  quarantine_key   text         NOT NULL,
  status           text         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired', 'cancelled')),
  media_id         uuid,
  expires_at       timestamptz  NOT NULL,
  created_by       uuid         NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (quarantine_key),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id) ON DELETE SET NULL (listing_id),
  FOREIGN KEY (company_id, media_id) REFERENCES property_media (company_id, id) ON DELETE SET NULL (media_id),
  FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX upload_sessions_pending_idx ON upload_sessions (expires_at) WHERE status = 'pending';

-- -----------------------------------------------------------------------------
-- Storage quotas (M-D4): entitlement per plan, running total per company.
-- Bytes are binary gigabytes (GiB / TiB).
-- -----------------------------------------------------------------------------
INSERT INTO plan_entitlements (plan_code, feature_key, is_enabled, limit_value) VALUES
  ('starter',      'storage.bytes', true, 25::bigint * 1024 * 1024 * 1024),
  ('professional', 'storage.bytes', true, 250::bigint * 1024 * 1024 * 1024),
  ('enterprise',   'storage.bytes', true, 2::bigint * 1024 * 1024 * 1024 * 1024);

CREATE TABLE storage_usage (
  company_id      uuid         PRIMARY KEY REFERENCES companies (id),
  bytes_used      bigint       NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
  bytes_reserved  bigint       NOT NULL DEFAULT 0 CHECK (bytes_reserved >= 0),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Security: same rules as every company-owned table (0013)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['listing_media', 'upload_sessions', 'storage_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I FOR ALL TO estatepro_app
         USING (company_id = app.current_company_id())
         WITH CHECK (company_id = app.current_company_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO estatepro_app, estatepro_platform', t);
  END LOOP;
END
$$;
