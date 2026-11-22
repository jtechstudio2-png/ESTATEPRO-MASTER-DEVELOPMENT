# Phase 7 · Milestone report: P7-0 Money integrity and tenancy records

| | |
|---|---|
| Date | 22 November 2026 |
| Branch | `phase-7/readiness` (from `main` at `7e5e9ab`, after PR #49), commits `1550860` (migration 0035, SQL suites 17 and 18, blocker messages), `d84c1ce` (ADR-009, API test, blocker performance), `__REVIEW__` (review fixes, browser tests), then this report; CI run __CI__ |
| Approvals | Phase 7 Readiness Report approved 22 November 2026, with P7-D1 to P7-D16 and the tenant-access decision (12 months read-only after the lease ends, then automatic removal) |
| Scope | Readiness report §4: P7-0.1 (#1 posted charges), P7-0.2 (#2 payment amounts), P7-0.3 (#3 void, bounce, refund), P7-0.4 (#13 statement lines), P7-0.5 (#22 tests), P7-0.6 (tenancy records, ADR-009) |
| Not in scope | Lease, rent, receipt, arrears and deposit features and screens (L1 to L7). No API endpoint for lettings is added. Statements, fees and payouts stay in Phase 9 (P7-D2) |
| Result | **P7-0 complete, for approval.** All six items are delivered. Two differ in form from the readiness wording, and each needs a decision: P70-D2 (the API action for #3 comes in L3) and P70-D6 (row-level security is not forced). Review in §3, tests in §4, decisions in §9 |

## 1. Deliverables

### 1.1 Documentation

| Document | Content |
|---|---|
| [ADR-009](../decisions/ADR-009-tenancy-records-money-integrity-retention-erasure.md) | Tenancy records: money integrity, retention and erasure (decisions T-D1 to T-D11). Status Proposed, for approval with this report |
| This report | Deliverables, checklist, review, tests, security, compliance, audit, performance, decisions, risks |

### 1.2 Database (migration 0035)

| Change | Purpose |
|---|---|
| `rent_charge_adjustments` (signed amount, reason, approving member, date, insertion number); row-level security; append-only; open-period rule | #1: corrections without editing a posted charge |
| `app.rent_charges_guard` | #1: a posted charge keeps its terms; waived or cancelled only at net zero allocation; scheduled charges editable until posted; only scheduled charges deleted |
| `rent_charge_balances` (adds `adjustment_amount`, `adjusted_total_amount`; outstanding includes adjustments); `app.payment_allocations_validate` (charge limit includes adjustments) | #1: balances, arrears and allocation limits see adjustments |
| `app.payments_guard` | #2: terms fixed once a payment leaves "pending"; never below the net allocated; status transitions; #3: bounced, refunded, voided only at net zero |
| `app.unwind_payment(payment, status, reason, date)` | #3: reverse every standing allocation and set the status, in one transaction |
| `app.statement_lines_guard`, `app.statements_guard`, `statements.supersedes_statement_id` | #13: issued and void statements' lines are final for every role; draft → issued → void; corrections supersede a void statement once |
| Rule `tenancy_records_retention_years` (no value); `app.tenancy_retained` | ADR-009: retention per jurisdiction, fail closed |
| `app.contact_erasure_blockers` (replaced) | ADR-009: `live_lease`, `open_balance`, `deposit_held`, `management_agreement`, `tenancy_record` replace the generic lease-party, payer and landlord references |
| `app.erase_contact_tenancy`; `app.erase_contact` (replaced, calls it) | ADR-009: lettings free text anonymised; amounts, dates and statuses kept |

### 1.3 API and web

| Change | Purpose |
|---|---|
| `apps/api/src/privacy/requests.service.ts`: messages for the five new blocker codes | The erasure refusal (422) names each reason |
| `apps/web/src/components/privacy/request-record.tsx`: one table of blocker messages | The request record explains each reason |
| `apps/web/src/messages/{en,ar}/privacy.json`: five messages in English and Arabic | Localisation (3,110 keys in each language) |
| Browser test seed: a Doha tenant with a live lease, rent owed and a deposit held, with an erasure request in progress | Browser tests of the new messages in both languages |

No lettings screen or endpoint was added. Earlier work (Buildora, Praiseflow, Cleanora and Phases 1 to 6) is unchanged, except one earlier test expectation (§4.2).

## 2. Requirement checklist

| Item | Readiness acceptance | Result | Evidence |
|---|---|---|---|
| P7-0.1 #1 | The audit's reproduction (a charge edited from 6,000 to 100) is rejected; the adjustment path works | ✅ Met | Suite 17 §#1: 6 refusals; 10 adjustment assertions, including balance, allocation limit, locked period and isolation |
| P7-0.2 #2 | The audit's reproduction (6,000 allocated, amount set to 10) is rejected | ✅ Met | Suite 17 §#2: amount, payer, date, value date, delete, status |
| P7-0.3 #3 | A bounced post-dated cheque restores the arrears balance | ✅ Met in the database. ⚠️ The API action (reason, outbox event) is not built: no receipts API exists until L3 (P70-D2) | Suite 17 §#3: bounce refused while allocated; `unwind_payment` reverses, February owed again, lease in arrears |
| P7-0.4 #13 | Every application role, including the platform role, is refused update and delete of issued lines; draft lines stay editable | ✅ Met, and the database owner is refused too | Suite 17 §#13: runtime, platform and owner roles; superseding statement; arithmetic |
| P7-0.5 #22 | Suites for deposits, concurrent allocations, number-sequence concurrency, statement arithmetic and freeze, and a row-level-security catalogue check | ✅ Met. ⚠️ The catalogue check requires row-level security enabled, with policies; it does not require it forced (P70-D6) | Suites 17 and 18 in the CI database job |
| P7-0.6 | ADR-009 and its database guards (blockers, retention rule) | ✅ Met | ADR-009; suite 17 §ADR-009; API test; two browser tests |

## 3. Review

The migration and tests were re-read adversarially before this report. The findings below were fixed in P7-0:

| # | Finding | Fix |
|---|---|---|
| 1 | `total_amount` is a generated column, so a BEFORE trigger sees it as NULL. Every status change on a posted charge looked like a change of terms | The guard compares `amount` and `tax_amount`, from which the total is derived |
| 2 | The `open_balance` blocker read `rent_charge_balances`, which totals every allocation in the company before filtering. One check took 225 ms (p50) and up to 577 ms at the readiness volumes | The same sum is computed per charge of the person's leases: 3 ms (p50) |
| 3 | A cleared payment's value date could still change | Fixed once recorded (a payment cleared without one may still record it) |
| 4 | `unwind_payment` recorded the user id in `allocated_by`, while the `_by` columns hold membership ids | Records the acting member, or none for a system job |
| 5 | The catalogue check counted partitions of `audit_logs` and `notifications`, which have no policies of their own | Partitions are reached through their parent; a second check requires row-level security enabled on each partition, so direct access finds nothing |

Also checked and found correct:
- Lock order: allocation locks the payment, then the charge; adjustment locks the charge only. Suite 18 shows no deadlock in any race.
- Reversals stay exact and single: the existing rule and the unique index of migration 0008.
- A draft statement can still be deleted with its lines (cascade).
- The erasure flag cannot be set by the runtime role (suite 17).

## 4. Tests

| Suite | Result |
|---|---|
| SQL, `verify.sh` | **35 migrations, 19 files passed.** New: `17_money_integrity_p7_0.sql` (91 assertions) and `18_concurrency_p7_0.sql` (14 assertions, two live sessions over dblink) |
| API (`test:ci`) | **All passed**, coverage 96.2 % statements, 90.6 % branches. New: "gives the lettings reasons a tenant cannot be erased (ADR-009)" |
| API performance (`test:performance`) | __PERF__ |
| Web unit | 20 files, 100 tests passed; message check 3,110 keys × 2 languages |
| Browser (Playwright) | __BROWSER__ |
| Lint and typecheck | API and web clean |

### 4.1 What suite 18 races

| Race | Result |
|---|---|
| Two allocations of one payment (4,000 + 4,000 of 6,000) | The second waits for the first, then is refused |
| Two payments onto one charge | The second waits, then is refused |
| A bounce, then an allocation | The allocation waits, then finds the payment bounced |
| An allocation, then a bounce | The bounce waits, then is refused while the allocation stands |
| An adjustment, then an allocation | The allocation waits, then sees the reduced charge |
| Two receipt references | The second waits; the references differ |

### 4.2 Earlier test changed

`09_rotation_erasure_e5_e6.sql` expected the generic blocker `lease_parties` for the fixture tenant. Under ADR-009 the same tenant is blocked with the specific code `live_lease`, so the expectation and its label were updated (P70-D7). The behaviour is unchanged: the tenant still cannot be erased.

## 5. Security impact

### 5.1 Controls added

- Money rules are database triggers. They hold for the API, the worker, imports and direct SQL by any application role.
- Statement lines are frozen for every role, including the database owner.
- Only an erasure transaction may blank cheque details or reasons. The runtime role cannot fake one (suite 17).
- `app.unwind_payment` runs as the caller (SECURITY INVOKER), so row-level security applies. `app.erase_contact_tenancy` is not executable by any application role.

### 5.2 Tenant isolation

- `rent_charge_adjustments` has a company policy. Another company reads none and inserts none (suite 17).
- Catalogue check in CI: every table with `company_id` has row-level security enabled and at least one policy; partitions have it enabled.
- Only `estatepro_platform` and `estatepro_auth` bypass row-level security; `estatepro_app` does not.
- The API test checks that another company's member cannot open the blocked request.

## 6. Compliance impact

- Tenancy records (rent, receipts, deposits, agreements) are kept while live or unsettled, and then for a retention period per jurisdiction.
- No retention period is set (no legal values may be invented). Until legal review #20 sets one, past tenants cannot be erased, as with completed sales under ADR-008. The privacy request screen gives the reason.
- Erasure removes the person's free text from the lettings records and the matching audit rows and outbox events. Amounts, dates and statuses stay, so the books remain complete.

## 7. Audit impact

- Adjustments are append-only and record the approving member and a reason.
- Reversals are new rows; originals are kept.
- Statements are superseded, never edited.
- The triggers write no audit rows themselves. The L-milestone actions write them in the same transaction, as every action does today.
- The erasure redacts the text of audit rows about the person's leases, charges, payments, deposits and inspections.

## 8. Performance impact

Measured on a copy of the database seeded at the readiness volumes for one company (20,000 leases, 500,000 charges, 300,000 payments, 400,000 allocations), as the runtime role with row-level security, 200 samples each (5 for company-wide reads):

| Operation | p50 | p95 | Max |
|---|---|---|---|
| Allocate a payment (guarded) | 0.43 ms | 0.54 ms | 2.6 ms |
| Adjust a charge (guarded) | 0.22 ms | 0.33 ms | 2.3 ms |
| Cancel a charge (guarded) | 0.18 ms | 0.27 ms | 0.7 ms |
| Unwind and void a payment (2 allocations) | 0.89 ms | 1.3 ms | 3.3 ms |
| Erasure blockers for a tenant | 3.0 ms | 4.5 ms | 15 ms |
| Read one lease's balances (25 charges) | 39 ms | 88 ms | 135 ms |
| Company arrears, all 20,000 leases | 820 ms | 878 ms | 890 ms |
| Company outstanding total, 500,000 charges | 806 ms | 863 ms | 866 ms |

- The guarded writes cost about a millisecond. The daily rent job budget (under 60 s) is not affected.
- The adjustments join adds 6 to 8 % to company-wide reads (arrears 757 → 817 ms; total 809 → 863 ms, measured before and after on the same data).
- The view as built in migration 0008 is the larger cost: it totals all allocations before filtering. A per-charge lookup reads one lease in 0.8 ms instead of about 50 ms. Company-wide reads stay under the 1,000 ms budget but with little room; see R1.

## 9. Decisions taken in P7-0 (for confirmation)

| ID | Decision | Reason |
|---|---|---|
| P70-D1 | ADR-009 decisions T-D1 to T-D11 | §1, ADR-009 |
| P70-D2 | #3 is closed in the database by `app.unwind_payment`; the API action (bounce, refund, void with reason, audit and outbox event) is built with receipts in L3 | No receipts API exists in P7-0 (P7-0 adds no feature); the database rule already makes a bounce without reversal impossible |
| P70-D3 | Any member of the company can be recorded as an adjustment's approver; who may approve (permission and any limit) is enforced by the API when adjustments are exposed (L3 or L4) | Permission rules belong with the action and its screen |
| P70-D4 | A void statement can be corrected once, by a statement for the same landlord, currency and period | One live statement per period already holds; the chain stays linear |
| P70-D5 | Scheduled charges stay editable and deletable; a posted charge is waived or cancelled only at net zero allocation | The schedule is a plan until posted; once posted it is a financial record |
| P70-D6 | **Row-level security is not forced.** CI instead checks that it is enabled, with policies, on every tenant table, and that only the platform and auth roles bypass it | Tables are owned by the superuser, who bypasses even forced row-level security. Forcing would change the SECURITY DEFINER functions (erasure, rotation, references) without protecting anything more. Forcing only becomes meaningful after moving ownership to a dedicated non-superuser role. **Your decision:** accept this, or schedule the ownership change (a separate migration, not in P7-0) |
| P70-D7 | Suite 09's expectation `lease_parties` becomes `live_lease` | Same behaviour, more specific reason (ADR-009) |
| P70-D8 | A payment's value date is fixed once recorded | It dates the clearing; a later change would move money between periods |
| P70-D9 | Erasing a landlord also anonymises the free text of their leases (reason ended, custom fields) | That text can name either party; amounts, terms and dates stay |

## 10. Risks and open items

| # | Risk | Rating | Owner / when |
|---|---|---|---|
| R1 | Company-wide balance reads take 0.82 to 0.89 s at the readiness volumes, against the 1 s budget, because the view totals all allocations (migration 0008 design; P7-0 adds 6 to 8 %) | Medium | L3/L4: give the arrears and ledger screens a per-lease or maintained-balance read path, measured against the budget before their screens ship |
| R2 | Until #20 sets `tenancy_records_retention_years`, past tenants cannot be erased | Medium (by design) | Legal review #20 |
| R3 | The guards raise database errors; L1 to L7 must turn them into clear 409/422 responses | Low | Each L-milestone |
| R4 | P70-D2: no API path to bounce, refund or void a receipt until L3 | Low | L3 |
| R5 | P70-D6: row-level security not forced; table owner is the superuser | Low | Your decision |
| R6 | Suite 18 uses the dblink extension in the test database only (created and dropped by the suite) | Low | None needed; the CI image includes it |

## 11. GitHub references

| Item | Reference |
|---|---|
| Issues closed by P7-0 once approved | #1, #2, #3, #13, #22 |
| Legal review (retention period) | #20 |
| CI | __CI__ |

## Approval

| Item | Decision | Date |
|---|---|---|
| P7-0 | Pending | |
| ADR-009 | Pending | |
| P70-D1 to P70-D9 | Pending | |
