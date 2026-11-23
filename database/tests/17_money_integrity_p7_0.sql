-- =============================================================================
-- P7-0: money integrity (#1, #2, #3, #13) and tenancy records (ADR-009)
-- (migration 0035). Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- ------------------------------------------------- #1: posted charges keep their terms
-- The audit's reproduction: a posted GHS 6,000 charge edited down to 100.
SELECT test_expect_error($$UPDATE rent_charges SET amount = 100 WHERE id = 'ac000000-0000-0000-0000-000000000001'$$,
  '42501', '#1: a posted charge cannot be edited down (6,000 to 100)');
SELECT test_expect_error($$UPDATE rent_charges SET due_date = '2026-03-01' WHERE id = 'ac000000-0000-0000-0000-000000000001'$$,
  '42501', '#1: a posted charge keeps its due date');
SELECT test_expect_error($$UPDATE rent_charges SET lease_id = lease_id, description = 'Other' WHERE id = 'ac000000-0000-0000-0000-000000000001'$$,
  '42501', '#1: a posted charge keeps its description');
SELECT test_expect_error($$DELETE FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000001'$$,
  '42501', '#1: a posted charge cannot be deleted');
SELECT test_expect_error($$UPDATE rent_charges SET status = 'scheduled' WHERE id = 'ac000000-0000-0000-0000-000000000001'$$,
  '23514', '#1: a posted charge cannot go back to scheduled');
SELECT test_assert((SELECT total_amount = 6000 FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000001'), '#1: the charge still reads 6,000');

-- Scheduled charges stay editable until posted.
INSERT INTO rent_charges (id, company_id, lease_id, charge_type, description, period_start, period_end, due_date, currency_code, amount, status) VALUES
  ('ac000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
   'rent', 'Rent March 2026', '2026-03-01', '2026-03-31', '2026-03-01', 'GHS', 6000, 'scheduled'),
  ('ac000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
   'rent', 'Rent April 2026', '2026-04-01', '2026-04-30', '2026-04-01', 'GHS', 6000, 'scheduled');
UPDATE rent_charges SET amount = 6500 WHERE id = 'ac000000-0000-0000-0000-000000000003';
SELECT test_assert((SELECT amount = 6500 FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000003'), 'a scheduled charge can still be edited');
SELECT test_expect_error($$UPDATE rent_charges SET status = 'waived', waived_reason = 'x' WHERE id = 'ac000000-0000-0000-0000-000000000003'$$,
  '23514', 'a scheduled charge is cancelled, not waived');
DELETE FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000004';
SELECT test_assert(NOT EXISTS (SELECT 1 FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000004'), 'a scheduled charge can be deleted');
UPDATE rent_charges SET status = 'posted', posted_at = now() WHERE id = 'ac000000-0000-0000-0000-000000000003';

-- Payments for the allocation and reversal cases.
INSERT INTO payments (id, company_id, reference, payer_contact_id, lease_id, bank_account_id, method_code, currency_code, amount,
                      received_on, instrument_number, instrument_date, instrument_bank, notes) VALUES
  ('ad000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'RCP-T-1', 'a5000000-0000-0000-0000-000000000002',
   'ab000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'bank_transfer', 'GHS', 6000, '2026-01-02', NULL, NULL, NULL, 'January rent'),
  ('ad000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'RCP-T-2', 'a5000000-0000-0000-0000-000000000002',
   'ab000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'cheque', 'GHS', 6000, '2026-01-20',
   '000123', '2026-02-01', 'Test Bank', 'Post-dated cheque for February');

-- Waive and cancel only while nothing is allocated.
UPDATE payments SET status = 'cleared', value_date = '2026-01-02' WHERE id = 'ad000000-0000-0000-0000-000000000001';
INSERT INTO payment_allocations (id, company_id, payment_id, rent_charge_id, amount, allocated_on) VALUES
  ('ae000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001',
   'ac000000-0000-0000-0000-000000000001', 1000, '2026-01-02');
SELECT test_expect_error($$UPDATE rent_charges SET status = 'waived', waived_reason = 'Goodwill' WHERE id = 'ac000000-0000-0000-0000-000000000001'$$,
  '23514', '#1: a charge with money allocated cannot be waived');
SELECT test_expect_error($$UPDATE rent_charges SET status = 'cancelled' WHERE id = 'ac000000-0000-0000-0000-000000000001'$$,
  '23514', '#1: a charge with money allocated cannot be cancelled');

-- ------------------------------------------------- #1: adjustments
SELECT test_expect_error(
  $$INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason, approved_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001', -5500, 'Too far', 'a4000000-0000-0000-0000-000000000003')$$,
  '23514', 'an adjustment cannot take a charge below what is already paid');
SELECT test_expect_error(
  $$INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason, approved_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001', -500, 'x', 'a4000000-0000-0000-0000-000000000003')$$,
  '23514', 'an adjustment needs a reason');
SELECT test_expect_error(
  $$INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001', -500, 'Agreed reduction')$$,
  '23502', 'an adjustment needs an approver');
SELECT test_expect_error(
  $$INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason, approved_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001', 0, 'Nothing', 'a4000000-0000-0000-0000-000000000003')$$,
  '23514', 'an adjustment is never zero');
INSERT INTO rent_charge_adjustments (id, company_id, rent_charge_id, amount, reason, approved_by, adjusted_on) VALUES
  ('af000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001',
   -500, 'Agreed reduction for the broken water heater', 'a4000000-0000-0000-0000-000000000003', current_date);
SELECT test_assert(
  (SELECT total_amount = 6000 AND adjustment_amount = -500 AND adjusted_total_amount = 5500 AND paid_amount = 1000 AND outstanding_amount = 4500
     FROM rent_charge_balances WHERE rent_charge_id = 'ac000000-0000-0000-0000-000000000001'),
  'the balance includes the adjustment (6,000 - 500 - 1,000 paid = 4,500)');
SELECT test_expect_error(
  $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001', 5000, '2026-01-02')$$,
  '23514', 'an allocation cannot exceed the adjusted amount (4,500 left)');
INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001', 4500, '2026-01-02');
SELECT test_assert((SELECT outstanding_amount = 0 FROM rent_charge_balances WHERE rent_charge_id = 'ac000000-0000-0000-0000-000000000001'),
  'the adjusted charge is settled exactly');
SELECT test_expect_error($$UPDATE rent_charge_adjustments SET amount = -100 WHERE id = 'af000000-0000-0000-0000-000000000001'$$,
  '42501', 'adjustments are append-only (no edit)');
SELECT test_expect_error($$DELETE FROM rent_charge_adjustments WHERE id = 'af000000-0000-0000-0000-000000000001'$$,
  '42501', 'adjustments are append-only (no delete)');
INSERT INTO rent_charges (id, company_id, lease_id, charge_type, description, due_date, currency_code, amount, status) VALUES
  ('ac000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
   'service_charge', 'Service charge 2026', '2026-06-01', 'GHS', 900, 'scheduled');
SELECT test_expect_error(
  $$INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason, approved_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000005', -100, 'Not posted yet', 'a4000000-0000-0000-0000-000000000003')$$,
  '23514', 'only posted charges are adjusted (a scheduled one is edited instead)');
DELETE FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000005';
-- A locked period refuses adjustments dated in it.
RESET ROLE;
INSERT INTO financial_periods (company_id, period_start, period_end, status, locked_at, locked_by)
VALUES ('a0000000-0000-0000-0000-000000000001', '2025-01-01', '2025-12-31', 'locked', now(), 'a4000000-0000-0000-0000-000000000003');
SET LOCAL ROLE estatepro_app;
SELECT test_expect_error(
  $$INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason, approved_by, adjusted_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000002', -100, 'Back-dated', 'a4000000-0000-0000-0000-000000000003', '2025-12-31')$$,
  '42501', 'an adjustment cannot be dated in a locked period');
-- Isolation: another company sees none of them.
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) = 0 FROM rent_charge_adjustments), 'another company sees no adjustments');
SELECT test_expect_error(
  $$INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason, approved_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000002', -100, 'Cross-company', 'a4000000-0000-0000-0000-000000000003')$$,
  '42501', 'another company cannot adjust this company''s charge');
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);

-- ------------------------------------------------- #2: payments keep their terms
-- The audit's reproduction: a cleared GHS 6,000 receipt edited to 10.
SELECT test_expect_error($$UPDATE payments SET amount = 10 WHERE id = 'ad000000-0000-0000-0000-000000000001'$$,
  '42501', '#2: a cleared payment cannot be edited down (6,000 to 10)');
SELECT test_expect_error($$UPDATE payments SET payer_contact_id = 'a5000000-0000-0000-0000-000000000001' WHERE id = 'ad000000-0000-0000-0000-000000000001'$$,
  '42501', '#2: a cleared payment keeps its payer');
SELECT test_expect_error($$UPDATE payments SET received_on = '2026-01-05' WHERE id = 'ad000000-0000-0000-0000-000000000001'$$,
  '42501', '#2: a cleared payment keeps its date');
SELECT test_expect_error($$UPDATE payments SET value_date = '2026-01-09' WHERE id = 'ad000000-0000-0000-0000-000000000001'$$,
  '42501', '#2: a cleared payment keeps its value date');
SELECT test_expect_error($$DELETE FROM payments WHERE id = 'ad000000-0000-0000-0000-000000000001'$$,
  '42501', '#2: a cleared payment cannot be deleted');
SELECT test_expect_error($$UPDATE payments SET status = 'pending' WHERE id = 'ad000000-0000-0000-0000-000000000001'$$,
  '23514', '#2: a cleared payment cannot go back to pending');
-- While pending, a payment can be corrected, but never below what is allocated (nothing is, yet).
UPDATE payments SET instrument_number = '000124' WHERE id = 'ad000000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT instrument_number = '000124' FROM payments WHERE id = 'ad000000-0000-0000-0000-000000000002'), 'a pending payment can be corrected');
SELECT test_expect_error($$UPDATE payments SET status = 'refunded', status_reason = 'x' WHERE id = 'ad000000-0000-0000-0000-000000000002'$$,
  '23514', 'a pending payment is voided or bounced, not refunded');

-- ------------------------------------------------- #3: a bounced post-dated cheque restores the arrears
UPDATE payments SET status = 'cleared', value_date = '2026-02-01' WHERE id = 'ad000000-0000-0000-0000-000000000002';
INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000002', 'ac000000-0000-0000-0000-000000000002', 6000, '2026-02-01');
SELECT test_assert((SELECT outstanding_amount = 0 FROM rent_charge_balances WHERE rent_charge_id = 'ac000000-0000-0000-0000-000000000002'),
  'February is paid by the cheque');
SELECT test_expect_error(
  $$UPDATE payments SET status = 'bounced', status_reason = 'Returned unpaid' WHERE id = 'ad000000-0000-0000-0000-000000000002'$$,
  '23514', '#3: a payment cannot bounce while its allocations stand (the arrears would vanish)');
SELECT test_expect_error($$UPDATE payments SET amount = 5000 WHERE id = 'ad000000-0000-0000-0000-000000000002'$$,
  '42501', '#3: an allocated payment cannot shrink');
SELECT test_expect_error($$SELECT app.unwind_payment('ad000000-0000-0000-0000-000000000002', 'cleared', 'Nothing', current_date)$$,
  '23514', 'unwind only bounces, refunds or voids');
SELECT test_expect_error($$SELECT app.unwind_payment('ad000000-0000-0000-0000-000000000002', 'bounced', '', current_date)$$,
  '23514', 'unwind needs a reason');
SELECT test_assert(app.unwind_payment('ad000000-0000-0000-0000-000000000002', 'bounced', 'Returned unpaid: insufficient funds', current_date) = 1,
  '#3: unwinding reverses the cheque''s one allocation');
SELECT test_assert(
  (SELECT status = 'bounced' AND status_reason = 'Returned unpaid: insufficient funds' FROM payments WHERE id = 'ad000000-0000-0000-0000-000000000002'),
  '#3: and marks it bounced in the same call');
SELECT test_assert((SELECT outstanding_amount = 6000 FROM rent_charge_balances WHERE rent_charge_id = 'ac000000-0000-0000-0000-000000000002'),
  '#3: February is owed again');
SELECT test_assert(
  (SELECT count(*) = 2 AND sum(amount) = 0 FROM payment_allocations WHERE payment_id = 'ad000000-0000-0000-0000-000000000002'),
  '#3: the reversal is a new row; the original allocation is kept');
SELECT test_assert(
  (SELECT allocated_by = 'a4000000-0000-0000-0000-000000000001' FROM payment_allocations WHERE payment_id = 'ad000000-0000-0000-0000-000000000002' AND amount < 0),
  '#3: the reversal records the member who made it');
SELECT test_assert(
  EXISTS (SELECT 1 FROM app.lease_arrears(current_date) WHERE lease_id = 'ab000000-0000-0000-0000-000000000001'),
  '#3: the lease is in arrears again');
SELECT test_expect_error($$UPDATE payments SET status = 'cleared' WHERE id = 'ad000000-0000-0000-0000-000000000002'$$,
  '23514', 'a bounced payment is final');
SELECT test_expect_error(
  $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000002', 'ac000000-0000-0000-0000-000000000002', 6000, current_date)$$,
  '23514', 'a bounced payment cannot be allocated again');
-- Waiving is allowed once the allocations are reversed.
UPDATE rent_charges SET status = 'waived', waived_reason = 'Agreed with the landlord' WHERE id = 'ac000000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT status = 'waived' FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000002'), 'a charge with net zero allocated can be waived');
SELECT test_expect_error($$UPDATE rent_charges SET waived_reason = 'Changed story' WHERE id = 'ac000000-0000-0000-0000-000000000002'$$,
  '42501', 'the waiver reason is fixed');
SELECT test_expect_error($$UPDATE rent_charges SET status = 'posted' WHERE id = 'ac000000-0000-0000-0000-000000000002'$$,
  '23514', 'a waived charge is final');
SELECT test_expect_error(
  $$INSERT INTO rent_charge_adjustments (company_id, rent_charge_id, amount, reason, approved_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000002', -100, 'Waived already', 'a4000000-0000-0000-0000-000000000003')$$,
  '23514', 'a waived charge cannot be adjusted');
-- The runtime role cannot pretend to be an erasure to rewrite the cheque.
SELECT set_config('app.erasure', 'on', true);
SELECT test_expect_error($$UPDATE payments SET instrument_number = NULL WHERE id = 'ad000000-0000-0000-0000-000000000002'$$,
  '42501', 'the runtime role cannot blank cheque details by setting the erasure flag');
SELECT set_config('app.erasure', 'off', true);

-- ------------------------------------------------- #13: statements
INSERT INTO ledger_entries (id, company_id, ledger_type, contact_id, lease_id, entry_date, currency_code, credit, description) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'landlord', 'a5000000-0000-0000-0000-000000000001',
   'ab000000-0000-0000-0000-000000000001', '2026-01-02', 'GHS', 5500, 'Rent January 2026'),
  ('b1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'landlord', 'a5000000-0000-0000-0000-000000000001',
   'ab000000-0000-0000-0000-000000000001', '2026-01-03', 'GHS', 100, 'Late credit');
SELECT test_expect_error(
  $$INSERT INTO statements (company_id, reference, landlord_contact_id, period_start, period_end, currency_code,
                            opening_balance, total_income, total_fees, total_expenses, total_payouts, closing_balance)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'STM-T-0', 'a5000000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', 'GHS',
            0, 5500, 550, 0, 0, 5000)$$,
  '23514', 'statement arithmetic: closing = opening + income - fees - expenses - payouts');
INSERT INTO statements (id, company_id, reference, landlord_contact_id, period_start, period_end, currency_code,
                        opening_balance, total_income, total_fees, total_expenses, total_payouts, closing_balance) VALUES
  ('b2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'STM-T-1', 'a5000000-0000-0000-0000-000000000001',
   '2026-01-01', '2026-01-31', 'GHS', 0, 5500, 550, 0, 0, 4950);
INSERT INTO statement_lines (company_id, statement_id, ledger_entry_id, line_group, sort_order) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'income', 1);
UPDATE statement_lines SET sort_order = 2 WHERE statement_id = 'b2000000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT sort_order = 2 FROM statement_lines WHERE statement_id = 'b2000000-0000-0000-0000-000000000001'), 'draft statement lines can change');
UPDATE statements SET status = 'issued', issued_at = now() WHERE id = 'b2000000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$INSERT INTO statement_lines (company_id, statement_id, ledger_entry_id, line_group)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', 'income')$$,
  '42501', '#13: no line can be added to an issued statement');
