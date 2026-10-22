-- EstatePro Phase 2 international finance and commercial plan extensions
-- Apply after 0002_integrity_and_rls_hardening.sql.
BEGIN;

-- Versioned FX rates carry source and effective time; values are never silently applied.
CREATE TABLE exchange_rate_sources (
  source_code text PRIMARY KEY,
  display_name text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('manual','provider','central_bank','other')),
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE exchange_rates (
  exchange_rate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency char(3) NOT NULL REFERENCES currencies(currency_code),
  quote_currency char(3) NOT NULL REFERENCES currencies(currency_code),
  rate numeric(24,12) NOT NULL CHECK (rate > 0),
  effective_at timestamptz NOT NULL,
  source_code text NOT NULL REFERENCES exchange_rate_sources(source_code),
  source_reference text,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (base_currency <> quote_currency),
  UNIQUE (base_currency, quote_currency, effective_at, source_code)
);

CREATE INDEX idx_exchange_rates_pair_effective
  ON exchange_rates(base_currency, quote_currency, effective_at DESC);

CREATE TABLE currency_conversions (
  conversion_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  source_amount numeric(18,4) NOT NULL CHECK (source_amount >= 0),
  source_currency char(3) NOT NULL REFERENCES currencies(currency_code),
  target_amount numeric(18,4) NOT NULL CHECK (target_amount >= 0),
  target_currency char(3) NOT NULL REFERENCES currencies(currency_code),
  applied_rate numeric(24,12) NOT NULL CHECK (applied_rate > 0),
  exchange_rate_id uuid REFERENCES exchange_rates(exchange_rate_id),
  conversion_reason text NOT NULL,
  converted_at timestamptz NOT NULL DEFAULT now(),
  converted_by_membership_id uuid,
  rounding_policy text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, conversion_id),
  FOREIGN KEY (company_id, converted_by_membership_id)
    REFERENCES company_memberships(company_id, membership_id),
  CHECK (source_currency <> target_currency)
);

CREATE TABLE subscription_plans (
  plan_code text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  billing_interval text NOT NULL DEFAULT 'month'
    CHECK (billing_interval IN ('month','year','custom')),
  base_price numeric(18,4) CHECK (base_price IS NULL OR base_price >= 0),
  currency_code char(3) REFERENCES currencies(currency_code),
  public_description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_plan_features (
  plan_code text NOT NULL REFERENCES subscription_plans(plan_code),
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  limit_value numeric(18,4),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (plan_code, feature_key),
  CHECK (limit_value IS NULL OR limit_value >= 0)
);

CREATE TABLE company_usage_counters (
  usage_counter_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(company_id),
  metric_key text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  quantity numeric(20,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  last_calculated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (company_id, usage_counter_id),
  UNIQUE (company_id, metric_key, period_start, period_end),
  CHECK (period_end >= period_start)
);

ALTER TABLE companies
  ADD CONSTRAINT fk_companies_subscription_plan
  FOREIGN KEY (subscription_plan_code) REFERENCES subscription_plans(plan_code);

ALTER TABLE subscription_records
  ADD CONSTRAINT fk_subscription_records_plan
  FOREIGN KEY (plan_code) REFERENCES subscription_plans(plan_code);

ALTER TABLE property_ownerships
  ADD CONSTRAINT fk_property_ownership_source_document
  FOREIGN KEY (company_id, source_document_id)
  REFERENCES documents(company_id, document_id);

ALTER TABLE currency_conversions ENABLE ROW LEVEL SECURITY;
ALTER TABLE currency_conversions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON currency_conversions
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

ALTER TABLE company_usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_usage_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON company_usage_counters
  USING (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid)
  WITH CHECK (company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid);

-- Audit history is append-only for application roles. Retention should be handled
-- by a separately reviewed privileged maintenance process, not ordinary CRUD.
CREATE FUNCTION estatepro_reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP;
END;
$function$;

CREATE TRIGGER trg_audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION estatepro_reject_audit_mutation();

COMMIT;

-- Global exchange-rate records and subscription plan catalogues are platform-managed.
-- Restrict writes with database grants; tenant RLS does not apply to these reference tables.
