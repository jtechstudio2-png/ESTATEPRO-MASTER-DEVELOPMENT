-- =============================================================================
-- P7-0 (#22): money rules hold under concurrent writers (migration 0035).
-- Two extra sessions (dblink, over the server's local socket) race each other
-- on committed rows, as two clerks or a clerk and the worker would. The rows
-- are removed at the end; the extension is dropped.
-- =============================================================================
\set ON_ERROR_STOP 1
CREATE EXTENSION IF NOT EXISTS dblink;

-- Two runtime sessions for company A.
SELECT dblink_connect('a', 'dbname=' || current_database());
SELECT dblink_connect('b', 'dbname=' || current_database());
SELECT dblink_exec(c, 'SET ROLE estatepro_app'),
       dblink_exec(c, $$SET app.company_id = 'a0000000-0000-0000-0000-000000000001'$$)
  FROM unnest(ARRAY['a', 'b']) AS c;

-- Committed rows to race on: four posted charges and four cleared payments.
CREATE TEMP TABLE saved_sequence AS
  SELECT next_value, current_year FROM number_sequences WHERE company_id = 'a0000000-0000-0000-0000-000000000001' AND sequence_key = 'payment';
INSERT INTO rent_charges (id, company_id, lease_id, charge_type, description, due_date, currency_code, amount)
SELECT ('c1000000-0000-0000-0000-00000000000' || i)::uuid, 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
       'rent', 'Race charge ' || i, date '2026-05-01' + i, 'GHS', 6000
  FROM generate_series(1, 4) AS i;
INSERT INTO payments (id, company_id, reference, payer_contact_id, lease_id, bank_account_id, method_code, currency_code, amount,
                      received_on, status, value_date)
SELECT ('c2000000-0000-0000-0000-00000000000' || i)::uuid, 'a0000000-0000-0000-0000-000000000001', 'RCP-RACE-' || i,
       'a5000000-0000-0000-0000-000000000002', 'ab000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001',
       'bank_transfer', 'GHS', 6000, '2026-05-01', 'cleared', '2026-05-01'
  FROM generate_series(1, 4) AS i;

-- ------------------------------------------------- two allocations of one payment
-- Each alone fits (4,000 of 6,000); together they would over-allocate it.
SELECT dblink_exec('a', 'BEGIN');
SELECT dblink_exec('a', $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 4000, '2026-05-02')$$);
SELECT dblink_send_query('b', $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 4000, '2026-05-02')$$);
SELECT pg_sleep(0.3);
SELECT test_assert(dblink_is_busy('b') = 1, '#22: the second allocation waits for the first (the payment row is locked)');
SELECT dblink_exec('a', 'COMMIT');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);
SELECT test_assert(dblink_error_message('b') LIKE '%exceeds unallocated amount%', '#22: the second allocation is refused once the first commits');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);
SELECT test_assert(
  (SELECT sum(amount) = 4000 FROM payment_allocations WHERE payment_id = 'c2000000-0000-0000-0000-000000000001'),
  '#22: the payment is never over-allocated');

-- ------------------------------------------------- two payments onto one charge
SELECT dblink_exec('a', 'BEGIN');
SELECT dblink_exec('a', $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000003', 5000, '2026-05-02')$$);
SELECT dblink_send_query('b', $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', 5000, '2026-05-02')$$);
SELECT pg_sleep(0.3);
SELECT test_assert(dblink_is_busy('b') = 1, '#22: a second payment onto the same charge waits (the charge row is locked)');
SELECT dblink_exec('a', 'COMMIT');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);
SELECT test_assert(dblink_error_message('b') LIKE '%exceeds outstanding amount%', '#22: the charge is never over-paid');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);

