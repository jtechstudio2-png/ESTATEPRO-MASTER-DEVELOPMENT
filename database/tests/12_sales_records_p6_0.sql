-- =============================================================================
-- P6-0: history order (#15), sales-record integrity, erasure and retention
-- (migrations 0029 and 0030). Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- ------------------------------------------------- #15: rows written together keep their order
INSERT INTO listing_status_history (company_id, listing_id, from_status, to_status, reason) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'available', 'reserved', 'first'),
  ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'reserved', 'under_contract', 'second'),
  ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'under_contract', 'available', 'third');
SELECT test_assert(
  (SELECT array_agg(reason ORDER BY changed_at, entry_no) FROM listing_status_history
    WHERE listing_id = 'a9000000-0000-0000-0000-000000000002' AND reason IN ('first', 'second', 'third')) = ARRAY['first', 'second', 'third'],
  'history rows written in one transaction read back in the order written');
SELECT test_assert(
  (SELECT count(DISTINCT changed_at) = 1 FROM listing_status_history WHERE reason IN ('first', 'second', 'third')),
  'those rows share one timestamp (the case #15 is about)');

INSERT INTO consents (company_id, contact_id, purpose, channel, status, captured_via) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'marketing', 'email', 'granted', 'web_form'),
  ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000003', 'marketing', 'email', 'withdrawn', 'portal');
SELECT test_assert(
  (SELECT status FROM consents WHERE contact_id = 'a5000000-0000-0000-0000-000000000003' AND purpose = 'marketing' AND channel = 'email'
    ORDER BY captured_at DESC, entry_no DESC LIMIT 1) = 'withdrawn',
  'the consent recorded last is the one in force, even at the same instant');

SELECT test_assert(
  (SELECT bool_and(is_nullable = 'NO') AND count(*) = 14 FROM information_schema.columns
    WHERE column_name = 'entry_no' AND table_schema = 'public'
      AND table_name IN ('activities', 'audit_logs', 'outbox_events', 'listing_status_history', 'listing_price_history', 'key_movements',
                         'lead_status_history', 'lead_assignments', 'data_subject_request_events', 'data_subject_request_evidence',
                         'consents', 'kyc_checks', 'deal_stage_history', 'offers')),
  'every history and audit stream has a required insertion number');

