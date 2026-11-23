-- =============================================================================
-- L4: notice and ending, renewal chain, deposits and deductions, inspections
-- and their photos (migration 0039). Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- Fixture lease LSE-2026-000001 (active, fixed term to 2026-12-31, GHS, Flat 1A, Ghana).
-- Flat 2B: a lease of 2025 (L4-A) and a periodic lease from 2027 (L4-P).
INSERT INTO leases (id, company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date,
                    currency_code, rent_amount, rent_frequency, rent_due_day, signed_at, deposit_amount) VALUES
  ('e1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'LSE-L4-A', 'a8000000-0000-0000-0000-000000000002',
   'GH', 'fixed_term', 'active', '2025-01-01', '2025-12-31', 'GHS', 3000, 'monthly', 1, '2024-12-20', 3000),
  ('e1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'LSE-L4-P', 'a8000000-0000-0000-0000-000000000002',
   'GH', 'periodic', 'active', '2027-01-01', NULL, 'GHS', 3000, 'monthly', 1, '2026-11-01', NULL);

-- ------------------------------------------------- ending
SELECT test_expect_error($$UPDATE leases SET status = 'ended', move_out_date = '2027-02-01' WHERE id = 'e1000000-0000-0000-0000-000000000002'$$,
  '23514', 'a lease without an end date does not end: notice gives the date');
UPDATE leases SET status = 'notice_given', notice_given_on = '2027-01-31', notice_given_by = 'tenant', end_date = '2027-03-31'
 WHERE id = 'e1000000-0000-0000-0000-000000000002';
UPDATE leases SET status = 'ended', move_out_date = '2027-03-30' WHERE id = 'e1000000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT status = 'ended' AND end_date = '2027-03-31' FROM leases WHERE id = 'e1000000-0000-0000-0000-000000000002'),
  'after notice the lease ends on the date the notice gives');
SELECT test_expect_error($$UPDATE leases SET move_out_date = '2027-03-31' WHERE id = 'e1000000-0000-0000-0000-000000000002'$$,
  '42501', 'the move-out date is kept once the lease has ended');

-- ------------------------------------------------- renewal chain
INSERT INTO leases (id, company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date,
                    currency_code, rent_amount, rent_frequency, previous_lease_id) VALUES
  ('e1000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'LSE-L4-R', 'a8000000-0000-0000-0000-000000000002',
   'GH', 'fixed_term', 'draft', '2026-01-01', '2026-12-31', 'GHS', 3200, 'monthly', 'e1000000-0000-0000-0000-000000000001');
