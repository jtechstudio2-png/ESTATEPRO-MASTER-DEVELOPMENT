-- =============================================================================
-- EstatePro · Migration 0013 · Row-level security, grants and generic triggers
-- =============================================================================
-- Tenant isolation is enforced twice: by the application (scoped repositories,
-- permission checks) and here by PostgreSQL RLS. RLS is ENABLED, not FORCED:
-- the table owner (migration role) and SECURITY DEFINER integrity functions
-- must see all rows; the runtime role estatepro_app never owns tables, so it is
-- always subject to the policies.
-- =============================================================================

-- Authentication service role: login, sign-up, MFA, sessions. Reads identity
-- tables across companies (e.g. to list a user's memberships) and nothing else.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'estatepro_auth') THEN
    CREATE ROLE estatepro_auth NOLOGIN BYPASSRLS;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA app, public TO estatepro_auth;

-- -----------------------------------------------------------------------------
-- Company id inheritance for child rows of shared configuration tables, so
-- translations / components / permissions always carry their parent's scope.
-- TG_ARGV[0]: parent table, TG_ARGV[1]: FK column pointing at parent.id
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.inherit_company_id() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  parent_company uuid;
BEGIN
  EXECUTE format('SELECT company_id FROM %I WHERE id = $1', TG_ARGV[0])
    INTO parent_company USING (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
  NEW.company_id := parent_company;
  RETURN NEW;
END
$$;

CREATE TRIGGER role_permissions_company BEFORE INSERT OR UPDATE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION app.inherit_company_id('roles', 'role_id');
CREATE TRIGGER picklist_value_translations_company BEFORE INSERT OR UPDATE ON picklist_value_translations
  FOR EACH ROW EXECUTE FUNCTION app.inherit_company_id('picklist_values', 'picklist_value_id');
CREATE TRIGGER property_type_translations_company BEFORE INSERT OR UPDATE ON property_type_translations
  FOR EACH ROW EXECUTE FUNCTION app.inherit_company_id('property_types', 'property_type_id');
CREATE TRIGGER tax_code_components_company BEFORE INSERT OR UPDATE ON tax_code_components
  FOR EACH ROW EXECUTE FUNCTION app.inherit_company_id('tax_codes', 'tax_code_id');

-- -----------------------------------------------------------------------------
-- References into shared configuration must point at a platform default or the
-- same company's row (FK checks alone ignore RLS).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('company_memberships',   'role_id',                    'roles'),
      ('invitations',           'role_id',                    'roles'),
      ('property_types',        'parent_id',                  'property_types'),
      ('properties',            'property_type_id',           'property_types'),
      ('units',                 'unit_type_id',               'property_types'),
      ('deals',                 'stage_id',                   'pipeline_stages'),
      ('deal_milestones',       'milestone_template_id',      'milestone_templates'),
      ('maintenance_requests',  'sla_policy_id',              'sla_policies'),
      ('planned_maintenance',   'sla_policy_id',              'sla_policies'),
      ('sales_transactions',    'agency_fee_tax_code_id',     'tax_codes'),
      ('management_agreements', 'fee_tax_code_id',            'tax_codes'),
      ('leases',                'rent_tax_code_id',           'tax_codes'),
      ('leases',                'template_id',                'document_templates'),
      ('rent_charges',          'tax_code_id',                'tax_codes'),
      ('finance_transactions',  'tax_code_id',                'tax_codes'),
      ('document_versions',     'generated_from_template_id', 'document_templates'),
      ('document_templates',    'supersedes_id',              'document_templates')
    ) AS t (tbl, col, ref)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I FOR EACH ROW
         EXECUTE FUNCTION app.enforce_shared_reference(%L, %L)',
      r.tbl || '_' || r.col || '_scope', r.col, r.tbl, r.ref, r.col);
  END LOOP;
END
$$;

-- updated_at + version on every table that has both columns.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'version' AND NOT a.attisdropped)
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.touch_row()',
                   t || '_touch', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO estatepro_app, estatepro_platform;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO estatepro_app, estatepro_platform, estatepro_auth;

-- Global reference data: read-only for the runtime role.
REVOKE INSERT, UPDATE, DELETE ON
  currencies, locales, countries, jurisdictions, jurisdiction_setting_definitions, jurisdiction_settings,
  public_holidays, fx_rates, plans, plan_prices, plan_entitlements, permissions
  FROM estatepro_app;

