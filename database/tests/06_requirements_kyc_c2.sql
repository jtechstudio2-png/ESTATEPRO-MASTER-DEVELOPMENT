-- =============================================================================
-- Requirements, identity documents and KYC (migration 0023, milestone C2).
-- Runs as estatepro_app in company A; rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- ------------------------------------------------------------ area matching
UPDATE addresses SET latitude = 5.5560, longitude = -0.1750, geocode_source = 'manual_pin', geocoded_at = now() WHERE id = 'a2000000-0000-0000-0000-000000000001';
SELECT test_assert(app.requirement_area_covers('[]', 'Accra', NULL, NULL), 'no areas means anywhere');
SELECT test_assert(app.requirement_area_covers('[{"kind":"locality","locality":"ACCRA"}]', 'Accra', NULL, NULL), 'locality matches ignoring case');
SELECT test_assert(NOT app.requirement_area_covers('[{"kind":"locality","locality":"Tema"}]', 'Accra', NULL, NULL), 'another locality does not match');
SELECT test_assert(NOT app.requirement_area_covers('[{"kind":"locality","locality":"Accra","adminArea1":"Ashanti"}]', 'Accra', 'Greater Accra', NULL),
  'a locality in another region does not match');
SELECT test_assert(
  (SELECT app.requirement_area_covers('[{"kind":"radius","latitude":5.5600,"longitude":-0.1750,"radiusMetres":600}]', locality, admin_area_1, location)
     FROM addresses WHERE id = 'a2000000-0000-0000-0000-000000000001'),
  'a point 445 m from the centre is inside a 600 m radius');
SELECT test_assert(
  (SELECT NOT app.requirement_area_covers('[{"kind":"radius","latitude":5.5600,"longitude":-0.1750,"radiusMetres":400}]', locality, admin_area_1, location)
     FROM addresses WHERE id = 'a2000000-0000-0000-0000-000000000001'),
  'the same point is outside a 400 m radius');
SELECT test_assert(
  (SELECT app.requirement_area_covers('[{"kind":"polygon","points":[[-0.18,5.55],[-0.17,5.55],[-0.17,5.56],[-0.18,5.56],[-0.18,5.55]]}]', locality, admin_area_1, location)
     FROM addresses WHERE id = 'a2000000-0000-0000-0000-000000000001'),
  'a point inside a drawn area matches');
SELECT test_assert(
  (SELECT app.requirement_area_covers('[{"kind":"locality","locality":"Tema"},{"kind":"polygon","points":[[-0.18,5.55],[-0.17,5.55],[-0.17,5.56],[-0.18,5.56],[-0.18,5.55]]}]', locality, admin_area_1, location)
     FROM addresses WHERE id = 'a2000000-0000-0000-0000-000000000001'),
  'any one of several areas is enough');
SELECT test_assert(NOT app.requirement_area_covers('[{"kind":"radius","latitude":5.56,"longitude":-0.175,"radiusMetres":600}]', 'Accra', NULL, NULL),
  'a listing without a map point never matches a map area');

-- ------------------------------------------------------- rent per period
SELECT test_assert(app.rent_per_period(72000, 'annual', 'monthly') = 6000, 'annual rent compares as monthly');
SELECT test_assert(app.rent_per_period(6000, 'monthly', 'annual') = 72000, 'monthly rent compares as annual');
SELECT test_assert(app.rent_per_period(1200, 'weekly', 'weekly') = 1200, 'same period is unchanged');

-- ------------------------------------------------------------ requirements
SELECT test_expect_error(
  $$INSERT INTO requirements (company_id, contact_id, requirement_type, currency_code, max_price)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000002', 'rent', 'GHS', 5000)$$,
  '23514', 'a rent budget needs a rent period');
SELECT test_expect_error(
  $$INSERT INTO requirements (company_id, contact_id, requirement_type, currency_code, min_bedrooms, max_bedrooms)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'buy', 'GHS', 3, 2)$$,
  '23514', 'maximum bedrooms cannot be below the minimum');
SELECT test_expect_error(
  $$INSERT INTO requirements (company_id, contact_id, requirement_type, currency_code, locations)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'buy', 'GHS', '{"kind":"locality"}')$$,
  '23514', 'areas are a list');
INSERT INTO requirements (id, company_id, contact_id, requirement_type, currency_code, max_price)
VALUES ('a5100000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'buy', 'GHS', 500000);

-- ------------------------------------------------------------- exclusions
INSERT INTO requirement_exclusions (company_id, requirement_id, listing_id, reason, excluded_by)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
        'Too far from school', 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$INSERT INTO requirement_exclusions (company_id, requirement_id, listing_id, reason)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'Again')$$,
  '23505', 'a listing is excluded once per requirement');
SELECT test_expect_error(
  $$UPDATE requirement_exclusions SET reason = 'Changed' WHERE requirement_id = 'a5100000-0000-0000-0000-000000000001'$$,
  '42501', 'exclusions are never edited');