SELECT test_expect_error($$UPDATE statement_lines SET line_group = 'fee' WHERE statement_id = 'b2000000-0000-0000-0000-000000000001'$$,
  '42501', '#13: no line of an issued statement can change');
SELECT test_expect_error($$DELETE FROM statement_lines WHERE statement_id = 'b2000000-0000-0000-0000-000000000001'$$,
  '42501', '#13: no line of an issued statement can be removed');
SELECT test_expect_error($$UPDATE statements SET status = 'draft' WHERE id = 'b2000000-0000-0000-0000-000000000001'$$,
  '23514', '#13: an issued statement cannot return to draft');
-- Not even the owner role (superuser, bypassing row-level security) can change issued lines.
RESET ROLE;
SELECT test_expect_error($$DELETE FROM statement_lines WHERE statement_id = 'b2000000-0000-0000-0000-000000000001'$$,
  '42501', '#13: the freeze holds for every role, including the database owner');
SET LOCAL ROLE estatepro_platform;
SELECT test_expect_error($$UPDATE statement_lines SET sort_order = 9 WHERE statement_id = 'b2000000-0000-0000-0000-000000000001'$$,
  '42501', '#13: the platform role cannot change issued lines either');
RESET ROLE;
SET LOCAL ROLE estatepro_app;
-- Correction: void the issued statement, then issue one that supersedes it.
SELECT test_expect_error(
  $$INSERT INTO statements (company_id, reference, landlord_contact_id, period_start, period_end, currency_code,
                            opening_balance, total_income, total_fees, total_expenses, total_payouts, closing_balance, supersedes_statement_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'STM-T-2', 'a5000000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', 'GHS',
            0, 5600, 560, 0, 0, 5040, 'b2000000-0000-0000-0000-000000000001')$$,
  '23514', '#13: a correction supersedes only a voided statement');
