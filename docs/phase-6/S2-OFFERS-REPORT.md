# Phase 6 · Milestone report: S2 Offers

| | |
|---|---|
| Date | 14 November 2026 |
| Branch | `phase-6/readiness`, commits `457d617` (implementation) and the report commit; CI run 120 (`457d617`, all six checks green) |
| Approvals | S1 approved with S1-D1 to S1-D12 (14 November 2026). "Proceed to S2 (Offers) according to the approved Phase 6 roadmap" |
| Scope | Offers as approved in the readiness report: record offers and counter-offers as an immutable chain; respond, accept, reject, withdraw; expiry; one accepted offer per listing (§2.1, §4.2); the offer effects on the deal stage (§4.3) and on the listing status (§5, P6-D5); who accepts (P6-D4) |
| Not in scope | Deals (S3: creation, lead conversion, parties and agents, milestones, exchange and completion, forecast), landlord visibility of offers (S4), screens (S5), offer letters (Phase 10, P6-D14), delivery of notifications (Phase 12) |
| Result | **S2 complete**, for approval before S3. Results in §3; CI run 120 green (§9) |

## 1. Deliverables

### 1.1 Database (migration 0032)

| Rule | Detail |
|---|---|
| Deal stage and offers agree | A deal is at "offer accepted" only while one of its offers is accepted; an accepted offer's deal is at "offer accepted" or later. Checked at commit, so the offer and the deal change together |
| Accepting needs a listing on the market | An offer is accepted only while its listing is available or reserved |
| Listing status follows the deal (P6-D5) | A listing with an accepted offer changes status only within an offer action (marked for the transaction); a manual change is refused, except withdrawing the listing |
| Expiry | Index on open offers by expiry time, for the worker |

These add to the offer rules of migrations 0007 (one accepted offer per listing) and 0030 (terms immutable, allowed statuses, counter-offer chain, no deletes, erasure of conditions).

### 1.2 API

| Endpoint | Purpose | Permission |
|---|---|---|
| `GET /api/v1/offers` | Offers in scope, newest first: a deal's negotiation, a listing's offers, a contact's offers, by status; cursor paging | `offer.view` |
| `POST /api/v1/offers` | Record an offer on an open deal (moves an early deal to negotiation) | `offer.manage` |
| `GET /api/v1/offers/{id}` | One offer with its chain (parent, counter-offers) and "another offer accepted" flag | `offer.view` |
| `POST …/counter` | Counter an open offer from the other side; returns the counter-offer | `offer.manage` |
| `POST …/accept` | Accept: deal to "offer accepted", listing reserved | `offer.accept` |
| `POST …/reject` | Reject an open offer | `offer.manage` |
| `POST …/withdraw` | Withdraw an open offer, or an accepted one with a reason (deal back to negotiation, listing available) | `offer.manage` |

Other changes: worker job `offer.expire` (every 15 minutes); the listing status change refuses a manual change while an accepted offer exists (code `listing-has-accepted-offer`) and, when the listing is withdrawn, withdraws the accepted offer too; the access report (G3) gains `offers`. A shared helper moves deals between stages for viewings and offers (`src/deals/deal-stage.ts`).

## 2. Decisions taken in S2 (approved 14 November 2026)

