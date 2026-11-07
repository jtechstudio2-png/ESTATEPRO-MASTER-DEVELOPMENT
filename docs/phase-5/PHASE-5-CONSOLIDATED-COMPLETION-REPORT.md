# Phase 5 · CRM — Consolidated Completion Report

| | |
|---|---|
| Date | 7 November 2026 |
| Branch | `phase-5/preparation` (not yet merged to `main`; see §8.1) |
| Period | 1–7 November 2026: readiness gate, encryption E1–E6, CRM C1–C6, data-subject requests G3, completion P5-H |
| Status | **Phase 5 planned work approved as complete** (product owner, 7 November 2026). This report is for review before major Phase 6 work begins |
| Final CI | Run 95 green on `0589ffc` (all six jobs); report-only commits since |

## Executive summary

Phase 5 delivered the CRM: contacts, requirements and matching, identity checks, leads, activity and follow-ups, dashboards, exports, the landlord view, ownership records and a register of data-subject requests. Personal data is protected by field encryption, a reveal flow with a second factor, key rotation, and erasure that survives restores (ADR-007, E1–E6). Every milestone was approved with its decisions; the approved scope was not widened.

What stops a launch is no longer in the application's feature set. It is the launch track: hosting and the key-management service (#28, E7, E8), the identity-provider choice (#6), the legal review of country rules and data residency (#20), the penetration test (#21), load testing (#27), and the accessibility and Arabic reviews (#24, #25). Finance-integrity work (#1–#3, #13) is a hard prerequisite of leasing (Phase 7), not of Phase 6.

