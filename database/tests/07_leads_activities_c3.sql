-- =============================================================================
-- Leads, activities and follow-ups (migration 0024, milestone C3).
-- Runs as estatepro_app in company A; rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- --------------------------------------------------------------------- leads
INSERT INTO leads (id, company_id, reference, contact_id, lead_type, source_code, assigned_to)
VALUES ('a6100000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'LEA-T-1',
        'a5000000-0000-0000-0000-000000000003', 'buy', 'website', 'a4000000-0000-0000-0000-000000000002');
SELECT test_expect_error(
  $$UPDATE leads SET status = 'converted' WHERE id = 'a6100000-0000-0000-0000-000000000001'$$,
  '23514', 'a lead converts only with a deal (Phase 6)');
UPDATE leads SET status = 'contacted' WHERE id = 'a6100000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$UPDATE leads SET status = 'new' WHERE id = 'a6100000-0000-0000-0000-000000000001'$$,
  '23514', 'a contacted lead cannot go back to new');
SELECT test_expect_error(
  $$UPDATE leads SET status = 'lost' WHERE id = 'a6100000-0000-0000-0000-000000000001'$$,
  '23514', 'a lost lead needs a reason');
UPDATE leads SET status = 'lost', lost_reason_code = 'price' WHERE id = 'a6100000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$UPDATE leads SET status = 'qualified' WHERE id = 'a6100000-0000-0000-0000-000000000001'$$,
  '23514', 'a lost lead can only be reopened as contacted');
UPDATE leads SET status = 'contacted' WHERE id = 'a6100000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT lost_reason_code IS NULL FROM leads WHERE id = 'a6100000-0000-0000-0000-000000000001'), 'a reopened lead drops its lost reason');
SELECT test_expect_error(
  $$UPDATE leads SET archived_at = now() WHERE id = 'a6100000-0000-0000-0000-000000000001'$$,
  '23514', 'archiving a lead needs a reason');
SELECT test_expect_error(
  $$DELETE FROM leads WHERE id = 'a6100000-0000-0000-0000-000000000001'$$,
  '42501', 'leads are never deleted by the application');

INSERT INTO lead_status_history (company_id, lead_id, from_status, to_status, changed_by)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a6100000-0000-0000-0000-000000000001', 'new', 'contacted', 'a4000000-0000-0000-0000-000000000002');
SELECT test_expect_error(
  $$UPDATE lead_status_history SET note = 'rewritten' WHERE lead_id = 'a6100000-0000-0000-0000-000000000001'$$,
  '42501', 'status history cannot be rewritten');
INSERT INTO lead_assignments (company_id, lead_id, assigned_to, assigned_by)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a6100000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$DELETE FROM lead_assignments WHERE lead_id = 'a6100000-0000-0000-0000-000000000001'$$,
  '42501', 'assignment history cannot be deleted');

-- ---------------------------------------------------------------- activities
INSERT INTO activities (id, company_id, activity_type, direction, body, occurred_at, created_by, created_at)
VALUES ('a6200000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'call', 'outbound', 'First call', '2026-11-01 09:00+00',
        'a4000000-0000-0000-0000-000000000002', now()),
       ('a6200000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'note', 'internal', 'Same minute', '2026-11-01 09:00+00',
        'a4000000-0000-0000-0000-000000000002', now()),
       ('a6200000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'call', 'outbound', 'Old call', '2026-10-01 09:00+00',
        'a4000000-0000-0000-0000-000000000002', now() - interval '25 hours'),
       ('a6200000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'status_change', 'internal', 'New → Contacted', now(),
        NULL, now());
SELECT test_assert(
  (SELECT a.entry_no < b.entry_no FROM activities a, activities b
    WHERE a.id = 'a6200000-0000-0000-0000-000000000001' AND b.id = 'a6200000-0000-0000-0000-000000000002'),
  'same-time entries keep the order they were logged in');
UPDATE activities SET body = 'First call, corrected' WHERE id = 'a6200000-0000-0000-0000-000000000001';
SELECT test_assert(
  (SELECT edited_at IS NOT NULL AND version = 2 FROM activities WHERE id = 'a6200000-0000-0000-0000-000000000001'),
  'an edit inside the window is marked and versioned');
SELECT test_expect_error(
  $$UPDATE activities SET body = 'Too late' WHERE id = 'a6200000-0000-0000-0000-000000000003'$$,
  '23514', 'activities cannot be edited after 24 hours');
UPDATE activities SET archived_at = now(), archived_reason = 'Logged on the wrong contact', archived_by = 'a4000000-0000-0000-0000-000000000002'
 WHERE id = 'a6200000-0000-0000-0000-000000000003';
SELECT test_assert((SELECT archived_at IS NOT NULL FROM activities WHERE id = 'a6200000-0000-0000-0000-000000000003'), 'old activities can still be archived');
SELECT test_expect_error(
  $$UPDATE activities SET archived_reason = 'Changed reason' WHERE id = 'a6200000-0000-0000-0000-000000000003'$$,
  '23514', 'an archive cannot be rewritten');
SELECT test_expect_error(
  $$UPDATE activities SET body = 'Edited system entry' WHERE id = 'a6200000-0000-0000-0000-000000000004'$$,
  '23514', 'system entries cannot be edited');
SELECT test_expect_error(
  $$UPDATE activities SET archived_at = now(), archived_reason = 'Hide it' WHERE id = 'a6200000-0000-0000-0000-000000000004'$$,
  '23514', 'system entries cannot be archived');
SELECT test_expect_error(
  $$DELETE FROM activities WHERE id = 'a6200000-0000-0000-0000-000000000001'$$,
  '42501', 'activities are never deleted by the application');

INSERT INTO activity_revisions (company_id, activity_id, revision_no, body, occurred_at, edited_by)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a6200000-0000-0000-0000-000000000001', 1, 'First call', '2026-11-01 09:00+00', 'a4000000-0000-0000-0000-000000000002');
SELECT test_expect_error(
  $$UPDATE activity_revisions SET body = 'Rewritten' WHERE activity_id = 'a6200000-0000-0000-0000-000000000001'$$,
  '42501', 'revision history is append-only');
SELECT test_expect_error(
  $$INSERT INTO activity_revisions (company_id, activity_id, revision_no, occurred_at)
    VALUES ('b0000000-0000-0000-0000-000000000001', 'a6200000-0000-0000-0000-000000000001', 2, now())$$,
  '42501', 'row-level security refuses another company''s revision');

-- --------------------------------------------------------------------- tasks
SELECT test_expect_error(
  $$INSERT INTO tasks (company_id, title, assigned_to, due_at, remind_at)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'Call back', 'a4000000-0000-0000-0000-000000000002', now(), now() + interval '1 hour')$$,
  '23514', 'a reminder cannot come after the due time');
INSERT INTO tasks (id, company_id, title, assigned_to, due_at)
VALUES ('a6300000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Call back', 'a4000000-0000-0000-0000-000000000002', now());
SELECT test_expect_error(
  $$UPDATE tasks SET status = 'cancelled' WHERE id = 'a6300000-0000-0000-0000-000000000001'$$,
  '23514', 'a cancelled follow-up records when');
SELECT test_expect_error(
  $$DELETE FROM tasks WHERE id = 'a6300000-0000-0000-0000-000000000001'$$,
  '42501', 'follow-ups are never deleted by the application');

-- ----------------------------------------------------------------- picklists
SELECT test_assert((SELECT count(*) >= 9 FROM picklist_values WHERE list_key = 'activity_outcome' AND company_id IS NULL), 'activity outcomes are seeded');

ROLLBACK;
