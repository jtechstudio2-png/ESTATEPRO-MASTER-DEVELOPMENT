-- =============================================================================
-- L3: maintained balances, bank-file import, arrears actions, payment plans
-- (migration 0038). Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- Fixture lease LSE-2026-000001 (active, GHS) has two posted rent charges of 6,000 (January, February).
INSERT INTO payments (id, company_id, reference, payer_contact_id, lease_id, bank_account_id, method_code, currency_code, amount, received_on, status, value_date) VALUES
  ('f1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'RCP-L3-1', 'a5000000-0000-0000-0000-000000000002',
   'ab000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'bank_transfer', 'GHS', 9000, '2026-01-05', 'pending', NULL);
UPDATE payments SET status = 'cleared', value_date = '2026-01-05' WHERE id = 'f1000000-0000-0000-0000-000000000001';

-- ------------------------------------------------- maintained balances
INSERT INTO payment_allocations (id, company_id, payment_id, rent_charge_id, amount, allocated_on) VALUES
  ('f2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001', 6000, '2026-01-05'),
  ('f2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000002', 2000, '2026-01-05');
SELECT test_assert((SELECT allocated_amount = 6000 FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000001')
               AND (SELECT allocated_amount = 2000 FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000002')
               AND (SELECT allocated_amount = 8000 FROM payments WHERE id = 'f1000000-0000-0000-0000-000000000001'),
  'allocations keep the charge''s paid amount and the receipt''s allocated amount');
INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, reversal_of_id, allocated_on) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000002', -2000, 'f2000000-0000-0000-0000-000000000002', '2026-01-06');
SELECT test_assert((SELECT allocated_amount = 0 FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000002')
               AND (SELECT allocated_amount = 6000 FROM payments WHERE id = 'f1000000-0000-0000-0000-000000000001'),
  'a reversal takes the balances back');
INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason, adjusted_on, approved_by) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000002', -500, 'Agreed reduction', current_date, 'a4000000-0000-0000-0000-000000000001');
SELECT test_assert((SELECT adjusted_amount = -500 FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000002'),
  'adjustments keep the charge''s adjusted amount');
SELECT test_assert((SELECT outstanding_amount = 5500 AND paid_amount = 0 AND adjustment_amount = -500 FROM rent_charge_balances WHERE rent_charge_id = 'ac000000-0000-0000-0000-000000000002'),
  'rent_charge_balances reads the maintained balances');
SELECT test_expect_error($$UPDATE rent_charges SET allocated_amount = 0 WHERE id = 'ac000000-0000-0000-0000-000000000001'$$,
  '42501', 'a charge''s paid amount changes only through allocations');
SELECT test_expect_error($$SELECT set_config('app.maintaining_balances', 'on', true); UPDATE payments SET allocated_amount = 0 WHERE id = 'f1000000-0000-0000-0000-000000000001'$$,
  '42501', 'setting the maintenance flag in a session does not open the balances');
SELECT set_config('app.maintaining_balances', 'off', true);
SELECT test_expect_error($$UPDATE rent_charges SET adjusted_amount = 1 WHERE id = 'ac000000-0000-0000-0000-000000000002'$$,
  '42501', 'a charge''s adjusted amount changes only through adjustments');
SELECT test_expect_error($$INSERT INTO rent_charges (company_id, lease_id, charge_type, description, due_date, currency_code, amount, allocated_amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'fee', 'Fee', '2026-05-01', 'GHS', 10, 10)$$,
  '23514', 'a charge starts with nothing paid');
SELECT test_expect_error($$INSERT INTO payments (company_id, reference, payer_contact_id, bank_account_id, method_code, currency_code, amount, received_on, allocated_amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'RCP-L3-X', 'a5000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000001', 'cash', 'GHS', 10, '2026-05-01', 5)$$,
  '23514', 'a receipt starts with nothing allocated');
UPDATE rent_charges SET status = 'posted' WHERE id = 'ac000000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT allocated_amount = 6000 FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000001'),
  'other updates of a charge leave its balances');

-- ------------------------------------------------- bank-file import
INSERT INTO documents (id, company_id, title, document_type_code, category) VALUES
  ('f3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'January statement', 'bank_statement', 'financial');
INSERT INTO document_links (company_id, document_id, entity_type, entity_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'bank_account', 'aa000000-0000-0000-0000-000000000001');
SELECT test_assert(true, 'a document may belong to a bank account');
INSERT INTO payment_imports (id, company_id, bank_account_id, document_id, line_count, created_by) VALUES
  ('f4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001',
   'f3000000-0000-0000-0000-000000000001', 3, 'a4000000-0000-0000-0000-000000000001');
INSERT INTO payment_import_lines (id, company_id, import_id, line_no, txn_date, amount, currency_code, reference, description, idempotency_key, status, lease_id, payer_contact_id) VALUES
  ('f5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 1, '2026-02-02', 6000, 'GHS',
   'LSE-2026-000001', 'Rent Feb', 'k1', 'matched', 'ab000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000002'),
  ('f5000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 2, '2026-02-02', 1200, 'GHS',
   'JAN RENT FLAT2', NULL, 'k2', 'unmatched', NULL, NULL);
INSERT INTO payment_import_lines (company_id, import_id, line_no, idempotency_key, status, error_code, error_message) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 3, 'k3', 'error', 'bad-date', 'The date is not a real date');
SELECT test_expect_error($$INSERT INTO payment_import_lines (company_id, import_id, line_no, idempotency_key, status)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 4, 'k4', 'matched')$$,
  '23514', 'a line that is not in error has its date, amount and currency');
