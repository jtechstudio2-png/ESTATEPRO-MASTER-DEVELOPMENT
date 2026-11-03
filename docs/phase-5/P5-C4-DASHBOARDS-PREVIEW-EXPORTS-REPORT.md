# Phase 5 · Milestone report: C4 Dashboards, landlord visibility preview and exports

| | |
|---|---|
| Date | 3 November 2026 |
| Branch | `phase-5/preparation`, C4 commit (see §10) |
| Approvals | C3 decisions C3-D1 to C3-D9 approved before work started |
| Scope | Dashboards (CA-14; wireframes D-A admin, D-C CRM, D-M My day), landlord visibility preview (CA-15; wireframe LL-1; issue #12, landlord part), contact and lead exports (CA-16) |
| Result | **C4 complete.** Encryption controls, reveal restrictions and tenant isolation unchanged and tested. Every export, download, expiry and preview is audited, and export records cannot be rewritten or deleted. 437 API tests and 9 SQL test suites pass locally; CI run in §10 |

## 1. Deliverables

### 1.1 Database (migration 0025)

| Change | Purpose |
|---|---|
| `app.landlord_unit_access(contact)` returns property, unit, basis (`ownership` or `management_agreement`) and the granting record. Helpers `app.landlord_property_ids` and `app.landlord_listing_ids` | Issue #12, landlord part. One resolver for the staff preview now and the landlord portal in Phase 7. Current ownerships and active management agreements only, judged in the **property's own time zone**, last day inclusive. `SECURITY INVOKER`, so row-level security still applies |
| Indexes on ownerships by owner and on agreements by landlord | Resolver speed |
| `export_jobs`: file name, failure reason, download count. Checks: a completed export has a file, a failed one has a reason | CA-16 |
| `app.export_jobs_guard` trigger: a finished export cannot be rewritten; failed or expired is final. `DELETE` revoked from the application role | Audit integrity: the record of an export outlives its file |
| Requirement area prefilter: generated columns on `requirements` (anywhere flag, area localities, bounding box and its edges) and on `addresses` (`locality_key`, float latitude and longitude), with indexes | Lets "no match" use indexes under row-level security (see §7) |
| `requirement_match_status` (requirement, has match, checked at) with row-level security | Precomputed "no published listing matches" count (C4-D1) |
| Dashboard indexes: contacts without owner, withdrawn consents, KYC expiry, audit by action and time, leads by office and received time, status history by target status | Dashboard panels |

### 1.2 API

| Endpoint | Permission | Wireframe |
|---|---|---|
| `GET /api/v1/dashboards/crm` (office, period 1–365 days, time zone) | `lead.view`, limited to the caller's lead scope | D-C |
| `GET /api/v1/dashboards/admin` (office) | `user.manage` | D-A |
| `GET /api/v1/dashboards/my-day` (time zone) | `lead.view` | D-M |
| `GET /api/v1/contacts/{id}/portal-visibility-preview` (`Cache-Control: no-store`) | `contact.view` and `property.view` | LL-1 |
| `POST /api/v1/contacts/exports` (office, contact type, roles, exclude marketing-withdrawn; purpose required) | `contact.export` | CA-16 |
| `POST /api/v1/leads/exports` (status, type, source, office, assignee, received range; purpose required) | `lead.export` | CA-16 |
| `GET /api/v1/exports`, `GET /api/v1/exports/{id}` | Export permission, or `user.manage` to see everyone's | CA-16 |
| `POST /api/v1/exports/{id}/download` (signed link valid 5 minutes; `no-store`) | The requester only | CA-16 |

Dashboard panels:

- **CRM:** new leads not yet contacted (10 oldest and the total, overdue against the response target); follow-ups overdue, today and this week (team view for managers with `lead.assign`); leads by status for the period; response times per assignee (median first response, within target, qualified; hidden for members who see only their own leads); leads by source; buy and rent requirements and "no match".
- **Admin:** needs-attention list (most urgent five, each linked to the list behind it where one exists); invitations and expiring agent licences; lead flow by office; possible duplicate groups, contacts without owner, identity documents and checks expiring; marketing withdrawals, protected-detail reveals and exports in the last 7 days; recent exports; seats and storage against plan limits.
- **My day:** my follow-ups due today or overdue and my new leads, overdue first; later this week; what is waiting on me; my leads by status.

Worker jobs (every 15 minutes): `export.expire` deletes expired export files and marks them expired; `requirement.match_refresh` refreshes the "no match" status.

## 2. Requirement checklist

| Requirement | How it is met | Evidence |
|---|---|---|
| Encryption controls | No new encrypted fields. Exports never read or decrypt protected values (identity and tax numbers, C3 encrypted fields). Dashboards show counts only | Export test checks the CSV header and that no protected value appears. Encryption suites unchanged and green |
| Reveal restrictions | Unchanged. No C4 endpoint returns a protected value; the admin dashboard counts reveals from the audit log | E4 tests still green |
| Tenant isolation | Row-level security on the new table; resolver is `SECURITY INVOKER`. Every dashboard number is computed inside the caller's scope. Other companies' contacts, exports and offices answer 404 | Isolation tests in both new suites; SQL suite 08 |
| Audit integrity | Export requests (with purpose and filters), downloads, expiries and previews are audited in the same transaction. Export records cannot be rewritten or deleted | Audit assertions; SQL tests "a finished export cannot be rewritten", "the record of an export is never deleted" |
| Performance validation | New test with 50,000 contacts, 100,000 leads, 100,000 follow-ups, 20,000 requirements, 20,000 listings; added to the nightly and release performance workflow | §7 |
| CI verification | All six required jobs | §10 |
| #12 landlord visibility | Ownerships and management agreements, property time zone, effective end date inclusive, units and listings under each | Preview tests and 9 SQL resolver assertions (including tenant isolation) |
| Exports safe to open | UTF-8 with byte-order mark (Excel shows Arabic correctly); cells starting `=`, `+`, `-`, `@`, tab or return are prefixed with `'` | Export test with a formula-like name |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `dashboards.e2e.test.ts` | 5 | ✅ |
| `exports-preview.e2e.test.ts` | 7 | ✅ |
| `requirements.e2e.test.ts` (new: "no match" equals the matches endpoint after a worker run) | 19 | ✅ |
| `dashboards.performance.test.ts` (nightly and release workflow) | 1 | ✅ p95 456–650 ms |
| SQL `database/tests/08_visibility_exports_c4.sql` | 17 assertions | ✅ |
| All SQL suites (25 migrations, 9 files) | — | ✅ |
| Full API suite (`test:ci`, local) | 437 in 33 files | ✅ |
| Contacts, requirements, leads performance tests (re-run after the matching change) | 3 | ✅ p95 330 / 322 / 243 ms |
| Lint, typecheck, OpenAPI regenerated | — | ✅ |

Coverage (whole API): 97.11 % statements, 91.63 % branches, 98.6 % functions, 99.21 % lines (thresholds 95/90 met).

### 3.1 Defects found by the tests and fixed before commit

| Defect | Found by | Fix |
|---|---|---|
| The "qualified" lookup in response times was not limited to the lead's company, so the planner scanned all history (64 s with 100,000 leads) | Performance test | Company condition added; later replaced by one hash join (below) |
| Requirement "no match" took up to 53 s: location conditions could not use indexes under row-level security (numeric, `lower()` and PostGIS operators are not leakproof) | Performance test | Generated plain columns compared with leakproof operators, a planner fence, and a precomputed status refreshed every 15 minutes (C4-D1) |
| Owner CRM dashboard p95 1,160 ms: the per-assignee and per-source tables each looked up status history once per lead | Performance test | One pass over the period's leads with grouping sets, and a single hash join for "qualified": 450–700 ms |
| A requirement saved with a non-array `locations` value failed in the generated column before the validation check could give a clear error | SQL test | Generated column guards the type |
| The bounding box lost its coordinate system (`ST_Extent` returns no SRID), so map comparisons failed | SQL test | `ST_SetSRID(…, 4326)` |
| Admin "needs attention" links pointed at lists that are not built yet | Review | Link is null with the reason in the API description |

## 4. Security validation

| Check | Result |
|---|---|
| Dashboards: an agent sees only their own leads and no per-agent table; an office manager only their offices; an office filter outside scope is refused | ✅ tested |
| Admin dashboard only with `user.manage` | ✅ tested |
| Exports need the export permission and a purpose; contact exports include only contacts the caller may edit; lead exports only leads in scope | ✅ tested |
| Only the requester can download; admins see the list but cannot download; expired exports cannot be downloaded and their files are deleted | ✅ tested |
| Exports never include protected values, notes, activity bodies or enquiry messages | ✅ tested |
| Preview limited to properties the staff member may view; the rest is reported as "limited to your access", not listed | ✅ tested |
| Ended ownerships and inactive agreements give no access; access is judged in the property's time zone | ✅ tested (API and SQL) |
| Cross-company: 404 on every new endpoint | ✅ tested |

## 5. Encryption impact

| Item | Impact |
|---|---|
| New encrypted fields | None |
| Protected values in C4 responses or files | None. Exports contain the primary phone and email (contact methods, not encrypted fields under ADR-007) for contacts the requester may edit |
| Export files | Stored in the same object storage as media, under `exports/{company}/`; deleted after 24 hours by the worker; downloaded only through a 5-minute signed link |
| Key use | None added |

## 6. Audit impact

| Action | Metadata |
|---|---|
| `contact.exported` / `lead.exported` | export id, purpose, filters, row count |
| `export.downloaded` | export type, rows |
| `export.expired` | export type |
| `contact.portal_preview` | portal, number of properties, units and listings shown |

Outbox event: `export.completed` (ready for notifications in Phase 12). The admin dashboard reads reveals and exports from the audit log; it writes nothing.

## 7. Performance results

`dashboards.performance.test.ts`: one company with 50,000 contacts, 100,000 leads across two offices, 100,000 follow-ups, 20,000 requirements, 1,000 properties with 10 units and 2 listings each, and one landlord with 100 properties. Requests go through the full API as owner, sales manager, office manager and agent.

| Measure | Result (two runs) |
|---|---|
| Requests | 30 per run |
| Median | 124–129 ms |
| **p95 (target < 1,000 ms)** | **456 / 650 ms** ✅ |
| CRM dashboard: owner / sales manager / office / agent (max) | 535–712 / 361–372 / 167–322 / 160–276 ms |
| Admin dashboard (all / one office) | 162–228 / 114–124 ms |
| My day (owner / agent) | 107–123 / 35–45 ms |
| Landlord preview (100 properties) | 93–129 ms |
| Contact export (16,666 rows, written to storage; target < 5 s) | 399 ms ✅ |
| Lead export | 180–193 ms |
| "No match" refresh in the worker (20,000 requirements; target < 60 s) | 4.1–4.6 s ✅ |

Optimisation path for the CRM dashboard: 64 s → 19 s → 3–9 s → 1.16 s → 0.45–0.71 s (see §3.1).

## 8. Decisions taken in C4 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| C4-D1 | The "no match" count is precomputed every 15 minutes against all published listings of the company, and shown with the time of the check and how many requirements changed since | A live check over every requirement cannot meet the 1-second target at scale |
| C4-D2 | Every export needs a purpose (5–300 characters), is limited to 50,000 rows, and expires after 24 hours | Data protection (GDPR, Ghana DPA, Qatar PDPPL): record why personal data left the system and keep copies short-lived |
| C4-D3 | Only the person who asked for an export can download it. Admins with `user.manage` see all exports but cannot download others' | Exports are personal data; the list gives oversight without spreading copies |
| C4-D4 | Exports never contain protected values, notes, activity bodies or enquiry messages. Contact exports include phone and email, and only contacts the requester may edit | Free text may hold personal data (R-3); edit scope matches who manages the contact |
| C4-D5 | The landlord preview shows only properties the staff member may view; others are counted as "limited to your access" | Preview must not widen staff access |
| C4-D6 | The `linked` scope (portal users) stays fail-closed until the Phase 7 portals | No portal endpoints in Phase 5 |
| C4-D7 | The admin dashboard needs `user.manage`. "Users without required MFA" and "open data-subject requests" are null, not zero | MFA is held by the identity provider (ADR-001); data-subject requests come with E6 (G3) |
| C4-D8 | A storage lifecycle rule deleting `exports/` objects after 2 days is added to the deployment checklist, as a backstop to the worker | Files must not outlive their record if the worker stops |

## 9. Risks and open items

| Item | Status |
|---|---|
| "No match" can be up to 15 minutes old | Shown with check time and pending count (C4-D1) |
| Export files depend on the worker for deletion | Storage lifecycle rule on the deployment checklist (C4-D8) |
| Tenant, buyer and vendor parts of #12 | Phase 7 portals; the resolver pattern is ready |
| Data-subject requests | E6 |
| Web screens for C1–C4 | C5 |
| Free text containing personal data (R-3 / WR-1) | Accepted; tracked in #35. Free text is never exported |

## 10. GitHub references

| Reference | Link |
|---|---|
| C1, C2 and C3 reports | `docs/phase-5/P5-C1-CONTACTS-REPORT.md`, `docs/phase-5/P5-C2-REQUIREMENTS-KYC-REPORT.md`, `docs/phase-5/P5-C3-LEADS-ACTIVITIES-REPORT.md` |
| Wireframes (#8, closed) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/8 |
| Portal visibility (#12) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/12 |
| Sensitive-data detection (#35) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/35 |
| Branch | `phase-5/preparation` |
| C4 commit and CI run | Recorded after CI completes |