-- ------------------------------------------------- a bounce racing an allocation (both orders)
-- Bounce first: the allocation then finds the payment bounced.
SELECT dblink_exec('a', 'BEGIN');
SELECT dblink_exec('a', $$UPDATE payments SET status = 'bounced', status_reason = 'Returned unpaid' WHERE id = 'c2000000-0000-0000-0000-000000000004'$$);
SELECT dblink_send_query('b', $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000004', 3000, '2026-05-02')$$);
SELECT pg_sleep(0.3);
SELECT test_assert(dblink_is_busy('b') = 1, '#22: an allocation waits for a bounce in progress');
SELECT dblink_exec('a', 'COMMIT');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);
SELECT test_assert(dblink_error_message('b') LIKE '%cannot be allocated until cleared%', '#22: the allocation is refused once the bounce commits');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);
-- Allocation first: the bounce then finds money allocated and is refused (reverse first, #3).
SELECT dblink_exec('a', 'BEGIN');
SELECT dblink_exec('a', $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000004', 1000, '2026-05-02')$$);
SELECT dblink_send_query('b', $$UPDATE payments SET status = 'bounced', status_reason = 'Returned unpaid' WHERE id = 'c2000000-0000-0000-0000-000000000003'$$);
SELECT pg_sleep(0.3);
SELECT test_assert(dblink_is_busy('b') = 1, '#22: a bounce waits for an allocation in progress');
SELECT dblink_exec('a', 'COMMIT');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);
SELECT test_assert(dblink_error_message('b') LIKE '%still has%allocated%', '#22: the bounce is refused while the new allocation stands');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);
SELECT test_assert((SELECT status = 'cleared' FROM payments WHERE id = 'c2000000-0000-0000-0000-000000000003'),
  '#22: so arrears never disappear behind a bounced payment');

-- ------------------------------------------------- an adjustment racing an allocation
SELECT dblink_exec('a', 'BEGIN');
SELECT dblink_exec('a', $$INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason, approved_by)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', -5000, 'Rent reduced by agreement', 'a4000000-0000-0000-0000-000000000003')$$);
SELECT dblink_send_query('b', $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
  VALUES ('a0000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002', 2000, '2026-05-02')$$);
SELECT pg_sleep(0.3);
SELECT test_assert(dblink_is_busy('b') = 1, '#22: an allocation waits for an adjustment of the same charge');
SELECT dblink_exec('a', 'COMMIT');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);
SELECT test_assert(dblink_error_message('b') LIKE '%exceeds outstanding amount%', '#22: the allocation sees the reduced charge (1,000 left)');
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);

-- ------------------------------------------------- reference numbers
SELECT dblink_exec('a', 'BEGIN');
CREATE TEMP TABLE race_refs (who text, ref text);
INSERT INTO race_refs SELECT 'a', r FROM dblink('a', $$SELECT app.next_reference('a0000000-0000-0000-0000-000000000001', 'payment', '2026-05-02')$$) AS t(r text);
SELECT dblink_send_query('b', $$SELECT app.next_reference('a0000000-0000-0000-0000-000000000001', 'payment', '2026-05-02')$$);
SELECT pg_sleep(0.3);
SELECT test_assert(dblink_is_busy('b') = 1, '#22: a second reference waits for the first');
SELECT dblink_exec('a', 'COMMIT');
INSERT INTO race_refs SELECT 'b', r FROM dblink_get_result('b') AS t(r text);
SELECT count(*) FROM dblink_get_result('b', false) AS r(status text);
SELECT test_assert((SELECT count(DISTINCT ref) = 2 AND count(*) = 2 FROM race_refs), '#22: concurrent receipts get distinct references');

-- ------------------------------------------------- clean up the committed rows
SELECT dblink_disconnect('a');
SELECT dblink_disconnect('b');
SET session_replication_role = replica;  -- the append-only guards would refuse the clean-up
DELETE FROM payment_allocations WHERE payment_id::text LIKE 'c2000000%';
DELETE FROM rent_charge_adjustments WHERE rent_charge_id::text LIKE 'c1000000%';
DELETE FROM payments WHERE id::text LIKE 'c2000000%';
DELETE FROM rent_charges WHERE id::text LIKE 'c1000000%';
SET session_replication_role = origin;
UPDATE number_sequences n SET next_value = s.next_value, current_year = s.current_year FROM saved_sequence s
 WHERE n.company_id = 'a0000000-0000-0000-0000-000000000001' AND n.sequence_key = 'payment';
DROP EXTENSION dblink;
\echo '18_concurrency_p7_0: all assertions passed'
