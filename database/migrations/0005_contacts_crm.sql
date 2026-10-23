-- =============================================================================
-- EstatePro · Migration 0005 · Contacts (clients) and CRM
-- =============================================================================
-- One contact per real person or organisation. Buyer, seller, landlord, tenant,
-- guarantor and supplier are RELATIONSHIPS of a contact, not separate tables,
-- so history follows the person across roles.
-- =============================================================================

CREATE TABLE contacts (
  id                         uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id                 uuid         NOT NULL REFERENCES companies (id),
  reference                  text,
  contact_type               text         NOT NULL CHECK (contact_type IN ('person', 'organisation')),
  -- Names: not every culture fits first/last. display_name is always set;
  -- structured parts are optional. display_name_local holds a native-script
  -- form (e.g. Arabic) for documents and search.
  display_name               text         NOT NULL,
  display_name_local         text,
  given_name                 text,
  family_name                text,
  other_names                text,
  title                      text,
  organisation_name          text,
  organisation_reg_number    text,
  tax_number                 text,
  primary_email              citext,
  primary_phone_e164         text         CHECK (primary_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  preferred_locale_code      text         REFERENCES locales (code),
  preferred_channel          text         CHECK (preferred_channel IN ('email', 'phone', 'sms', 'whatsapp', 'post')),
  nationality_country_code   char(2)      REFERENCES countries (code),
  residence_country_code     char(2)      REFERENCES countries (code),
  date_of_birth_encrypted    bytea,       -- envelope-encrypted; masked unless permitted
  address_id                 uuid,
  office_id                  uuid,
  owner_membership_id        uuid,        -- responsible staff member
  source_code                text,        -- picklist: lead_source
  notes                      text,
  custom_fields              jsonb        NOT NULL DEFAULT '{}'::jsonb,
  is_anonymised              boolean      NOT NULL DEFAULT false,
  merged_into_contact_id     uuid,
  archived_at                timestamptz,
  search_vector              tsvector GENERATED ALWAYS AS (
                               to_tsvector('simple',
                                 coalesce(display_name, '') || ' ' || coalesce(display_name_local, '') || ' ' ||
                                 coalesce(organisation_name, '') || ' ' || coalesce(primary_email::text, '') || ' ' ||
                                 coalesce(primary_phone_e164, '') || ' ' || coalesce(reference, ''))) STORED,
  created_by                 uuid,
  created_at                 timestamptz  NOT NULL DEFAULT now(),
  updated_at                 timestamptz  NOT NULL DEFAULT now(),
  version                    integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, address_id) REFERENCES addresses (company_id, id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id),
  FOREIGN KEY (company_id, owner_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, merged_into_contact_id) REFERENCES contacts (company_id, id),
  CHECK (contact_type = 'person' OR organisation_name IS NOT NULL),
  CHECK (merged_into_contact_id IS NULL OR merged_into_contact_id <> id)
);
CREATE INDEX contacts_search_idx ON contacts USING gin (search_vector);
CREATE INDEX contacts_name_trgm_idx ON contacts USING gin (display_name gin_trgm_ops);
CREATE INDEX contacts_email_idx ON contacts (company_id, primary_email) WHERE primary_email IS NOT NULL;
CREATE INDEX contacts_phone_idx ON contacts (company_id, primary_phone_e164) WHERE primary_phone_e164 IS NOT NULL;
CREATE INDEX contacts_owner_idx ON contacts (company_id, owner_membership_id) WHERE archived_at IS NULL;

ALTER TABLE company_memberships
  ADD FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id);
ALTER TABLE invitations
  ADD FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id);

