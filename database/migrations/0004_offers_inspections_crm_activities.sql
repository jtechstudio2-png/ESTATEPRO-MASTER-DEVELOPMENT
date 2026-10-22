-- EstatePro Phase 2 sales offer, inspection and CRM activity extension
-- Apply after 0003_international_finance_and_plans.sql.
BEGIN;

CREATE TABLE offers (
  offer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  deal_id uuid NOT NULL,
  submitted_by_contact_id uuid,
  offer_amount numeric(18,4) NOT NULL CHECK (offer_amount >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies(currency_code),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','countered','accepted','rejected','withdrawn','expired')),
  submitted_at timestamptz,
  expires_at timestamptz,
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  supersedes_offer_id uuid,
  recorded_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, offer_id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals(company_id, deal_id),
  FOREIGN KEY (company_id, submitted_by_contact_id) REFERENCES contacts(company_id, contact_id),
  FOREIGN KEY (company_id, supersedes_offer_id) REFERENCES offers(company_id, offer_id),
  FOREIGN KEY (company_id, recorded_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id),
  CHECK (expires_at IS NULL OR submitted_at IS NULL OR expires_at >= submitted_at)
);

CREATE INDEX idx_offers_company_deal_created
  ON offers(company_id, deal_id, created_at DESC);

CREATE TABLE inspections (
  inspection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  property_id uuid NOT NULL,
  unit_id uuid,
  inspection_type text NOT NULL
    CHECK (inspection_type IN ('move_in','move_out','routine','condition','safety','maintenance_follow_up','other')),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('draft','scheduled','in_progress','completed','cancelled')),
  scheduled_at timestamptz,
  timezone text NOT NULL,
  performed_by_membership_id uuid,
  inspector_contact_id uuid,
  completed_at timestamptz,
  summary text,
  findings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, inspection_id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties(company_id, property_id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units(company_id, unit_id),
  FOREIGN KEY (company_id, property_id, unit_id) REFERENCES units(company_id, property_id, unit_id),
  FOREIGN KEY (company_id, performed_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id),
  FOREIGN KEY (company_id, inspector_contact_id) REFERENCES contacts(company_id, contact_id)
);

CREATE INDEX idx_inspections_company_schedule
  ON inspections(company_id, status, scheduled_at);

CREATE TABLE inspection_items (
  inspection_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  inspection_id uuid NOT NULL,
  section_key text NOT NULL,
  item_label text NOT NULL,
  result text NOT NULL DEFAULT 'not_checked'
    CHECK (result IN ('not_checked','pass','attention','fail','not_applicable')),
  notes text,
  evidence_document_id uuid,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, inspection_item_id),
  FOREIGN KEY (company_id, inspection_id) REFERENCES inspections(company_id, inspection_id),
  FOREIGN KEY (company_id, evidence_document_id) REFERENCES documents(company_id, document_id)
);

CREATE TABLE contact_activities (
  contact_activity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  contact_id uuid NOT NULL,
  related_lead_id uuid,
  actor_membership_id uuid,
  activity_type text NOT NULL
    CHECK (activity_type IN ('call','email','message','meeting','note','task','follow_up','other')),
  direction text CHECK (direction IN ('inbound','outbound','internal')),
  subject text,
  summary text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  next_action_at timestamptz,
  outcome_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, contact_activity_id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts(company_id, contact_id),
  FOREIGN KEY (company_id, related_lead_id) REFERENCES leads(company_id, lead_id),
  FOREIGN KEY (company_id, actor_membership_id)
    REFERENCES company_memberships(company_id, membership_id)
);

CREATE INDEX idx_contact_activities_company_contact_time
  ON contact_activities(company_id, contact_id, occurred_at DESC);
CREATE INDEX idx_contact_activities_company_next_action
  ON contact_activities(company_id, next_action_at)
  WHERE next_action_at IS NOT NULL;

DO $rls$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY['offers','inspections','inspection_items','contact_activities'];
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