SELECT test_assert(true, 'a renewal follows the lease it renews');
SELECT test_expect_error($$INSERT INTO leases (company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date, currency_code, rent_amount, rent_frequency, previous_lease_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-L4-R2', 'a8000000-0000-0000-0000-000000000002', 'GH', 'fixed_term', 'draft', '2026-01-01', '2026-06-30', 'GHS', 3200, 'monthly', 'e1000000-0000-0000-0000-000000000001')$$,
  '23505', 'a lease is renewed once (a cancelled renewal frees it)');
UPDATE leases SET status = 'cancelled', ended_reason = 'Terms changed' WHERE id = 'e1000000-0000-0000-0000-000000000003';
SELECT test_expect_error($$INSERT INTO leases (company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date, currency_code, rent_amount, rent_frequency, previous_lease_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-L4-R3', 'a8000000-0000-0000-0000-000000000002', 'GH', 'fixed_term', 'draft', '2025-12-01', '2026-06-30', 'GHS', 3200, 'monthly', 'e1000000-0000-0000-0000-000000000001')$$,
  '23514', 'a renewal starts after the lease it renews ends');
SELECT test_expect_error($$INSERT INTO leases (company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date, currency_code, rent_amount, rent_frequency, previous_lease_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-L4-R4', 'a8000000-0000-0000-0000-000000000001', 'GH', 'fixed_term', 'draft', '2027-01-01', '2027-06-30', 'GHS', 3200, 'monthly', 'e1000000-0000-0000-0000-000000000001')$$,
  '23514', 'a renewal is of the same unit');
INSERT INTO leases (id, company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date,
                    currency_code, rent_amount, rent_frequency, previous_lease_id) VALUES
  ('e1000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'LSE-L4-R5', 'a8000000-0000-0000-0000-000000000002',
   'GH', 'fixed_term', 'draft', '2026-01-01', '2026-12-31', 'GHS', 3200, 'monthly', 'e1000000-0000-0000-0000-000000000001');
SELECT test_assert(true, 'after a cancelled renewal the lease can be renewed again');

-- ------------------------------------------------- deposits: registration
SELECT test_expect_error($$INSERT INTO deposits (company_id, lease_id, currency_code, amount, holder_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'USD', 12000, 'agent')$$,
  '23514', 'a deposit is in its lease''s currency');
SELECT test_expect_error($$INSERT INTO deposits (company_id, lease_id, currency_code, amount, holder_type, status, returned_at) VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 12000, 'agent', 'returned', now())$$,
  '23514', 'a deposit is registered as expected, held or protected');
SELECT test_expect_error($$INSERT INTO deposits (company_id, lease_id, currency_code, amount, holder_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000003', 'GHS', 3000, 'agent')$$,
  '23514', 'no deposit is registered on a cancelled lease');
INSERT INTO deposits (id, company_id, lease_id, currency_code, amount, holder_type, holding_account_id, created_by) VALUES
  ('e2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'GHS', 12000, 'agent',
   'aa000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error($$UPDATE deposits SET status = 'held' WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '23514', 'a held deposit records the date it was received');

-- ------------------------------------------------- deposits: received through the deposit charge
INSERT INTO rent_charges (id, company_id, lease_id, charge_type, description, due_date, currency_code, amount, source) VALUES
  ('e3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001',
   'deposit', 'Deposit', '2026-01-01', 'GHS', 12000, 'manual');
SELECT test_expect_error($$UPDATE deposits SET status = 'held', received_on = '2026-01-02' WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '23514', 'a deposit the agency collects is held once its charge is paid');
RESET ROLE;
INSERT INTO jurisdiction_settings (jurisdiction_code, key, value, effective_from, source_reference)
VALUES ('GH', 'deposit_protection_deadline_days', '30', '2025-01-01', 'Test value only');
SET LOCAL ROLE estatepro_app;
INSERT INTO payments (id, company_id, reference, payer_contact_id, lease_id, bank_account_id, method_code, currency_code, amount, received_on, status, value_date) VALUES
  ('e4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'RCP-L4-1', 'a5000000-0000-0000-0000-000000000002',
   'ab000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'bank_transfer', 'GHS', 12000, '2026-01-03', 'pending', NULL);
UPDATE payments SET status = 'cleared', value_date = '2026-01-03' WHERE id = 'e4000000-0000-0000-0000-000000000001';
INSERT INTO payment_allocations (id, company_id, payment_id, rent_charge_id, amount, allocated_on) VALUES
  ('e5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001', 7000, '2026-01-03');
SELECT test_assert((SELECT status = 'expected' FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000001'),
  'a deposit part-paid is still expected');
INSERT INTO payment_allocations (id, company_id, payment_id, rent_charge_id, amount, allocated_on) VALUES
  ('e5000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001', 5000, '2026-01-04');
SELECT test_assert((SELECT status = 'held' AND received_on = '2026-01-04' AND received_payment_id = 'e4000000-0000-0000-0000-000000000001'
                      FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000001'),
  'paying the deposit charge in full makes the deposit held, with the receipt and its date');
SELECT test_assert((SELECT protection_deadline = '2026-02-03' AND protection_deadline_source = 'jurisdiction' FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000001'),
  'P7-D11: a reviewed protection period gives the deadline from the date received');
INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, reversal_of_id, allocated_on) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001', -5000, 'e5000000-0000-0000-0000-000000000002', '2026-01-05');
SELECT test_assert((SELECT status = 'expected' AND received_on IS NULL AND received_payment_id IS NULL AND protection_deadline IS NULL
                      FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000001'),
  'reversing the payment before protection sends the deposit back to expected');
INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000001', 5000, '2026-01-06');
SELECT test_assert((SELECT status = 'held' AND received_on = '2026-01-06' FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000001'),
  'paid again, the deposit is held again');

-- ------------------------------------------------- deposits: protection and fixed details
SELECT test_expect_error($$UPDATE deposits SET status = 'protected', protected_at = now() WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '23514', 'a protected deposit records its scheme reference');
UPDATE deposits SET status = 'protected', protected_at = '2026-01-20', scheme_name = 'Rent Control Department', scheme_reference = 'RCD-123'
 WHERE id = 'e2000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE deposits SET scheme_reference = 'RCD-999' WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '42501', 'the protection is fixed once recorded');
SELECT test_expect_error($$UPDATE deposits SET received_on = '2026-01-01' WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '42501', 'the receipt of a deposit is fixed once recorded');
SELECT test_expect_error($$UPDATE deposits SET amount = 11000 WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '42501', 'the amount of a deposit is fixed');
SELECT test_expect_error($$UPDATE deposits SET returned_amount = 100 WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '23514', 'the amount returned is recorded with the return');
SELECT test_expect_error($$UPDATE deposits SET status = 'held' WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '23514', 'a protected deposit does not go back to held');
INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, reversal_of_id, allocated_on)
  SELECT company_id, payment_id, rent_charge_id, -amount, id, '2026-01-21' FROM payment_allocations WHERE id = 'e5000000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT status = 'protected' AND received_on = '2026-01-06' FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000001'),
  'a reversal after protection leaves the protected deposit (the charge shows as owed again)');

-- ------------------------------------------------- deposit deductions
INSERT INTO deposit_deductions (id, company_id, deposit_id, reason_code, description, amount, created_by) VALUES
  ('e6000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'cleaning', 'Oven and carpets', 500, 'a4000000-0000-0000-0000-000000000001'),
  ('e6000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'damage', 'Broken window', 1000, 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error($$INSERT INTO deposit_deductions (company_id, deposit_id, reason_code, description, amount, status, settled_amount) VALUES ('a0000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'cleaning', 'X', 10, 'agreed', 10)$$,
  '23514', 'a deduction starts as proposed');
SELECT test_expect_error($$INSERT INTO deposit_deductions (company_id, deposit_id, reason_code, description, amount) VALUES ('a0000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'damage', 'Everything', 10501)$$,
  '23514', 'deductions never take more than the deposit');
SELECT test_expect_error($$UPDATE deposit_deductions SET status = 'agreed', settled_amount = 400 WHERE id = 'e6000000-0000-0000-0000-000000000001'$$,
  '23514', 'an agreed deduction settles at its amount');
SELECT test_expect_error($$UPDATE deposit_deductions SET status = 'adjudicated', settled_amount = 400 WHERE id = 'e6000000-0000-0000-0000-000000000001'$$,
  '23514', 'only a disputed deduction is adjudicated');
UPDATE deposit_deductions SET status = 'agreed', settled_amount = 500, decided_at = now(), decided_by = 'a4000000-0000-0000-0000-000000000001'
 WHERE id = 'e6000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE deposit_deductions SET status = 'withdrawn', settled_amount = NULL WHERE id = 'e6000000-0000-0000-0000-000000000001'$$,
  '23514', 'an agreed deduction is final');
UPDATE deposit_deductions SET status = 'disputed' WHERE id = 'e6000000-0000-0000-0000-000000000002';
SELECT test_expect_error($$UPDATE deposit_deductions SET amount = 900 WHERE id = 'e6000000-0000-0000-0000-000000000002'$$,
  '42501', 'the amount claimed is fixed; adjudication settles it');
SELECT test_expect_error($$UPDATE deposit_deductions SET status = 'adjudicated', settled_amount = 1200 WHERE id = 'e6000000-0000-0000-0000-000000000002'$$,
  '23514', 'an adjudicated deduction settles at most at its amount');
UPDATE deposits SET status = 'disputed' WHERE id = 'e2000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE deposits SET status = 'partially_returned', returned_amount = 10500, returned_at = now() WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '23514', 'a disputed deposit is not returned');
UPDATE deposit_deductions SET status = 'adjudicated', settled_amount = 600, decided_at = now() WHERE id = 'e6000000-0000-0000-0000-000000000002';
UPDATE deposits SET status = 'return_pending' WHERE id = 'e2000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$DELETE FROM deposit_deductions WHERE id = 'e6000000-0000-0000-0000-000000000002'$$,
  '42501', 'deductions are never deleted');

-- ------------------------------------------------- deposits: return
SELECT test_expect_error($$UPDATE deposits SET status = 'returned', returned_amount = 12000, returned_at = now() WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '23514', 'the return is the deposit less the settled deductions');
SELECT test_expect_error($$UPDATE deposits SET status = 'partially_returned', returned_amount = 10900 WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '23514', 'a return records when it was made');
UPDATE deposits SET status = 'partially_returned', returned_amount = 10900, returned_at = '2027-01-10' WHERE id = 'e2000000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT returned_amount = 10900 FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000001'),
  'GHS 12,000 less 500 agreed and 600 adjudicated: 10,900 returned');
UPDATE deposits SET status = 'partially_returned', returned_amount = 10900, returned_at = '2027-01-10' WHERE id = 'e2000000-0000-0000-0000-000000000001';
SELECT test_assert(true, 'writing a final deposit unchanged is accepted');
SELECT test_expect_error($$UPDATE deposits SET returned_at = '2027-01-11' WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '23514', 'a returned deposit no longer changes');
SELECT test_expect_error($$INSERT INTO deposit_deductions (company_id, deposit_id, reason_code, description, amount) VALUES ('a0000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'cleaning', 'Late claim', 10)$$,
  '23514', 'no deduction from a returned deposit');
SELECT test_expect_error($$DELETE FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000001'$$,
  '42501', 'deposits are never deleted');

-- ------------------------------------------------- deposits: carried to the renewal
INSERT INTO deposits (id, company_id, lease_id, currency_code, amount, holder_type, status, received_on, protection_deadline, protection_deadline_source) VALUES
  ('e2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'GHS', 3000, 'landlord', 'expected', NULL, NULL, NULL);
UPDATE deposits SET status = 'held', received_on = '2025-01-02' WHERE id = 'e2000000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT status = 'held' AND protection_deadline = '2025-02-01' FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000002'),
  'a deposit the agency does not collect is held from the date a person records');
SELECT test_expect_error($$UPDATE deposits SET lease_id = 'e1000000-0000-0000-0000-000000000002' WHERE id = 'e2000000-0000-0000-0000-000000000002'$$,
  '23514', 'a deposit moves only to the renewal of its lease');
UPDATE deposits SET lease_id = 'e1000000-0000-0000-0000-000000000004' WHERE id = 'e2000000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT lease_id = 'e1000000-0000-0000-0000-000000000004' AND status = 'held' FROM deposits WHERE id = 'e2000000-0000-0000-0000-000000000002'),
  'a held deposit moves to the renewal of its lease');

-- ------------------------------------------------- inspections
SELECT test_expect_error($$INSERT INTO inspections (company_id, reference, property_id, unit_id, inspection_type, status, completed_at) VALUES ('a0000000-0000-0000-0000-000000000001', 'INS-X', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001', 'periodic', 'completed', now())$$,
  '23514', 'an inspection starts scheduled');
SELECT test_expect_error($$INSERT INTO inspections (company_id, reference, property_id, unit_id, inspection_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'INS-X', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001', 'move_in')$$,
  '23514', 'a move-in inspection is of a lease');
SELECT test_expect_error($$INSERT INTO inspections (company_id, reference, property_id, unit_id, lease_id, inspection_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'INS-X', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002', 'ab000000-0000-0000-0000-000000000001', 'move_out')$$,
  '23514', 'the inspection''s lease is of its unit');
SELECT test_expect_error($$INSERT INTO inspections (company_id, reference, property_id, unit_id, lease_id, inspection_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'INS-X', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000004', 'move_out')$$,
  '23514', 'no move-out inspection of a lease that has not started');
INSERT INTO inspections (id, company_id, reference, property_id, unit_id, lease_id, inspection_type, scheduled_at, inspector_membership_id, created_by) VALUES
  ('e7000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'INS-L4-1', 'a7000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'move_out', '2027-01-02 10:00+00', 'a4000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error($$INSERT INTO inspections (company_id, reference, property_id, unit_id, lease_id, inspection_type) VALUES ('a0000000-0000-0000-0000-000000000001', 'INS-X', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'move_out')$$,
  '23505', 'one move-out inspection per lease');
INSERT INTO inspection_items (id, company_id, inspection_id, area, item, sort_order) VALUES
  ('e8000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000001', 'Kitchen', 'Oven', 1),
  ('e8000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000001', 'Living room', 'Window', 2);
SELECT test_expect_error($$UPDATE inspections SET status = 'completed', completed_at = now(), overall_condition = 'good' WHERE id = 'e7000000-0000-0000-0000-000000000001'$$,
  '23514', 'an inspection is started before it is completed');
UPDATE inspections SET status = 'in_progress', started_at = now() WHERE id = 'e7000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE inspections SET status = 'completed', completed_at = now() WHERE id = 'e7000000-0000-0000-0000-000000000001'$$,
  '23514', 'a completed inspection records the overall condition');
UPDATE inspection_items SET condition_code = 'good' WHERE id = 'e8000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE inspections SET status = 'completed', completed_at = now(), overall_condition = 'good' WHERE id = 'e7000000-0000-0000-0000-000000000001'$$,
  '23514', 'a completed inspection records the condition of every item');
UPDATE inspection_items SET condition_code = 'damaged', notes = 'Cracked pane', action_required = true WHERE id = 'e8000000-0000-0000-0000-000000000002';

-- ------------------------------------------------- inspection item photos (W7-S1)
INSERT INTO documents (id, company_id, title, document_type_code, category) VALUES
  ('e9000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Window photo', 'inspection_photo', 'property'),
  ('e9000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Unrelated photo', 'inspection_photo', 'property');
INSERT INTO document_links (company_id, document_id, entity_type, entity_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'e9000000-0000-0000-0000-000000000001', 'inspection', 'e7000000-0000-0000-0000-000000000001');
INSERT INTO inspection_item_documents (company_id, inspection_item_id, document_id, caption, created_by) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000002', 'e9000000-0000-0000-0000-000000000001', 'Crack in the lower pane', 'a4000000-0000-0000-0000-000000000002');
SELECT test_assert(true, 'a photo of the inspection is linked to one of its items');
SELECT test_expect_error($$INSERT INTO inspection_item_documents (company_id, inspection_item_id, document_id) VALUES ('a0000000-0000-0000-0000-000000000001', 'e8000000-0000-0000-0000-000000000001', 'e9000000-0000-0000-0000-000000000002')$$,
  '23514', 'a photo is a document of the inspection');
SELECT test_expect_error($$UPDATE inspection_item_documents SET caption = 'Other' WHERE document_id = 'e9000000-0000-0000-0000-000000000001'$$,
  '42501', 'a photo link is added or removed, not changed');

UPDATE inspections SET status = 'completed', completed_at = now(), overall_condition = 'fair', summary = 'Window to repair' WHERE id = 'e7000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$INSERT INTO inspection_items (company_id, inspection_id, area, item) VALUES ('a0000000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000001', 'Hall', 'Door')$$,
  '23514', 'a completed inspection''s items no longer change');
SELECT test_expect_error($$UPDATE inspection_items SET condition_code = 'good' WHERE id = 'e8000000-0000-0000-0000-000000000002'$$,
  '23514', 'a completed inspection''s conditions are kept');
SELECT test_expect_error($$DELETE FROM inspection_item_documents WHERE document_id = 'e9000000-0000-0000-0000-000000000001'$$,
  '23514', 'a completed inspection''s photos are kept');
SELECT test_expect_error($$UPDATE inspections SET summary = 'All fine' WHERE id = 'e7000000-0000-0000-0000-000000000001'$$,
  '23514', 'a completed inspection is final');
UPDATE inspections SET tenant_signed_at = now() WHERE id = 'e7000000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT tenant_signed_at IS NOT NULL FROM inspections WHERE id = 'e7000000-0000-0000-0000-000000000001'),
  'the tenant''s acknowledgement is added to a completed inspection');
SELECT test_expect_error($$UPDATE inspections SET tenant_signed_at = now() - interval '1 day' WHERE id = 'e7000000-0000-0000-0000-000000000001'$$,
  '23514', 'the acknowledgement is recorded once');
SELECT test_expect_error($$DELETE FROM inspections WHERE id = 'e7000000-0000-0000-0000-000000000001'$$,
  '42501', 'inspections are never deleted');

INSERT INTO inspections (id, company_id, reference, property_id, unit_id, inspection_type) VALUES
  ('e7000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'INS-L4-2', 'a7000000-0000-0000-0000-000000000001',
   'a8000000-0000-0000-0000-000000000001', 'periodic');
SELECT test_expect_error($$UPDATE inspections SET status = 'cancelled' WHERE id = 'e7000000-0000-0000-0000-000000000002'$$,
  '23514', 'a cancelled inspection gives the reason');
UPDATE inspections SET status = 'cancelled', cancelled_reason = 'Tenant away' WHERE id = 'e7000000-0000-0000-0000-000000000002';
SELECT test_expect_error($$UPDATE inspections SET scheduled_at = now() WHERE id = 'e7000000-0000-0000-0000-000000000002'$$,
  '23514', 'a cancelled inspection is final');
SELECT test_expect_error($$UPDATE inspections SET lease_id = 'ab000000-0000-0000-0000-000000000001' WHERE id = 'e7000000-0000-0000-0000-000000000002'$$,
  '42501', 'the lease and unit of an inspection are fixed');

-- ------------------------------------------------- isolation
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) = 0 FROM deposits) AND (SELECT count(*) = 0 FROM deposit_deductions)
               AND (SELECT count(*) = 0 FROM inspections) AND (SELECT count(*) = 0 FROM inspection_items)
               AND (SELECT count(*) = 0 FROM inspection_item_documents),
  'another company sees none of the deposits, deductions, inspections, items or photos');

ROLLBACK;
\echo '22_deposits_inspections_l4: all assertions passed'