**Recommendation:** merge `phase-5/preparation` into `main` through a reviewed pull request, run a short Phase 6 readiness gate (wireframes and decisions for viewings, offers and deals; #5), then start Phase 6 milestone by milestone as in Phase 5. Start #28 and #6 now, in parallel, because they gate every shared environment.

## 1. Completed scope

### 1.1 Milestones

| Milestone | Delivered | Report | CI |
|---|---|---|---|
| Readiness gate | Gate criteria G1–G12 met or accepted; risk register re-rated; #14–#28 filed | `PHASE-5-READINESS-REPORT.md` | — |
| E1–E4 Field encryption | Crypto core (AES-256-GCM envelope per company, HMAC lookup hashes), company keys (migration 0021), log redaction and index rules, reveal with second factor, reason and audit | `P5-E1-E4-ENCRYPTION-REPORT.md` | green |
| C1 Contacts | Register, record, create and edit, duplicate detection, merge (never automatic), archive, consents, masking (migration 0022) | `P5-C1-CONTACTS-REPORT.md` | run 66 |
| C2 Requirements and KYC | Requirements with areas and exclusions, matching (D4), identity documents (encrypted numbers), identity checks with sign-off (migration 0023) | `P5-C2-REQUIREMENTS-KYC-REPORT.md` | run 68 |
| C3 Leads and activity | Lead inbox and lifecycle, response target, activity timeline with edit window and revisions, stable order, follow-ups (migration 0024) | `P5-C3-LEADS-ACTIVITIES-REPORT.md` | run 70 |
| C4 Dashboards, preview, exports | Admin, CRM and My day dashboards; landlord visibility resolver and preview (#12, landlord part); governed exports (migration 0025) | `P5-C4-DASHBOARDS-PREVIEW-EXPORTS-REPORT.md` | run 72 |
| C5 CRM web screens | Every approved CRM wireframe (SH-1, D-A, D-C, D-M, C-1 to C-6, B-1, B-2, SE-1, LL-1, L-1 to L-4, A-1, A-2, F-1, F-2, mobile and tablet) | `P5-C5-CRM-WEB-SCREENS-REPORT.md` | run 75 |
| C6 Gap closure | Per-contact summary columns, company-wide identity-check queue, localised API text, typed OpenAPI bodies | `P5-C6-CRM-GAP-CLOSURE-REPORT.md` | run 78 |
| E5–E6 Rotation and erasure | Key rotation without downtime; erasure, crypto-shredding, erasure ledger, restore replay, recovery drill, runbook (migration 0026) | `P5-E5-E6-ROTATION-ERASURE-REPORT.md` | run 83 |
| G3 Data-subject requests | Register of access and erasure requests: lifecycle, assignment, due dates, evidence, history, merge blocking, dashboard and contact integration (migration 0027) | `P5-G3-DATA-SUBJECT-REQUESTS-REPORT.md` | run 87 |
| P5-H Completion | Ownership records and Ownership tab, seller identity publish rule (#18), storage limits (#14) (migration 0028) | `P5-H-PHASE-5-COMPLETION-REPORT.md` | run 95 |

All decisions raised in these reports were approved: D1–D7 (wireframes), the C-series decisions, E56-D1 to E56-D7, G3-D1 to G3-D8 and H-D1 to H-D8.

### 1.2 Size at the end of Phase 5

| Measure | Value |
|---|---|
| Database migrations | 28 (0021–0028 in Phase 5) |
| SQL test files | 12 (verify script; all pass) |
| API tests (`test:ci`) | 480 in 39 files; coverage 95.94 % statements, 90.48 % branches, 98.40 % functions, 98.19 % lines |
| API performance suites (nightly) | 8 |
| Browser tests (Playwright) | 94, including the axe sweep of every screen in English and Arabic at desktop and 320 px, and the performance spec |
| Web unit tests | 79; coverage 98.14 % statements, 91.41 % branches |
| Message keys | 2,570 in each of English and Arabic |

### 1.3 Issues closed in Phase 5

| Issue | Closed by |
|---|---|
| #8 Admin dashboard and My day wireframes (with the full CRM wireframe set) | Approved wireframes and verification (D1–D7), 1 November |
| #14 Storage client timeouts | P5-H |
| #18 Seller identity for the publish rule | P5-H |

## 2. Deferred scope

Deliberately left out of Phase 5, each with its destination.

| Item | Why deferred | Destination |
|---|---|---|
| Deals, offers, viewings and lead conversion | Sales pipeline is Phase 6; panels are hidden, not empty; the database refuses conversion without a deal | **Phase 6** |
| Landlord visibility of offers, deals and viewing feedback (#5) | Needs the Phase 6 modules; the landlord resolver it relies on exists | **Phase 6** |
| Key sets checked out to a contact (wireframe A-3) | The API accepts a contact holder, but the screen still shows the option as unavailable, and the API does not yet check that the member may see that contact | **Phase 6** (viewings use keys) |
| "Call" from the field visit (X-1) | Small Phase 4 link not picked up | **Phase 6** (viewings) |
| Deterministic order for the remaining history streams (#15) | Done for the activity timeline (C3); listing status and price history, notes revisions, key register and audit log still tie-break on UUIDv7 | Phase 6, before deal history is built |
| Tenant, buyer and vendor parts of the visibility resolver (#12) | Portals are Phase 7 | Phase 7 |
| Notifications for assignments, reminders and renewals | Outbox events are written now | Phase 12 |
| Documents: identity scans, evidence files, contact Files tab | Columns exist | Phase 10 |
| Lead scoring rules (D7) | Display ready, no rules | Later, by decision |
| Rectification and objection requests | An edit of the contact and a consent change already cover them | Not planned |
| Four-eyes KYC sign-off (#36) | Future enhancement | Not scheduled |
| Detection of personal data in free text (#35, R-3 / WR-1) | Accepted risk for Phase 5; field help warns staff | Not scheduled |
| Cloud key-management adapter (E7) and key monitoring (E8) | Need hosting | With #28 |
| Storage metrics shipped to monitoring | In-process counters exist (#14) | With #28 |

## 3. Open issues

27 issues were open on 7 November 2026 before #14 and #18 closed; 25 remain.

| # | Title (short) | Severity | Target | Phase 5 effect |
|---|---|---|---|---|
| 6 | Identity-provider vendor | Critical | Decision | Accepted: Phase 5 used the test provider. **No shared environment until closed** |
| 13 | Statement integrity and ledger finalisation | Critical, launch blocker | Phases 7, 9 | None |
| 21 | Penetration test | Critical, launch blocker | Phase 15 (portals in 7) | None |
| 1, 2, 3 | Rent charge and payment allocation integrity | High | Phase 7 | None; hard prerequisite of leasing |
| 12 | Linked visibility resolver | High | Phases 5, 7 | Landlord part delivered (C4); tenant part remains |
| 17 | Field-encryption key management | High | Phase 5 | E1–E6 delivered; E7 and E8 remain with #28. Keep open |
| 19 | Support-access grants on platform reads | High, launch blocker | Phase 14 | None |
| 20 | Data residency and legal review | High, launch blocker | Phase 16 | Country rules stay off; response periods to confirm |
| 22 | Database test gaps (finance) | High | Phase 7 | None |
| 23 | Legal and finance reference data | High | Phases 7, 9 | None |
| 24 | Accessibility verification (screen reader, WCAG 2.2-only, usability) | High | Pre-launch | Automated axe passes on every screen; manual pass outstanding |
| 25 | Arabic native-speaker review | High | Pre-launch | All Phase 5 strings included |
| 26 | Monthly audit-log partition job | High | Phase 16 | Audit volume grows with CRM |
| 27 | Load testing against NFR targets | High, launch blocker | Phase 16 | Single-machine performance tests only |
| 28 | Infrastructure, delivery and observability | High, launch blocker | Phase 16 | Gates E7, E8, ledger object lock, storage lifecycle rules |
| 5 | Landlord visibility of offers, deals, viewings | Medium | Phase 6 | — |
| 9, 10, 11 | Wireframes and platform consoles | Low–Medium | Phases 7, 8, 14 | None |
| 4 | Retention purge of document versions | Medium | Phase 10 | None |
| 15 | Deterministic history ordering | Medium | — | Partly done (§2) |
| 35 | Personal data in free text | Medium | — | Accepted risk |
| 36 | Four-eyes KYC sign-off | — | — | Enhancement |

Dependency pull requests #29–#34 (Dependabot) are open against `main`, including major upgrades (Next.js 16, TypeScript 7). None was taken in Phase 5.

## 4. Performance summary

Budgets: API p95 under 1,000 ms at production-like volumes; screens ready and largest paint under 4,000 ms with at most 300 KB of script (production build, cold cache). All measured on one development machine; load testing at scale is #27.

### 4.1 API (nightly performance suites)

| Domain | Volume | p95 | Notes |
|---|---|---|---|
| Contacts (C1) | 100,000 contacts | 516 ms ✅ | 2,181 ms before index work |
| Requirements, matching, KYC (C2, re-measured C6) | 50,000 requirements, 40,000 listings, 50,000 documents and checks | 607–774 ms ✅ | Slowest single request 1.4 s (100-row page, risk C2-R1) |
| Leads, activity, follow-ups (C3) | 100,000 leads, 300,000 activities | 227 ms ✅ | No tuning needed |
| Dashboards, preview, exports (C4) | 50,000 contacts, 100,000 leads | 456–650 ms ✅ | CRM dashboard tuned from 64 s; 16,666-row export in 0.4 s |
| Key rotation and erasure (E5–E6) | 25,000 encrypted values | ≈ 2,100 values/s ✅ | Erasing a busy person: 121 ms |
| Encryption cost (E1) | — | 14 µs encrypt, 8 µs decrypt | Lists never decrypt |

### 4.2 Screens (Playwright performance spec)

| Screen | Ready | Script |
|---|---|---|
| Admin, CRM, My day dashboards | 340–670 ms | 222–225 KB |
| Contact register and record | 290–470 ms | 227–260 KB |
| Lead inbox and record | 330–660 ms | 239–241 KB |
| Sellers view, identity checks | 310–450 ms | 229–233 KB |
| Privacy requests register and request | 180–360 ms | 229–239 KB |
| Ownership tab, Add ownership | 195–292 ms | 241–242 KB |

All within budget. The largest bundle is the contact record at 260 KB (87 % of budget).

### 4.3 Performance risks

| Risk | Status |
|---|---|
| C2-R1: 100-row requirements page about 1.4 s | Low; default page is 50; option to precompute area geometry |
| API worker tests share a database with performance data when run together | Test isolation only; CI runs them separately |
| No multi-node or network-latency figures | #27 |

## 5. Security summary

| Area | Control | Evidence |
|---|---|---|
| Tenant isolation | Row-level security on every new table; company-bound foreign keys; another company's records answer 404 | SQL suites 05–11; isolation tests in every API suite and the browser sweep |
| Record-level access | Role scopes (all, office, own, assigned) on contacts, leads, properties, ownership, privacy requests; decision D1 (agents read contacts behind their leads and tasks) | API permission tests per milestone |
| Protected personal data | AES-256-GCM per field with per-company keys; exact-match HMAC lookups; masked by default; no protected value in lists, exports, logs, audit rows or URLs | Encryption, log-leak and export tests |
| Reveal | `contact.view_sensitive`, second factor within the reveal window, reason, audit, `no-store` | E4 and C5 tests |
| Key management | Rotation of field and lookup keys without downtime; company shred | E5 tests and drill |
| Erasure | Anonymise everywhere, keep legally required records, erasure ledger, restore replay so a restore cannot bring data back | E6 tests and recovery drill |
| Audit integrity | Append-only histories (leads, activities, privacy requests, ownership, exports); guarded updates; no deletes by the runtime role | SQL suites |
| Exports | Purpose required, 24-hour expiry, maker-only download, every download audited, records immutable | C4 tests |
| Storage | Bounded timeouts and retries; typed errors; no credentials in logs | P5-H tests |

### 5.1 Security items open after Phase 5

| Item | Severity | Owner issue |
|---|---|---|
| Only the local key provider exists; no KMS, no key-use monitoring | High | #17 (E7, E8), #28 |
| Identity provider not chosen; production MFA and refresh-token rotation unverified | Critical | #6 |
| No penetration test | Critical | #21 |
| Support access to tenant data not enforced on platform reads | High | #19 |
| Personal data typed into free text is not detected | Medium, accepted | #35 |
| Erased data remains in backups until they expire (ledger prevents restore) | Accepted (R-2) | Retention with #28 |
| Ledger bucket object lock and separate credentials | High | #28 |
| Key check-out to a contact does not check the member's contact scope (§2) | Low | Fix with A-3 in Phase 6 |

## 6. Compliance summary

| Requirement | Status |
|---|---|
| Consent recording per purpose and channel, withdrawal honoured in messaging actions | Done (C1, C5) |
| Access requests: report of everything held, including protected values, under second factor | Done (G3) |
| Erasure requests: erasure with legal-hold blockers, ledger, merge blocking while open | Done (E6, G3) |
| Response periods: 30 days, one extension to 60 days | Implemented as a single rule (G3-D3); Ghana and Qatar periods await #20 |
| Identity verification (KYC) with documents, sign-off, expiry and renewal state | Done (C2, C6) |
| Seller and landlord identity before publishing | Done (#18); company setting live; country rule off until #20 |
| Data residency (Ghana, Qatar, UK) | **Open (#20)**; blocks production deployment in Ghana and Qatar |
| Country rule values (deposits, advance rent, identity rule) | Held as data, none activated without legal review (#20) |
| Accessibility (WCAG 2.2 AA, ADR-002) | Automated checks pass on every screen in both languages; manual verification open (#24) |
| Arabic language quality | Machine-checked completeness; native review open (#25) |
| Audit trail for personal-data access | Every reveal, export, download, preview, erasure and privacy action audited |

## 7. Remaining launch blockers

| # | Blocker | Needed before |
|---|---|---|
| #6 | Identity-provider vendor decided and integrated (MFA, refresh rotation) | Any shared environment |
| #28 | Hosting, delivery pipeline, observability; with it E7 (KMS), E8 (key monitoring), ledger object lock, storage lifecycle rules | Any shared environment |
| #20 | Data residency and legal review; country rules and response periods | Production in Ghana and Qatar; activating any country rule |
| #21 | Penetration test (portals reviewed in Phase 7) | First external user |
| #27 | Load testing against NFR targets | Launch |
| #19 | Support-access grants enforced on platform reads | Launch |
| #13 | Statement integrity and ledger finalisation | Finance go-live (Phases 7, 9) |
| #24 | Manual accessibility verification | Launch |
| #25 | Arabic native-speaker review | Launch |
| — | Real-backup restore drill and emergency key-rotation drill (runbook §6) | Launch, after #28 |

## 8. Recommendations for Phase 6 (sales pipeline)

### 8.1 Before Phase 6 begins

1. **Merge Phase 5 into `main`.** Open a pull request from `phase-5/preparation` (34 CI runs on the branch; the latest code run, 95, is green), review it, and merge. Phase 6 branches from `main`, as Phase 5 did after #16.
2. **Triage the Dependabot pull requests (#29–#34)** after the merge. Take minor and patch groups; plan Next.js 16 and TypeScript 7 as a separate stabilisation task, not inside a feature milestone.
3. **Phase 6 readiness gate**, in the Phase 5 format: wireframes for viewings, offers, deals and the pipeline board; the landlord views of each (#5); decisions on pipeline stages, offer rules, deal parties and KYC at deal stage (the existing `sales_kyc_required` rule); performance budgets for the pipeline.
4. **Finish #15** (deterministic order for every history stream) before deal and offer histories are written.

### 8.2 Phase 6 scope proposal (for the readiness gate)

| Proposed milestone | Content | Builds on |
|---|---|---|
| S1 Viewings | Book, confirm, record feedback; keys out for a viewing (A-3, with the contact-scope check); "Call" from the field visit | Key register, field visit, contacts, follow-ups |
| S2 Offers | Offers on listings with conditions, counter-offers, history; landlord view (#5) | Listings, contacts, landlord resolver |
| S3 Deals and conversion | Lead conversion to a deal (the database guard exists); deal parties with KYC at deal stage; stage rules in the database | Leads, KYC, ownership records |
| S4 Pipeline screens and dashboards | Pipeline board, deal record, dashboard figures, the hidden "no viewing in 21 days" item | C5 patterns |

Apply the same standards as Phase 5: tenant isolation, encryption and reveal controls, append-only histories, audit, accessibility and localisation checks, performance budgets, CI on every push, a milestone report per milestone.

### 8.3 In parallel (launch track)

- Decide #6 and start #28 now; they gate every shared environment and E7/E8.
- Schedule #24 and #25 with external reviewers; both grow with each phase, so earlier is cheaper.
- Start the legal review (#20) for Ghana and Qatar: data residency, response periods, and the values of the country rules already held as data.
- Plan the finance-integrity fixes (#1–#3, #13) before Phase 7 begins.

## Approval

Awaiting product owner review. No major Phase 6 work starts until this report is reviewed.
