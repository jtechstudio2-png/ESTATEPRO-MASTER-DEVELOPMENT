-- =============================================================================
-- Landlord visibility resolver and exports (migration 0025, milestone C4).
-- Runs as estatepro_app in company A; rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- Fixtures: a5..01 owns Osu Court (whole property, units 1A and 2B, listings on both).
-- a5..02 owns only flat 2B. a5..03 owned 1A until yesterday (Accra time).
-- a5..c4 manages 1A through an active management agreement.
INSERT INTO contacts (id, company_id, contact_type, display_name) VALUES
  ('a5000000-0000-0000-0000-0000000000c4', 'a0000000-0000-0000-0000-000000000001', 'person', 'Managed landlord'),
  ('a5000000-0000-0000-0000-0000000000c5', 'a0000000-0000-0000-0000-000000000001', 'person', 'Owner from tomorrow'),
  ('a5000000-0000-0000-0000-0000000000c6', 'a0000000-0000-0000-0000-000000000001', 'person', 'Owner until today');
INSERT INTO property_ownerships (company_id, property_id, unit_id, owner_contact_id, effective_from, effective_to) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002',
   'a5000000-0000-0000-0000-000000000002', '2021-01-01', NULL),
  ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001',
   'a5000000-0000-0000-0000-000000000003', '2019-01-01', (now() AT TIME ZONE 'Africa/Accra')::date - 1),
  ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001',
   'a5000000-0000-0000-0000-0000000000c5', (now() AT TIME ZONE 'Africa/Accra')::date + 1, NULL),
  ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002',
   'a5000000-0000-0000-0000-0000000000c6', '2019-01-01', (now() AT TIME ZONE 'Africa/Accra')::date);
INSERT INTO management_agreements (company_id, reference, landlord_contact_id, property_id, unit_id, service_level, status, currency_code,
                                   fee_basis, fee_percent, start_date)
VALUES ('a0000000-0000-0000-0000-000000000001', 'MGT-T-1', 'a5000000-0000-0000-0000-0000000000c4', 'a7000000-0000-0000-0000-000000000001',
        'a8000000-0000-0000-0000-000000000001', 'rent_collection', 'active', 'GHS', 'percent_of_rent_collected', 8, '2025-01-01'),
       ('a0000000-0000-0000-0000-000000000001', 'MGT-T-2', 'a5000000-0000-0000-0000-0000000000c4', 'a7000000-0000-0000-0000-000000000001',
        'a8000000-0000-0000-0000-000000000002', 'rent_collection', 'ended', 'GHS', 'percent_of_rent_collected', 8, '2020-01-01');

SELECT test_assert(
  (SELECT array_agg(unit_id ORDER BY unit_id) FROM app.landlord_unit_access('a5000000-0000-0000-0000-000000000001'))
    = ARRAY['a8000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002']::uuid[],
  'a whole-property owner sees every unit of the property');
SELECT test_assert(
  (SELECT array_agg(unit_id) FROM app.landlord_unit_access('a5000000-0000-0000-0000-000000000002'))
    = ARRAY['a8000000-0000-0000-0000-000000000002']::uuid[],
  'a unit owner sees only their unit');
SELECT test_assert(
  (SELECT array_agg(i ORDER BY i) FROM app.landlord_listing_ids('a5000000-0000-0000-0000-000000000002') i)
    = ARRAY['a9000000-0000-0000-0000-000000000002']::uuid[],
  'two landlords in one company see only their own listings');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.landlord_unit_access('a5000000-0000-0000-0000-000000000003')),
  'access ends the day after an ownership''s last day, in the property''s time zone');
SELECT test_assert(EXISTS (SELECT 1 FROM app.landlord_unit_access('a5000000-0000-0000-0000-0000000000c6')),
  'an ownership is current on its last day');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.landlord_unit_access('a5000000-0000-0000-0000-0000000000c5')),
  'a future ownership grants nothing yet');
SELECT test_assert(
  (SELECT array_agg(basis || ':' || unit_id) FROM app.landlord_unit_access('a5000000-0000-0000-0000-0000000000c4'))
    = ARRAY['management_agreement:a8000000-0000-0000-0000-000000000001'],
  'only active management agreements grant access');
SELECT test_assert(
  (SELECT array_agg(p) FROM app.landlord_property_ids('a5000000-0000-0000-0000-000000000002') p)
    = ARRAY['a7000000-0000-0000-0000-000000000001']::uuid[],
  'property ids follow from the units');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.landlord_unit_access('b5000000-0000-0000-0000-000000000001')),
  'another company''s contact resolves to nothing');

-- --------------------------------------------------- matching prefilter columns
INSERT INTO requirements (id, company_id, contact_id, requirement_type, currency_code, locations)
VALUES ('a5100000-0000-0000-0000-0000000000c4', 'a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'buy', 'GHS',
        '[{"kind":"locality","locality":"East LEGON"},{"kind":"radius","latitude":5.6,"longitude":-0.18,"radiusMetres":1000}]');
SELECT test_assert((SELECT area_localities = ARRAY['east legon'] AND NOT area_anywhere FROM requirements WHERE id = 'a5100000-0000-0000-0000-0000000000c4'),
  'localities are kept in lower case for matching');
SELECT test_assert(
  (SELECT ST_Covers(area_bbox, ST_SetSRID(ST_MakePoint(-0.18, 5.6 + 0.0089), 4326))
      AND ST_Covers(area_bbox, ST_SetSRID(ST_MakePoint(-0.18 + 0.009, 5.6), 4326))
      AND NOT ST_Covers(area_bbox, ST_SetSRID(ST_MakePoint(-0.18, 5.62), 4326))
     FROM requirements WHERE id = 'a5100000-0000-0000-0000-0000000000c4'),
  'the radius box contains the whole circle and little more');
UPDATE requirements SET locations = '[]' WHERE id = 'a5100000-0000-0000-0000-0000000000c4';
SELECT test_assert((SELECT area_anywhere AND area_bbox IS NULL AND area_localities = '{}' FROM requirements WHERE id = 'a5100000-0000-0000-0000-0000000000c4'),
  'no areas means anywhere');

-- ------------------------------------------------------------------- exports
INSERT INTO export_jobs (id, company_id, export_type, format, requested_by)
VALUES ('a6400000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'contacts', 'csv', 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$UPDATE export_jobs SET status = 'completed' WHERE id = 'a6400000-0000-0000-0000-000000000001'$$,
  '23514', 'a completed export records its file, rows and expiry');
SELECT test_expect_error(
  $$UPDATE export_jobs SET status = 'failed' WHERE id = 'a6400000-0000-0000-0000-000000000001'$$,
  '23514', 'a failed export records why');
UPDATE export_jobs SET status = 'completed', storage_key = 'exports/x.csv', row_count = 3, expires_at = now() + interval '1 day', finished_at = now()
 WHERE id = 'a6400000-0000-0000-0000-000000000001';
UPDATE export_jobs SET download_count = download_count + 1 WHERE id = 'a6400000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$UPDATE export_jobs SET row_count = 2 WHERE id = 'a6400000-0000-0000-0000-000000000001'$$,
  '23514', 'a finished export cannot be rewritten');
UPDATE export_jobs SET status = 'expired' WHERE id = 'a6400000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$UPDATE export_jobs SET status = 'completed' WHERE id = 'a6400000-0000-0000-0000-000000000001'$$,
  '23514', 'an expired export cannot come back');
SELECT test_expect_error(
  $$DELETE FROM export_jobs WHERE id = 'a6400000-0000-0000-0000-000000000001'$$,
  '42501', 'the record of an export is never deleted by the application');

ROLLBACK;
