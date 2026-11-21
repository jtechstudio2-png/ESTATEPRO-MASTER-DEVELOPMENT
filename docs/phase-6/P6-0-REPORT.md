# Phase 6 · Milestone report: P6-0 Sales-pipeline readiness and governance

| | |
|---|---|
| Date | 13 November 2026 (implementation 12 November; review 13 November) |
| Branch | `phase-6/readiness` (from `main` at `5ef896c`, after pull request #39), commits `3b6c329` (implementation), `2b22e6b` (documentation), `bc94bae` and `3a2e134` (review fixes), then this report; CI run 112 (`c2924f8`, green) |
| Approvals | Phase 5 complete and P5-H decisions H-D1 to H-D8 approved (12 November 2026). Phase 6 Readiness Report and P6-D1 to P6-D14 approved (13 November 2026). R9 decision: commits `3b6c329` and `2b22e6b` kept on `phase-6/readiness` as the P6-0 implementation awaiting review; not merged into `main` until P6-0 is approved |
| Scope | (1) Deterministic history ordering (#15); (2) erasure of viewing feedback, offer conditions and deal notes; (3) erasure restrictions for parties to active deals and recorded sales; (4) accountant permission review; (5) validation of the histories that viewings, offers, deals and lead conversion will write; (6) audit and privacy of sales records; (7) data retention; (8) transaction-history integrity |
| Not in scope | Viewings (S1), offers (S2), deals (S3), landlord visibility (S4), lead conversion workflows, screens. No API endpoint for the pipeline was added |
| Result | **P6-0 complete**, for approval. Review in §3, test results in §4; CI run 112 green (§11) |

## 1. Deliverables

### 1.1 Documentation

| Document | Content |
|---|---|
| [ADR-008](../decisions/ADR-008-sales-records-integrity-retention-erasure.md) | Sales records: history integrity, erasure, retention, audit and privacy (decisions S-D1 to S-D13) |
| [P6-0 implementation notes](P6-0-IMPLEMENTATION.md) | How to write and read histories, the rules the database enforces, erasure, running the migrations, testing |
| [Phase 6 readiness report](PHASE-6-READINESS-REPORT.md) | Workflows, landlord visibility, decisions P6-D1 to P6-D14 (approved 13 November; approvals recorded in the report) |

### 1.2 Database

| Change | Purpose |
|---|---|
| Migration 0029: `entry_no` on 13 streams (audit log, outbox, listing status and price history, key movements, lead status and assignments, privacy request events and evidence, consents, identity checks, deal stage history, offers) | #15: rows written together read back in the order written. Existing rows numbered in today's visible order; indexes end in `entry_no` |
| Migration 0030: stage history written by the database; guards on deals, offers, viewings, milestones, sales; one deal per lead; no deletes | Transaction-history integrity (ADR-008 §2) |
| Migration 0030: `app.erase_contact_sales`, `app.erase_contact` calls it | Erasure of the pipeline's free text (ADR-008 §3) |
| Migration 0030: blockers `open_deal`, `sale_record`; rule `sales_records_retention_years` (no value); `app.jurisdiction_rule` | Erasure restrictions and retention (ADR-008 §4) |
| Migration 0030: accountant `viewing.view`, `offer.view` (all) | Specification §11.2 |

### 1.3 API and web

| Change | Detail |
|---|---|
| History cursors | `{ v, n }` with the insertion number on listing status, price and history, property activity and key movements; cursors from before #15 answer a validation error asking for the first page; record lists unchanged |
| History readers | Lead status and assignment history, privacy request events and evidence, consent in force and history, latest identity check, exports' marketing filter, the access report, owner identity (#18) |
| Erasure blocker text | API and privacy request screen explain `open_deal` and `sale_record`, in English and Arabic |

## 2. Requirement checklist

| # | Requirement | Where | Status |
|---|---|---|---|
| 1 | Deterministic history ordering (#15) | Migration 0029; readers §1.3 | ✅ |
| 2 | Erasure of viewing feedback | `app.erase_contact_sales`; also cancellation reason and meeting point | ✅ |
| 2 | Erasure of offer conditions | Same; amounts kept | ✅ |
| 2 | Erasure of deal notes | Lost notes, stage-change notes, milestone notes, fall-through reasons, custom fields | ✅ |
| 3 | No erasure of parties to active deals | Blocker `open_deal` | ✅ |
| 3 | No erasure of parties to recorded sales | Blocker `sale_record` (open sales; completed within retention; no retention value = kept) | ✅ |
| 4 | Accountant permissions aligned with the specification | §5.3 | ✅ |
| 5 | Validation of the new histories (viewings, offers, deals, lead conversion) | Guards in migration 0030; SQL suite 12 | ✅ |
| 6 | Audit and privacy of sales records | ADR-008 §5; erasure redacts audit and outbox (§6) | ✅ |
| 7 | Data-retention requirements | ADR-008 §4; jurisdiction rule, fail closed until #20 | ✅ |
| 8 | Transaction-history integrity | ADR-008 §2; guards on sales, offers, stages | ✅ |
| — | Report, implementation documentation, ADR | §1.1 | ✅ |

## 3. Review

The review on 13 November read migrations 0029 and 0030 line by line against the migrations they build on (0007 pipeline tables, 0013 sign-in audit, 0024 timeline order, 0026 erasure, 0027 privacy requests), then checked every claim in ADR-008 against the code and the database. The review also queried the catalogue for each runtime role's privileges on the new columns. Three defects were found and fixed (two in `bc94bae`, one in `3a2e134`), each with a new test; the other findings needed no change or are recorded for S2.

### 3.1 Migration 0029 (#15 insertion order)

| Check | Result |
|---|---|
| All 13 streams that lacked a tie-breaker get `entry_no` (with `activities` from 0024, 14 in total) | ✅ Verified against every reader that sorted by time |
| Existing rows numbered in today's visible order (time, then id), so nothing reorders on upgrade | ✅ `row_number() OVER (ORDER BY time, id)`, the same order readers used before #15 |
| Guards are disabled only for the numbering, inside the migration's transaction, and re-enabled | ✅ `DISABLE TRIGGER USER` / `ENABLE TRIGGER USER` around one `UPDATE` per table; a failure rolls the whole migration back |
| Sequence starts after the highest number; default and NOT NULL set after numbering | ✅ |
| Every role that inserts can use the sequence | ❌→✅ **Defect 1**: grants named only `estatepro_app` and `estatepro_platform`; `estatepro_auth` (allowed to insert sign-in audit rows by 0013; no code does yet) would fail with "permission denied for sequence audit_logs_entry_no_seq". Fixed: grants follow the table's INSERT grants. SQL test checks every inserting role on every stream |
| Uniqueness | ✅ Unique index on 12 tables; `audit_logs` is partitioned by time, so uniqueness rests on its sequence (a unique index would have to include the partition key) |
| Read indexes end in `entry_no` and match each reader's order (ascending histories, descending audit, consents, checks and key movements) | ✅ Plan checked for the listing history page: index scan on the new index, no sort (§8) |
| `outbox_events_unpublished_idx` moved from `occurred_at` to `entry_no` | ✅ No code reads the outbox yet (relay is Phase 12); the relay must poll by `entry_no` (ADR-008 §7) |
| Nobody can change `entry_no` to reorder history | ❌→✅ **Defect 3**: the runtime roles may UPDATE `consents`, `listing_status_history`, `listing_price_history` and `outbox_events`, which have no update guard, so a changed number could reorder them. On consents this would let an older grant become the consent in force over a later withdrawal. Fixed: a trigger on all 14 streams refuses any change to `entry_no`, whatever the role (`42501`). SQL tests: every stream has it; consent, listing history and outbox renumbering refused |
| Rollback | Restore from backup (no down migrations, as in all phases) |

### 3.2 Migration 0030 (sales records)

| Check | Result |
|---|---|
| Stage history written on insert and on every real stage change, with the member of the current user | ✅ `SECURITY DEFINER` with a fixed `search_path`; only fires when `stage_id` changes |
| Stage note belongs to one change | ❌→✅ **Defect 2**: `app.stage_note` stayed set for the rest of the transaction, so a second stage change repeated the first note. Fixed: the trigger clears it after use. SQL test |
| Closed deals final; notes changeable only by an erasure, only to `[Erased]` | ✅ |
| Offers: recorded as submitted; deal open; listing and currency of the deal; counter-offer answers an open offer of the other side; terms and conditions immutable; status transitions; response time only with status; no deletes | ✅ SQL suite 12 covers each refusal with its SQLSTATE |
| Guards compare with `<>`, which passes on a missing row | ✅ No gap: `deal_id`, `parent_offer_id`, `accepted_offer_id` and `listing_id` all have foreign keys that include `company_id`, checked after the trigger, so a missing or other-company row is refused |
| Offer on a deal with no listing yet | ⚠️ Not checked against a listing by the database. Recorded for S2 (risk R6) |
| Viewings, milestones, sales transactions: allowed transitions, final when finished, fixed terms and dates | ✅ |
| One deal per lead; lead points only at the deal made from it, and never changes once set | ✅ |
| Runtime role cannot delete pipeline rows or write stage history | ✅ `REVOKE` plus guards (`42501`) |
| `open_deal` and `sale_record` blockers include merged-away records of the person | ✅ Same subject set as the erasure |
| `sale_record` blocker cannot miss a sale | ✅ `sales_transactions.unit_id` is NOT NULL, so the join to the property's jurisdiction always finds it |
| Retention fails closed: no value, a non-number value, or within the period all block | ✅ SQL tests for no value, within and after the period |
| Erasure covers every free-text column of the pipeline | ✅ Checked against the catalogue: `deals.lost_notes`, `deals.custom_fields`, `deal_stage_history.note`, `deal_milestones.notes`, `offers.conditions`, `viewings.feedback`, `.cancelled_reason`, `.meeting_point`, `sales_transactions.fallen_through_reason`. The remaining text columns are codes, statuses or references |
| Erasure scope on a deal | ⚠️ By design: erasing one party anonymises all free text on their deals, including the other side's counter-offer conditions and the deal's custom fields; facts are kept for everyone (ADR-008 §3) |
| `erase_contact_sales` runs only inside an erasure; the runtime role cannot set the erasure flag | ✅ SQL tests |
| Audit rows and outbox events of every touched pipeline record are redacted | ✅ SQL test |
| `app.erase_contact` keeps every behaviour of 0026 (ledger, contacts, addresses, methods, consents, documents, checks, requirements, leads, activities, tasks) | ✅ Phase 5 erasure suites (SQL 10, API privacy and erasure tests) pass unchanged |
| Accountant grants | ✅ `viewing.view`, `offer.view` (all) on the system role only |

### 3.3 ADR-008

| Check | Result |
|---|---|
| Every decision S-D1 to S-D13 is implemented where it says, or is marked for S1–S3 | ✅ |
| §6: "partitioned tables in PostgreSQL 16 do not support identity columns" | ✅ Confirmed: adding an identity column to `audit_logs` is refused by PostgreSQL 16 |
| §4: commonly cited retention periods (five years UK and Ghana, ten years Qatar) | Stated as indications only; no value set until #20 |
| Gaps found | Added to ADR-008: sequence grants follow insert grants (§2.2); stage note used once (S-D2, §7); erasure scope covers the other side's counter-offers, with the reason (§3); the outbox relay polls by `entry_no` (§7); review record (§8) |
| Status | Remains **Proposed** for approval with this report |

## 4. Tests

| Suite | Tests | Result |
|---|---|---|
| `database/tests/12_sales_records_p6_0.sql` (history order, insertion numbers fixed on all 14 streams, sequence grants, stage history and stage notes, offers, sales, milestones, closed deals, viewings, lead conversion, blockers, retention, erasure of text and of audit and outbox, accountant grants, isolation) | 69 assertions | ✅ |
| All SQL suites (`database/scripts/verify.sh`) | 13 files, 364 assertions, 30 migrations | ✅ |
| `api/test/p6-0-sales-records.e2e.test.ts` (history order and paging through the API, old cursor refused, audit, lead and consent order, stage history, `open_deal` and `sale_record` through the privacy register, erasure keeps facts and redacts text, accountant grants, isolation) | 8 | ✅ |
| `api/test/list-query.test.ts` (history cursor encode, decode, refusal, paging) | 11 (4 new) | ✅ |
| Full API suite (`test:ci`), after the review fixes | 492 in 40 files | ✅ |
| API performance suites, each on its own database | 11 in 8 files | ✅ (§8) |
| API performance suites together (`test:performance`, one shared database) | 11 in 8 files | ⚠️ 9 of 11 in the first run; dashboards and media fail when run after other large suites: pre-existing defect, reproduced on `main` (§8.1, R7) |
| Web: typecheck, lint, message check (2,572 keys in both languages); unit tests | 79 in 18 files (coverage 98.14 % statements, 91.41 % branches) | ✅ |
| Browser suite (`test:e2e:ci`, local, 93 tests including the axe sweep in English and Arabic) | 88 passed, 1 failed, 4 not run (serial file stopped) | ⚠️ locally; the failure is a pre-existing test timing race, not P6-0 (§4.2). CI browser job green on `bc94bae` (run 111) and `c2924f8` (run 112, §11) |

API coverage: 95.95 % statements, 90.50 % branches, 98.41 % functions, 98.19 % lines (thresholds 95/90 met). `list-query.ts`: 100 % statements, 96.7 % branches.

### 4.1 Defects found and fixed during P6-0

| Defect | Found by | Fix |
|---|---|---|
| Lead status history was ordered by time only (no tie-breaker at all) | #15 review | Ordered by (time, `entry_no`) |
| "Latest consent" and "latest identity check" broke ties by random UUIDv7 order, so a withdrawal recorded at the same instant as a grant could be ignored | #15 review | Ordered by insertion |
| Sequence grants missed `estatepro_auth` (review defect 1) | P6-0 review | Grants follow INSERT grants (`bc94bae`) |
| A stage note stayed set for later stage changes in the transaction (review defect 2) | P6-0 review | Cleared after use (`bc94bae`) |
| Runtime roles could change `entry_no` on four streams and so reorder history, including which consent is in force (review defect 3) | P6-0 review | Trigger on all 14 streams (`3a2e134`) |

### 4.2 Browser suite findings (pre-existing, not caused by P6-0)

No browser spec or screen used by these tests changed in P6-0 (`git diff 5ef896c -- apps/web/e2e apps/web/src/components/leads apps/web/src/components/activity`: no change).

| Test | What happened | Cause | Evidence |
|---|---|---|---|
| L-3 "captures a lead for an existing contact found by phone" (`e2e/crm-leads.spec.ts:104`) | "Find contact" was filled with "Esi" but no option list opened | The test types immediately after navigation, before the page is interactive, so the component never sees the text. A test timing race | With one added `waitForLoadState('networkidle')` (temporary copy, not committed) both L-3 tests pass. CI passes the unchanged test |
| A-2 "logs a call on the lead" (`e2e/crm-leads.spec.ts:58`), when the file runs alone | "First response" not shown after logging a call | **Product defect (Phase 5, C3/C5):** the "When" field has minute precision, so a call logged in the same minute the lead arrived has `occurred_at` earlier than `received_at` (which has seconds), and `activities.service.ts` requires `received_at <= occurred_at` before recording the first response. A real agent who calls back within the same minute is not credited, and the lead later shows as overdue | Page state: status "Contacted", but "Reply due by" still shown; the lead was received at 15:00 and the call logged in the same minute |

Both are recorded as risk R8 with proposed fixes; neither is changed in P6-0 (outside its approved scope).

## 5. Security impact

### 5.1 Controls added

| Control | Evidence |
|---|---|
| The runtime role cannot delete deals, stage history, offers, viewings, milestones or sales, and cannot write stage history | SQL suite 12 (`42501`) |
| Offer terms, closed deals, finished viewings, completed milestones and exchanged sales cannot be rewritten by any path | SQL suite 12 |
| Only an erasure may redact pipeline text, and the runtime role cannot pretend to be one (`app.erasure` flag ignored for it) | SQL suite 12 |
| A stage change cannot go unrecorded | SQL suite 12; API test |
| No role can change an insertion number, so no history or audit stream can be reordered after it is written (review defect 3) | SQL suite 12 (`42501` on consents, listing status history, outbox; trigger present on all 14 streams) |
| Every role that may write a stream can number its rows, including `estatepro_auth`, which migration 0013 allows to insert sign-in audit rows (no code writes them yet, so the defect had not surfaced; review defect 1) | SQL suite 12 |

### 5.2 Tenant isolation

| Check | Evidence |
|---|---|
| Another company sees no deals, offers, viewings, stage history or sales | SQL suite 12 |
| Another company cannot probe a contact's erasure blockers | SQL suite 12 |
| Another company cannot read the listing histories or property activity | API test (404) |
| Every new column inherits its table's row-level security; sequences grant only `USAGE` to the runtime roles | Migration 0029 |

### 5.3 Accountant permission review (specification §11.2)

| Resource (specification) | Specified | Granted before | Now |
|---|---|---|---|
| Deals, viewings, offers | R (all) | `deal.view` only | `deal.view`, `viewing.view`, `offer.view` (all) ✅ |
| Company, billing, users, properties, listings, contacts, KYC | R (all) | Matching view grants | Unchanged ✅ |
| Management agreements, leases, work orders | R (all) | Matching view grants | Unchanged ✅ |
| Rent, arrears, deposits, expenses, statements, commissions, periods | Full (finance) | Matching grants | Unchanged ✅ |
| Documents, reports, automation | CRU / RX / R | Matching grants | Unchanged ✅ |
| Leads, EstateAI, API keys | None | None | Unchanged ✅ |
| Audit log | R (finance) | `audit.view` (all) | Unchanged; **finding**: no audit-log viewer exists yet, so the "finance only" limit has nothing to enforce. To apply when the viewer is built (risk R4) |
| Protected contact details (reveal) | — (ADR-007 E-Q5 approved accountant reveal) | `contact.view_sensitive` | Unchanged ✅ |

## 6. Compliance impact

| Requirement | Effect |
|---|---|
| Erasure (UK GDPR Art. 17; Ghana Data Protection Act 2012; Qatar Law No. 13 of 2016) | Extends to the sales pipeline's free text before any exists; facts kept as required records |
| Record keeping for sales (contract, tax, anti-money-laundering) | Parties to open and recorded sales cannot be erased; completed sales kept until the jurisdiction's retention period, which only legal review sets (#20). Until then: kept (fail closed) |
| Accountability (audit trail) | Every history ordered and immutable; the erasure redacts values in audit and outbox but keeps what happened and when |
| Consent | The consent in force is now the one recorded last, even when two are recorded at the same instant, and its position can never be changed afterwards (exports and messaging rely on it) |
| Access requests (G3) | The access report reads the same tables; S1–S3 add the person's deals, offers and viewings to it |
| Data residency, legal values | Unchanged: #20 |

## 7. Audit impact

| Item | Effect |
|---|---|
| Audit log | Ordered by insertion within an instant (#15); partitioned table numbered across partitions; the number is fixed once written |
| Erasure | Redacts audit rows and outbox events of the person's deals, offers, viewings, milestones and sales (shape and numbers kept) — SQL suite 12 |
| Stage history | Written by the database with the member; cannot be skipped or rewritten |
| New audit actions for S1–S3 | Listed in ADR-008 §5 (none emitted yet: no pipeline endpoint exists) |

## 8. Performance impact

Migration and query cost, measured on the development machine (PostgreSQL 16, 4 cores, one company):

| Measure | Result |
|---|---|
| Migration 0029 with 1,000,000 audit rows, 200,000 outbox events, 200,000 listing status rows and 200,000 consents | 46.8 s (about 34,000 rows a second, including new indexes) |
| Migration 0030 | 0.07 s (no data rewritten) |
| Listing history page, 50 rows of 1,000,000 audit rows, newest first | 0.28 ms (index scan on the new index) |
| Same page deep in the history (keyset on time and `entry_no`) | 0.22 ms |
| Insert 1,000 audit rows, before and after | 21 ms before, 16 ms after (no measurable cost) |

API performance suites, each run on its own fresh database (budgets unchanged from Phase 5):

| Suite | Budget | Result |
|---|---|---|
| Listings (100,000 listings) | p95 < 1,000 ms | ✅ 64 requests, median 23 ms, p95 210 ms |
| Location (100,000 listings) | radius 1,000; pages 500; map 500/800; polygon 1,000; notes 300 ms | ✅ radius 169, sorted pages 152, city map 179, clustered map 419, polygon 37, notes 14 ms (p95) |
| Media (12-megapixel photos, gallery of 60) | < 3 s a photo | ✅ 1.47 s a photo; gallery p95 108 ms |
| Contacts (100,000 contacts) | p95 < 1,000 ms | ✅ 70 requests, median 72 ms, p95 387 ms |
| Requirements, matching, KYC (19,984 published listings) | p95 < 1,000 ms | ✅ 90 requests, median 21 ms, p95 588 ms |
| Leads, timeline, follow-ups | p95 < 1,000 ms | ✅ 90 requests, median 21 ms, p95 254 ms (lead history now ordered by `entry_no`: lead 19 ms, timeline 19 ms) |
| Dashboards, preview, exports (20,000 contacts) | p95 < 1,000 ms; export < 5,000 ms; refresh < 60 s | ✅ p95 640 ms; 16,666-row contact export 520 ms; match refresh 4.2 s |
| Field-key rotation (25,000 values) | ≥ 500 a second | ✅ 15.1 s (about 1,650 a second) |
| Lookup-key rotation (5,000 tax numbers, two passes) | ≥ 250 a second | ✅ 3.3 s |
| Erasure of a person with a long history (now including the pipeline step) | < 2 s | ✅ 190 ms |

Every suite passes (11 of 11 tests) when it runs on its own database. Against the Phase 5 figures (consolidated report §4.1): contacts p95 387 ms (Phase 5: 516), requirements 588 ms (607–774), leads 254 ms (227), dashboards 640 ms (456–650), rotation about 1,650 values a second (≈ 2,100; 12.2 s, about 2,050 a second, in this phase's first run, so within run-to-run variation), erasure 190 ms (121; it now also runs the pipeline step of migration 0030, still a tenth of the 2 s budget). The readers changed by #15 stay within budget. Run together in one database, the dashboards and media suites can fail; that is the pre-existing defect in §8.1, not a P6-0 regression.

### 8.1 Performance finding: requirement match refresh (pre-existing, not caused by P6-0)

The first full `test:performance` run after the review fixes failed 2 of 11 tests: dashboards (401 "access token has expired", 574 s) and media (12-megapixel photos, timed out at 300 s). Both pass when run on their own (above). The cause was investigated rather than treated as a flake:

| Step | Evidence |
|---|---|
| Both suites call `worker.runOnce()`, which queues and runs the requirement match refresh (`requirement.match_refresh`, C4) for **every company** in the shared test database | `apps/api/src/worker/worker.ts`, `discover(JOBS.requirementMatchRefresh, …)` |
| The dashboards suite issues its 5-minute access tokens **before** that worker run; when the run takes longer, every dashboard request answers 401 | `test/dashboards.performance.test.ts`; token lifetime 300 s (`test/support/idp.ts`) |
| Reproduced in a fixed order (requirements suite, then dashboards): the refresh ran one statement for about 495 s, then another for over 110 s; the test timed out | PostgreSQL activity sampled every 10 s |
| The same order on `main` (`5ef896c`, without P6-0) fails the same way: the refresh was still running after 321 s | Separate worktree and database |
| With the requirements suite's own requirements paused, the dashboards company's refresh alone still ran for over 540 s, against 4.1 s when it is the only large company in the database | So the trigger is another company's listings and addresses, not its requirements |
| Query plan (200 requirements, `EXPLAIN ANALYZE`): for requirements with area localities, the planner starts from `listings_matching_idx` (estimated 4 rows, actual 1,253) and runs the address subquery (1,000 rows) once per candidate listing: 30,964 bitmap scans for 42 requirements, 7.5 s for 200 requirements | When alone, the same query is planned from the addresses and takes 4 s for all 20,000 |
| P6-0 changed none of this code, and the refresh reads no table that migrations 0029 or 0030 changed | `git diff 5ef896c` on `src/worker`, `src/dashboards`, `src/contacts/requirement-matching.ts` and these tests: no change |

**Conclusion.** The matching SQL of decision D4 (C2), used by the refresh, has a plan that depends on table statistics. In a database shared by many companies (production), one company's refresh can go from seconds to many minutes because other tenants hold data, inside one transaction, every 15 minutes. The test suites expose it only in some orders, and the nightly performance workflow runs them together (`.github/workflows/performance.yml`). The nightly runs on `main` passed on 12 and 13 November (runs 11 and 12), when the order did not expose it; any night it can. Phase 5 recorded the shared database as a test-isolation risk (consolidated report §4.3); this review shows it is also a product risk. It is a pre-existing Phase 5 defect; fixing it is outside P6-0's approved scope, so P6-0 does not change it. Proposed fix for your decision (risk R7): drive the area branches from the requirement's addresses (a lateral join on `addresses` first, then units and listings), refresh in batches of requirements per transaction, and make the performance suites independent of order (each suite's worker run limited to its own data; tokens issued after the worker run).

## 9. Decisions taken in P6-0 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| P60-D1 | ADR-008 decisions S-D1 to S-D13 | §1, ADR-008 |
| P60-D2 | History cursors carry the insertion number; older cursors are refused (first page again), not translated | One cursor format; a stale cursor could skip or repeat rows |
| P60-D3 | Consents and identity checks are histories too (latest wins by insertion) | A withdrawal must win over a grant recorded at the same instant |
| P60-D4 | `sales_records_retention_years` has no default; until #20 a completed sale keeps its parties | A retention period is a legal value |
| P60-D5 | Stage notes are passed with the transaction setting `app.stage_note` | Keeps stage history written only by the database |
| P60-D6 | The accountant's "audit log (finance)" limit is recorded as a finding and applied when an audit-log viewer is built | No endpoint reads `audit.view` today |
| P60-D7 | Insertion numbers are fixed by a trigger on every stream, not by column privileges | Some streams are updatable by the runtime roles for other columns; the trigger holds whatever the role |
| P60-D8 | The pre-existing defects found during the review (R7 match refresh, R8 browser test timing and first-response minute precision) are reported, not fixed in P6-0 | Outside P6-0's approved scope; each needs your decision on when and how |

## 10. Risks and open items

| # | Item | Rating | Status |
|---|---|---|---|
| R1 | Migration 0029 rewrites history tables once (about 34,000 rows a second); a large production database needs a maintenance window | Low now | No production data yet; noted in the implementation notes |
| R2 | Until #20 sets retention, buyers and sellers of completed sales cannot be erased | Medium (by design) | Shown to staff with the reason; legal review #20 |
| R3 | Pipeline guards raise database errors; S1–S3 must turn them into clear 409/422 responses | Low | Implementation notes §4 |
| R4 | Accountant audit-log scope not enforceable yet | Low | When the audit-log viewer is built |
| R5 | Decisions P6-D1 to P6-D14 | — | **Closed**: approved 13 November |
| R6 | An offer on a deal that has no listing yet (a unit-only deal) is not checked against a listing by the database (review finding 8) | Low | S2: the offer service refuses an offer on a deal without a listing |
| R8 | (a) L-3 browser test types before the page is interactive (test timing race); (b) a call logged in the same minute a lead arrived does not count as its first response (minute-precision time against a seconds-precision receipt time) (§4.2) | Low (a), Medium (b) | Pre-existing. (a) #43, maintenance backlog; (b) #44, before Phase 6 closes |
| R7 | Requirement match refresh (C2/C4, pre-existing): plan depends on other tenants' data; minutes instead of seconds per company; makes the dashboards and media performance suites fail in some orders (§8.1) | **High (launch, scale)** | Not changed by P6-0. #42: remediate before Phase 7 |
| — | #20, #24, #25 | High (pre-launch) | Unchanged |

## 11. GitHub references

| Reference | Link |
|---|---|
| Pull request #39 (Phase 5 into `main`, merged `5ef896c`) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/pull/39 |
| Issue #15 (deterministic history ordering) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/15 |
| Issue #5 (landlord visibility, S4) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/5 |
| Issue #20 (legal review, retention values) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/20 |
| Branch | `phase-6/readiness` |
| CI run 112 (`c2924f8`, all checks green, including the browser suite) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/43449020877 |

## Approval

| Item | Decision | Date |
|---|---|---|
| P6-0 | **Approved** | 13 November 2026 |
| ADR-008 | **Approved** (status Accepted) | 13 November 2026 |
| P60-D1 to P60-D8 | **Approved** | 13 November 2026 |
| R7 (requirement match refresh) | Tracked as [#42](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/42), priority High, remediate before Phase 7 | 13 November 2026 |
| R8a (L-3 browser test timing) | Tracked as [#43](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/43), priority Low, maintenance backlog | 13 November 2026 |
| R8b (first response in the same minute) | Tracked as [#44](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/44), priority Medium, fix before Phase 6 closes | 13 November 2026 |

Next: S1 (viewings), per the approved Phase 6 roadmap. The P6-0 commits stay on `phase-6/readiness` until Phase 6 work is merged through a reviewed pull request.
