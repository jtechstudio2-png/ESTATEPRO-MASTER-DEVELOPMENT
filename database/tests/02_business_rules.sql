-- =============================================================================
-- Business-rule tests: constraints and triggers that protect money, leases,
-- scheduling and the pipeline. Runs as estatepro_app in company A; rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000003', true);

-- ---------------------------------------------------------------- references
SELECT test_assert(app.next_reference('a0000000-0000-0000-0000-000000000001', 'lease', '2026-05-01') = 'LSE-2026-000001',
                   'first lease reference of 2026');
SELECT test_assert(app.next_reference('a0000000-0000-0000-0000-000000000001', 'lease', '2026-05-02') = 'LSE-2026-000002',
                   'references are sequential');
SELECT test_assert(app.next_reference('a0000000-0000-0000-0000-000000000001', 'lease', '2027-01-02') = 'LSE-2027-000001',
                   'references reset each year');

-- ------------------------------------------------------- optimistic locking
UPDATE contacts SET notes = 'called' WHERE id = 'a5000000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT version FROM contacts WHERE id = 'a5000000-0000-0000-0000-000000000001') = 2,
                   'update increments version');

-- ----------------------------------------------------------------- listings
SELECT test_expect_error(
  $$INSERT INTO listings (company_id, reference, unit_id, listing_type, currency_code, price,
                         agent_membership_id, office_id, default_locale_code, title)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LST-T1', 'a8000000-0000-0000-0000-000000000002', 'rent', 'GHS', 100,
            'a4000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', 'en-GH', 'No frequency')$$,
  '23514', 'rental listing requires rent frequency');
SELECT test_expect_error(
  $$INSERT INTO listings (company_id, reference, unit_id, listing_type, status, currency_code, price, rent_frequency,
                         agent_membership_id, office_id, default_locale_code, title)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LST-T2', 'a8000000-0000-0000-0000-000000000001', 'rent', 'draft', 'GHS', 100,
            'monthly', 'a4000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', 'en-GH', 'Duplicate')$$,
  '23505', 'only one open rental listing per unit');
SELECT test_expect_error(
  $$UPDATE listings SET status = 'rented' WHERE id = 'a9000000-0000-0000-0000-000000000002'$$,
  '23514', 'a sale listing cannot be marked rented');

-- ------------------------------------------------------------------- leases
SELECT test_expect_error(
  $$INSERT INTO leases (company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date,
                       currency_code, rent_amount, rent_frequency, signed_at)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-T1', 'a8000000-0000-0000-0000-000000000001', 'GH', 'fixed_term',
            'pending_signature', '2026-06-01', '2027-05-31', 'GHS', 6500, 'monthly', NULL)$$,
  '23P01', 'overlapping live leases on one unit are rejected');
SELECT test_expect_error(
  $$INSERT INTO leases (company_id, reference, unit_id, jurisdiction_code, lease_type, status, start_date, end_date,
                       currency_code, rent_amount, rent_frequency)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-T2', 'a8000000-0000-0000-0000-000000000002', 'GH', 'fixed_term',
            'active', '2026-06-01', '2027-05-31', 'GHS', 2000, 'monthly')$$,
  '23514', 'a lease cannot be active without a signature date');
-- A renewal starting the day after the current lease ends is allowed.
INSERT INTO leases (company_id, reference, unit_id, previous_lease_id, jurisdiction_code, lease_type, status,
                    start_date, end_date, currency_code, rent_amount, rent_frequency)
VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-T3', 'a8000000-0000-0000-0000-000000000001',
        'ab000000-0000-0000-0000-000000000001', 'GH', 'fixed_term', 'pending_signature', '2027-01-01', '2027-12-31',
        'GHS', 6600, 'monthly');
SELECT test_assert(true, 'back-to-back renewal lease accepted');

SELECT test_expect_error(
  $$INSERT INTO rent_charges (company_id, lease_id, charge_type, description, period_start, period_end, due_date, currency_code, amount)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'rent', 'dup',
            '2026-01-01', '2026-01-31', '2026-01-01', 'GHS', 6000)$$,
  '23505', 're-running the rent job cannot duplicate a period charge');

-- ------------------------------------------------- payments and allocations
INSERT INTO payments (id, company_id, reference, payer_contact_id, lease_id, bank_account_id, method_code,
                      currency_code, amount, received_on, instrument_number, instrument_date, status)
