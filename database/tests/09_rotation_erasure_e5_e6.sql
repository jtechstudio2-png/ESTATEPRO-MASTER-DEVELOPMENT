-- =============================================================================
-- Key rotation and erasure (migration 0026, ADR-007 E5–E6). Rolled back.
-- Company A: the buyer (…0003) is erased; the tenant (…0002) is on a lease
-- and cannot be. The runtime role cannot use the erasure or rotation paths
-- of the guards directly.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- ------------------------------------------------------------------ helpers
SELECT test_assert(app.ciphertext_key_version('\x0100000002aabbcc'::bytea) = 2, 'the key version is read from the ciphertext header');
SELECT test_assert(app.ciphertext_key_version('\x02000000020000'::bytea) IS NULL, 'an unknown format has no key version');
SELECT test_assert(app.redact_json('{"name":{"old":"Yaw","new":"Yaw A."},"count":2,"flag":true,"tags":["a"]}'::jsonb)
  = '{"name":{"old":"[Erased]","new":"[Erased]"},"count":2,"flag":true,"tags":["[Erased]"]}'::jsonb,
  'redaction keeps keys, numbers and booleans and replaces every string');

-- ------------------------------------------------------- data about the buyer
UPDATE contacts SET given_name = 'Yaw', family_name = 'Adjei', notes = 'Prefers calls after 6pm',
       nationality_country_code = 'GH', custom_fields = '{"church":"Osu"}'::jsonb,
       tax_number_encrypted = '\x0100000001aa'::bytea, tax_number_hash = decode(repeat('cd', 32), 'hex'), tax_number_last4 = '7781'
 WHERE id = 'a5000000-0000-0000-0000-000000000003';
INSERT INTO contact_methods (company_id, contact_id, method_type, value, normalised)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'email', 'yaw.home@example.test', 'yaw.home@example.test');
INSERT INTO consents (company_id, contact_id, purpose, channel, status, lawful_basis, captured_via, evidence)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'marketing', 'email', 'granted', 'consent', 'web_form', 'Ticked box, IP 10.0.0.1');
INSERT INTO identity_documents (id, company_id, contact_id, document_type_code, issuing_country_code, number_encrypted, number_hash, number_last4, issued_on, expires_on)
VALUES ('a9200000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003',
        'passport', 'GH', '\x0100000001aabb'::bytea, decode(repeat('ab', 32), 'hex'), '4821', '2020-01-01', '2030-01-01');
UPDATE identity_documents SET verified_at = now(), verified_by = 'a4000000-0000-0000-0000-000000000001' WHERE id = 'a9200000-0000-0000-0000-000000000001';
INSERT INTO kyc_checks (id, company_id, contact_id, check_type, recorded_by, identity_document_id, notes)
VALUES ('a9300000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003',
        'identity', 'a4000000-0000-0000-0000-000000000002', 'a9200000-0000-0000-0000-000000000001', 'Passport seen in person');
UPDATE kyc_checks SET status = 'verified', risk_rating = 'low', reviewed_by = 'a4000000-0000-0000-0000-000000000001', reviewed_at = now()
 WHERE id = 'a9300000-0000-0000-0000-000000000001';
INSERT INTO leads (id, company_id, reference, contact_id, lead_type, source_code, assigned_to, message)
VALUES ('a9100000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'LEA-E-1',
        'a5000000-0000-0000-0000-000000000003', 'buy', 'website', 'a4000000-0000-0000-0000-000000000002', 'I am Yaw, call me on 0271234567');
INSERT INTO activities (id, company_id, activity_type, direction, subject, body, occurred_at, created_by, created_at)
VALUES ('a9400000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'call', 'outbound', 'Call with Yaw', 'Yaw wants 3 beds', '2026-10-01 09:00+00',
        'a4000000-0000-0000-0000-000000000002', now() - interval '30 days'),
       ('a9400000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'status_change', 'internal', NULL, 'Yaw: New → Contacted', now(),
        NULL, now());
INSERT INTO activity_links (company_id, activity_id, entity_type, entity_id)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a9400000-0000-0000-0000-000000000001', 'contact', 'a5000000-0000-0000-0000-000000000003'),
       ('a0000000-0000-0000-0000-000000000001', 'a9400000-0000-0000-0000-000000000002', 'lead', 'a9100000-0000-0000-0000-000000000001');
