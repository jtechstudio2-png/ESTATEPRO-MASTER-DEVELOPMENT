# Phase 7 · Milestone report: L1 Management agreements and leases

| | |
|---|---|
| Date | 22 November 2026 |
| Branch | `phase-7/readiness`. Commits: `f83555f` (migration 0036, SQL suite 19), `2db5514` and `d00a548` (documents, agreements, leases, letting deals, tests), `71bc2e4` and `5aec8c6` (performance test, report), `5c079b6` (dashboards test clock fix). CI run 188 green on `5c079b6` |
| Approvals | P7-0 and ADR-009 approved, with P70-D1 to P70-D9 and risks R1 to R6 (22 November 2026). P7-W approved, with W7-D1 to W7-D8, W7-A1 (approved for L1), W7-A2, W7-S1 and risks W7-R1 to W7-R5 (22 November 2026) |
| Scope | Readiness report §11, L1: management agreements and leases (life cycle, parties, letting deal to lease, activation, listing `rented`). Also W7-A1: the documents upload API that activation needs |
| Not in scope | Rent schedule, charges, adjustments and rent reviews (L2). Receipts and arrears (L3). Deposits, inspections, notice, ending, closing and renewal (L4, see L1-D1). Portals (L5). Screens (L6) |
| Result | **L1 approved (23 November 2026).** L1 complete. All decisions approved, L1-D1 and L1-D2 explicitly (§9 and Approval) |

## 1. Deliverables

### 1.1 Database (migration 0036)

| Change | Purpose |
|---|---|
| `document_upload_sessions` (row-level security); `app.document_versions_scan_guard`; `app.document_is_clean` | W7-A1: uploads between the signed URL and confirmation. A scan result is recorded once (pending → clean, infected or failed) |
| `app.management_agreements_guard`, `app.agreements_overlap` | Draft → active → suspended → active, or ended. Instruction and fee terms are fixed once active. One live agreement per unit. Agreements with live leases cannot end. Only drafts are deleted |
| `leases.deal_id` (one live lease per deal); `app.leases_guard` | The lease life cycle and fixed terms once active. An activated lease names an active agreement that covers its unit, and a clean document if any. Only drafts are deleted |
| `app.lease_parties_guard` | Parties of a live lease are not removed or changed (portal access aside) |
| `app.deals_stage_rules` (replaced) | Letting deals reach "lease signing" once a lease is drawn up from them, and "let agreed" once it is active (replaces the S3 stop at "terms agreed") |

### 1.2 API

| Area | Endpoints |
|---|---|
| Documents (W7-A1) | `POST /documents/uploads`, `POST /documents/uploads/{id}/confirm`, `GET /documents/{id}`, `POST /documents/{id}/download`, `GET /leases/{id}/documents`, `GET /management-agreements/{id}/documents`; worker job `document.scan`; unconfirmed uploads expire with the existing clean-up job |
| Management agreements | `GET/POST /management-agreements`, `GET/PATCH /management-agreements/{id}`, `POST …/activate`, `…/suspend`, `…/end` |
| Leases | `GET/POST /leases`, `GET/PATCH /leases/{id}`, `POST/PATCH/DELETE /leases/{id}/parties…`, `POST …/send-for-signature`, `…/return-to-draft`, `…/activate`, `…/cancel` |
| Letting deals | `POST /deals/{id}/lease` (P7-D4). `POST /deals/{id}/complete` completes letting deals once their lease is active. `POST /deals/{id}/lose` cancels a draft lease with the deal |

The OpenAPI contract adds 20 paths. No existing path or schema changed.

No web screen changed. Earlier work (Buildora, Praiseflow, Cleanora and Phases 1 to 6) is unchanged, apart from three earlier test expectations (§4.3).

## 2. Requirement checklist

