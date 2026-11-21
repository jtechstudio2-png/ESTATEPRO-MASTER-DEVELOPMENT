# Phase 6 · Close-out report: sales pipeline

| | |
|---|---|
| Date | 21 November 2026 |
| Branch | `phase-6/readiness` (not merged; `main` unchanged since PR #39) |
| Scope | The approved Phase 6 roadmap (readiness report §10): P6-0, P6-W, S1 to S6 |
| Result | **All Phase 6 milestones delivered and approved; Phase 6 close-out approved (21 November 2026).** Merge to `main` through a reviewed pull request once Phase 6 is approved (§6) |

## 1. Milestones

| Milestone | Delivered | Report | Approval |
|---|---|---|---|
| P6-0 | Deterministic history ordering (#15), sales-pipeline data protection, ADR-008 | `P6-0-REPORT.md` | **Approved** 13 November 2026 (P60-D1 to P60-D8, ADR-008) |
| S1 | Viewings: booking rules, calendar, confirm, reschedule, cancel, outcome, feedback, key check-out | `S1-VIEWINGS-REPORT.md` | **Approved** 14 November 2026 (S1-D1 to S1-D12) |
| S2 | Offers: record, counter, accept, reject, withdraw, expiry; listing and deal effects | `S2-OFFERS-REPORT.md` | **Approved** 14 November 2026 (S2-D1 to S2-D13; S2-R1 to S2-R4 accepted) |
| S3 | Deals, lead conversion, milestones, KYC, completion and ownership transfer, forecast | `S3-DEALS-REPORT.md` | **Approved** 14 November 2026 (S3-D1 to S3-D16; S3-R1 to S3-R6 accepted) |
| S4 | Landlord visibility of offers, deal progress and viewing feedback (#5) | `S4-LANDLORD-VISIBILITY-REPORT.md` | **Approved** 15 November 2026 (S4-D1 to S4-D9; S4-R1 to S4-R4 accepted) |
| P6-W | Wireframes and verification for the Phase 6 screens | `P6-W-WIREFRAMES.md`, `P6-W-VERIFICATION.md` | **Approved** 15 November 2026 (W-D1 to W-D5; WR-1 to WR-4 accepted) |
| S5 | Screens to the approved wireframes | `S5-SCREENS-REPORT.md` | **Approved** 20 November 2026 (S5-D1 to S5-D13; S5-R1 to S5-R5 accepted; S5-R4 kept open for S6) |
| S6 | Pipeline board forecast line, dashboards, close-out (#44, S5-R4, S1-R3, S3-R3) | `S6-DASHBOARDS-CLOSE-OUT-REPORT.md` | **Approved** 21 November 2026 (S6-D1 to S6-D7; S6-R1 to S6-R5 reviewed; S6-R2 stays open, High) |

## 2. Items Phase 6 was to close

| Item | Outcome |
|---|---|
| #15 deterministic history ordering | Delivered in P6-0 (approved). **Closed** on approval, 21 November 2026 |
| #5 landlord visibility (P1–P3) | Delivered in S4 (approved). **Closed** on approval, 21 November 2026 |
| #44 first response in the same minute | Fixed in S6 (S6-D5). **Closed** on approval, 21 November 2026 |
| #43 L-3 browser test timing | The cause was the product behaviour behind S5-R4, fixed in S6 (S6-D4); the original test passes 10 of 10. **Closed** on approval, 21 November 2026 |
| S5-R4 (kept open for S6) | Fixed (S6-D4); closed with S6 |
| S1-R3 (dashboard counts at scale) | Measured in S6; a 3.9 s outlier found and fixed (S6-D6); closed with S6 |
| S3-R3 (open deals on sold listings) | Counted and listed in S6 (S6-D2); the risk itself stays accepted (deals are not closed automatically) |
| Readiness R7 (key check-out contact scope) | Fixed in S1 |
| Readiness R9, R10 | Closed (R9 by decision 13 November; R10 by P6-W) |

#5, #15, #43 and #44 closed on approval, 21 November 2026.

## 3. Open risks carried beyond Phase 6

| # | Risk | Rating | Owner / when |
|---|---|---|---|
| #42 (S6-R2) | Requirement match refresh at multi-tenant volume | **High, open** | First after the Phase 6 merge, before Phase 7 (21 November 2026) |
| Readiness R3 / #20 | Buyers and sellers of completed sales cannot be erased until a retention period is set | Medium (by design) | Legal review #20 |
| Readiness R5, S3-R5 | No commission records (splits and forecast only) | Medium | Finance phase |
| Readiness R4, S3-R4 | Letting deals stop at "terms agreed" | Low | Phase 7 |
| Readiness R6 | Accountant audit-log limit not enforceable yet | Low | When an audit-log viewer is built |
| S1-R2 | Viewing reminders written to the outbox, not delivered | Low | Phase 12 (P6-D14) |
| S3-R1, S3-R2, S3-R3, S3-R6 | Seller KYC needs a recorded owner; whole-property ownership not split; other deals on a sold listing stay open; totals per currency | Low | As accepted |
| S4-R1 to S4-R4 | Landlord view paging, management-agreement visibility, onboarding, typed offer conditions (#35) | Low | Phase 7 |
| S5-R1, S5-R2, S5-R3, S5-R5 | Message bundle size, booking time zone, calendar paging, offers per deal | Low | As accepted |
| S6-R1, S6-R3, S6-R4 | JIT off; quarter line leaves out overdue deals; search fields disabled until hydrated | Low | Reviewed 21 November 2026 |
| #6, #28, #20, #24, #25 and other launch blockers | Unchanged by Phase 6 | High (launch) | Their phases |

## 4. Standards maintained across Phase 6

| Standard | Evidence |
|---|---|
| Tenant isolation | Row-level security on every Phase 6 table; cross-company tests in every milestone (viewings, offers, deals, landlord views, dashboards) |
| ADR-008 | Pipeline records protected for erasure and retention as approved; erasure blockers shown with reasons; tests in P6-0 and S3 |
| Audit integrity | Every state change audited in the same transaction; history guards (append-only) tested in SQL suites 13 to 16 |
| Erasure protections | Erasure coverage and blockers for viewings, offers, deals and parties; replay tested |
| Accessibility, RTL, localisation | axe on every Phase 6 screen in English and Arabic at 320 px and desktop; 3,105 message keys in each language, checked in CI |
| CI | Every milestone closed on a green CI run (see each report) |
| Performance | All API and web budgets met at the readiness volumes (S6 report §6) |
| Earlier phases unchanged | No change to Buildora, Praiseflow, Cleanora or other existing work; Phase 1 to 5 tests pass unchanged except where a report records a reason |

## 5. Code size and tests (Phase 6)

Migrations 0029 to 0034; SQL suites 13 to 16; API end-to-end tests for every Phase 6 endpoint; 13 performance tests; 107 browser tests (all screens); unit tests for the sales rules. Figures for the final commit are in the S6 report §3.

## 6. Merge readiness

| Check | State |
|---|---|
| All milestones approved | Yes (21 November 2026) |
| CI green on the final commit | Run 158 green on `60fb926` (S6 report §10); this report commit re-runs CI |
| Open High issues introduced by Phase 6 | #42 (approved for remediation before Phase 7) |
| Pull request | One reviewed pull request `phase-6/readiness` → `main` (approved 21 November 2026) |

## Approval

| Item | Decision | Date |
|---|---|---|
| Phase 6 close-out | **Approved** | 21 November 2026 |
| Closing #5, #15, #43, #44 | **Approved**; closed | 21 November 2026 |
| One reviewed pull request `phase-6/readiness` → `main` | **Approved** | 21 November 2026 |
| Phase 7 | Not started until the Phase 6 branch is merged. After the merge: #42 first, then the standard readiness process, with the Phase 7 readiness report before implementation | 21 November 2026 |