INSERT INTO activity_revisions (company_id, activity_id, revision_no, subject, body, occurred_at, edited_by)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a9400000-0000-0000-0000-000000000001', 1, 'Call', 'Yaw (first version)', '2026-10-01 09:00+00', 'a4000000-0000-0000-0000-000000000002');
INSERT INTO tasks (id, company_id, title, description, assigned_to, due_at, entity_type, entity_id)
VALUES ('a9500000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Call Yaw Adjei', 'About the Osu flat',
        'a4000000-0000-0000-0000-000000000002', now() + interval '1 day', 'contact', 'a5000000-0000-0000-0000-000000000003');
INSERT INTO audit_logs (company_id, actor_type, action, entity_type, entity_id, changes, metadata)
VALUES ('a0000000-0000-0000-0000-000000000001', 'user', 'contact.updated', 'contact', 'a5000000-0000-0000-0000-000000000003',
        '{"displayName":{"old":"Yaw","new":"Yaw Adjei (buyer)"}}', '{"source":"api"}'),
       ('a0000000-0000-0000-0000-000000000001', 'user', 'contact.updated', 'contact', 'a5000000-0000-0000-0000-000000000001',
        '{"displayName":{"old":"Kofi","new":"Kofi Owusu (landlord)"}}', '{}');

-- ------------------------------------- the runtime role cannot take the side doors
SELECT set_config('app.erasure', 'on', true);
SELECT test_expect_error(
  $$UPDATE identity_documents SET number_encrypted = NULL, number_hash = NULL, number_last4 = NULL, erased_at = now()
     WHERE id = 'a9200000-0000-0000-0000-000000000001'$$,
  '23514', 'the runtime role cannot erase a verified document by setting the erasure flag itself');
SELECT test_expect_error(
  $$UPDATE audit_logs SET changes = app.redact_json(changes) WHERE entity_id = 'a5000000-0000-0000-0000-000000000003'$$,
  '42501', 'the runtime role cannot redact audit rows');
SELECT test_expect_error(
  $$UPDATE activity_revisions SET body = '[Erased]' WHERE activity_id = 'a9400000-0000-0000-0000-000000000001'$$,
  '42501', 'the runtime role cannot rewrite revision history');
SELECT test_expect_error(
  $$UPDATE identity_documents SET number_encrypted = '\x0100000002aabb'::bytea WHERE id = 'a9200000-0000-0000-0000-000000000001'$$,
  '23514', 'the runtime role cannot re-encrypt a verified document (rotation is the platform job)');
SELECT set_config('app.erasure', 'off', true);
SELECT test_expect_error(
  $$INSERT INTO key_rotations (company_id, purpose, from_version, to_version, trigger_type, reason, requested_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'field', 1, 2, 'request', 'Testing', 'test')$$,
  '42501', 'the runtime role cannot start a rotation');

-- -------------------------------------------------------------------- blockers
SELECT test_assert(app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000002') @> ARRAY['lease_parties'],
  'a party to a lease cannot be erased (contractual records are kept)');
SELECT test_expect_error(
  $$SELECT app.erase_contact('a5000000-0000-0000-0000-000000000002')$$,
  '23514', 'erasure refuses a blocked contact');
INSERT INTO contacts (id, company_id, contact_type, display_name, organisation_name)
VALUES ('a9000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', 'organisation', 'Osu Traders', 'Osu Traders Ltd');
SELECT test_assert(app.contact_erasure_blockers('a9000000-0000-0000-0000-000000000009') = ARRAY['organisation'],
  'organisations are not people and are not erased');
