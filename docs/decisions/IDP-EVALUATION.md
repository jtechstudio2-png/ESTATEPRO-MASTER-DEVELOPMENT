# Identity-provider evaluation (issue #6)

| | |
|---|---|
| Status | **In progress.** Evaluation started 30 October 2026; decision by the product owner |
| Decision it feeds | ADR-001 chose a managed OIDC identity provider. This document chooses the vendor |
| Blocks | Any shared environment (staging or production). Local development and CI use the test provider in `apps/web/e2e/support/idp.ts` |

## 1. Requirements

These come from code that already exists, so a vendor that fails one would need code changes.

### 1.1 Must have (pass or fail)

| # | Requirement | Where it is used | How we verify |
|---|---|---|---|
| R1 | OIDC authorisation code flow with PKCE (S256), `state` and `nonce` | `apps/web/src/server/oidc.ts` | Auth-flow test against a trial tenant |
| R2 | Refresh tokens with rotation; a revoked refresh token fails | Session refresh (`currentSession`) | Same test: refresh, then revocation |
| R3 | `end_session_endpoint` with `id_token_hint` and `post_logout_redirect_uri` | `/auth/logout` | Same test |
| R4 | Access token is a signed JWT (RS256 or ES256) with JWKS, our API audience, `sub`, verified `email` | API JWT guard (M1) | API tests against tokens from the tenant |
| R5 | `amr` claim showing MFA (or an equivalent mapped claim), and `auth_time` | MFA and step-up checks (M1) | Inspect tokens after MFA sign-in |
| R6 | Forced re-authentication: `prompt=login` and `max_age=0` | Step-up (`stepUp=1`) | Same test (step-up case) |
| R7 | MFA with TOTP and WebAuthn (passkeys) | ADR-001 | Manual |
| R8 | Data residency: user data stored in the EU or UK, acceptable for UK, Ghana and Qatar users | Data-protection review (S-11) | Vendor documentation and contract |
| R9 | Hosted sign-in pages localised in **Arabic, right to left** | Qatar launch | Manual review with a native speaker |
| R10 | Hosted pages meet **WCAG 2.2 AA**, including 3.3.8 accessible authentication (paste allowed, passkeys, no cognitive tests) | ADR-002 | Axe and a screen-reader pass on the hosted pages |
| R11 | Custom domain for sign-in | Trust and branding | Configuration |
| R12 | Management API to create users and invitations (company provisioning CLI, M1) | `provision-company` | API trial |

### 1.2 Scored (weighted)

| Criterion | Weight |
|---|---|
| Price at the expected monthly active users (staff now, landlord and tenant portals later) | 25 |
| Portal readiness: separate apps or tenants for landlords and tenants, magic link or passwordless (IS-9) | 20 |
| Operational maturity: SLA, status history, incident communication, support | 20 |
| Security features: breached-password detection, bot protection, anomaly detection, audit log export | 15 |
| Developer experience: standards compliance without vendor SDKs, test tenants, infrastructure as code | 10 |
| Exit cost: export of users (including password hashes where allowed) and MFA enrolments | 10 |

## 2. Shortlist

Vendor capabilities below are **to verify** in the trial; nothing is assumed.

| Option | Kind | Why it is on the list | Main question to answer |
|---|---|---|---|
| Auth0 (Okta Customer Identity) | Managed | Mature OIDC, customisable hosted pages, broad MFA | Price at portal scale; EU data region; Arabic RTL quality |
| Microsoft Entra External ID | Managed | Enterprise SLA and pricing; EU data boundary | Hosted-page customisation and Arabic RTL; `amr` claims |
| AWS Cognito | Managed | Low cost; fits an AWS deployment | WebAuthn and step-up support; hosted-page accessibility |
| Zitadel Cloud | Managed (open source core) | Standards-first, EU hosting, self-host exit path | Operational maturity; support |
| Keycloak | Self-hosted fallback | Full control, no per-user cost | Contradicts ADR-001 (managed); our team operates it |

**Recommendation for the trial order:** Auth0 and Microsoft Entra External ID first, Zitadel Cloud as the third. The final recommendation is made only after the proof in §3.

## 3. Proof for each trialled vendor

1. Create a trial tenant in an EU region, with our API audience and a web client (PKCE, no secret).
2. Run the server-layer sign-in flow test (`apps/web/test/server/auth-flow.test.ts` pattern) against the tenant: login, callback, replay refusal, refresh, revocation, step-up, sign-out (R1–R3, R6).
3. Feed the tenant's tokens into the API's auth tests: issuer, audience, `amr`, `auth_time` (R4, R5).
4. Run the Playwright sign-in path and an axe scan on the hosted pages, in English and Arabic (R9, R10).
5. Check the management API by provisioning a company owner (R12).
6. Record the results in this document with screenshots, and score §1.2.

**Effort:** about 1 engineer-day per vendor, plus the product owner's review.

## 4. Decision record

To complete after the trials. It records the vendor, the scores, the proof results, the cost estimate, the data-residency confirmation and the exit plan. Then issue #6 is closed, and ADR-001 gains a reference to this record.
