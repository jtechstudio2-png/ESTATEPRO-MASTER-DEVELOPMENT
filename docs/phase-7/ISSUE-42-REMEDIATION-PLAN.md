# Issue #42 · Remediation plan: requirement match refresh across tenants

| | |
|---|---|
| Date | 21 November 2026 |
| Issue | [#42](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/42), High; S6-R2. Approved on 13 and 21 November 2026 for remediation before Phase 7 |
| Branch | `issue-42/match-refresh`, from `main` at `a551ee7` (Phase 6 merge) |
| Status | **Plan for approval.** No code is changed until this plan is approved |

## 1. Measured cause

Reproduced on 21 November 2026 with the two performance-test companies in one database. The first is the C4 company: 20,000 active requirements (4,000 with named areas) and 9,974 published listings, all in one locality. The second is the requirements-test company: 50,000 active requirements and 19,984 published listings. JIT was off, as in production since S6-D6.

| Branch of the match test (`hasMatchSql`) | C4 company today |
|---|---|
| "Anywhere" requirements | 66 ms for 2,000; healthy |
| Named-area requirements (`area_localities`) | **58 s for 400**, about 10 minutes for all 4,000 |

The plan for named areas starts from the listings price index; the estimate is 4 rows per requirement, but the actual is 1,273. For each candidate listing it then re-reads every address in the company: 297,645 address scans and 13.4 million buffer reads for 400 requirements. The optimisation fence added in C4 (`OFFSET 0` on the address subquery) does not stop this. The planner still places the fenced subquery on the inner side of the loop, and it does so because of statistics that include other tenants' rows. The drawn-area branch (`area_west`…) has the same shape and is expected to behave the same way.

## 2. Options tried (same data)

| Approach | C4 company (no matches) | Requirements company (12,500 matches) | Result |
|---|---|---|---|
| Today's query | ~10 min | 221 s | Too slow both ways |
| Set-based join on `= any(array)` | 15.9 s | — | Planner still starts from listings |
| Unnest localities, then hash join | 19.4 s | — | Same |
| Requirement × address pairs first (materialised) | 36 ms | 150 s | Pairs explode where areas are dense |
| **Address-driven, nested `LIMIT 1` check per address** | **33 ms** | **27 s** | Same answers as today on both companies; order fixed by the query shape, not by statistics |

## 3. Plan

1. **Rewrite the area branches of `hasMatchSql`** (`apps/api/src/contacts/requirement-matching.ts`):
   - For each requirement, loop over the addresses in its area: the locality index for named areas, the coordinate columns for drawn areas.
   - For each address, check the listings with one scalar subquery ending in `LIMIT 1`. PostgreSQL cannot reorder or pull up such a subquery, so the address is always read first, and the check stops at the first match.
   - Matching rules (decision D4), listing scope and exclusions stay exactly as they are; only the order of reading changes. The "anywhere" branch stays as it is.
2. **Refresh in batches** (`refreshRequirementMatches`, worker job `requirement.match_refresh`): about 2,000 requirements per transaction, in id order. This bounds each transaction's length; a slow company no longer holds one transaction open for minutes. Results and the stale-row clean-up are unchanged.
3. **Make the performance tests independent of file order:**
   - The C4 test's worker run refreshes only its own company. Today it runs the scheduled jobs of every company in the shared test database, which is how it picked up the requirements test's 50,000 requirements.
   - Tokens are issued after the worker run.
4. **Tests:**
   - An equivalence test: old rules and new query give identical `has_match` across named-area, drawn-area, "anywhere", excluded, out-of-scope and other-company cases.
   - A plan check: with a second large company present, the refresh for a named-area requirement reads addresses before listings, asserted from `EXPLAIN`.
   - Existing matching and dashboard tests unchanged.
5. **Acceptance:**
   - The refresh for the C4 company stays under 60 s with the requirements company present, in both file orders. 33 ms is measured for the named-area branch.
   - The whole `test:performance` suite passes in one run, in any order. This was not possible before, so earlier milestones ran each file on its own database.
   - All other budgets unchanged, and CI green.
6. **Report:** a short #42 report in the standard format (decisions, tests, performance, risks), then one pull request to `main` and closing #42, each on your approval.

## 4. Scope and safeguards

- No migration, no new index, no API or screen change, and no change to Phase 1 to 6 behaviour: only the query shape and the transaction size.
- Tenant isolation: the refresh still runs in the tenant transaction under row-level security, and the company predicate is kept on every table.
- Audit and erasure are unaffected; the match status is a derived cache and is not audited.

## 5. Risks

| # | Risk | Rating | Mitigation |
|---|---|---|---|
| R1 | Dense areas (every requirement in one big locality) still take tens of seconds for a large company (27 s for 12,500) | Low | Runs every 15 minutes in the background, in batches; well under the 60 s acceptance. A per-company index on listings by unit for published rows can be added later if needed |
| R2 | Batching means a requirement's status can be at most one batch apart in time within one refresh | Low | The status is already up to 15 minutes old by design; each row carries its own `checked_at` |

## Approval

| Item | Decision | Date |
|---|---|---|
| #42 remediation plan | Awaiting approval | |
