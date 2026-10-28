-- =============================================================================
-- Location, property notes and key register (migration 0019, ADR-006).
-- Runs as estatepro_app in company A; rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- ----------------------------------------------------------------- location
UPDATE addresses SET latitude = 5.556000, longitude = -0.196900, geocode_source = 'manual_pin', geocoded_at = now()
 WHERE id = 'a2000000-0000-0000-0000-000000000001';
SELECT test_assert(
  (SELECT round(ST_Y(location::geometry)::numeric, 4) = 5.5560 AND round(ST_X(location::geometry)::numeric, 4) = -0.1969
     FROM addresses WHERE id = 'a2000000-0000-0000-0000-000000000001'),
  'the spatial point is calculated from latitude and longitude');
SELECT test_assert(
  (SELECT ST_DWithin(location, ST_SetSRID(ST_MakePoint(-0.1969, 5.5650), 4326)::geography, 1100)
      AND NOT ST_DWithin(location, ST_SetSRID(ST_MakePoint(-0.1969, 5.5650), 4326)::geography, 900)
     FROM addresses WHERE id = 'a2000000-0000-0000-0000-000000000001'),
  'radius checks use metres on the spheroid (0.009° of latitude ≈ 995 m)');
SELECT test_expect_error(
  $$UPDATE addresses SET location = NULL WHERE id = 'a2000000-0000-0000-0000-000000000001'$$,
  '428C9', 'the spatial point cannot be written directly');
SELECT test_expect_error(
  $$UPDATE addresses SET latitude = 0, longitude = 0 WHERE id = 'a2000000-0000-0000-0000-000000000001'$$,
  '23514', 'coordinates at 0,0 are rejected');
SELECT test_expect_error(
  $$UPDATE addresses SET geocode_source = NULL WHERE id = 'a2000000-0000-0000-0000-000000000001'$$,
  '23514', 'a stored point records how it was found');
SELECT test_expect_error(
  $$UPDATE addresses SET geocode_source = 'guess' WHERE id = 'a2000000-0000-0000-0000-000000000001'$$,
  '23514', 'geocode source is a controlled value');
SELECT test_assert(
  (SELECT bounds_south < 5.556 AND bounds_north > 5.556 AND bounds_west < -0.1969 AND bounds_east > -0.1969 FROM countries WHERE code = 'GH'),
  'Ghana bounds contain Accra');

-- ------------------------------------------------------------------- notes
INSERT INTO properties (id, company_id, reference, name, property_type_id, office_id, address_id, jurisdiction_code, timezone)
VALUES ('a7000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-000000000001', 'PRP-T-NOTES', 'Second',
        (SELECT id FROM property_types WHERE code = 'apartment_building' AND company_id IS NULL),
        'a3000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'GH', 'Africa/Accra');

SELECT test_expect_error(
  $$INSERT INTO property_notes (company_id, property_id, unit_id, body, created_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-0000000000f1',
            'a8000000-0000-0000-0000-000000000001', 'Wrong property', 'a4000000-0000-0000-0000-000000000001')$$,
  '23503', 'a note''s unit must belong to the note''s property');
SELECT test_expect_error(
  $$INSERT INTO property_notes (company_id, property_id, body, visibility, created_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'All tenants?', 'tenant',
            'a4000000-0000-0000-0000-000000000001')$$,
  '23514', 'a tenant-visible note must reference a unit');
SELECT test_expect_error(
  $$INSERT INTO property_notes (company_id, property_id, body, created_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', '', 'a4000000-0000-0000-0000-000000000001')$$,
  '23514', 'empty notes are rejected');
SELECT test_expect_error(
  $$INSERT INTO property_notes (company_id, property_id, body)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'Who wrote this?')$$,
  '23514', 'only migrated notes may have no author');

INSERT INTO property_notes (id, company_id, property_id, unit_id, body, visibility, created_by)
VALUES ('a7a00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001',
        'a8000000-0000-0000-0000-000000000001', 'Tenant: bins go out on Tuesday', 'tenant', 'a4000000-0000-0000-0000-000000000001');
INSERT INTO property_note_revisions (company_id, note_id, revision, body, written_by, written_at, superseded_by)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a7a00000-0000-0000-0000-000000000001', 1, 'Call Ama Mensah on 024 000 0000',
        'a4000000-0000-0000-0000-000000000001', now(), 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$UPDATE property_note_revisions SET body = 'rewritten' WHERE note_id = 'a7a00000-0000-0000-0000-000000000001'$$,
  '42501', 'revisions cannot be changed by the application');
