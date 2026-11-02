-- =============================================================================
-- Contacts C1 (migration 0022): search normalisation, archive rules and merge.
-- Runs as estatepro_app in company A; rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- ------------------------------------------------------- search normalisation
SELECT test_assert(app.search_normalise('أحمد الكوارى') = app.search_normalise('احمد الكواري'), 'alef and alef maqsura variants search alike');
SELECT test_assert(app.search_normalise('مَدْرَسَة') = 'مدرسه', 'diacritics are ignored and ta marbuta folds to ha');
SELECT test_assert(app.search_normalise('Kofi OWUSU') = 'kofi owusu', 'Latin text is compared in lower case');
INSERT INTO contacts (id, company_id, contact_type, display_name, display_name_local, primary_phone_e164)
VALUES ('a5000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-000000000001', 'person', 'Ahmed Al-Kuwari', 'أحمد الكواري', '+97455000001');
SELECT test_assert(
  (SELECT search_vector @@ plainto_tsquery('simple', app.search_normalise('احمد')) FROM contacts WHERE id = 'a5000000-0000-0000-0000-0000000000c1'),
  'a native-script name is found whichever alef the searcher types');

-- ------------------------------------------------------------------- archive
SELECT test_expect_error(
  $$UPDATE contacts SET archived_reason = 'No reason without archive' WHERE id = 'a5000000-0000-0000-0000-0000000000c1'$$,
  '23514', 'an archive reason needs an archived contact');
SELECT test_expect_error(
  $$UPDATE contacts SET merged_into_contact_id = 'a5000000-0000-0000-0000-000000000001' WHERE id = 'a5000000-0000-0000-0000-0000000000c1'$$,
  '23514', 'a merged contact is always archived');

-- --------------------------------------------------------------------- merge
-- Keep: c1. Merge: c2, with references of each handling kind.
INSERT INTO contacts (id, company_id, contact_type, display_name, primary_phone_e164)
VALUES ('a5000000-0000-0000-0000-0000000000c2', 'a0000000-0000-0000-0000-000000000001', 'person', 'Ahmed Kuwari', '+97455000001'),
       ('a5000000-0000-0000-0000-0000000000c3', 'a0000000-0000-0000-0000-000000000001', 'person', 'Earlier duplicate', '+97455000009');
INSERT INTO contact_relationships (company_id, contact_id, relationship_type)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c1', 'buyer'),
       ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c2', 'buyer'),
       ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c2', 'landlord');
INSERT INTO contact_methods (company_id, contact_id, method_type, value, normalised, is_primary, opted_out_at)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c1', 'mobile', '+97455000001', '+97455000001', true, NULL),
       ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c2', 'mobile', '+97455000001', '+97455000001', true, now()),
       ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c2', 'email', 'ahmed@example.test', 'ahmed@example.test', true, NULL);
INSERT INTO contact_links (company_id, contact_id, related_contact_id, link_type)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c2', 'a5000000-0000-0000-0000-0000000000c1', 'family'),
       ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c2', 'a5000000-0000-0000-0000-000000000003', 'spouse');
INSERT INTO property_ownerships (company_id, property_id, owner_contact_id, effective_from)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c2', '2024-01-01');
INSERT INTO activities (id, company_id, activity_type, subject)
VALUES ('a9000000-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-000000000001', 'note', 'Met at viewing');
INSERT INTO activity_links (company_id, activity_id, entity_type, entity_id)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-0000000000c1', 'contact', 'a5000000-0000-0000-0000-0000000000c1'),
       ('a0000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-0000000000c1', 'contact', 'a5000000-0000-0000-0000-0000000000c2');
UPDATE contacts SET merged_into_contact_id = 'a5000000-0000-0000-0000-0000000000c2', archived_at = now()
 WHERE id = 'a5000000-0000-0000-0000-0000000000c3';

SELECT test_assert(
  (SELECT app.contact_reference_counts('a5000000-0000-0000-0000-0000000000c2') ->> 'property_ownerships.owner_contact_id' = '1'),
  'the merge preview counts references per table');
