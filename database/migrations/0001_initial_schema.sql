-- EstatePro Phase 2 database baseline
-- PostgreSQL 15+ recommended. Review and test in a disposable database before production.
-- This migration creates structure only; it does not seed country-specific legal rules or production data.
-- Tenant RLS assumes the application sets app.current_company_id transaction-locally after validating membership.
BEGIN;

CREATE TABLE countries (
  country_code char(2) PRIMARY KEY,
  name text NOT NULL,
  default_locale text,
  active boolean NOT NULL DEFAULT true,
  CHECK (country_code = upper(country_code))
);

CREATE TABLE currencies (
  currency_code char(3) PRIMARY KEY,
  name text NOT NULL,
  minor_unit smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 4),
  active boolean NOT NULL DEFAULT true,
  CHECK (currency_code = upper(currency_code))
);

CREATE TABLE locales (
  locale_code varchar(35) PRIMARY KEY,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL UNIQUE,
  display_name text NOT NULL,
  identity_provider text,
  identity_subject text,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','active','suspended','closed')),
  preferred_locale varchar(35) REFERENCES locales(locale_code),
  preferred_timezone text,
  email_verified_at timestamptz,
  last_authenticated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_provider, identity_subject)
);

CREATE TABLE companies (
  company_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'trial'
    CHECK (status IN ('trial','active','suspended','closed')),
  subscription_plan_code text,
  billing_customer_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, display_name)
);

CREATE TABLE company_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(company_id),
  default_locale varchar(35) REFERENCES locales(locale_code),
  default_timezone text NOT NULL DEFAULT 'UTC',
  default_currency char(3) REFERENCES currencies(currency_code),
  date_format text,
  number_format_locale varchar(35) REFERENCES locales(locale_code),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_market_settings (
  company_id uuid NOT NULL REFERENCES companies(company_id),
  country_code char(2) NOT NULL REFERENCES countries(country_code),
  default_currency char(3) REFERENCES currencies(currency_code),
  default_locale varchar(35) REFERENCES locales(locale_code),
  default_timezone text,
  enabled boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company_id, country_code)
);

CREATE TABLE offices (
  office_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  name text NOT NULL,
  country_code char(2) NOT NULL REFERENCES countries(country_code),
  address_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  locality text,
  administrative_area text,
  postal_code text,
  timezone text NOT NULL,
  default_currency char(3) REFERENCES currencies(currency_code),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, office_id),
  UNIQUE (company_id, name)
);

CREATE TABLE company_roles (
  role_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  role_key text NOT NULL,
  display_name text NOT NULL,
  is_system_role boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, role_id),
  UNIQUE (company_id, role_key)
);

CREATE TABLE role_permissions (
  company_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_key text NOT NULL,
  scope_policy text NOT NULL DEFAULT 'company'
    CHECK (scope_policy IN ('company','office','assigned','related','own')),
  PRIMARY KEY (company_id, role_id, permission_key),
  FOREIGN KEY (company_id, role_id) REFERENCES company_roles(company_id, role_id)
);

CREATE TABLE company_memberships (
  membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  user_id uuid NOT NULL REFERENCES users(user_id),
  role_id uuid NOT NULL,
  office_id uuid,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','active','suspended','revoked')),
  invited_by_user_id uuid REFERENCES users(user_id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, membership_id),
  UNIQUE (company_id, user_id),
  FOREIGN KEY (company_id, role_id) REFERENCES company_roles(company_id, role_id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices(company_id, office_id)
);

CREATE TABLE property_type_catalog (
  country_code char(2) NOT NULL REFERENCES countries(country_code),
  type_code text NOT NULL,
  label text NOT NULL,
  applicable_to text NOT NULL DEFAULT 'both'
    CHECK (applicable_to IN ('sale','rental','both')),
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (country_code, type_code)
);

CREATE TABLE company_property_types (
  company_id uuid NOT NULL REFERENCES companies(company_id),
  country_code char(2) NOT NULL REFERENCES countries(country_code),
  type_code text NOT NULL,
  display_label text,
  enabled boolean NOT NULL DEFAULT true,
  custom_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company_id, country_code, type_code),
  FOREIGN KEY (country_code, type_code)
    REFERENCES property_type_catalog(country_code, type_code)
);