SELECT test_expect_error(
  $$DELETE FROM property_note_revisions WHERE note_id = 'a7a00000-0000-0000-0000-000000000001'$$,
  '42501', 'revisions cannot be deleted by the application');

SELECT app.redact_property_note('a7a00000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001');
SELECT test_assert(
  (SELECT body = '[Redacted]' AND redacted_at IS NOT NULL FROM property_notes WHERE id = 'a7a00000-0000-0000-0000-000000000001')
  AND NOT EXISTS (SELECT 1 FROM property_note_revisions WHERE note_id = 'a7a00000-0000-0000-0000-000000000001' AND body <> '[Redacted]'),
  'redaction replaces the note and every revision');

-- Company B cannot redact company A's note through the function.
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_expect_error(
  $$SELECT app.redact_property_note('a7a00000-0000-0000-0000-000000000001', NULL)$$,
  'P0002', 'redaction is limited to the caller''s company');
SELECT test_assert((SELECT count(*) FROM property_note_revisions) = 0, 'revisions are isolated by company');
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);

-- ------------------------------------------------------------- key register
INSERT INTO key_sets (id, company_id, property_id, unit_id, label, created_by)
VALUES ('a7b00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001',
        'a8000000-0000-0000-0000-000000000001', 'K-001', 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$INSERT INTO key_sets (company_id, property_id, unit_id, label)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-0000000000f1', 'a8000000-0000-0000-0000-000000000001', 'K-002')$$,
  '23503', 'a key set''s unit must belong to its property');
SELECT test_expect_error(
  $$UPDATE key_sets SET status = 'checked_out', checked_out_at = now() WHERE id = 'a7b00000-0000-0000-0000-000000000001'$$,
  '23514', 'a checked-out key set has a holder');
SELECT test_expect_error(
  $$UPDATE key_sets SET status = 'checked_out', checked_out_at = now(),
           holder_membership_id = 'a4000000-0000-0000-0000-000000000002', holder_contact_id = 'a5000000-0000-0000-0000-000000000001'
     WHERE id = 'a7b00000-0000-0000-0000-000000000001'$$,
  '23514', 'a key set has one holder, not two');
UPDATE key_sets SET status = 'checked_out', checked_out_at = now(), holder_membership_id = 'a4000000-0000-0000-0000-000000000002'
 WHERE id = 'a7b00000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT version FROM key_sets WHERE id = 'a7b00000-0000-0000-0000-000000000001') = 2, 'key set edits bump the version');
SELECT test_expect_error(
  $$INSERT INTO key_sets (company_id, property_id, label) VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'K-001')$$,
  '23505', 'tag numbers are unique among active key sets');

INSERT INTO key_movements (id, company_id, key_set_id, movement, holder_membership_id, recorded_by)
VALUES ('a7c00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a7b00000-0000-0000-0000-000000000001',
        'check_out', 'a4000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$UPDATE key_movements SET note = 'changed' WHERE id = 'a7c00000-0000-0000-0000-000000000001'$$,
  '42501', 'key movements are append-only');

UPDATE key_sets SET status = 'retired', retired_at = now(), checked_out_at = NULL, holder_membership_id = NULL
 WHERE id = 'a7b00000-0000-0000-0000-000000000001';
INSERT INTO key_sets (company_id, property_id, label) VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'K-001');
SELECT test_assert(true, 'a retired tag number can be reused');

-- -------------------------------------------------------------- permissions
SELECT test_assert(
  (SELECT count(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
    WHERE r.key = 'agent' AND rp.permission_key = 'property_note.manage') = 0,
  'agents cannot share notes externally');

ROLLBACK;
\echo '03_location_notes_keys: all assertions passed'
