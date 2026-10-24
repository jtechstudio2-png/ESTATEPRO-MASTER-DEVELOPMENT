# ADR-001 — Authentication through a managed identity provider

| | |
|---|---|
| Status | Accepted (product owner, 24 October 2026). Vendor selection open — GitHub issue #6 |
| Supersedes | Phase 1 baseline §13 "Identity" and Phase 1 detailed specification §9.2 "Auth" and §15.2, where they conflict with this record |
| Resolves | Audit contradiction C1; audit item IS-9 (portal sign-in) |

## Context

The two Phase 1 documents disagreed: the baseline recommended "a reputable OIDC provider or maintained authentication library"; the detailed specification recommended an in-house module. The product owner chose a managed identity provider (IdP).

## Decision

1. **The IdP authenticates; EstatePro authorises.**
   - The IdP owns sign-up/sign-in screens, passwords, passkeys, MFA enrolment and challenge, account recovery, brute-force protection and enterprise SSO (SAML/OIDC federation).
   - EstatePro owns companies, memberships, roles, permissions and scopes, in its own database, next to the data they protect (row-level security).
2. **Protocol.** OpenID Connect with OAuth 2.0 authorisation code flow and PKCE for the web app. The API accepts **JWT access tokens** and verifies them locally against the IdP's JSON Web Key Set (JWKS):
   - signature (RS256 or ES256 only), `iss` equal to the configured issuer, `aud` containing the configured audience, `exp`/`nbf` with 60 s clock tolerance;
   - `sub` is the stable user identifier at the IdP.
3. **User mapping.** `external_identities (provider, subject)` maps the IdP subject to `users.id`. On first sign-in, if no mapping exists, the API links the identity to an existing `users` row **only** when the token carries `email` with `email_verified = true` and that user has no identity for this provider yet. There is no self-registration in Phase 4: users exist because platform staff provisioned a company owner or a company invited them.
4. **Company context.** A user may belong to several companies. Each API request names the company it acts in with the header `X-Company-Id`. The API accepts it only if the user has an **active** membership in that company, then sets `app.company_id` for row-level security. The header selects among the user's own memberships; it cannot widen access.
5. **MFA enforcement.** The IdP performs MFA. The API requires proof of MFA in the token (`amr` contains one of the configured values, default `mfa`, `otp`, `hwk`, `swk`, `fido`) for:
   - memberships with `mfa_required = true`;
   - the system roles `company_owner`, `office_admin` and `accountant`;
   - any permission flagged `is_sensitive` (step-up: the token must also be no older than the configured step-up window, default 15 minutes, based on `auth_time`).
6. **Portals.** Landlords and tenants sign in through the same IdP using a separate client application, with email + passkey or password (MFA available) and, for tenants, email one-time codes. Portal memberships are `membership_type = 'portal'`.
7. **Platform staff** sign in through the IdP with MFA always required; platform authorisation comes from `platform_staff`.
8. **Sessions.** Browser sessions are handled by the web app with the IdP (short-lived access tokens, refresh token rotation at the IdP). Deactivating a membership takes effect on the next request, because membership is checked on every request. `user_sessions` remains for listing and revoking EstatePro web sessions.
9. **Tables made unnecessary:** `user_credentials`, `mfa_factors`, `auth_tokens`. They are not used by any code and will be dropped by a later migration (audit item C1-F, Phase 15).

## Vendor selection criteria (issue #6)

- OIDC/OAuth 2.0 compliant; JWT access tokens with JWKS; `amr`, `acr` and `auth_time` claims.
- TOTP and passkey/WebAuthn MFA, enforceable per application.
- SAML and OIDC enterprise federation for the Enterprise plan.
- Acceptable data residency for Ghana, Qatar and UK users (audit V-3).
- Separate client applications for staff, landlord and tenant portals; passwordless email codes.
- Cost at the expected monthly active users including portal users.
- User export (no lock-in).

Shortlist: Auth0, Microsoft Entra External ID, AWS Cognito, Keycloak (self-hosted or managed).

## Consequences

- No password or MFA secret is stored or processed by EstatePro.
- The API is vendor-neutral: issuer, audience, JWKS URL, provider name and accepted `amr` values are configuration.
- Tests use locally generated signing keys and a JWKS served by the test process; one end-to-end smoke test against the chosen vendor is added when issue #6 closes.
- If the IdP is unavailable, nobody can sign in; already-issued tokens continue to work until they expire. The IdP's availability SLA becomes part of EstatePro's.