-- Identity secrets and platform staff: never visible to the runtime role.
REVOKE ALL ON user_credentials, mfa_factors, external_identities, auth_tokens, platform_staff FROM estatepro_app;
REVOKE INSERT, DELETE ON users FROM estatepro_app;
REVOKE INSERT, DELETE ON user_sessions FROM estatepro_app;

-- Append-only tables (also protected by triggers).
REVOKE UPDATE, DELETE ON audit_logs, ledger_entries, payment_allocations FROM estatepro_app;

-- Plan and subscription state is written by the billing service (platform role).
REVOKE INSERT, UPDATE, DELETE ON subscriptions, subscription_invoices, usage_counters FROM estatepro_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, user_credentials, mfa_factors, external_identities, auth_tokens, user_sessions
  TO estatepro_auth;
GRANT SELECT ON
  company_memberships, companies, roles, role_permissions, permissions, platform_staff, locales, countries
  TO estatepro_auth;
GRANT SELECT, UPDATE ON invitations TO estatepro_auth;
GRANT INSERT ON audit_logs TO estatepro_auth;

-- -----------------------------------------------------------------------------
-- Row-level security policies
-- -----------------------------------------------------------------------------
-- 1. Every company-owned table (company_id NOT NULL): full isolation.
-- 2. Shared configuration (company_id nullable): read platform rows + own rows;
--    write own rows only.
-- 3. Partitions: no direct grants; access goes through the parent table.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relispartition, a.attnotnull
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.relname);

    IF r.relispartition THEN
      EXECUTE format('REVOKE ALL ON %I FROM estatepro_app, estatepro_auth', r.relname);
      CONTINUE;
    END IF;

    IF r.attnotnull THEN
      EXECUTE format(
        'CREATE POLICY company_isolation ON %I FOR ALL TO estatepro_app
           USING (company_id = app.current_company_id())
           WITH CHECK (company_id = app.current_company_id())', r.relname);
    ELSIF r.relname = 'audit_logs' THEN
      EXECUTE
        'CREATE POLICY company_isolation ON audit_logs FOR ALL TO estatepro_app
           USING (company_id = app.current_company_id())
           WITH CHECK (company_id = app.current_company_id())';
      EXECUTE
        'CREATE POLICY auth_events ON audit_logs FOR INSERT TO estatepro_auth WITH CHECK (true)';
    ELSE
      EXECUTE format(
        'CREATE POLICY shared_read ON %I FOR SELECT TO estatepro_app
           USING (company_id IS NULL OR company_id = app.current_company_id())', r.relname);
      EXECUTE format(
        'CREATE POLICY own_insert ON %I FOR INSERT TO estatepro_app
           WITH CHECK (company_id = app.current_company_id())', r.relname);
      EXECUTE format(
        'CREATE POLICY own_update ON %I FOR UPDATE TO estatepro_app
           USING (company_id = app.current_company_id())
           WITH CHECK (company_id = app.current_company_id())', r.relname);
      EXECUTE format(
        'CREATE POLICY own_delete ON %I FOR DELETE TO estatepro_app
           USING (company_id = app.current_company_id())', r.relname);
    END IF;
  END LOOP;
END
$$;

-- Companies: a request sees only its own company row.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_self ON companies FOR ALL TO estatepro_app
  USING (id = app.current_company_id())
  WITH CHECK (id = app.current_company_id());
CREATE POLICY auth_read ON companies FOR SELECT TO estatepro_auth USING (true);

-- Users: yourself, plus people who share the current company.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT TO estatepro_app
  USING (id = app.current_user_id()
         OR EXISTS (SELECT 1 FROM company_memberships m
                     WHERE m.user_id = users.id AND m.company_id = app.current_company_id()));
CREATE POLICY users_self_update ON users FOR UPDATE TO estatepro_app
  USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());

-- Sessions: a user can list and revoke their own sessions.
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sessions_self ON user_sessions FOR ALL TO estatepro_app
  USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());

-- Identity tables (credentials, MFA, tokens): auth service only.
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_staff ENABLE ROW LEVEL SECURITY;
