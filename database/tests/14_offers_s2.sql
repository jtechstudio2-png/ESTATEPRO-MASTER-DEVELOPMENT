-- =============================================================================
-- S2: offers (migration 0032, with the offer rules of 0007 and 0030). Rolled back.
-- Commit-time checks are forced with SET CONSTRAINTS ALL IMMEDIATE inside a block,
-- so each violation is tested on its own and undone.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

INSERT INTO deals (id, company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code, listing_id, unit_id)
VALUES ('a9b20000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'DEA-O-1', 'sale',
        (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'negotiation'),
        'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002',
        'GHS', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002');
INSERT INTO offers (id, company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, recorded_by)
VALUES ('a9c20000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a9b20000-0000-0000-0000-000000000001',
        'a9000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000003', 'from_buyer', 'GHS', 420000,
        'a4000000-0000-0000-0000-000000000002');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT test_assert(true, 'an offer is recorded on an open deal at negotiation');
SET CONSTRAINTS ALL DEFERRED;

-- ------------------------------------------------- deal stage and accepted offers agree
SELECT test_expect_error(
  $q$DO $d$ BEGIN
      UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = 'a9c20000-0000-0000-0000-000000000001';
      SET CONSTRAINTS ALL IMMEDIATE;
    END $d$$q$,
  '23514', 'accepting an offer moves its deal to "offer accepted" in the same transaction');
SET CONSTRAINTS ALL DEFERRED;
SELECT test_expect_error(
  $q$DO $d$ BEGIN
      UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'offer_accepted')
       WHERE id = 'a9b20000-0000-0000-0000-000000000001';
      SET CONSTRAINTS ALL IMMEDIATE;
    END $d$$q$,
  '23514', 'a deal reaches "offer accepted" only by accepting an offer');
SET CONSTRAINTS ALL DEFERRED;

-- The accept action: the offer, the deal and the listing together.
SELECT set_config('app.pipeline_action', 'on', true);
UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = 'a9c20000-0000-0000-0000-000000000001';
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'offer_accepted')
 WHERE id = 'a9b20000-0000-0000-0000-000000000001';
UPDATE listings SET status = 'reserved' WHERE id = 'a9000000-0000-0000-0000-000000000002';
SELECT set_config('app.pipeline_action', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT test_assert((SELECT stage_class = 'offer_accepted' FROM deals WHERE id = 'a9b20000-0000-0000-0000-000000000001')
                   AND (SELECT status = 'reserved' FROM listings WHERE id = 'a9000000-0000-0000-0000-000000000002'),
  'accepting moves the deal to "offer accepted" and reserves the listing');
SET CONSTRAINTS ALL DEFERRED;

-- ------------------------------------------------- the listing moves only through the pipeline (P6-D5)
SELECT test_expect_error(
  $$UPDATE listings SET status = 'available' WHERE id = 'a9000000-0000-0000-0000-000000000002'$$,
  '23514', 'a listing with an accepted offer cannot be made available by hand');
SELECT test_expect_error(
  $$UPDATE listings SET status = 'under_contract' WHERE id = 'a9000000-0000-0000-0000-000000000002'$$,
  '23514', 'a listing with an accepted offer cannot be put under contract by hand');

-- A second open offer on the same listing stays recorded (P6-D4) but cannot be accepted too.
INSERT INTO deals (id, company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code, listing_id, unit_id)
VALUES ('a9b20000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'DEA-O-2', 'sale',
        (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'negotiation'),
        'a5000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002',
        'GHS', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002');
INSERT INTO offers (id, company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, recorded_by)
VALUES ('a9c20000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a9b20000-0000-0000-0000-000000000002',
        'a9000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000002', 'from_buyer', 'GHS', 430000,
        'a4000000-0000-0000-0000-000000000002');
SELECT test_assert((SELECT status = 'submitted' FROM offers WHERE id = 'a9c20000-0000-0000-0000-000000000002'),
  'another buyer''s offer is still recorded while one is accepted');
SELECT test_expect_error(
  $$UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = 'a9c20000-0000-0000-0000-000000000002'$$,
  '23505', 'one accepted offer per listing');

-- Withdrawing the accepted offer returns the deal to negotiation and the listing to available.
SELECT set_config('app.pipeline_action', 'on', true);
UPDATE offers SET status = 'withdrawn', responded_at = now() WHERE id = 'a9c20000-0000-0000-0000-000000000001';
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'negotiation')
 WHERE id = 'a9b20000-0000-0000-0000-000000000001';
UPDATE listings SET status = 'available' WHERE id = 'a9000000-0000-0000-0000-000000000002';
SELECT set_config('app.pipeline_action', '', true);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT test_assert((SELECT stage_class = 'negotiation' FROM deals WHERE id = 'a9b20000-0000-0000-0000-000000000001')
                   AND (SELECT status = 'available' FROM listings WHERE id = 'a9000000-0000-0000-0000-000000000002'),
  'withdrawing the accepted offer returns the deal to negotiation and the listing to available');
SET CONSTRAINTS ALL DEFERRED;
SELECT test_expect_error(
  $q$DO $d$ BEGIN
      UPDATE offers SET status = 'withdrawn', responded_at = now() WHERE id = 'a9c20000-0000-0000-0000-000000000002';
      UPDATE offers SET status = 'accepted' WHERE id = 'a9c20000-0000-0000-0000-000000000002';
    END $d$$q$,
  '23514', 'a withdrawn offer is not accepted later');

-- ------------------------------------------------- accepting needs a listing on the market
RESET ROLE;
UPDATE listings SET status = 'withdrawn' WHERE id = 'a9000000-0000-0000-0000-000000000002';
SET LOCAL ROLE estatepro_app;
SELECT test_expect_error(
  $$UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = 'a9c20000-0000-0000-0000-000000000002'$$,
  '23514', 'an offer is not accepted on a withdrawn listing');
RESET ROLE;
UPDATE listings SET status = 'available' WHERE id = 'a9000000-0000-0000-0000-000000000002';
SET LOCAL ROLE estatepro_app;

-- ------------------------------------------------- tenant isolation
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) = 0 FROM offers), 'another company sees no offers');
SELECT test_expect_error(
  $$INSERT INTO offers (company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, recorded_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9b20000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
            'a5000000-0000-0000-0000-000000000003', 'from_buyer', 'GHS', 1, 'a4000000-0000-0000-0000-000000000002')$$,
  '42501', 'another company cannot record an offer on this company''s deal');

ROLLBACK;