CREATE TABLE contacts (
  contact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  contact_kind text NOT NULL DEFAULT 'person'
    CHECK (contact_kind IN ('person','organisation')),
  first_name text,
  last_name text,
  organisation_name text,
  display_name text NOT NULL,
  email text,
  email_normalized text,
  phone_e164 text,
  preferred_locale varchar(35) REFERENCES locales(locale_code),
  country_code char(2) REFERENCES countries(country_code),
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  communication_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, contact_id),
  CHECK (
    (contact_kind = 'person' AND (first_name IS NOT NULL OR last_name IS NOT NULL OR display_name <> ''))
    OR (contact_kind = 'organisation' AND organisation_name IS NOT NULL)
  )
);

CREATE TABLE contact_relationships (
  relationship_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  contact_id uuid NOT NULL,
  relationship_type text NOT NULL
    CHECK (relationship_type IN ('buyer','seller','landlord','tenant','supplier','contractor','other')),
  valid_from date,
  valid_to date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, relationship_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE properties (
  property_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  office_id uuid,
  country_code char(2) NOT NULL REFERENCES countries(country_code),
  property_type_code text NOT NULL,
  name text,
  address_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  locality text,
  administrative_area text,
  postal_code text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  timezone text NOT NULL,
  default_currency char(3) REFERENCES currencies(currency_code),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','available','reserved','under_contract','sold','rented','under_maintenance','archived')),
  tenure_type text,
  year_built smallint CHECK (year_built IS NULL OR year_built BETWEEN 1000 AND 3000),
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (company_id, property_id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices(company_id, office_id),
  FOREIGN KEY (company_id, country_code, property_type_code)
    REFERENCES company_property_types(company_id, country_code, type_code),
  FOREIGN KEY (company_id, created_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id),
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180)
);

CREATE TABLE property_ownerships (
  ownership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  property_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  ownership_share numeric(7,4) CHECK (ownership_share IS NULL OR ownership_share BETWEEN 0 AND 100),
  valid_from date,
  valid_to date,
  source_document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, ownership_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE units (
  unit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  property_id uuid NOT NULL,
  unit_code text NOT NULL,
  label text,
  bedrooms numeric(4,1) CHECK (bedrooms IS NULL OR bedrooms >= 0),
  bathrooms numeric(4,1) CHECK (bathrooms IS NULL OR bathrooms >= 0),
  floor_area numeric(12,3) CHECK (floor_area IS NULL OR floor_area >= 0),
  floor_area_unit text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','available','reserved','under_contract','sold','rented','under_maintenance','archived')),
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, unit_id),
  UNIQUE (company_id, property_id, unit_code),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id)
);

