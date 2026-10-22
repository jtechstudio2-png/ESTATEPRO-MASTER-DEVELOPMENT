-- EstatePro Phase 2 identity privacy hardening
-- Apply after 0004_offers_inspections_crm_activities.sql.
BEGIN;

-- User profiles are global identities that may belong to several companies.
-- They must not be globally enumerable by a tenant-scoped application role.
-- The API sets app.current_user_id from the authenticated session and
-- app.current_company_id from a separately validated active membership.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY user_profile_visibility ON users
USING (
  user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  OR EXISTS (
    SELECT 1
    FROM company_memberships m
    WHERE m.user_id = users.user_id
      AND m.company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      AND m.status IN ('invited','active','suspended')
  )
)
WITH CHECK (
  user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
);

COMMIT;

-- The identity provider remains authoritative for authentication credentials.
-- This table stores application profile and identity-link metadata, not passwords.
-- Keep writes to email_normalized, identity_provider and identity_subject behind
-- verified identity-link flows; a row policy cannot itself verify an email address.