| # | Decision | Reason | Status |
|---|---|---|---|
| S2-D1 | **Boundary with S3.** S2 records offers on existing deals and applies the offer effects the readiness report gives to offers (deal stage, listing status). Creating deals, lead conversion, parties and agents, milestones copied on acceptance and identity checks started on acceptance (§4.2 note, P6-D6, P6-D7) are built in S3. Until S3, deals exist only in tests | Approved milestone order (S2 offers, then S3 deals); avoids building deal features ahead of their milestone | **Approved** |
| S2-D2 | Offer scope follows the deal: **all**; **office** = deals of the member's offices; **own** = deals the member owns or is an agent on (`deal_agents`) | ADR-008 §5 ("their own deals and the offers on them") | **Approved** |
| S2-D3 | The offeror must be on the right side of the deal: buyer side = the deal's primary contact or a buyer or tenant party; seller side = a seller or landlord party or a current owner of the unit. Being on the deal links the contact to the member's deal; any other contact is refused | Prevents offers from unrelated people; agents record offers from their deal's buyer without needing the contact in their contact scope | **Approved** |
| S2-D4 | Terms: in the deal's currency, at most its decimal places, more than zero; rent frequency required for lettings and refused for sales; financing from the "financing" picklist; expiry in the future; the deal must be open and have a listing | §4.2; closes S1 finding R6 (offers on a deal without a listing) | **Approved** |
| S2-D5 | Only an open (submitted) offer can be countered; the counter comes from the other side; the answered offer becomes "countered"; the response is the counter-offer | §4.2 counter rule | **Approved** |
| S2-D6 | Accepting needs `offer.accept` (company owner all, sales manager office) and a listing that is available or reserved. The deal moves to "offer accepted" (stage note "Offer accepted"); an available listing becomes reserved (a reserved one stays). Other open offers on the listing stay recorded, flagged `otherOfferAccepted`; accepting a second one is refused (409) | P6-D4, P6-D5 | **Approved** |
| S2-D7 | Withdrawing an accepted offer needs a reason; the deal returns to negotiation and the listing to available ("Accepted offer withdrawn") | §4.3 (offer accepted → negotiation), P6-D5 | **Approved** |
| S2-D8 | With an accepted offer, a manual listing status change is refused; **withdrawing the listing withdraws the accepted offer and returns the deal to negotiation** (stage note "Listing withdrawn"). P6-D5 says "the deal then falls through": closing a deal as lost is an S3 action, so in S2 the deal stays open at negotiation and S3 offers to close it | P6-D5; the deal-closing action belongs to S3 | **Approved** |
| S2-D9 | Recording an offer moves a deal at lead, qualification or viewing to negotiation ("Offer recorded") | §4.3 | **Approved** |
| S2-D10 | Open offers past their expiry time become expired (worker, every 15 minutes, audited as the system); an expiry never moves the deal or the listing | §4.2 | **Approved** |
| S2-D11 | Free text (conditions, reasons) stays in the offer record and on the timeline (listing, offeror, the deal's lead), never in audit metadata; amounts and ids are in audit metadata | ADR-008 §5 | **Approved** |
| S2-D12 | The transaction marker for offer actions (`app.pipeline_action`) guards against a manual listing change slipping past the pipeline; it is not a security control (the application sets it), as documented in migration 0032 | Keeps P6-D5 in the database without new roles | **Approved** |
| S2-D13 | S2 delivers the API and database; offer screens follow the P6-W wireframes in S5; the landlord's reduced view of offers is S4 | Readiness §10, §6 | **Approved** |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `database/tests/14_offers_s2.sql` (offer and deal stage together; "offer accepted" only by accepting; listing reserved; manual listing changes refused; a second open offer kept; one accepted per listing; withdrawal reverses; no acceptance on a withdrawn listing; isolation) | 13 assertions | ✅ |
| All SQL suites (`database/scripts/verify.sh`) | 15 files, 32 migrations | ✅ |
| `api/test/offers.e2e.test.ts` (recording and effects; refusals with codes; counter chain both ways including a current owner; acceptance rights, effects and flags; 409 for a second acceptance; listing rule and listing withdrawal; withdrawing an accepted offer; reject and withdraw; worker expiry; scope for agent, co-agent, accountant, other company; listing and contact lists with paging; lead timeline; access report; erasure) | 12 | ✅ |
| Updated test: `p6-0-sales-records.e2e` (its fixture accepts the offer together with the deal stage, as migration 0032 requires) | — | ✅ |
| Full API suite (`test:ci`) | 525 in 42 files | ✅ |
| API performance: offers (100,000 offers, 20,000 open deals) | 1 | ✅ (§6) |
| API performance re-run after S2: listings, viewings | 2 | ✅ |
| Web: typecheck, lint, message check (2,572 keys in both languages), unit tests | 79 | ✅ |
| Browser suite (CI) | 93 | ✅ (run 120) |

API coverage: 96.13 % statements, 90.79 % branches, 98.42 % functions, 98.27 % lines (thresholds 95/90; up from 96.08/90.72). Offers module: 97.7 % statements, 93.4 % branches.

### 3.1 Defects found and fixed during S2

| Defect | Found by | Fix |
|---|---|---|
| Agents could not record an offer from their own deal's buyer when the buyer was outside their contact scope | S2 API test | Being on the deal links the contact (S2-D3) |
| The expiry test tried to backdate an offer's expiry, which the database rightly refuses (terms are immutable) | S2 API test | The worker runs with a clock two hours ahead instead |

## 4. Security impact

| Control | Evidence |
|---|---|
| Offers follow deal scope; outside scope 404, without the action's permission 403 | API tests (agent, co-agent, accountant) |
| Only the company owner and sales managers accept (P6-D4); agents get 403 | API test |
| Accountants read every offer and change none | API test |
| Offerors limited to the deal's sides (S2-D3) | API tests |
| One accepted offer per listing; stage and listing rules hold for every path, not only the API | SQL suites 12 and 14; API tests |
| Tenant isolation: another company sees no offers and cannot record, read or act on this company's | SQL suite 14; API test |

No new protected fields (P6-D13). Conditions carry the "do not type identity or bank numbers" guidance in the API description (#35).

## 5. Compliance and audit impact

| Item | Effect |
|---|---|
| Erasure | Offer conditions erased with the person, amount and status kept (migration 0030; API test). A party to an open deal cannot be erased (`open_deal` blocker) |
| Access requests (G3) | The access report lists the offers the person made: listing, direction, status, amount, currency, rent frequency, conditions, financing and dates (API test) |
| Audit actions | `offer.submitted`, `.countered`, `.accepted`, `.rejected`, `.withdrawn` (with `wasAccepted`), `.expired` (system); listing status changes by offers audited as `listing.status_changed` with the reason "Offer accepted" or "Accepted offer withdrawn"; deal stage changes recorded by the database with their note |
| Audit content | Ids, codes, amounts and expiry; no free text (tested) |
| Outbox | One event per action (offer id, deal, listing), for notifications in Phase 12 |
| History order | Offers carry `entry_no` (#15); the access report and lists order by time then insertion |

## 6. Performance

Budget (readiness report §10): API p95 under 1,000 ms with 20,000 open deals and 100,000 offers in one company.

| Measure | Result |
|---|---|
| Data | 4,000 listings, 50 agents, 20,000 contacts, 20,000 open deals, 100,000 offers |
| All requests (34, as owner, sales manager and agent) | median 24 ms, **p95 57 ms**, slowest 119 ms |
| Newest offers (owner, manager, agent) / open offers | 119 / 57 ms (max) |
| A deal's negotiation / a listing's / a contact's offers | 23 / 24 / 22 ms |
| One offer | 18 ms |
| Record / accept / withdraw an accepted offer | 45 / 30 / 28 ms |
| Migration 0032 | Triggers and two indexes; no data rewritten |

Re-run after S2, each on its own database: listings p95 263 ms; viewings (200,000) p95 297 ms. #42 (match refresh) unchanged.

## 7. Accessibility and localisation

S2 adds no screens (S2-D13). Every refusal carries a stable code (`currency-mismatch`, `precision`, `positive`, `not-buyer-side`, `not-seller-side`, `deal-without-listing`, `deal-closed`, `listing-not-available`, `listing-has-accepted-offer`, …) for the S5 screens to translate in English and Arabic; amounts are returned with their currency at its decimal places. Message files unchanged (2,572 keys in each language, checked).

## 8. Risks and open items (reviewed and accepted 14 November 2026)

| # | Item | Rating | Status |
|---|---|---|---|
| S2-R1 | Offers can be recorded only on deals, and deals are created in S3 (S2-D1) | — | As planned |
| S2-R2 | Withdrawing a listing with an accepted offer returns the deal to negotiation rather than closing it (S2-D8) | Low | S3 adds closing a deal as lost; the S3 report will say whether withdrawal should then offer it |
| S2-R3 | Deal scope is applied two ways today: viewings check a deal with `deal.view` where "own" means owner only (S1), offers count co-agents too (S2-D2) | Low | Unify in S3, where deal scope is defined for the deal API |
| S2-R4 | Milestones and buyer identity checks on acceptance (§4.2 note) | — | S3 (P6-D6, P6-D7) |
| — | #42 (before Phase 7), #44 (before Phase 6 closes), #43 (backlog) | — | Unchanged |

## 9. GitHub references

| Reference | Link |
|---|---|
| Phase 6 readiness report (approved) | `docs/phase-6/PHASE-6-READINESS-REPORT.md` |
| S1 report (approved) | `docs/phase-6/S1-VIEWINGS-REPORT.md` |
| Issues #42, #43, #44 | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/42 · /43 · /44 |
| CI run 120 (`457d617`, six checks green) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/43608054038 |

## Approval

| Item | Decision | Date |
|---|---|---|
| S2 (offers) | **Approved** | 14 November 2026 |
| S2-D1 to S2-D13 | **Approved**, each individually | 14 November 2026 |
| S2-R1 to S2-R4 | Reviewed and accepted | 14 November 2026 |

Next: S3 (deals), per the approved Phase 6 roadmap.