CREATE TABLE contact_relationships (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid         NOT NULL,
  contact_id         uuid         NOT NULL,
  relationship_type  text         NOT NULL
                       CHECK (relationship_type IN ('buyer', 'seller', 'landlord', 'tenant', 'applicant',
                                                    'guarantor', 'supplier', 'developer', 'investor', 'other')),
  status             text         NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  started_on         date         NOT NULL DEFAULT current_date,
  ended_on           date,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX contact_relationships_active_idx
  ON contact_relationships (company_id, contact_id, relationship_type) WHERE status = 'active';
CREATE INDEX contact_relationships_type_idx ON contact_relationships (company_id, relationship_type) WHERE status = 'active';

CREATE TABLE contact_methods (
  id             uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id     uuid         NOT NULL,
  contact_id     uuid         NOT NULL,
  method_type    text         NOT NULL CHECK (method_type IN ('email', 'phone', 'mobile', 'whatsapp', 'fax', 'website', 'other')),
  value          text         NOT NULL,
  normalised     text         NOT NULL,       -- lower-cased email / E.164 phone, for dedupe
  label          text,
  is_primary     boolean      NOT NULL DEFAULT false,
  verified_at    timestamptz,
  opted_out_at   timestamptz,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_methods_dedupe_idx ON contact_methods (company_id, method_type, normalised);

-- Links between contacts: director of a company, spouse, representative, etc.
CREATE TABLE contact_links (
  company_id          uuid  NOT NULL,
  contact_id          uuid  NOT NULL,
  related_contact_id  uuid  NOT NULL,
  link_type           text  NOT NULL CHECK (link_type IN ('spouse', 'partner', 'director', 'employee', 'representative',
                                                          'power_of_attorney', 'family', 'other')),
  PRIMARY KEY (company_id, contact_id, related_contact_id, link_type),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, related_contact_id) REFERENCES contacts (company_id, id) ON DELETE CASCADE,
  CHECK (contact_id <> related_contact_id)
);

-- Bank and mobile-money accounts for landlord payouts, refunds and suppliers.
CREATE TABLE contact_payment_accounts (
  id                        uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id                uuid         NOT NULL,
  contact_id                uuid         NOT NULL,
  account_type              text         NOT NULL CHECK (account_type IN ('bank', 'mobile_money', 'other')),
  account_name              text         NOT NULL,
  provider_name             text         NOT NULL,        -- bank or mobile-money operator
  country_code              char(2)      NOT NULL REFERENCES countries (code),
  currency_code             char(3)      NOT NULL REFERENCES currencies (code),
  account_number_encrypted  bytea        NOT NULL,        -- account no. / IBAN / wallet number
  routing_encrypted         bytea,                        -- sort code / SWIFT / branch code
  last4                     text         NOT NULL CHECK (length(last4) BETWEEN 2 AND 4),
  verified_at               timestamptz,
  verified_by               uuid,
  is_default                boolean      NOT NULL DEFAULT false,
  -- Payouts to an account changed recently are held (cooling-off period).
  changed_at                timestamptz  NOT NULL DEFAULT now(),
  archived_at               timestamptz,
  created_at                timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, verified_by) REFERENCES company_memberships (company_id, id)
);
CREATE UNIQUE INDEX contact_payment_accounts_default_idx
  ON contact_payment_accounts (company_id, contact_id, currency_code) WHERE is_default AND archived_at IS NULL;

-- Identity documents for KYC. Type codes come from the id_document_type
-- picklist, scoped by country (passport, national ID card, residence permit…).
CREATE TABLE identity_documents (
  id                     uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id             uuid         NOT NULL,
  contact_id             uuid         NOT NULL,
  document_type_code     text         NOT NULL,
  issuing_country_code   char(2)      NOT NULL REFERENCES countries (code),
  number_encrypted       bytea        NOT NULL,
  number_hash            bytea        NOT NULL,     -- keyed hash for duplicate detection
  issued_on              date,
  expires_on             date,
  document_id            uuid,                      -- scanned copy (documents module)
  verified_at            timestamptz,
  verified_by            uuid,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, verified_by) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX identity_documents_hash_idx ON identity_documents (company_id, number_hash);
CREATE INDEX identity_documents_expiry_idx ON identity_documents (company_id, expires_on) WHERE expires_on IS NOT NULL;