SELECT test_assert(cardinality(app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000003')) = 0, 'the buyer can be erased');

-- --------------------------------------------------------------------- erasure
SELECT test_assert(
  (SELECT (app.erase_contact('a5000000-0000-0000-0000-000000000003') ->> 'contacts')::int = 1),
  'erasure reports what it erased');
SELECT test_assert(
  (SELECT is_anonymised AND display_name = 'Erased contact' AND given_name IS NULL AND primary_email IS NULL
          AND primary_phone_e164 IS NULL AND notes IS NULL AND nationality_country_code IS NULL AND custom_fields = '{}'::jsonb
          AND tax_number_encrypted IS NULL AND tax_number_hash IS NULL AND tax_number_last4 IS NULL
     FROM contacts WHERE id = 'a5000000-0000-0000-0000-000000000003'),
  'the contact keeps no name, contact details, notes or protected values');
SELECT test_assert(
  (SELECT search_vector IS NULL OR search_vector::text NOT LIKE '%yaw%' FROM contacts WHERE id = 'a5000000-0000-0000-0000-000000000003'),
  'the contact can no longer be found by name');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM contact_methods WHERE contact_id = 'a5000000-0000-0000-0000-000000000003'), 'contact methods are removed');
SELECT test_assert((SELECT evidence = '[Erased]' AND status = 'granted' FROM consents WHERE contact_id = 'a5000000-0000-0000-0000-000000000003'),
  'consent records stay (with their status) but lose their evidence text');
SELECT test_assert(
  (SELECT erased_at IS NOT NULL AND number_encrypted IS NULL AND number_hash IS NULL AND number_last4 IS NULL
          AND verified_at IS NOT NULL AND document_type_code = 'passport'
     FROM identity_documents WHERE id = 'a9200000-0000-0000-0000-000000000001'),
  'a verified identity document loses its number but keeps type, country and verification');
SELECT test_assert((SELECT notes = '[Erased]' AND status = 'verified' FROM kyc_checks WHERE id = 'a9300000-0000-0000-0000-000000000001'),
  'a signed-off KYC check keeps its decision and loses its notes');
SELECT test_assert((SELECT message = '[Erased]' FROM leads WHERE id = 'a9100000-0000-0000-0000-000000000001'), 'lead messages are erased');
SELECT test_assert(
  (SELECT bool_and(coalesce(subject, '[Erased]') = '[Erased]' AND body = '[Erased]') FROM activities
    WHERE id IN ('a9400000-0000-0000-0000-000000000001', 'a9400000-0000-0000-0000-000000000002')),
  'activities about the person or their leads are erased, including old and system entries');
SELECT test_assert((SELECT edited_at IS NULL FROM activities WHERE id = 'a9400000-0000-0000-0000-000000000001'), 'an erased activity is not marked as edited');
SELECT test_assert((SELECT body = '[Erased]' AND subject = '[Erased]' FROM activity_revisions WHERE activity_id = 'a9400000-0000-0000-0000-000000000001'),
  'earlier versions of activities are erased too');
SELECT test_assert((SELECT title = '[Erased]' AND description = '[Erased]' FROM tasks WHERE id = 'a9500000-0000-0000-0000-000000000001'),
  'follow-ups about the person are erased');
SELECT test_assert(
  (SELECT changes = '{"displayName":{"old":"[Erased]","new":"[Erased]"}}'::jsonb AND action = 'contact.updated'
     FROM audit_logs WHERE entity_id = 'a5000000-0000-0000-0000-000000000003' AND action = 'contact.updated'),
  'audit rows keep who changed which field and when, not the values');
SELECT test_assert(
  (SELECT changes ->> 'displayName' LIKE '%Kofi%' FROM audit_logs WHERE entity_id = 'a5000000-0000-0000-0000-000000000001'),
  'audit rows of other people are untouched');
SELECT test_assert((SELECT display_name = 'Kofi Owusu (landlord)' FROM contacts WHERE id = 'a5000000-0000-0000-0000-000000000001'),
  'other contacts are untouched');
SELECT test_assert((app.erase_contact('a5000000-0000-0000-0000-000000000003') ->> 'alreadyErased')::boolean,
  'erasing again changes nothing (ledger replay is idempotent)');
SELECT test_assert(current_setting('app.erasure', true) = 'off', 'the erasure flag is cleared afterwards');

-- ------------------------------------------------------------ stays erased
SELECT test_expect_error(
  $$UPDATE contacts SET given_name = 'Yaw' WHERE id = 'a5000000-0000-0000-0000-000000000003'$$,
  '23514', 'an anonymised contact cannot be given personal data again');
