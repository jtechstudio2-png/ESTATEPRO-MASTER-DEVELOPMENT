-- =============================================================================
-- EstatePro · Migration 0034 · Landlord visibility (Phase 6 milestone S4, #5)
-- =============================================================================
-- Landlords see reduced, read-only views of the offers, deal progress and
-- viewings on their own listings (readiness report §6, P6-D10). The views are
-- built by the API from the same resolver the C4 staff preview uses
-- (app.landlord_unit_access), so staff and portal never disagree.
--
--  1. The landlord role reads deals and viewings with the linked scope
--     (offer.view linked exists since migration 0014).
--  2. app.landlord_listing_access(contact): each listing a landlord may see
--     and the day their current link to its unit began. Activity before that
--     day is not shown: a buyer who becomes the owner on completion does not
--     see the offers and viewings of the sale they bought through, and a
--     co-owner added later sees activity from their own start.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Landlord permissions (P6-D10)
-- -----------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT r.id, g.permission_key, 'linked'
  FROM (VALUES ('deal.view'), ('viewing.view')) AS g (permission_key)
  JOIN roles r ON r.key = 'landlord' AND r.company_id IS NULL
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Listings a landlord may see, from when
-- -----------------------------------------------------------------------------
-- SECURITY INVOKER: row-level security still limits it to the caller's company.
-- The link is current ownership or an active management agreement, judged in
-- the property's time zone (app.landlord_unit_access); when several links
-- cover the unit, the earliest start counts.
CREATE FUNCTION app.landlord_listing_access(p_contact uuid)
RETURNS TABLE (listing_id uuid, unit_id uuid, property_id uuid, since date, timezone text)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT l.id, l.unit_id, a.property_id, min(coalesce(o.effective_from, m.start_date)), p.timezone
    FROM app.landlord_unit_access(p_contact) a
    JOIN listings l ON l.company_id = app.current_company_id() AND l.unit_id = a.unit_id AND l.archived_at IS NULL
    JOIN properties p ON p.company_id = l.company_id AND p.id = a.property_id
    LEFT JOIN property_ownerships o ON a.basis = 'ownership' AND o.company_id = l.company_id AND o.id = a.basis_id
    LEFT JOIN management_agreements m ON a.basis = 'management_agreement' AND m.company_id = l.company_id AND m.id = a.basis_id
   GROUP BY l.id, l.unit_id, a.property_id, p.timezone
$$;
COMMENT ON FUNCTION app.landlord_listing_access(uuid) IS
  'S4 (#5): listings a landlord contact may see and the day their current link to the unit began (activity before it is not shown).';
GRANT EXECUTE ON FUNCTION app.landlord_listing_access(uuid) TO estatepro_app, estatepro_platform;
