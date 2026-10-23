-- =============================================================================
-- EstatePro · Migration 0003 · Companies, offices, addresses, users and access
-- =============================================================================
-- Tenant-safety pattern used from here on:
--   * every company-owned table has company_id NOT NULL and UNIQUE (company_id, id)
--   * children reference parents by (company_id, parent_id), so a row can never
--     point at another company's record, even through an application bug
--   * RLS policies are attached to every company-owned table in migration 0013
-- =============================================================================

CREATE TABLE companies (
  id                       uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  legal_name               text         NOT NULL,
  trading_name             text,
  slug                     citext       NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status                   text         NOT NULL DEFAULT 'trial'
                             CHECK (status IN ('trial', 'active', 'past_due', 'read_only', 'suspended', 'cancelled')),
  business_types           text[]       NOT NULL DEFAULT '{agency}'
                             CHECK (business_types <@ ARRAY['agency', 'property_manager', 'developer', 'landlord', 'broker']::text[]),
  headquarters_country_code char(2)     NOT NULL REFERENCES countries (code),
  base_currency_code       char(3)      NOT NULL REFERENCES currencies (code),  -- reporting currency
  default_locale_code      text         NOT NULL REFERENCES locales (code),
  default_timezone         text         NOT NULL,
  fiscal_year_start_month  smallint     NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  registration_number      text,
  tax_number               text,
  data_region              text         NOT NULL,                 -- deployment cell, e.g. 'eu-west', 'me-central'
  trial_ends_at            timestamptz,
  cancelled_at             timestamptz,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  version                  integer      NOT NULL DEFAULT 1
);

-- One row per company: who is billed and how. Card data is never stored.
CREATE TABLE billing_profiles (
  company_id              uuid         PRIMARY KEY REFERENCES companies (id),
  billing_email           citext       NOT NULL,
  billing_name            text         NOT NULL,
  billing_address         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  tax_number              text,
  provider                text         NOT NULL DEFAULT 'stripe',
  provider_customer_id    text,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  version                 integer      NOT NULL DEFAULT 1
);

CREATE TABLE subscriptions (
  id                         uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id                 uuid         NOT NULL REFERENCES companies (id),
  plan_code                  text         NOT NULL REFERENCES plans (code),
  status                     text         NOT NULL
                               CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  billing_interval           text         NOT NULL CHECK (billing_interval IN ('month', 'year')),
  currency_code              char(3)      NOT NULL REFERENCES currencies (code),
  seats                      integer      NOT NULL DEFAULT 1 CHECK (seats > 0),
  provider_subscription_id   text,
  current_period_start       timestamptz,
  current_period_end         timestamptz,
  cancel_at                  timestamptz,
  ended_at                   timestamptz,
  created_at                 timestamptz  NOT NULL DEFAULT now(),
  updated_at                 timestamptz  NOT NULL DEFAULT now(),
  version                    integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id)
);
-- At most one live subscription per company.
CREATE UNIQUE INDEX subscriptions_one_live_idx ON subscriptions (company_id)
  WHERE status IN ('trialing', 'active', 'past_due');

CREATE TABLE subscription_invoices (
  id                   uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid           NOT NULL REFERENCES companies (id),
  subscription_id      uuid           NOT NULL,
  provider_invoice_id  text           NOT NULL UNIQUE,
  number               text,
  status               text           NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency_code        char(3)        NOT NULL REFERENCES currencies (code),
  total                numeric(19,4)  NOT NULL,
  issued_at            timestamptz,
  paid_at              timestamptz,
  hosted_url           text,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, subscription_id) REFERENCES subscriptions (company_id, id)
);
CREATE INDEX subscription_invoices_company_idx ON subscription_invoices (company_id, issued_at DESC);

-- Metered usage for plan limits (users, units, storage bytes, AI credits).
CREATE TABLE usage_counters (
  company_id    uuid         NOT NULL REFERENCES companies (id),
  metric        text         NOT NULL CHECK (metric ~ '^[a-z][a-z0-9_.]*$'),
  period_start  date         NOT NULL,
  value         bigint       NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, metric, period_start)
);

