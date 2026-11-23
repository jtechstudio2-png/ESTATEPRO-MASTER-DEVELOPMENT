-- =============================================================================
-- L2: rent schedule, charges and rent reviews (migration 0037). Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- Leases of this suite (imported live, so signed):
--   e1: Flat 2B, 15 Jan – 31 Dec 2026, monthly on the 1st, pro-rated, GHS 3,000, one period in advance.
--   e2: Flat 1A, 1 Jan – 10 Feb 2027, weekly, GHS 700, nothing in advance.
--   e3: Flat 2B, from 31 Jan 2027, quarterly on the 31st, periodic, GHS 9,000.
INSERT INTO leases (id, company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date, currency_code,
                    rent_amount, rent_frequency, rent_due_day, advance_periods, prorate_first_period, signed_at, created_by) VALUES
  ('e1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'LSE-L2-1', 'a8000000-0000-0000-0000-000000000002',
   'GH', 'fixed_term', 'active', '2026-01-15', '2026-12-31', 'GHS', 3000, 'monthly', 1, 1, true, now(), 'a4000000-0000-0000-0000-000000000001'),
  ('e1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'LSE-L2-2', 'a8000000-0000-0000-0000-000000000001',
   'GH', 'fixed_term', 'active', '2027-01-01', '2027-02-10', 'GHS', 700, 'weekly', NULL, 0, true, now(), 'a4000000-0000-0000-0000-000000000001'),
  ('e1000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'LSE-L2-3', 'a8000000-0000-0000-0000-000000000002',
   'GH', 'periodic', 'periodic', '2027-01-31', NULL, 'GHS', 9000, 'quarterly', 31, 1, true, now(), 'a4000000-0000-0000-0000-000000000001');

-- ------------------------------------------------- the schedule start
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.lease_rent_due('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-12-31')),
  'a lease with no schedule start is not charged (imported leases wait for a person)');
SELECT test_expect_error($$UPDATE leases SET rent_schedule_from = '2026-01-01' WHERE id = 'e1000000-0000-0000-0000-000000000001'$$,
  '23514', 'the schedule starts within the lease dates');
UPDATE leases SET rent_schedule_from = '2026-01-15' WHERE id = 'e1000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE leases SET rent_schedule_from = '2026-02-01' WHERE id = 'e1000000-0000-0000-0000-000000000001'$$,
  '42501', 'the schedule start is fixed once set');
INSERT INTO leases (id, company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date, currency_code,
                    rent_amount, rent_frequency, rent_due_day) VALUES
  ('e1000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001', 'LSE-L2-9', 'a8000000-0000-0000-0000-000000000002',
   'GH', 'fixed_term', 'draft', '2029-01-01', '2029-12-31', 'GHS', 1000, 'monthly', 1);
SELECT test_expect_error($$UPDATE leases SET rent_schedule_from = '2029-01-01' WHERE id = 'e1000000-0000-0000-0000-000000000009'$$,
  '23514', 'a draft lease has no rent schedule');

-- ------------------------------------------------- periods: pro-rated first period, advance, due dates
SELECT test_assert((SELECT array_agg(format('%s|%s|%s|%s', period_start, period_end, due_date, amount) ORDER BY period_start)
                      FROM app.lease_rent_due('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-01-20'))
                   = ARRAY['2026-01-15|2026-01-31|2026-01-15|1645.16', '2026-02-01|2026-02-28|2026-01-15|3000.00'],
  'the first period runs to the day before the due day, pro-rated by actual days (17/31) and rounded to the currency; it and one advance period are due at the start');
SELECT test_assert((SELECT count(*) = 2 FROM app.post_rent_charges('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-01-20', 'a4000000-0000-0000-0000-000000000001')),
  'the charges due by the date are posted');
SELECT test_assert((SELECT count(*) = 0 FROM app.post_rent_charges('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-01-20', 'a4000000-0000-0000-0000-000000000001')),
  'running the schedule again posts nothing (idempotent per period)');
SELECT test_assert((SELECT bool_and(status = 'posted' AND source = 'schedule' AND posted_at IS NOT NULL AND description LIKE 'Rent 2026-0%')
                      FROM rent_charges WHERE lease_id = 'e1000000-0000-0000-0000-000000000001'),
  'scheduled rent is posted, with its period in the description');
