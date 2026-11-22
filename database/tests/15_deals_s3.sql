-- =============================================================================
-- S3: deals (migration 0033, with the deal rules of 0007, 0030 and 0032). Rolled back.
-- Commit-time checks are forced with SET CONSTRAINTS ALL IMMEDIATE inside a block,
-- so each violation is tested on its own and undone.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

INSERT INTO contacts (id, company_id, contact_type, display_name) VALUES
  ('ac330000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'person', 'Ama Buyer'),
  ('ac330000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'person', 'Kwesi Buyer'),
  ('ac330000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'person', 'Esi Applicant');

INSERT INTO deals (id, company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code, listing_id, unit_id)
VALUES ('ac300000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'DEA-S3-1', 'sale',
        (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'lead'),
        'ac330000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002',
        'GHS', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002');

-- ------------------------------------------------- owner history (SAL-05)
SELECT test_assert(
  (SELECT count(*) = 1 AND bool_and(from_membership_id IS NULL AND to_membership_id = 'a4000000-0000-0000-0000-000000000002'
                                    AND assigned_by = 'a4000000-0000-0000-0000-000000000001')
     FROM deal_assignments WHERE deal_id = 'ac300000-0000-0000-0000-000000000001'),
  'creating a deal records its first owner, with the member who did it');
SELECT set_config('app.assignment_note', 'Covering annual leave', true);
UPDATE deals SET owner_membership_id = 'a4000000-0000-0000-0000-000000000003' WHERE id = 'ac300000-0000-0000-0000-000000000001';
SELECT test_assert(
  (SELECT array_agg(coalesce(note, '-') ORDER BY assigned_at, entry_no) FROM deal_assignments WHERE deal_id = 'ac300000-0000-0000-0000-000000000001')
    = ARRAY['-', 'Covering annual leave']
  AND (SELECT from_membership_id = 'a4000000-0000-0000-0000-000000000002' AND to_membership_id = 'a4000000-0000-0000-0000-000000000003'
         FROM deal_assignments WHERE deal_id = 'ac300000-0000-0000-0000-000000000001' ORDER BY assigned_at DESC, entry_no DESC LIMIT 1),
  'reassigning records who had the deal, who has it now, and the note');
SELECT test_assert(coalesce(current_setting('app.assignment_note', true), '') = '', 'an assignment note is used once and cleared');
UPDATE deals SET expected_value = 450000 WHERE id = 'ac300000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT count(*) = 2 FROM deal_assignments WHERE deal_id = 'ac300000-0000-0000-0000-000000000001'),
  'other edits do not add owner history');
SELECT test_expect_error(
  $$INSERT INTO deal_assignments (company_id, deal_id, to_membership_id) VALUES ('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002')$$,
  '42501', 'the application cannot write owner history itself');
SELECT test_expect_error(
  $$UPDATE deal_assignments SET note = 'rewritten' WHERE deal_id = 'ac300000-0000-0000-0000-000000000001'$$,
  '42501', 'owner history cannot be rewritten');
SELECT test_expect_error(
  $$DELETE FROM deal_assignments WHERE deal_id = 'ac300000-0000-0000-0000-000000000001'$$,
  '42501', 'owner history cannot be deleted');

-- ------------------------------------------------- stage moves follow the life cycle (§4.3)
SELECT test_expect_error(
  $$INSERT INTO deals (company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'DEA-S3-X', 'sale',
            (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'contract'),
            'ac330000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002', 'GHS')$$,
  '23514', 'a deal starts before "offer accepted"');
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'contract')
     WHERE id = 'ac300000-0000-0000-0000-000000000001'$$,
  '23514', 'a deal does not jump from lead to contract');
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'qualification')
 WHERE id = 'ac300000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'lead')
     WHERE id = 'ac300000-0000-0000-0000-000000000001'$$,
  '23514', 'a qualified deal does not go back to lead');
SELECT test_assert(app.deal_stage_change_allowed('viewing', 'qualification') AND app.deal_stage_change_allowed('offer_accepted', 'negotiation')
                   AND NOT app.deal_stage_change_allowed('negotiation', 'contract') AND NOT app.deal_stage_change_allowed('closed_lost', 'lead'),
  'the life-cycle table: no fit returns to qualification; an accepted offer can be withdrawn; contracts follow an accepted offer; closed is final');

