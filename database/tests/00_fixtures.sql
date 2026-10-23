-- =============================================================================
-- Test fixtures: two companies in different markets.
--   Company A: Accra agency (Ghana, GHS)   Company B: London agency (UK, GBP)
-- Inserted as the migration owner (bypasses RLS). Fixed IDs for readability.
-- =============================================================================
\set ON_ERROR_STOP 1

-- Test helper: run SQL and require it to fail with the given SQLSTATE.
CREATE OR REPLACE FUNCTION public.test_expect_error(p_sql text, p_sqlstate text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF SQLSTATE = p_sqlstate THEN
      RAISE NOTICE 'PASS  %', p_label;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL  % — expected SQLSTATE %, got % (%)', p_label, p_sqlstate, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  % — expected SQLSTATE %, but statement succeeded', p_label, p_sqlstate;
END
$$;

CREATE OR REPLACE FUNCTION public.test_assert(p_condition boolean, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL  %', p_label;
  END IF;
  RAISE NOTICE 'PASS  %', p_label;
END
$$;
GRANT EXECUTE ON FUNCTION public.test_expect_error(text, text, text), public.test_assert(boolean, text) TO estatepro_app;

INSERT INTO companies (id, legal_name, slug, status, headquarters_country_code, base_currency_code,
                       default_locale_code, default_timezone, data_region) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Accra Homes Ltd',   'accra-homes',   'active', 'GH', 'GHS', 'en-GH', 'Africa/Accra',  'eu-west'),
  ('b0000000-0000-0000-0000-000000000001', 'London Lettings Ltd', 'london-lettings', 'active', 'GB', 'GBP', 'en-GB', 'Europe/London', 'eu-west');

SELECT app.provision_company_defaults('a0000000-0000-0000-0000-000000000001');
SELECT app.provision_company_defaults('b0000000-0000-0000-0000-000000000001');

INSERT INTO users (id, email, display_name) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'owner@accrahomes.test',  'Ama Mensah'),
  ('a1000000-0000-0000-0000-000000000002', 'agent@accrahomes.test',  'Kwame Asante'),
  ('a1000000-0000-0000-0000-000000000003', 'accounts@accrahomes.test', 'Esi Boateng'),
  ('b1000000-0000-0000-0000-000000000001', 'owner@londonlettings.test', 'Daniel Clarke');

INSERT INTO user_credentials (user_id, password_hash) VALUES
  ('a1000000-0000-0000-0000-000000000001', '$argon2id$v=19$m=65536,t=3,p=4$placeholder');

INSERT INTO addresses (id, company_id, country_code, address_line_1, locality, admin_area_1, local_components, formatted) VALUES
  ('a2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'GH', '12 Oxford Street', 'Accra', 'Greater Accra',
   '{"digital_address": "GA-123-4567"}', '12 Oxford Street, Osu, Accra'),
  ('b2000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'GB', '1 High Street', 'London', NULL,
   '{}', '1 High Street, London SW1A 1AA');

INSERT INTO offices (id, company_id, code, name, country_code, jurisdiction_code, currency_code, locale_code, timezone, address_id, is_head_office) VALUES
  ('a3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'OSU', 'Osu office', 'GH', 'GH', 'GHS', 'en-GH', 'Africa/Accra',
   'a2000000-0000-0000-0000-000000000001', true),
  ('b3000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'LDN', 'London office', 'GB', 'GB-ENG', 'GBP', 'en-GB', 'Europe/London',
   'b2000000-0000-0000-0000-000000000001', true);

INSERT INTO company_memberships (id, company_id, user_id, role_id, membership_type, status) VALUES
  ('a4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
   (SELECT id FROM roles WHERE key = 'company_owner' AND company_id IS NULL), 'staff', 'active'),
  ('a4000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002',
   (SELECT id FROM roles WHERE key = 'agent' AND company_id IS NULL), 'staff', 'active'),
  ('a4000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003',
   (SELECT id FROM roles WHERE key = 'accountant' AND company_id IS NULL), 'staff', 'active'),
  ('b4000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
   (SELECT id FROM roles WHERE key = 'company_owner' AND company_id IS NULL), 'staff', 'active');

INSERT INTO contacts (id, company_id, contact_type, display_name, primary_email, primary_phone_e164) VALUES
  ('a5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'person', 'Kofi Owusu (landlord)', 'kofi@example.test', '+233201234567'),
  ('a5000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'person', 'Abena Darko (tenant)',  'abena@example.test', '+233241234567'),
  ('a5000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'person', 'Yaw Adjei (buyer)',     'yaw@example.test',   '+233271234567'),
  ('b5000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'person', 'Sarah Jones',           'sarah@example.test', '+447700900123');

INSERT INTO contact_relationships (company_id, contact_id, relationship_type) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', 'landlord'),
  ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000002', 'tenant'),
  ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'buyer');

-- Company B's private property type (must stay invisible to company A).
INSERT INTO property_types (id, company_id, code, name, usage_class, applies_to) VALUES
  ('b6000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'b_private_type', 'B private type', 'residential', 'both');

INSERT INTO properties (id, company_id, reference, name, property_type_id, office_id, address_id, jurisdiction_code, timezone) VALUES
  ('a7000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'PRP-2026-000001', 'Osu Court',
   (SELECT id FROM property_types WHERE code = 'apartment_building' AND company_id IS NULL),
   'a3000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'GH', 'Africa/Accra'),
  ('b7000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'PRP-2026-000001', 'High Street House',
   (SELECT id FROM property_types WHERE code = 'terraced' AND company_id IS NULL),
   'b3000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'GB-ENG', 'Europe/London');

INSERT INTO units (id, company_id, property_id, reference, unit_label, unit_type_id, bedrooms, floor_area_sqm) VALUES
  ('a8000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001',
   'UNT-2026-000001', 'Flat 1A', (SELECT id FROM property_types WHERE code = 'apartment' AND company_id IS NULL), 2, 85),
  ('a8000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001',
   'UNT-2026-000002', 'Flat 2B', (SELECT id FROM property_types WHERE code = 'chamber_and_hall' AND company_id IS NULL), 1, 40),
  ('b8000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000001',
   'UNT-2026-000001', 'Whole property', NULL, 3, 110);

INSERT INTO property_ownerships (company_id, property_id, owner_contact_id, effective_from) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', '2020-01-01');

INSERT INTO listings (id, company_id, reference, unit_id, listing_type, status, currency_code, price, rent_frequency,
                      advance_rent_periods, agent_membership_id, office_id, default_locale_code, title) VALUES
  ('a9000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'LST-2026-000001',
   'a8000000-0000-0000-0000-000000000001', 'rent', 'available', 'GHS', 6000, 'monthly', 12,
   'a4000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', 'en-GH', '2-bed apartment, Osu'),
  ('a9000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'LST-2026-000002',
   'a8000000-0000-0000-0000-000000000002', 'sale', 'available', 'GHS', 450000, NULL,
   NULL, 'a4000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', 'en-GH', 'Chamber and hall for sale');

INSERT INTO bank_accounts (id, company_id, name, account_purpose, country_code, currency_code) VALUES
  ('aa000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Client account GHS', 'client_money', 'GH', 'GHS');

INSERT INTO leases (id, company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date,
                    currency_code, rent_amount, rent_frequency, rent_due_day, advance_periods, signed_at) VALUES
  ('ab000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'LSE-2026-000001',
   'a8000000-0000-0000-0000-000000000001', 'GH', 'fixed_term', 'active', '2026-01-01', '2026-12-31',
   'GHS', 6000, 'monthly', 1, 12, '2025-12-20');

INSERT INTO lease_parties (company_id, lease_id, contact_id, party_role, is_primary) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000002', 'tenant', true),
  ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', 'landlord', false);

INSERT INTO rent_charges (id, company_id, lease_id, charge_type, description, period_start, period_end, due_date, currency_code, amount) VALUES
  ('ac000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
   'rent', 'Rent January 2026', '2026-01-01', '2026-01-31', '2026-01-01', 'GHS', 6000),
  ('ac000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
   'rent', 'Rent February 2026', '2026-02-01', '2026-02-28', '2026-02-01', 'GHS', 6000);

\echo 'fixtures loaded'