-- -----------------------------------------------------------------------------
-- Addresses: one international structure used by offices, contacts and
-- properties. Country-specific parts (Ghana digital address, Qatar zone /
-- street / building numbers) go in local_components, validated against
-- countries.address_format by the application.
-- -----------------------------------------------------------------------------
CREATE TABLE addresses (
  id                  uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id          uuid           NOT NULL REFERENCES companies (id),
  country_code        char(2)        NOT NULL REFERENCES countries (code),
  address_line_1      text,
  address_line_2      text,
  address_line_3      text,
  dependent_locality  text,          -- neighbourhood / district
  locality            text,          -- city / town / post town
  admin_area_2        text,          -- county / municipality / district
  admin_area_1        text,          -- region / state / emirate
  postal_code         text,
  local_components    jsonb          NOT NULL DEFAULT '{}'::jsonb,
  formatted           text,          -- rendered by the application for display and search
  latitude            numeric(9,6)   CHECK (latitude BETWEEN -90 AND 90),
  longitude           numeric(9,6)   CHECK (longitude BETWEEN -180 AND 180),
  geocode_source      text,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now(),
  version             integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX addresses_company_locality_idx ON addresses (company_id, country_code, locality);
CREATE INDEX addresses_postal_idx ON addresses (company_id, postal_code) WHERE postal_code IS NOT NULL;
CREATE INDEX addresses_formatted_trgm_idx ON addresses USING gin (formatted gin_trgm_ops);

-- Offices (branches). Each office can operate in its own country, currency and
-- timezone, so one company can run offices in Accra, Doha and London.
CREATE TABLE offices (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid         NOT NULL REFERENCES companies (id),
  code               text         NOT NULL,
  name               text         NOT NULL,
  country_code       char(2)      NOT NULL REFERENCES countries (code),
  jurisdiction_code  text         NOT NULL REFERENCES jurisdictions (code),
  currency_code      char(3)      NOT NULL REFERENCES currencies (code),
  locale_code        text         NOT NULL REFERENCES locales (code),
  timezone           text         NOT NULL,
  -- Overrides the country weekend for SLA and scheduling, if the office differs.
  working_days       smallint[]   NOT NULL DEFAULT '{1,2,3,4,5}',
  address_id         uuid,
  phone_e164         text         CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email              citext,
  licence_number     text,        -- agency/brokerage licence where the market requires one
  is_head_office     boolean      NOT NULL DEFAULT false,
  archived_at        timestamptz,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  version            integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (company_id, address_id) REFERENCES addresses (company_id, id)
);
CREATE UNIQUE INDEX offices_one_head_office_idx ON offices (company_id) WHERE is_head_office AND archived_at IS NULL;

-- -----------------------------------------------------------------------------
-- Users are global identities. A user joins companies through memberships and
-- may be staff in one company and a landlord or tenant in another.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  email              citext       NOT NULL UNIQUE,
  email_verified_at  timestamptz,
  phone_e164         text         CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_verified_at  timestamptz,
  display_name       text         NOT NULL,
  given_name         text,
  family_name        text,
  locale_code        text         REFERENCES locales (code),
  timezone           text,
  status             text         NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'locked', 'disabled')),
  last_login_at      timestamptz,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  version            integer      NOT NULL DEFAULT 1
);

-- Kept apart from users so ordinary queries never touch secrets.
CREATE TABLE user_credentials (
  user_id              uuid         PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash        text         NOT NULL,          -- Argon2id encoded string
  password_changed_at  timestamptz  NOT NULL DEFAULT now(),
  failed_attempts      smallint     NOT NULL DEFAULT 0,
  locked_until         timestamptz
);

CREATE TABLE mfa_factors (
  id                uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  user_id           uuid         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  factor_type       text         NOT NULL CHECK (factor_type IN ('totp', 'webauthn', 'recovery_codes')),
  label             text,
  secret_encrypted  bytea,       -- TOTP secret / hashed recovery codes, envelope-encrypted
  credential_id     bytea,       -- WebAuthn
  public_key        bytea,       -- WebAuthn
  sign_count        bigint,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  disabled_at       timestamptz,
  CHECK (factor_type <> 'webauthn' OR (credential_id IS NOT NULL AND public_key IS NOT NULL)),
  CHECK (factor_type = 'webauthn' OR secret_encrypted IS NOT NULL)
);
CREATE INDEX mfa_factors_user_idx ON mfa_factors (user_id) WHERE disabled_at IS NULL;
CREATE UNIQUE INDEX mfa_factors_credential_idx ON mfa_factors (credential_id) WHERE credential_id IS NOT NULL;

