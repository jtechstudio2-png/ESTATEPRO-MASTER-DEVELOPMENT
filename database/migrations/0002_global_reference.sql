-- =============================================================================
-- EstatePro · Migration 0002 · Global reference data (platform-maintained)
-- =============================================================================
-- These tables have no company_id. They are readable by every company and
-- writable only by the platform role. Country behaviour lives here as DATA, so
-- adding a market means inserting rows, not changing the schema.
-- =============================================================================

CREATE TABLE currencies (
  code          char(3)     PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),      -- ISO 4217
  name          text        NOT NULL,
  minor_units   smallint    NOT NULL CHECK (minor_units BETWEEN 0 AND 4),  -- GBP 2, KWD 3
  symbol        text,
  is_active     boolean     NOT NULL DEFAULT true
);

CREATE TABLE locales (
  code            text      PRIMARY KEY CHECK (code ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),  -- BCP 47 subset
  name            text      NOT NULL,
  text_direction  text      NOT NULL DEFAULT 'ltr' CHECK (text_direction IN ('ltr', 'rtl')),
  fallback_code   text      REFERENCES locales (code),
  is_active       boolean   NOT NULL DEFAULT true
);

CREATE TABLE countries (
  code                   char(2)    PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),  -- ISO 3166-1 alpha-2
  name                   text       NOT NULL,
  default_currency_code  char(3)    NOT NULL REFERENCES currencies (code),
  default_locale_code    text       NOT NULL REFERENCES locales (code),
  default_timezone       text       NOT NULL,           -- IANA name, e.g. Africa/Accra
  phone_country_code     text       NOT NULL CHECK (phone_country_code ~ '^\+[0-9]{1,4}$'),
  -- ISO weekday numbers (1 = Monday … 7 = Sunday). Used by SLA and due-date logic.
  weekend_days           smallint[] NOT NULL DEFAULT '{6,7}',
  area_display_unit      text       NOT NULL DEFAULT 'sqm' CHECK (area_display_unit IN ('sqm', 'sqft')),
  -- Describes which address fields apply, their labels and which are required.
  -- Example keys: {"postal_code": {"required": true, "label": "Postcode"},
  --                "local_components": [{"key": "zone_number", "label": "Zone"}]}
  address_format         jsonb      NOT NULL DEFAULT '{}'::jsonb,
  is_active              boolean    NOT NULL DEFAULT true
);

-- A jurisdiction is the legal regime that governs leases, deposits and sales.
-- It is usually a country, but can be a sub-national area where law differs
-- (England, Scotland, Wales and Northern Ireland have different tenancy law).
CREATE TABLE jurisdictions (
  code          text     PRIMARY KEY CHECK (code ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),  -- ISO 3166-2 style
  country_code  char(2)  NOT NULL REFERENCES countries (code),
  parent_code   text     REFERENCES jurisdictions (code),
  name          text     NOT NULL,
  is_active     boolean  NOT NULL DEFAULT true
);
CREATE INDEX jurisdictions_country_idx ON jurisdictions (country_code);

-- Catalogue of configurable rule keys (e.g. deposit_protection_deadline_days).
-- The application reads rules by key; it never branches on a country code.
CREATE TABLE jurisdiction_setting_definitions (
  key          text   PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  data_type    text   NOT NULL CHECK (data_type IN ('integer', 'decimal', 'boolean', 'text', 'json', 'duration_days')),
  description  text   NOT NULL,
  default_value jsonb
);

-- Effective-dated rule values per jurisdiction. Values must be confirmed by
-- legal review before activation; nothing is seeded by default.
CREATE TABLE jurisdiction_settings (
  jurisdiction_code  text   NOT NULL REFERENCES jurisdictions (code),
  key                text   NOT NULL REFERENCES jurisdiction_setting_definitions (key),
  value              jsonb  NOT NULL,
  effective_from     date   NOT NULL,
  effective_to       date,
  source_reference   text,                       -- statute, regulator notice, legal memo
  reviewed_at        timestamptz,
  PRIMARY KEY (jurisdiction_code, key, effective_from),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE public_holidays (
  jurisdiction_code  text  NOT NULL REFERENCES jurisdictions (code),
  holiday_date       date  NOT NULL,
  name               text  NOT NULL,
  PRIMARY KEY (jurisdiction_code, holiday_date)
);

-- Daily reference rates for reporting conversion only. Stored transactions are
-- never converted; reports convert at the rate for the transaction date.
CREATE TABLE fx_rates (
  base_currency_code   char(3)        NOT NULL REFERENCES currencies (code),
  quote_currency_code  char(3)        NOT NULL REFERENCES currencies (code),
  rate_date            date           NOT NULL,
  rate                 numeric(20,10) NOT NULL CHECK (rate > 0),
  source               text           NOT NULL,
  PRIMARY KEY (base_currency_code, quote_currency_code, rate_date, source),
  CHECK (base_currency_code <> quote_currency_code)
);

-- -----------------------------------------------------------------------------
-- Subscription plans (limits are set in Phase 14)
-- -----------------------------------------------------------------------------
CREATE TABLE plans (
  code         text     PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name         text     NOT NULL,
  sort_order   smallint NOT NULL DEFAULT 0,
  is_public    boolean  NOT NULL DEFAULT true,
  is_active    boolean  NOT NULL DEFAULT true
);

CREATE TABLE plan_prices (
  plan_code         text           NOT NULL REFERENCES plans (code),
  currency_code     char(3)        NOT NULL REFERENCES currencies (code),
  billing_interval  text           NOT NULL CHECK (billing_interval IN ('month', 'year')),
  amount            numeric(19,4)  NOT NULL CHECK (amount >= 0),
  provider_price_id text,
  effective_from    date           NOT NULL,
  effective_to      date,
  PRIMARY KEY (plan_code, currency_code, billing_interval, effective_from)
);

-- Feature flags and numeric limits per plan. NULL limit = unlimited.
CREATE TABLE plan_entitlements (
  plan_code    text     NOT NULL REFERENCES plans (code),
  feature_key  text     NOT NULL CHECK (feature_key ~ '^[a-z][a-z0-9_.]*$'),
  is_enabled   boolean  NOT NULL DEFAULT true,
  limit_value  bigint   CHECK (limit_value IS NULL OR limit_value >= 0),
  PRIMARY KEY (plan_code, feature_key)
);