SELECT test_assert((SELECT array_agg(format('%s|%s', due_date, amount)) FROM app.post_rent_charges('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-03-01', 'a4000000-0000-0000-0000-000000000001'))
                   = ARRAY['2026-03-01|3000.0000'],
  'later periods are due on their first day');
UPDATE rent_charges SET status = 'cancelled' WHERE lease_id = 'e1000000-0000-0000-0000-000000000001' AND period_start = '2026-03-01';
SELECT test_assert((SELECT count(*) = 0 FROM app.post_rent_charges('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-03-01', 'a4000000-0000-0000-0000-000000000001')),
  'a period whose charge was cancelled is not charged again');

UPDATE leases SET rent_schedule_from = '2027-01-01' WHERE id = 'e1000000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT array_agg(format('%s|%s|%s', period_start, period_end, amount) ORDER BY period_start)
                      FROM app.lease_rent_due('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000002', '2027-12-31'))
                   = ARRAY['2027-01-01|2027-01-07|700.00', '2027-01-08|2027-01-14|700.00', '2027-01-15|2027-01-21|700.00',
                           '2027-01-22|2027-01-28|700.00', '2027-01-29|2027-02-04|700.00', '2027-02-05|2027-02-10|600.00'],
  'weekly periods run from the start date; the last is cut at the end date and pro-rated (6/7); nothing after the end');
SELECT test_assert((SELECT bool_and(due_date = period_start) FROM app.lease_rent_due('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000002', '2027-12-31')),
  'with no advance periods, every period is due on its first day');

UPDATE leases SET rent_schedule_from = '2027-01-31' WHERE id = 'e1000000-0000-0000-0000-000000000003';
SELECT test_assert((SELECT array_agg(format('%s|%s', period_start, period_end) ORDER BY period_start)
                      FROM app.lease_rent_due('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000003', '2027-08-01'))
                   = ARRAY['2027-01-31|2027-04-29', '2027-04-30|2027-07-30', '2027-07-31|2027-10-30'],
  'a due day past the month''s end falls on its last day (31 Jan, 30 Apr, 31 Jul); a periodic lease has no end');

-- ------------------------------------------------- charges: where they may be raised
SELECT test_expect_error($$INSERT INTO rent_charges (company_id, lease_id, charge_type, description, due_date, currency_code, amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000009', 'service_charge', 'Service', '2029-01-01', 'GHS', 100)$$,
  '23514', 'no charge on a draft lease');
SELECT test_expect_error($$INSERT INTO rent_charges (company_id, lease_id, charge_type, description, due_date, currency_code, amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'service_charge', 'Service', '2026-04-01', 'AED', 100)$$,
  '23514', 'a charge is in the lease''s currency');
INSERT INTO rent_charges (id, company_id, lease_id, charge_type, description, period_start, period_end, due_date, currency_code, amount, status, source) VALUES
  ('e2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001',
   'service_charge', 'Service charge Q2', '2026-04-01', '2026-06-30', '2026-05-01', 'GHS', 900, 'scheduled', 'manual');
SELECT test_assert((SELECT posted_at IS NULL FROM rent_charges WHERE id = 'e2000000-0000-0000-0000-000000000001'), 'a scheduled charge is not yet posted');
UPDATE rent_charges SET status = 'posted' WHERE id = 'e2000000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT posted_at IS NOT NULL FROM rent_charges WHERE id = 'e2000000-0000-0000-0000-000000000001'), 'posting records the time');
SELECT test_expect_error($$INSERT INTO rent_charges (company_id, lease_id, charge_type, description, due_date, currency_code, amount, status)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'fee', 'Fee', '2026-05-01', 'GHS', 10, 'waived')$$,
  '23514', 'a charge starts scheduled or posted');

-- Agreements: the agency collects only under an active rent-collection or fully managed agreement.
INSERT INTO management_agreements (id, company_id, reference, landlord_contact_id, property_id, unit_id, service_level, currency_code,
                                   fee_basis, fee_percent, fee_fixed_amount, start_date) VALUES
  ('e3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'MGT-L2-1', 'a5000000-0000-0000-0000-000000000001',
   'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002', 'rent_collection', 'GHS', 'percent_of_rent_collected', 10, NULL, '2026-01-01'),
  ('e3000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'MGT-L2-2', 'a5000000-0000-0000-0000-000000000001',
   'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001', 'let_only', 'GHS', 'one_off', NULL, 500, '2026-01-01');
