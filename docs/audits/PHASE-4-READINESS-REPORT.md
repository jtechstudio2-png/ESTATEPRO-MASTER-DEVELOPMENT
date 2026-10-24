# EstatePro — Phase 4 Readiness Report

| | |
|---|---|
| Date | 24 October 2026 |
| Inputs | [Compliance audit](PRE-PHASE-4-COMPLIANCE-AUDIT.md) · [Audit Resolution Plan](AUDIT-RESOLUTION-PLAN.md) · Product owner decisions of 24 October 2026 |
| Phase 4 scope (approved) | Property Management Module only: add, edit and archive properties; property categories (types); property status (Available, Reserved, Sold, Rented, Under Contract, Under Maintenance); gallery; floor plans; location management; property notes |
| Verdict | **Ready to start**, with the conditions in §4 |

## 1. Readiness by area (re-rated after the resolution plan)

| Area | Audit rating | Now | Why |
|---|---|---|---|
| Product Architecture | Amber | **Green** | Contradictions C1–C4 decided (ADR-001/002/003); stack confirmed (§3) |
| Database Design | Amber | **Green for Phase 4** | All Phase 4 tables built and isolation-tested. A1–A4 are outside Phase 4 scope and scheduled before Phases 7 and 10 |
| Security Design | Amber | **Green for Phase 4** | Auth strategy decided (managed IdP, OIDC); MFA enforcement via token claims; key management (IS-7) is needed only from Phase 5 |
| Tenant Isolation | Green | **Green** | Unchanged; Phase 4 adds API-level cross-company tests |
| UI/UX Design | Amber | **Amber** | Phase 4 screens exist except the media gallery manager and map search (MD-9, MD-10), which are scheduled inside Phase 4 before the UI milestone; usability testing still to run |
| API Planning | Amber | **Green** | Conventions decided (ADR-003); OpenAPI generated from code in Phase 4 |
| Subscription Model | Amber | **Amber (not needed for Phase 4)** | Phase 14 item; Phase 4 routes feature access through one service |
| Portal Design | Amber | **Amber (not needed for Phase 4)** | Portal sign-in decided (ADR-001); screens in Phase 7 |
| Internationalisation | Amber | **Green for Phase 4** | Address formats, property types and locales are seeded for GH/QA/GB; legal and tax data are not used by Phase 4 |
| Deployment Planning | Amber | **Amber** | Phase 4 needs CI and local/staging environments only; production provider and regions wait on V-3 (data residency) |

## 2. What Phase 4 will deliver (milestones)

| Milestone | Content |
|---|---|
| M1 Foundation | Monorepo; API service (NestJS, Kysely, PostgreSQL); configuration; OIDC token verification and membership resolution; tenant transaction wrapper (`SET LOCAL`); permission checks with scopes; RFC 9457 errors; cursor pagination; audit log and outbox writers; OpenAPI generation; platform-staff provisioning command (IS-5); CI pipeline running database and API tests |
| M2 Properties and units | Property types (categories) by country and company; properties and units: create, edit, archive, restore; international address validation from `countries.address_format`; references; optimistic locking; audit trail |
| M3 Listings and status | Sale and rent listings; status state machine (Available, Reserved, Under Contract, Sold, Rented, Withdrawn, Expired) plus the unit availability flag Under Maintenance; price history; status history; bilingual titles and descriptions |
| M4 Gallery and floor plans | Pre-signed uploads to S3-compatible storage; upload confirmation with checksum and content-type sniffing; image derivatives; ordering, cover photo, captions; floor plans, video and virtual-tour links; archive |
| M5 Location and notes | PostGIS geography column and index; map bounding-box and radius search; property notes with audiences (internal, landlord, tenant) |
| M6 Web interface | Next.js staff app shell with sign-in through the IdP; property register, property record, forms, listing editor, gallery manager, map search, Property dashboard; English and Arabic (RTL) string catalogues; accessibility checks |
| M7 Close-out | Phase 4 close-out report in the standard format; audit register update |

Every milestone ends with the report the product owner requested: files created, files modified, endpoints added, database dependencies, tests completed, known limitations and next milestone.

## 3. Confirmed implementation stack

As recommended in audit §6.1, with the authentication change:

- TypeScript (strict), Node.js 22 LTS, NestJS 11, Kysely, PostgreSQL 16 (+ PostGIS 3.4 from M5).
- **Authentication:** managed OIDC identity provider; the API validates access tokens against the provider's JWKS (`jose`). Vendor-neutral: issuer, audience and JWKS URL are configuration.
- Object storage: S3 API (AWS SDK v3). Integration tests run against SeaweedFS (S3-compatible) in Docker.
- Web: Next.js, React, CSS custom-property tokens from Phase 3, ICU messages, CSS logical properties.
- Tests: Vitest for unit and API integration tests against real PostgreSQL; the existing SQL suites; Playwright + axe for the UI milestone.

## 4. Conditions and constraints for Phase 4

1. **Scope lock.** No contacts/CRM, ownership, leases, rent, maintenance or finance features. Phase 4 touches ownership only to the extent of reading nothing from it; ownership management is Phase 5 (it depends on contacts).
2. **Tenant safety.** Every request runs inside the tenant transaction wrapper; there is no other way to obtain a database handle in request code. API tests attempt cross-company access on every endpoint.
3. **IdP vendor not yet chosen** (Open, PO). Phase 4 integrates through standard OIDC and is tested with locally generated signing keys and a JWKS served in the test process. Connecting the chosen vendor is configuration, plus one end-to-end smoke test once the vendor exists.
4. **Malware scanning.** Media uploads are checked for type and size and processed in a worker. Production malware scanning (ClamAV or a cloud scanning service) is a pluggable step; if no scanner is configured, uploaded media stays in `pending` and is never served. This is stated in the M4 report.
5. **No audit fixes outside scope.** A1–A4 and the permission change are not implemented in Phase 4; they stay tracked in the resolution plan.
6. **Branching.** Phase 4 work happens on `phase-4/property-management`, branched from `main`; the audit branch stays unmerged.

## 5. Risks for Phase 4

| Risk | Mitigation |
|---|---|
| IdP-specific claims (organisation, MFA) differ by vendor | Only standard claims (`sub`, `iss`, `aud`, `exp`, `amr`, `acr`) are relied on; mapping is configurable |
| Media processing load | Processing runs in a separate worker queue, not in API requests |
| PostGIS availability on the chosen managed database | All major managed PostgreSQL services offer PostGIS; it is checked when the provider is chosen |
| Scope creep into CRM (owners, applicants) | Scope lock (§4.1); owner fields deferred to Phase 5 |
