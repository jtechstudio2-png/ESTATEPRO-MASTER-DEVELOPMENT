# Phase 6 · Milestone report: S3 Deals

| | |
|---|---|
| Date | 14 November 2026 |
| Branch | `phase-6/readiness`, commits `89a747c` (implementation) and the report commit; CI run 124 (`5719db7`, the implementation plus this report; all six checks green; run 123 on `89a747c` was cancelled when 124 started) |
| Approvals | S2 approved with S2-D1 to S2-D13; S2 risks reviewed and accepted (14 November 2026). "Proceed with S3 (Deals) according to the approved Phase 6 roadmap" |
| Scope | Deals as approved in the readiness report: stages through actions; parties and agents with splits; milestones after acceptance; exchange and completion (sale); ownership transfer on completion; stalled flags; forecast; the pipeline list and board data (§2.1, §4.3); lead conversion (§4.4, P6-D11); the listing effects of exchange, completion and fall-through (§5, P6-D5); P6-D2, P6-D6 to P6-D8. Also the S2 follow-ups: one deal scope (S2-R3), listing withdrawal after S3 (S2-R2), milestones and identity checks on acceptance (S2-R4) |
| Not in scope | Landlord visibility (S4), screens and the drag-free board UI (S5, to the P6-W wireframes), dashboards and close-out (S6), leases from letting deals (Phase 7, P6-D2), commission records (finance phase, P6-D9), contract documents (Phase 10, P6-D14), delivery of notifications (Phase 12) |
| Result | **S3 complete**, for approval before S4. Results in §3; CI run 124 green (§9) |

## 1. Deliverables

### 1.1 Database (migration 0033)

