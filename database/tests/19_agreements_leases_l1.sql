-- =============================================================================
-- L1: management agreements, leases, documents, letting deals (migration 0036).
-- Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- A signed document whose scan is still pending.
INSERT INTO documents (id, company_id, title, document_type_code, category) VALUES
  ('d1100000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Signed agreement', 'management_agreement', 'legal'),
  ('d1100000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Signed lease', 'lease', 'legal');
INSERT INTO document_versions (id, company_id, document_id, version_no, storage_key, file_name, mime_type, size_bytes, checksum_sha256, is_signed) VALUES
  ('d1200000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001', 1,
   'a0000000-0000-0000-0000-000000000001/documents/t1', 'agreement.pdf', 'application/pdf', 1000, decode(repeat('ab', 32), 'hex'), true),
  ('d1200000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000002', 1,
   'a0000000-0000-0000-0000-000000000001/documents/t2', 'lease.pdf', 'application/pdf', 1000, decode(repeat('cd', 32), 'hex'), true);
UPDATE documents SET current_version_id = 'd1200000-0000-0000-0000-000000000001' WHERE id = 'd1100000-0000-0000-0000-000000000001';
UPDATE documents SET current_version_id = 'd1200000-0000-0000-0000-000000000002' WHERE id = 'd1100000-0000-0000-0000-000000000002';

-- ------------------------------------------------- documents: the scan result is final
SELECT test_assert(NOT app.document_is_clean('a0000000-0000-0000-0000-000000000001', 'd1100000-0000-0000-0000-000000000001'),
  'a document is not usable while its scan is pending');
UPDATE document_versions SET scan_status = 'infected' WHERE id = 'd1200000-0000-0000-0000-000000000002';
SELECT test_assert((SELECT scanned_at IS NOT NULL FROM document_versions WHERE id = 'd1200000-0000-0000-0000-000000000002'),
  'the scan time is recorded with the result');
SELECT test_expect_error($$UPDATE document_versions SET scan_status = 'clean' WHERE id = 'd1200000-0000-0000-0000-000000000002'$$,
  '23514', 'an infected file never becomes clean');
SELECT test_expect_error($$UPDATE document_versions SET storage_key = 'elsewhere' WHERE id = 'd1200000-0000-0000-0000-000000000001'$$,
  '42501', 'a document version never changes (only its scan result is recorded)');
SELECT test_expect_error($$DELETE FROM document_versions WHERE id = 'd1200000-0000-0000-0000-000000000001'$$,
  '42501', 'a document version is never deleted');

-- ------------------------------------------------- management agreements
INSERT INTO management_agreements (id, company_id, reference, landlord_contact_id, property_id, unit_id, service_level, currency_code,
                                   fee_basis, fee_percent, start_date) VALUES
  ('d1300000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'MGT-L1-1', 'a5000000-0000-0000-0000-000000000001',
   'a7000000-0000-0000-0000-000000000001', NULL, 'fully_managed', 'GHS', 'percent_of_rent_collected', 10, '2026-01-01'),
  ('d1300000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'MGT-L1-2', 'a5000000-0000-0000-0000-000000000001',
   'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002', 'rent_collection', 'GHS', 'percent_of_rent_due', 8, '2026-01-01');
UPDATE management_agreements SET fee_percent = 9 WHERE id = 'd1300000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT fee_percent = 9 FROM management_agreements WHERE id = 'd1300000-0000-0000-0000-000000000001'), 'a draft agreement can be edited');
SELECT test_expect_error(
  $$INSERT INTO management_agreements (company_id, reference, landlord_contact_id, property_id, unit_id, service_level, currency_code, fee_basis, fee_percent, start_date)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'MGT-L1-X', 'a5000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001',
            'b8000000-0000-0000-0000-000000000001', 'let_only', 'GHS', 'one_off', NULL, '2026-01-01')$$,
  '23514', 'an agreement''s unit belongs to its property (and to this company)');
UPDATE management_agreements SET document_id = 'd1100000-0000-0000-0000-000000000001' WHERE id = 'd1300000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE management_agreements SET status = 'active' WHERE id = 'd1300000-0000-0000-0000-000000000001'$$,
  '23514', 'an agreement is not activated with a document that has not passed the scan');
