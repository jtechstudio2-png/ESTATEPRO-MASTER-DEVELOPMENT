-- =============================================================================
-- Ownership records and seller identity (migration 0028, P5-H). Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- The fixture owns the whole of Osu Court from 2020; add a unit owner and an ended record.
INSERT INTO property_ownerships (id, company_id, property_id, unit_id, owner_contact_id, share_percent, effective_from, created_by) VALUES
  ('a9700000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000003', 50, current_date - 10, 'a4000000-0000-0000-0000-000000000001'),
  ('a9700000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001',
   NULL, 'a5000000-0000-0000-0000-000000000002', 100, current_date - 400, 'a4000000-0000-0000-0000-000000000001');

SELECT test_assert((SELECT count(*) = 1 FROM app.unit_current_owners('a8000000-0000-0000-0000-000000000001')
                     WHERE owner_contact_id = 'a5000000-0000-0000-0000-000000000001'),
  'a whole-property owner is a current owner of each unit');
SELECT test_assert((SELECT count(*) = 3 FROM app.unit_current_owners('a8000000-0000-0000-0000-000000000002')),
  'a unit''s current owners include whole-property and unit records');

-- ----------------------------------------------------------- ending a record
SELECT test_expect_error(
  $$UPDATE property_ownerships SET ended_by = 'a4000000-0000-0000-0000-000000000001', ended_at = now() WHERE id = 'a9700000-0000-0000-0000-000000000002'$$,
  '23514', 'who ended a record is only set with the end date');
UPDATE property_ownerships SET effective_to = current_date - 1, ended_by = 'a4000000-0000-0000-0000-000000000001', ended_at = now(), end_reason = 'Sold to a new owner'
 WHERE id = 'a9700000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT count(*) = 2 FROM app.unit_current_owners('a8000000-0000-0000-0000-000000000002')),
  'an ownership that ended yesterday is no longer current');
UPDATE property_ownerships SET effective_to = current_date WHERE id = 'a9700000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT count(*) = 2 FROM app.unit_current_owners('a8000000-0000-0000-0000-000000000002')),
  'the end date is the last day of ownership (inclusive)');
SELECT test_expect_error(
  $$UPDATE property_ownerships SET effective_to = current_date + 5 WHERE id = 'a9700000-0000-0000-0000-000000000002'$$,
  '23514', 'an ended record cannot be re-dated');
SELECT test_expect_error(
  $$UPDATE property_ownerships SET end_reason = 'Changed my mind' WHERE id = 'a9700000-0000-0000-0000-000000000002'$$,
  '23514', 'the reason a record ended cannot be rewritten');

-- --------------------------------------------------------- history is kept
SELECT test_expect_error(
  $$UPDATE property_ownerships SET share_percent = 75 WHERE id = 'a9700000-0000-0000-0000-000000000001'$$,
  '23514', 'the share is not rewritten (end the record and add a new one)');
SELECT test_expect_error(
  $$UPDATE property_ownerships SET effective_from = current_date - 20 WHERE id = 'a9700000-0000-0000-0000-000000000001'$$,
  '23514', 'the start date is not rewritten');
SELECT test_expect_error(
  $$UPDATE property_ownerships SET unit_id = NULL WHERE id = 'a9700000-0000-0000-0000-000000000001'$$,
  '23514', 'what is owned is not rewritten');
SELECT test_expect_error(
  $$DELETE FROM property_ownerships WHERE id = 'a9700000-0000-0000-0000-000000000001'$$,
  '42501', 'the application cannot delete ownership records');
-- A contact merge repoints the owner (migration 0022).
UPDATE property_ownerships SET owner_contact_id = 'a5000000-0000-0000-0000-000000000001' WHERE id = 'a9700000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT owner_contact_id = 'a5000000-0000-0000-0000-000000000001' FROM property_ownerships WHERE id = 'a9700000-0000-0000-0000-000000000001'),
  'a merge can move a record to the kept contact');

-- ------------------------------------------------------------- isolation
SELECT test_expect_error(
  $$INSERT INTO property_ownerships (company_id, property_id, owner_contact_id, effective_from)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'b5000000-0000-0000-0000-000000000001', current_date)$$,
  '23503', 'an owner is a contact of the same company');
SELECT test_expect_error(
  $$INSERT INTO property_ownerships (company_id, property_id, owner_contact_id, effective_from, created_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', current_date, 'b4000000-0000-0000-0000-000000000001')$$,
  '23503', 'the recorder is a member of the same company');
SELECT test_assert((SELECT count(*) = 0 FROM app.unit_current_owners('b8000000-0000-0000-0000-000000000001')),
  'another company''s owners are not visible');

-- ------------------------------------------------------------- the rule
SELECT test_assert((SELECT default_value = 'false'::jsonb AND data_type = 'boolean' FROM jurisdiction_setting_definitions WHERE key = 'listing_owner_identity_required'),
  'the per-jurisdiction owner identity rule exists and is off by default');
SELECT test_assert((SELECT count(*) = 0 FROM jurisdiction_settings WHERE key = 'listing_owner_identity_required'),
  'no jurisdiction turns it on before legal review (#20)');

ROLLBACK;