UPDATE management_agreements SET status = 'active' WHERE id IN ('e3000000-0000-0000-0000-000000000001', 'e3000000-0000-0000-0000-000000000002');
INSERT INTO leases (id, company_id, reference, unit_id, management_agreement_id, jurisdiction_code, lease_type, status, start_date, end_date,
                    currency_code, rent_amount, rent_frequency, rent_due_day, signed_at, rent_schedule_from) VALUES
  ('e1000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'LSE-L2-4', 'a8000000-0000-0000-0000-000000000002',
   'e3000000-0000-0000-0000-000000000001', 'GH', 'fixed_term', 'active', '2027-01-01', '2027-01-30', 'GHS', 2000, 'monthly', 1, now(), '2027-01-01'),
  ('e1000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000001', 'LSE-L2-5', 'a8000000-0000-0000-0000-000000000001',
   'e3000000-0000-0000-0000-000000000002', 'GH', 'fixed_term', 'active', '2027-03-01', '2027-12-31', 'GHS', 2000, 'monthly', 1, now(), '2027-03-01');
SELECT test_assert((SELECT count(*) = 1 FROM app.lease_rent_due('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000004', '2028-01-01')),
  'rent is scheduled under an active rent-collection agreement');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.lease_rent_due('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000005', '2028-06-01')),
  'no rent is scheduled under a let-only agreement (the agency does not collect)');
SELECT test_expect_error($$INSERT INTO rent_charges (company_id, lease_id, charge_type, description, due_date, currency_code, amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000005', 'fee', 'Fee', '2028-02-01', 'GHS', 50)$$,
  '23514', 'no charge is raised under a let-only agreement');
UPDATE management_agreements SET status = 'suspended' WHERE id = 'e3000000-0000-0000-0000-000000000001';
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.lease_rent_due('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000004', '2028-06-01')),
  'no rent is scheduled while the agreement is suspended');
