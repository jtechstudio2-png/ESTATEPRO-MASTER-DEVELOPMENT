-- =============================================================================
-- S4: landlord visibility (migration 0034, with the C4 resolver of 0025). Rolled back.
-- =============================================================================
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL ROLE estatepro_app;
SELECT set_config('app.company_id', 'a0000000-0000-0000-0000-000000000001', true);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-000000000001', true);

-- ------------------------------------------------- permissions (P6-D10)
SELECT test_assert(
  (SELECT array_agg(rp.permission_key ORDER BY rp.permission_key) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
    WHERE r.key = 'landlord' AND r.company_id IS NULL AND rp.permission_key IN ('offer.view', 'deal.view', 'viewing.view') AND rp.scope = 'linked')
  = ARRAY['deal.view', 'offer.view', 'viewing.view'],
  'landlords read offers, deals and viewings with the linked scope');
SELECT test_assert(
  NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
               WHERE r.key = 'landlord' AND rp.permission_key IN ('offer.manage', 'offer.accept', 'deal.update', 'deal.close', 'viewing.manage')),
  'landlords change none of them');

-- ------------------------------------------------- listings a landlord may see, from when
-- Kofi owns Osu Court (both units, both listings) since 2020-01-01 (fixtures).
SELECT test_assert(
  (SELECT array_agg(listing_id ORDER BY listing_id) FROM app.landlord_listing_access('a5000000-0000-0000-0000-000000000001'))
  = ARRAY['a9000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000002']::uuid[]
  AND (SELECT bool_and(since = '2020-01-01' AND timezone = 'Africa/Accra') FROM app.landlord_listing_access('a5000000-0000-0000-0000-000000000001')),
  'the owner sees the listings of their units, from the start of their ownership');
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.landlord_listing_access('a5000000-0000-0000-0000-000000000003')),
  'a contact who owns nothing sees no listing');

-- A co-owner of one unit, from yesterday: that unit's listing only, from their own start.
INSERT INTO contacts (id, company_id, contact_type, display_name) VALUES
  ('ad330000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'person', 'Esi Co-owner');
INSERT INTO property_ownerships (company_id, property_id, unit_id, owner_contact_id, share_percent, effective_from) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000002',
   'ad330000-0000-0000-0000-000000000001', 50, current_date - 1);
SELECT test_assert(
  (SELECT array_agg(listing_id) FROM app.landlord_listing_access('ad330000-0000-0000-0000-000000000001')) = ARRAY['a9000000-0000-0000-0000-000000000002']::uuid[]
  AND (SELECT since = current_date - 1 FROM app.landlord_listing_access('ad330000-0000-0000-0000-000000000001')),
  'a co-owner of one unit sees that unit''s listing, from their own start');

-- An ownership that starts tomorrow, or ended yesterday, gives nothing (C4 resolver, property time zone).
INSERT INTO contacts (id, company_id, contact_type, display_name) VALUES
  ('ad330000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'person', 'Future Owner'),
  ('ad330000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'person', 'Former Owner');
INSERT INTO property_ownerships (company_id, property_id, unit_id, owner_contact_id, share_percent, effective_from, effective_to) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001',
   'ad330000-0000-0000-0000-000000000002', 10, current_date + 1, NULL),
  ('a0000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001',
   'ad330000-0000-0000-0000-000000000003', 10, '2019-01-01', current_date - 1);
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.landlord_listing_access('ad330000-0000-0000-0000-000000000002'))
                   AND NOT EXISTS (SELECT 1 FROM app.landlord_listing_access('ad330000-0000-0000-0000-000000000003')),
  'visibility starts with the ownership and ends with it');

-- An archived listing is not shown.
RESET ROLE;
UPDATE listings SET archived_at = now() WHERE id = 'a9000000-0000-0000-0000-000000000001';
SET LOCAL ROLE estatepro_app;
SELECT test_assert(
  (SELECT array_agg(listing_id) FROM app.landlord_listing_access('a5000000-0000-0000-0000-000000000001')) = ARRAY['a9000000-0000-0000-0000-000000000002']::uuid[],
  'archived listings are not shown');

-- ------------------------------------------------- tenant isolation
SELECT set_config('app.company_id', 'b0000000-0000-0000-0000-000000000001', true);
SELECT test_assert(NOT EXISTS (SELECT 1 FROM app.landlord_listing_access('a5000000-0000-0000-0000-000000000001')),
  'another company sees none of this landlord''s listings');

ROLLBACK;
