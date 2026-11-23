# Phase 7 · Milestone report: L2 Rent schedule, charges, adjustments and rent reviews

| | |
|---|---|
| Date | 23 November 2026 |
| Branch | `phase-7/readiness`. Commits: `11bd5e5` (L1 approvals recorded), `8404c52` (migration 0037, SQL suite 20), `94e3251` (API, worker jobs, tests), `5b394bb` (performance test, charges list window), `678bf1c` and the commit recording these results (report). CI run 197 green on `678bf1c` |
| Approvals | L1 approved with L1-D1 to L1-D9 and risks L1-R1 to L1-R4 (23 November 2026); W7-A1 completed. Earlier: P7-0, ADR-009, P70-D1 to P70-D9, P7-W, W7-D1 to W7-D8 (22 November 2026) |
| Scope | Readiness report §11, L2: rent schedule and charges, adjustments, rent reviews (LET-03, LET-08; §5.2, §5.6; P7-D6). Verification report §3.1 row L2: ledger, charges (list, add, waive, cancel), adjustments, rent reviews, lettings settings (charge lead days) |
| Not in scope | Receipts, bank-file import, allocation, bounced cheques, arrears and payment plans (L3). Deposits, inspections, notice, ending, renewal (L4). Portals (L5). Screens (L6). Rent dashboard (L7). Fees and statements (Phase 9, P7-D2). Notification delivery (Phase 12) |
| Result | **L2 complete, for approval.** Decisions in §9; L1-R1 (advance rent at activation) is resolved |

## 1. Deliverables

### 1.1 Database (migration 0037)

| Change | Purpose |
|---|---|
| `leases.rent_schedule_from` and its guard | The day a lease is charged from: set at activation, or once by a person for an imported live lease; fixed once set; only for a live lease, within its dates |
| `app.lease_rent_due`, `app.post_rent_charges`, `app.month_day`, `app.rent_in_force`, `app.tax_amount` | The rent schedule (P7-D6): periods by frequency, the pro-rated first and last periods, the rent in force (applied reviews), tax from configured components, the periods due at signing, each period charged once (any status) |
| `app.rent_charges_insert_rules` | A charge is raised only on a live or ended lease, in its currency, where the agency collects the rent (never under a let-only, draft or suspended agreement, §5.1), starting scheduled or posted |
| `app.rent_charges_open_period` | A charge is never dated in, nor waived or cancelled out of, a locked financial period |
| `app.rent_reviews_guard`, one-open-review index, `rent_reviews.due_notified_at` | Scheduled → proposed → agreed → applied (disputed, cancelled on the way); agreed terms fixed; applied and cancelled final (notes erasable, ADR-009); applied only from a date no rent is charged for; the review-due notice recorded once; never deleted |
| Indexes | Scheduled live leases; charges by lease, type and period (any status) |

### 1.2 API