-- ------------------------------------------------- deals: stage history by the database
INSERT INTO contacts (id, company_id, contact_type, display_name, primary_email) VALUES
  ('a5600000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'person', 'Efua Buyer', 'efua@example.test'),
  ('a5600000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'person', 'Kojo Applicant', 'kojo@example.test');

INSERT INTO deals (id, company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code, listing_id, unit_id)
VALUES ('a9b00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'DEA-T-1', 'sale',
        (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'lead'),
        'a5600000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002',
        'GHS', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002');
SELECT test_assert(
  (SELECT count(*) = 1 AND bool_and(from_stage_id IS NULL AND changed_by = 'a4000000-0000-0000-0000-000000000001')
     FROM deal_stage_history WHERE deal_id = 'a9b00000-0000-0000-0000-000000000001'),
  'creating a deal records its first stage, with the member who did it');
SELECT set_config('app.stage_note', 'Called the buyer', true);
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'qualification')
 WHERE id = 'a9b00000-0000-0000-0000-000000000001';
SELECT set_config('app.stage_note', '', true);
SELECT test_assert(
  (SELECT array_agg(coalesce(note, '-') ORDER BY changed_at, entry_no) FROM deal_stage_history WHERE deal_id = 'a9b00000-0000-0000-0000-000000000001')
    = ARRAY['-', 'Called the buyer'],
  'every stage change is recorded in order, with its note');
UPDATE deals SET expected_value = 450000 WHERE id = 'a9b00000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT count(*) = 2 FROM deal_stage_history WHERE deal_id = 'a9b00000-0000-0000-0000-000000000001'),
  'other edits do not add stage history');
SELECT test_expect_error(
  $$INSERT INTO deal_stage_history (company_id, deal_id, to_stage_id) VALUES ('a0000000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001', (SELECT id FROM pipeline_stages LIMIT 1))$$,
  '42501', 'the application cannot write stage history itself');
SELECT test_expect_error(
  $$UPDATE deal_stage_history SET note = 'rewritten' WHERE deal_id = 'a9b00000-0000-0000-0000-000000000001'$$,
  '42501', 'stage history cannot be rewritten');
SELECT test_expect_error($$DELETE FROM deals WHERE id = 'a9b00000-0000-0000-0000-000000000001'$$, '42501', 'deals are never deleted');

-- ------------------------------------------------- offers: terms, statuses, chain
INSERT INTO offers (id, company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, conditions, recorded_by) VALUES
  ('a9c00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'a5600000-0000-0000-0000-000000000001', 'from_buyer', 'GHS', 400000, 'Subject to survey', 'a4000000-0000-0000-0000-000000000002');
SELECT test_expect_error(
  $$INSERT INTO offers (company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, recorded_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000001',
            'a5600000-0000-0000-0000-000000000001', 'from_buyer', 'GHS', 1, 'a4000000-0000-0000-0000-000000000002')$$,
  '23514', 'an offer is for its deal''s listing');
SELECT test_expect_error(
  $$INSERT INTO offers (company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, recorded_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
            'a5600000-0000-0000-0000-000000000001', 'from_buyer', 'GBP', 1, 'a4000000-0000-0000-0000-000000000002')$$,
  '23514', 'an offer is in its deal''s currency');
SELECT test_expect_error(
  $$INSERT INTO offers (company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, recorded_by, status, responded_at)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
            'a5600000-0000-0000-0000-000000000001', 'from_buyer', 'GHS', 1, 'a4000000-0000-0000-0000-000000000002', 'accepted', now())$$,
  '23514', 'an offer starts as submitted');
SELECT test_expect_error(
  $$INSERT INTO offers (company_id, deal_id, listing_id, offered_by_contact_id, direction, parent_offer_id, currency_code, amount, recorded_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
            'a5600000-0000-0000-0000-000000000001', 'from_buyer', 'a9c00000-0000-0000-0000-000000000001', 'GHS', 410000, 'a4000000-0000-0000-0000-000000000002')$$,
  '23514', 'a counter-offer comes from the other side');
-- The seller counters at 440,000.
INSERT INTO offers (id, company_id, deal_id, listing_id, offered_by_contact_id, direction, parent_offer_id, currency_code, amount, recorded_by) VALUES
  ('a9c00000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'a5000000-0000-0000-0000-000000000001', 'from_seller', 'a9c00000-0000-0000-0000-000000000001', 'GHS', 440000, 'a4000000-0000-0000-0000-000000000002');
UPDATE offers SET status = 'countered', responded_at = now() WHERE id = 'a9c00000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE offers SET amount = 420000 WHERE id = 'a9c00000-0000-0000-0000-000000000001'$$, '42501', 'an offer''s amount never changes');
SELECT test_expect_error($$UPDATE offers SET conditions = 'No survey' WHERE id = 'a9c00000-0000-0000-0000-000000000001'$$, '42501', 'an offer''s conditions never change');
SELECT test_expect_error($$UPDATE offers SET status = 'accepted' WHERE id = 'a9c00000-0000-0000-0000-000000000001'$$, '23514', 'a countered offer cannot be accepted');
UPDATE offers SET status = 'accepted', responded_at = now() WHERE id = 'a9c00000-0000-0000-0000-000000000002';
SELECT test_expect_error($$UPDATE offers SET status = 'rejected' WHERE id = 'a9c00000-0000-0000-0000-000000000002'$$, '23514', 'an accepted offer can only be withdrawn');
SELECT test_expect_error($$UPDATE offers SET responded_at = now() - interval '1 day' WHERE id = 'a9c00000-0000-0000-0000-000000000002'$$, '23514', 'the response time is not rewritten');
SELECT test_expect_error($$DELETE FROM offers WHERE id = 'a9c00000-0000-0000-0000-000000000001'$$, '42501', 'offers are never deleted');
SELECT test_assert(
  (SELECT array_agg(direction ORDER BY submitted_at, entry_no) FROM offers WHERE deal_id = 'a9b00000-0000-0000-0000-000000000001') = ARRAY['from_buyer', 'from_seller'],
  'the offer chain reads in the order it was made');

-- ------------------------------------------------- sales transactions
SELECT test_expect_error(
  $$INSERT INTO sales_transactions (company_id, reference, deal_id, listing_id, unit_id, accepted_offer_id, currency_code, agreed_price)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'SAL-T-0', 'a9b00000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
            'a8000000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000001', 'GHS', 400000)$$,
  '23514', 'a sale records an accepted offer');
INSERT INTO sales_transactions (id, company_id, reference, deal_id, listing_id, unit_id, accepted_offer_id, currency_code, agreed_price)
VALUES ('a9d00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'SAL-T-1', 'a9b00000-0000-0000-0000-000000000001',
        'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002', 'a9c00000-0000-0000-0000-000000000002', 'GHS', 440000);
SELECT test_expect_error($$UPDATE sales_transactions SET status = 'completed', completed_on = current_date WHERE reference = 'SAL-T-1'$$, '23514', 'a sale exchanges before it completes');
UPDATE sales_transactions SET status = 'exchanged', contract_signed_on = '2015-01-01' WHERE reference = 'SAL-T-1';
SELECT test_expect_error($$UPDATE sales_transactions SET agreed_price = 430000 WHERE reference = 'SAL-T-1'$$, '23514', 'the price is fixed once contracts are exchanged');
UPDATE sales_transactions SET status = 'completed', completed_on = '2015-02-01' WHERE reference = 'SAL-T-1';
SELECT test_expect_error($$UPDATE sales_transactions SET completed_on = '2015-03-01' WHERE reference = 'SAL-T-1'$$, '23514', 'the completion date is fixed');
SELECT test_expect_error($$UPDATE sales_transactions SET status = 'fallen_through', fallen_through_reason = 'x' WHERE reference = 'SAL-T-1'$$, '23514', 'a completed sale cannot fall through');
SELECT test_expect_error($$DELETE FROM sales_transactions WHERE reference = 'SAL-T-1'$$, '42501', 'sales records are never deleted');

-- ------------------------------------------------- milestones
INSERT INTO deal_milestones (id, company_id, deal_id, code, name, sort_order, notes) VALUES
  ('a9e00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000001',
   'buyer_kyc', 'Buyer due diligence complete', 1, 'Passport seen');
UPDATE deal_milestones SET completed_at = now(), completed_by = 'a4000000-0000-0000-0000-000000000001' WHERE id = 'a9e00000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE deal_milestones SET completed_at = NULL, completed_by = NULL WHERE id = 'a9e00000-0000-0000-0000-000000000001'$$, '23514', 'a completed milestone stays complete');
SELECT test_expect_error($$UPDATE deal_milestones SET name = 'Something else' WHERE id = 'a9e00000-0000-0000-0000-000000000001'$$, '23514', 'a milestone keeps what it is');
SELECT test_expect_error($$DELETE FROM deal_milestones WHERE id = 'a9e00000-0000-0000-0000-000000000001'$$, '42501', 'milestones are never deleted');

-- ------------------------------------------------- closed deals are final
UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'closed_won'), closed_at = now()
 WHERE id = 'a9b00000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$UPDATE deals SET stage_id = (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'sale' AND code = 'negotiation'), closed_at = NULL
     WHERE id = 'a9b00000-0000-0000-0000-000000000001'$$,
  '23514', 'a closed deal does not reopen');