UPDATE statements SET status = 'void', void_reason = 'Late credit missed' WHERE id = 'b2000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE statements SET status = 'issued' WHERE id = 'b2000000-0000-0000-0000-000000000001'$$,
  '23514', '#13: a void statement is final');
SELECT test_expect_error($$DELETE FROM statement_lines WHERE statement_id = 'b2000000-0000-0000-0000-000000000001'$$,
  '42501', '#13: a void statement keeps its lines');
SELECT test_expect_error(
  $$INSERT INTO statements (company_id, reference, landlord_contact_id, period_start, period_end, currency_code,
                            opening_balance, total_income, total_fees, total_expenses, total_payouts, closing_balance, supersedes_statement_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'STM-T-2', 'a5000000-0000-0000-0000-000000000001', '2026-02-01', '2026-02-28', 'GHS',
            0, 5600, 560, 0, 0, 5040, 'b2000000-0000-0000-0000-000000000001')$$,
  '23514', '#13: a correction covers the same period');
INSERT INTO statements (id, company_id, reference, landlord_contact_id, period_start, period_end, currency_code,
                        opening_balance, total_income, total_fees, total_expenses, total_payouts, closing_balance, supersedes_statement_id) VALUES
  ('b2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'STM-T-2', 'a5000000-0000-0000-0000-000000000001',
   '2026-01-01', '2026-01-31', 'GHS', 0, 5600, 560, 0, 0, 5040, 'b2000000-0000-0000-0000-000000000001');
