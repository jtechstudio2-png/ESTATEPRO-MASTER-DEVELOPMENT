# Phase 7 Readiness Report (Lettings, leases and rent)

| | |
|---|---|
| Date | 22 November 2026 |
| Branch | `phase-7/readiness`, from `main` at `7e5e9ab` (PR #49, #42 remediation) |
| Scope | Readiness for Phase 7: management agreements, leases, rent schedule and charges, receipts and allocations, arrears, deposits, inspections, renewals and rent reviews, and the tenant and landlord portals (specification LET-01 to LET-11), with a preparatory milestone P7-0 for the money-integrity issues (#1, #2, #3, #13, #22) |
| **Recommendation** | **GO for Phase 7 once the decisions in §9 (P7-D1 to P7-D16) are approved**, starting with P7-0. No lease, rent or payment feature is built before P7-0 is approved. No screen is built before the P7-W wireframes are approved |
| **Approval** | Awaiting review |
| Code | None. This report changes no code; Phase 7 implementation has not started |

## Contents

1. [Gate status](#1-gate-status)
2. [Phase 7 scope](#2-phase-7-scope)
3. [What exists today](#3-what-exists-today)
4. [P7-0 scope: money integrity before any rent feature](#4-p7-0-scope-money-integrity-before-any-rent-feature)
5. [Workflows](#5-workflows)
6. [Portals (#12, LET-10, LET-11)](#6-portals-12-let-10-let-11)
7. [Legal rules and reference data (#23)](#7-legal-rules-and-reference-data-23)
8. [Open risks](#8-open-risks)
9. [Required decisions (P7-D1 to P7-D16)](#9-required-decisions-p7-d1-to-p7-d16)
10. [Standards](#10-standards)
11. [Proposed milestone order](#11-proposed-milestone-order)

## 1. Gate status

| # | Gate | Status | Evidence |
|---|---|---|---|
| G1 | Phase 6 merged to `main` through a reviewed pull request, CI green | ✅ Met | PR #47 merged as `a551ee7`; `main` green in CI run 163 (21 November 2026) |
| G2 | Phase 6 approved as complete | ✅ Met | Phase 6 close-out approved 21 November 2026 (`docs/phase-6/PHASE-6-CLOSE-OUT-REPORT.md`) |
| G3 | Phase 6 blocker #42 resolved | ✅ Met | Remediation approved and merged through PR #49 as `7e5e9ab`; #42 closed (`docs/phase-7/ISSUE-42-REPORT.md`) |
| G4 | `main` green after the #42 merge | ✅ Met | CI run 171 on `7e5e9ab`, all six jobs green (22 November 2026) |
| G5 | Existing leasing schema reviewed against the specification | ✅ Met | §3: migration 0008 covers LET-01 to LET-09; gaps listed in §3.3 and §4 |
| G6 | Money-integrity findings assessed (#1, #2, #3, #13, #22) | ✅ Met | §4: all five belong in P7-0, before any rent feature |
| G7 | Legal reference data reviewed per market (#23) | ❌ Not met | No reviewed values or lease templates exist. Phase 7 can proceed without them under P7-D3 (§7); market launch cannot |
| G8 | Wireframes for Phase 7 screens, including the landlord portal home (#9) | ❌ Not yet | Proposed as P7-W after this report is approved (§11) |
| G9 | Portal sign-in decision (audit IS-9, "decide before Phase 7") | ✅ Ready (approval needed) | P7-D12 |
| G10 | Launch-track items keep their accepted status for local development | ✅ Met | #6 (identity provider vendor), #21 (penetration test before the first external user), #28 (no shared environment): unchanged; portals are built and tested locally only (§6.4) |
| G11 | `phase-6-complete` tag | Pending | Pushed separately by the repository owner; does not block Phase 7 (approval of 21 November 2026) |

## 2. Phase 7 scope

### 2.1 In scope (specification §5.5)

| ID | Requirement | Phase 7 |
|---|---|---|
| LET-01 | Lease: unit, landlord(s), tenant(s), guarantor(s), dates, type, rent, frequency, due day, deposit, notice, break clause | ✅ |
| LET-02 | Management agreement per landlord and property: service level, fee type and rate, expense approval limit | ✅ (fees recorded; fee charging with Phase 9, P7-D2) |
| LET-03 | Rent schedule from the lease; pro-rated first period; rent changes | ✅ |
| LET-04 | Receipts (manual, bank import, payment provider) and allocation to charges | ✅ manual and bank-file import; payment provider with LET-12 (P7-D7) |
| LET-05 | Arrears balance and ageing per tenant; arrears workflow | ✅ |
| LET-06 | Deposits: amount, holder, reference, return and deductions | ✅ |
| LET-07 | Renewal workflow, or notice and move-out | ✅ |
| LET-08 | Rent reviews on a scheduled date with notification | ✅ (notifications written to the outbox; delivery with Phase 12, as S1-R2) |
| LET-09 | Move-in and move-out inspections with condition reports and photos | ✅ |
| LET-10 | Tenant portal: lease, documents, balance, payment history, receipts, repair requests | ✅ except repair requests, which come with maintenance in Phase 8 (P7-D15) |
| LET-11 | Landlord portal: properties, tenancies, statements, work orders awaiting approval, documents | ✅ properties, tenancies, rent received, documents; statements with Phase 9, work orders with Phase 8 (P7-D2, P7-D15) |
| — | Letting deals completed into a lease (P6-D2, S3-R4) | ✅ |
| — | Tenant part of the visibility resolver (#12) | ✅ |

### 2.2 Not in scope

| Item | Where |
|---|---|
| LET-12 online rent payment through a provider | Later phase, with a provider decision (P7-D7) |
| Landlord statements, fee posting, ledger entries, payouts | Phase 9 Finance (P7-D2). Their database controls (#13) are fixed in P7-0 so nothing is built on an unprotected table |
| Work orders, repair requests, technician screens | Phase 8 Maintenance |
| Generated lease documents from templates | After legal review (#23, P7-D3) |
| Notification delivery (email, SMS) | Phase 12; Phase 7 writes outbox events |
| Commission records | Finance phase (as P6-D9) |

## 3. What exists today

### 3.1 Database (Phase 2, migration 0008, untouched since)

| Table | Purpose | State |
|---|---|---|
| `management_agreements` | Landlord, property or unit, service level, fee basis, approval limit, float, payout schedule | Complete for LET-02 |
| `leases` | Lease terms and status (`draft` → `pending_signature` → `active` → `periodic`/`notice_given` → `ended` → `closed`, or `cancelled`); renewal chain; no two live leases may overlap on one unit (exclusion constraint); activation requires `signed_at` | Complete for LET-01 and LET-07 |
| `lease_parties` | Tenant, co-tenant, occupant, guarantor, landlord, landlord agent; liability share; portal access | Complete |
| `rent_reviews` | Scheduled, proposed, agreed, applied | Complete for LET-08 |
| `rent_charges` | Rent, service, fee, utility, late fee and other charges; one charge per lease, type and period (unique index) | **Gap #1**: posted charges can still be edited |
| `payments` | Receipts with method, instrument (cheques, post-dated cheques), status, provider reference, idempotency key | **Gaps #2, #3**: amount can be reduced and status changed while allocations still count |
| `payment_allocations` | Append-only, reversals by negative rows; guards against over-allocation, wrong currency, uncleared payment; serialised by row locks | Complete; concurrency not yet tested (**#22**) |
| `deposits`, `deposit_deductions` | Holder, scheme reference, protection deadline, return and itemised deductions | Complete for LET-06; no tests yet (**#22**) |
| `arrears_actions`, `payment_plans` | Arrears steps and agreed plans | Complete for LET-05 |
| `inspections`, `inspection_items` | Move-in, move-out and periodic inspections with item conditions | Complete for LET-09 |
| `app.lease_arrears(as_of)` | Arrears per lease | Exists; to be checked against the adjustments of P7-0 |
| `statements`, `statement_lines` (0010) | Landlord statements | Header frozen once issued; **lines unprotected (#13)** |

All are tenant tables under row-level security, and their permissions are already seeded: `lease.*`, `management_agreement.*`, `rent.*`, `payment.record`, `payment.allocate`, `arrears.manage`, `deposit.*`, `inspection.*`, `statement.*`.

### 3.2 API and web

No lettings module exists. The existing modules give Phase 7 these building blocks:
- ownership records (P5-H)
- the landlord visibility resolver (C4, S4)
- the deal pipeline with letting deals stopping at "terms agreed" (S3)
- the media pipeline (photos for inspections)
- the worker and its job queue (rent schedule), with batching and lock renewal (#42)
- field encryption (bank details, ADR-007)
- erasure and retention rules (ADR-008)
- the Phase 6 performance harness

### 3.3 Gaps beyond #1 to #3 and #13

| Gap | Resolution |
|---|---|
| `rent_charge_adjustments` (credit notes, corrections) does not exist | P7-0, with #1 |
| Rent balance views do not include adjustments | P7-0 |
| Lease and deposit records are not covered by an erasure and retention decision (ADR-008 covers sales records only) | ADR-009 in P7-0 (P7-D14) |
| Tenant visibility resolver and portal row-level security keyed on the contact | L6, defence in depth (P7-D13) |
| Bank-file import format | L3 (P7-D7) |

## 4. P7-0 scope: money integrity before any rent feature

Each item is a database control, so it holds whatever the API does, and each comes with a regression test reproducing the original finding.

| # | Issue | Control | Test |
|---|---|---|---|
| P7-0.1 | #1 posted rent charges can be edited | Trigger: once `posted`, only `status` (to waived or cancelled), `waived_reason`, `updated_at` and `version` may change. Waive or cancel only while the net allocation is zero. New `rent_charge_adjustments` (signed amount, reason, approver, open-period check); balances include adjustments | The audit's reproduction (a charge paid 6,000 edited to 100) is rejected; adjustment path works |
| P7-0.2 | #2 payment amount can be reduced after allocation | Once `cleared`: amount, currency, payer, received date, bank account and instrument fields frozen; no update may take the amount below the net allocated total | The audit's reproduction (6,000 allocated, amount set to 10) is rejected |
| P7-0.3 | #3 a payment can be voided, bounced or refunded while allocated | Those statuses allowed only when the net allocation is zero. The API action writes the reversals and the status change in one transaction, with the reason and an outbox event | A bounced post-dated cheque restores the arrears balance |
| P7-0.4 | #13 issued statement lines can be changed | Freeze trigger on `statement_lines` when the parent statement is issued or void; corrections by a superseding statement, linked | Every application role, including the platform role, is refused update and delete of issued lines; draft lines stay editable |
| P7-0.5 | #22 test gaps | SQL suites for deposits, concurrent allocations (parallel sessions), number-sequence concurrency, statement arithmetic and freeze, and a row-level-security catalogue check that fails CI when a tenant table lacks enabled and forced row-level security with policies | New suites in the CI "Database migrations and SQL tests" job |
| P7-0.6 | Data protection for tenancy records | ADR-009 (P7-D14) and its database guards (erasure blockers, retention rule) | As ADR-008 in P6-0 |

P7-0 changes no screen and adds no feature. It ends with a milestone report and your approval, as P6-0 did.

## 5. Workflows

### 5.1 Letting: from agreed terms to an active lease (specification §7.2)

1. **Management agreement:** must be active before rent is collected for a unit (§7.2 step 1). This applies to service levels `rent_collection` and `fully_managed`; for `let_only` the agency lets but does not collect.
2. **Letting deal to lease.** A letting deal at "terms agreed" (S3) is closed won by creating a **draft lease** for the deal's unit (P7-D4). Parties are copied from the deal, the tenant becomes the primary tenant, and the lease records the deal.
3. **Signature.** Draft → pending signature → active. Activation requires the signed lease document uploaded and `signed_at` set (P7-D5). There are no generated templates until #23.
4. **Move-in.** The move-in inspection and keys are logged, and the rent listing becomes `rented` when the lease activates (P7-D4).
5. **Deposit and first rent** are recorded as receipts and allocated (§5.3). The deposit is registered with its holder.

### 5.2 Rent cycle (§12.3)

- A daily worker job per company, in batches with lock renewal as the #42 refresh does, creates each charge `lead_days` before its due date (company setting).
- The first period is pro-rated by actual days when the lease says so. Advance periods are charged at signing (`advance_periods`). Rent reviews change the amount from their effective date.
- Charges are idempotent: one per lease, type and period, enforced by the existing unique index.
- Reminders are written to the outbox (delivery in Phase 12).

### 5.3 Receipts and allocation

- **Recording receipts:** manual entry and bank-file import (CSV in a documented format, P7-D7). Imported lines are matched to tenants by reference.
- **Allocation:** suggested oldest-due-first. An accountant confirms; nothing is allocated without a person (P7-D8). Unmatched receipts wait in a queue.
- **Cheques:** post-dated cheques stay `pending` until cleared. A bounced cheque reverses its allocations and restores arrears (P7-0.3).

### 5.4 Arrears (LET-05)

- **Balance and ageing:** per lease and per tenant, in buckets of 0–30, 31–60, 61–90 and over 90 days past due (P7-D10).
- **Workflow:** reminder, then formal notice, then escalation to the property manager, recorded in `arrears_actions`. The steps and their days are company settings, with no legal thresholds invented (§7). Payment plans are recorded and tracked.

### 5.5 Deposits (LET-06)

- **Recording:** holder, scheme name and reference.
- **Protection deadline:**
  - set from the jurisdiction setting when a reviewed value exists;
  - otherwise entered by the person, with the screen saying no reviewed rule exists for that jurisdiction (P7-D3, P7-D11).
- **Return:** itemised deductions with evidence. Returned amounts can never exceed the deposit (existing check).

### 5.6 Renewals, notice and rent reviews (LET-07, LET-08)

- **Renewal window:** at 90, 60 and 30 days before the end date, a renewal task is created. If no decision is recorded by 30 days, it escalates (§7.2 step 10).
- **Renewal:** a new lease linked to the old one (`previous_lease_id`).
- **Notice:** recorded with who gave it and when, then a move-out inspection, then deposit return.
- **Ending:** the lease ends, then closes once the deposit is settled and the balance is zero (§12.5). The listing is relisted as a new listing (ADR-004 D3).
- **Rent reviews:** scheduled, then proposed, then agreed, then applied. The applied amount drives future charges.

### 5.7 Inspections (LET-09)

- Move-in, move-out and periodic inspections, with item conditions and photos through the existing media pipeline.
- Tablet layout per Phase 3 design 07 §2.5.

## 6. Portals (#12, LET-10, LET-11)

### 6.1 Tenant portal (LET-10)

- **Shows:** the tenant's own leases, documents shared with them, balance, payment history and receipts.
- **Who sees what:**
  - visibility runs through `lease_parties` (tenant, co-tenant, occupant) with `portal_access = true`;
  - a guarantor sees only the leases they guarantee, with balance but not payment detail (P7-D13).
- **Not in Phase 7:** repair requests come with Phase 8.

### 6.2 Landlord portal (LET-11)

- **Shows:** the landlord's properties and units (ownership records, P5-H), tenancies, rent due and received per tenancy, and shared documents.
- **Also:** the sale activity already delivered in S4 (#5).
- **Not in Phase 7:** statements come with Phase 9, and work orders awaiting approval come with Phase 8.
- **Home screen:** the design in P3-06 §11, with its wireframe in P7-W (#9).

### 6.3 Isolation

- **The rule:** no portal user sees a record not linked to their own contact (#12 acceptance), tested with two tenants and two landlords in one company.
- **Defence in depth:** portal reads also go through row-level-security policies keyed on a transaction-local `app.contact_id`, so an API mistake cannot widen access (P7-D13).
- **Ending access:**
  - landlord access ends the day after ownership ends, in the property's time zone (#12);
  - tenant access to a lease continues read-only for 12 months after the lease ends, then is removed automatically (P7-D13; period approved 22 November 2026).

### 6.4 Sign-in and exposure

- **Sign-in:** portal users sign in through the same identity design as staff, with the test identity provider locally (#6 unchanged).
- **Multi-factor authentication:** required for landlords and offered to tenants (P7-D12).
- **Invitations:** staff invite a contact; the invitation creates the portal membership.
- **Exposure:** no portal is exposed to real external users before #6 (identity provider vendor), #21 (penetration test, which covers the portals) and #28 (hosting) are resolved. Phase 7 builds and tests the portals locally.

## 7. Legal rules and reference data (#23)

There are no reviewed values for Ghana, Qatar or any UK nation, and no lease templates (#23). Values may not be invented (your requirement). The database already separates rule keys (`jurisdiction_setting_definitions`) from reviewed, dated values with a source reference (`jurisdiction_settings`), and the application reads rules by key, never by country.

**Proposal (P7-D3):** build every rule as configuration-driven.
- **Reviewed value exists:** the system enforces it and cites its source.
- **No reviewed value:**
  - the system does not enforce a legal limit;
  - it asks the person for the value where one is needed (for example the deposit protection deadline);
  - it states on screen that no reviewed rule exists for that jurisdiction.

Lease documents are uploaded, not generated. Legal review (#23) stays open and is a launch blocker for each market, not a blocker for building Phase 7.

## 8. Open risks

| # | Risk | Rating | Mitigation |
|---|---|---|---|
| R1 | No reviewed legal values or templates (#23): a company could let without the legal limits of its market enforced | High (launch) | P7-D3: rules are configuration-driven and shown as "not reviewed"; #23 is a launch blocker per market |
| R2 | Money integrity (#1, #2, #3, #13): building rent features on unprotected tables | Critical until P7-0 | P7-0 first; no rent feature before P7-0 is approved |
| R3 | Portal isolation: one tenant or landlord seeing another's records in the same company; row-level security alone isolates companies, not contacts | High | Resolver plus contact-keyed row-level-security policies (P7-D13); two-user tests; penetration test #21 before external users |
| R4 | Tenancy records and erasure: tenants' financial records must be kept, but erasure requests must still be honoured | Medium | ADR-009 (P7-D14), on the pattern of ADR-008; retention period depends on #20 |
| R5 | Rent schedule volume: daily charge generation across many companies | Medium | Batched, idempotent job with lock renewal (as #42); performance test at 20,000 leases and 500,000 charges (§10) |
| R6 | Statements are deferred to Phase 9, so the landlord portal shows rent received but not statements until then | Low | P7-D2; stated on the portal |
| R7 | Repair requests are deferred to Phase 8, so the tenant portal has none until then | Low | P7-D15 |
| R8 | Launch-track items #6, #20, #21, #24, #25, #28 | High (launch) | Unchanged; the portals stay local |
| R9 | Free-text fields (inspection notes, arrears notes) could hold sensitive personal data | Medium | Existing guidance and #35; field guidance on the new screens |

## 9. Required decisions (P7-D1 to P7-D16)

| # | Decision | Recommendation |
|---|---|---|
| P7-D1 | **Phase 7 scope** | LET-01 to LET-11 as in §2.1; LET-12 and the items in §2.2 excluded |
| P7-D2 | **Statements, fees and payouts** | Phase 9 Finance. Phase 7 records agreements (fee terms included), charges, receipts and allocations. #13's database controls are fixed in P7-0 anyway |
| P7-D3 | **Legal rules without reviewed values (#23)** | Configuration-driven and never invented: enforced only where a reviewed value exists, otherwise entered by the person and shown as not reviewed. Lease documents uploaded, not generated (§7) |
| P7-D4 | **Letting deal to lease** | Closing a letting deal won creates a draft lease for its unit with its parties. The rent listing becomes `rented` when the lease activates, not when the deal closes |
| P7-D5 | **Lease activation** | Requires the signed lease document uploaded (the specification's configurable rule, on by default) |
| P7-D6 | **Rent schedule** | Daily batched worker job; charges created `lead_days` before due (company setting); first period pro-rated by actual days; advance periods charged at signing; idempotent per period |
| P7-D7 | **Receipts** | Manual entry and a documented CSV bank-file import in Phase 7. Payment-provider integration (LET-12) later, after a provider is chosen |
| P7-D8 | **Allocation** | Suggested oldest-due-first, confirmed by a person; never automatic |
| P7-D9 | **Money integrity (#1, #2, #3, #13, #22)** | The controls in §4, in P7-0, before any rent feature |
| P7-D10 | **Arrears** | Ageing buckets of 0–30, 31–60, 61–90 and over 90 days; workflow steps and their days as company settings; reminders to the outbox |
| P7-D11 | **Deposits** | Holder and scheme recorded; deadlines from reviewed jurisdiction values or entered by the person (P7-D3); itemised, evidenced deductions; never returned above the amount held |
| P7-D12 | **Portal sign-in (IS-9)** | Same identity design as staff; invitation by staff; multi-factor authentication required for landlords and offered to tenants; local only until #6, #21 and #28 |
| P7-D13 | **Portal visibility (#12)** | Tenant resolver through `lease_parties`; guarantors see guaranteed leases' balance only; contact-keyed row-level-security policies as defence in depth; read-only tenant access for 12 months after the lease ends, then portal access removed automatically (period **approved 22 November 2026**) |
| P7-D14 | **Tenancy records protection** | ADR-009 in P7-0. Leases, charges, receipts, allocations and deposits are financial records: kept, with personal details erased on request, and erasure blocked while a lease is live, a balance is open or a deposit is held. Retention period from #20 |
| P7-D15 | **Repair requests and work orders** | Phase 8 Maintenance; no placeholder in the Phase 7 portals |
| P7-D16 | **Milestone order** | As §11, with P7-0 and P7-W first |

## 10. Standards

The standards maintained through Phases 4 to 6 continue unchanged:
- **Tenant isolation:** row-level security, cross-company tests, and now contact isolation for portals.
- **Data protection:** ADR-008 and the new ADR-009.
- **Audit:** every state change audited in the same transaction.
- **Erasure:** protections as above.
- **Accessibility, RTL, localisation:** axe in English and Arabic at 320 px and desktop; messages in both languages.
- **CI:** CI verification on every milestone.
- **Performance budgets:**

| Measure | Budget |
|---|---|
| API p95 | Under 1,000 ms at 20,000 leases, 500,000 rent charges, 300,000 payments and 400,000 allocations |
| Daily rent job | Under 60 s for the largest test company |
| Web screens | Data shown within 4,000 ms with at most 300 KB of script |

**Money:** decimal strings with currency (ADR-003), never summed or converted across currencies, and every amount check enforced in the database as well as the API.

## 11. Proposed milestone order

| Milestone | Content | Depends on |
|---|---|---|
| P7-0 | Money integrity (#1, #2, #3, #13, #22) and ADR-009 (§4) | Approval of this report |
| P7-W | Wireframes and verification for the Phase 7 screens, including the landlord portal home (#9), tenant portal, lease record, rent ledger, receipts and allocation, arrears, deposits, inspections (tablet) | Approval of this report (can run alongside P7-0) |
| L1 | Management agreements and leases: lifecycle, parties, letting deal to lease, activation, listing `rented` | P7-0 |
| L2 | Rent schedule and charges, adjustments, rent reviews | L1 |
| L3 | Receipts, bank-file import, allocation, bounced cheques, arrears and payment plans | L2 |
| L4 | Deposits, inspections, renewals, notice and move-out | L3 |
| L5 | Portals: tenant resolver, contact row-level security, invitations, tenant and landlord portal API (#12) | L4 |
| L6 | Screens to the approved wireframes | P7-W, L1 to L5 |
| L7 | Rent dashboard (Phase 3 design 06 §6), performance at scale, close-out | L6 |

Each milestone ends with its report in the standard format and your approval before the next begins. The Phase 7 branch is merged to `main` through one reviewed pull request after Phase 7 close-out.

## Approval

| Item | Decision | Date |
|---|---|---|
| Phase 7 readiness report | Awaiting review | |
| P7-D1 to P7-D16 | Awaiting approval, each individually | |
| Tenant read-only access after lease end (P7-D13 detail) | **Approved**: 12 months, then automatic removal of portal access | 22 November 2026 |
| Start of P7-0 | Not started; waits for approval of P7-D1 to P7-D16 | |