-- ------------------------------------------------- co-agent splits add up to 100 % (checked at commit)
SELECT test_expect_error(
  $q$DO $d$ BEGIN
      INSERT INTO deal_agents (company_id, deal_id, membership_id, agent_role, split_percent) VALUES
        ('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000003', 'lister', 60),
        ('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002', 'co_agent', 30);
      SET CONSTRAINTS ALL IMMEDIATE;
    END $d$$q$,
  '23514', 'agents'' splits that do not add up to 100 % are refused');
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO deal_agents (company_id, deal_id, membership_id, agent_role, split_percent) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000003', 'lister', 60),
  ('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002', 'co_agent', 40);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT test_assert((SELECT sum(split_percent) = 100 FROM deal_agents WHERE deal_id = 'ac300000-0000-0000-0000-000000000001'), 'splits of 60 % and 40 % are kept');
SET CONSTRAINTS ALL DEFERRED;

-- ------------------------------------------------- offer accepted
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'negotiation')
 WHERE id = 'ac300000-0000-0000-0000-000000000001';
INSERT INTO offers (id, company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, recorded_by)
VALUES ('ac310000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001',
        'a9000000-0000-0000-0000-000000000002', 'ac330000-0000-0000-0000-000000000001', 'from_buyer', 'GHS', 440000,
        'a4000000-0000-0000-0000-000000000002');
SELECT set_config('app.pipeline_action', 'on', true);
UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = 'ac310000-0000-0000-0000-000000000001';
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'offer_accepted')
 WHERE id = 'ac300000-0000-0000-0000-000000000001';
UPDATE listings SET status = 'reserved' WHERE id = 'a9000000-0000-0000-0000-000000000002';
SELECT set_config('app.pipeline_action', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT test_assert(true, 'the offer is accepted');
SET CONSTRAINTS ALL DEFERRED;

-- ------------------------------------------------- contracts need verified buyers (P6-D6)
INSERT INTO deal_parties (company_id, deal_id, contact_id, party_role) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001', 'ac330000-0000-0000-0000-000000000002', 'buyer');
SELECT test_assert(app.deal_identity_required('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001'),
  'Ghana requires buyer due diligence for sales (sales_kyc_required, default on)');
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'contract')
     WHERE id = 'ac300000-0000-0000-0000-000000000001'$$,
  '23514', 'contracts are not exchanged while a buyer''s identity is unverified');
INSERT INTO kyc_checks (company_id, contact_id, check_type, status, risk_rating, reviewed_by, reviewed_at, recorded_by) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ac330000-0000-0000-0000-000000000001', 'identity', 'verified', 'low',
   'a4000000-0000-0000-0000-000000000001', now(), 'a4000000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'contract')
     WHERE id = 'ac300000-0000-0000-0000-000000000001'$$,
  '23514', 'every buyer is verified, not only the primary contact');
INSERT INTO kyc_checks (company_id, contact_id, check_type, status, risk_rating, reviewed_by, reviewed_at, recorded_by, expires_on) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ac330000-0000-0000-0000-000000000002', 'identity', 'verified', 'low',
   'a4000000-0000-0000-0000-000000000001', now(), 'a4000000-0000-0000-0000-000000000001', current_date - 1);
SELECT test_assert(NOT app.contact_identity_verified('a0000000-0000-0000-0000-000000000001', 'ac330000-0000-0000-0000-000000000002'),
  'a verified check past its expiry date does not count');
INSERT INTO kyc_checks (company_id, contact_id, check_type, status, risk_rating, reviewed_by, reviewed_at, recorded_by, expires_on) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ac330000-0000-0000-0000-000000000002', 'identity', 'verified', 'medium',
   'a4000000-0000-0000-0000-000000000001', now(), 'a4000000-0000-0000-0000-000000000001', current_date + 365);
SELECT test_assert(app.contact_identity_verified('a0000000-0000-0000-0000-000000000001', 'ac330000-0000-0000-0000-000000000002'),
  'a newer verified check counts');
INSERT INTO kyc_checks (company_id, contact_id, check_type, status, recorded_by) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'ac330000-0000-0000-0000-000000000002', 'address', 'pending', 'a4000000-0000-0000-0000-000000000001');
SELECT test_assert(app.contact_identity_verified('a0000000-0000-0000-0000-000000000001', 'ac330000-0000-0000-0000-000000000002'),
  'a check of another type does not replace the identity check');

-- ------------------------------------------------- the deal stage and its sale agree (checked at commit)
SELECT test_expect_error(
  $q$DO $d$ BEGIN
      UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'contract')
       WHERE id = 'ac300000-0000-0000-0000-000000000001';
      SET CONSTRAINTS ALL IMMEDIATE;
    END $d$$q$,
  '23514', 'a sale deal is at contract stage only with its contracts exchanged');