-- KYC/AML review per contact (optionally per deal). The company performs the
-- regulated check; EstatePro records evidence, outcome and reviewer.
CREATE TABLE kyc_checks (
  id              uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id      uuid         NOT NULL,
  contact_id      uuid         NOT NULL,
  deal_id         uuid,
  check_type      text         NOT NULL CHECK (check_type IN ('identity', 'address', 'source_of_funds', 'sanctions_pep', 'company_ownership')),
  status          text         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'verified', 'failed', 'expired')),
  risk_rating     text         CHECK (risk_rating IN ('low', 'medium', 'high')),
  provider        text,
  provider_reference text,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  expires_on      date,
  notes           text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  version         integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, reviewed_by) REFERENCES company_memberships (company_id, id),
  CHECK (status NOT IN ('verified', 'failed') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX kyc_checks_contact_idx ON kyc_checks (company_id, contact_id, check_type);

CREATE TABLE consents (
  id             uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id     uuid         NOT NULL,
  contact_id     uuid         NOT NULL,
  purpose        text         NOT NULL CHECK (purpose IN ('marketing', 'property_alerts', 'data_processing', 'third_party_sharing', 'portal_terms')),
  channel        text         CHECK (channel IN ('email', 'sms', 'whatsapp', 'phone', 'post', 'any')),
  status         text         NOT NULL CHECK (status IN ('granted', 'withdrawn')),
  lawful_basis   text         CHECK (lawful_basis IN ('consent', 'contract', 'legal_obligation', 'legitimate_interest')),
  captured_at    timestamptz  NOT NULL DEFAULT now(),
  captured_via   text         NOT NULL,          -- web_form, portal, verbal, paper, import
  evidence       text,
  captured_by    uuid,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id) ON DELETE CASCADE
);
CREATE INDEX consents_contact_idx ON consents (company_id, contact_id, purpose, captured_at DESC);

-- What a buyer or tenant is looking for; drives listing matching.
CREATE TABLE requirements (
  id                 uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid           NOT NULL,
  contact_id         uuid           NOT NULL,
  requirement_type   text           NOT NULL CHECK (requirement_type IN ('buy', 'rent')),
  status             text           NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'fulfilled', 'cancelled')),
  currency_code      char(3)        NOT NULL REFERENCES currencies (code),
  min_price          numeric(19,4)  CHECK (min_price >= 0),
  max_price          numeric(19,4)  CHECK (max_price >= 0),
  rent_frequency     text           CHECK (rent_frequency IN ('weekly', 'monthly', 'quarterly', 'semi_annual', 'annual')),
  min_bedrooms       smallint       CHECK (min_bedrooms >= 0),
  max_bedrooms       smallint,
  property_type_ids  uuid[]         NOT NULL DEFAULT '{}',
  locations          jsonb          NOT NULL DEFAULT '[]'::jsonb,   -- localities / polygons / radius
  must_have_features text[]         NOT NULL DEFAULT '{}',
  move_by            date,
  financing_status   text           CHECK (financing_status IN ('cash', 'mortgage_approved', 'mortgage_in_progress', 'not_started', 'not_applicable')),
  notes              text,
  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),
  version            integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id),
  CHECK (max_price IS NULL OR min_price IS NULL OR max_price >= min_price),
  CHECK (requirement_type = 'rent' OR rent_frequency IS NULL)
);
CREATE INDEX requirements_active_idx ON requirements (company_id, requirement_type, max_price) WHERE status = 'active';

-- Activity timeline: calls, emails, messages, meetings, notes and system events.
CREATE TABLE activities (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid         NOT NULL,
  activity_type      text         NOT NULL CHECK (activity_type IN ('call', 'email', 'sms', 'whatsapp', 'meeting', 'note',
                                                                    'viewing', 'offer', 'status_change', 'document', 'portal', 'system')),
  direction          text         CHECK (direction IN ('inbound', 'outbound', 'internal')),
  subject            text,
  body               text,
  occurred_at        timestamptz  NOT NULL DEFAULT now(),
  duration_seconds   integer      CHECK (duration_seconds >= 0),
  outcome_code       text,
  performed_by       uuid,
  external_message_id text,       -- e-mail Message-ID / provider id, for dedupe of synced mail
  created_at         timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, performed_by) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX activities_company_time_idx ON activities (company_id, occurred_at DESC);
CREATE UNIQUE INDEX activities_external_idx ON activities (company_id, external_message_id) WHERE external_message_id IS NOT NULL;

-- One activity can relate to several records (contact, lead, deal, listing…).
-- entity_type/entity_id is polymorphic; the application validates the target
-- and a nightly integrity job reports orphans.
CREATE TABLE activity_links (
  company_id   uuid  NOT NULL,
  activity_id  uuid  NOT NULL,
  entity_type  text  NOT NULL CHECK (entity_type IN ('contact', 'lead', 'deal', 'listing', 'property', 'unit', 'lease', 'maintenance_request')),
  entity_id    uuid  NOT NULL,
  PRIMARY KEY (company_id, activity_id, entity_type, entity_id),
  FOREIGN KEY (company_id, activity_id) REFERENCES activities (company_id, id) ON DELETE CASCADE
);
CREATE INDEX activity_links_entity_idx ON activity_links (company_id, entity_type, entity_id);