UPDATE document_versions SET scan_status = 'clean' WHERE id = 'd1200000-0000-0000-0000-000000000001';
UPDATE management_agreements SET status = 'active' WHERE id = 'd1300000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT status = 'active' FROM management_agreements WHERE id = 'd1300000-0000-0000-0000-000000000001'),
  'an agreement with a clean signed document is activated');
SELECT test_expect_error($$UPDATE management_agreements SET status = 'active' WHERE id = 'd1300000-0000-0000-0000-000000000002'$$,
  '23514', 'one live agreement per unit: the whole-property agreement already covers Flat 2B');
SELECT test_expect_error($$UPDATE management_agreements SET fee_percent = 12 WHERE id = 'd1300000-0000-0000-0000-000000000001'$$,
  '42501', 'an active agreement keeps its fee terms');
SELECT test_expect_error($$UPDATE management_agreements SET landlord_contact_id = 'a5000000-0000-0000-0000-000000000003' WHERE id = 'd1300000-0000-0000-0000-000000000001'$$,
  '42501', 'an active agreement keeps its landlord');
UPDATE management_agreements SET expense_approval_limit = 2000, payout_day = 5 WHERE id = 'd1300000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT expense_approval_limit = 2000 FROM management_agreements WHERE id = 'd1300000-0000-0000-0000-000000000001'),
  'the approval limit and payout day remain editable');
SELECT test_expect_error($$UPDATE management_agreements SET status = 'draft' WHERE id = 'd1300000-0000-0000-0000-000000000001'$$,
  '23514', 'an active agreement does not return to draft');
SELECT test_expect_error($$DELETE FROM management_agreements WHERE id = 'd1300000-0000-0000-0000-000000000001'$$,
  '42501', 'an active agreement is not deleted');
UPDATE management_agreements SET status = 'suspended' WHERE id = 'd1300000-0000-0000-0000-000000000001';
UPDATE management_agreements SET status = 'active' WHERE id = 'd1300000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT status = 'active' FROM management_agreements WHERE id = 'd1300000-0000-0000-0000-000000000001'),
  'a suspended agreement is reactivated');
DELETE FROM management_agreements WHERE id = 'd1300000-0000-0000-0000-000000000002';
SELECT test_assert(NOT EXISTS (SELECT 1 FROM management_agreements WHERE id = 'd1300000-0000-0000-0000-000000000002'), 'a draft agreement is deleted');

-- ------------------------------------------------- leases: life cycle
INSERT INTO leases (id, company_id, reference, unit_id, management_agreement_id, jurisdiction_code, lease_type, start_date, end_date,
                    currency_code, rent_amount, rent_frequency, rent_due_day, advance_periods) VALUES
  ('d1400000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'LSE-L1-1', 'a8000000-0000-0000-0000-000000000002',
   'd1300000-0000-0000-0000-000000000001', 'GH', 'fixed_term', '2027-01-01', '2027-12-31', 'GHS', 4500, 'monthly', 1, 6);
SELECT test_expect_error(
  $$INSERT INTO leases (company_id, reference, unit_id, management_agreement_id, jurisdiction_code, lease_type, start_date, end_date, currency_code, rent_amount, rent_frequency)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-L1-X', 'a8000000-0000-0000-0000-000000000002', 'ab000000-0000-0000-0000-000000000001',
            'GH', 'fixed_term', '2027-01-01', '2027-12-31', 'GHS', 4500, 'monthly')$$,
  '23514', 'a lease names an agreement that exists and covers its unit');
