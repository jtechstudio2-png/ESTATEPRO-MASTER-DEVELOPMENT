# Phase 6 · Milestone report: S6 Pipeline board, dashboards, close-out

| | |
|---|---|
| Date | 21 November 2026 |
| Branch | `phase-6/readiness`; commits `8460a1d` (S5 approvals recorded) to the report commit; CI: see §10 |
| Approvals | S5 approved with S5-D1 to S5-D13; S5-R1 to S5-R5 reviewed and accepted; S5-R4 kept open for review in S6 (20 November 2026). "Proceed with S6 according to the approved Phase 6 roadmap" |
| Scope | Readiness report §10, S6 "Pipeline board, dashboards, close-out": the Phase 6 parts of the approved role dashboards (Phase 3 design `06-role-dashboards.md` §4 CRM, §5 pipeline board, §10 My day), and the items left for Phase 6 to close: #44 (P6-0 R8b, before Phase 6 closes), S5-R4 (kept open for S6), S1-R3 (dashboard counts at scale, "to be measured in the S6 performance pass"), S3-R3 ("S6 dashboards can list them"). The Phase 6 close-out is in `PHASE-6-CLOSE-OUT-REPORT.md` |
| Not in scope | New dashboards beyond the approved design (rent, maintenance and finance dashboards follow their phases), landlord portal (Phase 7), commission records (finance phase) |
| Result | **S6 complete, awaiting approval.** Results in §3; CI in §10 |

## 1. Deliverables

### 1.1 API

