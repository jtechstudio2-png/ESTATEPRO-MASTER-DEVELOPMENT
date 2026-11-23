# Phase 7 · Milestone report: L4 Deposits, inspections, notice, ending and renewal

| | |
|---|---|
| Date | 23 November 2026 |
| Branch | `phase-7/readiness`. Commits: `f106416` (L3 approvals recorded), `2a0d238` (migration 0039, SQL suite 22), `1dbeab8`, `6e4a0cc` (API, renewal job, settings), `f8f47aa`, `fc4c2c0`, `25045cf`, `095c0ef` (tests), `8d6e84d` (performance test) and the report commits. CI __CI__ |
| Approvals | L3 approved with L3-D1 to L3-D14 and risks L3-R1 to L3-R4 (23 November 2026). Earlier: L2, L1, P7-0, ADR-009, P7-W and their decisions |
| Scope | Readiness report §11, L4: deposits, inspections, renewals, notice and move-out (LET-06, LET-07, LET-09; §5.5 to §5.7; P7-D3, P7-D11). Verification report §3.1 row L4: deposit (record, protection, deductions, return); inspections (list, schedule, items, complete, tenant acknowledgement); inspection item photos (W7-S1). Wireframes LS-6, LS-7, DP-1, IN-1 to IN-3, ST-2 |
| Not in scope | Payment of deposit returns and of deductions to landlords (payouts and statements, Phase 9). Notification delivery (Phase 12). Portals (L5). Screens, including the printable inspection report (L6). Rent dashboard (L7) |
| Result | **L4 complete, for approval.** Decisions in §9 |

## 1. Deliverables

### 1.1 Database (migration 0039)

