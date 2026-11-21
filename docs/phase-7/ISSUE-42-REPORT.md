# Issue #42 · Remediation report: requirement match refresh across tenants

| | |
|---|---|
| Date | 21 November 2026 |
| Issue | [#42](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/42), High; S6-R2 |
| Plan | `docs/phase-7/ISSUE-42-REMEDIATION-PLAN.md`, **approved 21 November 2026** |
| Branch | `issue-42/match-refresh`, from `main` at `a551ee7`; CI: see §9 |
| Result | **#42 remediated; all acceptance criteria met** (§2). Awaiting review and approval |

## 1. What changed

| Change | Where | Detail |
|---|---|---|
| Address-first match test | `apps/api/src/contacts/requirement-matching.ts` (`hasMatchSql`) | For named areas, circles and drawn areas, the requirement's addresses are read first (locality index or coordinate index). Each address is then checked through scalar `LIMIT 1` subqueries: address → its units → each unit's listing. PostgreSQL never pulls such subqueries up or reorders them, so the plan no longer depends on statistics that include other companies, and the search stops at the first match. The D4 rules, listing scope and exclusions are unchanged; "anywhere" requirements keep their price-index search |
| Per-unit listing lookup | same | The listing check repeats `status in ('available', 'reserved', 'under_contract')`. The listings table already guarantees this for published listings (CHECK `listings_check4`), so no answer changes, and the existing partial index `listings_one_open_per_unit_idx` (company, unit, type) finds the unit's listing directly (decision 42-D2) |
| Batches of 2,000 | `apps/api/src/dashboards/dashboards.service.ts` | `refreshRequirementMatchBatch` refreshes 2,000 active requirements per transaction, in id order. `removeInactiveMatchStatus` drops the status of requirements no longer active, once per refresh |
| Lock renewal | `apps/api/src/worker/queue.ts`, `worker.ts` | `JobQueue.renewLock` extends a running job's lock after each batch, but only for the claim that holds it: a later claim increments `attempts`, so a replaced holder's renewal fails. The refresh then stops with `LockLostError` and leaves the job's row to the new holder |
| Company-scoped refresh | `Worker.refreshRequirementMatches(companyId)` | The job handler calls it; so do tests, for one company. The worker can also be limited to chosen job types (`jobTypes`), used by the media performance test |
| Performance tests independent of order | `dashboards`, `media`, `data-protection` performance tests | The C4 test refreshes only its own company, with tokens issued after the refresh. The media test runs only media jobs. The rotation test refreshes the contacts statistics after its bulk insert, as the other large tests already did |

There are no migrations, new indexes, API changes or web changes.

## 2. Acceptance criteria

| Criterion (approved 21 November) | Result |
|---|---|
| Matching results identical to current behaviour | **Met.** Equivalence test: for every requirement of two companies (named areas, circles, drawn shapes, "anywhere", exclusions, paused, other company) the new test and the C4 test give the same answer. The existing check against the matches endpoint is unchanged and passes. At scale both versions report every one of the 50,000 dense requirements as matched (§5) |
| C4 refresh under 60 s | **Met: 0.68 s** for 20,000 requirements with the dense company present (was about 10 minutes) |
| Dense-company refresh under 60 s | **Met: 7.1 s** for 50,000 requirements |
| No duplicate worker execution | **Met.** The lock is renewed after every batch (each under 2 s), well inside the 300 s lock, so the job is never released while it runs. If it ever were, the replaced holder's renewal fails and it stops (worker test) |
| Full performance suite in one run and in alternate orders | **Met.** `test:performance` (13 files, 17 tests) passed 17 of 17 in one shared database, three times: the default order (requirements before C4, the order that used to hang) and two shuffled file orders (seeds 1042 and 7, C4 before requirements). Every budget was met in all three (§5.3) |
| Drawn-area measurements in the report | **Met** (§5.2) |
| CI green | CI_RESULT |

## 3. Decisions taken during implementation (for approval)

| # | Decision | Reason | Status |
|---|---|---|---|
| 42-D1 | **Nested scalar subqueries define the reading order:** requirement → address → unit → listing | Measured: a fence (`OFFSET 0`), set-based joins and materialised pairs all still let the planner start from listings or blow up on dense areas (plan §3) | For approval |
| 42-D2 | **The listing lookup states the published statuses explicitly** so the existing per-unit index is used, instead of adding an index | The first measurement of drawn areas was 94.5 s for 25,000 (§5.2): inside each address the planner again read the price index (about 1,450 listings per address) because listings have no plain index by unit. The CHECK constraint makes the added condition redundant, and the approved scope excluded migrations | For approval |
| 42-D3 | **Batch size 2,000, in requirement id order;** inactive rows are removed once at the end | As planned. Measured batches take under 2 s (0.7 s per 2,000 in the C4 company) | For approval |
| 42-D4 | **Lock ownership by `attempts`:** a claim increments it, so a stale holder can tell it was replaced | No new column needed; the claim already does this | For approval |
| 42-D5 | **`jobTypes` worker option** limits which job types a worker claims | Needed so the media performance test times only media work in a shared database; the production worker passes no option and claims every type, as before | For approval |
| 42-D6 | **The rotation performance test refreshes table statistics after seeding** | It measured 492 values a second in a full run (budget 500) and 1,168 alone: the same code, stale statistics after inserting 25,000 rows into a table shared with other files. The C4 and requirements tests already do this | For approval |

## 4. Tests

| Suite | Result | Added for #42 |
|---|---|---|
| API (`test:ci`) | **565 of 565 pass** (45 files); coverage 96.17% statements, 98.31% lines; lint, typecheck and build pass | Equivalence against the C4 query (kept in `test/support/legacy-match.ts` as the reference); a plan check that no join in the match test combines addresses and listings, which fails on the old query; batches of one in id order, results equal to the reference, inactive rows removed, and another company's rows untouched; lock renewal only for the current claim, with a stale holder stopping |
| API performance | **17 of 17 pass in one run**, three orders (§5.3) | Dense-company refresh measured per kind of area; C4 refresh scoped to its company |
| Web | Not affected (no web change); runs in CI | — |

## 5. Performance

### 5.1 Refresh with several large companies in one database

Measured with the requirements-test company (50,000 active requirements, 19,984 published listings, every requirement matched) and the C4 company (20,000 requirements, 9,974 listings) in one database, JIT off as in production.

| Refresh | Before (21 November) | After | Target |
|---|---|---|---|
| C4 company, 20,000 requirements | about 10 min (58 s per 400 named-area requirements) | **0.68 s** | 60 s |
| Dense company, 50,000 requirements, as the worker runs it | named areas alone 221 s | **7.1 s** | 60 s |

### 5.2 Drawn areas (requested before merge)

The dense company's 25,000 drawn-area requirements: 12,500 circles (5 km radius) and 12,500 drawn polygons around Accra, every one matched.

| Version | Drawn areas and circles, 25,000 | Per requirement |
|---|---|---|
| Plan version (address first, one subquery for units and listings) | 94.5 s | 3.8 ms; the planner read about 1,450 listings per address |
| **Final (42-D2: per-unit listing lookup)** | **3.8 s** | 0.15 ms |

The same run, by kind:

| Kind | Requirements | Matched | Time |
|---|---|---|---|
| Named areas | 12,500 | 12,500 | 0.95 s |
| Drawn areas and circles | 25,000 | 25,000 | 3.8 s |
| Anywhere | 12,500 | 12,500 | 0.18 s |

### 5.3 Full API performance suite

All 13 files ran in one Vitest run against one shared database (`npm run test:performance`). Files run one at a time, so the order below is the run order.

| Run | File order | Result |
|---|---|---|
| Default | sales-dashboards, location, listings, leads, **requirements**, data-protection, **dashboards (C4)**, contacts, media, viewings, landlord-visibility, offers, deals | 17 of 17 |
| Shuffled, seed 1042 | offers, listings, leads, viewings, data-protection, media, **dashboards (C4)**, sales-dashboards, location, **requirements**, contacts, landlord-visibility, deals | 17 of 17 |
| Shuffled, seed 7 | **dashboards (C4)**, offers, leads, deals, viewings, media, landlord-visibility, **requirements**, contacts, location, data-protection, listings, sales-dashboards | 17 of 17 |

p95 for each test across the three runs (lowest to highest):

| Test | p95 | Budget |
|---|---|---|
| Listings (100,000) | 188 to 208 ms | 1,000 ms |
| Location: radius, pages, city map, clustered map, polygon | 127–194, 83–179, 179–230, 396–443, 39–76 ms | 1,000 / 500 / 500 / 800 / 1,000 ms |
| Media | 1.74 s per 12 MP photo; gallery 109 to 126 ms | as Phase 4 |
| Contacts (100,000) | 226 to 251 ms | 1,000 ms |
| Requirements and KYC | 281 to 614 ms | 1,000 ms |
| Dense match refresh (new, #42) | 50,000 in 6.6 to 6.9 s; drawn areas and circles 3.8 to 4.3 s | 60 s |
| Leads, timeline, follow-ups | 245 to 256 ms | 1,000 ms |
| CRM, admin, My day (C4) | 385 to 444 ms; C4 refresh 20,000 in 0.65 to 1.65 s | 1,000 ms; 60 s |
| Key rotation and erasure | 3 of 3 pass in every run (field rotation 1,033 values a second in the last run; budget 500) | as Phase 5 |
| Viewings (200,000) | 308 to 826 ms | 1,000 ms |
| Offers (100,000) | 60 to 71 ms | 1,000 ms |
| Deals (20,000) | 191 to 271 ms | 1,000 ms |
| Landlord views | 161 to 192 ms | 1,000 ms |
| Phase 6 dashboards | 138 to 188 ms | 1,000 ms |

Viewings reached 826 ms in the seed-7 run, where it followed six other files in the shared database; it is 308 ms in the default run. It stays within budget and is unchanged by #42. Noted under 42-R4.

## 6. Security, compliance and data

| Item | Effect |
|---|---|
| Tenant isolation | The refresh runs in the tenant transaction under row-level security, and every table in the match test keeps its company predicate. Tested: refreshing one company leaves another's rows unchanged |
| ADR-008, audit, erasure | Unaffected: `requirement_match_status` is a derived cache, not audited, and is removed with its requirement as before |
| Data | No migration. Existing status rows stay valid and are overwritten by the next refresh |

## 7. Risks and open items (for review)

| # | Risk | Rating | Mitigation |
|---|---|---|---|
| 42-R1 | The stale-holder check runs after each batch. If a lock were lost between the last renewal and completion (a window of milliseconds), the stale holder could still mark the job done | Low | Batches are under 2 s and the lock is 300 s, so the lock is never released while a refresh runs. Making every job's completion owner-checked is a change to all jobs, left out of this scope |
| 42-R2 | 42-D2 relies on the CHECK constraint `listings_check4` (published only when available, reserved or under contract) | Low | The equivalence tests would fail if the constraint and the condition ever diverged; the condition is commented in the code |
| 42-R3 | Listings still have no plain index by unit for published rows | Low | Not needed now (per-unit lookup through the existing partial index). Proposed only if a future query needs it |
| 42-R4 | Performance tests share one database in a full run; a future test that bulk-inserts and measures straight away without refreshing statistics can be order-sensitive | Low | Each large test now refreshes statistics after seeding; noted for Phase 7 tests. Viewings p95 ranged 308 to 826 ms across the three orders (budget 1,000 ms) |

## 8. Rollback

Code only: revert the #42 merge commit and deploy. `requirement_match_status` needs nothing (a cache, overwritten by the next refresh).

## 9. GitHub references

| Reference | Link |
|---|---|
| Issue | #42 |
| Plan | `docs/phase-7/ISSUE-42-REMEDIATION-PLAN.md` |
| CI | CI_RESULT |

## Approval

| Item | Decision | Date |
|---|---|---|
| #42 remediation | Awaiting approval | |
| 42-D1 to 42-D6 | Awaiting approval, each individually | |
| 42-R1 to 42-R4 | Awaiting review | |
| Pull request `issue-42/match-refresh` → `main`, and closing #42 | Awaiting approval | |