| Change | Where | Detail |
|---|---|---|
| CRM dashboard: sales work | `GET /api/v1/dashboards/crm` → `sales` | `viewingsNeedingOutcome` (ended, still scheduled or confirmed, no outcome; viewing scope), `stalledDeals` (longer in their stage than it allows; deal scope), `openDealsOnClosedListings` (open deals whose listing is sold, rented, withdrawn or expired; deal scope). `null` without the permission. Each equals its list: `GET /viewings?filter[needsOutcome]=true`, `GET /deals?filter[attention]=stalled`, `…=listing_closed` |
| CRM dashboard: conversions | `leadsByStatus.converted`; `converted` on each agent and source row | Leads of the period converted to a deal (`convertedDealId`) |
| My day | `today[]` kinds `viewing` and `offer`; `waitingOnMe.viewingsNeedingOutcome`, `offersAwaitingResponse` | Viewings I conduct today (my time zone), with end time and the property's zone; offers awaiting a response (`submitted`) on deals I own or work on, or listings I am the agent of, within my offer scope, with the amount |
| Deals list | `filter[attention]=listing_closed` | The list behind the new count (S3-R3) |
| First response (#44) | `activities.service.ts` | A call logged to the minute in the minute the lead arrived answers it; recorded at the receipt time, never before (the database requires `first_response_at ≥ received_at`) |
| Connections | `database.module.ts` | PostgreSQL JIT off on every API and worker connection (S6-D6, §6) |

OpenAPI and the web API types regenerated. No migration: S6 adds no table, column, permission or trigger.

### 1.2 Web

| Screen | Change |
|---|---|
| CRM dashboard (D-C) | New "Sales work" panel: viewings without an outcome, stalled deals, open deals on a closed listing; every number links to its list (team list for managers). "Converted" in the status counts; "Converted to deal" column in the agent and source tables (the screen previously said this waited for Phase 6) |
| My day (D-M) | Today's viewings in the property's time zone with "Open" (the viewing drawer, where the outcome is recorded); offers awaiting a response with the amount, opening the deal's Offers tab; "Waiting on me" adds my viewings without an outcome and offers awaiting a response; "Converted" in my leads; "Book viewing" in quick actions |
| Pipeline board (PB-1) | "Weighted forecast, this quarter" line per currency (never converted), with "How is this calculated?" linking to the forecast (design 06 §5) |
| Deals list (DL-1) | "Listing closed" attention filter |
| Viewings to follow up (V-5) | Mine or Team kept in the URL, so dashboard links open the right view |
| Search fields (S5-R4) | Contact search, record search (listings, deals) and the people picker accept typing only once they can search (§2, S6-D4) |

Messages: 15 new keys in English and Arabic (3,105 in each language, checked).

## 2. Decisions taken in S6 (for approval)

| # | Decision | Reason | Status |
|---|---|---|---|
| S6-D1 | **Dashboard scope.** S6 adds the Phase 6 panels of the approved Phase 3 dashboard design (06 §4, §5, §10) to the existing CRM dashboard, My day and pipeline board. No new dashboard and no new wireframe: the panels follow the approved layouts and rules (every number links to its list, counts in the viewer's scope, money per currency) | Readiness §10 S6; the board itself was delivered in S5 | For approval |
| S6-D2 | **"Sales work" counts.** Viewings needing an outcome, stalled deals and open deals on a closed listing ("closed" = sold, rented, withdrawn or expired). Open deals on a closed listing are listed for a person to close; they are not closed automatically | S3-R3 (approved: "S6 dashboards can list them"); P6-D4 keeps other buyers' deals open | For approval |
| S6-D3 | **Offers on My day** are offers awaiting a response (`submitted`) on deals I own or work on, or on listings I am the agent of, and only within my offer scope: a listing agent who is not on the deal sees nothing they could not open | Design 06 §10 "offers awaiting response on their listings", without widening offer scope (S2-D2) | For approval |
| S6-D4 | **S5-R4 fix: search fields accept typing once they can search.** The contact search, record search and people picker are disabled until the page has hydrated (in practice a fraction of a second after it appears). Investigation showed the field could take focus before the page was ready, so the combobox never knew it was focused and never opened its results, and React could clear text typed in that moment. Replaying the typed text and focus was tried and did not make it reliable (5 of 10 runs still failed), so it was not kept. The original L-3 test from before S5 is restored and passes 10 of 10 unchanged | S5-R4 kept open for S6; a fix that can be shown to work | For approval |
| S6-D5 | **#44: first response to the minute.** A call or meeting logged in the same minute as the lead's receipt answers the lead, recorded at the receipt time; one logged in an earlier minute still does not | P6-0 R8b, Medium, "fix before Phase 6 closes" (approved 13 November) | For approval |
| S6-D6 | **PostgreSQL JIT off for the API's connections** (`-c jit=off` on the pool). At 20,000 listings the planner's cost estimate for the property dashboard's correlated counts started the JIT compiler, adding about 0.4 s to a 12 ms query (§6). The API runs short queries only; JIT helps long analytical scans, which the API does not run | Found by the S6 performance pass (S1-R3); one setting in one place | For approval |
| S6-D7 | **Quarter forecast on the board** sums the forecast's months of the current calendar quarter, per currency, with exact decimal arithmetic. Deals whose close date in the quarter has already passed count as overdue in the forecast (FC-1), not in the quarter line | Design 06 §5; FC-1 rules (S3) unchanged | For approval |

## 3. Tests

| Suite | Result | S6 additions |
|---|---|---|
| API unit and end-to-end (`test:ci`) | **561 of 561 pass** (45 files); coverage 96.19% statements, 98.34% lines | Dashboards: "sales work on the dashboards (Phase 6, S6)": counts equal their lists, scope by role (owner, office manager, agent), another office and another company see zero, My day viewings and offers, conversions; existing dashboard assertions extended. Activities: #44 same-minute first response and earlier minute |
| API performance | **13 of 13 pass**, each on its own database (§6) | `sales-dashboards.performance.test.ts` |
| Web unit | **100 of 100 pass** (20 files) | `useHydrated`; quarter start, exact decimal sums and the quarter forecast |
| Web lint, typecheck; API lint, typecheck | Pass (9 existing CSS warnings, unchanged) | — |
| Messages | 3,105 keys in English and Arabic, checked | 15 keys |
| Browser (Playwright, axe) | **107 of 107 pass** (CI set, `next` 15.5.29); performance pass separately (§6.2) | "S6 dashboards: sales work on D-C, offers and viewings on My day, the quarter forecast on the board"; the CRM dashboard in the Arabic axe loop (320 px and desktop); L-3 restored to its original form (S6-D4) |
| Dependency scan | Clean after `next` 15.5.29 (S6-R5) | — |

### 3.1 Defects found and fixed during S6

| Defect | Found by | Fix |
|---|---|---|
| The property dashboard took up to 3.9 s at 20,000 listings and 200,000 viewings (S1-R3) | S6 performance test | S6-D6; measured again in §6 |
| The V-1 browser test opened the last viewing drawn on the week, which late in the day is the past one (no Confirm button) | Whole browser suite | The test picks tomorrow's viewing by its time |
| Text typed into a search field before hydration was not searched (S5-R4) | S5, kept open | S6-D4 |
| A call logged in the minute a lead arrived did not count as its first response (#44) | P6-0 review | S6-D5 |
| Three advisories published against `next` 15.5.28 failed the dependency scan (CI run 156) | CI | Upgraded to 15.5.29 (S6-R5) |

## 4. Security impact

| Control | Evidence |
|---|---|
| Every new count is computed in the viewer's own scope (viewing, deal and offer scope) and matches a list the viewer can open | API tests: owner, office manager, other office, agent, other company |
| Tenant isolation | Dashboards run in the tenant transaction (row-level security); another company sees zero on every new count (API test) |
| My day shows only the member's own viewings and offers within their offer scope (S6-D3) | API test: a second agent sees none |
| No new data, permission or endpoint; no personal data beyond what each list already shows | — |

## 5. Compliance and audit impact

| Item | Effect |
|---|---|
| ADR-008 | Unchanged: dashboards read the pipeline tables; nothing new is stored |
| Audit | Unchanged: dashboard reads are not audited (as before); the first-response change is part of the existing `activity.logged` entry (`firstResponseFor`) |
| Erasure | Unchanged: erased contacts appear as the lists show them |

## 6. Performance

### 6.1 API (readiness volumes; every performance test, each on its own database)

New test `sales-dashboards.performance.test.ts`: one company with 20,000 live listings (1 in 50 sold), 20,000 open deals, 100,000 offers and 200,000 viewings, 20 agents; property dashboard ("No viewing in 21 days"), CRM dashboard with the sales work, My day with viewings and offers, and the "listing closed" deals list, as owner, manager and agent.

| Measurement | Before S6-D6 | After S6-D6 | Budget |
|---|---|---|---|
| Phase 6 dashboards p95 | 1,204 ms (property dashboard up to 3,850 ms) | **129 ms** (slowest 221 ms) | 1,000 ms |
| Property dashboard query alone | about 450 ms (JIT compile) | 12 ms | — |

The cause (S1-R3): at this volume the planner's cost estimate for the property dashboard's per-listing counts passed PostgreSQL's JIT threshold, and compiling the query took about 0.4 s every time. S6-D6 turns JIT off for the API's connections.

Every existing performance test was run again with JIT off, to show nothing else slowed:

| Test | p95 | Budget |
|---|---|---|
| Listings (100,000) | 182 ms | 1,000 ms |
| Location (100,000) | radius 149, pages 95, city map 140, clustered 352, polygon 34, notes 18 ms | 1,000 / 500 / 500 / 800 / 1,000 / 300 ms |
| Media | 1.46 s per 12 MP photo; gallery p95 117 ms | as Phase 4 |
| Contacts (100,000) | 300 ms | 1,000 ms |
| Requirements and KYC | 576 ms | 1,000 ms |
| Leads, timeline, follow-ups | 247 ms | 1,000 ms |
| CRM, admin, My day dashboards (C4) | 433 ms; exports within budget | 1,000 ms; 5,000 ms |
| Key rotation and erasure | 3 of 3 pass | as Phase 5 |
| Viewings (200,000) | 398 ms | 1,000 ms |
| Offers (100,000) | 62 ms | 1,000 ms |
| Deals (20,000) | 178 ms | 1,000 ms |
| Landlord views | 177 ms | 1,000 ms |
| Phase 6 dashboards (new) | 129 ms | 1,000 ms |

**Running all 13 files in one database still fails in some orders.** When the requirements test's company is in the database, the C4 test's worker run takes more than 10 minutes. This is #42 (match refresh, High, approved for remediation before Phase 7), recorded on 13 November with JIT on as well (over 321 s on `main`). It is not caused by S6. It is why earlier milestones ran each test on its own database (S3 report §6), and S6 does the same. During S6 the test machine also ran out of disk (an old test-media volume, 15 GB, removed); the runs above were made afterwards.

### 6.2 Web

Performance pass (`@performance`, production build, `next` 15.5.29): 28 screens. Every screen shows its data within 4,000 ms (ready 192 to 656 ms), and every screen without a map uses at most 300 KB of script (226 to 276 KB). The two map screens stay within their own Phase 4 budget (535 and 563 KB). New in S6: "CRM dashboard with sales work": ready 328 ms, 227 KB.

The performance pass runs on its own, as in CI (`test:e2e:ci`, then `test:e2e:performance`). It creates its own sales data, so running it in the same pass as the other browser tests makes P-1 and the sales tests find extra rows. That is a test arrangement, not a product fault.

## 7. Accessibility and localisation

New panels follow the dashboard rules (design 06 §1): every number is a link with its label, warnings carry an icon and words, never colour alone; tables keep headers. The CRM dashboard is checked with axe in Arabic at 320 px and desktop (with the Phase 6 screens), and in English with the S6 browser test; My day in English. Amounts per currency, isolated left to right; viewing times in the property's time zone with its name. 15 new message keys in both languages (3,105 each, checked).

## 8. Risks and open items (for review)

| # | Risk | Rating | Mitigation |
|---|---|---|---|
| S6-R1 | JIT is off for every API connection (S6-D6). A future long analytical query run by the API would not get JIT's speed-up | Low | All 13 performance tests pass with it off (§6.1). Reports and exports that need JIT can turn it on for their own transaction (`set local jit = on`) |
| S6-R2 | #42 still open: the requirement match refresh can take minutes when another large company shares the database, and the whole performance suite fails in some file orders | High (unchanged) | Approved for remediation before Phase 7; proposed as the next milestone (§9). Each performance test runs on its own database meanwhile |
| S6-R3 | The quarter forecast on the board leaves out deals whose close date in the quarter has passed (S6-D7) | Low | They show as overdue in the forecast (FC-1), which the line links to |
| S6-R4 | Search fields are disabled for a fraction of a second after a page appears (S6-D4) | Low | Shown as disabled (not hidden); the alternative lost what people typed |
| S6-R5 | `next` 15.5.28 had three new advisories published during S6 (GHSA-7qx7-33qx-rqx2, GHSA-f3mh-rxg3-f5g2, GHSA-pc58-hwjq-p385), failing the dependency scan | — | **Closed:** upgraded to 15.5.29 (patch release); `pnpm audit` reports none; full checks and browser suite re-run (§3) |

Earlier risks closed in S6: **S5-R4** (fixed, S6-D4); **S1-R3** (measured; the outlier fixed, S6-D6); **S3-R3** remains accepted as designed, now with its count and list (S6-D2). Issues **#43** and **#44** are fixed by S6 and proposed for closing on your approval; **#5** (S4) and **#15** (P6-0) were delivered and are still open on GitHub, also proposed for closing. No issue has been closed.

## 9. Next

Phase 6 close-out: `PHASE-6-CLOSE-OUT-REPORT.md`. Proposed next, before Phase 7: #42 (match refresh), per the approval of 13 November. Merge to `main` only on your approval, through a reviewed pull request.

## 10. GitHub references

| Reference | Link |
|---|---|
| Phase 6 close-out report | `docs/phase-6/PHASE-6-CLOSE-OUT-REPORT.md` |
| S5 report (approved) | `docs/phase-6/S5-SCREENS-REPORT.md` |
| Issues #42, #43, #44 | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/42 · /43 · /44 |
| CI | Run 158 on `60fb926`, all jobs green: https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/44848059915 (run 156 failed only on the dependency scan, fixed by S6-R5; run 157 failed on the same scan before the upgrade) |

## Approval

| Item | Decision | Date |
|---|---|---|
| S6 (pipeline board, dashboards, close-out) | Awaiting approval | |
| S6-D1 to S6-D7 | Awaiting approval, each individually | |
| S6 risks | Awaiting review | |
