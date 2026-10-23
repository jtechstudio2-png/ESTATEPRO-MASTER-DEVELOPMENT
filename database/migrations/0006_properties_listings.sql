-- =============================================================================
-- EstatePro · Migration 0006 · Developments, properties, units, ownership,
-- listings, media, notes, keys and inspections
-- =============================================================================
-- Property = physical asset. Unit = lettable/sellable part (a house has one).
-- Listing = one marketing campaign for one unit, for sale or rent.
-- =============================================================================

-- Developer projects (off-plan and new-build inventory).
CREATE TABLE developments (
  id                    uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid         NOT NULL,
  reference             text,
  name                  text         NOT NULL,
  developer_contact_id  uuid,        -- NULL when the company itself is the developer
  address_id            uuid,
  jurisdiction_code     text         NOT NULL REFERENCES jurisdictions (code),
  status                text         NOT NULL DEFAULT 'planning'
                          CHECK (status IN ('planning', 'pre_launch', 'selling', 'construction', 'completed', 'cancelled')),
  launch_date           date,
  expected_completion   date,
  completed_on          date,
  description           text,
  archived_at           timestamptz,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  version               integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, developer_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, address_id) REFERENCES addresses (company_id, id)
);

CREATE TABLE development_phases (
  id                   uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid         NOT NULL,
  development_id       uuid         NOT NULL,
  name                 text         NOT NULL,
  sort_order           smallint     NOT NULL DEFAULT 0,
  status               text         NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'selling', 'construction', 'completed')),
  expected_completion  date,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, development_id) REFERENCES developments (company_id, id) ON DELETE CASCADE
);

CREATE TABLE properties (
  id                     uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id             uuid           NOT NULL,
  reference              text           NOT NULL,
  name                   text,                         -- building / estate name
  property_type_id       uuid           NOT NULL REFERENCES property_types (id),
  development_id         uuid,
  development_phase_id   uuid,
  office_id              uuid           NOT NULL,
  address_id             uuid           NOT NULL,
  jurisdiction_code      text           NOT NULL REFERENCES jurisdictions (code),
  timezone               text           NOT NULL,      -- drives due dates and reminders for this asset
  tenure_code            text,                         -- picklist: tenure (country-scoped)
  tenure_expires_on      date,                         -- leasehold / usufruct end
  title_reference        text,                         -- land registry / title number
  year_built             smallint       CHECK (year_built BETWEEN 1000 AND 2200),
  floors_count           smallint       CHECK (floors_count >= 0),
  -- Areas are stored in square metres. The value and unit originally entered
  -- are kept so a figure typed in acres or square feet is shown back unchanged.
  land_area_sqm          numeric(14,2)  CHECK (land_area_sqm >= 0),
  land_area_input        numeric(14,4),
  land_area_input_unit   text           CHECK (land_area_input_unit IN ('sqm', 'sqft', 'acre', 'hectare', 'plot')),
  is_managed             boolean        NOT NULL DEFAULT false,   -- under a management agreement
  internal_notes         text,
  custom_fields          jsonb          NOT NULL DEFAULT '{}'::jsonb,
  archived_at            timestamptz,
  archived_reason        text,
  created_by             uuid,
  created_at             timestamptz    NOT NULL DEFAULT now(),
  updated_at             timestamptz    NOT NULL DEFAULT now(),
  version                integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, development_id) REFERENCES developments (company_id, id),
  FOREIGN KEY (company_id, development_phase_id) REFERENCES development_phases (company_id, id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id),
  FOREIGN KEY (company_id, address_id) REFERENCES addresses (company_id, id),
  CHECK ((land_area_input IS NULL) = (land_area_input_unit IS NULL))
);
CREATE INDEX properties_office_idx ON properties (company_id, office_id) WHERE archived_at IS NULL;
CREATE INDEX properties_type_idx ON properties (company_id, property_type_id) WHERE archived_at IS NULL;
CREATE INDEX properties_development_idx ON properties (company_id, development_id) WHERE development_id IS NOT NULL;