SELECT test_expect_error(
  $$INSERT INTO requirement_exclusions (company_id, requirement_id, listing_id, reason)
    VALUES ('b0000000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'Other company')$$,
  '42501', 'row-level security refuses another company''s exclusion');

-- ------------------------------------------------------ identity documents
INSERT INTO identity_documents (id, company_id, contact_id, document_type_code, issuing_country_code, number_encrypted, number_hash, number_last4, issued_on, expires_on)
VALUES ('a5200000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003',
        'passport', 'GH', '\x01'::bytea, decode(repeat('ab', 32), 'hex'), '4821', '2020-01-01', '2030-01-01');
SELECT test_expect_error(
  $$INSERT INTO identity_documents (company_id, contact_id, document_type_code, issuing_country_code, number_encrypted, number_hash, number_last4, issued_on, expires_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'passport', 'GH', '\x01', decode(repeat('ab', 32), 'hex'), '1', '2030-01-01', '2020-01-01')$$,
  '23514', 'a document cannot expire before it was issued');
SELECT test_expect_error(
  $$UPDATE identity_documents SET archived_at = now() WHERE id = 'a5200000-0000-0000-0000-000000000001'$$,
  '23514', 'archiving a document needs a reason');
UPDATE identity_documents SET expires_on = '2031-01-01' WHERE id = 'a5200000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT version = 2 FROM identity_documents WHERE id = 'a5200000-0000-0000-0000-000000000001'), 'document edits bump the version');
UPDATE identity_documents SET verified_at = now(), verified_by = 'a4000000-0000-0000-0000-000000000001' WHERE id = 'a5200000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$UPDATE identity_documents SET expires_on = '2032-01-01' WHERE id = 'a5200000-0000-0000-0000-000000000001'$$,
  '23514', 'a verified document cannot be changed');
SELECT test_expect_error(
  $$UPDATE identity_documents SET number_hash = decode(repeat('cd', 32), 'hex') WHERE id = 'a5200000-0000-0000-0000-000000000001'$$,
  '23514', 'a verified document number cannot be replaced');
UPDATE identity_documents SET archived_at = now(), archived_reason = 'Replaced by a new passport', archived_by = 'a4000000-0000-0000-0000-000000000001'
 WHERE id = 'a5200000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT archived_at IS NOT NULL FROM identity_documents WHERE id = 'a5200000-0000-0000-0000-000000000001'), 'a verified document can still be archived');
SELECT test_expect_error(
  $$DELETE FROM identity_documents WHERE id = 'a5200000-0000-0000-0000-000000000001'$$,
  '42501', 'identity documents are never deleted by the application');

-- --------------------------------------------------------------- KYC checks
INSERT INTO kyc_checks (id, company_id, contact_id, check_type, recorded_by, identity_document_id)
VALUES ('a5300000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003',
        'identity', 'a4000000-0000-0000-0000-000000000002', 'a5200000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$UPDATE kyc_checks SET status = 'verified', reviewed_by = 'a4000000-0000-0000-0000-000000000001', reviewed_at = now()
     WHERE id = 'a5300000-0000-0000-0000-000000000001'$$,
  '23514', 'a verified check needs a risk rating');
SELECT test_expect_error(
  $$UPDATE kyc_checks SET status = 'failed', reviewed_by = 'a4000000-0000-0000-0000-000000000001', reviewed_at = now()
     WHERE id = 'a5300000-0000-0000-0000-000000000001'$$,
  '23514', 'a failed check needs the reviewer''s reason');
UPDATE kyc_checks SET status = 'verified', risk_rating = 'low', reviewed_by = 'a4000000-0000-0000-0000-000000000001', reviewed_at = now()
 WHERE id = 'a5300000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$UPDATE kyc_checks SET risk_rating = 'high' WHERE id = 'a5300000-0000-0000-0000-000000000001'$$,
  '23514', 'a signed-off check cannot be changed');
SELECT test_expect_error(
  $$UPDATE kyc_checks SET status = 'pending' WHERE id = 'a5300000-0000-0000-0000-000000000001'$$,
  '23514', 'a signed-off check cannot be reopened');
SELECT test_expect_error(
  $$DELETE FROM kyc_checks WHERE id = 'a5300000-0000-0000-0000-000000000001'$$,
  '42501', 'KYC checks are never deleted by the application');
-- A merge may still move signed-off checks and verified documents.
UPDATE kyc_checks SET contact_id = 'a5000000-0000-0000-0000-000000000002' WHERE id = 'a5300000-0000-0000-0000-000000000001';
UPDATE identity_documents SET contact_id = 'a5000000-0000-0000-0000-000000000002' WHERE id = 'a5200000-0000-0000-0000-000000000001';
SELECT test_assert(
  (SELECT count(*) = 2 FROM (SELECT contact_id FROM kyc_checks WHERE id = 'a5300000-0000-0000-0000-000000000001'
                             UNION ALL SELECT contact_id FROM identity_documents WHERE id = 'a5200000-0000-0000-0000-000000000001') s
    WHERE contact_id = 'a5000000-0000-0000-0000-000000000002'),
  'a contact merge can move signed-off checks and verified documents');

ROLLBACK;
