# Phase 7 · Milestone report: L3 Receipts, bank-file import, allocation, bounced cheques, arrears and payment plans

| | |
|---|---|
| Date | 23 November 2026 |
| Branch | `phase-7/readiness`. Commits: `ef73fa8` (L2 approvals recorded), `2cba4a8` (migration 0038, SQL suite 21), `355efc9` (API, workflow job, tests, bank-file format), `a2658bf` (performance test, set-based arrears query), `7940733`, `a115254`, `21a28f5` and this commit (report, L2 performance seed balances). CI runs 205 (`21a28f5`) and 206 (`8bd8fcd`): green |
| Approvals | L2 approved with L2-D1 to L2-D12 and risks L2-R1 to L2-R4 (23 November 2026). Earlier: L1, P7-0, ADR-009, P7-W and their decisions |
| Scope | Readiness report §11, L3: receipts, bank-file import, allocation, bounced cheques, arrears and payment plans (LET-04, LET-05; §5.3, §5.4; P7-D7, P7-D8, P7-D10). Verification report §3.1 row L3: receipts (list, record, clear, bounce, refund, void), bank-file import and commit, allocations, arrears list, arrears actions, payment plans, arrears settings |
| Not in scope | Payment-provider receipts (LET-12, P7-D7). Deposits, inspections, notice, ending, renewal (L4). Portals (L5). Screens (L6). Rent dashboard (L7). Statements and payouts (Phase 9). Notification delivery (Phase 12) |
| Result | **L3 complete and approved (23 November 2026).** P7-0 R1 (company-wide balance reads near the budget) is resolved by maintained balances (L3-D1). Decisions in §9 |

## 1. Deliverables

### 1.1 Database (migration 0038)

| Change | Purpose |
|---|---|
| `rent_charges.allocated_amount`, `adjusted_amount`; `payments.allocated_amount`, kept by triggers on the append-only allocation and adjustment tables; guards so nothing else changes them; `rent_charge_balances` reads them; open-charge and unallocated-receipt indexes | Per-charge and per-receipt balances without totalling every allocation of the company (P7-0 R1). The guard accepts a change only from inside the maintenance trigger, not from a session that sets the flag itself |
| `app.rent_charges_guard` (replaced) | The same rules as migration 0035; the balance columns are not terms |
| `payment_imports`, `payment_import_lines` (row-level security) and their guards | A checked bank file and its lines: matched, unmatched, queued, imported, duplicate or in error; a stable key per line so a file imported twice adds nothing; the bank's data of a line never changes |
| `app.arrears_actions_guard` | Arrears actions are a history: never edited or deleted (notes erasable, ADR-009) |
| `payment_plans` columns and `app.payment_plans_guard`; one active plan per lease | Instalments positive, due in order from the agreement, adding up to the total; in the lease's currency; terms fixed; active → completed, broken or cancelled, then final |
| Document entity `bank_account`; picklist `bank_statement` | Bank files are scanned documents of the bank account |
| `app.erase_contact_tenancy` (replaced), contact merge register | Erasure also blanks the person's bank-file line texts and payment-plan reasons; merges leave bank-file lines as a history |

### 1.2 API

