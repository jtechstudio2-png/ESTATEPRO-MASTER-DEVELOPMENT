# Phase 6 · Milestone report: S1 Viewings

| | |
|---|---|
| Date | 13 November 2026 |
| Branch | `phase-6/readiness`, commits `2c5982c` (implementation) and the report commit; CI run 117 |
| Approvals | P6-0 approved, ADR-008 accepted, P60-D1 to P60-D8 approved (13 November 2026). "You may proceed to S1 (Viewings) according to the approved Phase 6 roadmap" |
| Scope | Viewings as approved in the readiness report: book, confirm, reschedule, cancel, record outcome and feedback, no-show; the agent calendar; conflict check; key check-out for a viewing; "viewings needing feedback" (§2.1, §4.1); the "No viewing in 21 days" listing flag (§5); the contact-scope fix for key check-out (readiness R7) |
| Not in scope | Offers (S2), deals (S3), landlord visibility (S4, the feedback-sharing choice is recorded now and shown to landlords in S4), screens (S5, after the P6-W wireframes), delivery of reminders (Phase 12) |
| Result | **S1 complete**, for approval before S2. Results in §3; CI run 117 green (§9) |

## 1. Deliverables

### 1.1 Database (migration 0031)

| Rule | Detail |
|---|---|
| Booking | A viewing is for a live listing (available, reserved or under contract, not archived) and that listing's unit; the unit is not under maintenance; a deal, when given, is open and for the same listing |
| Recording | Completed or no-show only once the viewing has started |
| Attendees | At least one, except an open house, checked at commit (viewing and attendees in one transaction); attendees of a finished viewing never change |
| Rescheduling | The old viewing points at its replacement, written in the same transaction (link checked at commit) |
| Keys | `key_movements.viewing_id`: a check-out may name the viewing it is for |
| Read paths | Team calendar index by time; recent-viewing index per listing for the 21-day flag |

These add to the viewing rules of migrations 0007 (no overlapping live viewings for one agent) and 0030 (allowed statuses, final once finished, no deletes, erasure of feedback).

### 1.2 API