VALUES ('ad000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'RCT-T1',
        'a5000000-0000-0000-0000-000000000002', 'ab000000-0000-0000-0000-000000000001',
        'aa000000-0000-0000-0000-000000000001', 'post_dated_cheque', 'GHS', 9000, '2025-12-20', '000123', '2026-01-01', 'pending');

SELECT test_expect_error(
  $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001',
            'ac000000-0000-0000-0000-000000000001', 6000, '2026-01-02')$$,
  '23514', 'a post-dated cheque cannot be allocated before it clears');

UPDATE payments SET status = 'cleared', value_date = '2026-01-02' WHERE id = 'ad000000-0000-0000-0000-000000000001';

INSERT INTO payment_allocations (id, company_id, payment_id, rent_charge_id, amount, allocated_on)
VALUES ('ae000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
        'ad000000-0000-0000-0000-000000000001', 'ac000000-0000-0000-0000-000000000001', 6000, '2026-01-02');
SELECT test_assert((SELECT outstanding_amount FROM rent_charge_balances
                     WHERE rent_charge_id = 'ac000000-0000-0000-0000-000000000001') = 0, 'January fully paid');

SELECT test_expect_error(
  $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001',
            'ac000000-0000-0000-0000-000000000002', 3500, '2026-01-02')$$,
  '23514', 'cannot allocate more than the unallocated payment amount');
SELECT test_expect_error(
  $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001',
            'ac000000-0000-0000-0000-000000000001', 1, '2026-01-02')$$,
  '23514', 'cannot over-pay a charge');

INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, allocated_on)
VALUES ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001',
        'ac000000-0000-0000-0000-000000000002', 2000, '2026-02-02');
SELECT test_assert((SELECT outstanding_amount FROM rent_charge_balances
                     WHERE rent_charge_id = 'ac000000-0000-0000-0000-000000000002') = 4000, 'February part-paid, 4000 outstanding');

SELECT test_expect_error(
  $$UPDATE payment_allocations SET amount = 1 WHERE id = 'ae000000-0000-0000-0000-000000000001'$$,
  '42501', 'allocations are append-only');
SELECT test_expect_error(
  $$INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, reversal_of_id, allocated_on)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001',
            'ac000000-0000-0000-0000-000000000001', -100, 'ae000000-0000-0000-0000-000000000001', '2026-01-03')$$,
  '23514', 'a reversal must negate the whole allocation');
INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, reversal_of_id, allocated_on)
VALUES ('a0000000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001',
        'ac000000-0000-0000-0000-000000000001', -6000, 'ae000000-0000-0000-0000-000000000001', '2026-01-03');
SELECT test_assert((SELECT outstanding_amount FROM rent_charge_balances
                     WHERE rent_charge_id = 'ac000000-0000-0000-0000-000000000001') = 6000, 'reversal restores the balance');

-- Arrears ageing as of 15 March 2026: Jan 6000 (73 days), Feb 4000 (42 days).
SELECT test_assert((SELECT days_61_90 FROM app.lease_arrears('2026-03-15')
                     WHERE lease_id = 'ab000000-0000-0000-0000-000000000001') = 6000, 'arrears 61-90 bucket = 6000');
SELECT test_assert((SELECT days_31_60 FROM app.lease_arrears('2026-03-15')
                     WHERE lease_id = 'ab000000-0000-0000-0000-000000000001') = 4000, 'arrears 31-60 bucket = 4000');
SELECT test_assert((SELECT total_outstanding FROM app.lease_arrears('2026-03-15')
                     WHERE lease_id = 'ab000000-0000-0000-0000-000000000001') = 10000, 'total arrears = 10000');

-- ---------------------------------------------- finance and period locking
INSERT INTO finance_transactions (id, company_id, reference, txn_type, direction, txn_date, currency_code, amount,
                                  description, status, posted_at)
VALUES ('af000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'FIN-T1', 'management_fee',
        'in', '2026-01-31', 'GHS', 600, 'Management fee January', 'posted', now());
SELECT test_expect_error(
  $$UPDATE finance_transactions SET amount = 1 WHERE id = 'af000000-0000-0000-0000-000000000001'$$,
  '42501', 'posted transactions cannot be edited');
SELECT test_expect_error(
  $$DELETE FROM finance_transactions WHERE id = 'af000000-0000-0000-0000-000000000001'$$,
  '42501', 'posted transactions cannot be deleted');