INSERT INTO lease_parties (company_id, lease_id, contact_id, party_role, is_primary) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'd1400000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'tenant', true);
UPDATE lease_parties SET liability_share = 100 WHERE lease_id = 'd1400000-0000-0000-0000-000000000001';
UPDATE leases SET rent_amount = 4600 WHERE id = 'd1400000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT rent_amount = 4600 FROM leases WHERE id = 'd1400000-0000-0000-0000-000000000001'), 'a draft lease can be edited');
SELECT test_expect_error($$UPDATE leases SET status = 'active', signed_at = now() WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '23514', 'a draft lease goes through signature before it is active');
UPDATE leases SET status = 'pending_signature' WHERE id = 'd1400000-0000-0000-0000-000000000001';
UPDATE leases SET document_id = 'd1100000-0000-0000-0000-000000000002', signed_at = now() WHERE id = 'd1400000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE leases SET status = 'active' WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '23514', 'a lease is not activated with a document that failed the scan');
-- Replace the document with a clean one (the infected version stays as it was).
UPDATE leases SET document_id = 'd1100000-0000-0000-0000-000000000001' WHERE id = 'd1400000-0000-0000-0000-000000000001';
UPDATE management_agreements SET status = 'suspended' WHERE id = 'd1300000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE leases SET status = 'active' WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '23514', 'a lease is not activated under a suspended agreement');
UPDATE management_agreements SET status = 'active' WHERE id = 'd1300000-0000-0000-0000-000000000001';
UPDATE leases SET status = 'active', move_in_date = '2027-01-01' WHERE id = 'd1400000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT status = 'active' FROM leases WHERE id = 'd1400000-0000-0000-0000-000000000001'),
  'a signed lease under an active agreement is activated');

-- Terms are fixed once active.
SELECT test_expect_error($$UPDATE leases SET rent_amount = 100 WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '42501', 'an active lease keeps its rent (changed only through a rent review)');
SELECT test_expect_error($$UPDATE leases SET start_date = '2027-02-01' WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '42501', 'an active lease keeps its start date');
SELECT test_expect_error($$UPDATE leases SET unit_id = 'a8000000-0000-0000-0000-000000000001' WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '42501', 'an active lease keeps its unit');
SELECT test_expect_error($$UPDATE leases SET end_date = '2028-12-31' WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '42501', 'an active lease''s end date moves only with notice (a longer term is a renewal)');
SELECT test_expect_error($$UPDATE leases SET status = 'draft' WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '23514', 'an active lease does not return to draft');
SELECT test_expect_error($$UPDATE leases SET status = 'cancelled' WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '23514', 'an active lease is not cancelled (it is ended)');
SELECT test_expect_error($$DELETE FROM leases WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '42501', 'an active lease is not deleted');
UPDATE leases SET renewal_status = 'pending_decision', next_rent_review_date = '2027-10-01' WHERE id = 'd1400000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT renewal_status = 'pending_decision' FROM leases WHERE id = 'd1400000-0000-0000-0000-000000000001'),
  'renewal status and the next review date remain editable');

-- Parties are fixed once active; portal access is not.
SELECT test_expect_error($$DELETE FROM lease_parties WHERE lease_id = 'd1400000-0000-0000-0000-000000000001'$$,
  '42501', 'a party is not removed from an active lease');
SELECT test_expect_error($$UPDATE lease_parties SET liability_share = 50 WHERE lease_id = 'd1400000-0000-0000-0000-000000000001'$$,
  '42501', 'a party''s share on an active lease is fixed');
UPDATE lease_parties SET portal_access = false WHERE lease_id = 'd1400000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT NOT portal_access FROM lease_parties WHERE lease_id = 'd1400000-0000-0000-0000-000000000001'),
  'portal access can be turned off on an active lease');

-- An agreement with a live lease cannot end; the lease names an agreement that covers its unit.
SELECT test_expect_error($$UPDATE management_agreements SET status = 'ended', end_date = '2027-06-30' WHERE id = 'd1300000-0000-0000-0000-000000000001'$$,
  '23514', 'an agreement with a live lease cannot end');
INSERT INTO properties (id, reference, name, company_id, property_type_id, office_id, address_id, jurisdiction_code, timezone)
SELECT 'd1500000-0000-0000-0000-000000000001', 'PRP-L1-1', 'Other building', company_id, property_type_id, office_id, address_id, jurisdiction_code, timezone
  FROM properties WHERE id = 'a7000000-0000-0000-0000-000000000001';
INSERT INTO units (id, company_id, property_id, reference, unit_label, bedrooms)
VALUES ('d1600000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'd1500000-0000-0000-0000-000000000001', 'UNT-L1-1', 'Flat 9', 1);
SELECT test_expect_error(
  $$INSERT INTO leases (company_id, reference, unit_id, management_agreement_id, jurisdiction_code, lease_type, start_date, end_date, currency_code, rent_amount, rent_frequency)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-L1-Y', 'd1600000-0000-0000-0000-000000000001', 'd1300000-0000-0000-0000-000000000001',
            'GH', 'fixed_term', '2027-01-01', '2027-12-31', 'GHS', 3000, 'monthly')$$,
  '23514', 'a lease names only an agreement that covers its unit');