SET CONSTRAINTS ALL DEFERRED;
SELECT test_expect_error(
  $q$DO $d$ BEGIN
      INSERT INTO sales_transactions (company_id, reference, deal_id, listing_id, unit_id, accepted_offer_id, currency_code, agreed_price)
      VALUES ('a0000000-0000-0000-0000-000000000001', 'SAL-S3-X', 'ac300000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
              'a8000000-0000-0000-0000-000000000002', 'ac310000-0000-0000-0000-000000000001', 'GHS', 440000);
      UPDATE sales_transactions SET status = 'exchanged', contract_signed_on = current_date WHERE reference = 'SAL-S3-X';
      SET CONSTRAINTS ALL IMMEDIATE;
    END $d$$q$,
  '23514', 'exchanged contracts move the deal to contract stage in the same transaction');
SET CONSTRAINTS ALL DEFERRED;

-- Exchange: the sale, the deal and the listing together.
INSERT INTO sales_transactions (id, company_id, reference, deal_id, listing_id, unit_id, accepted_offer_id, currency_code, agreed_price)
VALUES ('ac320000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'SAL-S3-1', 'ac300000-0000-0000-0000-000000000001',
        'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002', 'ac310000-0000-0000-0000-000000000001', 'GHS', 440000);
UPDATE sales_transactions SET status = 'exchanged', contract_signed_on = current_date WHERE id = 'ac320000-0000-0000-0000-000000000001';
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'contract')
 WHERE id = 'ac300000-0000-0000-0000-000000000001';
SELECT set_config('app.pipeline_action', 'on', true);
UPDATE listings SET status = 'under_contract' WHERE id = 'a9000000-0000-0000-0000-000000000002';
SELECT set_config('app.pipeline_action', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT test_assert((SELECT stage_class = 'contract' FROM deals WHERE id = 'ac300000-0000-0000-0000-000000000001'),
  'with verified buyers and exchanged contracts the deal is at contract stage');
SET CONSTRAINTS ALL DEFERRED;

-- ------------------------------------------------- the listing follows the deal (P6-D5)
SELECT test_expect_error(
  $$UPDATE listings SET status = 'withdrawn' WHERE id = 'a9000000-0000-0000-0000-000000000002'$$,
  '23514', 'a listing with exchanged contracts is not withdrawn by hand: the sale falls through first');

-- ------------------------------------------------- completion needs required milestones (P6-D7)
INSERT INTO deal_milestones (id, company_id, deal_id, code, name, sort_order, is_required) VALUES
  ('ac340000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001',
   'title_transfer', 'Title transfer registered', 8, true),
  ('ac340000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001',
   'financing_approved', 'Financing approved', 5, false);
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'closed_won'), closed_at = now()
     WHERE id = 'ac300000-0000-0000-0000-000000000001'$$,
  '23514', 'a deal is not completed while a required milestone is open');
UPDATE deal_milestones SET completed_at = now(), completed_by = 'a4000000-0000-0000-0000-000000000001' WHERE id = 'ac340000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $q$DO $d$ BEGIN
      UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'closed_won'), closed_at = now()
       WHERE id = 'ac300000-0000-0000-0000-000000000001';
      SET CONSTRAINTS ALL IMMEDIATE;
    END $d$$q$,
  '23514', 'a sale deal is won only with its sale completed');
SET CONSTRAINTS ALL DEFERRED;
UPDATE sales_transactions SET status = 'completed', completed_on = current_date WHERE id = 'ac320000-0000-0000-0000-000000000001';
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'closed_won'), closed_at = now()
 WHERE id = 'ac300000-0000-0000-0000-000000000001';