SELECT test_assert((SELECT count(*) = 3 FROM deal_stage_history WHERE deal_id = 'a9b00000-0000-0000-0000-000000000001'),
  'closing is recorded as a stage change');

-- ------------------------------------------------- viewings
INSERT INTO viewings (id, company_id, listing_id, unit_id, deal_id, agent_membership_id, scheduled_start, scheduled_end, timezone, meeting_point) VALUES
  ('a9f00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002',
   'a8000000-0000-0000-0000-000000000002', 'a9b00000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002',
   '2015-01-10 10:00+00', '2015-01-10 10:30+00', 'Africa/Accra', 'Gate by the mango tree');
INSERT INTO viewing_attendees (company_id, viewing_id, contact_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a9f00000-0000-0000-0000-000000000001', 'a5600000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$INSERT INTO viewings (company_id, listing_id, unit_id, agent_membership_id, scheduled_start, scheduled_end, timezone, status, outcome)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002',
            'a4000000-0000-0000-0000-000000000001', '2015-01-11 10:00+00', '2015-01-11 10:30+00', 'Africa/Accra', 'completed', 'interested')$$,
  '23514', 'a viewing is booked, not recorded as already done');
SELECT test_expect_error($$UPDATE viewings SET status = 'cancelled' WHERE id = 'a9f00000-0000-0000-0000-000000000001'$$, '23514', 'a cancellation needs a reason');
UPDATE viewings SET status = 'completed', outcome = 'offer_expected', feedback = 'Loved the kitchen; worried about the road noise'
 WHERE id = 'a9f00000-0000-0000-0000-000000000001';
