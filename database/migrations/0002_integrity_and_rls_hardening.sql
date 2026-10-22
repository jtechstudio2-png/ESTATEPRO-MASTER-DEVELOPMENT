-- EstatePro Phase 2 integrity hardening
-- Apply after 0001_initial_schema.sql. PostgreSQL 15+.
BEGIN;

-- Bind a unit to the property that actually contains it. Individual property and
-- unit foreign keys alone would not prevent a mismatched property_id/unit_id pair.
ALTER TABLE units
  ADD CONSTRAINT uq_units_company_property_unit
  UNIQUE (company_id, property_id, unit_id);

ALTER TABLE property_media
  ADD CONSTRAINT fk_property_media_unit_property
  FOREIGN KEY (company_id, property_id, unit_id)
  REFERENCES units(company_id, property_id, unit_id);

ALTER TABLE leads
  ADD CONSTRAINT fk_leads_unit_property
  FOREIGN KEY (company_id, property_id, unit_id)
  REFERENCES units(company_id, property_id, unit_id);

ALTER TABLE viewings
  ADD CONSTRAINT fk_viewings_unit_property
  FOREIGN KEY (company_id, property_id, unit_id)
  REFERENCES units(company_id, property_id, unit_id);

ALTER TABLE deals
  ADD CONSTRAINT fk_deals_unit_property
  FOREIGN KEY (company_id, property_id, unit_id)
  REFERENCES units(company_id, property_id, unit_id);

ALTER TABLE leases
  ADD CONSTRAINT fk_leases_unit_property
  FOREIGN KEY (company_id, property_id, unit_id)
  REFERENCES units(company_id, property_id, unit_id);

ALTER TABLE maintenance_requests
  ADD CONSTRAINT fk_maintenance_unit_property
  FOREIGN KEY (company_id, property_id, unit_id)
  REFERENCES units(company_id, property_id, unit_id);

ALTER TABLE operational_finance_entries
  ADD CONSTRAINT fk_finance_unit_property
  FOREIGN KEY (company_id, property_id, unit_id)
  REFERENCES units(company_id, property_id, unit_id);

ALTER TABLE documents
  ADD CONSTRAINT fk_documents_unit_property
  FOREIGN KEY (company_id, property_id, unit_id)
  REFERENCES units(company_id, property_id, unit_id);

-- The company table itself is tenant-scoped too. Without this policy, a role
-- with table access could query other company metadata even if child tables
-- were protected.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON companies
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

COMMIT;

-- Operational note:
-- For optional unit_id references, PostgreSQL's default MATCH SIMPLE means the
-- composite FK is checked when unit_id is non-null; property_id still has its
-- own FK. This allows property-level records with no specific unit while
-- ensuring that any specified unit belongs to the same property and company.
