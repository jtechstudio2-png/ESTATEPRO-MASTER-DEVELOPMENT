-- =============================================================================
-- EstatePro · Migration 0017 · Listing permissions and title search (Phase 4 M3)
-- =============================================================================
-- Product-owner decisions (docs/phase-4/M3-LISTINGS-REQUIREMENTS-VERIFICATION.md):
--   D1  Agents may publish listings assigned to themselves ('own' scope).
--   G2  Listings are archived with their own permission (P1-D §11.2 "D").
--   G6  Title and reference search; indexes for the list sorts (100,000 listings, p95 < 1 s).
-- Company settings read by the listings module (company_settings, office row
-- overrides company row; absent = default):
--   listing.price_reduction_approval_percent  number 1–100; absent = off (D2)
--   listing.require_seller_kyc                boolean; absent = false (G4)
-- =============================================================================

INSERT INTO permissions (key, module, description, is_sensitive) VALUES
  ('listing.archive', 'properties', 'Archive and restore listings', false);

INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT r.id, g.permission_key, g.scope
  FROM (VALUES
          ('company_owner',    'listing.archive', 'all'),
          ('office_admin',     'listing.archive', 'all'),
          ('sales_manager',    'listing.archive', 'office'),
          ('property_manager', 'listing.archive', 'office'),
          ('agent',            'listing.publish', 'own')
       ) AS g (role_key, permission_key, scope)
  JOIN roles r ON r.key = g.role_key AND r.company_id IS NULL;

-- Text search (q): each branch of the search uses its own trigram index.
CREATE INDEX listings_title_trgm_idx ON listings USING gin (title gin_trgm_ops);
CREATE INDEX listings_reference_trgm_idx ON listings USING gin (reference gin_trgm_ops);
CREATE INDEX listing_translations_title_trgm_idx ON listing_translations USING gin (title gin_trgm_ops);

-- Keyset pagination for the list sorts (updatedAt is the default).
CREATE INDEX listings_updated_idx ON listings (company_id, updated_at, id) WHERE archived_at IS NULL;
CREATE INDEX listings_created_idx ON listings (company_id, created_at, id) WHERE archived_at IS NULL;
CREATE INDEX listings_price_idx ON listings (company_id, price, id) WHERE archived_at IS NULL;
