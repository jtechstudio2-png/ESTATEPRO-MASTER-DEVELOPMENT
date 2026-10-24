-- =============================================================================
-- EstatePro · Migration 0016 · Auth role can read membership offices
-- =============================================================================
-- The API resolves a request's membership (role, permissions and office scope)
-- through the estatepro_auth role before any company context exists (ADR-001).
-- Office-scoped permissions need the member's offices, so the auth role gets
-- read access to membership_offices. It still has no access to business data.
-- =============================================================================

GRANT SELECT ON membership_offices TO estatepro_auth;
