-- =============================================================================
-- EstatePro · Migration 0011 · Documents, versions, links, sharing, templates,
-- required-document rules
-- =============================================================================
-- File bytes live in private object storage; the database holds metadata,
-- storage key, checksum, malware-scan state, version history and access.
-- =============================================================================

-- Country- and language-specific templates (lease agreements, offer letters,
-- notices, statements, receipts). Platform defaults have company_id NULL.
CREATE TABLE document_templates (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid         REFERENCES companies (id),
  template_type      text         NOT NULL CHECK (template_type IN (
                       'lease_agreement', 'lease_renewal', 'management_agreement', 'sale_agreement', 'reservation_form',
                       'offer_letter', 'notice', 'rent_receipt', 'rent_demand', 'landlord_statement',
                       'inspection_report', 'deposit_return', 'email', 'sms')),
  jurisdiction_code  text         REFERENCES jurisdictions (code),   -- NULL = usable anywhere
  usage              text         CHECK (usage IN ('residential', 'commercial', 'mixed')),
  locale_code        text         NOT NULL REFERENCES locales (code),
  code               text         NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name               text         NOT NULL,
  version_no         integer      NOT NULL DEFAULT 1 CHECK (version_no > 0),
  status             text         NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  body_storage_key   text,        -- DOCX/HTML source in object storage
  body_inline        text,        -- short templates (email/SMS)
  merge_schema       jsonb        NOT NULL DEFAULT '{}'::jsonb,   -- fields the template expects
  legal_review_note  text,
  effective_from     date,
  supersedes_id      uuid         REFERENCES document_templates (id),
  created_by         uuid,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  version            integer      NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT (company_id, code, jurisdiction_code, locale_code, version_no),
  CHECK ((body_storage_key IS NULL) <> (body_inline IS NULL))
);
-- One active version per template code, jurisdiction and language.
CREATE UNIQUE INDEX document_templates_one_active_idx
  ON document_templates (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), code,
                         coalesce(jurisdiction_code, ''), locale_code)
  WHERE status = 'active';
CREATE INDEX document_templates_lookup_idx ON document_templates (template_type, jurisdiction_code, locale_code) WHERE status = 'active';

CREATE TABLE documents (
  id                   uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid         NOT NULL,
  title                text         NOT NULL,
  document_type_code   text         NOT NULL,     -- picklist: document_type (title_deed, lease, id_copy, safety_certificate, …)
  category             text         NOT NULL CHECK (category IN ('legal', 'financial', 'compliance', 'identity', 'property', 'correspondence', 'media', 'other')),
  confidentiality      text         NOT NULL DEFAULT 'internal' CHECK (confidentiality IN ('internal', 'restricted', 'shareable')),
  jurisdiction_code    text         REFERENCES jurisdictions (code),
  locale_code          text         REFERENCES locales (code),
  issued_on            date,
  expires_on           date,
  current_version_id   uuid,
  owner_membership_id  uuid,
  retention_until      date,
  legal_hold           boolean      NOT NULL DEFAULT false,
  archived_at          timestamptz,
  created_by           uuid,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  version              integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, owner_membership_id) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX documents_expiry_idx ON documents (company_id, expires_on) WHERE expires_on IS NOT NULL AND archived_at IS NULL;
CREATE INDEX documents_type_idx ON documents (company_id, document_type_code);
CREATE INDEX documents_title_trgm_idx ON documents USING gin (title gin_trgm_ops);

-- Versions are immutable once uploaded; only scan results may be recorded.
CREATE TABLE document_versions (
  id                    uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid         NOT NULL,
  document_id           uuid         NOT NULL,
  version_no            integer      NOT NULL CHECK (version_no > 0),
  storage_key           text         NOT NULL,
  file_name             text         NOT NULL,
  mime_type             text         NOT NULL,
  size_bytes            bigint       NOT NULL CHECK (size_bytes > 0),
  checksum_sha256       bytea        NOT NULL,
  scan_status           text         NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),
  scanned_at            timestamptz,
  generated_from_template_id uuid    REFERENCES document_templates (id),
  is_signed             boolean      NOT NULL DEFAULT false,
  signature_provider    text,
  signature_reference   text,
  change_note           text,
  uploaded_by           uuid,
  uploaded_by_contact_id uuid,       -- portal uploads
  uploaded_at           timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, document_id, version_no),
  FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id),
  FOREIGN KEY (company_id, uploaded_by) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, uploaded_by_contact_id) REFERENCES contacts (company_id, id)
);
CREATE INDEX document_versions_scan_idx ON document_versions (scan_status, uploaded_at) WHERE scan_status = 'pending';

CREATE TRIGGER document_versions_immutable BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION app.freeze_when_posted('scan_status', 'pending,clean,infected,failed', 'scan_status,scanned_at');