| Item | Wireframe | Result | Evidence |
|---|---|---|---|
| LET-02 management agreement: service level, fee, approval limit | MA-1, MA-2 | ✅ Met. Fees are recorded and charged in Phase 9 (P7-D2) | API tests, agreements; suite 19 |
| LET-01 lease: unit, landlords, tenants, guarantors, dates, type, rent, frequency, due day, deposit, notice, break clause | LS-1 to LS-4 | ✅ Met. The deposit amount is recorded; receiving it is L4 | API tests, leases; suite 19 |
| Life cycle draft → pending signature → active, and cancel | LS-3, LS-5 | ✅ Met. Later statuses are guarded in the database; their actions are L4 (L1-D1) | Suite 19 |
| Activation needs the signed document (P7-D5) | LS-5 | ✅ Met: signed, scanned clean, linked to the lease; company setting, on by default | API tests |
| Rent listing becomes rented on activation (P7-D4) | LS-5 | ✅ Met | API tests |
| Letting deal to draft lease, with its parties (P7-D4) | X-D9, LS-2 | ✅ Met; the deal is won through completion (L1-D2) | API tests; suite 19 |
| Management agreement active before rent is collected (§5.1) | LS-2 | ✅ Met for leases that name an agreement. Charges start in L2, which applies the rule to the rent schedule | Suite 19 |
| Documents API (W7-A1) | LS-5, MA-2 | ✅ Met | API tests |

## 3. Review

The migration, services and tests were re-read adversarially before this report. The findings below were fixed in L1:

| # | Finding | Fix |
|---|---|---|
| 1 | Leases and agreements imported live (as in the existing fixtures and the browser seed) were refused by a "starts as draft" rule | Live inserts are allowed, with the same checks as activation (L1-D4) |
| 2 | A database freeze on adding parties broke imports, which add parties after the lease row | The database refuses removing or changing parties of a live lease. The API refuses adding them after activation |
| 3 | An imported ended agreement may have no end date | The end date is required only when an agreement is ended through the workflow |
| 4 | The deal record would have offered the sale completion screen (with ownership transfer) on letting deals | `canComplete` stays sale-only until the letting screens (L6). The completion action itself accepts letting deals |
| 5 | Unit scope for agents ("own"): the first rule let an agent with no office let any unit | Agents draw up leases only for units of their offices |
| 6 | The refusal tests found two defects: an end date before the start reached the overlap query and answered 500; an agreement edit that changed nothing still raised the version and wrote an audit row (amounts compared as text) | The overlap check runs only on a valid date range (the 422 names the dates); amounts compare as numbers |
| 7 | The platform role (support and tests) could not maintain document uploads, unlike media uploads | Same grants as `upload_sessions` (migration 0018) |

## 4. Tests

| Suite | Result |
|---|---|
| SQL, `verify.sh` | **36 migrations, 20 files passed.** New: `19_agreements_leases_l1.sql` (54 assertions) |
| API (`test:ci`) | **48 files, 581 tests passed**; coverage 95.95 % statements, 90.39 % branches (thresholds 95 % and 90 %). New: `lettings.e2e.test.ts` (10 tests), `lettings-rules.e2e.test.ts` (3 tests of every refusal and scan outcome), `lettings-access.test.ts` (2 unit tests) |
| API performance (`test:performance`) | **14 files, 18 tests passed** (13 earlier files unchanged in one run; the new lettings test re-run after a fix to its own setup, §3 finding 6) |
| Web unit and message check | Unchanged by L1 (no web change); run in CI |
| Browser | Unchanged by L1; run in CI |
| Lint and typecheck | API clean |

### 4.1 What the API tests cover (10 tests, `lettings.e2e.test.ts`)

- **Documents:** upload, scan pending then clean, download and its audit, list per record. An infected file is refused for download. Unsupported types and unknown document types are refused. Scope by office, and isolation from another company.
- **Agreements:** validation, draft edit, activation (without a document, with an unsigned one, then with the signed one), fixed terms and editable operational terms, the overlap refusal, suspend and reactivate, end (and the date check). Audit and outbox for each step. Office scope, accountant read-only, agents without access, isolation.
- **Leases:** validation, the landlord taken from the ownership record, parties, draft edit, send for signature, the overlap refusal for the same dates. Activation: agents refused (403), document required, scan pending, signature date in the future, then success. Afterwards the listing is rented and published no more, terms and parties are fixed, portal access still changes, cancel is refused, and the agreement cannot end while the lease is live. Audit and outbox for each step.
- **Signed-document rule turned off (P7-D5):** primary tenant changes, return to draft, cancel with reason.
- **Lists:** filters and search, office scope, agents' own leases, isolation.
- **Letting deals:** lease drawn up from the deal (rent from the offer, parties from the deal). The deal is at lease signing and the listing under contract. Only one lease per deal, and the rent cannot be edited. Completion is refused before activation and with milestones open; activation completes "lease signed"; then the deal is won. Losing the deal cancels a draft lease but is refused while a lease awaits signature. Members without `lease.create` are refused, as are deals not at terms agreed.