| Rule | Detail |
|---|---|
| Life cycle (§4.3) | Stage moves follow the drawn life cycle for every path (API, worker, scripts): moves within a class; lead → qualification, viewing, negotiation; qualification → viewing, negotiation; viewing → qualification, negotiation; negotiation → offer accepted; offer accepted → negotiation, contract; contract → won; any open stage → lost. A deal starts before "offer accepted" |
| Letting deals (P6-D2) | Stop at "terms agreed": no contract stage and no "let agreed" until leases exist (Phase 7) |
| Contracts (P6-D6) | A sale deal reaches contract only with every buyer (primary contact, buyer and tenant parties) verified where the jurisdiction rule `sales_kyc_required` applies (default on) |
| Completion (P6-D7) | A deal is won only with its required milestones done |
| Deal stage and sale agree | Checked at commit: contract = contracts exchanged; won = sale completed; a fallen-through sale = a lost deal |
| Splits | The credited agents' splits add up to 100 % (checked at commit); none listed = the owner has all the credit |
| Closed deals | Keep their agents, milestones and owner, as they already keep stage and terms (S-D7) |
| Owner history (SAL-05) | `deal_assignments`, written by the database on every owner change with who did it and the note (`app.assignment_note`, used once); append-only; insertion order (#15); erased with the deal's free text (ADR-008 §3, updated) |
| Listing (P6-D5) | A listing whose sale has exchanged contracts is not withdrawn by hand: the sale falls through on its deal first |
| Columns and indexes | `deals.source_code` (lead source carried over); length limits on lost notes, milestone notes and fall-through reasons; indexes for the board and stalled flag, the deal list, owner lists and co-agent scope |

Helper functions: `app.deal_stage_change_allowed`, `app.contact_identity_verified` (the H-D3 reading: latest identity or company-ownership check verified and not expired; erased contacts never), `app.deal_buyer_contacts`, `app.deal_identity_required`.

### 1.2 API

| Endpoint | Purpose | Permission |
|---|---|---|
| `GET /api/v1/deals` | Pipeline list in scope: open by default; filters by type, status, stage, stage class, office, owner (`me`), listing, contact (primary or party), lead, stalled, expected close range; search by reference or contact; cursor paging | `deal.view` |
| `GET /api/v1/deals/pipeline` | Board columns (SAL-06): every active stage before closing with count, stalled count and totals per currency | `deal.view` |
| `GET /api/v1/deals/forecast` | Forecast (SAL-07): expected value × probability of open deals by expected close month (1–24 months), with overdue and undated buckets, per currency | `deal.view` |
| `POST /api/v1/deals` | Create a deal directly (walk-in, referral) | `deal.create` |
| `POST /api/v1/leads/{id}/convert` | Convert a buy or rent lead into its one deal | `lead.update` and `deal.create` |
| `GET /api/v1/deals/{id}` | The deal with parties (identity shown where the member may see it), agents, milestones, stage history, owner history, accepted offer, sale, identity status and the actions available | `deal.view` |
| `PATCH /api/v1/deals/{id}` | Expected value, fee, close date, probability; the listing until offers are recorded | `deal.update` |
| `POST …/stage` | Move by hand among lead, qualification, viewing and negotiation, as the life cycle allows | `deal.update` |
| `POST …/reassign`, `PUT …/agents` | Hand the deal to another agent; set the credited agents and splits (managers) | `deal.update` (company or office scope) |
| `POST …/parties`, `POST …/parties/remove` | Add or remove a party role (the primary contact stays) | `deal.update` |
| `PATCH …/milestones/{id}`, `POST …/milestones/{id}/complete` | Change an open milestone's due date or notes; mark it done | `deal.update` |
| `POST …/exchange` | Contracts exchanged (sales): sale recorded, deal to contract, listing under contract | `deal.update` |
| `POST …/complete` | Completion (sales): deal won, listing sold, ownership transferred | `deal.close` |
| `POST …/lose` | Close as lost with a reason: accepted offer withdrawn, open offers withdrawn, exchanged sale falls through, listing available | `deal.close` |

Other changes:

- **Accepting an offer** (S2) now copies the milestones, opens identity checks for unverified buyers, and completes identity milestones already met (S2-R4).
- **Signing off an identity check** (C2) completes the due-diligence milestones of the person's open deals once their side is verified (P6-D7).
- **One deal scope** (S2-R3): `src/deals/deal-access.ts` is used by deals, offers and viewings; "own" means the owner or an agent on the deal everywhere. A co-agent now also sees the viewings of the deal and may link viewings to it.
- **Listings**: the pipeline sets reserved, available, under contract and sold (sold is final: unpublished and closed); a manual change on a listing with exchanged contracts is refused with code `listing-sale-exchanged`.
- **Leads**: `convertedDealId` on the lead record. **Access report** (G3): a `deals` section.

## 2. Decisions taken in S3 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| S3-D1 | **Boundary.** S3 delivers the API and database for deals and lead conversion; screens follow the P6-W wireframes in S5; the landlord's reduced view is S4; dashboards are S6 | Approved milestone order (readiness §10) |
| S3-D2 | **One deal scope** for deals, offers and viewings: all; office = deals of the member's offices; own = deals the member owns or is a credited agent on. Viewings' own scope (S1-D2) now includes the deals the member is an agent on | Closes S2-R3; ADR-008 §5 |
| S3-D3 | **Stages by action only.** By hand a deal moves among lead, qualification, viewing and negotiation as the life cycle allows; "offer accepted" comes only from accepting an offer, contract from exchange, won from completion, lost from losing. The database enforces the life cycle for every path; a deal starts before "offer accepted" | §4.3 "actions only, never a free edit" |
| S3-D4 | **Direct deals** start at the lead stage. The primary contact becomes the primary buyer (sale) or tenant (letting) party. A listing is optional at creation (required before offers, S2-D4) and must be live and of the deal's kind; the deal's currency is the listing's (else the office's); the expected value defaults to the listing price, or the rent per year for lettings. The owner is the creator unless a manager (company or office scope) names an agent they reach | §4.4 "direct deals allowed"; SAL-07 needs a value |
| S3-D5 | **Lead conversion** (buy → sale, rent → letting) from a new, contacted or qualified lead, in one step: the deal starts at qualification, or at viewing when a viewing is booked; the lead's live viewings of the deal's listing join the deal; owner, office, listing and source come from the lead; the lead becomes "converted", points at the deal and keeps its history. Needs `lead.update` on the lead and `deal.create`; the lead's version is checked | §4.4, P6-D11 |
| S3-D6 | **Reassignment and splits are manager actions** (`deal.update` with company or office scope; office managers reach members of their offices). The new owner or agent must be active staff whose deal access covers the deal. Owner changes are history written by the database with the note. Splits are replaced as a whole and add up to exactly 100 % | §4.3 "reassignment by managers, recorded"; SAL-05 |
| S3-D7 | **Milestones** are copied when an offer is accepted, from the most specific template per code (the company's over the platform's; the property's jurisdiction or its parent over any), with due dates counted from that day in the property's time zone. Accepting again after a withdrawal keeps the milestones already on the deal. Open milestones may change due date and notes; done is final | §4.3, P6-D7, S-D5 |
| S3-D8 | **Identity on acceptance** (sales where `sales_kyc_required` applies): a pending identity check, linked to the deal, is opened for each buyer not yet verified and without a check in progress (also for a buyer added later). `buyer_kyc` completes itself when every buyer is verified, `seller_kyc` when every seller (seller or landlord parties and current owners) is; they cannot be ticked by hand. A side with nobody recorded does not complete, so the seller must be recorded (Ownership tab or a seller party). A completed identity milestone stays complete; exchange checks every buyer again | §4.2 note, P6-D6, P6-D7 |
| S3-D9 | **Exchange** (sale deals at "offer accepted", `deal.update`): the sales record is made from the accepted offer (agreed price = offer amount; agency fee from the request, else the deal's expected fee), with the contract date (not in the future) and the completion due date (not before it). Refused with a field per unverified buyer (`buyerIdentity.<id>`, `unverified`) | Journey step 10, P6-D6 |
| S3-D10 | **Completion** (sale deals at contract, `deal.close`): refused with a field per open required milestone; completion date not in the future and not before exchange. The sale completes, the deal is won, the listing is sold. **Ownership transfer is on by default** (P6-D8): the legal-owner records covering the unit end the day before completion and the buyers are recorded as owners in equal shares from the completion day, for the same unit or whole property. A whole-property record on a property with several units is not split automatically (`ownership-shared`): the change is recorded on the Ownership tab and the deal completed with `transferOwnership: false` | Journey step 11, P6-D8 |
| S3-D11 | **Losing** (`deal.close`, reason from the `lost_reason` picklist, optional notes): from any open stage; an accepted offer is withdrawn, the deal's open offers are withdrawn, an exchanged sale falls through (its reason = the notes, else the reason's label), and the listing returns to available. Closed deals never reopen | §4.3, P6-D5, S-D7 |
| S3-D12 | **Listing withdrawal after S3** (S2-R2): with the deal at "offer accepted" it stays as approved in S2-D8 (offer withdrawn, deal back to negotiation; the manager then loses or keeps the deal). With contracts exchanged the listing is not withdrawn by hand (`listing-sale-exchanged`): the fall-through is recorded on the deal first, which makes the listing available | P6-D5; a fall-through needs a reason on the deal |
| S3-D13 | **Letting deals** stop at "terms agreed": exchange and completion are refused (database and API); letting milestones are copied on acceptance; the sales identity rule does not apply | P6-D2 |
| S3-D14 | **Board, forecast, stalled.** The board lists every active stage before closing with counts, stalled counts and totals per currency; cards come from the list filtered by stage. The forecast weighs open deals' expected value by the probability (the deal's override, else the stage's), by expected close month, with overdue and undated buckets. Amounts are never converted between currencies. A deal is stalled when open longer in its stage than the stage's `stall_after_days`; computed when read | SAL-06, SAL-07, readiness §4.3 |
| S3-D15 | **Parties**: any role, for a contact the member can see that is active; the primary contact's party stays; removing a role is allowed while the deal is open | SAL-05 parties; ADR-008 §5 (links, not copies) |
| S3-D16 | **Free text** (stage notes, owner-change notes, lost notes, milestone notes, fall-through reasons) stays in the record and on the timeline, never in audit metadata; audit holds ids, codes, amounts and dates. Timeline entries link the deal, its primary contact, listing and lead. Audit actions added to ADR-008's list: `deal.updated`, `deal.agents_changed`, `deal.milestone_updated` | ADR-008 §5 |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `database/tests/15_deals_s3.sql` (owner history by the database, note once, no direct writes; life-cycle table, start stage; splits at commit; verified buyers before contracts, expiry and check types; stage and sale agree both ways; listing not withdrawn after exchange; required milestones before completion; closed deals keep agents, milestones and owner; letting deals stop at terms agreed; losing needs the offer withdrawn; erasure of owner-change notes; isolation) | 41 assertions | ✅ |
| Updated SQL suite 12 (P6-0): 15 history streams; its sale walks the life cycle | — | ✅ |
| All SQL suites (`database/scripts/verify.sh`) | 16 files, 33 migrations | ✅ |
| `api/test/deals.e2e.test.ts` (creation and its checks; lead conversion; manual stages; edits; reassignment and splits; co-agent scope for deals, offers and viewings; parties; milestones and identity checks on acceptance; automatic identity milestones; exchange; completion with ownership transfer; shared-ownership refusal; letting stop; losing at offer accepted and after exchange; board, forecast, stalled, paging, search; office scope and manager reach; dates and money; filters; scope, accountants, other company; access report; erasure blocker and erasure) | 19 | ✅ |
| `api/test/deal-rules.test.ts` (scope table, life-cycle table, weighting, equal shares, dates) | 7 | ✅ |
| Updated tests: `offers.e2e` (co-agent split 100 %), `viewings.e2e` and `p6-0-sales-records.e2e` (deals walk the life cycle) | — | ✅ |
| Full API suite (`test:ci`) | 551 in 44 files | ✅ |
| API performance: deals (20,000 open deals) | 1 | ✅ (§6) |
| API performance re-run after S3: listings, viewings, offers | 3 | ✅ |
| Web: typecheck, lint, message check (2,572 keys in both languages), unit tests | 79 | ✅ |
| Browser suite (CI) | 93 | ✅ (run 124) |

API coverage: 96.17 % statements, 90.70 % branches, 98.44 % functions, 98.32 % lines (thresholds 95/90; S2: 96.13/90.79). Deals module: 96.6 % statements, 88.2 % branches.

### 3.1 Defects found and fixed during S3

| Defect | Found by | Fix |
|---|---|---|
| A stale version masked the manager rule: an agent reassigning with an old version got 412 instead of 403 | S3 API test | The manager rule is checked before the version |
| Fixtures in the S1, S2 and P6-0 tests put deals straight into late or closed stages, or credited one co-agent with 0 % | Migration 0033 (life cycle, splits) | The fixtures walk the life cycle and use valid splits |
| Branch coverage fell to 89.86 % with the first S3 tests | Coverage threshold | Edge-rule tests (office scope, dates, filters) and unit tests for the deal helpers |

## 4. Security impact

| Control | Evidence |
|---|---|
| Deals follow one scope (S3-D2); outside scope 404, without the action's permission 403 | API tests (agents, co-agent, office manager in another office, accountant) |
| Reassignment and splits only by managers, who reach only members of their offices | API tests |
| Completion and losing only by the company owner and sales managers (`deal.close`) | API tests (agent 403) |
| Accountants read every deal and change none | API test |
| Contracts need verified buyers; completion needs required milestones; the life cycle holds for every path, not only the API | SQL suite 15; API tests |
| Identity status shown only within the member's identity-check scope | Deal detail (`identityVerified` null otherwise) |
| Tenant isolation: another company sees no deals, board totals or owner history and cannot act on this company's | SQL suite 15; API tests |

No new protected fields (P6-D13). Notes carry the "do not type identity or bank numbers" guidance (#35).

## 5. Compliance and audit impact

| Item | Effect |
|---|---|
| Erasure | Lost notes, stage notes, owner-change notes, milestone notes and fall-through reasons are anonymised with the person; stages, amounts, dates and codes kept (migration 0033 adds owner-change notes; SQL and API tests). A party to an open deal cannot be erased (`open_deal`); a party to a recorded sale stays blocked until the retention rule (#20) |
| Access requests (G3) | The access report lists the person's deals: reference, type, stage, status, listing, their roles, dates, lost reason and notes, and the sale (reference, status, price, contract and completion dates) (API test) |
| Audit actions | `deal.created`, `.updated`, `.stage_changed`, `.reassigned`, `.agents_changed`, `.party_added`, `.party_removed`, `.milestone_updated`, `.milestone_completed` (with `automatic`), `.lost`, `.won`; `lead.converted`; `sale.recorded`, `.exchanged`, `.completed`, `.fallen_through`; `kyc.check_recorded` (started by an acceptance); `property.ownership_ended` / `_added` (transfer, with deal and sale ids); `offer.withdrawn` (with its cause) |
| Audit content | Ids, codes, amounts and dates; no free text (tested for reassignment notes and lost notes) |
| Outbox | One event per action, for notifications in Phase 12 |
| History order | Stage and owner histories carry `entry_no` (#15) |
| Records kept | Deals, stage and owner histories, milestones and sales are never deleted by the runtime role (S-D9) |

## 6. Performance

Budget (readiness report §10): API p95 under 1,000 ms with 20,000 open deals in one company.

| Measure | Result |
|---|---|
| Data | 4,000 listings, 50 agents, 20,000 contacts, 20,000 open deals (2,000 with co-agents) and 5,000 closed deals, with parties, stage and owner histories |
| All requests (43, as owner, sales manager and agent) | median 36 ms, **p95 129 ms**, slowest 184 ms |
| Deal list (owner, manager, agent) / stalled / one column / search | 184 / 130 / 57 / 126 ms (max) |
| A contact's deals / one deal | 36 / 27 ms |
| Board (owner, agent) / forecast (owner, manager) | 50 / 34 ms |
| Create / reassign / set splits | 42 / 26 / 27 ms |
| Migration 0033 | Triggers, one table, five indexes; no data rewritten (owner history seeded from existing deals) |

Re-run after S3, each on its own database: listings p95 153 ms; viewings (200,000, own scope now including co-agents) p95 307 ms (S2: 297 ms); offers (100,000) p95 59 ms (S2: 57 ms). #42 (match refresh) unchanged.

## 7. Accessibility and localisation

S3 adds no screens (S3-D1). Every refusal carries a stable code for the S5 screens to translate in English and Arabic (`stage-change`, `action-stage`, `type-mismatch`, `listing-not-live`, `not-convertible`, `splits-total`, `not-allowed`, `not-assignable`, `out-of-scope`, `primary-contact`, `has-offers`, `automatic`, `unverified`, `incomplete`, `ownership-shared`, `before-contract`, `future`, `listing-sale-exchanged`, …). Amounts come with their currency at its decimal places; dates of exchange and completion are checked against the property's time zone. Message files unchanged (2,572 keys in each language, checked).

## 8. Risks and open items

| # | Item | Rating | Status |
|---|---|---|---|
| S3-R1 | `seller_kyc` completes only when the seller is recorded (owner record or seller party) and verified (S3-D8); a sale whose unit has no recorded owner cannot complete until the owner is recorded | Low | By design, consistent with #18; the Ownership tab records it |
| S3-R2 | A whole-property ownership record over several units is not split automatically on completion (S3-D10) | Low | Recorded by hand on the Ownership tab; completion offers `transferOwnership: false` |
| S3-R3 | Other open deals on a listing that is sold stay open (not lost automatically), like other buyers' offers (P6-D4) | Low | Their listing shows as sold; S6 dashboards can list them |
| S3-R4 | Letting deals stop at "terms agreed" (P6-D2, readiness R4) | — | Phase 7 |
| S3-R5 | No commission records on completion (P6-D9); splits and forecast recorded | — | Finance phase |
| S3-R6 | Totals are per currency, never converted (S3-D14) | Low | A company reporting currency is a later decision |
| — | #42 (before Phase 7), #44 (before Phase 6 closes), #43 (backlog) | — | Unchanged |

## 9. GitHub references

| Reference | Link |
|---|---|
| Phase 6 readiness report (approved) | `docs/phase-6/PHASE-6-READINESS-REPORT.md` |
| S1 and S2 reports (approved) | `docs/phase-6/S1-VIEWINGS-REPORT.md`, `docs/phase-6/S2-OFFERS-REPORT.md` |
| ADR-008 (updated §3: owner-change notes) | `docs/decisions/ADR-008-sales-records-integrity-retention-erasure.md` |
| Issues #42, #43, #44 | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/42 · /43 · /44 |
| CI run 124 (`5719db7`, six checks green) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/43634339056 |

## Approval

Awaiting product owner approval of S3 (S3-D1 to S3-D16) before S4 (landlord visibility) begins.