| Endpoint | Purpose | Permission |
|---|---|---|
| `GET /api/v1/viewings` | Calendar and lists: time range, agents, status, listing, lead, deal, contact (attendee), `needsOutcome` ("needing feedback"); time order, cursor paging | `viewing.view` |
| `POST /api/v1/viewings` | Book (optionally already confirmed), from a lead or an open deal | `viewing.manage` |
| `GET /api/v1/viewings/{id}` | One viewing with attendees, outcome, links, same-unit warnings | `viewing.view` |
| `POST …/confirm` | Confirm | `viewing.manage` |
| `POST …/reschedule` | New time (and agent, managers): old kept as rescheduled, new one returned | `viewing.manage` |
| `POST …/cancel` | Cancel with a reason | `viewing.manage` |
| `POST …/outcome` | Outcome, feedback, attendance, optional sharing; final (P6-D3) | `viewing.manage` |
| `POST …/no-show` | No-show; every attendee absent | `viewing.manage` |
| `POST …/feedback-sharing` | Share (or stop sharing) feedback with the landlord (#5, shown in S4) | `viewing.manage` |
| `POST …/keys/check-out` | Keys for the viewing, to its agent or an attendee | `key.issue` |

Other changes: `filter[attention]=no-viewing` on listings and `noViewing` on the property dashboard counts; `viewingId` on key movements; the access report (G3) gains `viewings`; key check-out to a contact now requires a contact in the member's contact scope (readiness R7).

All writes take `If-Match` (except booking and keys), return `ETag`, and answer refusals with a field and a code (screens translate codes, as since C6).

## 2. Decisions taken in S1 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| S1-D1 | "Live listing" means available, reserved or under contract, not archived; the unit must not be under maintenance | Readiness §4.1 and §5; second viewings after an accepted offer remain possible |
| S1-D2 | Viewing scope: **all**; **office** = listings of the member's offices; **own** = viewings the member conducts, and viewings of their listings, of leads assigned to them and of deals they own | Readiness §4.1 ("agents for their own listings, leads and deals") |
| S1-D3 | Booking needs `viewing.manage` covering the listing, lead or deal (conducting it does not count for own scope). Booking for another agent is a manager action (office or company scope); the agent must be active staff with `viewing.manage`, in one of an office manager's offices | Same rule as follow-ups (D6) |
| S1-D4 | Rescheduling keeps the old viewing (status rescheduled, linked) and books a new one with the same attendees; the response is the new viewing | Keeps the history of what was arranged |
| S1-D5 | Outcome or no-show only once the viewing has started; attendees not listed as absent are recorded as attended; a no-show marks every attendee absent | Readiness §4.1 diagram |
| S1-D6 | Booking from a **new** lead moves it to contacted; a deal at lead or qualification moves to the viewing stage, with the stage note "Viewing booked" | Readiness §4.1 effects |
| S1-D7 | An agent cannot hold two overlapping live viewings (refused, 409, database); the same unit at the same time is a warning (`unitConflicts`) | Readiness §4.1 conflicts |
| S1-D8 | New times are from now on (5 minutes' tolerance); a viewing lasts at most 8 hours | Guards against typing errors; open houses fit |
| S1-D9 | "No viewing in 21 days": available listings on the market for 21 days with no scheduled, confirmed or completed viewing starting in the last 21 days | Readiness §5 (flag hidden since Phase 4) |
| S1-D10 | Keys for a viewing go to its agent or an attendee, due back one hour after the viewing unless given; any contact key holder must be in the member's contact scope | Readiness R7 |
| S1-D11 | Reminders: outbox events only (booked, confirmed, rescheduled, cancelled, completed, no-show, feedback shared) with times and time zone; delivery in Phase 12. Booking, rescheduling, cancelling and completing add system entries to the timeline of the listing, lead and attendees | P6-D14 |
| S1-D12 | S1 delivers the API and database; screens follow the P6-W wireframes in S5, as in the approved milestone order | Readiness §10 |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `database/tests/13_viewings_s1.sql` (booking on live listings, unit, maintenance, deal; attendee required except open house; agent overlap; timing of outcome and no-show; attendees fixed once finished; rescheduling link; keys for a viewing; isolation) | 21 assertions | ✅ |
| All SQL suites (`database/scripts/verify.sh`) | 14 files, 31 migrations | ✅ |
| `api/test/viewings.e2e.test.ts` (booking and effects, refusals with codes, conflicts and warnings, deal stage, scope for agent, manager, accountant, other company, lifecycle, outcome rules, no-show, calendar paging, keys and R7, 21-day flag, access report, erasure) | 21 | ✅ |
| Updated tests: `keys.e2e` (contact holder must be in scope, R7), `p6-0-sales-records.e2e` (viewing fixture follows S1 rules), `activities-tasks.e2e` (audit read ordered by `entry_no`, #15) | — | ✅ |
| Full API suite (`test:ci`) | 513 in 41 files | ✅ |
| API performance: viewings (200,000) | 1 | ✅ (§6) |
| API performance: listings, dashboards, data protection, re-run after S1 | 5 | ✅ |
| Web: typecheck, lint, message check (2,572 keys in both languages), unit tests | 79 | ✅ |
| Browser suite (CI, functional and accessibility, English and Arabic) | 93 | ✅ (run 117) |

API coverage: 96.08 % statements, 90.72 % branches, 98.42 % functions, 98.26 % lines (thresholds 95/90; up from 95.95/90.50). Viewings module: 98.8 % statements, 92.5 % branches.

### 3.1 Defects found and fixed during S1

| Defect | Found by | Fix |
|---|---|---|
| Own-scope agents could book on any listing, because conducting the viewing counted as "own" | S1 scope test | Booking checks the listing, lead or deal only (S1-D3) |
| `Intl.DateTimeFormat` refuses a time-zone name together with date and time styles (500 on booking) | S1 API test | Explicit date and time fields |
| Audit metadata carried free text (feedback, cancel and reschedule reasons, no-show note), against ADR-008 §5 | Review of S1 against ADR-008 | Removed from metadata; the no-show note goes to the timeline; tests check no free text reaches audit |
| An activities test read two audit rows without an order and assumed the first was the earlier (order not guaranteed; the #15 problem in a test) | Full API run | Ordered by `entry_no` |

## 4. Security impact

| Control | Evidence |
|---|---|
| Viewings follow record scope (all, office, own); a member outside scope gets 404; a member who can see but not manage gets 403 | API tests (agent, manager, accountant) |
| Accountants read every viewing and change none (`viewing.view` all, no `viewing.manage`) | API test |
| Booking for someone else only by managers within their offices | API test |
| Attendees, leads and deals must be visible to the member; deal scope by `deal.view` | API tests |
| Key check-out to a contact limited to the member's contact scope (readiness R7, closed) | API tests (`keys.e2e`, `viewings.e2e`) |
| Rules hold for every path, not only the API (database triggers) | SQL suite 13 |
| Tenant isolation: another company sees no viewings or attendees, cannot book on, read or act on this company's viewings | SQL suite 13; API test |

No new protected fields (P6-D13). Meeting point and feedback carry the "do not type identity or bank numbers" guidance in the API description (#35).

## 5. Compliance and audit impact

| Item | Effect |
|---|---|
| Erasure | Viewing feedback, cancellation reason and meeting point erased with the person; outcome, times and status kept (migration 0030; API test) |
| Access requests (G3) | The access report lists the person's viewings: listing, type, status, times, meeting point, outcome, feedback, cancellation reason and their attendance (API test) |
| Feedback to landlords | Only feedback explicitly shared is eligible for the landlord views of S4; the choice is audited |
| Audit actions | `viewing.booked`, `.confirmed`, `.rescheduled`, `.cancelled`, `.completed`, `.no_show`, `.feedback_shared`; lead status changes caused by a viewing are audited as `lead.status_changed` with `by: viewing`; deal stage changes are recorded by the database (ADR-008) |
| Audit content | Ids, codes, times and the outcome in metadata; no free text (feedback, reasons, notes stay in the viewing record and the timeline, both reached by the erasure; ADR-008 §5). Tested |
| Outbox | One event per action, for reminders and notifications in Phase 12 |
| History order | Viewings are ordered by time then id (they are records, not a history stream); all audit and outbox rows carry `entry_no` (#15) |

ADR-008 §5 listed the viewing audit actions before S1; `viewing.no_show` is added (S1-D5).

## 6. Performance

Budget (readiness report §10): API p95 under 1,000 ms with 200,000 viewings in one company.

| Measure | Result |
|---|---|
| Data | 1,000 listings, 50 agents, 20,000 contacts, 200,000 viewings over a year |
| All requests (44, as owner, sales manager and agent) | median 90 ms, **p95 328 ms**, slowest 360 ms |
| Agent's week / past week / default list | 123 / 99 / 46 ms (max) |
| Team week (manager, owner) / five agents' week | 109 / 128 ms |
| Needing feedback | 140 ms |
| A listing's / a contact's viewings | 118 / 360 ms |
| One viewing | 21 ms |
| "No viewing in 21 days" filter / property dashboard counts | 22 / 27 ms |
| Booking (checks, effects, timeline, audit, outbox) | 57 ms |
| Migration 0031 | Adds triggers, two indexes and one column; no data rewritten |

Existing suites re-run after S1, each on its own database: listings p95 203 ms; dashboards p95 557 ms (match refresh 4.2 s); field-key rotation 25,000 values in 17.5 s; lookup rotation 3.9 s; erasure 274 ms. All within budget. The order-dependent failure of the dashboards and media suites when run together (#42) is unchanged.

## 7. Accessibility and localisation

S1 adds no screens (S1-D12). Every refusal carries a stable code (for example `listing-not-live`, `unit-under-maintenance`, `not-started`, `not-attendee`, `not-for-viewing`) for the screens to translate in English and Arabic in S5; times are returned in UTC with the property's time zone (IANA name) for display. The message files are unchanged (2,572 keys in each language, checked). Accessibility (axe in English and Arabic, desktop and 320 px) applies to the S5 screens.

## 8. Risks and open items

| # | Item | Rating | Status |
|---|---|---|---|
| S1-R1 | Screens for viewings (calendar, booking, outcome) wait for the P6-W wireframes | — | As planned (S5) |
| S1-R2 | Reminders are written to the outbox but not delivered until Phase 12 | Low | P6-D14 |
| S1-R3 | The property dashboard counts with the 21-day flag were measured with 1,000 listings and 200,000 viewings, not with 100,000 listings | Low | Index-backed per-listing check; to be measured in the S6 performance pass |
| S1-R4 | Viewings on letting listings follow the same rules; lettings stop at "terms agreed" (P6-D2) | — | As approved |
| — | #42 (match refresh, before Phase 7), #44 (first response, before Phase 6 closes), #43 (backlog) | — | Unchanged |

## 9. GitHub references

| Reference | Link |
|---|---|
| Phase 6 readiness report (approved) | `docs/phase-6/PHASE-6-READINESS-REPORT.md` |
| P6-0 report (approved) | `docs/phase-6/P6-0-REPORT.md` |
| Issue #5 (landlord visibility, S4) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/5 |
| Issues #42, #43, #44 | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/42 · /43 · /44 |
| CI run 117 (`9519100`, all six checks green) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/43526248934 |

## Approval

Awaiting product owner approval of S1 (S1-D1 to S1-D12) before S2 (offers) begins.