### 4.2 What suite 19 covers (54 assertions)

- **Documents:** the scan result is final, and versions are never changed or deleted.
- **Agreements:** the life cycle, fixed terms, overlap, the clean-document rule, ending with live leases, and deleting drafts only.
- **Leases:** the life cycle, including the L4 transitions; fixed terms; the end date moving only with notice; the agreement covering the unit and being active; the clean-document rule; deleting drafts only.
- **Parties:** fixed once the lease is active, except portal access.
- **Letting deals:** lease signing only with a lease, and let agreed only once it is active.
- **Isolation:** another company sees none of it.

### 4.3 Earlier tests changed

| Test | Change | Reason |
|---|---|---|
| Suite 15 (S3), letting-deal assertion | Label only: "stops until leases (Phase 7)" becomes "moves to lease signing only once a lease is drawn up (P7-D4)" | Same refusal, new reason |
| `deals.e2e.test.ts` (S3), letting test | Title and the expected refusal text | Exchange is still refused for lettings. The message now points to `POST /deals/{id}/lease` |
| Suite 17 (P7-0) | The fixture lease is ended, then closed, in two steps | The lease life cycle (migration 0036) has no active → closed step |
| `dashboards.e2e.test.ts` (C4), CRM dashboard | Lead times are computed from one clock reading instead of a `Date.now()` per call | A response set exactly on the 60-minute target fell 1 ms outside it when the clock ticked between calls (CI run 187). Test-only; the dashboard code is unchanged |

## 5. Security impact

- **Database rules:** every life-cycle and fixed-term rule is a trigger, so it holds for every path. Two exceptions are deliberate: the API checks the activation document rule (P7-D5, a company setting) and the adding of parties to a live lease.
- **Documents:**
  - stored privately and uploaded with a signed URL bound to type and size;
  - checked for checksum, malware (ClamAV, fail closed) and real type before use;
  - downloaded only when clean, through a short-lived link, and every download is audited;
  - access follows the lease or agreement the document belongs to.
- **Scope:** leases follow the property's office, or "own" (drawn up by the member or on their deals). Agreements follow the property's office.
- **Isolation:** row-level security applies on the new table and the existing ones. Every API test includes a second company.

## 6. Compliance impact

