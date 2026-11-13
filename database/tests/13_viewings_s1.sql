-- =============================================================================
-- S1: viewings (migration 0031, with the history rules of 0030). Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);
-- Check the commit-time rules at the end of each statement, so each one can be tested here.
SET CONSTRAINTS ALL IMMEDIATE;

-- ------------------------------------------------- booking
WITH v AS (
  INSERT INTO viewings (id, company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone)
  VALUES ('a9f10000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
          'a8000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000002',
          now() + interval '1 day', now() + interval '1 day 30 minutes', 'Africa/Accra')
  RETURNING id, company_id)
INSERT INTO viewing_attendees (company_id, viewing_id, contact_id)
SELECT company_id, id, 'a5000000-0000-0000-0000-000000000003' FROM v;
SELECT test_assert((SELECT status = 'scheduled' FROM viewings WHERE id = 'a9f10000-0000-0000-0000-000000000001'),
  'a viewing is booked on a live listing with its attendee');

SELECT test_expect_error(
  $$INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002',
            'a4000000-0000-0000-0000-000000000001', now() + interval '2 days', now() + interval '2 days 30 minutes', 'Africa/Accra')$$,
  '23514', 'a viewing needs an attendee, except an open house');
WITH v AS (
  INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, viewing_type, scheduled_start, scheduled_end, timezone)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002',
          'a4000000-0000-0000-0000-000000000001', 'open_house', now() + interval '3 days', now() + interval '3 days 2 hours', 'Africa/Accra')
  RETURNING id)
SELECT test_assert((SELECT count(*) = 1 FROM v), 'an open house is booked without named attendees');

SELECT test_expect_error(
  $$INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, viewing_type, scheduled_start, scheduled_end, timezone)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000001',
            'a4000000-0000-0000-0000-000000000001', 'open_house', now() + interval '4 days', now() + interval '4 days 1 hour', 'Africa/Accra')$$,
  '23514', 'a viewing is of its listing''s unit');

SELECT test_expect_error(
  $$INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, viewing_type, scheduled_start, scheduled_end, timezone)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002',
            'a4000000-0000-0000-0000-000000000002', 'open_house', now() + interval '1 day 10 minutes', now() + interval '1 day 50 minutes', 'Africa/Accra')$$,
  '23P01', 'an agent cannot hold two overlapping live viewings');

UPDATE units SET availability = 'under_maintenance' WHERE id = 'a8000000-0000-0000-0000-000000000002';
SELECT test_expect_error(
  $$INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, viewing_type, scheduled_start, scheduled_end, timezone)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002',
            'a4000000-0000-0000-0000-000000000001', 'open_house', now() + interval '5 days', now() + interval '5 days 1 hour', 'Africa/Accra')$$,
  '23514', 'no viewings while the unit is under maintenance');
UPDATE units SET availability = 'available' WHERE id = 'a8000000-0000-0000-0000-000000000002';

RESET ROLE;
UPDATE listings SET status = 'withdrawn' WHERE id = 'a9000000-0000-0000-0000-000000000002';
SET LOCAL ROLE estatepro_app;
SELECT test_expect_error(
  $$INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, viewing_type, scheduled_start, scheduled_end, timezone)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002',
            'a4000000-0000-0000-0000-000000000001', 'open_house', now() + interval '6 days', now() + interval '6 days 1 hour', 'Africa/Accra')$$,
  '23514', 'viewings are booked on live listings only');
RESET ROLE;
UPDATE listings SET status = 'available' WHERE id = 'a9000000-0000-0000-0000-000000000002';
SET LOCAL ROLE estatepro_app;

-- A deal's viewings: open deals of the same listing.
INSERT INTO deals (id, company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code, listing_id, unit_id)
VALUES ('a9b10000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'DEA-V-1', 'sale',
        (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'qualification'),
        'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002',
        'GHS', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002');
SELECT test_expect_error(
  $$INSERT INTO viewings (company_id, listing_id, unit_id, deal_id, agent_membership_id, viewing_type, scheduled_start, scheduled_end, timezone)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001',
            'a9b10000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'open_house',
            now() + interval '7 days', now() + interval '7 days 1 hour', 'Africa/Accra')$$,
  '23514', 'a deal''s viewings are of its listing');

-- ------------------------------------------------- recording
SELECT test_expect_error(
  $$UPDATE viewings SET status = 'completed', outcome = 'interested' WHERE id = 'a9f10000-0000-0000-0000-000000000001'$$,
  '23514', 'an outcome is recorded once the viewing has started');
SELECT test_expect_error(
  $$UPDATE viewings SET status = 'no_show' WHERE id = 'a9f10000-0000-0000-0000-000000000001'$$,
  '23514', 'a no-show is recorded once the viewing has started');

-- A viewing that has taken place (booked in the past by the migration owner, as the API never books in the past).
RESET ROLE;
WITH v AS (
  INSERT INTO viewings (id, company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone)
  VALUES ('a9f10000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
          'a8000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000002',
          now() - interval '2 hours', now() - interval '90 minutes', 'Africa/Accra')
  RETURNING id, company_id)