INSERT INTO statement_lines (company_id, statement_id, ledger_entry_id, line_group, sort_order) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'income', 1),
  ('a0000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', 'income', 2);
SELECT test_assert(
  (SELECT s.supersedes_statement_id = 'b2000000-0000-0000-0000-000000000001' AND p.status = 'void'
     FROM statements s JOIN statements p ON p.id = s.supersedes_statement_id WHERE s.id = 'b2000000-0000-0000-0000-000000000002'),
  '#13: the correcting statement names the void one');
SELECT test_expect_error(
  $$INSERT INTO statements (company_id, reference, landlord_contact_id, period_start, period_end, currency_code,
                            opening_balance, total_income, total_fees, total_expenses, total_payouts, closing_balance, supersedes_statement_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'STM-T-3', 'a5000000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', 'GHS',
            0, 5600, 560, 0, 0, 5040, 'b2000000-0000-0000-0000-000000000001')$$,
  '23505', '#13: a void statement is corrected once');
-- A draft statement can still be deleted with its lines.
DELETE FROM statements WHERE id = 'b2000000-0000-0000-0000-000000000002';
SELECT test_assert(NOT EXISTS (SELECT 1 FROM statement_lines WHERE statement_id = 'b2000000-0000-0000-0000-000000000002'),
  'deleting a draft statement removes its lines');