SELECT test_expect_error($$UPDATE viewings SET feedback = 'Changed later' WHERE id = 'a9f00000-0000-0000-0000-000000000001'$$, '23514', 'feedback is final once the viewing is completed');
SELECT test_expect_error($$UPDATE viewings SET status = 'scheduled' WHERE id = 'a9f00000-0000-0000-0000-000000000001'$$, '23514', 'a completed viewing does not reopen');
UPDATE viewings SET seller_feedback_shared = true WHERE id = 'a9f00000-0000-0000-0000-000000000001';
SELECT test_assert((SELECT seller_feedback_shared FROM viewings WHERE id = 'a9f00000-0000-0000-0000-000000000001'),
  'sharing feedback with the landlord can be decided after the viewing');
SELECT test_expect_error($$DELETE FROM viewings WHERE id = 'a9f00000-0000-0000-0000-000000000001'$$, '42501', 'viewings are never deleted');

-- ------------------------------------------------- lead conversion
INSERT INTO leads (id, company_id, reference, contact_id, lead_type, source_code) VALUES
  ('a9a00000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'LEA-T-1', 'a5600000-0000-0000-0000-000000000002', 'rent', 'website');
INSERT INTO deals (id, company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code, lead_id)
VALUES ('a9b00000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'DEA-T-2', 'letting',
        (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'qualification'),
        'a5600000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002', 'GHS',
        'a9a00000-0000-0000-0000-000000000001');
SELECT test_expect_error(
  $$UPDATE leads SET status = 'converted', converted_deal_id = 'a9b00000-0000-0000-0000-000000000001' WHERE id = 'a9a00000-0000-0000-0000-000000000001'$$,
  '23514', 'a lead converts only to the deal made from it');
UPDATE leads SET status = 'converted', converted_deal_id = 'a9b00000-0000-0000-0000-000000000002' WHERE id = 'a9a00000-0000-0000-0000-000000000001';
SELECT test_expect_error(
  $$INSERT INTO deals (company_id, reference, deal_type, stage_id, primary_contact_id, office_id, owner_membership_id, currency_code, lead_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'DEA-T-3', 'letting',
            (SELECT id FROM pipeline_stages WHERE company_id IS NULL AND deal_type = 'letting' AND code = 'qualification'),
            'a5600000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002', 'GHS',
            'a9a00000-0000-0000-0000-000000000001')$$,
  '23505', 'a lead converts to one deal');

-- ------------------------------------------------- erasure blockers
SELECT test_assert('open_deal' = ANY (app.contact_erasure_blockers('a5600000-0000-0000-0000-000000000002')),
  'a party to an open deal cannot be erased');
SELECT test_expect_error($$SELECT app.erase_contact('a5600000-0000-0000-0000-000000000002')$$, '23514', 'erasing a party to an open deal is refused');
SELECT test_assert('sale_record' = ANY (app.contact_erasure_blockers('a5600000-0000-0000-0000-000000000001')),
  'a party to a completed sale is kept while no retention period is set');
SELECT test_assert(app.jurisdiction_rule('GH', 'sales_records_retention_years', current_date) IS NULL,
  'no jurisdiction has a retention period before the legal review (#20)');
RESET ROLE;
INSERT INTO jurisdiction_settings (jurisdiction_code, key, value, effective_from, source_reference)
VALUES ('GH', 'sales_records_retention_years', '5', current_date - 1, 'Test value only');
SET LOCAL ROLE estatepro_app;
SELECT test_assert(app.jurisdiction_rule('GH', 'sales_records_retention_years', current_date) = '5'::jsonb, 'the rule is read from the jurisdiction');
SELECT test_assert(NOT ('sale_record' = ANY (app.contact_erasure_blockers('a5600000-0000-0000-0000-000000000001'))),
  'once the retention period after completion has passed, the sale no longer blocks erasure');

-- ------------------------------------------------- erasure covers the pipeline's free text
-- Audit rows and outbox events about the pipeline records carry the text too; the erasure must reach them.
INSERT INTO audit_logs (company_id, actor_type, action, entity_type, entity_id, changes, metadata) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'user', 'offer.submitted', 'offer', 'a9c00000-0000-0000-0000-000000000001',
   '{"conditions": {"old": null, "new": "Subject to survey"}}', '{"amount": 400000}'),
  ('a0000000-0000-0000-0000-000000000001', 'user', 'viewing.completed', 'viewing', 'a9f00000-0000-0000-0000-000000000001',
   NULL, '{"feedback": "Loved the kitchen"}');
INSERT INTO outbox_events (company_id, event_type, aggregate_type, aggregate_id, payload) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'deal.stage_changed', 'deal', 'a9b00000-0000-0000-0000-000000000001', '{"note": "Called the buyer"}');
SELECT test_assert((app.erase_contact('a5600000-0000-0000-0000-000000000001') ->> 'offers')::int = 1, 'the erasure counts the offers whose text it redacted');
SELECT test_assert(
  (SELECT bool_and(conditions IS NULL OR conditions = '[Erased]') AND bool_and(amount IN (400000, 440000)) FROM offers WHERE deal_id = 'a9b00000-0000-0000-0000-000000000001'),
  'offer conditions are erased; amounts are kept');