-- Pending signature can go back to draft, and draft or pending can be cancelled; cancelled is final.
INSERT INTO leases (id, company_id, reference, unit_id, jurisdiction_code, lease_type, start_date, end_date, currency_code, rent_amount, rent_frequency)
VALUES ('d1400000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'LSE-L1-2', 'd1600000-0000-0000-0000-000000000001',
        'GH', 'fixed_term', '2027-01-01', '2027-12-31', 'GHS', 3000, 'monthly');
UPDATE leases SET status = 'pending_signature' WHERE id = 'd1400000-0000-0000-0000-000000000002';
UPDATE leases SET status = 'draft' WHERE id = 'd1400000-0000-0000-0000-000000000002';
UPDATE leases SET status = 'cancelled' WHERE id = 'd1400000-0000-0000-0000-000000000002';
SELECT test_expect_error($$UPDATE leases SET status = 'draft' WHERE id = 'd1400000-0000-0000-0000-000000000002'$$,
  '23514', 'a cancelled lease is final');
SELECT test_expect_error($$DELETE FROM leases WHERE id = 'd1400000-0000-0000-0000-000000000002'$$,
  '42501', 'a cancelled lease is kept');
-- A draft lease can be deleted.
INSERT INTO leases (id, company_id, reference, unit_id, jurisdiction_code, lease_type, start_date, end_date, currency_code, rent_amount, rent_frequency)
VALUES ('d1400000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'LSE-L1-3', 'd1600000-0000-0000-0000-000000000001',
        'GH', 'fixed_term', '2028-01-01', '2028-12-31', 'GHS', 3000, 'monthly');
DELETE FROM leases WHERE id = 'd1400000-0000-0000-0000-000000000003';
SELECT test_assert(NOT EXISTS (SELECT 1 FROM leases WHERE id = 'd1400000-0000-0000-0000-000000000003'), 'a draft lease is deleted');

-- Later transitions (L4 uses them): active → notice given (the end date may move then) → ended → closed.
UPDATE leases SET status = 'notice_given', notice_given_on = '2027-06-01', notice_given_by = 'tenant', end_date = '2027-08-31'
 WHERE id = 'd1400000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT end_date = '2027-08-31' FROM leases WHERE id = 'd1400000-0000-0000-0000-000000000001'),
  'notice sets the end date');
SELECT test_expect_error($$UPDATE leases SET status = 'closed' WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '23514', 'a lease under notice ends before it closes');
UPDATE leases SET status = 'ended', move_out_date = '2027-08-31' WHERE id = 'd1400000-0000-0000-0000-000000000001';
UPDATE leases SET status = 'closed' WHERE id = 'd1400000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE leases SET status = 'active' WHERE id = 'd1400000-0000-0000-0000-000000000001'$$,
  '23514', 'a closed lease is final');
UPDATE management_agreements SET status = 'ended', end_date = '2027-09-30' WHERE id = 'd1300000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT status = 'ended' FROM management_agreements WHERE id = 'd1300000-0000-0000-0000-000000000001'),
  'an agreement whose leases have closed can end');
SELECT test_expect_error($$UPDATE management_agreements SET status = 'active' WHERE id = 'd1300000-0000-0000-0000-000000000001'$$,
  '23514', 'an ended agreement is final');
SELECT test_expect_error(
  $$INSERT INTO leases (company_id, reference, unit_id, management_agreement_id, jurisdiction_code, lease_type, start_date, end_date, currency_code, rent_amount, rent_frequency)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-L1-Z', 'a8000000-0000-0000-0000-000000000002', 'd1300000-0000-0000-0000-000000000001',
            'GH', 'fixed_term', '2028-01-01', '2028-12-31', 'GHS', 3000, 'monthly')$$,
  '23514', 'a new lease does not name an ended agreement');