ALTER TABLE documents
  ADD FOREIGN KEY (company_id, current_version_id) REFERENCES document_versions (company_id, id);

-- A document can relate to several records (a lease PDF → lease, unit, tenants).
CREATE TABLE document_links (
  company_id   uuid         NOT NULL,
  document_id  uuid         NOT NULL,
  entity_type  text         NOT NULL CHECK (entity_type IN ('property', 'unit', 'listing', 'development', 'contact', 'lead', 'deal',
                                                            'sales_transaction', 'lease', 'management_agreement', 'deposit',
                                                            'inspection', 'maintenance_request', 'supplier_invoice', 'statement', 'payout')),
  entity_id    uuid         NOT NULL,
  linked_by    uuid,
  linked_at    timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, document_id, entity_type, entity_id),
  FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id) ON DELETE CASCADE
);
CREATE INDEX document_links_entity_idx ON document_links (company_id, entity_type, entity_id);

-- Explicit sharing with portal users or specific staff. Nothing is visible in
-- a portal unless shared here.
CREATE TABLE document_shares (
  id                         uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id                 uuid         NOT NULL,
  document_id                uuid         NOT NULL,
  shared_with_contact_id     uuid,
  shared_with_membership_id  uuid,
  permission                 text         NOT NULL DEFAULT 'view' CHECK (permission IN ('view', 'download')),
  shared_by                  uuid         NOT NULL,
  shared_at                  timestamptz  NOT NULL DEFAULT now(),
  expires_at                 timestamptz,
  revoked_at                 timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, shared_with_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, shared_with_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, shared_by) REFERENCES company_memberships (company_id, id),
  CHECK ((shared_with_contact_id IS NULL) <> (shared_with_membership_id IS NULL))
);
CREATE INDEX document_shares_contact_idx ON document_shares (company_id, shared_with_contact_id) WHERE revoked_at IS NULL;

-- Which documents must exist for a record, by jurisdiction (e.g. a safety
-- certificate before a let, KYC identity before a sale completes).
CREATE TABLE required_document_rules (
  id                  uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id          uuid         REFERENCES companies (id),
  jurisdiction_code   text         REFERENCES jurisdictions (code),
  applies_to          text         NOT NULL CHECK (applies_to IN ('property', 'unit', 'listing', 'lease', 'deal', 'contact', 'management_agreement')),
  conditions          jsonb        NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"listing_type": "rent", "usage": "residential"}
  document_type_code  text         NOT NULL,
  blocking_stage      text,        -- status/stage that cannot be entered without it (e.g. 'active', 'available')
  validity_days       integer      CHECK (validity_days > 0),
  remind_before_days  integer      CHECK (remind_before_days >= 0),
  is_active           boolean      NOT NULL DEFAULT true,
  source_reference    text,
  created_at          timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX required_document_rules_lookup_idx ON required_document_rules (applies_to, jurisdiction_code) WHERE is_active;

-- Document foreign keys for tables created before this migration.
ALTER TABLE agent_profiles        ADD FOREIGN KEY (company_id, photo_document_id)    REFERENCES documents (company_id, id);
ALTER TABLE identity_documents    ADD FOREIGN KEY (company_id, document_id)          REFERENCES documents (company_id, id);
ALTER TABLE property_ownerships   ADD FOREIGN KEY (company_id, evidence_document_id) REFERENCES documents (company_id, id);
ALTER TABLE sales_transactions    ADD FOREIGN KEY (company_id, contract_document_id) REFERENCES documents (company_id, id);
ALTER TABLE management_agreements ADD FOREIGN KEY (company_id, document_id)          REFERENCES documents (company_id, id);
ALTER TABLE leases                ADD FOREIGN KEY (company_id, document_id)          REFERENCES documents (company_id, id);
ALTER TABLE leases                ADD FOREIGN KEY (template_id)                      REFERENCES document_templates (id);
ALTER TABLE deposit_deductions    ADD FOREIGN KEY (company_id, evidence_document_id) REFERENCES documents (company_id, id);
ALTER TABLE arrears_actions       ADD FOREIGN KEY (company_id, document_id)          REFERENCES documents (company_id, id);
ALTER TABLE inspections           ADD FOREIGN KEY (company_id, report_document_id)   REFERENCES documents (company_id, id);
ALTER TABLE maintenance_quotes    ADD FOREIGN KEY (company_id, document_id)          REFERENCES documents (company_id, id);
ALTER TABLE supplier_invoices     ADD FOREIGN KEY (company_id, document_id)          REFERENCES documents (company_id, id);
ALTER TABLE statements            ADD FOREIGN KEY (company_id, document_id)          REFERENCES documents (company_id, id);