CREATE TABLE units (
  id                     uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id             uuid           NOT NULL,
  property_id            uuid           NOT NULL,
  reference              text           NOT NULL,
  unit_label             text           NOT NULL,      -- "Flat 3B", "Shop 12", "Whole property"
  unit_type_id           uuid           REFERENCES property_types (id),
  is_whole_property      boolean        NOT NULL DEFAULT false,
  floor_label            text,
  bedrooms               smallint       CHECK (bedrooms >= 0),
  bathrooms              numeric(3,1)   CHECK (bathrooms >= 0),
  reception_rooms        smallint       CHECK (reception_rooms >= 0),
  floor_area_sqm         numeric(12,2)  CHECK (floor_area_sqm >= 0),
  floor_area_input       numeric(12,4),
  floor_area_input_unit  text           CHECK (floor_area_input_unit IN ('sqm', 'sqft')),
  parking_spaces         smallint       CHECK (parking_spaces >= 0),
  furnishing_code        text,          -- picklist: furnishing
  energy_rating          text,          -- e.g. EPC band where the market uses one
  -- Operational availability. 'under_maintenance' blocks viewings and new lets
  -- without changing the listing's marketing status.
  availability           text           NOT NULL DEFAULT 'available'
                           CHECK (availability IN ('available', 'under_maintenance', 'owner_occupied', 'unavailable')),
  availability_note      text,
  availability_until     date,
  custom_fields          jsonb          NOT NULL DEFAULT '{}'::jsonb,
  archived_at            timestamptz,
  created_at             timestamptz    NOT NULL DEFAULT now(),
  updated_at             timestamptz    NOT NULL DEFAULT now(),
  version                integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  UNIQUE (company_id, property_id, unit_label),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  CHECK ((floor_area_input IS NULL) = (floor_area_input_unit IS NULL))
);
CREATE UNIQUE INDEX units_one_whole_property_idx ON units (company_id, property_id) WHERE is_whole_property AND archived_at IS NULL;
CREATE INDEX units_search_idx ON units (company_id, bedrooms, floor_area_sqm) WHERE archived_at IS NULL;

CREATE TABLE unit_features (
  company_id    uuid  NOT NULL,
  unit_id       uuid  NOT NULL,
  feature_code  text  NOT NULL,        -- picklist: feature (pool, generator, borehole, gym, lift, …)
  detail        text,
  PRIMARY KEY (company_id, unit_id, feature_code),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id) ON DELETE CASCADE
);
CREATE INDEX unit_features_code_idx ON unit_features (company_id, feature_code);

