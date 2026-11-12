-- =============================================================================
-- Field encryption keys and protected columns (migration 0021, ADR-007).
-- Runs as estatepro_app in company A, then as the platform role; rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- --------------------------------------------------------- runtime role rules
INSERT INTO company_data_keys (company_id, purpose, version, wrapped_key, kms_key_ref)
VALUES ('a0000000-0000-0000-0000-000000000001', 'field', 1, decode(repeat('ab', 60), 'hex'), 'local:test');
SELECT test_assert(
  (SELECT status = 'active' AND retired_at IS NULL FROM company_data_keys
    WHERE company_id = 'a0000000-0000-0000-0000-000000000001' AND purpose = 'field' AND version = 1),
  'the runtime role creates a company''s first key, active');
SELECT test_expect_error(
  $$INSERT INTO company_data_keys (company_id, purpose, version, wrapped_key, kms_key_ref)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'field', 2, decode(repeat('ab', 60), 'hex'), 'local:test')$$,
  '42501', 'the runtime role cannot add later key versions (rotation is the platform job)');
SELECT test_expect_error(
  $$INSERT INTO company_data_keys (company_id, purpose, version, wrapped_key, kms_key_ref)
    VALUES ('b0000000-0000-0000-0000-000000000002', 'field', 1, decode(repeat('ab', 60), 'hex'), 'local:test')$$,
  '42501', 'the runtime role cannot create keys for another company');
SELECT test_expect_error(
  $$UPDATE company_data_keys SET status = 'decrypt_only', retired_at = now()$$,
  '42501', 'the runtime role cannot change keys');
SELECT test_expect_error(
  $$DELETE FROM company_data_keys$$,
  '42501', 'the runtime role cannot delete keys');
SELECT test_expect_error(
  $$INSERT INTO company_data_keys (company_id, purpose, version, wrapped_key, kms_key_ref)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'secret', 1, decode(repeat('ab', 60), 'hex'), 'local:test')$$,
  '23514', 'key purpose is a controlled value');

-- --------------------------------------------------------- protected columns
SELECT test_expect_error(
  $$INSERT INTO contacts (company_id, contact_type, display_name, tax_number)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'person', 'Plain tax number', 'P0012345678')$$,
  '23514', 'an individual''s tax number is only stored encrypted (E-Q1)');
SELECT test_expect_error(
  $$INSERT INTO contacts (company_id, contact_type, display_name, tax_number_encrypted)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'person', 'No hash', decode(repeat('cd', 40), 'hex'))$$,
  '23514', 'an encrypted tax number comes with its lookup hash and display suffix');
INSERT INTO contacts (company_id, contact_type, display_name, organisation_name, tax_number)
VALUES ('a0000000-0000-0000-0000-000000000001', 'organisation', 'Org with TIN', 'Org Ltd', 'C0001112223');
SELECT test_assert(true, 'organisations keep their public tax number in plain text');

-- ---------------------------------------------------------- platform role rules
RESET ROLE;
SET LOCAL ROLE estatepro_platform;
SELECT test_expect_error(
  $$UPDATE company_data_keys SET wrapped_key = decode(repeat('ef', 60), 'hex')
     WHERE company_id = 'a0000000-0000-0000-0000-000000000001' AND purpose = 'field'$$,
  '23514', 'key material is never replaced');
SELECT test_expect_error(
  $$UPDATE company_data_keys SET status = 'destroyed', destroyed_at = now(), retired_at = now()
     WHERE company_id = 'a0000000-0000-0000-0000-000000000001' AND purpose = 'field'$$,
  '23514', 'a destroyed key has its key material erased');
UPDATE company_data_keys SET status = 'decrypt_only', retired_at = now()
 WHERE company_id = 'a0000000-0000-0000-0000-000000000001' AND purpose = 'field';
SELECT test_expect_error(
  $$UPDATE company_data_keys SET status = 'active', retired_at = NULL
     WHERE company_id = 'a0000000-0000-0000-0000-000000000001' AND purpose = 'field'$$,
  '23514', 'a retired key cannot become active again');
UPDATE company_data_keys SET status = 'destroyed', wrapped_key = NULL, destroyed_at = now()
 WHERE company_id = 'a0000000-0000-0000-0000-000000000001' AND purpose = 'field';
SELECT test_assert(
  (SELECT wrapped_key IS NULL FROM company_data_keys WHERE company_id = 'a0000000-0000-0000-0000-000000000001' AND purpose = 'field'),
  'destroying a key erases it (crypto-shredding)');
SELECT test_expect_error(
  $$DELETE FROM company_data_keys WHERE company_id = 'a0000000-0000-0000-0000-000000000001'$$,
  '42501', 'keys are destroyed, never deleted, so the history stays');

ROLLBACK;