SELECT test_assert(
  (SELECT cardinality(app.contact_merge_blockers('a5000000-0000-0000-0000-0000000000c2')) = 0),
  'a contact without financial records has no merge blockers');

SELECT test_expect_error(
  $$SELECT app.merge_contact_references('a5000000-0000-0000-0000-0000000000c1', 'a5000000-0000-0000-0000-0000000000c1')$$,
  '23514', 'a contact cannot be merged into itself');
SELECT test_expect_error(
  $$SELECT app.merge_contact_references('a5000000-0000-0000-0000-0000000000c1', 'b5000000-0000-0000-0000-000000000001')$$,
  '23503', 'another company''s contact cannot be merged (row-level security hides it)');

SELECT app.merge_contact_references('a5000000-0000-0000-0000-0000000000c1', 'a5000000-0000-0000-0000-0000000000c2');

SELECT test_assert(
  (SELECT count(*) = 2 FROM contact_relationships WHERE contact_id = 'a5000000-0000-0000-0000-0000000000c1' AND status = 'active'),
  'roles are combined: buyer once, landlord moved');
SELECT test_assert(
  (SELECT count(*) = 1 FROM contact_relationships WHERE contact_id = 'a5000000-0000-0000-0000-0000000000c1' AND status = 'inactive' AND relationship_type = 'buyer'),
  'the duplicate active role is kept as ended history');
SELECT test_assert(
  (SELECT count(*) = 1 FROM contact_methods WHERE contact_id = 'a5000000-0000-0000-0000-0000000000c1' AND method_type = 'mobile'),
  'an identical phone number is folded into one method');
SELECT test_assert(
  (SELECT opted_out_at IS NOT NULL FROM contact_methods WHERE contact_id = 'a5000000-0000-0000-0000-0000000000c1' AND method_type = 'mobile'),
  'an opt-out on either duplicate stays in force');
SELECT test_assert(
  (SELECT NOT is_primary FROM contact_methods WHERE contact_id = 'a5000000-0000-0000-0000-0000000000c1' AND method_type = 'email'),
  'moved methods never displace the kept contact''s primary values');
SELECT test_assert(
  (SELECT count(*) = 1 FROM contact_links WHERE contact_id = 'a5000000-0000-0000-0000-0000000000c1' AND related_contact_id = 'a5000000-0000-0000-0000-000000000003'),
  'links to other contacts move');
SELECT test_assert(
  (SELECT count(*) = 0 FROM contact_links WHERE contact_id = related_contact_id OR 'a5000000-0000-0000-0000-0000000000c2' IN (contact_id, related_contact_id)),
  'links between the two merged contacts are removed');
SELECT test_assert(
  (SELECT owner_contact_id = 'a5000000-0000-0000-0000-0000000000c1' FROM property_ownerships WHERE property_id = 'a7000000-0000-0000-0000-000000000001' AND effective_from = '2024-01-01'),
  'ownership records move to the kept contact');
SELECT test_assert(
  (SELECT count(*) = 1 FROM activity_links WHERE activity_id = 'a9000000-0000-0000-0000-0000000000c1'),
  'an activity linked to both contacts is linked once');
SELECT test_assert(
  (SELECT merged_into_contact_id = 'a5000000-0000-0000-0000-0000000000c1' FROM contacts WHERE id = 'a5000000-0000-0000-0000-0000000000c3'),
  'earlier merges into the merged contact now point at the kept contact');

-- Financial records block a merge.
INSERT INTO contact_payment_accounts (company_id, contact_id, account_type, account_name, provider_name, country_code, currency_code, account_number_encrypted, last4)
VALUES ('a0000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-0000000000c1', 'mobile_money', 'Ahmed Al-Kuwari', 'MTN', 'GH', 'GHS', '\x01'::bytea, '4321');
SELECT test_assert(
  (SELECT app.contact_merge_blockers('a5000000-0000-0000-0000-0000000000c1') = ARRAY['contact_payment_accounts']),
  'a payout account blocks merging that contact away');

ROLLBACK;
