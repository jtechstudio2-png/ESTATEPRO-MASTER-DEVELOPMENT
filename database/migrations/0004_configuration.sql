-- =============================================================================
-- EstatePro · Migration 0004 · Configuration: settings, picklists, property
-- types, tax codes, custom fields, reference numbering, holidays
-- =============================================================================
-- Shared configuration rows: company_id NULL = platform default visible to all
-- companies (optionally limited to a country); company_id set = that company's
-- own value. Companies extend or hide defaults; they never edit platform rows.
-- =============================================================================

-- Company-level overrides of jurisdiction settings and general preferences.
-- Resolution order in the application: office → company → jurisdiction → definition default.
CREATE TABLE company_settings (
  company_id         uuid         NOT NULL REFERENCES companies (id),
  office_id          uuid,
  key                text         NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]*$'),
  value              jsonb        NOT NULL,
  updated_by         uuid,
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id),
  UNIQUE NULLS NOT DISTINCT (company_id, office_id, key)
);

-- Generic controlled vocabularies: lead sources, tenure types, payment methods,
-- ID document types, expense categories, maintenance categories, lost reasons,
-- features, furnishing, and so on. Records store the stable `code`.
CREATE TABLE picklist_values (
  id            uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id    uuid         REFERENCES companies (id),
  list_key      text         NOT NULL CHECK (list_key ~ '^[a-z][a-z0-9_]*$'),
  code          text         NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_]*$'),
  label         text         NOT NULL,           -- default-language label
  country_code  char(2)      REFERENCES countries (code),   -- NULL = all countries
  sort_order    integer      NOT NULL DEFAULT 0,
  metadata      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  version       integer      NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT (company_id, list_key, code, country_code)
);
CREATE INDEX picklist_values_lookup_idx ON picklist_values (list_key, company_id, country_code) WHERE is_active;

CREATE TABLE picklist_value_translations (
  picklist_value_id  uuid  NOT NULL REFERENCES picklist_values (id) ON DELETE CASCADE,
  company_id         uuid  REFERENCES companies (id),     -- mirrors parent for RLS
  locale_code        text  NOT NULL REFERENCES locales (code),
  label              text  NOT NULL,
  PRIMARY KEY (picklist_value_id, locale_code)
);

-- Property and unit types, hierarchical, scoped by country. Examples: "Chamber
-- and hall" (Ghana), "Compound villa" (Qatar), "Terraced house" (UK) sit beside
-- universal types such as Apartment or Office.
CREATE TABLE property_types (
  id            uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id    uuid         REFERENCES companies (id),
  parent_id     uuid         REFERENCES property_types (id),
  code          text         NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_]*$'),
  name          text         NOT NULL,
  usage_class   text         NOT NULL
                  CHECK (usage_class IN ('residential', 'commercial', 'industrial', 'land', 'mixed_use', 'hospitality', 'agricultural', 'other')),
  applies_to    text         NOT NULL DEFAULT 'both' CHECK (applies_to IN ('property', 'unit', 'both')),
  country_code  char(2)      REFERENCES countries (code),
  sort_order    integer      NOT NULL DEFAULT 0,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  version       integer      NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT (company_id, code, country_code)
);
CREATE INDEX property_types_lookup_idx ON property_types (company_id, country_code) WHERE is_active;

CREATE TABLE property_type_translations (
  property_type_id  uuid  NOT NULL REFERENCES property_types (id) ON DELETE CASCADE,
  company_id        uuid  REFERENCES companies (id),
  locale_code       text  NOT NULL REFERENCES locales (code),
  name              text  NOT NULL,
  PRIMARY KEY (property_type_id, locale_code)
);

-- Tax codes with one or more components, effective-dated. Supports single VAT
-- rates and multi-levy regimes without schema change. No rates are seeded:
-- rates must be entered and verified per jurisdiction.
CREATE TABLE tax_codes (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid         REFERENCES companies (id),
  jurisdiction_code  text         NOT NULL REFERENCES jurisdictions (code),
  code               text         NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9_]*$'),
  name               text         NOT NULL,
  is_active          boolean      NOT NULL DEFAULT true,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  version            integer      NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT (company_id, jurisdiction_code, code)
);

CREATE TABLE tax_code_components (
  id              uuid          PRIMARY KEY DEFAULT app.uuid_v7(),
  tax_code_id     uuid          NOT NULL REFERENCES tax_codes (id) ON DELETE CASCADE,
  company_id      uuid          REFERENCES companies (id),
  name            text          NOT NULL,
  rate_percent    numeric(9,6)  NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  is_compound     boolean       NOT NULL DEFAULT false,   -- applied on amount + earlier components
  sequence        smallint      NOT NULL DEFAULT 1,
  effective_from  date          NOT NULL,
  effective_to    date,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX tax_code_components_code_idx ON tax_code_components (tax_code_id, effective_from);

-- Company-defined custom fields. Values live in each record's custom_fields jsonb.
CREATE TABLE custom_field_definitions (
  id           uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id   uuid         NOT NULL REFERENCES companies (id),
  entity_type  text         NOT NULL CHECK (entity_type IN ('property', 'unit', 'listing', 'contact', 'lead', 'deal', 'lease', 'maintenance_request')),
  key          text         NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  label        text         NOT NULL,
  data_type    text         NOT NULL CHECK (data_type IN ('text', 'long_text', 'integer', 'decimal', 'boolean', 'date', 'select', 'multi_select')),
  options      jsonb        NOT NULL DEFAULT '[]'::jsonb,
  is_required  boolean      NOT NULL DEFAULT false,
  is_searchable boolean     NOT NULL DEFAULT false,
  sort_order   integer      NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  version      integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, entity_type, key)
);

-- Human-readable references such as LSE-2026-000042, per company and key.
CREATE TABLE number_sequences (
  company_id     uuid      NOT NULL REFERENCES companies (id),
  sequence_key   text      NOT NULL,              -- property, listing, lead, deal, lease, payment, work_order, …
  prefix         text      NOT NULL,
  include_year   boolean   NOT NULL DEFAULT true,
  padding        smallint  NOT NULL DEFAULT 6 CHECK (padding BETWEEN 3 AND 12),
  current_year   smallint,
  next_value     bigint    NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, sequence_key)
);

-- Allocates the next reference in the caller's transaction. Row lock keeps it
-- gap-free per company and key; resets yearly when include_year is set.
CREATE OR REPLACE FUNCTION app.next_reference(p_company_id uuid, p_key text, p_on date DEFAULT current_date)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  seq number_sequences%ROWTYPE;
  yr smallint := extract(year FROM p_on)::smallint;
  n bigint;
BEGIN
  SELECT * INTO seq FROM number_sequences
   WHERE company_id = p_company_id AND sequence_key = p_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'number sequence % is not configured for company %', p_key, p_company_id;
  END IF;
  IF seq.include_year AND seq.current_year IS DISTINCT FROM yr THEN
    n := 1;
  ELSE
    n := seq.next_value;
  END IF;
  UPDATE number_sequences SET next_value = n + 1, current_year = yr
   WHERE company_id = p_company_id AND sequence_key = p_key;
  RETURN seq.prefix || '-' ||
         CASE WHEN seq.include_year THEN yr::text || '-' ELSE '' END ||
         lpad(n::text, seq.padding, '0');
END
$$;

-- Company or office closures in addition to public holidays.
CREATE TABLE company_holidays (
  id            uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id    uuid         NOT NULL REFERENCES companies (id),
  office_id     uuid,
  holiday_date  date         NOT NULL,
  name          text         NOT NULL,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE NULLS NOT DISTINCT (company_id, office_id, holiday_date),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id)
);