SELECT test_expect_error(
  $$UPDATE contacts SET is_anonymised = false WHERE id = 'a5000000-0000-0000-0000-000000000003'$$,
  '23514', 'an anonymised contact cannot be restored');
SELECT test_expect_error(
  $$UPDATE identity_documents SET number_last4 = '4821' WHERE id = 'a9200000-0000-0000-0000-000000000001'$$,
  '23514', 'an erased document cannot regain its number');

-- ------------------------------------------------------- other company is safe
SELECT test_expect_error(
  $$SELECT app.erase_contact('b5000000-0000-0000-0000-000000000001')$$,
  'P0002', 'another company''s contact is not found');

-- ------------------------------------------------------------------- rotation
RESET ROLE;
SET LOCAL ROLE estatepro_platform;
INSERT INTO identity_documents (id, company_id, contact_id, document_type_code, issuing_country_code, number_encrypted, number_hash, number_last4, issued_on, expires_on)
VALUES ('a9200000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001',
        'passport', 'GH', '\x0100000001aabb'::bytea, decode(repeat('ab', 32), 'hex'), '1234', '2020-01-01', '2030-01-01');
UPDATE identity_documents SET verified_at = now(), verified_by = 'a4000000-0000-0000-0000-000000000001' WHERE id = 'a9200000-0000-0000-0000-000000000002';
UPDATE identity_documents SET number_encrypted = '\x0100000002ccdd'::bytea WHERE id = 'a9200000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT app.ciphertext_key_version(number_encrypted) = 2 FROM identity_documents WHERE id = 'a9200000-0000-0000-0000-000000000002'),
  'the platform role re-encrypts a verified document under a newer key');
SELECT test_expect_error(
  $$UPDATE identity_documents SET number_encrypted = '\x0100000001eeff'::bytea WHERE id = 'a9200000-0000-0000-0000-000000000002'$$,
  '23514', 're-encryption only moves to a newer key');
UPDATE identity_documents SET number_hash = decode(repeat('ef', 32), 'hex') WHERE id = 'a9200000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT number_hash = decode(repeat('ef', 32), 'hex') FROM identity_documents WHERE id = 'a9200000-0000-0000-0000-000000000002'),
  'a lookup-key rotation replaces the hash of a verified document');
SELECT test_expect_error(
  $$UPDATE identity_documents SET number_encrypted = '\x0100000003aabb'::bytea, expires_on = '2031-01-01' WHERE id = 'a9200000-0000-0000-0000-000000000002'$$,
  '23514', 'a rotation cannot change anything else on a verified document');

INSERT INTO company_data_keys (company_id, purpose, version, wrapped_key, kms_key_ref, status, retired_at)
VALUES ('a0000000-0000-0000-0000-000000000001', 'field', 1, decode(repeat('ab', 60), 'hex'), 'local:test', 'decrypt_only', now()),
       ('a0000000-0000-0000-0000-000000000001', 'field', 2, decode(repeat('ab', 60), 'hex'), 'local:test', 'active', NULL);
SELECT test_expect_error(
  $$INSERT INTO company_data_keys (company_id, purpose, version, wrapped_key, kms_key_ref)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'field', 3, decode(repeat('ab', 60), 'hex'), 'local:test')$$,
  '23505', 'only one key per company and purpose is active');
INSERT INTO key_rotations (company_id, purpose, from_version, to_version, trigger_type, reason, requested_by)
VALUES ('a0000000-0000-0000-0000-000000000001', 'field', 1, 2, 'request', 'Yearly rotation', 'test');
SELECT test_expect_error(
  $$INSERT INTO key_rotations (company_id, purpose, from_version, to_version, trigger_type, reason, requested_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'field', 1, 2, 'compromise', 'Second at once', 'test')$$,
  '23505', 'one rotation at a time per company and key');
SELECT test_expect_error(
  $$INSERT INTO key_rotations (company_id, purpose, from_version, to_version, trigger_type, reason, requested_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'lookup', 1, 3, 'request', 'Skips a version', 'test')$$,
  '23514', 'a rotation moves to the next version');

ROLLBACK;