INSERT INTO viewing_attendees (company_id, viewing_id, contact_id)
SELECT company_id, id, 'a5000000-0000-0000-0000-000000000003' FROM v;
SET LOCAL ROLE estatepro_app;
UPDATE viewing_attendees SET attendance = 'attended' WHERE viewing_id = 'a9f10000-0000-0000-0000-000000000002';
UPDATE viewings SET status = 'completed', outcome = 'second_viewing', feedback = 'Wants to see it in daylight'
 WHERE id = 'a9f10000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT status = 'completed' FROM viewings WHERE id = 'a9f10000-0000-0000-0000-000000000002'),
  'a viewing that has started is completed with its outcome');
SELECT test_expect_error(
  $$UPDATE viewing_attendees SET attendance = 'absent' WHERE viewing_id = 'a9f10000-0000-0000-0000-000000000002'$$,
  '23514', 'attendance of a finished viewing is fixed');
SELECT test_expect_error(
  $$INSERT INTO viewing_attendees (company_id, viewing_id, contact_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9f10000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000002')$$,
  '23514', 'no attendee is added to a finished viewing');
SELECT test_expect_error(
  $$DELETE FROM viewing_attendees WHERE viewing_id = 'a9f10000-0000-0000-0000-000000000002'$$,
  '23514', 'no attendee is removed from a finished viewing');
SELECT test_expect_error(
  $$DELETE FROM viewing_attendees WHERE viewing_id = 'a9f10000-0000-0000-0000-000000000001'$$,
  '23514', 'a live viewing keeps at least one attendee');

-- ------------------------------------------------- rescheduling (old and new written together)
WITH new_id AS (SELECT 'a9f10000-0000-0000-0000-000000000003'::uuid AS id),
old AS (
  UPDATE viewings SET status = 'rescheduled', rescheduled_to_id = (SELECT id FROM new_id)
   WHERE id = 'a9f10000-0000-0000-0000-000000000001' RETURNING company_id, listing_id, unit_id, agent_membership_id),
v AS (
  INSERT INTO viewings (id, company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone)
  SELECT (SELECT id FROM new_id), company_id, listing_id, unit_id, agent_membership_id,
         now() + interval '1 day 15 minutes', now() + interval '1 day 45 minutes', 'Africa/Accra' FROM old
  RETURNING id, company_id)
INSERT INTO viewing_attendees (company_id, viewing_id, contact_id)
SELECT company_id, id, 'a5000000-0000-0000-0000-000000000003' FROM v;
SELECT test_assert(
  (SELECT status = 'rescheduled' AND rescheduled_to_id = 'a9f10000-0000-0000-0000-000000000003' FROM viewings WHERE id = 'a9f10000-0000-0000-0000-000000000001')
  AND (SELECT status = 'scheduled' FROM viewings WHERE id = 'a9f10000-0000-0000-0000-000000000003'),
  'rescheduling links the old viewing to its replacement, at an overlapping time for the same agent');
SELECT test_expect_error(
  $$UPDATE viewings SET status = 'rescheduled', rescheduled_to_id = 'a9f1ffff-0000-0000-0000-000000000009'
     WHERE id = 'a9f10000-0000-0000-0000-000000000003'$$,
  '23503', 'a rescheduled viewing points at a viewing that exists');

-- ------------------------------------------------- keys for a viewing
INSERT INTO key_sets (id, company_id, property_id, unit_id, label, created_by)
VALUES ('ac100000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001',
        'a8000000-0000-0000-0000-000000000002', 'K-V1', 'a4000000-0000-0000-0000-000000000002');
INSERT INTO key_movements (company_id, key_set_id, movement, holder_membership_id, recorded_by, viewing_id)
VALUES ('a0000000-0000-0000-0000-000000000001', 'ac100000-0000-0000-0000-000000000001', 'check_out',
        'a4000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000002', 'a9f10000-0000-0000-0000-000000000003');
SELECT test_assert((SELECT viewing_id = 'a9f10000-0000-0000-0000-000000000003' FROM key_movements WHERE key_set_id = 'ac100000-0000-0000-0000-000000000001'),
  'a key check-out records the viewing it is for');
SELECT test_expect_error(
  $$INSERT INTO key_movements (company_id, key_set_id, movement, recorded_by, viewing_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac100000-0000-0000-0000-000000000001', 'check_in',
            'a4000000-0000-0000-0000-000000000002', 'a9f10000-0000-0000-0000-000000000003')$$,
  '23514', 'only a check-out names a viewing');

-- ------------------------------------------------- tenant isolation
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) = 0 FROM viewings) AND (SELECT count(*) = 0 FROM viewing_attendees),
  'another company sees no viewings or attendees');
SELECT test_expect_error(
  $$INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, viewing_type, scheduled_start, scheduled_end, timezone)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002',
            'a4000000-0000-0000-0000-000000000001', 'open_house', now() + interval '8 days', now() + interval '8 days 1 hour', 'Africa/Accra')$$,
  '42501', 'another company cannot book on this company''s listing');

ROLLBACK;