UPDATE finance_transactions SET status = 'reversed', reversed_at = now() WHERE id = 'af000000-0000-0000-0000-000000000001';
SELECT test_assert(true, 'posted transaction can be marked reversed');

INSERT INTO ledger_entries (id, company_id, ledger_type, contact_id, entry_date, currency_code, credit, description)
VALUES ('b0e00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'landlord',
        'a5000000-0000-0000-0000-000000000001', '2026-01-02', 'GHS', 6000, 'Rent received Jan');
INSERT INTO ledger_entries (company_id, ledger_type, contact_id, entry_date, currency_code, debit, description)
VALUES ('a0000000-0000-0000-0000-000000000001', 'landlord', 'a5000000-0000-0000-0000-000000000001', '2026-01-31', 'GHS', 600,
        'Management fee Jan');
SELECT test_assert((SELECT balance FROM ledger_balances WHERE contact_id = 'a5000000-0000-0000-0000-000000000001') = 5400,
                   'landlord ledger balance = 5400');
SELECT test_expect_error(
  $$UPDATE ledger_entries SET credit = 1 WHERE id = 'b0e00000-0000-0000-0000-000000000001'$$,
  '42501', 'ledger entries are append-only');
SELECT test_expect_error(
  $$INSERT INTO ledger_entries (company_id, ledger_type, contact_id, entry_date, currency_code, debit, credit, description)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'landlord', 'a5000000-0000-0000-0000-000000000001', '2026-01-31', 'GHS',
            10, 10, 'both sides')$$,
  '23514', 'a ledger entry is either a debit or a credit');

INSERT INTO financial_periods (company_id, period_start, period_end, status, locked_by, locked_at)
VALUES ('a0000000-0000-0000-0000-000000000001', '2026-01-01', '2026-01-31', 'locked',
        'a4000000-0000-0000-0000-000000000003', now());
SELECT test_expect_error(
  $$INSERT INTO finance_transactions (company_id, reference, txn_type, direction, txn_date, currency_code, amount, description)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'FIN-T2', 'property_expense', 'out', '2026-01-15', 'GHS', 50, 'late entry')$$,
  '42501', 'no entries in a locked period');
SELECT test_expect_error(
  $$INSERT INTO ledger_entries (company_id, ledger_type, contact_id, entry_date, currency_code, debit, description)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'landlord', 'a5000000-0000-0000-0000-000000000001', '2026-01-20', 'GHS', 5, 'late')$$,
  '42501', 'no ledger entries in a locked period');
INSERT INTO finance_transactions (company_id, reference, txn_type, direction, txn_date, currency_code, amount, description)
VALUES ('a0000000-0000-0000-0000-000000000001', 'FIN-T3', 'property_expense', 'out', '2026-02-01', 'GHS', 50, 'open period');
SELECT test_assert(true, 'entries in an open period are accepted');

-- ------------------------------------------------- separation of duties
INSERT INTO contact_payment_accounts (id, company_id, contact_id, account_type, account_name, provider_name,
                                      country_code, currency_code, account_number_encrypted, last4)
VALUES ('b1a00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001',
        'mobile_money', 'Kofi Owusu', 'MTN MoMo', 'GH', 'GHS', '\x00', '4567');
SELECT test_expect_error(
  $$INSERT INTO payouts (company_id, reference, payee_contact_id, payee_type, from_account_id, to_account_id, currency_code,
                        amount, status, requested_by, approved_by, approved_at)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'PAY-T1', 'a5000000-0000-0000-0000-000000000001', 'landlord',
            'aa000000-0000-0000-0000-000000000001', 'b1a00000-0000-0000-0000-000000000001', 'GHS', 5400, 'approved',
            'a4000000-0000-0000-0000-000000000003', 'a4000000-0000-0000-0000-000000000003', now())$$,
  '23514', 'requester cannot approve their own payout');

-- ------------------------------------------------------------ sales pipeline
INSERT INTO deals (id, company_id, reference, deal_type, stage_id, listing_id, unit_id, primary_contact_id, office_id,
                   owner_membership_id, currency_code, expected_value)
VALUES ('b2d00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'DEA-T1', 'sale',
        (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'viewing'),
        'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002',
        'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001',
        'a4000000-0000-0000-0000-000000000002', 'GHS', 450000);