| Area | Endpoints |
|---|---|
| Lettings settings (ST-2) | `GET /settings/lettings` (lease.view), `PUT /settings/lettings` (settings.manage): charge lead days (0–90, none by default) and the signed-lease rule (L1-D3) |
| Charges (RC-1, RC-2, RC-4) | `GET /rent-charges` (filters, cursor, totals per currency), `GET /rent-charges/{id}`, `POST /leases/{id}/charges`, `POST /rent-charges/{id}/waive`, `…/cancel` |
| Adjustments (RC-3, #1) | `POST /rent-charges/{id}/adjustments/preview` (server-side "after"), `POST /rent-charges/{id}/adjustments` |
| Ledger (RL-1) | `GET /leases/{id}/ledger?asOf=`: entries in date order with the running balance, ageing in the §5.4 buckets, upcoming charges |
| Rent reviews (RR-1) | `GET/POST /leases/{id}/rent-reviews`, `PATCH /leases/{id}/rent-reviews/{reviewId}` (edit, propose, agree, dispute, cancel), `POST …/{reviewId}/apply` |
| Schedule start | `POST /leases/{id}/rent-schedule` for an imported live lease |
| Leases | Activation starts the schedule and charges the periods due at signing. `LeaseDto` adds `rentScheduleFrom` and `currentRent` |
| Worker | `rent.schedule`, daily: every scheduled lease, in batches of 500 leases, one transaction each, lock renewed after each batch (#42). `rent.post_due`, hourly: scheduled charges whose due date has come, and review-due notices |

The OpenAPI contract adds 13 paths and two `LeaseDto` fields. No existing path or schema changed otherwise.

No web screen changed. Earlier work (Buildora, Praiseflow, Cleanora and Phases 1 to 6, P7-0 and L1) is unchanged, apart from one earlier test (§4.3).

## 2. Requirement checklist

| Item | Wireframe | Result | Evidence |
|---|---|---|---|
| LET-03 rent schedule from the lease | RL-1, RC-1 | ✅ Met: periods by frequency and due day, idempotent per period | Suite 20; API tests |
| LET-03 pro-rated first period | RL-1 | ✅ Met: by actual days, rounded to the currency (L2-D1) | Suite 20 (1,645.16 = 3,000 × 17/31) |
| LET-03 rent changes | RR-1 | ✅ Met through applied reviews (L2-D3) | Suite 20; API tests |
| P7-D6 daily batched job, lead days, advance periods at signing, idempotent | ST-2 | ✅ Met | API tests; performance |
| Charges: list, add, waive, cancel | RC-1, RC-2, RC-4 | ✅ Met | API tests |
| Adjustments (#1): signed, reason, approver with rent.manage, open period, never below paid | RC-3 | ✅ Met, with the server-side preview | API tests; suites 17, 20 |
| Ledger with running balance and ageing, per currency | RL-1 | ✅ Met; the CSV export comes with the screens (L2-D11) | API tests |
| LET-08 rent reviews on a scheduled date with notification | RR-1 | ✅ Met: notices written to the outbox; delivery with Phase 12 | API tests |
| §5.1 management agreement active before rent is collected | — | ✅ Met: no charges under let-only, draft or suspended agreements | Suite 20; API tests |
| Lettings settings: charge lead days (W7-D7: empty until saved) | ST-2 | ✅ Met | API tests |

## 3. Review

The migration, services and tests were re-read adversarially before this report. The findings below were fixed in L2:

| # | Finding | Fix |
|---|---|---|
| 1 | The period index of migration 0008 covers scheduled and posted charges only, so the schedule would have charged again a period whose charge was cancelled or waived | Each period is charged once whatever its charge's status (suite 20, API test) |
| 2 | Applying a review by changing `leases.rent_amount` would break the fixed terms of an active lease (L1, migration 0036) | The lease keeps its rent; the rent in force is the latest applied review (`app.rent_in_force`), shown as `currentRent` |
| 3 | A review applied from a date already charged would leave charges that disagree with the rent | Refused, in the database and when agreeing; correct those charges by adjustment |
| 4 | The charges list totalled every charge with two subqueries per row: 3.4 s at 500,000 charges | Totals are set-based, and the list covers this month unless a due-date or lease filter is given (L2-D9): p95 590 ms |
| 5 | Ledger rows of the same day were ordered by identifier only, and allocations have no entry number | Ordered by date, kind, period and creation time |
| 6 | Editing a review with one invalid field also answered "nothing to change" | Only when no field is given (rules test) |
| 7 | A repair recharge could be raised on a closed lease | Charges are raised on live and ended leases only; suite 17 raises its recharge before closing (§4.3) |

## 4. Tests

| Suite | Result |
|---|---|
| SQL, `verify.sh` | **37 migrations, 21 files passed.** New: `20_rent_schedule_l2.sql` (43 assertions) |
| API (`test:ci`) | **50 files, 599 tests passed**; coverage 96.00 % statements, 90.42 % branches (thresholds 95 % and 90 %). New: `rent.e2e.test.ts` (14 tests), `rent-rules.e2e.test.ts` (4 tests) |
| API performance (`test:performance`) | **15 files, 19 tests passed** in one run (the 14 earlier files unchanged; the new rent test: daily job 11.3 s, p95 587 ms in this run, §8 figures from the dedicated run) |
| Web unit and message check | Unchanged by L2 (no web change); run in CI |
| Browser (Playwright, axe, English and Arabic, 320 px to desktop) | Unchanged by L2; run in CI |
| Lint and typecheck | API clean |

### 4.1 What the API tests cover (`rent.e2e.test.ts`, `rent-rules.e2e.test.ts`)

- **Settings:** empty to start; only settings.manage saves; range check; audit.
- **Schedule:** activation charges the pro-rated first period and the advance period with no lead time; the job is idle without a lead time; with 14 days it creates the next charges once; the scheduler path runs; a waived period is not charged again; an imported lease's schedule starts from a chosen date, once, with refusals for dates outside the lease and stale versions.
- **Ledger:** date order, running balance, receipts with payer names, ageing buckets, upcoming charges; invalid dates; agents refused, other offices and companies not found.
- **Charges:** list scope and totals per currency, filters, cursor pages; posted and scheduled manual charges (the scheduled one posted on its due date by `rent.post_due`); duplicate period, currency, past schedule date, locked period, precision, period checks; rent refused as a manual type; property managers refused (no rent.manage); tax from a code; tax code of another jurisdiction.
- **Adjustments:** preview; approver without rent.manage refused; future and locked dates; credit below paid and below zero; credit and debit; ledger rows with the approver; cancelled charges refused.
- **Waive and cancel:** refused with money allocated, on stale versions and when final; audit and outbox.
- **Reviews:** one open review; propose (outbox), dispute, agree (refused from a charged date), edit refused once agreed, apply; the reviewed rent charged from its date; the review-due notice once on the date; cancelled reviews final; every field check.
- **Collection rule:** a let-only lease gets no charges and manual charges are refused.
- **Isolation:** another company sees nothing and its job does nothing.

### 4.2 What suite 20 covers (43 assertions)

- **Schedule start:** none until set, within the lease, fixed, never on a draft.
- **Periods:** pro-rated first period and rounding, advance periods due at the start, later periods due on their first day, idempotency, cancelled periods not recharged, weekly periods and the pro-rated last period, a due day past the month's end, periodic leases.
- **Charges:** never on a draft lease, in the lease currency, start status, posting time, let-only and suspended agreements, locked periods.
- **Tax:** simple and compound components, only those in force.
- **Reviews:** one open review, transitions, the proposed amount, fixed agreed terms, no application from a charged date, the rent in force, final states, no deletion, the notice recorded once, the starting rent fixed.
- **Isolation:** another company sees none of it.

### 4.3 Earlier tests changed

| Test | Change | Reason |
|---|---|---|
| Suite 17 (P7-0), lease close-out | The repair recharge is raised while the lease is ended, before it closes | Charges are no longer raised on a closed lease (L2-D7). The assertions are unchanged |

## 5. Security impact

- **Database rules:** the schedule, the charge rules, the locked-period rule and the review life cycle are triggers and functions, so they hold for every path, including imports and the worker. The API checks first only to answer with field-level codes.
- **Permissions:** rent.view for charges and the ledger, rent.manage for adding, waiving, cancelling, adjusting and starting a schedule (owner and accountant), lease.view and lease.update for reviews, settings.manage for settings. Adjustment approvers must hold rent.manage covering the lease (W7-D2).
- **Scope:** charges and ledgers follow the lease's scope (office through the property). Payer names in the ledger are shown to members who may see contacts.
- **Isolation:** row-level security applies; the worker runs in tenant transactions per company. Every API test and suite 20 include a second company.
- **Concurrency:** charges are locked during waive, cancel and adjust (If-Match on waive and cancel); the schedule is safe to run twice at once (the period index rejects a second charge); the job's lock is renewed after each batch.

## 6. Compliance impact

- No legal values are invented (P7-D3). Lead days are a company setting with no default (W7-D7). Tax comes only from the company's configured tax codes.
- Erasure (ADR-009): review notes, adjustment reasons and waiver reasons are erased with the person (migration 0035, unchanged). Manual charge descriptions are fixed once posted (ADR-009 T-D1) and kept; see L2-R2.
- Rent review notices and charge events are written to the outbox; nothing is sent until Phase 12.

## 7. Audit impact

Every action is audited in the same transaction, with an outbox event for the state changes:

| Record | Audit actions |
|---|---|
| Charges | `rent_charge.created`, `.posted` (schedule, activation, scheduled charge due), `.waived`, `.cancelled`, `.adjusted` |
| Rent reviews | `rent_review.scheduled`, `.updated`, `.proposed`, `.agreed`, `.disputed`, `.cancelled`, `.applied`, `.due_notified` |
| Leases | `lease.activated` (now with the schedule start and the charges posted), `lease.rent_schedule_started` |
| Settings | `settings.lettings_updated` |

The worker writes its audit and outbox rows in two statements per batch (`AuditService.recordMany`, `emitMany`), as the system actor. Free text (reasons, notes) stays on the record, not in audit metadata.

## 8. Performance impact

Measured through the full API at the readiness volume for one company (§10): 20,000 leases, 500,000 rent charges, 300,000 payments and 400,000 allocations. Owner (all) and property manager (office) scope; 45 requests:

| Measure | Result | Budget |
|---|---|---|
| Daily rent job (20,000 charges created, audited, outbox) | **12.1 s**; a second run the same day 3.1 s (nothing to create) | 60 s |
| API p95 / median | **590 ms / 24 ms** | 1,000 ms |
| Ledger (owner, property manager) | 125 ms | |
| Charges list, this month (default), by office, by month | 590 / 382 / 412 ms | |
| Charges, one quarter | 719 ms | |
| One lease's charges / one charge / reviews / lease | 24 / 17 / 18 / 24 ms | |
| Add a charge / preview / adjust / waive / schedule a review | 42 / 28 / 36 / 26 / 22 ms | |

## 9. Decisions taken in L2 (for confirmation)

| ID | Decision | Reason |
|---|---|---|
| L2-D1 | **Periods.** Periods follow the frequency. With pro-rating and a due day, the first period runs from the start date to the day before the first due day, pro-rated by actual days of the full period it falls in; later periods start on the due day (the last day of a shorter month). Without pro-rating or a due day, periods run from the start date. Weekly periods run from the start date. Amounts are rounded to the currency's minor units | P7-D6 "first period pro-rated by actual days" |
| L2-D2 | **The last period** is cut at the end date and pro-rated the same way; nothing is charged after the end (periodic leases have no end) | Not stated in P7-D6; charging a full period past the end would overcharge |
| L2-D3 | **Rent changes through reviews only.** The lease keeps its signed rent; a period's rent is the latest applied review in force on its first day (a mid-period date takes effect from the next period). A review is applied only from a date no rent is charged for yet | The lease's rent is fixed once active (L1); charges already raised never change (#1) |
| L2-D4 | **Charged at signing:** the pro-rated first period and `advance_periods` full periods are due on the start date and posted at activation, even with no lead time set; later periods wait for the lead time | P7-D6 "advance periods charged at signing"; resolves L1-R1 |
| L2-D5 | **Schedule charges are posted when created**, lead days before their due date. A charge a person schedules is posted on its due date (hourly job, the property's local date) | Ageing counts from the due date, so posting ahead does not make arrears; the wireframe's "Schedule for the due date" |
| L2-D6 | **Imported live leases** are not charged until a person sets the schedule start (`POST /leases/{id}/rent-schedule`), fixed once set; periods before it are not charged | L1-D4 accepts imported live leases; charging their history automatically would duplicate the previous system's charges |
| L2-D7 | **Where charges are raised:** live and ended leases (for recharges), never draft, signed-but-not-active, closed or cancelled ones; none under let-only, draft or suspended agreements; leases without an agreement are charged (the company's own lettings) | Readiness §5.1 |
| L2-D8 | **Locked periods:** a charge is not dated in, nor waived or cancelled out of, a locked financial period (by due date) | As allocations and adjustments (migrations 0008, 0035) |
| L2-D9 | **Charges list window:** without a due-date or lease filter, the list and its totals cover this month (company time zone), and the response says so (`dueDateWindow`) | RC-1 opens on "Due this month"; company-wide totals over every charge exceed the budget (P7-0 R1, §3 finding 4) |
| L2-D10 | **Reviews:** one open review per lease; the proposal, agreement and the review-due notice (on the review date, once) are written to the outbox; agreed terms are fixed (cancel and schedule another to change them) | LET-08; delivery with Phase 12 |
| L2-D11 | **Ledger CSV export** (RL-1, `lease.export`) comes with the screens in L6, through the existing export pipeline | The verification report's L2 row lists the ledger; the export is a screen action |
| L2-D12 | **Tax** on a charge comes from its tax code's components in force on the charge's first day (rent: period start; others: due date), simple then compound, each rounded. Tax codes on manual charges are of the lease's jurisdiction | Configuration-driven (P7-D3); wireframe RC-2 |

## 10. Risks and open items

| # | Risk | Rating | Owner / when |
|---|---|---|---|
| L2-R1 | The daily job runs at the first pass after midnight UTC; a property west of UTC sees its charges created up to a day later in local time. With a lead time of a day or more, no charge is late | Low | L7 (schedule per time zone if needed) |
| L2-R2 | Manual charge descriptions are free text kept on erasure (ADR-009 T-D1 fixes posted terms) | Low | L6: the screen guides "no personal details" |
| L2-R3 | Totals over long date ranges approach the budget (a quarter 719 ms at 500,000 charges); continues P7-0 R1 | Medium | L3 (arrears) and L7 (rent dashboard) |
| L2-R4 | Late fees and arrears reminders are L3; charge and review notices are only written to the outbox until Phase 12 | Low | L3, Phase 12 |

## 11. GitHub references

| Item | Reference |
|---|---|
| CI | Run 197 (`678bf1c`, the complete L2 code): all 6 jobs green: API lint, typecheck, build and tests with coverage thresholds; database migrations and SQL suites; web lint, typecheck, messages, unit tests and build; web end-to-end (Playwright, axe, English and Arabic, 320 px to desktop); secret scanning; dependency scanning. Runs 190, 195 and 196 were cancelled by the next push; run 193 (`8404c52`) green |

## Approval

| Item | Decision | Date |
|---|---|---|
| L2 | Pending | |
| L2-D1 to L2-D12 | Pending | |
| L2-R1 to L2-R4 | Pending | |
