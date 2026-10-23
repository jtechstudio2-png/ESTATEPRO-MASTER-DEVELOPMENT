-- =============================================================================
-- Tenant isolation tests. Runs as the runtime role estatepro_app.
-- Everything happens in one transaction and is rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;

-- 1. No company context: nothing is visible (fail closed).
SELECT test_assert((SELECT count(*) FROM contacts) = 0, 'no context: contacts hidden');
SELECT test_assert((SELECT count(*) FROM companies) = 0, 'no context: companies hidden');
SELECT test_assert((SELECT count(*) FROM properties) = 0, 'no context: properties hidden');

-- 2. Company A context.
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

SELECT test_assert((SELECT count(*) FROM companies) = 1, 'A sees exactly one company');
SELECT test_assert((SELECT count(*) FROM contacts) = 3, 'A sees its 3 contacts only');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM contacts WHERE company_id <> 'a0000000-0000-0000-0000-000000000001'),
                   'A sees no foreign contacts');
SELECT test_assert((SELECT count(*) FROM units) = 2, 'A sees its 2 units only');
SELECT test_assert((SELECT count(*) FROM offices) = 1, 'A sees its office only');

-- 3. Writes into another company are rejected by RLS WITH CHECK.
SELECT test_expect_error(
  $$INSERT INTO contacts (company_id, contact_type, display_name)
    VALUES ('b0000000-0000-0000-0000-000000000001', 'person', 'Injected')$$,
  '42501', 'A cannot insert a contact into B');

SELECT test_expect_error(
  $$UPDATE contacts SET company_id = 'b0000000-0000-0000-0000-000000000001'
     WHERE id = 'a5000000-0000-0000-0000-000000000001'$$,
  '42501', 'A cannot move its contact into B');

-- 4. Updates and deletes of B's rows silently match nothing.
WITH u AS (UPDATE contacts SET display_name = 'hacked'
            WHERE id = 'b5000000-0000-0000-0000-000000000001' RETURNING 1)
SELECT test_assert((SELECT count(*) FROM u) = 0, 'A update of B contact affects 0 rows');
WITH d AS (DELETE FROM listings WHERE company_id = 'b0000000-0000-0000-0000-000000000001' RETURNING 1)
SELECT test_assert((SELECT count(*) FROM d) = 0, 'A delete of B listings affects 0 rows');

-- 5. Composite foreign keys: A's unit cannot point at B's property, even if
--    the caller guesses B's id.
SELECT test_expect_error(
  $$INSERT INTO units (company_id, property_id, reference, unit_label)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000001', 'UNT-X', 'Sneaky')$$,
  '23503', 'A unit cannot reference B property (composite FK)');

SELECT test_expect_error(
  $$INSERT INTO lease_parties (company_id, lease_id, contact_id, party_role)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
            'b5000000-0000-0000-0000-000000000001', 'tenant')$$,
  '23503', 'A lease cannot include a B contact');

-- 6. Shared configuration: platform defaults visible, B's private rows not.
SELECT test_assert((SELECT count(*) FROM property_types WHERE company_id IS NULL) > 30, 'A sees platform property types');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM property_types WHERE code = 'b_private_type'), 'A cannot see B private property type');
SELECT test_assert((SELECT count(*) FROM roles WHERE company_id IS NULL) = 9, 'A sees the 9 system roles');

-- 7. Referencing another company's private configuration is blocked by trigger
--    (plain FK checks ignore RLS).
SELECT test_expect_error(
  $$UPDATE properties SET property_type_id = 'b6000000-0000-0000-0000-000000000001'
     WHERE id = 'a7000000-0000-0000-0000-000000000001'$$,
  '23503', 'A cannot use B private property type');

-- 8. A cannot edit platform defaults.
WITH u AS (UPDATE property_types SET name = 'Changed' WHERE company_id IS NULL RETURNING 1)
SELECT test_assert((SELECT count(*) FROM u) = 0, 'A cannot edit platform property types');
SELECT test_expect_error(
  $$INSERT INTO property_types (company_id, code, name, usage_class) VALUES (NULL, 'x', 'X', 'other')$$,
  '42501', 'A cannot create platform-level property types');

-- 9. Company-specific configuration works.
INSERT INTO property_types (company_id, code, name, usage_class, applies_to, country_code)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a_shop_and_flat', 'Shop with flat above', 'mixed_use', 'property', 'GH');
SELECT test_assert(EXISTS (SELECT 1 FROM property_types WHERE code = 'a_shop_and_flat'), 'A can add its own property type');

-- 10. Secrets and partitions are not reachable directly.
SELECT test_expect_error($$SELECT * FROM user_credentials$$, '42501', 'app role cannot read password hashes');
SELECT test_expect_error($$SELECT * FROM mfa_factors$$, '42501', 'app role cannot read MFA secrets');
SELECT test_expect_error($$SELECT * FROM audit_logs_default$$, '42501', 'app role cannot bypass RLS via a partition');
SELECT test_expect_error($$INSERT INTO currencies (code, name, minor_units) VALUES ('XXX', 'Test', 2)$$, '42501',
                         'app role cannot change global reference data');

-- 11. Users: own company's members only.
SELECT test_assert((SELECT count(*) FROM users) = 3, 'A sees its 3 users');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM users WHERE email = 'owner@londonlettings.test'), 'A cannot see B users');

-- 12. Views and functions respect the caller's RLS.
SELECT test_assert((SELECT count(*) FROM rent_charge_balances) = 2, 'balance view shows A charges');

-- 13. Audit log isolation.
INSERT INTO audit_logs (company_id, actor_type, actor_user_id, action, entity_type, entity_id)
VALUES ('a0000000-0000-0000-0000-000000000001', 'user', 'a1000000-0000-0000-0000-000000000001', 'contact.viewed', 'contact',
        'a5000000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$INSERT INTO audit_logs (company_id, actor_type, action) VALUES ('b0000000-0000-0000-0000-000000000001', 'system', 'forged')$$,
  '42501', 'A cannot write audit events for B');
SELECT test_expect_error($$DELETE FROM audit_logs$$, '42501', 'audit log cannot be deleted');

-- 14. Switch to company B in the same session: A's data disappears.
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'b1000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) FROM contacts) = 1, 'B sees its 1 contact');
SELECT test_assert((SELECT count(*) FROM audit_logs) = 0, 'B cannot see A audit events');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM property_types WHERE code = 'a_shop_and_flat'), 'B cannot see A property type');
SELECT test_assert((SELECT count(*) FROM rent_charge_balances) = 0, 'B sees no A balances');

ROLLBACK;
\echo '01_tenant_isolation: all assertions passed'