-- SSO links (OIDC/SAML) for Enterprise.
CREATE TABLE external_identities (
  id          uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  user_id     uuid         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider    text         NOT NULL,
  subject     text         NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

-- Single-use tokens: email verification, password reset, magic links.
CREATE TABLE auth_tokens (
  id          uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  user_id     uuid         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     text         NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'magic_link', 'verify_phone')),
  token_hash  bytea        NOT NULL UNIQUE,
  expires_at  timestamptz  NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose) WHERE used_at IS NULL;

-- -----------------------------------------------------------------------------
-- Roles and permissions
-- System roles have company_id NULL and cannot be edited by companies.
-- Companies on eligible plans can create custom roles.
-- -----------------------------------------------------------------------------
CREATE TABLE permissions (
  key           text     PRIMARY KEY CHECK (key ~ '^[a-z_]+\.[a-z_]+$'),   -- resource.action
  module        text     NOT NULL,
  description   text     NOT NULL,
  is_sensitive  boolean  NOT NULL DEFAULT false   -- requires step-up auth / always audited
);

CREATE TABLE roles (
  id           uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id   uuid         REFERENCES companies (id),     -- NULL = system role
  key          text         NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name         text         NOT NULL,
  description  text,
  audience     text         NOT NULL CHECK (audience IN ('staff', 'portal')),
  is_system    boolean      NOT NULL DEFAULT false,
  archived_at  timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  version      integer      NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT (company_id, key),
  CHECK (is_system = (company_id IS NULL))
);

CREATE TABLE role_permissions (
  role_id         uuid  NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  company_id      uuid  REFERENCES companies (id),           -- mirrors roles.company_id for RLS
  permission_key  text  NOT NULL REFERENCES permissions (key),
  scope           text  NOT NULL CHECK (scope IN ('all', 'office', 'team', 'own', 'linked', 'assigned')),
  PRIMARY KEY (role_id, permission_key)
);

-- Platform staff (EstatePro employees). Separate from company memberships.
CREATE TABLE platform_staff (
  user_id      uuid         PRIMARY KEY REFERENCES users (id),
  role         text         NOT NULL CHECK (role IN ('platform_owner', 'super_admin', 'support', 'billing_ops')),
  is_active    boolean      NOT NULL DEFAULT true,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE company_memberships (
  id                uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id        uuid         NOT NULL REFERENCES companies (id),
  user_id           uuid         NOT NULL REFERENCES users (id),
  role_id           uuid         NOT NULL REFERENCES roles (id),
  membership_type   text         NOT NULL CHECK (membership_type IN ('staff', 'portal')),
  -- Portal users (landlords, tenants) and external suppliers are linked to their
  -- contact record; that link defines which records they may see.
  contact_id        uuid,
  status            text         NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended', 'ended')),
  job_title         text,
  mfa_required      boolean      NOT NULL DEFAULT false,
  invited_by        uuid,
  joined_at         timestamptz,
  ended_at          timestamptz,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  version           integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, user_id),
  CHECK (membership_type = 'staff' OR contact_id IS NOT NULL)
);
CREATE INDEX company_memberships_user_idx ON company_memberships (user_id) WHERE status = 'active';
-- (contact_id FK is added in 0005 once contacts exist.)

CREATE TABLE membership_offices (
  company_id     uuid  NOT NULL,
  membership_id  uuid  NOT NULL,
  office_id      uuid  NOT NULL,
  is_primary     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (company_id, membership_id, office_id),
  FOREIGN KEY (company_id, membership_id) REFERENCES company_memberships (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id)
);
CREATE INDEX membership_offices_office_idx ON membership_offices (company_id, office_id);

