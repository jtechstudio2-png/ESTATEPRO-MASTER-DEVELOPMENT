# Phase 4 · Property Management — Consolidated Status Report

**Executive engineering review before the next functional domain**

| | |
|---|---|
| Date | 30 October 2026 |
| Branch | `phase-4/property-management`; not merged to `main`, no pull request open |
| Audit branch | `audit/pre-phase-4`; not merged, as instructed |
| Sources | Milestone commits and reports (M3–M6), ADR-001 to ADR-006, the pre-Phase-4 compliance audit, GitHub issues #1–#12, GitHub Actions runs 1–27, and local test runs on 30 October |

## Executive summary

**Phase 4 is functionally complete and well tested locally. It is not release-ready.**

All six milestones are delivered: the API, the database, the background worker and the web interface. Locally:

- the API suite passes (288 tests);
- the web unit suite passes (64 tests);
- the end-to-end suite passes (55 tests);
- every measured performance target is met with wide margins;
- automated accessibility checks pass on every screen in English and Arabic.

Three facts weigh against that picture:

1. **Continuous integration is red, and has been since Milestone 4.** The API test job has passed in 1 of the last 20 runs on GitHub, although it passes every time locally. The new web end-to-end job has never run on GitHub, because it depends on the API job. The milestone reports for M4–M6 described tests as "enforced in CI". That was not true in practice: the workflow defines the checks, but they have not been passing. This should have been caught at each push and was not.
2. **Production prerequisites are open.** The identity-provider vendor is not chosen (#6). No hosting, deployment pipeline, monitoring or backups exist. The data-residency question for Ghana and Qatar media is unanswered.
3. **Open defects block later domains.** Three high-severity money-integrity defects (#1–#3) must be fixed before Leasing and Finance. The linked-visibility resolver for portals (#12) is needed from Phase 5.

**Recommendation:** fix CI first (one to two days), then start Phase 5 CRM in parallel with the launch-infrastructure track. Do not begin Leasing or Finance until #1–#3 and audit item IS-3 are fixed.

## 1. Milestones 1–6 summary

| # | Milestone | Delivered | Key decisions | Commit |
|---|---|---|---|---|
| M1 | Foundation | <ul><li>NestJS and Kysely API on PostgreSQL 16 with row-level security: every request runs in a company-scoped transaction</li><li>OIDC JWT verification, membership resolution, MFA and step-up</li><li>RFC 9457 errors, audit log and outbox</li><li>Provisioning CLI</li><li>OpenAPI 3.1 contract with a drift test</li><li>CI</li></ul> | ADR-001, ADR-002, ADR-003 | `8665c3e` |
| M2 | Properties, units, property types | <ul><li>Country-format addresses</li><li>Record-level scopes</li><li>Keyset pagination</li><li>If-Match and idempotent creates</li><li>Archive and restore with blocking rules</li></ul> | — | `efbfe4f` |
| M3 | Listings | <ul><li>Status model and terminal states</li><li>Publish rules and checklist</li><li>Price-reduction approval threshold</li><li>Relist and reassign</li><li>Translations, histories, unit availability</li><li>100,000-listing search test</li></ul> | ADR-004 (D1–D4) | `22b9ff7` |
| M4 | Gallery and floor plans | <ul><li>Direct-to-storage signed uploads with quota reservation</li><li>ClamAV scan (fail closed), content sniffing, EXIF and GPS stripping, WebP variants, PDF previews</li><li>Video and tour links</li><li>Gallery ordering and cover</li><li>90-day archive and purge, legal hold</li><li>PostgreSQL-backed worker</li></ul> | ADR-005 (M-D1 to M-D8); media retention policy | `115060f` |
| M5 | Location, notes, keys | <ul><li>PostGIS radius, viewport and polygon search</li><li>Distance sort; clustered map endpoints</li><li>Suggest-only geocoding port</li><li>Property notes with revisions, pinning and redaction</li><li>Key register with append-only movements</li></ul> | ADR-006 (L-D1 to L-D10) | `83df360` |
| M6 | Web interface | <ul><li>Next.js app behind a server-side sign-in layer (sealed tokens, CSRF, CSP)</li><li>All 51 wireframe screens, English and Arabic</li><li>Phone and tablet layouts</li><li>Unit, end-to-end, accessibility and performance suites; web CI jobs</li></ul> | W-D1 to W-D10 | `6a2c14b` to `f5ca548` |

Scale of the work:

| Item | Count |
|---|---|
| Database migrations | 20 |
| ADRs | 6, plus the media retention policy |
| Milestone and verification reports | 7 |
| Phase 4 commits not yet on `main` | 26 |

## 2. Implemented features

| Area | Features |
|---|---|
| Tenancy and access | <ul><li>Row-level security on every company table</li><li>Membership scopes (all, office, own)</li><li>Read-only companies</li><li>Step-up MFA for sensitive permissions</li><li>Provisioning CLI for platform staff</li></ul> |
| Properties | <ul><li>Register with filters, search and saved views</li><li>Country-driven address forms (Ghana digital address, Qatar zone, street and building, UK postcode)</li><li>Units and availability</li><li>Archive and restore</li><li>Activity history</li><li>Company property types</li></ul> |
| Listings | <ul><li>Sale and rent</li><li>Lifecycle and terminal states</li><li>Publish checklist (photos, floor plans, mandate, KYC setting, translations)</li><li>Price-reduction approval</li><li>Relist and reassign</li><li>Multilingual translations</li><li>Price and status history</li><li>Listing rules settings</li></ul> |
| Media | <ul><li>Signed direct uploads</li><li>Malware scan</li><li>Metadata stripping</li><li>Variants and PDF previews</li><li>External video and tour links</li><li>Per-listing gallery and cover</li><li>Archive, purge and legal hold</li><li>Storage quota and usage</li></ul> |
| Location | <ul><li>Confirmed-pin model (a geocoder only suggests)</li><li>Stale-pin flag</li><li>Radius, polygon and viewport search</li><li>Distance sort</li><li>Clustered maps</li><li>Self-hosted basemap tooling</li></ul> |
| Notes | <ul><li>Categories and audiences (portal audiences are stored, but no portal shows them yet)</li><li>Pinning (maximum 5)</li><li>Revisions and history</li><li>Archive</li><li>Irreversible redaction</li></ul> |
| Keys | <ul><li>Register, check out and check in</li><li>Lost, found and retire</li><li>Overdue tracking in the property's time zone</li><li>Movement history</li></ul> |
| Background worker | <ul><li>Media processing</li><li>Mandate expiry</li><li>Upload cleanup</li><li>Processing timeouts</li><li>Retention purge</li><li>Storage reconciliation</li></ul> |
| Web | <ul><li>All P, L, G, N, K, M, D, X and T screens</li><li>Global search</li><li>Dashboards</li><li>Field-visit flow</li><li>Phone and tablet layouts</li><li>Arabic right-to-left</li><li>Keyboard-operable maps</li></ul> |

## 3. Open issues (GitHub)

| # | Title | Severity | Needed by | Classification |
|---|---|---|---|---|
| 6 | Select the managed identity-provider vendor | Decision | Any production environment | **Critical** |
| 1 | Freeze posted rent charges | High | Phase 7 Leasing | **Critical** (before Phase 7) |
| 2 | Prevent reducing a payment below its allocations | High | Phase 7 | **Critical** (before Phase 7) |
| 3 | Require allocation reversal before void, bounce or refund | High | Phase 7 | **Critical** (before Phase 7) |
| 12 | Linked-visibility scope resolver (landlord and tenant portals) | High | Starts in Phase 5 (landlords) | **High** |
| 8 | Wireframes: admin dashboard layout and agent desktop home | Medium | Phase 5 | **High** (blocks Phase 5 interface) |
| 5 | Landlord visibility of offers, deals and viewing feedback | Medium | Phase 6 | **Medium** |
| 9 | Wireframe: landlord portal home | Medium | Phase 7 | **Medium** |
| 4 | Retention purge of document versions | Medium | Phase 10 | **Medium** |
| 11 | Platform Owner and Super Admin consoles | Medium | Phase 14 | **Medium** |
| 10 | Wireframe: technician job list | Low | Phase 8 | **Low** |

Issue #7 (gallery and map wireframes) was closed on 30 October after the implemented screens were checked against the wireframes.

## 4. Deferred features

Each was deferred by an approved decision, with the reason recorded.

| Feature | Deferred to | Reason | Classification |
|---|---|---|---|
| Seller identity (KYC) for the publish rule | Phase 5 (ownership) | Needs owners and contacts; the setting fails closed until then | **High** (Phase 5 scope) |
| Contacts as key holders (A-3); "Call" on the field visit | Phase 5 | Needs contacts | **Medium** |
| Listing syndication to portals and website, SEO metadata (PRP-10, G5, G8) | Phase 12 integrations | Should-have; `is_published` stays the source of truth | **Medium** |
| Portal reading of notes, media and listings | Phase 7 (needs #12) | Portals not built; staff endpoints reject portal memberships | **Medium** |
| Viewings, offers and deals tabs; work queue | Phase 6 | Modules not built | **Medium** |
| Notifications (quota warnings, mandate expiry, approval queue) | Phase 12 | Events are emitted now; no delivery yet | **Medium** |
| Plan prices and entitlements (MD-8); storage add-ons | Phase 14 | Product decision; storage quotas seeded per plan | **Medium** |
| Lease templates, legal rule values, tax codes, holidays, FX rates (MD-7) | Phases 7 and 9 | Needs legal and finance review | **High** (blocks Leasing and Finance) |
| Seeded reminder rules (MD-6) | Phase 12 | Automation engine | **Low** |
| Offline mode | Not planned (W-D6) | Responsive web only | **Low** |
| Long-press drag for gallery order on touch | Optional (T-3) | Arrow buttons and "Move to position" cover the need | **Low** |

## 5. Known technical debt

| ID | Item | Impact | Classification |
|---|---|---|---|
| TD-1 | API tests fail intermittently on GitHub but pass locally. Identical code passed in run 9 and failed in run 7. There are two patterns: most runs end with an ordinary test failure after 120–187 s (runs 7, 10, 26), and some are cut off with the step left "in progress" (runs 20, 27). Leading hypotheses: hard performance budgets on the 2 vCPU private-repository runner, and memory pressure (ClamAV, image processing, Postgres). **Unconfirmed**: see the [Stabilisation Plan](PHASE-4-STABILISATION-PLAN.md) §2. *(Corrected 30 October: an earlier version said every failure was a cut-off.)* | No merge gate; regressions can land unseen | **Critical** |
| TD-2 | The web end-to-end job has never run on GitHub | Browser and accessibility regressions unguarded | **Critical** (fixed by TD-1) |
| TD-3 | Rate limits (map, geocoder) are held in each API instance's memory | With several instances, the effective limit multiplies | **Medium** |
| TD-4 | Upload type and size rules are copied by hand from the API into the web app | The two can drift; the API and worker still check | **Low** |
| TD-5 | The listing register fetches publishing blockers once per draft row | Extra requests on large draft lists | **Medium** |
| TD-6 | Saved views are kept in browser storage | Not shared across devices; lost when the browser is cleared | **Low** |
| TD-7 | The end-to-end suite runs serially (about 5 minutes) on one shared seeded database | CI time grows with every phase | **Medium** |
| TD-8 | Screen components have no unit coverage figure; they are covered only by end-to-end tests | Branch-level gaps in screens are invisible | **Medium** |
| TD-9 | Lifecycle transitions are enforced in the application only, not the database (audit IS-4) | A direct SQL write could bypass rules | **Medium** |
| TD-10 | Monthly audit-log partitions need a deployment job (the table owner runs it, not the worker) | Inserts fail at month end if the job is missing | **High** (operational) |
| TD-11 | Database test gaps: deposits, statement arithmetic, number sequences, concurrent allocations, RLS catalogue (audit IS-11) | Finance-domain risk | **High** (before Phases 7 and 9) |
| TD-12 | Map cards show no thumbnail when results are clustered (more than 500) | Cosmetic | **Low** |
| TD-13 | D-1 panel visibility approximates the role table through `listing.approve_price`; maintenance staff see Media and Activity tabs | Minor role-presentation gaps; the API still scopes the data | **Low** |
| TD-14 | 9 Stylelint warnings; Prettier not enforced | Style consistency only | **Low** |
| TD-15 | Phase 4 branch not merged to `main`, with no pull request or human review of 26 commits | Large unreviewed change set | **High** |

## 6. Unresolved audit findings (pre-Phase-4 audit)

| Finding | Status | Classification |
|---|---|---|
| A1–A3 / IS-1, money integrity | Open (#1–#3) | **Critical** before Phase 7 |
| IS-3: `statement_lines` not frozen when a statement is issued | Open, **with no GitHub issue**; recommend filing one | **Critical** before Phase 7 and Phase 9 |
| A4 / IS-2, document-version retention purge | Open (#4) | **Medium** (Phase 10) |
| IS-4, lifecycle transitions application-only | Open (TD-9) | **Medium** |
| IS-6, support-access grants not enforced against platform reads | Open | **High** before any support tooling or production data |
| IS-7, field-encryption key management (`*_encrypted` columns) | Open; **becomes urgent in Phase 5**, when contact data (personal data) arrives | **High** |
| IS-8, component visual specifications | Partly resolved (tokens, UI consistency checklist) | **Low** |
| IS-9, portal authentication default | Open (decision) | **Medium** (before Phase 7) |
| IS-10, localisation workflow | Partly resolved: English and Arabic files and a key and placeholder checker exist. **Arabic copy has not been reviewed by a native speaker**, and there is no translation workflow | **High** for the Qatar launch |
| IS-11, database test gaps | Open (TD-11) | **High** |
| MD-1 to MD-4, missing wireframes | Open (#8–#11) | as in §3 |
| MD-6 to MD-8, unseeded reference data | Deferred (§4) | as in §4 |
| MD-5 (OpenAPI), IS-5 (company sign-up path), MD-9 and MD-10 (#7) | **Resolved** | — |

## 7. Performance benchmarks

Measured on 30 October on a single development container. These are not production-like: there is no concurrency or load testing, no network latency, and no production hardware.

**API (100,000 listings)**

| Query | Measured | Target |
|---|---|---|
| Listing search, 64 typical queries | median 27 ms, p95 232 ms, slowest 283 ms | p95 < 1 s |
| Radius search | p95 199 ms | < 1 s |
| Distance-sorted pages | p95 181 ms | < 500 ms |
| Map, city zoom | p95 229 ms | < 500 ms |
| Map, country zoom (clustered) | p95 588 ms | < 800 ms |
| Polygon search, 100 vertices | p95 67 ms | < 1 s |
| Notes list | p95 26 ms | < 300 ms |
| 12 MP photo processing | 2.17 s per photo | < 3 s |
| 60-item gallery with 240 signed URLs | p95 132 ms | — |

**Web** (production build, cold cache)

| Screen | Time to data | LCP | JavaScript |
|---|---|---|---|
| Dashboard | 1.14 s | 0.49 s | 244 KB |
| Property register | 1.13 s | 1.03 s | 232 KB |
| Property overview (mini map) | 1.00 s | 0.80 s | 551 KB |
| Listing register | 0.92 s | 0.88 s | 234 KB |
| Media | 0.80 s | 0.64 s | 247 KB |
| Notes | 1.08 s | 0.81 s | 243 KB |
| Key register | 0.95 s | 0.18 s | 246 KB |
| Property map (54 pins) | 2.58 s | 1.10 s | 534 KB |

**Gap:** no load test of concurrent users, worker throughput under a backlog, or database connection-pool sizing. Classification: **High** before launch.

## 8. Security findings

**Controls in place**

| Area | Controls |
|---|---|
| Tenancy | <ul><li>Row-level security, with all company data reached through a transaction-local company context</li><li>Scope applied before counting and clustering</li></ul> |
| Sign-in and sessions | <ul><li>OIDC with PKCE, state and nonce</li><li>Server-side sessions with AES-256-GCM-sealed tokens bound to the session hash</li><li>HttpOnly cookies</li><li>CSRF (Origin and token) on every write</li><li>Per-request nonce CSP</li><li>Single-flight token refresh</li></ul> |
| Writes | <ul><li>If-Match and Idempotency-Key</li><li>Audit log and outbox in the same transaction</li></ul> |
| Uploads | <ul><li>Signed upload URLs bound to type and size</li><li>Malware scan fails closed</li><li>Content sniffing</li><li>EXIF and GPS removal</li><li>No embedded third-party players</li></ul> |
| Location and notes | <ul><li>No address text in logs</li><li>Note redaction covers every revision</li></ul> |

**Findings**

| ID | Finding | Status | Classification |
|---|---|---|---|
| S-1 | The BFF accepted `.` and `..` path segments, which could reach API routes outside `/api/v1` | **Fixed** in M6 (`c9c55c5`), with tests | Closed |
| S-2 | Dependency advisory: `zod` < 4.6.6 (API), memory exhaustion on oversized constrained collections. The API validates untrusted input with zod | Open; upgrade | **High** |
| S-3 | Dependency advisory: `multer` < 2.5.0 (DoS), pulled in through `@nestjs/platform-express`. The API registers no file interceptors (uploads go direct to storage), so exposure is believed low | Open; upgrade | **Medium** |
| S-4 | Four `postcss` advisories (2 high, 2 moderate) through `next`. They affect CSS processing at build time, on our own stylesheets | Open; upgrade Next | **Low** |
| S-5 | No dependency scanning, SAST, secret scanning or Dependabot in CI | Open | **High** |
| S-6 | Identity-provider vendor not chosen (#6); the production MFA and refresh-rotation behaviour is unverified | Open | **Critical** |
| S-7 | Support-access grants not enforced (IS-6) | Open | **High** |
| S-8 | Field-encryption key management (IS-7) | Open | **High** before Phase 5 personal data |
| S-9 | Portal isolation inside a company would be application-only. Portal RLS as defence in depth is planned with #12 | Open | **High** (Phase 5 to 7) |
| S-10 | CSP allows `'unsafe-inline'` styles (needed by React style attributes) | Accepted | **Low** |
| S-11 | Data residency: one EU R2 bucket for Ghana and Qatar media needs legal confirmation; geocoder storage terms must be reconfirmed | Open | **High** (launch blocker) |
| S-12 | No penetration test (planned for Phase 15) | Open | **Medium** now, **Critical** before launch |

## 9. Accessibility findings

| Area | Finding | Classification |
|---|---|---|
| Automated | axe (WCAG 2.1 A/AA) passes on every M6 screen: 27 English and 18 Arabic screens, at 1280 px and at 320 px, with no sideways scroll | — |
| Fixed | Dashboard link names differed from their visible text (2.5.3), fixed in M6 | Closed |
| Keyboard | Full keyboard operation, including map pins, radius and draw tools and the location pin. Drag alternatives (2.5.7) are in place | — |
| Gap | No manual screen-reader pass (NVDA, VoiceOver, TalkBack) | **High** |
| Gap | ADR-002 commits to **WCAG 2.2 AA**; the automated rules cover 2.1. The 2.2-only criteria (2.4.11 focus not obscured, 2.5.8 target size, 3.3.7 redundant entry, 3.3.8 accessible authentication) are not formally verified | **High** |
| Gap | W-D10 usability testing ("week 1") has not taken place | **High** |
| Gap | The Arabic interface has not been reviewed with native-speaking users (wording and right-to-left reading order) | **High** (Qatar) |
| Note | The identity provider's sign-in pages are outside our control. Their accessibility (3.3.8) must be part of the vendor choice (#6) | **Medium** |

## 10. Infrastructure requirements

Nothing below is provisioned yet; only the local and CI environments exist.

| Component | Requirement |
|---|---|
| Database | <ul><li>PostgreSQL 16 with PostGIS 3.4</li><li>Roles `estatepro_app`, `estatepro_auth`, `estatepro_platform`, `estatepro_web`</li><li>Migrations 0001–0020</li><li>Point-in-time recovery backups</li><li>Monthly partition job (TD-10)</li><li>Connection pooling sized after load testing</li></ul> |
| API | Node 22 containers, behind TLS, scaled horizontally. Rate limits need a shared store once there is more than one instance (TD-3) |
| Worker | Node 22 with a ClamAV sidecar (about 1.5 GB RAM, signature updates) and Poppler. Can scale out, because jobs are claimed with SKIP LOCKED |
| Web | Next.js server (Node 22) |
| Object storage | <ul><li>Cloudflare R2 media bucket (jurisdiction per S-11) and tile bucket</li><li>CORS rules for both, as documented</li><li>CDN for tiles and variants</li></ul> |
| Basemap | PMTiles archive built with `scripts/build-basemap.sh` |
| Identity | Managed OIDC provider (#6) with PKCE, refresh rotation, MFA and an end-session endpoint |
| Third parties | Geocoding key (Mapbox candidate; suggest-only) |
| Secrets | `WEB_SESSION_KEY`, database credentials, storage keys and the OIDC client, in a secrets manager |
| Observability | **None yet.** Structured logs exist. Metrics, tracing, uptime checks, error tracking and alerting are needed (worker backlog, scan failures, purge runs) |
| Environments | Staging and production, with separate buckets, databases and identity-provider tenants |

## 11. CI/CD status

| Job | Status on GitHub (latest run 27, `f5ca548`) |
|---|---|
| Database migrations and SQL tests | ✅ Pass |
| Web: lint, typecheck, messages, unit tests with coverage, production build | ✅ Pass |
| API: lint, typecheck, build | ✅ Pass |
| API: tests with coverage | ❌ **Fail, intermittent.** Usually an ordinary test failure; twice the step was cut off (TD-1). The same suite passes locally: 288 of 288 tests; 97.1% statements, 92.6% branches |
| Web end-to-end (Playwright, axe, performance) | ⏭ **Skipped** (needs the API job). Never run on GitHub. Passes locally, 55 of 55 |

History: 1 green run in the last 20, all red since the M4 code landed (run 7). Earlier milestone reports described the checks as "enforced in CI"; the gate exists in the workflow but has not been passing.

There is **no continuous delivery**: no build artifacts or images, no deployment pipeline, no environment promotion, no migration runner for deployments.

Classification:

| Item | Classification |
|---|---|
| CI red (TD-1, TD-2) | **Critical** |
| No delivery pipeline | **High** |

## 12. Launch readiness assessment

| Area | Rating | Basis |
|---|---|---|
| Functional scope, Phase 4 | 🟢 Ready | All milestones delivered and tested locally; every wireframe implemented |
| Code quality and tests | 🟡 Conditional | Strong suites and coverage, but CI does not currently prove them (TD-1) and there has been no human code review (TD-15) |
| Security | 🔴 Not ready | Identity provider undecided; dependency advisories; no scanning or pen test; IS-6 and IS-7 open; data residency unconfirmed |
| Accessibility | 🟡 Conditional | Automated checks pass; manual, WCAG 2.2-only and usability testing outstanding |
| Performance | 🟡 Conditional | Every single-user target met with margin; no load testing |
| Infrastructure and operations | 🔴 Not ready | Nothing provisioned; no delivery pipeline, monitoring or backups |
| Data integrity, later domains | 🔴 Blocking for Leasing and Finance | #1–#3 and IS-3 |
| Localisation | 🟡 Conditional | Arabic complete, not natively reviewed |

**Overall: not launch-ready.**

Phase 4 is a solid, demonstrable foundation for continuing development. The path to a pilot launch is mainly infrastructure, security decisions and verification, not more features.

### Prioritised backlog (all items)

| Priority | Items |
|---|---|
| **Critical** | <ul><li>TD-1 and TD-2: CI red and the end-to-end job never run</li><li>#6 / S-6: identity-provider vendor</li><li>#1, #2, #3 and IS-3: money integrity, before Phase 7</li><li>S-12: penetration test, before launch</li></ul> |
| **High** | <ul><li>#12 / S-9: linked-visibility resolver</li><li>#8: Phase 5 wireframes</li><li>S-2: zod upgrade</li><li>S-5: dependency and secret scanning</li><li>S-7 / IS-6: support-access enforcement</li><li>S-8 / IS-7: key management</li><li>S-11: data residency</li><li>TD-10: partition job</li><li>TD-11 / IS-11: database test gaps</li><li>TD-15: review and merge Phase 4</li><li>MD-7: legal and finance reference data</li><li>Seller KYC</li><li>Accessibility: screen reader, WCAG 2.2, usability (W-D10)</li><li>Arabic native review (IS-10)</li><li>Load testing</li><li>Delivery pipeline and infrastructure provisioning</li><li>Observability</li></ul> |
| **Medium** | <ul><li>#4, #5, #9, #11</li><li>S-3: multer</li><li>TD-3, TD-5, TD-7, TD-8, TD-9 / IS-4</li><li>IS-9: portal authentication</li><li>Syndication and SEO</li><li>Notifications</li><li>MD-8: plans</li><li>Contacts as key holders</li><li>Identity-provider page accessibility</li></ul> |
| **Low** | <ul><li>#10</li><li>S-4: postcss</li><li>S-10: CSP inline styles</li><li>TD-4, TD-6, TD-12, TD-13, TD-14</li><li>IS-8</li><li>MD-6</li><li>T-3 long-press drag</li><li>Offline mode</li></ul> |

## 13. Recommendations for the next domains

### Before any new domain (about one week)

1. **Make CI green.** Get the API test job's logs (re-run with debug logging, or download them from the Actions page). Confirm the cause, then fix it. Likely options: run the media performance test in its own job or nightly, or cap image-processing concurrency in tests. Then let `web-e2e` run.
2. **Review and merge Phase 4.** Open a pull request from `phase-4/property-management`, and have a human review it by milestone.
3. Upgrade `zod`, `multer` and `next`; add dependency and secret scanning to CI.
4. File an issue for IS-3, and decide #6 (identity-provider vendor).

### Phase 5 — CRM (contacts, ownership, landlords)

- **Prerequisites:**
  - IS-7 key management, because contacts bring personal data (phone, email, IDs);
  - wireframes #8;
  - a data-protection review: lawful basis, retention, subject access and erasure for contacts.
- Build the **landlord part of the #12 resolver** now (SQL scope functions over ownerships and management agreements), with RLS defence in depth. Phases 6 and 7 depend on it.
- Complete the deferred Phase 4 links:
  - seller KYC for the publish rule;
  - contacts as key holders (A-3);
  - the Ownership tab;
  - "Call" on the field visit.
- Reuse the Phase 4 patterns: scoped lists, If-Match, the audit and outbox, the people picker, saved views, and the end-to-end and accessibility harness.
- Plan duplicate detection and merge early; it is hard to retrofit.

### Sales pipeline (Phase 6)

- **Depends on** Phase 5 contacts and the landlord resolver.
- Implement #5 (landlord visibility of offers, deals and viewing feedback) through linked scope, not special cases.
- Viewings should reuse the key register (keys out for a viewing) and the field-visit flow, which saves its feedback as a Viewing note today.
- Keep the pipeline-stage rules in the database where possible (lesson from IS-4).

### Leasing (Phase 7)

- **Hard prerequisites:**
  - fix #1–#3 and IS-3 first, with tests (TD-11);
  - MD-7 lease templates and legal rule values per jurisdiction, reviewed by counsel in Ghana, Qatar and the UK;
  - IS-9 portal authentication decision;
  - #9 landlord portal wireframe;
  - #12 extended to tenants.
- Portals are a new external attack surface. Schedule the security review and penetration test for the portals within this phase, not in Phase 15.
- Lease and inspection evidence must interact with media legal hold and retention (ADR-005).

### Maintenance (Phase 8)

- **Depends on** #10 (technician job list wireframe) and the `assigned` scope already designed.
- Work-order photos should reuse the Phase 4 upload pipeline (scan, strip, variants), but as a separate collection from marketing media, as the M4 decision set out.
- The mobile-first field patterns exist (X-1 to X-3, T-1). Decide early whether technicians need offline capture; W-D6 currently excludes offline.

### Finance (Phase 9)

- **Hard prerequisites:**
  - money-integrity fixes #1–#3 and IS-3;
  - database tests for deposits, statement arithmetic, number sequences and concurrent allocations (IS-11);
  - MD-7 tax codes, holidays and FX rates.
- Keep ADR-003's money rules: decimal strings with a currency, never summed across currencies.
- Treat posted records as immutable, with corrections only through adjustments, enforced in the database.
- Run separation-of-duties and period-locking tests in CI, and get an external accounting review before the first live company.

### Launch track (in parallel from now)

1. Provision staging: database, API, worker with ClamAV, web, R2 buckets with CORS, basemap, identity provider, secrets.
2. Add observability and backups; build a delivery pipeline with a migration step.
3. Load-test the Phase 4 flows.
4. Complete the accessibility programme: screen reader, WCAG 2.2 and W-D10 usability, plus Arabic native review.
5. Run a penetration test before the first external user.
