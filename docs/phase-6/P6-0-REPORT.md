# Phase 6 · Milestone report: P6-0 Sales-pipeline readiness and governance

| | |
|---|---|
| Date | 12 November 2026 |
| Branch | `phase-6/readiness` (from `main` at `5ef896c`, after pull request #39), commits __COMMITS__; CI run __RUN__ |
| Approvals | Phase 5 complete and P5-H decisions H-D1 to H-D8 approved (12 November 2026). P6-0 directed as the first and only Phase 6 milestone until approved |
| Scope | (1) Deterministic history ordering (#15); (2) erasure of viewing feedback, offer conditions and deal notes; (3) erasure restrictions for parties to active deals and recorded sales; (4) accountant permission review; (5) validation of the histories that viewings, offers, deals and lead conversion will write; (6) audit and privacy of sales records; (7) data retention; (8) transaction-history integrity |
| Not in scope | Viewings (S1), offers (S2), deals (S3), landlord visibility (S4), lead conversion workflows, screens. No API endpoint for the pipeline was added |
| Result | **P6-0 complete**, for approval. Results in §3; CI run __RUN__ green (§10) |

## 1. Deliverables

### 1.1 Documentation

| Document | Content |
|---|---|
| [ADR-008](../decisions/ADR-008-sales-records-integrity-retention-erasure.md) | Sales records: history integrity, erasure, retention, audit and privacy (decisions S-D1 to S-D13) |
| [P6-0 implementation notes](P6-0-IMPLEMENTATION.md) | How to write and read histories, the rules the database enforces, erasure, running the migrations, testing |
| [Phase 6 readiness report](PHASE-6-READINESS-REPORT.md) | Workflows, landlord visibility, decisions P6-D1 to P6-D14 (for review) |

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
| 4 | Accountant permissions aligned with the specification | §4.3 | ✅ |
| 5 | Validation of the new histories (viewings, offers, deals, lead conversion) | Guards in migration 0030; SQL suite 12 | ✅ |
| 6 | Audit and privacy of sales records | ADR-008 §5; erasure redacts audit and outbox (§6) | ✅ |
| 7 | Data-retention requirements | ADR-008 §4; jurisdiction rule, fail closed until #20 | ✅ |
| 8 | Transaction-history integrity | ADR-008 §2; guards on sales, offers, stages | ✅ |
| — | Report, implementation documentation, ADR | §1.1 | ✅ |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `database/tests/12_sales_records_p6_0.sql` (history order, stage history, offers, sales, milestones, closed deals, viewings, lead conversion, blockers, retention, erasure of text and of audit and outbox, accountant grants, isolation) | __SQL12__ assertions | ✅ |
| All SQL suites (`database/scripts/verify.sh`) | 13 files, 30 migrations | ✅ |
| `api/test/p6-0-sales-records.e2e.test.ts` (history order and paging through the API, old cursor refused, audit, lead and consent order, stage history, `open_deal` and `sale_record` through the privacy register, erasure keeps facts and redacts text, accountant grants, isolation) | 8 | ✅ |
| `api/test/list-query.test.ts` (history cursor encode, decode, refusal, paging) | 11 (4 new) | ✅ |
| Full API suite (`test:ci`) | 492 in 40 files | ✅ |
| API performance suites (`test:performance`) | __PERFTESTS__ | __PERFRES__ |
| Web: typecheck, lint, message check (2,572 keys in both languages); unit tests | __WEBUNIT__ | ✅ |
| Browser suite | __E2E__ | __E2ERES__ |

API coverage: 95.95 % statements, 90.50 % branches, 98.41 % functions, 98.19 % lines (thresholds 95/90 met). `list-query.ts`: 100 % statements, 96.7 % branches.

### 3.1 Defects found and fixed during P6-0

| Defect | Found by | Fix |
|---|---|---|
| Lead status history was ordered by time only (no tie-breaker at all) | #15 review | Ordered by (time, `entry_no`) |
| "Latest consent" and "latest identity check" broke ties by random UUIDv7 order, so a withdrawal recorded at the same instant as a grant could be ignored | #15 review | Ordered by insertion |

## 4. Security impact

### 4.1 Controls added

| Control | Evidence |
|---|---|
| The runtime role cannot delete deals, stage history, offers, viewings, milestones or sales, and cannot write stage history | SQL suite 12 (`42501`) |
| Offer terms, closed deals, finished viewings, completed milestones and exchanged sales cannot be rewritten by any path | SQL suite 12 |
| Only an erasure may redact pipeline text, and the runtime role cannot pretend to be one (`app.erasure` flag ignored for it) | SQL suite 12 |
| A stage change cannot go unrecorded | SQL suite 12; API test |

### 4.2 Tenant isolation

| Check | Evidence |
|---|---|
| Another company sees no deals, offers, viewings, stage history or sales | SQL suite 12 |
| Another company cannot probe a contact's erasure blockers | SQL suite 12 |
| Another company cannot read the listing histories or property activity | API test (404) |
| Every new column inherits its table's row-level security; sequences grant only `USAGE` to the runtime roles | Migration 0029 |

### 4.3 Accountant permission review (specification §11.2)

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

## 5. Compliance impact

| Requirement | Effect |
|---|---|
| Erasure (UK GDPR Art. 17; Ghana Data Protection Act 2012; Qatar Law No. 13 of 2016) | Extends to the sales pipeline's free text before any exists; facts kept as required records |
| Record keeping for sales (contract, tax, anti-money-laundering) | Parties to open and recorded sales cannot be erased; completed sales kept until the jurisdiction's retention period, which only legal review sets (#20). Until then: kept (fail closed) |
| Accountability (audit trail) | Every history ordered and immutable; the erasure redacts values in audit and outbox but keeps what happened and when |
| Consent | The consent in force is now the one recorded last, even when two are recorded at the same instant (exports and messaging rely on it) |
| Access requests (G3) | The access report reads the same tables; S1–S3 add the person's deals, offers and viewings to it |
| Data residency, legal values | Unchanged: #20 |

## 6. Audit impact

| Item | Effect |
|---|---|
| Audit log | Ordered by insertion within an instant (#15); partitioned table numbered across partitions |
| Erasure | Redacts audit rows and outbox events of the person's deals, offers, viewings, milestones and sales (shape and numbers kept) — SQL suite 12 |
| Stage history | Written by the database with the member; cannot be skipped or rewritten |
| New audit actions for S1–S3 | Listed in ADR-008 §5 (none emitted yet: no pipeline endpoint exists) |

## 7. Performance impact

Migration cost (`docs/phase-6/P6-0-REPORT.md` §7 figures measured on the development machine, PostgreSQL 16, one company):

| Measure | Result |
|---|---|
| Migration 0029 with 1,000,000 audit rows, 200,000 outbox events, 200,000 listing status rows and 200,000 consents | 46.8 s (about 34,000 rows a second, including new indexes) |
| Migration 0030 | 0.07 s (no data rewritten) |
| Listing history page, 50 rows of 1,000,000 audit rows, newest first | 0.28 ms (index scan on the new index) |
| Same page deep in the history (keyset on time and `entry_no`) | 0.22 ms |
| Insert 1,000 audit rows, before and after | 21 ms before, 16 ms after (no measurable cost) |

API performance suites (unchanged budgets: p95 under 1,000 ms):

__PERF__

## 8. Decisions taken in P6-0 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| P60-D1 | ADR-008 decisions S-D1 to S-D13 | §1, ADR-008 |
| P60-D2 | History cursors carry the insertion number; older cursors are refused (first page again), not translated | One cursor format; a stale cursor could skip or repeat rows |
| P60-D3 | Consents and identity checks are histories too (latest wins by insertion) | A withdrawal must win over a grant recorded at the same instant |
| P60-D4 | `sales_records_retention_years` has no default; until #20 a completed sale keeps its parties | A retention period is a legal value |
| P60-D5 | Stage notes are passed with the transaction setting `app.stage_note` | Keeps stage history written only by the database |
| P60-D6 | The accountant's "audit log (finance)" limit is recorded as a finding and applied when an audit-log viewer is built | No endpoint reads `audit.view` today |

## 9. Risks and open items

| # | Item | Rating | Status |
|---|---|---|---|
| R1 | Migration 0029 rewrites history tables once (about 34,000 rows a second); a large production database needs a maintenance window | Low now | No production data yet; noted in the implementation notes |
| R2 | Until #20 sets retention, buyers and sellers of completed sales cannot be erased | Medium (by design) | Shown to staff with the reason; legal review #20 |
| R3 | Pipeline guards raise database errors; S1–S3 must turn them into clear 409/422 responses | Low | Implementation notes §4 |
| R4 | Accountant audit-log scope not enforceable yet | Low | When the audit-log viewer is built |
| R5 | Decisions P6-D1 to P6-D14 (readiness report) still to be reviewed | — | Presented with this report |
| — | #20, #24, #25 | High (pre-launch) | Unchanged |

## 10. GitHub references

| Reference | Link |
|---|---|
| Pull request #39 (Phase 5 into `main`, merged `5ef896c`) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/pull/39 |
| Issue #15 (deterministic history ordering) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/15 |
| Issue #5 (landlord visibility, S4) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/5 |
| Issue #20 (legal review, retention values) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/20 |
| Branch | `phase-6/readiness` |
| CI run __RUN__ | __RUNURL__ |

## Approval

Awaiting product owner approval of P6-0 (P60-D1 to P60-D6, ADR-008). Viewings, offers, deals, landlord visibility and lead conversion remain blocked until then.