SELECT test_assert(
  (SELECT feedback = '[Erased]' AND meeting_point = '[Erased]' AND outcome = 'offer_expected' FROM viewings WHERE id = 'a9f00000-0000-0000-0000-000000000001'),
  'viewing feedback and meeting point are erased; the outcome is kept');
SELECT test_assert(
  (SELECT bool_and(note IS NULL OR note = '[Erased]') FROM deal_stage_history WHERE deal_id = 'a9b00000-0000-0000-0000-000000000001'),
  'deal stage notes are erased');
SELECT test_assert((SELECT notes = '[Erased]' FROM deal_milestones WHERE id = 'a9e00000-0000-0000-0000-000000000001'), 'milestone notes are erased');
SELECT test_assert(
  (SELECT changes = '{"conditions": {"old": null, "new": "[Erased]"}}'::jsonb AND metadata = '{"amount": 400000}'::jsonb
     FROM audit_logs WHERE action = 'offer.submitted' AND entity_id = 'a9c00000-0000-0000-0000-000000000001'),
  'audit rows about the pipeline keep their shape and numbers but lose the text');
SELECT test_assert(
  (SELECT metadata = '{"feedback": "[Erased]"}'::jsonb FROM audit_logs WHERE action = 'viewing.completed'),
  'audit rows about the viewing lose the feedback');
SELECT test_assert(
  (SELECT payload = '{"note": "[Erased]"}'::jsonb FROM outbox_events WHERE aggregate_id = 'a9b00000-0000-0000-0000-000000000001'),
  'outbox events about the deal lose the text');
SELECT test_assert(
  (SELECT agreed_price = 440000 AND status = 'completed' AND completed_on = '2015-02-01' FROM sales_transactions WHERE reference = 'SAL-T-1'),
  'the sale record keeps its price, status and dates');
SELECT test_assert((SELECT stage_class = 'closed_won' FROM deals WHERE id = 'a9b00000-0000-0000-0000-000000000001'), 'the deal keeps its stage');
INSERT INTO offers (id, company_id, deal_id, listing_id, offered_by_contact_id, direction, currency_code, amount, conditions, recorded_by) VALUES
  ('a9c00000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'a9b00000-0000-0000-0000-000000000002',
   'a9000000-0000-0000-0000-000000000001', 'a5600000-0000-0000-0000-000000000002', 'from_buyer', 'GHS', 5500, 'Pets allowed', 'a4000000-0000-0000-0000-000000000002');
SELECT test_expect_error($$UPDATE offers SET conditions = '[Erased]' WHERE id = 'a9c00000-0000-0000-0000-000000000003'$$, '42501', 'outside an erasure, nobody can redact offer text');
SELECT set_config('app.erasure', 'on', true);
SELECT test_expect_error($$UPDATE offers SET conditions = '[Erased]' WHERE id = 'a9c00000-0000-0000-0000-000000000003'$$, '42501',
  'the runtime role cannot pretend to be an erasure');
SELECT set_config('app.erasure', 'off', true);

-- ------------------------------------------------- accountant permissions and isolation
SELECT test_assert(
  (SELECT count(*) = 3 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
    WHERE r.key = 'accountant' AND r.company_id IS NULL AND rp.scope = 'all'
      AND rp.permission_key IN ('deal.view', 'viewing.view', 'offer.view')),
  'accountants read deals, viewings and offers across the company (specification §11.2)');
SELECT test_assert(
  (SELECT count(*) = 0 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
    WHERE r.key = 'accountant' AND r.company_id IS NULL AND rp.permission_key IN ('deal.create', 'deal.update', 'offer.manage', 'offer.accept', 'viewing.manage')),
  'accountants change nothing in the pipeline');

SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert((SELECT count(*) = 0 FROM deals) AND (SELECT count(*) = 0 FROM offers) AND (SELECT count(*) = 0 FROM viewings)
                   AND (SELECT count(*) = 0 FROM deal_stage_history) AND (SELECT count(*) = 0 FROM sales_transactions),
  'another company sees none of these pipeline records');
SELECT test_assert(cardinality(app.contact_erasure_blockers('a5600000-0000-0000-0000-000000000002')) = 0,
  'another company cannot probe a contact''s blockers');

ROLLBACK;
