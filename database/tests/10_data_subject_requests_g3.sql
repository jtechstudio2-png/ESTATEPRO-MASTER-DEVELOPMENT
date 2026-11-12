-- =============================================================================
-- Data-subject request register (migration 0027, gap G3). Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

SELECT test_assert(app.next_reference('a0000000-0000-0000-0000-000000000001', 'privacy_request') LIKE 'DSR-%',
  'existing companies have a DSR reference sequence');

INSERT INTO data_subject_requests (id, company_id, reference, contact_id, request_type, channel, received_on, due_on, created_by)
VALUES ('a9600000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'DSR-T-1', 'a5000000-0000-0000-0000-000000000003',
        'erasure', 'email', current_date - 3, current_date + 27, 'a4000000-0000-0000-0000-000000000001'),
       ('a9600000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'DSR-T-2', 'a5000000-0000-0000-0000-000000000001',
        'access', 'post', current_date, current_date + 30, 'a4000000-0000-0000-0000-000000000001');
SELECT test_assert((SELECT status = 'received' FROM data_subject_requests WHERE reference = 'DSR-T-1'), 'a new request is received');

SELECT test_expect_error(
  $$INSERT INTO data_subject_requests (company_id, reference, contact_id, request_type, channel, received_on, due_on, created_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'DSR-T-3', 'a5000000-0000-0000-0000-000000000003', 'rectification', 'email', current_date, current_date, 'a4000000-0000-0000-0000-000000000001')$$,
  '23514', 'only access and erasure requests are registered');
SELECT test_expect_error(
  $$INSERT INTO data_subject_requests (company_id, reference, contact_id, request_type, channel, received_on, due_on, created_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'DSR-T-3', 'a5000000-0000-0000-0000-000000000003', 'access', 'email', current_date, current_date - 1, 'a4000000-0000-0000-0000-000000000001')$$,
  '23514', 'a request cannot be due before it was received');
SELECT test_expect_error(
  $$INSERT INTO data_subject_requests (company_id, reference, contact_id, request_type, channel, received_on, due_on, created_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'DSR-T-3', 'b5000000-0000-0000-0000-000000000001', 'access', 'email', current_date, current_date, 'a4000000-0000-0000-0000-000000000001')$$,
  '23503', 'a request is about a contact of the same company');

-- --------------------------------------------------------------- lifecycle
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET status = 'in_progress' WHERE reference = 'DSR-T-1'$$,
  '23514', 'work does not start before the requester''s identity is verified');
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET status = 'completed' WHERE reference = 'DSR-T-1'$$,
  '23514', 'a request cannot jump from received to completed');
UPDATE data_subject_requests SET status = 'verifying' WHERE reference = 'DSR-T-1';
UPDATE data_subject_requests
   SET identity_verified_at = now(), identity_verified_by = 'a4000000-0000-0000-0000-000000000001', identity_method = 'documents_seen', status = 'in_progress'
 WHERE reference = 'DSR-T-1';
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET identity_method = 'other' WHERE reference = 'DSR-T-1'$$,
  '23514', 'a recorded identity check cannot be rewritten');
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET status = 'verifying' WHERE reference = 'DSR-T-1'$$,
  '23514', 'status only moves forward');
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET status = 'completed', closed_at = now(), closed_by = 'a4000000-0000-0000-0000-000000000001' WHERE reference = 'DSR-T-1'$$,
  '23514', 'an erasure request is completed only by carrying out the erasure');
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET request_type = 'access' WHERE reference = 'DSR-T-1'$$,
  '23514', 'the type of a request cannot change');
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET received_on = current_date - 30 WHERE reference = 'DSR-T-1'$$,
  '23514', 'the receipt date cannot change');

UPDATE data_subject_requests SET extended_due_on = current_date + 60, extension_reason = 'Complex request: many records over several years'
 WHERE reference = 'DSR-T-1';
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET extended_due_on = current_date + 90 WHERE reference = 'DSR-T-1'$$,
  '23514', 'a due date is extended once');
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET extended_due_on = current_date + 60 WHERE reference = 'DSR-T-2'$$,
  '23514', 'an extension needs a reason');

-- -------------------------------------------------- merges and closed requests
SELECT test_assert(app.contact_open_erasure_requests('a5000000-0000-0000-0000-000000000003') = ARRAY['DSR-T-1'],
  'an open erasure request is reported for the merge check');