| Change | Purpose |
|---|---|
| `app.leases_guard` (replaced) | The L1 rules, plus: a lease ends only with an end date (its term, or the date its notice gives); the move-out date is kept once ended; a renewal (`previous_lease_id`) follows a signed lease of the same unit and starts after it ends. One renewal per lease (not cancelled) |
| `leases.renewal_mark` | The last renewal reminder written (90, 60 or 30 days before the end date), so each is written once |
| `app.deposits_guard` | Deposit life cycle: expected → held → protected → return pending / disputed → returned, partly returned or forfeited. Amount and currency fixed; receipt and protection details fixed once recorded; the return is the deposit less its settled deductions; never deleted. A held deposit moves only to the renewal of its lease |
| `app.deposits_follow_charge` (trigger on the deposit charge) | A deposit the agency collects is held when its deposit charge is paid in full (the receipt and its date recorded), and expected again if that payment is reversed before protection |
| Protection deadline (P7-D11) | With a reviewed jurisdiction value (`deposit_protection_deadline_days`), the deadline follows from the date received; otherwise a person may enter it (`protection_deadline_source`). No value is invented (P7-D3) |
| `deposit_deductions`: `settled_amount`, decided by and at, version; `app.deposit_deductions_guard` | proposed → agreed, disputed or withdrawn; disputed → agreed, adjudicated (with the amount decided) or withdrawn; final after that. Total never above the deposit. Never deleted. Description erasable (ADR-009) |
| `app.inspections_guard`, `app.inspection_items_guard`; one move-in and one move-out inspection per lease | scheduled → in progress → completed (overall condition and every item's condition) or cancelled with a reason. A completed inspection is final except the tenant's acknowledgement, once. Items change only before completion. Never deleted |
| `inspection_item_documents` (W7-S1; row-level security, enabled and forced) and its guard | A photo is a document of the inspection linked to one item, with a caption; added or removed before completion only |
| Documents of an inspection; document type `inspection_photo` | Photos and reports go through the scanned document upload (W7-A1) |
| `app.erase_contact_tenancy` (replaced) | Erasure also blanks inspection cancellation reasons and photo captions (item notes, summaries and deduction descriptions were already covered) |

### 1.2 API

| Area | Endpoints |
|---|---|
| Notice, ending, closing (LS-6) | `POST /leases/{id}/notice`, `POST /leases/{id}/end`, `GET /leases/{id}/close-check`, `POST /leases/{id}/close` |
| Renewal (LS-7) | `POST /leases/{id}/renewal-decision`, `POST /leases/{id}/renewal` (the draft renewal lease); renewals list: `GET /leases?filter[renewalStatus]=pending_decision&sort=endDate` |
| Deposits (DP-1) | `GET`, `PUT /leases/{id}/deposit`; `POST /deposits/{id}/protection`; `POST /deposits/{id}/deductions`; `PATCH /deposits/{id}/deductions/{deductionId}`; `POST /deposits/{id}/return` |
| Inspections (IN-1 to IN-3) | `GET`, `POST /inspections`; `GET`, `PATCH /inspections/{id}`; `PUT /inspections/{id}/items`; `POST`, `DELETE /inspections/{id}/items/{itemId}/photos[/{documentId}]`; `POST /inspections/{id}/complete`, `/tenant-signed`, `/cancel`; `GET /inspections/{id}/documents` |
| Settings (ST-2) | `PUT /settings/lettings` takes `inspectionAreas` (left out: kept) |
| Worker | Daily `lease.renewals` job: renewal reminders at 90, 60 and 30 days, escalation at 30 days without a decision |
| Lease record | `renewalLease`, `moveOutDate`, `noticeGivenOn`, `noticeGivenBy` added; activation of a renewal marks the earlier lease renewed and takes over its held deposit; activation raises the deposit charge of a deposit registered before signature |

The OpenAPI contract adds 20 paths (23 operations). Changed schemas are additions only: the four lease fields above, `inspectionAreas` on the lettings settings, `inspection` among document upload owners, `lease` among the record types a task is about.

No web screen changed. Earlier work (Buildora, Praiseflow, Cleanora, Phases 1 to 6, P7-0, L1, L2 and L3) is unchanged, apart from the test expectations in §4.3.

## 2. Requirement checklist

| Item | Wireframe | Result | Evidence |
|---|---|---|---|
| LET-06 deposit: amount, holder, reference | DP-1 | ✅ Met: the lease's amount; holder and holding account; scheme and reference at protection | API tests; suite 22 |
| Protection deadline from a reviewed value, otherwise entered (P7-D11) | DP-1 | ✅ Met: computed only from a reviewed value with its source; entered otherwise; never invented | API tests; suite 22 |
| Return with itemised, evidenced deductions; never above the deposit | DP-1 | ✅ Met: evidence is a clean document of the lease or an inspection; settled deductions only; returned, partly returned or forfeited | API tests; suites 17, 22 |
| LET-07 notice: who gave it and when | LS-6 | ✅ Met: end date from the lease's notice days by default, shown against the terms, not enforced as law (P7-D3) | API tests |
| Ending, then closing once the deposit is settled and the balance zero (§12.5) | LS-6 | ✅ Met: close check lists each condition; the move-out inspection is shown, not required | API tests |
| Renewal: decision and a new lease linked to the old one | LS-7 | ✅ Met: draft renewal of the same unit and parties; renewed at activation | API tests; suite 22 |
| Renewal tasks at 90, 60, 30 days; escalation at 30 without a decision | LS-7 | ✅ Met: daily job; tasks on the assignee's list; escalation written to the outbox | API tests; performance |
| LET-09 inspections: move-in, move-out, periodic, with item conditions and photos | IN-1, IN-2 | ✅ Met: items from the unit's last inspection; move-in condition beside each move-out item; photos per item (W7-S1) | API tests; suite 22 |
| Finish disabled while photos are scanning; tenant acknowledgement | IN-2, IN-3 | ✅ Met: completion waits for every photo to pass the scan; acknowledgement once | API tests; suite 22 |
| Default inspection areas (company setting) | ST-2 | ✅ Met: none until set (W7-D7) | API tests |

## 3. Review

The migration, services and tests were re-read adversarially before this report. The findings below were fixed in L4:

| # | Finding | Fix |
|---|---|---|
| 1 | The deposit trigger sent a held deposit back to "expected" whenever its charge was not paid, including when the lease has no deposit charge at all (let only), which the guard then refused | It reacts only when a deposit charge exists (suite 22) |
| 2 | Outbox event names for deduction decisions were built by adding "d" to the action ("withdrawd") | An explicit table of names (API tests check the events) |
| 3 | A test company setup failed once a sub-jurisdiction of Ghana existed in the shared test database: provisioning then asks which jurisdiction to use | The reviewed-rule test inserts a Ghana value for that one test and removes it afterwards; no jurisdiction is added (test files run one at a time) |
| 4 | Notice on a lease with a renewal drawn up, and a "not renewing" decision with a renewal drawn up, would contradict each other | Both refused until the renewal is cancelled |
| 5 | Ending a lease when the rent schedule had not yet charged its last periods (no lead time set) would leave them uncharged, since ended leases are not scheduled | The rent up to the end date is charged before the lease ends |
| 6 | Suite 17 (P7-0) added a deduction to a deposit after it was returned | The deduction is proposed and withdrawn before the return (§4.3) |

## 4. Tests

| Suite | Result |
|---|---|
| SQL, `verify.sh` | **39 migrations, 23 files passed.** New: `22_deposits_inspections_l4.sql` (66 assertions); suite 17 adds one erasure assertion |
| API (`test:ci`) | **58 files, 652 tests passed**; coverage 96.19 % statements, 90.33 % branches (thresholds 95 % and 90 %). New: `lease-ending.e2e.test.ts` (9), `deposits.e2e.test.ts` (6), `inspections.e2e.test.ts` (4), `l4-rules.e2e.test.ts` (5); `lettings-access.test.ts` adds the inspection scopes |
| API performance (`test:performance`) | __PERF__ |
| Web unit and message check | Unchanged by L4 (no web change); run in CI |
| Browser (Playwright, axe, English and Arabic, 320 px to desktop) | Unchanged by L4; run in CI |
| Lint and typecheck | API clean |

### 4.1 What the API tests cover

- **Notice:** dates (not in the future; the end on or after the notice and the start; not beyond a fixed term); the default from the lease's notice days, or required without them; charges already raised past the new end returned, unchanged; once only; version, scope and isolation.
- **Ending and closing:** not before the end date; the move-out date (required unless renewed, not in the future, not before the start); the rent to the end date charged first; the close check (balance, unsettled receipts, deposit, move-out inspection shown); closing refused until settled.
- **Renewal:** decisions; the renewal lease (same unit and parties, from the day after the end, terms copied unless given); one per lease; activation marks the earlier lease renewed and carries the held deposit; notice refused on a renewed lease; periodic and finished leases are not renewed.
- **Renewal reminders:** the mark reached (60 then 30 days), once each; the reminder superseded; urgent and escalated at 30 days; closed by the decision; leases ending later, periodic leases and other companies untouched; the task on the assignee's list.
- **Deposits:** registration (the lease's amount; holder and account, its currency and status; entered deadline; not on drafts; If-Match once it exists); the deposit charge and the receipt that makes it held; let-only deposits held from the date entered; the reviewed rule computing the deadline and refusing an entered one; protection (received first, dates, once); deductions (end of tenancy, picklist, currency, total, evidence of the lease or its inspections; agree, dispute, adjudicate within the claim, withdraw, attach evidence; final states); return (ended lease, nothing open, dates; returned, partly returned, forfeited; final); permissions (property managers in their offices; office administrators view only; agents none) and isolation.
- **Inspections:** scheduling (property in scope, unit of the property, lease of the unit and its status, one move-in and move-out per lease, active inspector); items (order, duplicates, unknown ids); start; read only to others while in progress; photos (images of the inspection only, scan pending blocks completion, failed scans refused); completion (overall and item conditions, report clean); the move-out compared with the move-in; acknowledgement once, not before completion or in the future; cancellation; lists with filters, sort, cursor and the assigned scope of maintenance staff; documents of an inspection; isolation.
- **Settings:** default inspection areas, duplicates refused, kept when left out.

### 4.2 What suite 22 covers (66 assertions)

- **Leases:** no ending without an end date; the end date from notice; move-out date kept; renewal of the same unit, after the end, once (a cancelled renewal frees it).
- **Deposits:** registration rules; held only when its charge is paid (part payment, reversal, payment again); the reviewed deadline; protection fixed; amount and receipt fixed; transitions; the return equal to the deposit less settled deductions, with its date; final; never deleted; carried to the renewal only.
- **Deductions:** start proposed; never above the deposit; agreed at the amount; adjudicated only when disputed and at most the claim; final states; never deleted; none on a returned deposit.
- **Inspections and photos:** start scheduled; move-in and move-out of a lease of the unit, not before it starts; one each; completion rules; items, photos and conditions kept once completed; acknowledgement once; cancellation with a reason, final; fixed lease and unit; never deleted; photos only documents of the inspection; links added or removed, not changed.
- **Isolation:** another company sees none of it.

### 4.3 Earlier tests changed

| Test | Change | Reason |
|---|---|---|
| `rent.e2e.test.ts` (L2), lettings settings | The expected settings include `inspectionAreas: []` | The settings gained the default inspection areas (ST-2); an addition |
| Suite 17 (P7-0), deposit close-out | The withdrawn deduction is inserted as proposed and withdrawn before the deposit is returned, instead of inserted as withdrawn after | Migration 0039: deductions start proposed and are not added to a returned deposit. The erasure assertion on it is unchanged |
| Suite 17 (P7-0), erasure | One assertion added (inspection cancellation reason, item note, photo caption) | ADR-009 covers the new free text |

## 5. Security impact

- **Database rules:** deposits, deductions, inspections, items and photo links are guarded by triggers for every path; the API checks first to answer with field codes.
- **Permissions:** lease.update for notice, ending, closing and renewal decisions (owner, admin all; property managers office; agents their own leases); lease.create for the renewal lease. deposit.view to read (owner, admin, accountant all; property managers office); deposit.manage to change (owner, accountant all; property managers office). inspection.view (owner and admin all; property managers office; agents own; maintenance staff assigned); inspection.manage (owner and admin all; property managers office). No permission was added or widened.
- **Scope:** deposits follow their lease; inspections follow their property's office, their inspector and scheduler, and their lease. An inspection in progress is changed only by its inspector or a member who sees every inspection.
- **Files:** photos, reports and evidence go through the scanned document upload (size, checksum, malware scan failing closed, content type checked against the file). A photo is a JPEG or PNG; completion waits for every photo to pass.
- **Concurrency:** leases, deposits, deductions and inspections are locked for each change with version checks (If-Match); the close check runs under the lease's lock.
- **Isolation:** row-level security (enabled and forced) on the new table; every API test and suite 22 include a second company.

## 6. Compliance impact

- No legal values are invented (P7-D3): the protection deadline comes from a reviewed jurisdiction value with its source, or is entered by a person; notice periods are the lease's terms, shown and not enforced; the renewal reminder days are the readiness report's company practice, not law.
- ADR-009: deduction descriptions, inspection summaries, item notes, cancellation reasons, photo captions and lease reasons are erased with the person; amounts, dates and conditions are kept. A held deposit blocks erasure (P7-0); deposits are tenancy records within the retention rule.
- Reminders, escalations and deposit events are written to the outbox; nothing is sent until Phase 12.

## 7. Audit impact

| Record | Audit actions |
|---|---|
| Leases | `lease.notice_given`, `.ended`, `.closed`, `.renewal_decided`, `.renewal_drawn_up`, `.renewed`, `.renewal_reminder` |
| Deposits | `deposit.registered`, `.updated`, `.received`, `.protected`, `.deduction_proposed`, `.deduction_evidence_attached`, `.deduction_agreed`, `.deduction_disputed`, `.deduction_adjudicated`, `.deduction_withdrawn`, `.return_pending`, `.returned`, `.carried_over` |
| Inspections | `inspection.scheduled`, `.updated`, `.started`, `.items_saved`, `.photo_added`, `.photo_removed`, `.completed`, `.tenant_acknowledged`, `.cancelled` |
| Charges and tasks | `rent_charge.posted` (the deposit charge; the rent to the end date); `task.completed`, `task.cancelled` (renewal reminders) |
| Settings | `settings.lettings_updated` (with the areas) |

Every state change also writes an outbox event (`lease.notice_given`, `lease.ended`, `lease.renewal_reminder`, `lease.renewal_escalated`, `deposit.returned`, `inspection.completed` and so on). The renewal job writes audit and outbox rows in one statement each. Free text stays on the record, not in audit metadata (inspection summaries are recorded as changed, not copied).

## 8. Performance impact

Measured through the full API for one company: 20,000 active fixed-term leases (5,000 ending within 90 days), 20,000 held deposits, 40,000 inspections (a completed move-in and a scheduled periodic inspection per lease) with 400,000 items. Owner (all), property manager (office) and maintenance staff (assigned); 42 requests:

| Measure | Result | Budget |
|---|---|---|
| API p95 / median | **90 ms / 27 ms** | 1,000 ms |
| Inspection lists (all, scheduled, assigned, completed) | 113 / 97 ms at most | |
| One inspection (10 items, photos) / deposit tab / close check / lease | 22 / 40 / 14 / 26 ms | |
| Renewals list / task list | 68 / 48 ms | |
| Schedule a move-out (items copied, compared with the move-in) / save items / notice | 60 / 51 / 37 ms | |
| Daily renewal reminders (5,000 leases, 5,000 tasks, 1,735 escalations, audit and outbox) | **5.1 s**; a second run the same day 81 ms (nothing to write) | 60 s |

## 9. Decisions taken in L4 (for confirmation)

| ID | Decision | Reason |
|---|---|---|
| L4-D1 | **Notice** sets the end date: by default the given date plus the lease's notice days, otherwise the date entered; it cannot extend a fixed term. Shorter notice than the lease's terms is shown, not refused | P7-D3; LS-6 "computed and shown, not enforced as law" |
| L4-D2 | **Charges already raised for days after the new end date** are listed with the notice and left to a person (adjust or cancel, RC-3, RC-4); none are changed automatically | P7-D8: money is changed by a person |
| L4-D3 | **Ending** is on or after the end date (term or notice); a running lease with a later end date needs notice first. The rent up to the end date is charged first. A renewed lease ends without a move-out date | Charges must exist for the whole tenancy; the tenant stays under the renewal |
| L4-D4 | **Closing** needs nothing owed, no pending or unallocated receipt for the lease, and the deposit settled (or none). The move-out inspection is shown, not required. Enforced by the API under the lease's lock, not by a database rule | §12.5 and LS-6; P7-0 tests close leases directly |
| L4-D5 | **Renewal** is a draft lease of the same unit and parties starting the day after the end, with the current terms unless given (rent: the rent in force at the end). One per lease. Activating it marks the earlier lease renewed and moves its held deposit to it | §5.6 "a new lease linked to the old one"; a deposit is held once |
| L4-D6 | **Renewal reminders** are tasks on the existing task list, assigned to the member who drew the lease up (or the company owner if they have left): 90 days normal, 60 high, 30 urgent with an escalation event; each superseding the last; closed by a decision, notice or ending. Task titles are written in English | §5.6; tasks are where follow-ups already live (CRM-05) |
| L4-D7 | **Deposit charge.** Where the agency collects (no agreement, or not let only), registering the deposit of a live lease raises a deposit charge due on the start date (today if that period is locked), and the receipt that pays it in full makes the deposit held. It is owed like rent and shows in arrears until paid. Otherwise a person records the day received | §5.1 "deposit … recorded as receipts and allocated"; one money path |
| L4-D8 | **Deposit amount** is the amount the lease's terms name; the deposit cannot be registered without it | Terms are fixed at signing (L1) |
| L4-D9 | **Protection deadline** follows from a reviewed `deposit_protection_deadline_days` value and the date received; otherwise a person may enter one; late protection is recorded (audit), not refused | P7-D11, P7-D3 |
| L4-D10 | **Deductions** are proposed once notice is given or the lease has ended, with optional evidence (a clean document of the lease or one of its inspections); agreed at the amount, or disputed then adjudicated at an amount up to the claim | DP-1; evidenced deductions |
| L4-D11 | **Return** records the amount (the deposit less settled deductions) and the date: returned, partly returned or forfeited. The payment itself is made outside EstatePro until payouts (Phase 9) | Payouts and statements are Phase 9 (P7-D2) |
| L4-D12 | **Inspection items** come from the unit's last completed inspection; with none, the screen offers the company's default areas (setting). A move-out inspection shows each item's move-in condition, matched by area and item | IN-2 |
| L4-D13 | **Photos (W7-S1)** are scanned documents of the inspection (JPEG or PNG) linked to an item with a caption, not media-pipeline assets; completion waits until every photo has passed the scan | One scanned, kept evidence path, as deduction evidence; IN-2 "Finish disabled while uploads are pending" |
| L4-D14 | **Inspection report.** Completion may attach a report uploaded to the inspection; a printable report generated from the record comes with the screens (L6). No PDF library is added in L4 | IN-3; the record is the report until the print view exists |
| L4-D15 | **In progress, read only to others.** Only the inspector (or a member who sees every inspection) changes an inspection in progress; starting it makes the starter the inspector if none is set | IN-2 |

## 10. Risks and open items

| # | Risk | Rating | Owner / when |
|---|---|---|---|
| L4-R1 | Deposit returns and deductions paid to landlords are recorded but paid outside EstatePro until payouts and statements (Phase 9) | Medium | Phase 9 |
| L4-R2 | Renewal task titles are stored in English; other generated texts are translated on screen | Low | L6 (show a translated title for system tasks from their type and lease) |
| L4-R3 | Inspection photos are kept as evidence when a person is erased (captions are erased); a photo could show a person despite the hint | Low | Accepted with the field hint (#35); revisit with the retention rule (#20) |
| L4-R4 | The close conditions are enforced by the API, not the database: a direct database change could close an unsettled lease | Low | Accepted (L4-D4); revisit if other writers appear |
| L4-R5 | The renewal job, like the rent schedule (L2-R1) and the arrears workflow (L3-R3), runs once per UTC day | Low | L7 |

## 11. GitHub references

| Item | Reference |
|---|---|
| CI | __CI__ |
| Earlier CI failure in the screenshot of 23 November | Not found among the last 100 CI runs of the repository (12 to 23 November); the runs on `phase-7/readiness` since L3 commit `21a28f5` (205, 206) passed, and no run since 12 November shows the dependency scan failing |

## Approval

| Item | Decision | Date |
|---|---|---|
| L4 | Pending | |
| L4-D1 to L4-D15 | Pending | |
| L4-R1 to L4-R5 | Pending | |