SELECT test_expect_error($$INSERT INTO rent_charges (company_id, lease_id, charge_type, description, due_date, currency_code, amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000004', 'fee', 'Fee', '2028-02-01', 'GHS', 50)$$,
  '23514', 'no charge is raised under a suspended agreement');

-- ------------------------------------------------- tax from the configured components
INSERT INTO tax_codes (id, company_id, jurisdiction_code, code, name) VALUES
  ('e4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'GH', 'l2_test', 'Test tax');
INSERT INTO tax_code_components (tax_code_id, name, rate_percent, is_compound, sequence, effective_from, effective_to) VALUES
  ('e4000000-0000-0000-0000-000000000001', 'Base', 5, false, 1, '2026-01-01', NULL),
  ('e4000000-0000-0000-0000-000000000001', 'On top', 10, true, 2, '2026-01-01', NULL),
  ('e4000000-0000-0000-0000-000000000001', 'Expired', 50, false, 3, '2020-01-01', '2025-12-31');
SELECT test_assert(app.tax_amount('e4000000-0000-0000-0000-000000000001', 1000, '2026-06-01', 2) = 155,
  'tax: simple components on the amount, compound ones on the amount plus earlier tax, only those in force (5% + 10% of 1,050)');
SELECT test_assert(app.tax_amount(NULL, 1000, '2026-06-01', 2) = 0, 'no tax code, no tax');

-- ------------------------------------------------- rent reviews
INSERT INTO rent_reviews (id, company_id, lease_id, review_date, method, old_amount) VALUES
  ('e5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-02-15', 'negotiated', 3000);
SELECT test_expect_error($$INSERT INTO rent_reviews (company_id, lease_id, review_date, method, old_amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-06-01', 'market', 3000)$$,
  '23505', 'one open review per lease');
SELECT test_expect_error($$INSERT INTO rent_reviews (company_id, lease_id, review_date, method, old_amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000009', '2029-06-01', 'market', 1000)$$,
  '23514', 'no review on a draft lease');
SELECT test_expect_error($$UPDATE rent_reviews SET status = 'proposed' WHERE id = 'e5000000-0000-0000-0000-000000000001'$$,
  '23514', 'a proposed review names the proposed rent');
SELECT test_expect_error($$UPDATE rent_reviews SET status = 'applied', agreed_amount = 3100, effective_from = '2026-04-01' WHERE id = 'e5000000-0000-0000-0000-000000000001'$$,
  '23514', 'a review is agreed before it is applied');
UPDATE rent_reviews SET status = 'proposed', proposed_amount = 3300 WHERE id = 'e5000000-0000-0000-0000-000000000001';
UPDATE rent_reviews SET status = 'disputed' WHERE id = 'e5000000-0000-0000-0000-000000000001';
UPDATE rent_reviews SET status = 'agreed', agreed_amount = 3200, effective_from = '2026-02-01' WHERE id = 'e5000000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE rent_reviews SET effective_from = '2026-04-01' WHERE id = 'e5000000-0000-0000-0000-000000000001'$$,
  '42501', 'agreed terms are fixed');
SELECT test_expect_error($$UPDATE rent_reviews SET status = 'applied' WHERE id = 'e5000000-0000-0000-0000-000000000001'$$,
  '23514', 'a review is not applied from a date rent is already charged for (February is posted)');
UPDATE rent_reviews SET status = 'cancelled' WHERE id = 'e5000000-0000-0000-0000-000000000001';
INSERT INTO rent_reviews (id, company_id, lease_id, review_date, method, old_amount, proposed_amount, status) VALUES
  ('e5000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-02-15', 'negotiated', 3000, 3300, 'proposed');
UPDATE rent_reviews SET status = 'agreed', agreed_amount = 3200, effective_from = '2026-04-01' WHERE id = 'e5000000-0000-0000-0000-000000000002';
UPDATE rent_reviews SET status = 'applied' WHERE id = 'e5000000-0000-0000-0000-000000000002';
SELECT test_assert(app.rent_in_force('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-03-31') = 3000
               AND app.rent_in_force('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-04-01') = 3200,
  'the applied rent is in force from its effective date');
SELECT test_assert((SELECT array_agg(format('%s|%s', period_start, amount)) FROM app.post_rent_charges('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-04-01', 'a4000000-0000-0000-0000-000000000001'))
                   = ARRAY['2026-04-01|3200.0000'],
  'later charges use the reviewed rent (March, cancelled, is not charged again)');
SELECT test_assert((SELECT rent_amount = 3000 FROM leases WHERE id = 'e1000000-0000-0000-0000-000000000001'), 'the lease keeps its original rent; the review records the change');
SELECT test_expect_error($$UPDATE rent_reviews SET agreed_amount = 3500 WHERE id = 'e5000000-0000-0000-0000-000000000002'$$,
  '42501', 'an applied review is final');
SELECT test_expect_error($$UPDATE rent_reviews SET notes = 'changed' WHERE id = 'e5000000-0000-0000-0000-000000000001'$$,
  '42501', 'a cancelled review is final');
SELECT test_expect_error($$DELETE FROM rent_reviews WHERE id = 'e5000000-0000-0000-0000-000000000002'$$,
  '42501', 'reviews are never deleted');
INSERT INTO rent_reviews (id, company_id, lease_id, review_date, method, old_amount) VALUES
  ('e5000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-10-01', 'market', 3200);
UPDATE rent_reviews SET due_notified_at = now() WHERE id = 'e5000000-0000-0000-0000-000000000003';
SELECT test_expect_error($$UPDATE rent_reviews SET due_notified_at = now() + interval '1 day' WHERE id = 'e5000000-0000-0000-0000-000000000003'$$,
  '42501', 'the review-due notice is recorded once');
SELECT test_expect_error($$UPDATE rent_reviews SET old_amount = 1 WHERE id = 'e5000000-0000-0000-0000-000000000003'$$,
  '42501', 'a review''s starting rent is fixed');

-- ------------------------------------------------- locked periods
INSERT INTO financial_periods (company_id, period_start, period_end, status, locked_by, locked_at) VALUES
  ('a0000000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', 'locked', 'a4000000-0000-0000-0000-000000000001', now());
SELECT test_expect_error($$INSERT INTO rent_charges (company_id, lease_id, charge_type, description, due_date, currency_code, amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'fee', 'Late key', '2026-01-20', 'GHS', 50)$$,
  '42501', 'no charge is dated in a locked period');
SELECT test_expect_error($$UPDATE rent_charges SET status = 'cancelled' WHERE lease_id = 'e1000000-0000-0000-0000-000000000001' AND period_start = '2026-01-15'$$,
  '42501', 'a charge in a locked period is not waived or cancelled');

-- ------------------------------------------------- isolation
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.lease_rent_due('a0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', '2026-12-31')),
  'another company sees no rent due for this lease');
SELECT test_assert((SELECT count(*) = 0 FROM rent_reviews WHERE lease_id = 'e1000000-0000-0000-0000-000000000001'), 'another company sees none of its reviews');

ROLLBACK;