-- Ownership is historical and may be joint. unit_id NULL = whole property;
-- set for strata / apartment ownership where each unit has its own owner.
CREATE TABLE property_ownerships (
  id                    uuid          PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid          NOT NULL,
  property_id           uuid          NOT NULL,
  unit_id               uuid,
  owner_contact_id      uuid          NOT NULL,
  share_percent         numeric(7,4)  NOT NULL DEFAULT 100 CHECK (share_percent > 0 AND share_percent <= 100),
  ownership_type        text          NOT NULL DEFAULT 'legal_owner'
                          CHECK (ownership_type IN ('legal_owner', 'beneficial_owner', 'leaseholder', 'developer')),
  effective_from        date          NOT NULL,
  effective_to          date,
  evidence_document_id  uuid,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, owner_contact_id) REFERENCES contacts (company_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX property_ownerships_owner_idx ON property_ownerships (company_id, owner_contact_id) WHERE effective_to IS NULL;
CREATE INDEX property_ownerships_property_idx ON property_ownerships (company_id, property_id, unit_id);

-- -----------------------------------------------------------------------------
-- Listings
-- -----------------------------------------------------------------------------
CREATE TABLE listings (
  id                     uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id             uuid           NOT NULL,
  reference              text           NOT NULL,
  unit_id                uuid           NOT NULL,
  listing_type           text           NOT NULL CHECK (listing_type IN ('sale', 'rent')),
  status                 text           NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'available', 'reserved', 'under_contract', 'sold', 'rented', 'withdrawn', 'expired')),
  currency_code          char(3)        NOT NULL REFERENCES currencies (code),
  price                  numeric(19,4)  NOT NULL CHECK (price >= 0),
  price_qualifier_code   text,          -- picklist: offers_over, guide_price, price_on_application, negotiable, fixed
  rent_frequency         text           CHECK (rent_frequency IN ('weekly', 'monthly', 'quarterly', 'semi_annual', 'annual')),
  -- Common in markets where landlords take rent in advance (e.g. one or two years).
  advance_rent_periods   smallint       CHECK (advance_rent_periods >= 0),
  deposit_amount         numeric(19,4)  CHECK (deposit_amount >= 0),
  service_charge_amount  numeric(19,4)  CHECK (service_charge_amount >= 0),
  service_charge_frequency text         CHECK (service_charge_frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
  min_term_months        smallint       CHECK (min_term_months > 0),
  available_from         date,
  mandate_type_code      text,          -- picklist: sole_agency, multi_agency, open, exclusive_right_to_sell
  mandate_signed_on      date,
  mandate_expires_on     date,
  fee_terms              jsonb          NOT NULL DEFAULT '{}'::jsonb,   -- agreed agency fee for this instruction
  agent_membership_id    uuid           NOT NULL,
  office_id              uuid           NOT NULL,
  default_locale_code    text           NOT NULL REFERENCES locales (code),
  title                  text           NOT NULL,
  description            text,
  is_published           boolean        NOT NULL DEFAULT false,
  published_at           timestamptz,
  listed_at              timestamptz,
  closed_at              timestamptz,
  custom_fields          jsonb          NOT NULL DEFAULT '{}'::jsonb,
  archived_at            timestamptz,
  created_by             uuid,
  created_at             timestamptz    NOT NULL DEFAULT now(),
  updated_at             timestamptz    NOT NULL DEFAULT now(),
  version                integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, agent_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id),
  CHECK ((listing_type = 'rent') = (rent_frequency IS NOT NULL)),
  CHECK (listing_type = 'rent' OR advance_rent_periods IS NULL),
  CHECK (listing_type = 'sale' OR status <> 'sold'),
  CHECK (listing_type = 'rent' OR status <> 'rented'),
  CHECK (NOT is_published OR status IN ('available', 'reserved', 'under_contract')),
  CHECK (mandate_expires_on IS NULL OR mandate_signed_on IS NULL OR mandate_expires_on >= mandate_signed_on)
);
-- One open campaign per unit and type at a time.
CREATE UNIQUE INDEX listings_one_open_per_unit_idx ON listings (company_id, unit_id, listing_type)
  WHERE status IN ('draft', 'available', 'reserved', 'under_contract') AND archived_at IS NULL;
CREATE INDEX listings_search_idx ON listings (company_id, listing_type, status, price)
  WHERE archived_at IS NULL;
CREATE INDEX listings_agent_idx ON listings (company_id, agent_membership_id, status);
CREATE INDEX listings_mandate_expiry_idx ON listings (company_id, mandate_expires_on)
  WHERE mandate_expires_on IS NOT NULL AND status IN ('available', 'reserved', 'under_contract');

-- Title and description per language (e.g. English and Arabic).
CREATE TABLE listing_translations (
  company_id      uuid         NOT NULL,
  listing_id      uuid         NOT NULL,
  locale_code     text         NOT NULL REFERENCES locales (code),
  title           text         NOT NULL,
  description     text,
  source          text         NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai_draft', 'translation_service')),
  approved_by     uuid,
  approved_at     timestamptz,
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, listing_id, locale_code),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, approved_by) REFERENCES company_memberships (company_id, id),
  -- AI-generated text cannot be published without a named approver.
  CHECK (source <> 'ai_draft' OR approved_by IS NOT NULL OR approved_at IS NULL)
);

CREATE TABLE listing_status_history (
  id           uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id   uuid         NOT NULL,
  listing_id   uuid         NOT NULL,
  from_status  text,
  to_status    text         NOT NULL,
  changed_at   timestamptz  NOT NULL DEFAULT now(),
  changed_by   uuid,
  reason       text,
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id) ON DELETE CASCADE
);
CREATE INDEX listing_status_history_idx ON listing_status_history (company_id, listing_id, changed_at);