SELECT set_config('app.pipeline_action', 'on', true);
UPDATE listings SET status = 'sold', closed_at = now() WHERE id = 'a9000000-0000-0000-0000-000000000002';
SELECT set_config('app.pipeline_action', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT test_assert((SELECT stage_class = 'closed_won' FROM deals WHERE id = 'ac300000-0000-0000-0000-000000000001'),
  'with its required milestones done (an optional one still open) and the sale completed, the deal is won');
SET CONSTRAINTS ALL DEFERRED;

-- ------------------------------------------------- a closed deal keeps its agents, milestones and owner
SELECT test_expect_error(
  $$UPDATE deal_agents SET split_percent = 50 WHERE deal_id = 'ac300000-0000-0000-0000-000000000001'$$,
  '23514', 'a closed deal''s splits do not change');
SELECT test_expect_error(
  $$DELETE FROM deal_agents WHERE deal_id = 'ac300000-0000-0000-0000-000000000001'$$,
  '23514', 'a closed deal''s agents are not removed');
SELECT test_expect_error(
  $$UPDATE deal_milestones SET due_date = current_date WHERE id = 'ac340000-0000-0000-0000-000000000002'$$,
  '23514', 'a closed deal''s open milestones do not change');
SELECT test_expect_error(
  $$INSERT INTO deal_milestones (company_id, deal_id, code, name, sort_order) VALUES
      ('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001', 'extra', 'Extra', 10)$$,
  '23514', 'a closed deal gets no new milestones');
SELECT test_expect_error(
  $$UPDATE deals SET owner_membership_id = 'a4000000-0000-0000-0000-000000000002' WHERE id = 'ac300000-0000-0000-0000-000000000001'$$,
  '23514', 'a closed deal keeps its owner');

-- ------------------------------------------------- letting deals stop at "terms agreed" (P6-D2)
INSERT INTO deals (id, company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code, listing_id, unit_id)
VALUES ('ac300000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'DEA-S3-2', 'letting',
        (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'negotiation'),
        'ac330000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002',
        'GHS', 'a9000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001');
INSERT INTO offers (id, company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, rent_frequency, recorded_by)
VALUES ('ac310000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000002',
        'a9000000-0000-0000-0000-000000000001', 'ac330000-0000-0000-0000-000000000003', 'from_buyer', 'GHS', 5800, 'monthly',
        'a4000000-0000-0000-0000-000000000002');
SELECT set_config('app.pipeline_action', 'on', true);
UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = 'ac310000-0000-0000-0000-000000000002';
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'offer_accepted')
 WHERE id = 'ac300000-0000-0000-0000-000000000002';
SELECT set_config('app.pipeline_action', '', true);
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'contract')
     WHERE id = 'ac300000-0000-0000-0000-000000000002'$$,
  '23514', 'a letting deal moves to lease signing only once a lease is drawn up from it (P7-D4)');
SELECT test_assert(NOT app.deal_identity_required('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000002'),
  'the sales identity rule does not apply to lettings');

-- Losing it: the accepted offer is withdrawn with it.
SELECT set_config('app.assignment_note', 'Applicant asked for another agent', true);
UPDATE deals SET owner_membership_id = 'a4000000-0000-0000-0000-000000000003' WHERE id = 'ac300000-0000-0000-0000-000000000002';
SELECT test_expect_error(
  $q$DO $d$ BEGIN
      UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'closed_lost'),
                       closed_at = now(), lost_reason_code = 'financing_failed'
       WHERE id = 'ac300000-0000-0000-0000-000000000002';
      SET CONSTRAINTS ALL IMMEDIATE;
    END $d$$q$,
  '23514', 'a deal is not lost while its offer stays accepted');
SET CONSTRAINTS ALL DEFERRED;
UPDATE offers SET status = 'withdrawn', responded_at = now() WHERE id = 'ac310000-0000-0000-0000-000000000002';
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'closed_lost'),
                 closed_at = now(), lost_reason_code = 'financing_failed', lost_notes = 'Guarantor withdrew'
 WHERE id = 'ac300000-0000-0000-0000-000000000002';
SET CONSTRAINTS ALL IMMEDIATE;
SELECT test_assert((SELECT stage_class = 'closed_lost' FROM deals WHERE id = 'ac300000-0000-0000-0000-000000000002'),
  'losing the deal with the accepted offer withdrawn');
SET CONSTRAINTS ALL DEFERRED;

-- ------------------------------------------------- erasure covers owner-change notes (ADR-008 §3)
SELECT test_assert(NOT ('open_deal' = ANY (app.contact_erasure_blockers('ac330000-0000-0000-0000-000000000003'))),
  'a party to a lost deal without a sale may be erased');
SELECT app.erase_contact('ac330000-0000-0000-0000-000000000003');
SELECT test_assert(
  (SELECT bool_and(note IS NULL OR note = '[Erased]') AND count(*) FILTER (WHERE note = '[Erased]') = 1
     FROM deal_assignments WHERE deal_id = 'ac300000-0000-0000-0000-000000000002'),
  'the erasure anonymises owner-change notes on the person''s deals; who and when are kept');
SELECT test_assert((SELECT lost_notes = '[Erased]' AND lost_reason_code = 'financing_failed' FROM deals WHERE id = 'ac300000-0000-0000-0000-000000000002'),
  'the lost notes are erased; the reason code is kept');

-- ------------------------------------------------- tenant isolation
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) = 0 FROM deal_assignments), 'another company sees none of these owner changes');
SELECT test_expect_error(
  $$INSERT INTO deal_agents (company_id, deal_id, membership_id, agent_role, split_percent)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'ac300000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002', 'referrer', 0)$$,
  '42501', 'another company cannot add agents to these deals');

ROLLBACK;