- Lease documents are uploaded, not generated (P7-D3, #23).
- The lease record shows `rulesNotReviewed` when the jurisdiction has no reviewed rule values (P7-D3).
- Lease cancellation reasons are free text on the lease. They are erased with the person under ADR-009 (ended reason).
- Document titles are guided "no identity or bank numbers".

## 7. Audit impact

Every action is audited in the same transaction, with an outbox event for the state changes:

| Record | Audit actions |
|---|---|
| Documents | `document.uploaded`, `.scanned`, `.rejected`, `.downloaded` |
| Management agreements | `management_agreement.created`, `.updated`, `.activated`, `.suspended`, `.ended` |
| Leases | `lease.created`, `.updated`, `.party_added`, `.party_updated`, `.party_removed`, `.sent_for_signature`, `.returned_to_draft`, `.activated`, `.cancelled` |
| Deals | `deal.stage_changed`, `deal.milestone_completed`, `deal.won` |

Free text (cancellation reasons) stays on the record, not in audit metadata. The deal timeline records lease events.

## 8. Performance impact

Measured through the full API at the readiness volume for one company: 2,000 properties of 10 units, 20,000 leases (18,000 active, 1,000 closed, 1,000 drafts) each with a tenant and a landlord, 2,000 management agreements. Owner (all) and property manager (office) scope; 42 requests:

| Request | Slowest |
|---|---|
| Lease list (default, active, owner and PM) | 157 ms |
| Leases ending by a date, sorted by end | 79 ms |
| Lease search (tenant name) | 117 ms |
| Leases of a contact / of a property | 17 ms / 13 ms |
| One lease | 24 ms |
| Agreement list and search / one agreement | 45 ms / 15 ms |
| Draw up / edit / send for signature / cancel a lease | 46 / 28 / 26 / 25 ms |

**p95 116 ms, median 26 ms** against the 1,000 ms budget. The 13 earlier performance files pass unchanged.

## 9. Decisions taken in L1 (for confirmation)

| ID | Decision | Reason |
|---|---|---|
| L1-D1 | **Notice, ending, closing and renewal are built in L4**, as the readiness roadmap (§11, approved) places them. The database already guards those transitions (suite 19). The P7-W verification report §3.1 listed their endpoints under L1 | Closing needs settled deposits and the move-out inspection (L4), and renewal follows notice. Building them in L1 would mean placeholders |
| L1-D2 | **A letting deal moves to "lease signing" when its lease is drawn up, and is won ("let agreed") through the existing completion action once the lease is active and the deal's required milestones are done.** Activation completes the "lease signed" milestone itself | P7-D4 says a deal is "closed won by creating a draft lease". The letting milestone templates require "advance received" and "move-in inspection" before a deal is won, and those happen after signing. Closing at draft would break the approved milestone rule (P6-D7) |
| L1-D3 | The signed-document rule (P7-D5) is the company setting `lettings.require_signed_lease`, on unless stored as `false`. The settings screen comes with ST-2 (L2) | "Configurable, on by default" |
| L1-D4 | Leases and agreements imported live are accepted with the activation checks. Parties of a live lease are added only on import; the API refuses it | Existing data (fixtures, migrations from other systems) arrives live |
| L1-D5 | One live (active or suspended) agreement per unit; a whole-property agreement covers every unit | Otherwise who collects the rent would be ambiguous |
| L1-D6 | Without a landlord party, a new lease takes the unit's current legal owners (P5-H ownership records) as landlords | Wireframe LS-2 |
| L1-D7 | A lease under an agreement is in the agreement's currency. A deal's lease takes the accepted offer's rent; changing it means a new offer on the deal | Fees are a share of rent in one currency. The offer is the agreed term |
| L1-D8 | Documents count towards the plan's storage quota, like media. A replacement is a new document (versions arrive when needed) | One storage entitlement; versions never change (migration 0011) |
| L1-D9 | Agents ("own" scope) draw up leases for units of their offices, and see the leases they drew up or that are on their deals | Seeded `lease.*` own scope |

## 10. Risks and open items

| # | Risk | Rating | Owner / when |
|---|---|---|---|
| L1-R1 | Activation does not yet charge the advance rent (wireframe LS-5); charges start with the rent schedule | Low | L2 |
| L1-R2 | Activation does not schedule the move-in inspection (LS-5) | Low | L4 |
| L1-R3 | Until L4, active leases cannot be ended through the API | Low | L4 |
| L1-R4 | P7-0 R1 (company-wide balance reads near the budget) is unchanged by L1 | Medium | L3 |

## 11. GitHub references

| Item | Reference |
|---|---|
| CI | Run 188 (`5c079b6`): all 6 jobs green: API lint, typecheck, build and tests with coverage thresholds; database migrations and SQL suites; web lint, typecheck, messages, unit tests and build; web end-to-end (Playwright, axe, English and Arabic, 320 px to desktop); secret scanning; dependency scanning. Run 187 (`5aec8c6`) failed on one Phase 5 dashboards test, a timing bug in the test, fixed in `5c079b6` (§4.3) |

## Approval

| Item | Decision | Date |
|---|---|---|
| L1 | Approved | 23 November 2026 |
| L1-D1 (notice, ending, closing and renewal in L4) | Approved | 23 November 2026 |
| L1-D2 (letting deal won once the lease is active) | Approved | 23 November 2026 |
| L1-D3 to L1-D9 | Approved, each individually | 23 November 2026 |
| L1-R1 to L1-R4 | Reviewed and accepted | 23 November 2026 |
| W7-A1 (documents upload API) | Completed | 23 November 2026 |