CREATE TABLE teams (
  id                     uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id             uuid         NOT NULL REFERENCES companies (id),
  office_id              uuid,
  name                   text         NOT NULL,
  manager_membership_id  uuid,
  archived_at            timestamptz,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  version                integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id),
  FOREIGN KEY (company_id, manager_membership_id) REFERENCES company_memberships (company_id, id)
);

CREATE TABLE team_members (
  company_id     uuid  NOT NULL,
  team_id        uuid  NOT NULL,
  membership_id  uuid  NOT NULL,
  PRIMARY KEY (company_id, team_id, membership_id),
  FOREIGN KEY (company_id, team_id) REFERENCES teams (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, membership_id) REFERENCES company_memberships (company_id, id) ON DELETE CASCADE
);

-- Agent profile and licensing. Licensing rules differ by market, so the
-- authority and number are free data, not country-specific columns.
CREATE TABLE agent_profiles (
  company_id            uuid         NOT NULL,
  membership_id         uuid         NOT NULL,
  licence_number        text,
  licence_authority     text,
  licence_country_code  char(2)      REFERENCES countries (code),
  licence_expires_on    date,
  languages             text[]       NOT NULL DEFAULT '{}',
  specialisations       text[]       NOT NULL DEFAULT '{}',   -- e.g. residential_sales, lettings, commercial
  public_bio            text,
  photo_document_id     uuid,
  is_listed_publicly    boolean      NOT NULL DEFAULT true,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  version               integer      NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, membership_id),
  FOREIGN KEY (company_id, membership_id) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX agent_profiles_licence_expiry_idx ON agent_profiles (company_id, licence_expires_on)
  WHERE licence_expires_on IS NOT NULL;

CREATE TABLE invitations (
  id             uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id     uuid         NOT NULL REFERENCES companies (id),
  email          citext       NOT NULL,
  role_id        uuid         NOT NULL REFERENCES roles (id),
  office_ids     uuid[]       NOT NULL DEFAULT '{}',
  contact_id     uuid,
  token_hash     bytea        NOT NULL UNIQUE,
  invited_by     uuid         NOT NULL,
  expires_at     timestamptz  NOT NULL,
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, invited_by) REFERENCES company_memberships (company_id, id)
);
CREATE UNIQUE INDEX invitations_open_email_idx ON invitations (company_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE user_sessions (
  id                  uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  user_id             uuid         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  active_company_id   uuid         REFERENCES companies (id),
  refresh_token_hash  bytea        NOT NULL UNIQUE,
  token_family        uuid         NOT NULL,            -- rotation family, for reuse detection
  mfa_verified_at     timestamptz,
  ip_address          inet,
  user_agent          text,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  last_seen_at        timestamptz  NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz  NOT NULL,
  absolute_expires_at timestamptz  NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text
);
CREATE INDEX user_sessions_user_active_idx ON user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_sessions_family_idx ON user_sessions (token_family);

CREATE TABLE api_keys (
  id            uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id    uuid         NOT NULL REFERENCES companies (id),
  name          text         NOT NULL,
  key_prefix    text         NOT NULL UNIQUE,            -- shown in UI to identify the key
  key_hash      bytea        NOT NULL,
  scopes        text[]       NOT NULL,
  created_by    uuid         NOT NULL,
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id)
);

-- Time-boxed, consented support access by platform staff.
CREATE TABLE support_access_grants (
  id                     uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id             uuid         NOT NULL REFERENCES companies (id),
  staff_user_id          uuid         NOT NULL REFERENCES platform_staff (user_id),
  reason                 text         NOT NULL,
  ticket_reference       text,
  access_level           text         NOT NULL DEFAULT 'read_only' CHECK (access_level IN ('read_only', 'read_write')),
  status                 text         NOT NULL DEFAULT 'requested'
                           CHECK (status IN ('requested', 'approved', 'rejected', 'expired', 'revoked')),
  approved_by            uuid,
  approved_at            timestamptz,
  starts_at              timestamptz,
  expires_at             timestamptz,
  revoked_at             timestamptz,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, approved_by) REFERENCES company_memberships (company_id, id),
  CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND starts_at IS NOT NULL AND expires_at > starts_at))
);
CREATE INDEX support_access_grants_active_idx ON support_access_grants (company_id, expires_at) WHERE status = 'approved';
