# Phase 7 · P7-W · Wireframe Verification Report

| | |
|---|---|
| Status | **Proposed**, for approval together with the [wireframes](./P7-W-WIREFRAMES.md) |
| Scope | Checks the Phase 7 wireframes against the approved readiness report (§2.1, §5 to §7, §9, §10), the seeded permission model (migration 0014), the schema (migrations 0003, 0004, 0008, 0010, 0011, 0035) and the P7-0 controls. Lists the endpoints L1 to L5 must provide, the schema gaps, and the decisions needed before L6 screen work starts |
| Result | **Ready for approval**, subject to eight decisions (§5). Every in-scope requirement has a screen. One schema gap (inspection item photos, §4) and one API gap that L1 needs first (documents upload, §3.2). No business or legal rule is re-decided |
| Order | The readiness report puts P7-W after P7-0 and before L1 (§11). The wireframes come before the API, so each screen names the endpoint its milestone must build. L1 to L5 build those endpoints to these screens; L6 builds the screens |

## 1. Requirements coverage

### 1.1 Readiness report §2.1

| ID | Requirement | Screens | Coverage |
|---|---|---|---|
| LET-01 | Lease: unit, landlords, tenants, guarantors, dates, type, rent, frequency, due day, deposit, notice, break clause | LS-1 to LS-5 | Full |
| LET-02 | Management agreement: service level, fee, approval limit | MA-1, MA-2 | Full (fees recorded; charged in Phase 9, P7-D2) |
| LET-03 | Rent schedule; pro-rated first period; rent changes | LS-2, LS-5, RL-1, RC-1, RC-2, RR-1, ST-2 | Full |
| LET-04 | Receipts (manual, bank import) and allocation | RP-1 to RP-7 | Full for manual and CSV (P7-D7); provider later |
| LET-05 | Arrears balance, ageing, workflow | RL-1, AR-1, AR-2, ST-2, RD-1 | Full |
| LET-06 | Deposits: amount, holder, reference, return, deductions | DP-1 | Full |
| LET-07 | Renewal, or notice and move-out | LS-6, LS-7, SH-3 badge | Full |
| LET-08 | Rent reviews with notification | RR-1 | Full (notice to the outbox; delivery Phase 12) |
| LET-09 | Move-in and move-out inspections with condition reports and photos | IN-1 to IN-3 | Full, after W7-S1 |
| LET-10 | Tenant portal: lease, documents, balance, payment history, receipts | PS-1, PT-1 to PT-4, PD-1 | Full; repair requests Phase 8 (P7-D15) |
| LET-11 | Landlord portal: properties, tenancies, documents (statements, work orders later) | PS-1, PL-1, PL-2, PD-1 | Full for Phase 7 scope; landlord home #9 drawn (PL-1) |
| — | Letting deals completed into a lease | X-D9, LS-2 | Full (P7-D4) |
| — | Tenant visibility (#12) | PS-1, PT-1 to PT-4 | Full (P7-D13) |

### 1.2 Readiness §10 standards and budgets

| Standard | Where |
|---|---|
| WCAG 2.2 AA; axe in English and Arabic at desktop and 320 px | Wireframes §13 (L6 browser suite) |
| English and Arabic; amounts per currency, never summed across | §14; RL-1, AR-1, RD-1 footers per currency |
| Screens ready within 4,000 ms with at most 300 KB of script | RL-1 and AR-1 measured in L6; the read-path risk is P7-0 R1 |
| Money in the database as well as the API | RC-3, RC-4, RP-4, RP-7 show the P7-0 refusals as screen states |

## 2. Permission and scope verification

| Check | Result |
|---|---|
| Every action names its permission (migration 0014 seed) | ✅ |
| Recording receipts and allocating only for Own and Acc (`payment.record`, `payment.allocate`) | ✅ RP-2 to RP-7; property managers read rent but do not take money |
| Lease activation only for `lease.activate` (Own, PM office) | ✅ LS-5 |
| Agreement activation only for `management_agreement.approve` (Own, PM office) | ✅ MA-2 |
| Adjustments, waivers and manual charges only for `rent.manage` (Own, Acc) | ✅ RC-2 to RC-4 |
| Arrears actions for `arrears.manage` (Own, Adm, Acc; PM office) | ✅ AR-2 |
| Deposits for `deposit.manage` (Own, Acc; PM office) | ✅ DP-1 |
| Agents see leases they own (`lease.view` own) and no rent screens | ✅ LS-1, LS-3 (Ledger and Arrears tabs need `rent.view`) |
| Portal users reach only portal screens, for records linked to their contact | ✅ PS-1, PT-*, PL-*, PD-1 |
| Guarantors: balance only, no payment detail | ✅ PT-4 (P7-D13) |
| Landlords see tenants' names but not their contact details, identity or payment instruments | ✅ PL-1, PL-2 |
| Counts and totals come from scoped server queries | ✅ SH-3 badges, RC-1, AR-1, RD-1 |

## 3. API mapping

### 3.1 Endpoints by milestone

All screens read and write through the endpoints marked † in the wireframes, plus existing ones: `/me/context`, `/units`, `/deals/{id}`, `/contacts`, `/members`, `/portal/landlord/listings`. Each milestone builds the endpoints its screens need:

| Milestone | Endpoints |
|---|---|
| L1 | Management agreements (list, record, create, update, activate, suspend, end); leases (list, record, create, from deal, parties, send for signature, activate, notice, end, close, cancel, renewal decision, renewal); documents upload (§3.2) |
| L2 | Ledger; charges (list, add, waive, cancel); adjustments; rent reviews; lettings settings (charge lead days) |
| L3 | Receipts (list, record, clear, bounce, refund, void), bank-file import and commit, allocations, arrears list, arrears actions, payment plans; arrears settings |
| L4 | Deposit (record, protection, deductions, return); inspections (list, schedule, items, complete, tenant acknowledgement); inspection item photos (W7-S1) |
| L5 | Portal: `/portal/me`, tenant home, lease, ledger, receipt PDF, landlord home, property, documents; invitations and access (PI-1) |
| L7 | `/dashboards/rent` |

### 3.2 Gap needed first

| # | Gap | Needed by | Proposed fix |
|---|---|---|---|
| W7-A1 | The documents tables exist (migration 0011: documents, versions with scan status, links, shares) but no API uploads, scans or links a document | LS-5 (signed lease, P7-D5), MA-2, IN-3, DP-1 evidence, PD-1 | L1 adds document upload through the existing object storage and scan pipeline (media), with links to a lease or agreement. Shares come with L5 |
| W7-A2 | Tenant payment instructions (where to pay) are not a setting | PT-1 | L5 adds them to the lettings settings (ST-2), per bank account, as text the company enters |

## 4. Schema gaps found

| # | Gap | Proposal |
|---|---|---|
| W7-S1 | Inspection photos cannot be tied to an inspection item. Documents link to an inspection only (`document_links.entity_type = 'inspection'`), and the media pipeline links photos to properties and units | L4 migration: a link from a media asset or document to an `inspection_item` (one table, row-level security, erased with the inspection's free text under ADR-009). Without it, photos attach to the inspection with the item named in the caption, which weakens the evidence for deposit deductions |

No other table or column is needed. Settings use the existing `company_settings` and invitations use the existing `invitations` table with `contact_id`.

## 5. Decisions needed before L6 screen work

| # | Decision | Proposal |
|---|---|---|
| W7-D1 | Navigation | Two sections, Lettings and Rent, as in the Phase 3 information architecture (02), with the badges in SH-3 |
| W7-D2 | Adjustment approver (P70-D3) | Chosen from members holding `rent.manage`. The approver may be the person recording, so that one-person offices can work, and the record shows both people |
| W7-D3 | Phone scope (staff) | Read a lease and its ledger, record a receipt, mark a cheque cleared or bounced, record an arrears action. Allocation, bank import and adjustments are tablet and desktop only; on a phone they show "Open on a larger screen" |
| W7-D4 | Who invites portal users | A new permission `portal.invite` for Own, Adm (all) and PM (office), seeded in L5. The alternative is to reuse `user.manage`, which only Own and Adm hold |
| W7-D5 | Liability shares | Recorded as entered; not required to total 100 % (joint and several liability is common) |
| W7-D6 | Inspections offline | Not supported in Phase 7. Each item saves as it changes; with no connection the screen says so and keeps the unsaved item on screen |
| W7-D7 | Lettings settings start empty | No default charge lead days or arrears steps. The rent job and the arrears automation stay idle for a company until it saves them, and the dashboard says so. Manual charges and actions work regardless |
| W7-D8 | Gaps | W7-A1 in L1, W7-A2 in L5, W7-S1 in L4, each before the screens that use it |

## 6. Risks found

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| W7-R1 | Ledger and arrears screens read the balance view, which is slow company-wide (P7-0 R1) | Medium | L3 measures the per-lease ledger and the arrears list at the readiness volumes and adds a faster read path before L6 |
| W7-R2 | Staff expect to edit a posted charge or a cleared receipt | Low | RC-3, RC-4 and RP-2 explain the correction path in the screen itself |
| W7-R3 | With W7-D7, a company that never configures lettings settings gets no charges | Low | RD-1 and the Lettings settings page show "Rent schedule not set up" to members with `settings.manage` |
| W7-R4 | Free text on inspections and arrears can hold sensitive data (readiness R9) | Medium | Field hints (#35); erased with the person (ADR-009) |
| W7-R5 | Portals shown to real users before #6, #21 and #28 | High (launch) | Local only (readiness §6.4); no change in Phase 7 |

## 7. Verification method

- Every screen traced to a readiness §2.1 item (§1). Every action traced to a seeded permission (§2) and a planned endpoint (§3).
- Every field checked against the schema as of migration 0035. Every refusal shown on screen checked against a database rule tested in SQL suites 17 and 18.
- Approved rules (P7-D2 to P7-D15, P70 decisions pending) drawn as given, not re-decided.
- Accessibility and right-to-left rules checked against ADR-002, Phase 3 04, and the Phase 4 to 6 browser suites.

## 8. Exit criteria for P7-W

1. Wireframes approved, with any changes recorded.
2. Decisions W7-D1 to W7-D8 recorded.
3. Gaps W7-A1, W7-A2 and W7-S1 accepted into their milestones.
4. Risks W7-R1 to W7-R5 reviewed.

Then L1 starts, after approval of the P7-0 report.

## Approval

| Item | Decision | Date |
|---|---|---|
| P7-W wireframes and this verification report | Pending | |
| W7-D1 to W7-D8 | Pending | |
| W7-A1, W7-A2, W7-S1 | Pending | |
| W7-R1 to W7-R5 | Pending | |