CREATE TABLE tasks (
  id                uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id        uuid         NOT NULL,
  title             text         NOT NULL,
  description       text,
  task_type         text         NOT NULL DEFAULT 'follow_up'
                      CHECK (task_type IN ('follow_up', 'call', 'email', 'viewing_feedback', 'document_chase', 'renewal', 'arrears', 'inspection', 'other')),
  priority          text         NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status            text         NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  due_at            timestamptz,
  remind_at         timestamptz,
  assigned_to       uuid         NOT NULL,
  entity_type       text         CHECK (entity_type IN ('contact', 'lead', 'deal', 'listing', 'property', 'unit', 'lease', 'maintenance_request')),
  entity_id         uuid,
  source            text         NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'automation', 'system')),
  automation_rule_id uuid,
  completed_at      timestamptz,
  completed_by      uuid,
  created_by        uuid,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  version           integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, assigned_to) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, completed_by) REFERENCES company_memberships (company_id, id),
  CHECK ((entity_type IS NULL) = (entity_id IS NULL)),
  CHECK (status <> 'done' OR completed_at IS NOT NULL)
);
CREATE INDEX tasks_my_open_idx ON tasks (company_id, assigned_to, due_at) WHERE status = 'open';
CREATE INDEX tasks_entity_idx ON tasks (company_id, entity_type, entity_id);

-- -----------------------------------------------------------------------------
-- Leads: an enquiry or opportunity before (or instead of) a deal.
-- -----------------------------------------------------------------------------
CREATE TABLE leads (
  id                   uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid         NOT NULL,
  reference            text         NOT NULL,
  contact_id           uuid         NOT NULL,
  lead_type            text         NOT NULL CHECK (lead_type IN ('buy', 'rent', 'sell', 'let', 'valuation', 'management', 'other')),
  status               text         NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost')),
  source_code          text         NOT NULL,   -- picklist: lead_source
  source_detail        text,                    -- portal name, campaign, referrer
  campaign             text,
  listing_id           uuid,                    -- enquiry about a specific listing
  requirement_id       uuid,
  office_id            uuid,
  assigned_to          uuid,
  score                smallint     CHECK (score BETWEEN 0 AND 100),
  score_breakdown      jsonb        NOT NULL DEFAULT '{}'::jsonb,   -- rule → points, so scores are explainable
  received_at          timestamptz  NOT NULL DEFAULT now(),
  first_response_at    timestamptz,
  next_action_at       timestamptz,
  lost_reason_code     text,
  converted_deal_id    uuid,
  message              text,                    -- original enquiry text
  custom_fields        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  archived_at          timestamptz,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  version              integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, requirement_id) REFERENCES requirements (company_id, id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id),
  FOREIGN KEY (company_id, assigned_to) REFERENCES company_memberships (company_id, id),
  CHECK (status <> 'lost' OR lost_reason_code IS NOT NULL),
  CHECK (first_response_at IS NULL OR first_response_at >= received_at)
);
CREATE INDEX leads_queue_idx ON leads (company_id, assigned_to, status, next_action_at)
  WHERE status IN ('new', 'contacted', 'qualified') AND archived_at IS NULL;
CREATE INDEX leads_unassigned_idx ON leads (company_id, office_id, received_at) WHERE assigned_to IS NULL AND status = 'new';
CREATE INDEX leads_source_idx ON leads (company_id, source_code, received_at);
CREATE INDEX leads_contact_idx ON leads (company_id, contact_id);

CREATE TABLE lead_status_history (
  id           uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id   uuid         NOT NULL,
  lead_id      uuid         NOT NULL,
  from_status  text,
  to_status    text         NOT NULL,
  changed_at   timestamptz  NOT NULL DEFAULT now(),
  changed_by   uuid,
  note         text,
  FOREIGN KEY (company_id, lead_id) REFERENCES leads (company_id, id) ON DELETE CASCADE
);
CREATE INDEX lead_status_history_lead_idx ON lead_status_history (company_id, lead_id, changed_at);

CREATE TABLE lead_assignments (
  id             uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id     uuid         NOT NULL,
  lead_id        uuid         NOT NULL,
  assigned_to    uuid         NOT NULL,
  assigned_by    uuid,                  -- NULL = assignment rule
  assignment_rule text,
  assigned_at    timestamptz  NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, lead_id) REFERENCES leads (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, assigned_to) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX lead_assignments_lead_idx ON lead_assignments (company_id, lead_id, assigned_at);