CREATE TABLE property_media (
  media_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  property_id uuid NOT NULL,
  unit_id uuid,
  media_type text NOT NULL CHECK (media_type IN ('photo','video','floor_plan','document','other')),
  storage_key text NOT NULL,
  original_filename text,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  checksum_sha256 char(64),
  caption text,
  sort_order integer NOT NULL DEFAULT 0,
  visibility text NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal','listing','landlord_portal','tenant_portal','restricted')),
  uploaded_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, media_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, unit_id),
  FOREIGN KEY (company_id, uploaded_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE agent_profiles (
  agent_profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  membership_id uuid NOT NULL,
  agent_code text,
  commission_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, agent_profile_id),
  UNIQUE (company_id, membership_id),
  FOREIGN KEY (company_id, membership_id) REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE leads (
  lead_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  contact_id uuid,
  assigned_membership_id uuid,
  property_id uuid,
  unit_id uuid,
  intent text NOT NULL CHECK (intent IN ('buy','sell','rent','let','invest','other')),
  source_code text,
  stage text NOT NULL DEFAULT 'new'
    CHECK (stage IN ('new','qualification','viewing_scheduled','negotiation','offer_accepted','contract','won','lost','disqualified')),
  estimated_value numeric(18,4) CHECK (estimated_value IS NULL OR estimated_value >= 0),
  currency_code char(3) REFERENCES currencies(currency_code),
  expected_close_date date,
  next_action_at timestamptz,
  lost_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (company_id, lead_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  FOREIGN KEY (company_id, assigned_membership_id) REFERENCES company_memberships(company_id, membership_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, unit_id)
);

CREATE TABLE lead_activities (
  activity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  lead_id uuid NOT NULL,
  actor_membership_id uuid,
  activity_type text NOT NULL
    CHECK (activity_type IN ('note','call','email','message','task','stage_change','other')),
  subject text,
  body text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  next_action_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, activity_id),
  FOREIGN KEY (company_id, lead_id) REFERENCES leads(company_id, lead_id),
  FOREIGN KEY (company_id, actor_membership_id) REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE viewings (
  viewing_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  lead_id uuid,
  contact_id uuid,
  property_id uuid NOT NULL,
  unit_id uuid,
  assigned_membership_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','confirmed','completed','cancelled','no_show','rescheduled')),
  outcome text,
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, viewing_id),
  FOREIGN KEY (company_id, lead_id) REFERENCES leads(company_id, lead_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, unit_id),
  FOREIGN KEY (company_id, assigned_membership_id) REFERENCES company_memberships(company_id, membership_id),
  CHECK (ends_at > starts_at)
);

CREATE TABLE deals (
  deal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  lead_id uuid,
  property_id uuid NOT NULL,
  unit_id uuid,
  deal_type text NOT NULL CHECK (deal_type IN ('sale','rental','letting','other')),
  stage text NOT NULL DEFAULT 'qualification'
    CHECK (stage IN ('qualification','viewing','negotiation','offer_accepted','contract','closed_won','closed_lost')),
  asking_price numeric(18,4) CHECK (asking_price IS NULL OR asking_price >= 0),
  agreed_price numeric(18,4) CHECK (agreed_price IS NULL OR agreed_price >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies(currency_code),
  expected_close_date date,
  closed_at timestamptz,
  lost_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, deal_id),
  FOREIGN KEY (company_id, lead_id) REFERENCES leads(company_id, lead_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, unit_id)
);

CREATE TABLE deal_parties (
  company_id uuid NOT NULL REFERENCES companies(company_id),
  deal_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  party_role text NOT NULL CHECK (party_role IN ('buyer','seller','tenant','landlord','broker','other')),
  PRIMARY KEY (company_id, deal_id, contact_id, party_role),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals(company_id, deal_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id)
);

CREATE TABLE deal_stage_history (
  stage_history_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  deal_id uuid NOT NULL,
  from_stage text,
  to_stage text NOT NULL,
  changed_by_membership_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  UNIQUE (company_id, stage_history_id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals(company_id, deal_id),
  FOREIGN KEY (company_id, changed_by_membership_id) REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE lease_template_versions (
  template_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code char(2) NOT NULL REFERENCES countries(country_code),
  region_code text,
  language_code varchar(35) REFERENCES locales(locale_code),
  template_key text NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','published','retired')),
  effective_from date,
  effective_to date,
  storage_key text NOT NULL,
  checksum_sha256 char(64),
  review_notes text,
  reviewed_by text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_code, region_code, template_key, version_number),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

CREATE TABLE leases (
  lease_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  property_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  lease_reference text NOT NULL,
  jurisdiction_country_code char(2) NOT NULL REFERENCES countries(country_code),
  jurisdiction_region_code text,
  template_version_id uuid REFERENCES lease_template_versions(template_version_id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','active','expired','renewal_pending','terminated','cancelled')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  notice_date date,
  renewal_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (renewal_status IN ('not_applicable','not_started','due','in_progress','renewed','declined')),
  rent_amount numeric(18,4) NOT NULL CHECK (rent_amount >= 0),
  rent_currency char(3) NOT NULL REFERENCES currencies(currency_code),
  rent_frequency text NOT NULL DEFAULT 'monthly'
    CHECK (rent_frequency IN ('weekly','fortnightly','monthly','quarterly','annual','custom')),
  deposit_amount numeric(18,4) CHECK (deposit_amount IS NULL OR deposit_amount >= 0),
  deposit_currency char(3) REFERENCES currencies(currency_code),
  timezone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, lease_id),
  UNIQUE (company_id, lease_reference),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, unit_id),
  CHECK (ends_on >= starts_on),
  CHECK (deposit_amount IS NULL OR deposit_currency IS NOT NULL)
);

CREATE TABLE lease_parties (
  company_id uuid NOT NULL REFERENCES companies(company_id),
  lease_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  party_role text NOT NULL CHECK (party_role IN ('tenant','landlord','guarantor','agent','other')),
  valid_from date,
  valid_to date,
  PRIMARY KEY (company_id, lease_id, contact_id, party_role),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases(company_id, lease_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE rent_charges (
  rent_charge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  lease_id uuid NOT NULL,
  charge_type text NOT NULL DEFAULT 'rent'
    CHECK (charge_type IN ('rent','deposit','fee','utility','other')),
  period_start date,
  period_end date,
  due_date date NOT NULL,
  amount numeric(18,4) NOT NULL CHECK (amount >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies(currency_code),
  status text NOT NULL DEFAULT 'due' CHECK (status IN ('due','part_paid','paid','waived','void')),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, rent_charge_id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases(company_id, lease_id),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);

CREATE TABLE rent_payments (
  payment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  lease_id uuid NOT NULL,
  payer_contact_id uuid,
  received_at timestamptz,
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  currency_code char(3) NOT NULL REFERENCES currencies(currency_code),
  method_code text,
  status text NOT NULL DEFAULT 'recorded'
    CHECK (status IN ('pending','recorded','failed','reversed','refunded')),
  provider_reference text,
  idempotency_key text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, payment_id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases(company_id, lease_id),
  FOREIGN KEY (company_id, payer_contact_id) REFERENCES contacts(company_id, contact_id),
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE payment_allocations (
  allocation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  payment_id uuid NOT NULL,
  rent_charge_id uuid NOT NULL,
  amount numeric(18,4) NOT NULL CHECK (amount > 0),
  allocated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, allocation_id),
  FOREIGN KEY (company_id, payment_id) REFERENCES rent_payments(company_id, payment_id),
  FOREIGN KEY (company_id, rent_charge_id) REFERENCES rent_charges(company_id, rent_charge_id)
);

CREATE TABLE maintenance_requests (
  maintenance_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  property_id uuid NOT NULL,
  unit_id uuid,
  reported_by_contact_id uuid,
  assigned_membership_id uuid,
  title text NOT NULL,
  description text,
  category_code text,
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent','emergency')),
  status text NOT NULL DEFAULT 'reported'
    CHECK (status IN ('reported','triaged','assigned','in_progress','waiting','completed','closed','cancelled')),
  reported_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  completed_at timestamptz,
  closed_at timestamptz,
  estimated_cost numeric(18,4) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  cost_currency char(3) REFERENCES currencies(currency_code),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, maintenance_request_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, unit_id),
  FOREIGN KEY (company_id, reported_by_contact_id) REFERENCES contacts(company_id, contact_id),
  FOREIGN KEY (company_id, assigned_membership_id) REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE maintenance_status_history (
  history_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  maintenance_request_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  changed_by_membership_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  note text,
  UNIQUE (company_id, history_id),
  FOREIGN KEY (company_id, maintenance_request_id)
    REFERENCES maintenance_requests(company_id, maintenance_request_id),
  FOREIGN KEY (company_id, changed_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE operational_finance_entries (
  finance_entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  entry_type text NOT NULL CHECK (entry_type IN ('income','expense','commission','adjustment','refund')),
  category_code text NOT NULL,
  property_id uuid,
  unit_id uuid,
  lease_id uuid,
  deal_id uuid,
  contact_id uuid,
  occurred_on date NOT NULL,
  amount numeric(18,4) NOT NULL CHECK (amount >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies(currency_code),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','rejected','paid','void')),
  description text,
  external_reference text,
  created_by_membership_id uuid,
  approved_by_membership_id uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, finance_entry_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, unit_id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases(company_id, lease_id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals(company_id, deal_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  FOREIGN KEY (company_id, created_by_membership_id) REFERENCES company_memberships(company_id, membership_id),
  FOREIGN KEY (company_id, approved_by_membership_id) REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE commission_records (
  commission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  deal_id uuid NOT NULL,
  agent_membership_id uuid NOT NULL,
  calculation_basis numeric(18,4) NOT NULL CHECK (calculation_basis >= 0),
  rate numeric(9,6) CHECK (rate IS NULL OR rate >= 0),
  fixed_amount numeric(18,4) CHECK (fixed_amount IS NULL OR fixed_amount >= 0),
  amount_due numeric(18,4) NOT NULL CHECK (amount_due >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies(currency_code),
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','payable','paid','disputed','void')),
  approved_by_membership_id uuid,
  approved_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, commission_id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals(company_id, deal_id),
  FOREIGN KEY (company_id, agent_membership_id) REFERENCES company_memberships(company_id, membership_id),
  FOREIGN KEY (company_id, approved_by_membership_id) REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE documents (
  document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  document_type text NOT NULL,
  title text NOT NULL,
  sensitivity text NOT NULL DEFAULT 'confidential'
    CHECK (sensitivity IN ('internal','confidential','restricted')),
  property_id uuid,
  unit_id uuid,
  contact_id uuid,
  lease_id uuid,
  deal_id uuid,
  maintenance_request_id uuid,
  created_by_membership_id uuid,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  retention_until date,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, document_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, unit_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases(company_id, lease_id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals(company_id, deal_id),
  FOREIGN KEY (company_id, maintenance_request_id)
    REFERENCES maintenance_requests(company_id, maintenance_request_id),
  FOREIGN KEY (company_id, created_by_membership_id) REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE document_versions (
  document_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  document_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  storage_key text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  checksum_sha256 char(64) NOT NULL,
  uploaded_by_membership_id uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  change_note text,
  UNIQUE (company_id, document_version_id),
  UNIQUE (company_id, document_id, version_number),
  FOREIGN KEY (company_id, document_id) REFERENCES documents(company_id, document_id),
  FOREIGN KEY (company_id, uploaded_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE document_access_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  document_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(user_id),
  access_level text NOT NULL CHECK (access_level IN ('view','download','manage')),
  granted_by_membership_id uuid,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, grant_id),
  FOREIGN KEY (company_id, document_id) REFERENCES documents(company_id, document_id),
  FOREIGN KEY (company_id, granted_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE audit_logs (
  audit_log_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  actor_user_id uuid REFERENCES users(user_id),
  actor_membership_id uuid,
  action_key text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id text,
  ip_address inet,
  user_agent text,
  change_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (company_id, actor_membership_id)
    REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE notifications (
  notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  recipient_user_id uuid NOT NULL REFERENCES users(user_id),
  notification_type text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app','email','sms','push')),
  subject text,
  body text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','delivered','failed','read','cancelled')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  read_at timestamptz,
  related_entity_type text,
  related_entity_id uuid,
  deduplication_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, notification_id),
  UNIQUE (company_id, deduplication_key)
);

CREATE TABLE automation_rules (
  automation_rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  rule_key text NOT NULL,
  name text NOT NULL,
  trigger_type text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, automation_rule_id),
  UNIQUE (company_id, rule_key),
  FOREIGN KEY (company_id, created_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id)
);

CREATE TABLE automation_runs (
  automation_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  automation_rule_id uuid,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, automation_run_id),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, automation_rule_id)
    REFERENCES automation_rules(company_id, automation_rule_id)
);

CREATE TABLE subscription_records (
  subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  provider_code text NOT NULL,
  provider_customer_ref text,
  provider_subscription_ref text,
  plan_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('trialing','active','past_due','paused','cancelled','expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  usage_limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, subscription_id),
  UNIQUE (provider_code, provider_subscription_ref)
);

CREATE TABLE landlord_property_access (
  access_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  user_id uuid NOT NULL REFERENCES users(user_id),
  contact_id uuid NOT NULL,
  property_id uuid NOT NULL,
  access_scope text NOT NULL DEFAULT 'property_summary'
    CHECK (access_scope IN ('property_summary','financial_summary','documents','maintenance','full_permitted_portal')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  granted_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, access_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, granted_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE tenant_lease_access (
  access_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  user_id uuid NOT NULL REFERENCES users(user_id),
  contact_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  granted_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, access_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases(company_id, lease_id),
  FOREIGN KEY (company_id, granted_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

-- Performance indexes for common tenant-scoped work queues and lookups.
CREATE INDEX idx_properties_company_status ON properties(company_id, status) WHERE archived_at IS NULL;
CREATE INDEX idx_properties_company_country ON properties(company_id, country_code);
CREATE INDEX idx_units_company_property_status ON units(company_id, property_id, status);
CREATE INDEX idx_contacts_company_name ON contacts(company_id, display_name) WHERE archived_at IS NULL;
CREATE INDEX idx_contacts_company_email ON contacts(company_id, email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX idx_leads_company_stage_next_action ON leads(company_id, stage, next_action_at);
CREATE INDEX idx_leads_company_assignee ON leads(company_id, assigned_membership_id, updated_at DESC);
CREATE INDEX idx_lead_activities_company_lead_time ON lead_activities(company_id, lead_id, occurred_at DESC);
CREATE INDEX idx_viewings_company_schedule ON viewings(company_id, starts_at, status);
CREATE INDEX idx_deals_company_stage_close ON deals(company_id, stage, expected_close_date);
CREATE INDEX idx_leases_company_status_end ON leases(company_id, status, ends_on);
CREATE INDEX idx_rent_charges_company_due_status ON rent_charges(company_id, due_date, status);
CREATE INDEX idx_rent_payments_company_lease_received ON rent_payments(company_id, lease_id, received_at DESC);
CREATE INDEX idx_payment_allocations_company_charge ON payment_allocations(company_id, rent_charge_id);
CREATE INDEX idx_maintenance_company_queue ON maintenance_requests(company_id, status, priority, due_at);
CREATE INDEX idx_finance_company_date_status ON operational_finance_entries(company_id, occurred_on, status);
CREATE INDEX idx_commissions_company_status ON commission_records(company_id, status, agent_membership_id);
CREATE INDEX idx_documents_company_type ON documents(company_id, document_type) WHERE archived_at IS NULL;
CREATE INDEX idx_audit_logs_company_time ON audit_logs(company_id, occurred_at DESC);
CREATE INDEX idx_notifications_user_status_schedule ON notifications(company_id, recipient_user_id, status, scheduled_at);
CREATE INDEX idx_automation_runs_company_status_schedule ON automation_runs(company_id, status, scheduled_at);
CREATE INDEX idx_landlord_access_user_active ON landlord_property_access(company_id, user_id, property_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_tenant_access_user_active ON tenant_lease_access(company_id, user_id, lease_id)
  WHERE revoked_at IS NULL;

-- RLS on tenant-owned tables. The application must set app.current_company_id
-- transaction-locally only after verifying the user's active membership.
-- Use a non-owner application DB role without BYPASSRLS in runtime.
DO $rls$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'company_settings','company_market_settings','offices','company_roles','role_permissions',
    'company_memberships','company_property_types','contacts','contact_relationships','properties',
    'property_ownerships','units','property_media','agent_profiles','leads','lead_activities',
    'viewings','deals','deal_parties','deal_stage_history','leases','lease_parties','rent_charges',
    'rent_payments','payment_allocations','maintenance_requests','maintenance_status_history',
    'operational_finance_entries','commission_records','documents','document_versions',
    'document_access_grants','audit_logs','notifications','automation_rules','automation_runs',
    'subscription_records','landlord_property_access','tenant_lease_access'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid) WITH CHECK (company_id = NULLIF(current_setting(''app.current_company_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$rls$;

COMMIT;

-- REQUIRED APPLICATION INVARIANTS NOT ENFORCED BY THIS DDL ALONE:
-- 1. Set app.current_company_id with SET LOCAL inside each transaction after membership validation.
-- 2. Runtime DB role must not own these tables and must not have BYPASSRLS/superuser.
-- 3. Validate landlord/tenant portal access against active access grant + resource relationship in every API request.
-- 4. Ensure allocated payments never exceed received payment or charge balance using transactional domain logic/locking.
-- 5. Ensure payment/charge currencies match or create explicit FX conversion records; never silently convert.
-- 6. Prevent overlapping active leases for the same unit with a transaction-safe exclusion/locking strategy.
-- 7. Enforce allowed status transitions and write immutable audit/history events in the same transaction.
-- 8. Add production-specific grants, retention policies, backup policies, test fixtures and reviewed seed data.