CREATE TABLE listing_price_history (
  id             uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id     uuid           NOT NULL,
  listing_id     uuid           NOT NULL,
  old_price      numeric(19,4),
  new_price      numeric(19,4)  NOT NULL,
  currency_code  char(3)        NOT NULL REFERENCES currencies (code),
  changed_at     timestamptz    NOT NULL DEFAULT now(),
  changed_by     uuid,
  approved_by    uuid,
  reason         text,
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id) ON DELETE CASCADE
);
CREATE INDEX listing_price_history_idx ON listing_price_history (company_id, listing_id, changed_at);

-- Where a listing is advertised (website, portals) and the remote reference.
CREATE TABLE listing_publications (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid         NOT NULL,
  listing_id         uuid         NOT NULL,
  channel            text         NOT NULL,       -- website, portal key
  status             text         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'live', 'failed', 'removed')),
  external_reference text,
  last_synced_at     timestamptz,
  last_error         text,
  UNIQUE (company_id, listing_id, channel),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id) ON DELETE CASCADE
);

-- Listing / property media: photos, videos, floor plans, virtual tours.
CREATE TABLE property_media (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid         NOT NULL,
  property_id        uuid         NOT NULL,
  unit_id            uuid,
  listing_id         uuid,
  media_type         text         NOT NULL CHECK (media_type IN ('photo', 'video', 'floor_plan', 'virtual_tour', 'site_plan', 'brochure')),
  storage_key        text,        -- private object key (company-prefixed)
  external_url       text,        -- hosted video / 3D tour
  mime_type          text,
  size_bytes         bigint       CHECK (size_bytes >= 0),
  width_px           integer,
  height_px          integer,
  duration_seconds   integer,
  checksum_sha256    bytea,
  caption            text,
  room_label         text,
  sort_order         integer      NOT NULL DEFAULT 0,
  is_cover           boolean      NOT NULL DEFAULT false,
  processing_status  text         NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'ready', 'failed', 'rejected')),
  derivatives        jsonb        NOT NULL DEFAULT '{}'::jsonb,   -- thumbnail / web sizes
  uploaded_by        uuid,
  archived_at        timestamptz,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id),
  CHECK ((storage_key IS NULL) <> (external_url IS NULL))
);
CREATE INDEX property_media_property_idx ON property_media (company_id, property_id, unit_id, sort_order) WHERE archived_at IS NULL;
CREATE INDEX property_media_listing_idx ON property_media (company_id, listing_id, sort_order) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX property_media_one_cover_idx ON property_media (company_id, listing_id)
  WHERE is_cover AND listing_id IS NOT NULL AND archived_at IS NULL;

CREATE TABLE property_notes (
  id           uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id   uuid         NOT NULL,
  property_id  uuid         NOT NULL,
  unit_id      uuid,
  body         text         NOT NULL,
  visibility   text         NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'landlord', 'tenant')),
  is_pinned    boolean      NOT NULL DEFAULT false,
  created_by   uuid         NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  version      integer      NOT NULL DEFAULT 1,
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX property_notes_property_idx ON property_notes (company_id, property_id, created_at DESC);

-- Key register: physical keys / access cards held by the office.
CREATE TABLE key_sets (
  id            uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id    uuid         NOT NULL,
  property_id   uuid         NOT NULL,
  unit_id       uuid,
  label         text         NOT NULL,       -- key tag number
  description   text,
  status        text         NOT NULL DEFAULT 'in_office' CHECK (status IN ('in_office', 'checked_out', 'with_owner', 'lost', 'retired')),
  created_at    timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, label),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id)
);

CREATE TABLE key_movements (
  id                    uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid         NOT NULL,
  key_set_id            uuid         NOT NULL,
  movement              text         NOT NULL CHECK (movement IN ('check_out', 'check_in', 'lost', 'found')),
  holder_membership_id  uuid,
  holder_contact_id     uuid,
  due_back_at           timestamptz,
  occurred_at           timestamptz  NOT NULL DEFAULT now(),
  recorded_by           uuid         NOT NULL,
  FOREIGN KEY (company_id, key_set_id) REFERENCES key_sets (company_id, id),
  FOREIGN KEY (company_id, holder_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, holder_contact_id) REFERENCES contacts (company_id, id),
  CHECK (movement <> 'check_out' OR holder_membership_id IS NOT NULL OR holder_contact_id IS NOT NULL)
);
CREATE INDEX key_movements_key_idx ON key_movements (company_id, key_set_id, occurred_at DESC);