SELECT test_assert((SELECT stage_class = 'viewing' AND status = 'open' FROM deals WHERE id = 'b2d00000-0000-0000-0000-000000000001'),
                   'deal stage_class and status derived from stage');
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'contract')
     WHERE id = 'b2d00000-0000-0000-0000-000000000001'$$,
  '23514', 'a sale deal cannot use a letting stage');
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'closed_lost')
     WHERE id = 'b2d00000-0000-0000-0000-000000000001'$$,
  '23514', 'closing a deal as lost requires closed_at and a reason');

INSERT INTO offers (id, company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, recorded_by)
VALUES ('b3f00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'b2d00000-0000-0000-0000-000000000001',
        'a9000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000003', 'from_buyer', 'GHS', 420000,
        'a4000000-0000-0000-0000-000000000002');
SELECT test_expect_error(
  $$UPDATE offers SET amount = 430000 WHERE id = 'b3f00000-0000-0000-0000-000000000001'$$,
  '42501', 'offer amounts are immutable');
UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = 'b3f00000-0000-0000-0000-000000000001';
SELECT test_assert(true, 'offer status can change');

SELECT test_expect_error(
  $$INSERT INTO commissions (company_id, deal_id, membership_id, currency_code, basis_amount, split_percent, amount,
                            calculation, status, approved_by, approved_at)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'b2d00000-0000-0000-0000-000000000001',
            'a4000000-0000-0000-0000-000000000002', 'GHS', 22500, 100, 5625, '{}', 'approved',
            'a4000000-0000-0000-0000-000000000002', now())$$,
  '23514', 'an agent cannot approve their own commission');

-- ------------------------------------------------------------------ viewings
INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002',
        'a4000000-0000-0000-0000-000000000002', '2026-03-10 10:00+00', '2026-03-10 10:30+00', 'Africa/Accra');
SELECT test_expect_error(
  $$INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001',
            'a4000000-0000-0000-0000-000000000002', '2026-03-10 10:15+00', '2026-03-10 10:45+00', 'Africa/Accra')$$,
  '23P01', 'an agent cannot be double-booked');

-- --------------------------------------------------------------- maintenance
SELECT test_expect_error(
  $$INSERT INTO maintenance_requests (company_id, reference, property_id, unit_id, source, reported_by_contact_id,
                                     category_code, title, description, sla_policy_id, priority_code, status,
                                     approval_status, response_due_at, resolution_due_at)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'WO-T1', 'a7000000-0000-0000-0000-000000000001',
            'a8000000-0000-0000-0000-000000000001', 'tenant_portal', 'a5000000-0000-0000-0000-000000000002',
            'plumbing', 'Leak', 'Kitchen tap leaking', (SELECT id FROM sla_policies WHERE priority_code = 'routine' AND company_id IS NULL),
            'routine', 'in_progress', 'pending', now() + interval '3 days', now() + interval '14 days')$$,
  '23514', 'work cannot start while landlord approval is pending');

-- ------------------------------------------------------------------ documents
INSERT INTO documents (id, company_id, title, document_type_code, category)
VALUES ('b4c00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Lease LSE-2026-000001', 'lease', 'legal');
INSERT INTO document_versions (id, company_id, document_id, version_no, storage_key, file_name, mime_type, size_bytes, checksum_sha256)
VALUES ('b4d00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'b4c00000-0000-0000-0000-000000000001', 1,
        'a0000000-0000-0000-0000-000000000001/documents/lease-v1.pdf', 'lease.pdf', 'application/pdf', 120000, '\x01');
UPDATE document_versions SET scan_status = 'clean', scanned_at = now() WHERE id = 'b4d00000-0000-0000-0000-000000000001';
SELECT test_assert(true, 'scan result can be recorded on a version');
SELECT test_expect_error(
  $$UPDATE document_versions SET storage_key = 'swapped.pdf' WHERE id = 'b4d00000-0000-0000-0000-000000000001'$$,
  '42501', 'an uploaded version cannot be swapped');
SELECT test_expect_error(
  $$INSERT INTO document_versions (company_id, document_id, version_no, storage_key, file_name, mime_type, size_bytes, checksum_sha256)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'b4c00000-0000-0000-0000-000000000001', 1, 'k', 'f', 'application/pdf', 1, '\x02')$$,
  '23505', 'version numbers are unique per document');

ROLLBACK;
\echo '02_business_rules: all assertions passed'
