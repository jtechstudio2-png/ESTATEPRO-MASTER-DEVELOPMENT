# Issue #42 · Remediation plan: requirement match refresh across tenants

| | |
|---|---|
| Date | 21 November 2026 |
| Issue | [#42](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/42), High; S6-R2. Approved 13 and 21 November 2026 for remediation before Phase 7 |
| Branch | `issue-42/match-refresh`, from `main` at `a551ee7` (Phase 6 merge; `main` green, CI run 163) |
| Status | **Plan for approval.** No code is changed until this plan is approved |

## 1. Root cause analysis

The CRM dashboard's "no match" figure (decision D4) reads `requirement_match_status`. The worker job `requirement.match_refresh` refreshes that table every 15 minutes, one company per job and one SQL statement per company (`refreshRequirementMatches`, `apps/api/src/dashboards/dashboards.service.ts`). For each active requirement the statement evaluates `hasMatchSql` (`apps/api/src/contacts/requirement-matching.ts`). That is three `EXISTS` branches: "anywhere", named localities (`area_localities`) and drawn areas (`area_west`…).

**The cause lies in the named-area branch.** The intended order is a requirement's addresses first, then the properties, units and listings at those addresses. The SQL leaves the join order to the planner. The C4 code added an optimisation fence (`OFFSET 0`) on the address subquery, but the planner can still place the fenced subquery on the *inner* side of the loop. It then reads the listings price index first and re-runs the address subquery for every candidate listing.

**Why it depends on other tenants:** the planner chooses the order from table statistics, and in a shared database those cover every company's rows. With a second large company present, it estimates 4 candidate listings per requirement where the actual is 1,273, so it starts from listings. The plan is chosen per statement, not per company, so one tenant's data changes another tenant's plan.

The match rules themselves are correct. Only the order of reading is at fault.

## 2. Current behaviour

| Situation | Behaviour |
|---|---|
| One large company alone in the database | Refresh of 20,000 requirements in about 4 s (#42, 13 November) |
| A second company with ~20,000 published listings present | The same refresh runs for many minutes (over 540 s, still running when stopped, on 13 November; about 10 minutes measured on 21 November) |
| During that time | One transaction stays open for the whole refresh; the "no match" figure is stale for that company |
| After 5 minutes | The job's queue lock (`LOCK_SECONDS = 300`) expires, and `releaseExpiredLocks` makes the still-running job claimable again. A second worker pass can start the same refresh while the first is still running |
| Test suite | `test:performance` fails in some file orders: the C4 test's worker run takes over 10 minutes (seen in S6), so each performance file has been run on its own database since S3 |

Users see only a delayed "no match" count. The count is shown as pending until it is refreshed, so no wrong number is shown. The cost is database load and a long transaction, and both grow with the number of tenants.

## 3. Reproduction steps and evidence

**Steps** (test database, JIT off as in production since S6-D6):

1. `npx vitest run test/requirements.performance.test.ts test/dashboards.performance.test.ts`, one run, shared database. The C4 test's worker run stalls.
2. Stop it after the seeding; the data stays in `estatepro_api_test`.
3. Run each branch of `hasMatchSql` for the C4 company with `EXPLAIN (ANALYZE, BUFFERS)`.

**Data:**
- C4 company: 20,000 active requirements, of which 4,000 have named areas and 16,000 are "anywhere"; 9,974 published listings, all in one locality.
- Requirements-test company: 50,000 active requirements, of which 12,500 have named areas, 12,500 are "anywhere" and 25,000 have drawn areas; 19,984 published listings.

**Evidence, 21 November 2026:**

| Measurement | Result |
|---|---|
| "Anywhere" branch, C4 company, 2,000 requirements | 66 ms (healthy) |
| Named-area branch, C4 company, 400 requirements | **57,835 ms**, about 10 minutes for all 4,000 |
| Plan for those 400 | Starts from `listings_matching_idx`: 1,273 rows per requirement, 509,241 listing lookups. The address subquery runs 297,645 times and scans 1,000 addresses each time; 13.4 million buffer reads |
| Named-area branch, requirements company, 12,500 requirements (all match) | 220,829 ms with today's query |

**Alternatives tried on the same data:**

| Approach | C4 company (0 matches) | Requirements company (12,500 matches) | Verdict |
|---|---|---|---|
| Today's query | ~10 min | 221 s | The defect |
| Set-based join on `= any(array)` | 15.9 s | — | Planner still starts from listings |
| Unnest localities, then hash join | 19.4 s | — | Same |
| Materialised requirement × address pairs first | 36 ms | 150 s | Pairs explode where areas are dense |
| **Address-driven, nested `LIMIT 1` check per address** | **33 ms** | **27 s** | Same answers as today on both companies |

## 4. Proposed solution

1. **Read addresses first, by the shape of the query.**
   - For named areas and drawn areas, the requirement's addresses are scanned first, through the locality index or the coordinate columns, and filtered by `requirement_area_covers`.
   - For each address, a single scalar subquery ending in `LIMIT 1` looks for a matching listing: properties at the address, then units, then published listings.
   - The match conditions are exactly the D4 conditions used today: price band, type, currency, bedrooms, exclusions and listing scope.
   - A scalar `LIMIT 1` subquery cannot be pulled up or reordered by the planner, so the order no longer depends on statistics, and it stops at the first match.
   - The "anywhere" branch is unchanged. It starts from the listings price index, which is correct for it (66 ms).
2. **Refresh in batches.**
   - `refreshRequirementMatches` processes active requirements in id order, 2,000 per transaction.
   - The upsert and the stale-row clean-up are the same statements, limited to the batch; the clean-up runs once at the end.
   - Each batch is short, so no transaction stays open for minutes.
3. **No second copy of a running refresh.**
   - Each batch's transaction is short, so a refresh's total time stays well under the 300 s lock.
   - The job also renews its lock after each batch, so a long refresh is never handed to a second worker.
4. **Performance tests independent of file order.**
   - The C4 test's worker run handles only its own company. Today it runs the scheduled jobs of every company in the shared test database.
   - Tokens are issued after the worker run.
   - `test:performance` can then run as one suite again.

The live screens are unaffected: the requirement record's own matching (`matchConditions`, the "Matches" view) is a separate query and is not changed.

## 5. Database impact

| Item | Impact |
|---|---|
| Migrations | **None.** No table, column, index, trigger, policy or permission changes |
| Existing indexes used | `addresses_locality_key_idx` (company, locality_key), `properties_address_id_fk_idx` (company, address_id), `units_company_property_id_key`, listing unit indexes |
| `requirement_match_status` | Same rows and meaning; written in batches instead of one statement |
| Row-level security | Unchanged; the refresh runs in the tenant transaction, and every table keeps its company predicate |
| Audit, erasure, ADR-008 | Unaffected: a derived cache, not audited, and cascaded on requirement deletion as today |

## 6. API impact

| Item | Impact |
|---|---|
| Endpoints, request and response shapes, OpenAPI | **None** |
| CRM dashboard "no match" and "pending" figures | Same meaning; fresher at scale, because the refresh finishes in seconds instead of minutes |
| Requirement matching screens (B-1, B-2) | Unchanged (separate query) |
| Worker | Same job, schedule (every 15 minutes) and idempotency key; batched internally, with lock renewal |
| Web | No change |

## 7. Performance expectations

| Measure | Today | Expected | Acceptance |
|---|---|---|---|
| C4 company refresh, requirements company present | ~10 min | Seconds: named-area branch 33 ms measured, "anywhere" 66 ms per 2,000 | **Under 60 s, in both file orders** |
| Requirements company, 12,500 dense named-area requirements | 221 s | 27 s measured | Under 60 s |
| Drawn-area branch (25,000 requirements) | Not separately measured yet | Same shape as named areas | Measured and reported; under 60 s for the company |
| Longest transaction of a refresh | The whole refresh | One batch of 2,000 | Below the 300 s queue lock |
| `test:performance` | Fails in some orders; run file by file | One run, any order | Green twice, in two different orders |
| All other API and web budgets | Met | Unchanged | Re-run and reported |

## 8. Test strategy

1. **Equivalence (correctness first).** On one fixture set, the new `hasMatchSql` gives the same `has_match` as the current one for every case:
   - named locality, drawn area, "anywhere"
   - matched, unmatched and excluded listings
   - unpublished and archived listings
   - price, type, currency and bedroom boundaries
   - out of scope, and other company
   The current query is kept in the test as the reference.
2. **Cross-tenant plan check.** With a second large company seeded, an API test asserts from `EXPLAIN` that the named-area refresh reads addresses before listings. The order is fixed by the query shape, so the check is stable.
3. **Batching.**
   - More requirements than one batch: every active requirement gets a row.
   - Requirements made inactive lose their row.
   - A failure in a later batch leaves earlier batches committed; the next run completes them.
4. **Tenant isolation.** The refresh for company A never writes or reads company B's rows (row-level security plus an explicit test).
5. **Existing suites unchanged:** API end-to-end (matching, dashboards, requirements), SQL suites, web unit and browser tests.
6. **Performance:** the C4 test in both orders with the requirements test; the full `test:performance` in one run, twice; and the figures in §7.
7. **CI** green on the branch, then on `main` after the merge.

## 9. Risks

| # | Risk | Rating | Mitigation |
|---|---|---|---|
| R1 | The new query gives a different answer from today's in some case | Medium before tests, Low after | The equivalence test covers every D4 condition, with today's query as the reference; any difference stops the change |
| R2 | Very dense areas still take tens of seconds for a large company (27 s for 12,500) | Low | Background job every 15 minutes, batched; within the 60 s acceptance. A further index can be proposed later if real data needs it |
| R3 | Within one refresh, batches finish seconds apart | Low | Each row has its own `checked_at`; the dashboard already treats a row older than the requirement's last change as pending |
| R4 | The drawn-area branch behaves differently from named areas | Low | Measured during implementation (§7); reported before the pull request |
| R5 | Lock renewal adds a write per batch to the queue table | Low | At most a few updates per refresh |

## 10. Rollback approach

- The change is code only: no migration, no data change and no API change.
- **To roll back:** revert the #42 merge commit on `main` and deploy. The previous query and the single-transaction refresh return at once.
- `requirement_match_status` needs nothing: it is a derived cache, overwritten by the next refresh, whichever version wrote it.
- If a wrong figure were ever suspected after release, deleting a company's rows in that table makes its dashboard show "pending" until the next refresh (at most 15 minutes), with no other effect.

## 11. Estimated impact on Phase 7 readiness

| Item | Estimate |
|---|---|
| Implementation and tests | About one working day: two functions, the test changes, and the performance test change |
| Performance verification | About 2 hours of suite runs (both orders; full suite twice) |
| #42 report, pull request, CI, merge | Half a day, plus your review |
| **Effect on Phase 7** | The Phase 7 readiness process starts once #42 is merged, about 2 working days from approval of this plan. No Phase 7 design depends on this change, but Phase 7 lettings add rent listings and requirements, which grows exactly this workload; fixing it first removes a known scaling defect before that growth |
| Benefit for Phase 7 | The API performance suite runs as one suite again, in any order, so Phase 7 milestones can show the whole suite green instead of file by file |

## Approval

| Item | Decision | Date |
|---|---|---|
| #42 remediation plan | Awaiting approval | |