-- ------------------------------------------------- letting deals follow their lease (P7-D4)
INSERT INTO contacts (id, company_id, contact_type, display_name) VALUES
  ('d1700000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'person', 'Kojo Applicant');
INSERT INTO deals (id, company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code, listing_id, unit_id)
VALUES ('d1800000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'DEA-L1-1', 'letting',
        (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'negotiation'),
        'd1700000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002',
        'GHS', 'a9000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001');
INSERT INTO offers (id, company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, rent_frequency, recorded_by)
VALUES ('d1900000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'd1800000-0000-0000-0000-000000000001',
        'a9000000-0000-0000-0000-000000000001', 'd1700000-0000-0000-0000-000000000001', 'from_buyer', 'GHS', 6000, 'monthly',
        'a4000000-0000-0000-0000-000000000002');
SELECT set_config('app.pipeline_action', 'on', true);
UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = 'd1900000-0000-0000-0000-000000000001';
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'offer_accepted')
 WHERE id = 'd1800000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'contract')
     WHERE id = 'd1800000-0000-0000-0000-000000000001'$$,
  '23514', 'a letting deal moves to lease signing only once a lease is drawn up from it');
INSERT INTO leases (id, company_id, reference, unit_id, listing_id, deal_id, jurisdiction_code, lease_type, start_date, end_date, currency_code, rent_amount, rent_frequency)
VALUES ('d1400000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000001', 'LSE-L1-4', 'a8000000-0000-0000-0000-000000000001',
        'a9000000-0000-0000-0000-000000000001', 'd1800000-0000-0000-0000-000000000001', 'GH', 'fixed_term', '2027-01-01', '2027-12-31', 'GHS', 6000, 'monthly');
SELECT test_expect_error(
  $$INSERT INTO leases (company_id, reference, unit_id, deal_id, jurisdiction_code, lease_type, start_date, end_date, currency_code, rent_amount, rent_frequency)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'LSE-L1-W', 'a8000000-0000-0000-0000-000000000001', 'd1800000-0000-0000-0000-000000000001',
            'GH', 'fixed_term', '2028-01-01', '2028-12-31', 'GHS', 6000, 'monthly')$$,
  '23505', 'a deal has one lease (a cancelled one aside)');
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'contract')
 WHERE id = 'd1800000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT stage_class = 'contract' FROM deals WHERE id = 'd1800000-0000-0000-0000-000000000001'),
  'with its draft lease the deal is at lease signing');
UPDATE deal_milestones SET completed_at = now(), completed_by = 'a4000000-0000-0000-0000-000000000002'
 WHERE deal_id = 'd1800000-0000-0000-0000-000000000001' AND is_required;
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'closed_won'), closed_at = now()
     WHERE id = 'd1800000-0000-0000-0000-000000000001'$$,
  '23514', 'a letting deal is won only once its lease is active');
UPDATE leases SET status = 'pending_signature' WHERE id = 'd1400000-0000-0000-0000-000000000004';
UPDATE leases SET status = 'active', signed_at = now(), document_id = 'd1100000-0000-0000-0000-000000000001'
 WHERE id = 'd1400000-0000-0000-0000-000000000004';
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'closed_won'), closed_at = now()
 WHERE id = 'd1800000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT stage_class = 'closed_won' AND status = 'won' FROM deals WHERE id = 'd1800000-0000-0000-0000-000000000001'),
  'once the lease is active, the letting deal is won (let agreed)');
SELECT set_config('app.pipeline_action', '', true);

-- ------------------------------------------------- isolation
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) = 0 FROM leases WHERE reference LIKE 'LSE-L1-%'), 'another company sees none of these leases');
SELECT test_assert((SELECT count(*) = 0 FROM management_agreements WHERE reference LIKE 'MGT-L1-%'), 'nor the agreements');
SELECT test_assert((SELECT count(*) = 0 FROM document_upload_sessions), 'nor any document upload');
SELECT test_expect_error(
  $$INSERT INTO document_upload_sessions (company_id, entity_type, entity_id, title, document_type_code, category, file_name, declared_mime, declared_size, sha256, storage_key, expires_at, created_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'lease', 'd1400000-0000-0000-0000-000000000001', 'x', 'lease', 'legal', 'x.pdf', 'application/pdf', 10,
            decode(repeat('ab', 32), 'hex'), 'k', now() + interval '1 hour', 'a4000000-0000-0000-0000-000000000003')$$,
  '42501', 'another company cannot start an upload for this company');

ROLLBACK;
\echo '19_agreements_leases_l1: all assertions passed'