| Area | Endpoints |
|---|---|
| Receipts (RP-1, RP-2, RP-5, RP-6) | `GET /payments` (filters, cursor; this month by default), `GET /payments/{id}`, `POST /payments` (Idempotency-Key) |
| Cheques and reversals (RP-6, RP-7) | `POST /payments/{id}/clear`, `…/bounce`, `…/refund`, `…/void` (each through `app.unwind_payment`, #3) |
| Allocation (RP-4) | `GET /payments/{id}/allocations` (allocations and the oldest-first suggestion), `POST /payments/{id}/allocations` (all lines in one transaction), `POST /payments/{id}/allocations/{allocationId}/reverse` |
| Bank-file import (RP-3) | `POST /payments/imports` (check), `GET /payments/imports/{id}`, `POST …/commit`, `POST …/cancel`, `GET /payments/import-lines` (the queue), `POST /payments/import-lines/{id}/match`. Format: `docs/phase-7/BANK-FILE-FORMAT.md` |
| Arrears (AR-1, AR-2) | `GET /arrears?asOf=` (ageing, totals per currency, filters, cursor), `GET /leases/{id}/arrears`, `POST /leases/{id}/arrears-actions`, `POST /leases/{id}/payment-plans`, `PATCH /leases/{id}/payment-plans/{planId}` |
| Settings (ST-2) | `PUT /settings/lettings` takes `arrearsSteps` (left out: kept) |
| Charges | `late_fee` is a type a person may add (L3-D10) |
| Documents (W7-A1) | Uploads for a `bank_account` accept `text/csv` as `bank_statement` only; the scan checks the file is plain text |
| Worker | `arrears.workflow`, daily: leases in batches of 500, one transaction each, lock renewed after each batch (#42) |

The OpenAPI contract adds 19 paths. Changed schemas are additions only: `arrearsSteps` on the lettings settings, `late_fee` among charge types, `bank_account` and `text/csv` among document upload values.

No web screen changed. Earlier work (Buildora, Praiseflow, Cleanora, Phases 1 to 6, P7-0, L1 and L2) is unchanged, apart from the test expectations in §4.3.

## 2. Requirement checklist

| Item | Wireframe | Result | Evidence |
|---|---|---|---|
| LET-04 manual receipts (P7-D7) | RP-2 | ✅ Met: idempotent; currency of the account; payer a party of the lease; terms fixed once cleared (#2) | API tests; suites 17, 21 |
| LET-04 bank-file import, matched by reference (P7-D7) | RP-3 | ✅ Met: scanned document; check then commit; duplicates skipped; queue and match | API tests; parser unit tests |
| Allocation suggested oldest first, confirmed by a person (P7-D8) | RP-4 | ✅ Met: never automatic; all lines in one transaction; concurrent allocations answered with a conflict (suite 18) | API tests |
| Unallocated receipts, post-dated cheques | RP-5, RP-6 | ✅ Met through the receipts list filters | API tests |
| Bounced cheques restore arrears (#3) | RP-7 | ✅ Met: allocations reversed first; the charge is owed again | API tests; suite 17 |
| LET-05 arrears balance and ageing per lease (P7-D10) | AR-1 | ✅ Met: 0–30 (1–30 past due), 31–60, 61–90, over 90; per currency; as of a date, reproducible | API tests |
| Arrears workflow: company steps and days, reminders to the outbox (P7-D10) | AR-2, ST-2 | ✅ Met: no legal thresholds (P7-D3); idle until set (W7-D7) | API tests |
| Payment plans recorded and tracked | AR-2 | ✅ Met: progress against instalments shown | API tests; suite 21 |
| P7-0 R1: a per-lease or maintained-balance read path, measured before the screens | — | ✅ Met: maintained balances; arrears p95 652 ms at full volume | Performance |

## 3. Review

The migration, services and tests were re-read adversarially before this report. The findings below were fixed in L3:

| # | Finding | Fix |
|---|---|---|
| 1 | The "unallocated" and "next action due" filters compared a parsed boolean with the string `'true'`, so they were ignored | Compared with `true` (API tests) |
| 2 | The balance guard trusted a session setting any session could set | It also requires the change to come from inside the maintenance trigger (suite 21) |
| 3 | The arrears list took 1.65 s at full volume: later allocations were summed per charge, and lease details were read for every lease, not only the page | Aggregated once and joined; details for the page only: p95 652 ms |
| 4 | A contact merge had no rule for the payer of a bank-file line (database catalogue test) | Registered as a history (receipts already block a merge) |
| 5 | A line imported by another file between check and commit could not be marked duplicate | The line guard allows matched or unmatched → duplicate at commit |
| 6 | Erasure did not reach the new free text (bank-file line texts, plan reasons) | Added to `app.erase_contact_tenancy` (suite 17) |
| 7 | In the full performance run the arrears list took 4.9 s and the month end 24 s: the L2 rent test seeds 500,000 charges with triggers off and left their new balances at zero, so half a million charges looked unpaid and skewed the planner's estimates for every company | The L2 test now fills the balances as the triggers would (§4.3); both tests pass in sequence. L3-R2 records the sensitivity |

## 4. Tests

| Suite | Result |
|---|---|
| SQL, `verify.sh` | **38 migrations, 22 files passed.** New: `21_receipts_arrears_l3.sql` (36 assertions); suite 17 adds two erasure assertions |
| API (`test:ci`) | **54 files, 627 tests passed**; coverage 96.07 % statements, 90.30 % branches (thresholds 95 % and 90 %). New: `receipts.e2e.test.ts` (11), `receipts-rules.e2e.test.ts` (5), `arrears.e2e.test.ts` (7), `bank-file.test.ts` (5 unit tests) |
| API performance (`test:performance`) | **16 files, 20 tests passed** in one run (the 15 earlier files, including L1 leases and L2 rent, and the new receipts test: p95 654 ms, month end 842 ms, arrears workflow 9.5 s, bank file check 153 ms and commit 291 ms). §8 figures are from the dedicated run; an earlier full run failed (§3 finding 7). In the passing full run the L1 lettings test reached p95 846 ms (slowest 1,204 ms, one property-manager list) against 129 ms before; run on its own twice afterwards it gave p95 120 ms and 125 ms (slowest 207 ms), so the rise came from the shared database straight after the larger seeds, not from a change to the lettings queries. Within budget either way |
| Web unit and message check | Unchanged by L3 (no web change); run in CI |
| Browser (Playwright, axe, English and Arabic, 320 px to desktop) | Unchanged by L3; run in CI |
| Lint and typecheck | API clean |

### 4.1 What the API tests cover

- **Receipts:** every field check; idempotent recording; a cheque dated after today pending, then cleared; list windows, filters, cursor, scope (office, agents refused) and isolation; audit and outbox.
- **Allocation:** the oldest-first suggestion (for the receipt's lease, or the payer's leases); above outstanding, above unallocated, duplicate lines, future or locked dates, unknown, foreign-currency and waived charges; success in one transaction; single reversal once, never of a reversal.
- **Bounce, refund, void:** only cheques bounce; refunds only when cleared; dates in range and open periods; a bounced cheque's allocation reversed and the rent owed again; audit and outbox.
- **Bank-file import:** CSV only as a bank statement of the account; access; scan pending, infected and non-text files refused; matched, unmatched and error lines (bad date, amount, currency, column count); quoted fields; commit with chosen payers; the queue; the same file again gives duplicates; matching a queued line; versions; isolation.
- **Arrears:** ageing as of today and as of past dates (a later payment added back); filters (office, bucket, currency, next action due), cursor pages, totals per currency, scope and isolation.
- **Steps, actions, plans, workflow:** steps in order and from the picklist (kept when left out); manual actions as a history; plan checks (order, total above what is owed, one active), tracking ("behind"), closing with a reason, final; the workflow records the step reached once, pauses for an active plan, runs through the scheduler.
- **Parser (unit):** RFC 4180 records, required columns, line limits, line errors, stable keys, reference tokens.

### 4.2 What suite 21 covers (36 assertions)

- **Balances:** kept by allocations, reversals and adjustments; read by `rent_charge_balances`; not changed directly, even with the flag set; start at zero; other updates leave them.
- **Bank-file import:** documents of a bank account; lines in error without data; a queued line not queued twice; bank data and texts fixed; line and import transitions; never deleted.
- **Arrears actions:** never edited or deleted.
- **Payment plans:** totals, order, start date, currency, instalments required, one active plan, fixed terms, closing date, final, never deleted.
- **Isolation:** another company sees none of it.

### 4.3 Earlier tests changed

| Test | Change | Reason |
|---|---|---|
| `rent.e2e.test.ts` (L2), lettings settings | The expected settings include `arrearsSteps: []` | The settings gained the arrears steps (ST-2); an addition |
| Suite 17 (P7-0), erasure | Two assertions added (bank-file line texts, plan reasons); the existing ones unchanged | ADR-009 covers the new free text |
| `rent.performance.test.ts` (L2), seed | After seeding with triggers off, the maintained balances are filled as the triggers would have kept them | Data no real company can have (every charge unpaid while allocated) skewed later tests (§3 finding 7). The measured requests are unchanged |

## 5. Security impact

- **Database rules:** balances, import lines, actions and plans are guarded by triggers for every path; the API checks first to answer with field codes.
- **Permissions:** rent.view to read receipts and arrears (owner, admin and accountant: all; property managers: their offices). payment.record to record, clear, bounce, refund, void and import (owner, accountant). payment.allocate to allocate and reverse (owner, accountant). arrears.manage for actions and plans (owner, admin, accountant; property managers in their offices). Bank files: members who record receipts company-wide.
- **Scope:** receipts follow their lease's office; receipts with no lease are company-wide only. Suggestions and allocations only reach charges the member may see.
- **Files:** bank files are uploaded with a signed URL, checked for size, checksum, malware (ClamAV, fail closed) and plain text before use, and kept as documents of the account.
- **Concurrency:** receipts and charges are locked during allocation; a conflicting allocation is answered "someone allocated at the same time" (suite 18 rules); version checks on clear, bounce, refund, void, import commit and cancel, line match and plan closing.
- **Isolation:** row-level security (enabled and forced) on the new tables. Every API test and suite 21 include a second company.

## 6. Compliance impact

- No legal values are invented (P7-D3): arrears steps and days are company settings with none by default (W7-D7); late fees are never computed (L3-D10).
- ADR-009: bank-file line texts and payment-plan reasons are erased with the person; amounts and dates are kept. Receipts, allocations and bank files remain financial records within the retention rule.
- Arrears steps and plan events are written to the outbox; nothing is sent until Phase 12.

## 7. Audit impact

| Record | Audit actions |
|---|---|
| Receipts | `payment.recorded` (by hand or from a bank file), `.cleared`, `.allocated`, `.allocation_reversed`, `.bounced`, `.refunded`, `.voided` |
| Bank files | `payment_import.checked`, `.committed`, `.cancelled` |
| Arrears | `arrears.action_recorded` (by a person or the workflow) |
| Payment plans | `payment_plan.agreed`, `.completed`, `.broken`, `.cancelled` |
| Settings | `settings.lettings_updated` (with the steps) |

Every state change also writes an outbox event (`payment.received`, `payment.allocated`, `payment.bounced`, `arrears.step_due` and so on). Bulk paths (bank-file commit, the workflow) write audit and outbox rows in one statement each. Free text stays on the record, not in audit metadata.

## 8. Performance impact

Measured through the full API at the readiness volume for one company (§10): 20,000 leases, 500,000 rent charges, 300,000 payments, 400,000 allocations, with every lease in arrears (about 100,000 open charges). Owner (all) and property manager (office); 40 requests:

| Measure | Result | Budget |
|---|---|---|
| API p95 / median | **652 ms / 27 ms** | 1,000 ms |
| Arrears list (today), filtered by bucket | 652 ms | |
| Arrears as of a past month end | 825 ms | |
| Lease arrears tab / record an action | 40 / 35 ms | |
| Receipts list, unallocated, by lease, cheques due | 16 / 16 / 18 / 16 ms | |
| Record a receipt / allocation view / allocate / void | 60 / 19 / 41 / 30 ms | |
| Bank file of 1,000 lines: check / commit | 162 / 326 ms | |
| Daily arrears workflow (20,000 leases, 20,000 actions with audit and outbox) | **10.1 s**; a second run the same day 8.4 s (nothing to record) | 60 s |

## 9. Decisions taken in L3 (for confirmation)

| ID | Decision | Reason |
|---|---|---|
| L3-D1 | **Maintained balances.** Paid, adjusted and allocated amounts are kept on charges and receipts by triggers on the append-only tables, and read everywhere instead of totalling allocations | P7-0 R1: the read path for arrears and the screens |
| L3-D2 | **Receipt status.** A receipt is cleared when recorded, except a cheque dated after today, which stays pending until cleared. Only cheques bounce; only cleared receipts are refunded; pending or cleared receipts are voided | RP-2, RP-7 |
| L3-D3 | **Who pays.** A receipt is in its bank account's currency. With a lease, the payer is its tenant, co-tenant, occupant or guarantor and the lease is in that currency; a receipt may name no lease | Correct allocation; RP-2 has the lease optional |
| L3-D4 | **Receipt numbers** use the existing payment sequence (`RCT-YYYY-NNNNNN`, migration 0014) rather than the `RCP` drawn in the wireframes | The company sequences already exist |
| L3-D5 | **Allocation** is suggested oldest due first over the receipt's lease (or, with none, the payer's leases), in its currency, and applied only by a person. One allocation can be reversed on its own | P7-D8; RC-3 and RC-4 tell people to reverse an allocation first |
| L3-D6 | **Bank files** use the documented EstatePro CSV v1. The file is uploaded as a bank-statement document of the account (W7-A1 extended to bank accounts and `text/csv`; the scan checks plain text instead of a file signature) and kept | P7-D7; RP-3 "scanned and kept as a document" |
| L3-D7 | **Matching and the queue.** A line matches when its reference or description names exactly one signed lease in the account's currency; the payer is the primary tenant. Unmatched lines are given a payer at commit or wait in a queue of file lines, not as receipts | A receipt always has a payer (schema); RP-1 drew unmatched receipts |
| L3-D8 | **Line identity** is the bank's transaction id, or the line's content with its position among identical lines; a line imported or queued already is skipped in any later file | "Re-importing a file skips lines already imported" (RP-3) |
| L3-D9 | **Receipts list window:** without a date, lease, payer or unallocated filter, the list covers this month (company time zone), and says so | As L2-D9; RP-1 opens on "this month" |
| L3-D10 | **Late fees** are charges a person adds (`late_fee`); none are computed | Late-fee limits are legal values not yet reviewed (P7-D3); resolves L2-R4 for late fees |
| L3-D11 | **Arrears** are posted charges due before the date and still owed then; the buckets count days past due (1–30, 31–60, 61–90, over 90). A past date adds back the allocations and adjustments made after it | P7-D10; AR-1 "month-end figures can be reproduced" |
| L3-D12 | **Workflow.** The daily job records, once per arrears episode (since the oldest unpaid due date), the latest step the arrears have reached, with the date of the next step, and writes a notice to the outbox. Steps passed while it was idle are not recorded one by one. A lease with an active plan is paused | P7-D10; no reminder flood after a pause |
| L3-D13 | **Payment plans** cover at most what the lease owes when agreed; one active plan per lease; agreeing one records a "payment plan" action; a plan shows whether it is behind, and people close it (completed, broken with a reason, cancelled with a reason) | Readiness §5.4 "recorded and tracked" |
| L3-D14 | **Bank-file lines and people.** Merges leave them as a history (their receipts block a merge); erasure blanks their texts | ADR-008/ADR-009 rules for financial records |

## 10. Risks and open items

| # | Risk | Rating | Owner / when |
|---|---|---|---|
| L3-R1 | Arrears as of a past date leave out a charge waived or cancelled after that date (the charge does not record when its status changed) | Low | L7 (record the date if month-end packs need it) |
| L3-R2 | The arrears list with every lease of the largest company in arrears is within budget but not far from it (652 ms; month end 825 ms), and its plan depends on the table statistics (§3 finding 7) | Medium | L7 (rent dashboard), measured again with the screens (L6) |
| L3-R3 | The workflow, like the rent schedule (L2-R1), runs once per UTC day | Low | L7 |
| L3-R4 | Plans are not marked broken automatically; the record shows "behind" and people decide | Low | Accepted practice; revisit with Phase 12 notifications |

## 11. GitHub references

| Item | Reference |
|---|---|
| CI | Run 205 (`21a28f5`), workflow CI: success — https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/45170080813 |

## Approval

| Item | Decision | Date |
|---|---|---|
| L3 | Approved | 23 November 2026 |
| L3-D1 to L3-D14 | Each approved | 23 November 2026 |
| L3-R1 to L3-R4 | Reviewed and accepted | 23 November 2026 |
