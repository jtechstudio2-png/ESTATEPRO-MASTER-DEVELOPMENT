# ADR-009: Tenancy records: money integrity, retention and erasure

| | |
|---|---|
| Status | **Proposed** (with P7-0, for approval with the P7-0 report) |
| Date | 22 November 2026 |
| Context | Phase 7 builds lettings: leases, rent, receipts, arrears, deposits, statements and portals (readiness report, approved 22 November 2026). The lettings and finance tables have existed since migrations 0008 and 0010 and hold no data yet. The readiness audit found five money-integrity gaps (#1, #2, #3, #13, #22). It also found that a tenancy party could only be refused erasure as a generic "referenced record". P7-0 closes all of these before any lettings screen or job writes data |
| Builds on | ADR-003 (API conventions), ADR-007 (field encryption, erasure §8), ADR-008 (sales records: the same retention and erasure pattern), Phase 1 specification §5.5 (LET), §5.7 (FIN), §12.3 (lease life cycle) |
| Implemented by | Migration 0035; SQL suites `17_money_integrity_p7_0.sql` and `18_concurrency_p7_0.sql`; erasure blocker messages in `apps/api/src/privacy/requests.service.ts` and `apps/web/src/components/privacy/request-record.tsx` (en, ar) |

## 1. Decision summary

| ID | Decision |
|---|---|
| T-D1 | **A posted rent charge keeps its terms** (#1). Amount, tax, dates, lease, type and description never change once it is posted. It can only be waived or cancelled, and only while nothing is allocated to it (net). A scheduled charge stays editable and deletable until it is posted or cancelled. Waived and cancelled are final |
| T-D2 | **Corrections are adjustments** (#1). `rent_charge_adjustments` holds signed amounts (credit or debit), each with a reason of 3 to 500 characters, an approving member and a date in an open period. Adjustments are append-only and apply to posted charges only. They never take what is owed below zero or below what is already paid. Balances, arrears and allocation limits include them |
| T-D3 | **A payment's terms are fixed once it leaves "pending"** (#2). These are: payer, lease, bank account, method, currency, amount, received date, value date (once recorded), instrument details, provider reference, idempotency key and recorder. A pending payment can still be corrected. Only a pending payment with no allocations can be deleted. The amount is never below what is allocated from it |
| T-D4 | **Payment statuses**: pending → cleared, bounced or voided; cleared → bounced, refunded or voided. Bounced, refunded and voided are final |
| T-D5 | **A payment is bounced, refunded or voided only once its net allocation is zero** (#3), so arrears always reappear when money is taken back. `app.unwind_payment(payment, status, reason, date)` adds a reversal for each allocation still standing (recording the acting member) and sets the status, in one transaction. The original allocations are kept. The API action that calls it is built in L3 |
| T-D6 | **Issued statements are final** (#13). No line of an issued or void statement can be added, changed or removed, by any role, including the database owner. A statement moves draft → issued → void only. A correction is a new statement that supersedes the voided one, for the same landlord, currency and period, and each void statement can be corrected once |
| T-D7 | **Concurrent writers cannot break the money rules** (#22). Allocation, adjustment and payment guards lock the payment and charge rows they check. SQL suite 18 tests the races with two live sessions: two allocations of one payment, two payments onto one charge, a bounce against an allocation (in both orders), an adjustment against an allocation, and reference numbers |
| T-D8 | **Erasure blockers for lettings** replace the generic lease-party, payer and landlord references with specific reasons (§3) |
| T-D9 | **Tenancy records are kept for a retention period** set per jurisdiction (`tenancy_records_retention_years`). Until legal review (#20) sets the period, tenancy records are kept and erasure stays blocked (fail closed, as ADR-008 S-D11) |
| T-D10 | **Erasure anonymises the lettings free text and keeps the facts** (§4) |
| T-D11 | **Row-level security is checked as a catalogue rule in CI.** Every tenant table has row-level security enabled and at least one policy, partitions included. Only the platform and auth roles bypass it; the runtime role never does. `FORCE ROW LEVEL SECURITY` is not applied (§5) |

## 2. Money rules (T-D1 to T-D7)

### 2.1 Why

The audit reproduced each gap directly against the database:

| Issue | Reproduction before 0035 | After 0035 |
|---|---|---|
| #1 | A posted GHS 6,000 rent charge edited to 100; arrears and the landlord's income fell with no trace | Refused. The correction is an adjustment with a reason and an approver |
| #2 | A cleared GHS 6,000 receipt edited to 10 after allocation | Refused. A payment's terms are fixed once it leaves "pending" |
| #3 | A post-dated cheque allocated to February, then bounced; February still showed as paid | Bouncing is refused while allocations stand. `unwind_payment` reverses them, and February is owed again |
| #13 | Lines of an issued statement could be deleted, changing a document the landlord had received | Refused for every role. Corrections supersede a voided statement |
| #22 | No test covered concurrent allocations | Six races in suite 18 |

### 2.2 Where the rules live

The rules are database triggers, so every path obeys them: the API, the worker, imports and any future integration. The open-period rule (migration 0008) applies to adjustments by their date. The view `rent_charge_balances` keeps its columns and adds `adjustment_amount` and `adjusted_total_amount` at the end, so existing readers are unchanged.

## 3. Erasure blockers (T-D8, T-D9)

ADR-008's blockers stay as they are (organisation, open deal, sale record), and so do the other merge blockers: ledger entries, payouts, statements, finance transactions, supplier invoices and payment accounts. The lease-party, payer and agreement-landlord references are replaced by:

| Code | Blocks while |
|---|---|
| `live_lease` | The person is party to a lease that is draft, pending signature, active, periodic, under notice, or ended but not closed |
| `open_balance` | A posted charge on one of their leases still has money outstanding, or a cleared payment from them is not fully allocated |
| `deposit_held` | A deposit on one of their leases is not returned or forfeited |
| `management_agreement` | They are the landlord on a management agreement that is draft, active or suspended |
| `tenancy_record` | A closed or cancelled lease of theirs with charges, payments or a deposit, a payment from them, or an ended agreement of theirs, is within the retention period. The period runs from the move-out date (or end date) of the lease, the received date of the payment, or the end date of the agreement. A payment with no lease takes the jurisdiction of its bank account's country |

Merged-away records of the person count as theirs, as in ADR-008.

## 4. Erasure of lettings records (T-D10)

| Record | Anonymised (`[Erased]` or emptied) | Kept |
|---|---|---|
| Leases of the person | Reason the lease ended; custom fields | Parties, unit, terms, rent, dates, status |
| Arrears actions, rent reviews | Notes | Dates, amounts, outcomes |
| Inspections and their items | Summary, notes | Dates, conditions, ratings |
| Rent charges, adjustments | Waiver reason, adjustment reason | Amounts, dates, statuses, approver |
| Deposit deductions | Description | Reason code, amount, status |
| Payments from the person | Notes, status reason; cheque number and bank are removed | Amount, currency, dates, method, status, allocations |
| Audit rows and outbox events about these records | Text values (as ADR-007 §8) | Shape, numbers, dates |

The erasure runs in the existing `app.erase_contact` transaction. Only that transaction may change these fields (`app.erasure_in_progress()`). The runtime role cannot set the erasure flag to rewrite cheque details or reasons.

## 5. FORCE row-level security (T-D11)

Tables are owned by the migration superuser, which bypasses row-level security whether or not it is forced. Forcing it would therefore not protect against the owner. It would, however, change how the SECURITY DEFINER functions behave (erasure, rotation, reference numbers), because these run as the owner and rely on reading across rows of one company. The protection that matters is that the runtime role (`estatepro_app`) has no BYPASSRLS and that every tenant table has a policy. Suite 17 checks both in CI. Moving table ownership to a dedicated non-superuser owner, and then forcing row-level security, is a separate change, put to the product owner as P70-D6.

## 6. Consequences

- Lettings features (L1 to L7) correct money only by adjustment, reversal or a superseding statement. They never edit in place.
- Imports of historical charges insert them as posted. Corrections to imported data follow the same rules.
- The tenant (or landlord) of a live or unsettled tenancy cannot be erased. The privacy request screen gives the specific reason in English and Arabic.
- Until #20 sets `tenancy_records_retention_years` for a jurisdiction, no past tenant can be erased there. This is the same position as completed sales under ADR-008 (#20).