UPDATE payment_import_lines SET status = 'queued' WHERE id = 'f5000000-0000-0000-0000-000000000002';
SELECT test_expect_error($$INSERT INTO payment_import_lines (company_id, import_id, line_no, txn_date, amount, currency_code, idempotency_key, status)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 5, '2026-02-02', 1200, 'GHS', 'k2', 'queued')$$,
  '23505', 'a line already waiting in the queue is not queued again (the same file imported twice)');
SELECT test_expect_error($$UPDATE payment_import_lines SET amount = 1 WHERE id = 'f5000000-0000-0000-0000-000000000002'$$,
  '42501', 'the bank data of a line is fixed');
SELECT test_expect_error($$UPDATE payment_import_lines SET reference = 'changed' WHERE id = 'f5000000-0000-0000-0000-000000000002'$$,
  '42501', 'a line''s reference is fixed (an erasure may blank it)');
SELECT test_expect_error($$UPDATE payment_import_lines SET status = 'imported' WHERE id = 'f5000000-0000-0000-0000-000000000002'$$,
  '23514', 'a line is imported with its receipt');
SELECT test_expect_error($$UPDATE payment_import_lines SET status = 'matched' WHERE id = 'f5000000-0000-0000-0000-000000000002'$$,
  '23514', 'a queued line is only imported');
SELECT test_expect_error($$UPDATE payment_import_lines SET status = 'queued' WHERE line_no = 3 AND import_id = 'f4000000-0000-0000-0000-000000000001'$$,
  '23514', 'a line in error is final');
INSERT INTO payments (id, company_id, reference, payer_contact_id, lease_id, bank_account_id, method_code, currency_code, amount, received_on, status, value_date, idempotency_key) VALUES
  ('f1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'RCP-L3-2', 'a5000000-0000-0000-0000-000000000002',
   'ab000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'bank_transfer', 'GHS', 6000, '2026-02-02', 'cleared', '2026-02-02', 'k1');
UPDATE payment_import_lines SET status = 'imported', payment_id = 'f1000000-0000-0000-0000-000000000002' WHERE id = 'f5000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE payment_import_lines SET payer_contact_id = NULL WHERE id = 'f5000000-0000-0000-0000-000000000001'$$,
  '42501', 'an imported line is final');
SELECT test_expect_error($$DELETE FROM payment_import_lines WHERE id = 'f5000000-0000-0000-0000-000000000001'$$,
  '42501', 'file lines are never deleted');
UPDATE payment_imports SET status = 'committed', committed_at = now(), committed_by = 'a4000000-0000-0000-0000-000000000001' WHERE id = 'f4000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE payment_imports SET status = 'cancelled' WHERE id = 'f4000000-0000-0000-0000-000000000001'$$,
  '23514', 'a committed import is final');
SELECT test_expect_error($$UPDATE payment_imports SET line_count = 9 WHERE id = 'f4000000-0000-0000-0000-000000000001'$$,
  '42501', 'the file of an import is fixed');
SELECT test_expect_error($$DELETE FROM payment_imports WHERE id = 'f4000000-0000-0000-0000-000000000001'$$,
  '42501', 'imports are never deleted');