-- ------------------------------------------------- deposits (existing constraints, #22 coverage)
INSERT INTO deposits (id, company_id, lease_id, currency_code, amount, holder_type, status) VALUES
  ('b3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 12000, 'agent', 'held');
SELECT test_expect_error($$UPDATE deposits SET returned_amount = 12001 WHERE id = 'b3000000-0000-0000-0000-000000000001'$$,
  '23514', 'a deposit cannot return more than was held');
SELECT test_expect_error($$UPDATE deposits SET status = 'protected', protected_at = now() WHERE id = 'b3000000-0000-0000-0000-000000000001'$$,
  '23514', 'a protected deposit needs its scheme reference');
SELECT test_expect_error(
  $$INSERT INTO deposits (company_id, lease_id, currency_code, amount, holder_type)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 1, 'agent')$$,
  '23505', 'one deposit per lease');

-- ------------------------------------------------- ADR-009: erasure blockers for lettings
SELECT test_assert(
  (SELECT count(*) = 1 FROM jurisdiction_setting_definitions WHERE key = 'tenancy_records_retention_years' AND default_value IS NULL),
  'the tenancy retention rule exists with no default (set per jurisdiction after legal review)');
SELECT test_assert(app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000002') @> ARRAY['live_lease', 'open_balance', 'deposit_held'],
  'ADR-009: the tenant of an active lease with rent owed and a deposit held cannot be erased');
SELECT test_assert(NOT (app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000002') && ARRAY['lease_parties', 'payments']),
  'ADR-009: the generic reference codes are replaced by the specific ones');
SELECT test_assert('live_lease' = ANY (app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000001')),
  'ADR-009: the landlord party of an active lease cannot be erased');
-- A payment received from the person and not allocated is money still to account for.
INSERT INTO payments (id, company_id, reference, payer_contact_id, bank_account_id, method_code, currency_code, amount, received_on, status, value_date) VALUES
  ('ad000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'RCP-T-3', 'a5000000-0000-0000-0000-000000000003',
   'aa000000-0000-0000-0000-000000000001', 'cash', 'GHS', 300, '2026-03-01', 'pending', NULL);
UPDATE payments SET status = 'cleared', value_date = '2026-03-01' WHERE id = 'ad000000-0000-0000-0000-000000000003';
SELECT test_assert(app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000003') @> ARRAY['open_balance', 'tenancy_record'],
  'ADR-009: an unallocated receipt blocks, and a receipt is a tenancy record (no lease: the bank account''s country decides)');
UPDATE payments SET status = 'voided', status_reason = 'Entered in error' WHERE id = 'ad000000-0000-0000-0000-000000000003';
SELECT test_assert(NOT ('open_balance' = ANY (app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000003'))),
  'ADR-009: a voided receipt is not money still owed');

-- L3 (migration 0038): a bank-file line naming the tenant, and a payment plan closed with a reason.
INSERT INTO documents (id, company_id, title, document_type_code, category) VALUES
  ('ae100000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Statement', 'bank_statement', 'financial');
INSERT INTO payment_imports (id, company_id, bank_account_id, document_id, line_count) VALUES
  ('ae200000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'ae100000-0000-0000-0000-000000000001', 1);
INSERT INTO payment_import_lines (id, company_id, import_id, line_no, txn_date, amount, currency_code, reference, description, idempotency_key, status, payer_contact_id) VALUES
  ('ae300000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ae200000-0000-0000-0000-000000000001', 1, '2026-03-02', 100, 'GHS',
   'AMA RENT', 'From Ama Mensah', 'erasure-test-1', 'queued', 'a5000000-0000-0000-0000-000000000002');
INSERT INTO payment_plans (id, company_id, lease_id, currency_code, total_amount, instalments, agreed_on) VALUES
  ('ae400000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 100,
   '[{"due_date": "2026-04-01", "amount": "100"}]', '2026-03-01');
UPDATE payment_plans SET status = 'cancelled', closed_on = '2026-03-10', closed_reason = 'Ama moved to Kumasi' WHERE id = 'ae400000-0000-0000-0000-000000000001';

-- L4 (migration 0039): an inspection cancelled with a reason, and an item note and photo caption naming the tenant.
INSERT INTO inspections (id, company_id, reference, property_id, unit_id, lease_id, inspection_type) VALUES
  ('b4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'INS-T-1', 'a7000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'periodic'),
  ('b4000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'INS-T-2', 'a7000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'periodic');
UPDATE inspections SET status = 'cancelled', cancelled_reason = 'Ama asked to rebook' WHERE id = 'b4000000-0000-0000-0000-000000000001';
INSERT INTO inspection_items (id, company_id, inspection_id, area, item, notes) VALUES
  ('b4100000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000002', 'Hall', 'Door', 'Scratched by Ama''s bicycle');
INSERT INTO documents (id, company_id, title, document_type_code, category) VALUES
  ('b4200000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Hall door', 'inspection_photo', 'property');
INSERT INTO document_links (company_id, document_id, entity_type, entity_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'b4200000-0000-0000-0000-000000000001', 'inspection', 'b4000000-0000-0000-0000-000000000002');
INSERT INTO inspection_item_documents (company_id, inspection_item_id, document_id, caption) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'b4100000-0000-0000-0000-000000000001', 'b4200000-0000-0000-0000-000000000001', 'Ama''s bicycle marks');

-- Close out the lease: charges settled or waived, deposit returned, tenancy closed.
UPDATE rent_charges SET status = 'cancelled' WHERE id = 'ac000000-0000-0000-0000-000000000003';
UPDATE leases SET status = 'ended', move_out_date = '2026-10-31' WHERE id = 'ab000000-0000-0000-0000-000000000001';
-- A recharge is raised while the lease is ended, before it closes (L2: no charges on a closed lease).
INSERT INTO rent_charges (id, company_id, lease_id, charge_type, description, due_date, currency_code, amount) VALUES
  ('ac000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
   'repair_recharge', 'Broken window', '2026-10-31', 'GHS', 500);
UPDATE leases SET status = 'closed' WHERE id = 'ab000000-0000-0000-0000-000000000001';
-- L4 (migration 0039): deductions are proposed while the deposit is held, then decided, before the return.
INSERT INTO deposit_deductions (id, company_id, deposit_id, reason_code, description, amount) VALUES
  ('b3100000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001', 'cleaning', 'Cleaning after Ama moved out', 200);
UPDATE deposit_deductions SET status = 'withdrawn' WHERE id = 'b3100000-0000-0000-0000-000000000001';
UPDATE deposits SET status = 'returned', returned_amount = 12000, returned_at = now() WHERE id = 'b3000000-0000-0000-0000-000000000001';
-- The January adjustment left GHS 500 of RCP-T-1 unallocated: the tenant's credit still has to be accounted for.
SELECT test_assert(app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000002') @> ARRAY['open_balance'],
  'ADR-009: a tenant''s unallocated credit blocks erasure even after the lease closes');
INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000006', 500, current_date);
UPDATE deposits SET status = 'returned', returned_amount = 12000, returned_at = now() WHERE id = 'b3000000-0000-0000-0000-000000000001';
UPDATE leases SET ended_reason = 'Tenant Ama relocated to Kumasi',
                  custom_fields = '{"guarantor": "Kofi"}'::jsonb
 WHERE id = 'ab000000-0000-0000-0000-000000000001';
SELECT test_assert(
  app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000002') = ARRAY['tenancy_record'],
  'ADR-009: once closed and settled, only the retention period blocks');
SELECT test_assert(app.jurisdiction_rule('GH', 'tenancy_records_retention_years', current_date) IS NULL,
  'ADR-009: no jurisdiction has a tenancy retention period before the legal review (#20)');
SELECT test_expect_error($$SELECT app.erase_contact('a5000000-0000-0000-0000-000000000002')$$, '23514',
  'ADR-009: with no retention rule, tenancy records are kept and erasure is refused');
RESET ROLE;
INSERT INTO jurisdiction_settings (jurisdiction_code, key, value, effective_from, source_reference)
VALUES ('GH', 'tenancy_records_retention_years', '6', current_date - 1, 'Test value only');
SET LOCAL ROLE estatepro_app;
SELECT test_assert('tenancy_record' = ANY (app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000002')),
  'ADR-009: within the retention period the records are kept');
RESET ROLE;
UPDATE jurisdiction_settings SET value = '0' WHERE jurisdiction_code = 'GH' AND key = 'tenancy_records_retention_years';
SET LOCAL ROLE estatepro_app;
SELECT test_assert(cardinality(app.contact_erasure_blockers('a5000000-0000-0000-0000-000000000002')) = 0,
  'ADR-009: after the retention period the tenant can be erased');

-- Free text that names the tenant, across the lettings records.
INSERT INTO audit_logs (company_id, actor_type, action, entity_type, entity_id, changes) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'user', 'payment.bounced', 'payment', 'ad000000-0000-0000-0000-000000000002',
   '{"status_reason": {"old": null, "new": "Ama''s cheque bounced"}}');
SELECT test_assert(
  (SELECT (r ->> 'contacts')::int = 1 AND (r ->> 'payments')::int = 2 AND (r ->> 'leases')::int = 1
     FROM (SELECT app.erase_contact('a5000000-0000-0000-0000-000000000002') AS r) x),
  'ADR-009: the erasure reports the lettings records it anonymised');
SELECT test_assert(
  (SELECT ended_reason = '[Erased]' AND custom_fields = '{}'::jsonb AND status = 'closed' AND rent_amount = 6000
          AND start_date = '2026-01-01' AND move_out_date = '2026-10-31' FROM leases WHERE id = 'ab000000-0000-0000-0000-000000000001'),
  'ADR-009: lease free text is erased; terms, dates and status are kept');
SELECT test_assert(
  (SELECT bool_and(notes IS NULL OR notes = '[Erased]') AND bool_and(instrument_number IS NULL AND instrument_bank IS NULL)
          AND bool_and(status_reason IS NULL OR status_reason = '[Erased]') AND sum(amount) = 12000
     FROM payments WHERE payer_contact_id = 'a5000000-0000-0000-0000-000000000002'),
  'ADR-009: receipts lose notes and cheque details; amounts are kept');
SELECT test_assert(
  (SELECT reference = '[Erased]' AND description = '[Erased]' AND amount = 100 AND txn_date = '2026-03-02' FROM payment_import_lines WHERE id = 'ae300000-0000-0000-0000-000000000001'),
  'ADR-009 (L3): bank-file line texts of the person are erased; date and amount are kept');
SELECT test_assert(
  (SELECT closed_reason = '[Erased]' AND total_amount = 100 AND status = 'cancelled' FROM payment_plans WHERE id = 'ae400000-0000-0000-0000-000000000001'),
  'ADR-009 (L3): payment-plan reasons are erased; terms are kept');
SELECT test_assert(
  (SELECT reason = '[Erased]' AND amount = -500 FROM rent_charge_adjustments WHERE id = 'af000000-0000-0000-0000-000000000001'),
  'ADR-009: adjustment reasons are erased; amounts are kept');
SELECT test_assert(
  (SELECT waived_reason = '[Erased]' AND total_amount = 6000 FROM rent_charges WHERE id = 'ac000000-0000-0000-0000-000000000002'),
  'ADR-009: waiver reasons are erased; amounts are kept');
SELECT test_assert(
  (SELECT description = '[Erased]' AND amount = 200 FROM deposit_deductions WHERE deposit_id = 'b3000000-0000-0000-0000-000000000001'),
  'ADR-009: deposit deduction descriptions are erased; amounts are kept');
SELECT test_assert(
  (SELECT cancelled_reason = '[Erased]' AND status = 'cancelled' FROM inspections WHERE id = 'b4000000-0000-0000-0000-000000000001')
  AND (SELECT notes = '[Erased]' AND item = 'Door' FROM inspection_items WHERE id = 'b4100000-0000-0000-0000-000000000001')
  AND (SELECT caption = '[Erased]' FROM inspection_item_documents WHERE inspection_item_id = 'b4100000-0000-0000-0000-000000000001'),
  'ADR-009 (L4): inspection cancellation reasons, item notes and photo captions are erased; the record is kept');
SELECT test_assert(
  (SELECT changes = '{"status_reason": {"old": null, "new": "[Erased]"}}'::jsonb FROM audit_logs WHERE action = 'payment.bounced'),
  'ADR-009: audit rows about the receipts lose the text');
SELECT test_assert(
  (SELECT sum(amount) = 6000 FROM payment_allocations WHERE payment_id IN ('ad000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000002')),
  'ADR-009: allocations and their reversals are untouched');

-- ------------------------------------------------- row-level security catalogue
RESET ROLE;
SELECT test_assert(
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
                 AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped)
                 AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))),
  'every table with a company_id has row-level security enabled and a policy (partitions are reached through their parent)');
SELECT test_assert(
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relispartition AND NOT c.relrowsecurity),
  'partitions have row-level security enabled too, so direct access to one finds nothing');
SELECT test_assert(
  (SELECT array_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolbypassrls AND NOT rolsuper AND rolname LIKE 'estatepro%')
    = ARRAY['estatepro_auth', 'estatepro_platform']::name[],
  'only the platform and auth roles bypass row-level security; the runtime role does not');

ROLLBACK;
\echo '17_money_integrity_p7_0: all assertions passed'
