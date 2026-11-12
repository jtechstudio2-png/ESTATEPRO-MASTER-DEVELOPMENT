# Phase 6 Readiness Report (Sales pipeline)

| | |
|---|---|
| Date | 12 November 2026 |
| Branch | `phase-6/readiness` from `main` after the Phase 5 merge (§1, G1) |
| Scope | Readiness for Phase 6 (sales pipeline): viewings, offers, deals, lead conversion, and landlord visibility (#5). Includes the determination on #15 |
| **Recommendation** | **GO for Phase 6 once the decisions in §9 are approved**, starting with milestone P6-0 (#15 and the data-protection groundwork). Viewings, offers and deals start only after P6-0 is approved (product owner direction, 12 November 2026). No Phase 6 implementation has started |

## 1. Gate status checklist

| # | Gate | Status | Evidence |
|---|---|---|---|
| G1 | Phase 5 merged to `main` through a reviewed pull request, CI green | ✅ Met | Pull request #39 merged on 12 November 2026 as `5ef896c` after all six required checks passed (run 43186315491); review decision recorded on the pull request |
| G2 | Phase 5 approved as complete; consolidated report reviewed; P5-H decisions approved | ✅ Met | Product owner, 7 and 12 November 2026 |
| G3 | Branch protection on `main` with the six required checks | ✅ Met | Unchanged since Phase 5 (G5 of the Phase 5 report) |
| G4 | Existing schema for the pipeline reviewed against the specification | ✅ Met | §2: migration 0007 covers SAL-01 to SAL-07; gaps listed |
| G5 | #15 assessed for Phase 6 | ✅ Met (decision needed) | §3: must be completed before deal and offer histories (P6-D1) |
| G6 | Workflows prepared: viewings, offers, deals, lead conversion | ✅ Met (approval needed) | §4–§7 |
| G7 | Landlord visibility (#5) requirements prepared | ✅ Met (approval needed) | §8 |
| G8 | Data-protection impact assessed (encryption, erasure, merge, audit) | ✅ Met | §10 |
| G9 | Decisions listed for approval | ✅ Ready | §9: P6-D1 to P6-D14 |
| G10 | Wireframes for the Phase 6 screens | ❌ Not yet | First deliverable after approval (P6-W), as #8 was for Phase 5 |
| G11 | Launch-track items keep their accepted status for local development | ✅ Met | #6 (test identity provider), #28 (no shared environment) unchanged |

## 2. What already exists

### 2.1 Database (migration 0007, Phase 2)

| Table | Holds | Built-in rules |
|---|---|---|
| `pipeline_stages` | Stages per company and deal type (sale, letting), each mapped to a fixed stage class | Seeded defaults; closed won 100 %, closed lost 0 %; stall threshold per stage |
| `deals` | Deal with type, stage, listing or unit, lead, primary contact, office, owner, value, fee, expected close | Status generated from stage class; closed deals have a close time; lost needs a reason; accepted-offer stages need a listing or unit; stage class kept in step by trigger |
| `deal_stage_history` | Stage changes | — (no order guarantee: §3) |
| `deal_parties`, `deal_agents` | Parties by role; agents with commission split | — |
| `viewings`, `viewing_attendees` | Viewing with listing, unit, lead or deal, agent, type, time window, time zone, status, outcome, feedback, `seller_feedback_shared`, reschedule link | An agent cannot hold two overlapping live viewings; completed viewings need an outcome |
| `offers` | Offer with direction, parent offer, amount, rent frequency, conditions, financing, status, expiry | Terms immutable (trigger); one accepted offer per listing (unique index) |
| `milestone_templates`, `deal_milestones` | Progression steps per jurisdiction and deal type, copied onto deals | Seeded for sale (9) and letting (4) |
| `sales_transactions` | Agreed price, fee, contract, completion, fall-through | One per deal |

Also in place: permissions `deal.*`, `viewing.*`, `offer.*` with role grants (migration 0014); `leads.converted_deal_id` and the rule that a converted lead has a deal (0024); contact merge rules for deals, parties, attendees and offers (0022); the landlord resolver (0025); ownership records and the owner-identity check (0028); `kyc_checks.deal_id`.

### 2.2 Gaps found in this review

| # | Gap | Effect | Proposed fix |
|---|---|---|---|
| R1 | History order (#15) not guaranteed in `deal_stage_history`, offers, lead status history and five older streams | Acceptance writes several rows in one transaction; they can show in any order | P6-0 (§3) |
| R2 | `app.erase_contact` does not clear Phase 6 free text: viewing feedback, offer conditions, deal lost notes, stage-change notes, milestone notes | An erasure would leave personal data behind | P6-0 (§10) |
| R3 | Erasure blockers do not consider deals or sales | A party to an open deal or a recorded sale could be erased | P6-D12 |
| R4 | No append-only guard on `deal_stage_history`, viewing outcome, accepted-offer status, or completed sales | Audit integrity weaker than Phase 5 histories | Guards in the Phase 6 migrations |
| R5 | Landlord role lacks `deal.view` and `viewing.view`; accountant lacks `viewing.view` and `offer.view` (the specification grants read to both) | #5 cannot be implemented; accountant view incomplete | P6-D10 |
| R6 | Listing status is changed by hand today (ADR-004); no link to offers or deals | A listing could read "Sold" with no deal, or "Available" with an accepted offer | P6-D5 |
| R7 | Key check-out to a contact does not check contact scope (Phase 5 report §5.1) | Low | With viewings (S1) |

## 3. Issue #15: deterministic history ordering

### 3.1 Current state

| Stream | Ordered by | Stable? |
|---|---|---|
| Activity timeline | time, `entry_no` (C3) | ✅ |
| Notes revisions | revision number | ✅ |
| Lead status history | time only | ❌ |
| Listing status and price history | time, UUIDv7 id | ❌ |
| Property and listing activity (audit) | time, UUIDv7 id | ❌ |
| Key movements | time, UUIDv7 id | ❌ |
| Privacy request events | time, UUIDv7 id | ❌ |
| Deal stage history, offers (Phase 6) | time only | ❌ |

PostgreSQL `now()` is the same for every row in a transaction, and UUIDv7 ids are only ordered to the millisecond, so rows written together tie and can come back in either order.

### 3.2 Determination

**#15 must be completed before deal and offer histories are introduced** (recommendation P6-D1). Reasons:

1. **Phase 6 actions write several history rows at once.** Accepting an offer, in one transaction, changes the offer, the deal stage, the listing status, writes audit rows and outbox events. Converting a lead changes the lead status and creates the deal. These are exactly the ties #15 describes; the deal timeline would show "Listing reserved" before "Offer accepted" at random.
2. **The histories are append-only.** Phase 5 made them immutable by guard triggers. Adding an order column afterwards means a backfill under the maintenance role on tables that are already large, instead of a column that is right from the first row.
3. **Cursor format changes once.** The keyset cursors encode (time, id). Changing them for every history endpoint in one milestone keeps one cursor version, rather than a different rule per stream.
4. **Cost is small now.** Seven existing streams plus the new Phase 6 tables, with the pattern already proven in C3.

### 3.3 Required approach (P6-0)

- An `entry_no bigint` insertion-order column on every history and audit stream (the C3 pattern), unique, indexed with the time column.
- **Backfill in the current visible order** (time, then id): add the column without the identity default, number existing rows with `row_number()` in that order under the maintenance role, then attach the sequence starting after the maximum. (`ADD COLUMN … GENERATED ALWAYS AS IDENTITY` numbers rows in physical order, which is not the visible order.)
- Final sort key and keyset cursor tie-breaker for listing status and price history, property and listing activity, key movements, lead status history, privacy request events and the audit log; then deal stage history, offers and viewing changes from their first migration.
- Cursor format versioned (old cursors answer a clear 400 asking for the first page).
- Tests: several entries written in one transaction read back in write order on every run; paging across tied times neither skips nor repeats; row-level security and guards unchanged.

## 4. Viewing workflow (SAL-02)

### 4.1 Life cycle

```text
scheduled ──confirm──▶ confirmed ──record outcome──▶ completed
    │                      │
    ├──cancel (reason)─────┴──▶ cancelled
    ├──no-show (after start) ──▶ no_show
    └──reschedule ──▶ rescheduled  (a new viewing is created; rescheduled_to_id links them)
```

| Rule | Detail |
|---|---|
| What can be viewed | A unit of a listing that is live (available, reserved, under contract). Not when the unit is under maintenance (PRP-05). |
| Who | `viewing.manage` within scope: agents for their own listings, leads and deals; managers for their office. The agent must be an active staff member |
| Attendees | Contacts the member may see; at least one for in-person and virtual viewings; none required for an open house |
| Conflicts | The database refuses two live viewings for one agent at the same time. A second viewing of the same unit at the same time is a warning, not a block (open houses, joint viewings) |
| Time | Start and end in the property's time zone, shown with the zone name |
| Outcome | Required to complete: interested, not interested, second viewing, offer expected, offer made. Feedback text optional, with the "no ID or bank numbers" help (#35) |
| Sharing with the landlord | `seller_feedback_shared` off by default; staff turn it on per viewing (§8) |
| After completion | Outcome and feedback cannot be changed; a correction is a note on the timeline (P6-D3) |
| Keys | "Keys out for this viewing" links a key check-out to the viewing; check-out to a contact checks contact scope (R7) |
| Links | From a lead (books the viewing and moves the lead to contacted), from a deal (moves an open deal to the viewing stage if earlier), or from the listing |

### 4.2 Screens, events and audit

- Screens (wireframes in P6-W): book viewing (dialog, full screen on mobile), viewing record with outcome form, agent calendar (day and week), listing viewings tab, "viewings needing feedback" on the CRM dashboard and My day (the panel hidden in Phase 4 and 5).
- Events: `viewing.booked`, `viewing.rescheduled`, `viewing.cancelled`, `viewing.completed` (outbox; reminders are delivered in Phase 12).
- Audit: every status change and outcome; attendee changes.

## 5. Offer workflow (SAL-03)

### 5.1 Life cycle

```text
submitted ──accept──▶ accepted ──withdraw (buyer) / fall through──▶ withdrawn
    ├──counter──▶ countered   (the counter-offer is a new offer with parent_offer_id)
    ├──reject──▶ rejected
    ├──withdraw──▶ withdrawn
    └──expires_at passes──▶ expired   (worker)
```

| Rule | Detail |
|---|---|
| Where | Every offer belongs to a deal and its listing. Recording the first offer moves the deal to negotiation if it is earlier |
| Terms | Amount, currency (the listing's), rent frequency for lettings, conditions, financing, expiry. Never edited: the database refuses it. A change is a counter-offer |
| Who records | `offer.manage` within scope (agents for their own deals) |
| Who accepts | `offer.accept`: company owner and sales managers. Agents record the offer and the seller's response but cannot mark it accepted (P6-D4) |
| One accepted offer | The database allows one accepted offer per listing. Accepting while another is accepted is refused with the existing offer named |
| Other open offers | When one is accepted, the others stay recorded and are shown as "listing under offer"; they are not rejected automatically (P6-D4) |
| On acceptance | In one transaction: offer accepted; deal to offer accepted; listing to reserved (P6-D5); milestones copied (§6.3); buyer identity checks started (P6-D6) |
| Accepted offer falls through | Status withdrawn with a reason; deal back to negotiation or closed lost; listing back to available with the reason |
| Seller identity | The #18 rule (owners verified) applies at publishing; offers do not repeat it |

### 5.2 Screens, events and audit

- Screens: record offer and counter-offer (dialog), offer history on the deal (chain with parent links, direction, amounts in the listing currency), offers tab on the listing, "offers awaiting response" on My day and the CRM dashboard.
- Events: `offer.submitted`, `offer.countered`, `offer.accepted`, `offer.rejected`, `offer.withdrawn`, `offer.expired`.
- Audit: every offer and status change, with the deal and listing.

## 6. Deal workflow (SAL-01, SAL-04 to SAL-07)

### 6.1 Stages (seeded, renamable per company)

| Sale | Letting | Stage class | Entry rule |
|---|---|---|---|
| Lead | Enquiry | lead | Created from a lead or directly |
| Qualification | Qualified | qualification | — |
| Viewing scheduled | Viewing scheduled | viewing | A viewing is booked |
| Negotiation | Application / terms | negotiation | An offer is recorded |
| Offer accepted | Terms agreed | offer_accepted | Only through accepting an offer |
| Contract stage | Lease signing | contract | Buyer identity verified where required (P6-D6) |
| Closed – won | Let agreed | closed_won | Sale: completion recorded, required milestones done. Letting: Phase 7 (P6-D2) |
| Closed – lost | Lost | closed_lost | From any open stage, with a reason code and optional notes |

| Rule | Detail |
|---|---|
| Moving stages | Through actions only (`advance`, `lose`, accept offer, complete), never a free edit (spec §1180). Each move is recorded in stage history with who and when |
| Owner and agents | One owner (responsible agent); reassignment is limited to members whose `deal.update` scope is office or all (managers), and is recorded (SAL-05). Co-agents with splits that add up to 100 % |
| Parties | Buyers or tenants, sellers or landlords (current owners proposed from ownership records), lawyers, lender, other agent |
| Stalled flag | Time in stage longer than the stage's `stall_after_days` |
| Forecast (SAL-07) | Σ expected value × probability (override or stage default) for open deals by expected close month, per currency, with the formula shown |
| Closed deals | Final. A won sale cannot be reopened; a lost deal can be copied into a new deal |

### 6.2 Completion (sale)

| Step | Effect |
|---|---|
| Record exchange | Sales transaction exchanged (contract signed date); deal to contract stage if earlier; listing to under contract |
| Record completion | Sales transaction completed (completion date); deal closed won; listing sold; required milestones must be done |
| Ownership transfer | Offered in the completion dialog, on by default: sellers' ownership records end the day before completion, buyers' start on completion day (P5-H rules), in the same transaction (P6-D8) |
| Fall-through | Sales transaction fallen through with a reason; deal closed lost; listing back to available |

### 6.3 Milestones (SAL-04)

Copied from the templates on acceptance, most specific first (company and jurisdiction, then platform), with due dates offset from the acceptance date in the property's time zone. Buyer and seller due-diligence milestones are completed automatically when the identity checks are verified; the others by a member with `deal.update`, with who and when. Required milestones block completion.

## 7. Lead conversion workflow

```text
Lead (new / contacted / qualified) ──convert──▶ Lead converted (final)  +  Deal (qualification)
```

| Rule | Detail |
|---|---|
| From | A lead in new, contacted or qualified status (the database already allows conversion only from these) |
| Who | `lead.update` on the lead and `deal.create` |
| Creates | One deal: type from the lead (buy → sale, rent → letting; other lead types do not convert, see below), primary contact = lead contact (added as buyer or tenant party), listing and unit from the lead if any, office and owner from the lead's assignee, source kept, expected value from the listing price |
| Stage | Qualification by default; viewing if a viewing is booked at the same time |
| Lead after | Status converted, `converted_deal_id` set, history kept; no further status changes |
| Requirements | The buyer's requirement stays on the contact; matches remain visible on the deal |
| Directly created deals | Allowed without a lead (walk-in, referral), with `deal.create` |
| Sell, let, valuation and management leads | Not converted to deals: they lead to an instruction and a listing for the owner (out of Phase 6 scope) |

Screens: "Convert to deal" on the lead record (dialog showing what will be created), and a link both ways between the lead and the deal.

## 8. Landlord visibility (#5)

Adopts the recommendation on #5, built on the landlord resolver from C4 (current ownership, in the property's time zone).

| What the landlord sees | Fields | Never shown |
|---|---|---|
| Offers on their listings | Amount, currency, rent frequency, conditions, financing, status, dates; buyer by name only | Buyer contact details, internal notes, other offers' parties beyond name |
| Deal progress | Stage name and milestone checklist (name, done or not, due date) | Activities, notes, commissions, fees, agents' splits, documents |
| Viewings on their listings | Date, time, type, outcome; feedback text only where `seller_feedback_shared` is on | Attendee identities, agent notes |

| Item | Proposal |
|---|---|
| Permissions | Migration adds `deal.view` and `viewing.view` with linked scope to the landlord role (`offer.view` linked exists) |
| Phase 6 delivers | The reduced API (separate DTOs, never the staff DTOs), its tests, and the staff-side preview extended (LL-1 "What this landlord could see" adds offers, deal progress and viewings) |
| Phase 7 delivers | The landlord portal screens using the same API |
| Joint owners | Each current owner sees the same reduced view |
| Ended ownership | Visibility ends with the ownership record (the end date is inclusive) |
| Tests | Field-level tests that the reduced DTOs carry nothing else; a landlord of another property sees nothing; ended owner sees nothing |

## 9. Decisions for approval

| # | Decision | Reason |
|---|---|---|
| P6-D1 | **#15 is milestone P6-0 and is completed, reported and approved before any deal, offer or viewing implementation begins** (direction of 12 November 2026) | §3 |
| P6-D2 | Phase 6 covers sale deals end to end and letting deals up to "terms agreed". Closing a letting deal as "let agreed" creates the lease and belongs to Phase 7 | Leases depend on #1–#3, #22 and #23 |
| P6-D3 | Viewing outcome and feedback are final once completed; corrections are timeline notes | Same as activities (D5) |
| P6-D4 | Only the company owner and sales managers record an offer as accepted (`offer.accept`); other open offers stay recorded and are flagged, not rejected automatically | Specification §11.2 note on Sales Manager approval; the seller may still prefer a later offer |
| P6-D5 | When a listing has a deal with an accepted offer, its status moves only through deal actions (accept → reserved, exchange → under contract, completion → sold, fall-through → available with reason). Listings without deals keep today's manual changes (ADR-004) | A listing cannot read "Sold" without a sale, or "Available" while under offer |
| P6-D6 | Moving a deal to contract requires every buyer party's identity to be verified when the existing jurisdiction rule `sales_kyc_required` applies (default true); "verified" as approved in H-D3 | Spec journey step 9; one definition across the product |
| P6-D7 | Milestones are copied on acceptance from the most specific template; required milestones block completion; identity milestones complete automatically | SAL-04 |
| P6-D8 | Completion offers the ownership transfer, on by default, in the same transaction | Spec journey step 11; keeps ownership records and landlord visibility correct |
| P6-D9 | Commission calculation and records (SAL-08, FIN-04) move to the finance phase; Phase 6 records agents and splits (SAL-05) and the forecast (SAL-07) | Commissions post money and depend on #13 |
| P6-D10 | Grant accountants `viewing.view` and `offer.view` (all) in P6-0, as the specification's permission table states; grant landlords `deal.view` and `viewing.view` (linked) with the reduced views in §8 in S4 | Spec §11.2; #5 |
| P6-D11 | Lead conversion as in §7; deals may also be created directly | §7 |
| P6-D12 | Erasure: blocked while the person is a party to an open deal or to a sale that is exchanged or completed (contractual record, like lease parties); otherwise Phase 6 free text is anonymised (R2) and offers keep their amounts | E6 rules; legal retention periods with #20 |
| P6-D13 | No new encrypted fields: offer amounts and financing are business data protected by role and scope; free-text fields carry the "no ID or bank numbers" help (#35) | ADR-007 classification |
| P6-D14 | Offer letters and contract documents wait for the documents module (Phase 10); reminders are written to the outbox and delivered in Phase 12; the agent calendar is in Phase 6 | SAL-02 calendar is Must; delivery channels are later |

## 10. Standards and data-protection impact

| Standard | How Phase 6 meets it |
|---|---|
| Tenant isolation | Row-level security already on every pipeline table; company-bound foreign keys; isolation tests per endpoint and in the browser sweep |
| Record scope | Deals, viewings and offers by the role's scope (all, office, own); agents see their own deals and the offers and viewings on them |
| Encryption | No new protected fields (P6-D13); deal parties show masked contact details as in C5; no protected value in lists, exports, logs or audit |
| Erasure and merge | P6-0 extends `app.erase_contact` to Phase 6 free text and adds the blockers in P6-D12; merge rules already exist (deals and parties repoint, offers keep history) |
| Audit integrity | Append-only stage history, offer chain, completed viewings and completed sales, enforced by guards (R4); every action audited and sent to the outbox |
| Accessibility | WCAG 2.2 AA; axe on every new screen in English and Arabic at desktop and 320 px; keyboard alternative to drag on the pipeline board (spec: "Move to…") |
| Localisation | English and Arabic for every string; amounts in the listing currency with the member's locale; times with the property's time zone |
| CI governance | Pull requests to `main` with the six required checks; milestone reports with CI runs; no merge with a red check |

## 11. Proposed milestones (after approval)

| Milestone | Content | Depends on |
|---|---|---|
| **P6-0** | **#15 for all history streams (§3.3); erasure coverage for viewing feedback, offer conditions, deal lost notes, stage-change notes and milestone notes (R2); erasure blocked for parties to active deals and recorded sales (P6-D12, R3); accountant `viewing.view` and `offer.view` aligned with the specification (P6-D10, R5); guards on the Phase 6 histories (R4). Milestone report and approval before S1** | Approval of this report |
| P6-W | Wireframes and verification for viewings, offers, deals, conversion, pipeline board, calendar and the landlord preview, in the format of `P5-CRM-WIREFRAMES.md` (design only; may run alongside P6-0) | Approval of this report |
| S1 | Viewings API: book, confirm, reschedule, cancel, complete, calendar; key check-out link (R7) | **P6-0 approved** |
| S2 | Offers API: record, counter, respond, accept, withdraw, expiry job | S1 |
| S3 | Deals API: conversion, stages, parties, agents, milestones, exchange, completion with ownership transfer, forecast | S2 |
| S4 | Landlord visibility (#5): reduced API and staff preview | S3 |
| S5 | Web screens to the approved wireframes | P6-W, S1–S4 |
| S6 | Pipeline board, dashboards and My day panels; performance and close-out | S5 |

Performance budgets proposed: API p95 under 1,000 ms with 20,000 open deals, 200,000 viewings and 100,000 offers in one company; pipeline board and calendar ready under 4,000 ms with at most 300 KB of script.

## 12. Risks

| Risk | Rating | Mitigation |
|---|---|---|
| Listing status rules change for listings with deals (P6-D5) | Medium | Only listings with an accepted offer are affected; existing listing tests kept; migration needs no data change (no deals exist) |
| #15 backfill on large append-only tables in production | Low now | No production data yet; backfill runs in P6-0 before launch |
| Letting deals stop before lease (P6-D2) | Low | Clear stage limit in the screens; Phase 7 completes them |
| Commission expectations (P6-D9) | Medium | Splits and forecast visible in Phase 6; commission records with finance |
| #6, #28 still open | High (launch) | No shared environment, as in Phase 5 |

## Approval

Awaiting product owner approval of this report and of P6-D1 to P6-D14. No Phase 6 implementation begins until then.