-- ------------------------------------------------- arrears actions
INSERT INTO arrears_actions (id, company_id, lease_id, action_code, action_date, arrears_amount, notes, next_action_date, performed_by) VALUES
  ('f6000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'reminder', '2026-02-10', 5500,
   'Called, no answer', '2026-02-24', 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error($$UPDATE arrears_actions SET notes = 'edited' WHERE id = 'f6000000-0000-0000-0000-000000000001'$$,
  '42501', 'arrears actions are a history (notes are not edited)');
SELECT test_expect_error($$DELETE FROM arrears_actions WHERE id = 'f6000000-0000-0000-0000-000000000001'$$,
  '42501', 'arrears actions are never deleted');

-- ------------------------------------------------- payment plans
SELECT test_expect_error($$INSERT INTO payment_plans (company_id, lease_id, currency_code, total_amount, instalments, agreed_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 5500,
            '[{"due_date": "2026-03-01", "amount": "3000"}, {"due_date": "2026-04-01", "amount": "2000"}]', '2026-02-15')$$,
  '23514', 'the instalments add up to the plan total');
SELECT test_expect_error($$INSERT INTO payment_plans (company_id, lease_id, currency_code, total_amount, instalments, agreed_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 5500,
            '[{"due_date": "2026-04-01", "amount": "3000"}, {"due_date": "2026-03-01", "amount": "2500"}]', '2026-02-15')$$,
  '23514', 'instalments are due in order');
SELECT test_expect_error($$INSERT INTO payment_plans (company_id, lease_id, currency_code, total_amount, instalments, agreed_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 5500,
            '[{"due_date": "2026-01-01", "amount": "5500"}]', '2026-02-15')$$,
  '23514', 'no instalment is due before the plan is agreed');
SELECT test_expect_error($$INSERT INTO payment_plans (company_id, lease_id, currency_code, total_amount, instalments, agreed_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'AED', 5500,
            '[{"due_date": "2026-03-01", "amount": "5500"}]', '2026-02-15')$$,
  '23514', 'a plan is in the lease''s currency');
SELECT test_expect_error($$INSERT INTO payment_plans (company_id, lease_id, currency_code, total_amount, instalments, agreed_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 5500, '[]', '2026-02-15')$$,
  '23514', 'a plan has instalments');
INSERT INTO payment_plans (id, company_id, lease_id, currency_code, total_amount, instalments, agreed_on) VALUES
  ('f7000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 5500,
   '[{"due_date": "2026-03-01", "amount": "3000"}, {"due_date": "2026-04-01", "amount": "2500"}]', '2026-02-15');
SELECT test_expect_error($$INSERT INTO payment_plans (company_id, lease_id, currency_code, total_amount, instalments, agreed_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 100, '[{"due_date": "2026-03-01", "amount": "100"}]', '2026-02-15')$$,
  '23505', 'one active plan per lease');
SELECT test_expect_error($$UPDATE payment_plans SET total_amount = 1 WHERE id = 'f7000000-0000-0000-0000-000000000001'$$,
  '42501', 'the terms of a plan are fixed');
SELECT test_expect_error($$UPDATE payment_plans SET status = 'broken', closed_on = '2026-01-01', closed_reason = 'Missed', closed_by = 'a4000000-0000-0000-0000-000000000001' WHERE id = 'f7000000-0000-0000-0000-000000000001'$$,
  '23514', 'a plan closes on or after the day it was agreed');
UPDATE payment_plans SET status = 'broken', closed_on = '2026-03-05', closed_reason = 'First instalment missed', closed_by = 'a4000000-0000-0000-0000-000000000001'
 WHERE id = 'f7000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE payment_plans SET status = 'active', closed_on = NULL WHERE id = 'f7000000-0000-0000-0000-000000000001'$$,
  '42501', 'a broken plan is final');
SELECT test_expect_error($$DELETE FROM payment_plans WHERE id = 'f7000000-0000-0000-0000-000000000001'$$,
  '42501', 'plans are never deleted');

-- ------------------------------------------------- isolation
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) = 0 FROM payment_imports) AND (SELECT count(*) = 0 FROM payment_import_lines WHERE import_id = 'f4000000-0000-0000-0000-000000000001')
               AND (SELECT count(*) = 0 FROM payment_plans WHERE lease_id = 'ab000000-0000-0000-0000-000000000001'),
  'another company sees none of the imports, lines or plans');

ROLLBACK;