SELECT test_assert(cardinality(app.contact_open_erasure_requests('a5000000-0000-0000-0000-000000000001')) = 0,
  'an access request does not block merging');

SELECT test_expect_error(
  $$UPDATE data_subject_requests SET status = 'withdrawn', closed_at = now(), closed_by = 'a4000000-0000-0000-0000-000000000001' WHERE reference = 'DSR-T-2'$$,
  '23514', 'a withdrawal records what the requester said');
UPDATE data_subject_requests
   SET status = 'withdrawn', outcome_note = 'Requester withdrew by phone', closed_at = now(), closed_by = 'a4000000-0000-0000-0000-000000000001'
 WHERE reference = 'DSR-T-2';
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET outcome_note = 'Changed later' WHERE reference = 'DSR-T-2'$$,
  '23514', 'a closed request is final');
SELECT test_expect_error(
  $$UPDATE data_subject_requests SET status = 'received', closed_at = NULL, closed_by = NULL WHERE reference = 'DSR-T-2'$$,
  '23514', 'a closed request cannot be reopened');
UPDATE data_subject_requests SET contact_id = 'a5000000-0000-0000-0000-000000000002' WHERE reference = 'DSR-T-2';
SELECT test_assert((SELECT contact_id = 'a5000000-0000-0000-0000-000000000002' FROM data_subject_requests WHERE reference = 'DSR-T-2'),
  'a merge can move even a closed request to the kept contact');
SELECT test_assert(
  (SELECT handling = 'repoint' FROM contact_reference_columns WHERE table_name = 'data_subject_requests' AND column_name = 'contact_id'),
  'requests are in the merge register');
SELECT test_expect_error(
  $$DELETE FROM data_subject_requests WHERE reference = 'DSR-T-2'$$,
  '42501', 'requests are never deleted');

-- ------------------------------------------------------ history and evidence
INSERT INTO data_subject_request_events (company_id, request_id, event_type, actor)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a9600000-0000-0000-0000-000000000001', 'created', 'a4000000-0000-0000-0000-000000000001');
INSERT INTO data_subject_request_evidence (company_id, request_id, kind, summary, received_on, recorded_by)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a9600000-0000-0000-0000-000000000001', 'request', 'Email asking us to delete their data', current_date - 3, 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$UPDATE data_subject_request_events SET event_type = 'assigned'$$, '42501', 'request history is append-only');
SELECT test_expect_error(
  $$DELETE FROM data_subject_request_evidence$$, '42501', 'evidence is append-only');
SELECT test_expect_error(
  $$INSERT INTO data_subject_request_evidence (company_id, request_id, kind, summary, received_on, recorded_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9600000-0000-0000-0000-000000000001', 'request', 'x', current_date, 'a4000000-0000-0000-0000-000000000001')$$,
  '23514', 'evidence needs a summary');

-- --------------------------------------------------------- tenant isolation
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) = 0 FROM data_subject_requests), 'another company sees no requests');
SELECT test_assert((SELECT count(*) = 0 FROM data_subject_request_evidence), 'another company sees no evidence');
SELECT test_expect_error(
  $$INSERT INTO data_subject_requests (company_id, reference, contact_id, request_type, channel, received_on, due_on, created_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'DSR-X', 'a5000000-0000-0000-0000-000000000003', 'access', 'email', current_date, current_date, 'a4000000-0000-0000-0000-000000000001')$$,
  '42501', 'row-level security refuses another company''s request');

-- ------------------------------------------------------------- permissions
RESET ROLE;
SELECT test_assert(
  (SELECT array_agg(permission_key ORDER BY permission_key) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
    WHERE r.key = 'office_admin' AND r.company_id IS NULL AND permission_key LIKE 'privacy.%') = ARRAY['privacy.manage', 'privacy.view'],
  'office administrators manage requests but cannot fulfil them');
SELECT test_assert(
  (SELECT is_sensitive FROM permissions WHERE key = 'privacy.fulfil'), 'fulfilling a request is sensitive (step-up)');
SELECT test_assert(
  NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
               WHERE r.key IN ('agent', 'sales_manager', 'accountant') AND permission_key LIKE 'privacy.%'),
  'agents, sales managers and accountants have no access to the register');

ROLLBACK;
