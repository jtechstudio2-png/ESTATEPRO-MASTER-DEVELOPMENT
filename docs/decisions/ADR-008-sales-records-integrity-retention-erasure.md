# ADR-008 — Sales records: history integrity, retention and erasure

| | |
|---|---|
| Status | **Proposed** (P6-0, 12 November 2026; reviewed 13 November 2026, §8; for approval with the P6-0 report) |
| Date | 12 November 2026 |
| Context | Phase 6 adds viewings, offers, deals, lead conversion and sales to the product. Their tables exist since migration 0007 and hold no data yet. Before any is written, the product owner asked for P6-0: deterministic history (#15), erasure of the pipeline's free text, limits on erasing parties to deals and sales, the accountant's access, and the audit, privacy, retention and integrity rules for sales records |
| Builds on | ADR-003 (API conventions), ADR-004 (listing rules), ADR-007 (field encryption, erasure §8), Phase 1 specification §5.4 (SAL), §7.1 (journey from instruction to completion), §11.2 (permissions), §12.2 (deal life cycle) |
| Implemented by | Migrations 0029 and 0030; `apps/api/src/common/list-query.ts`; the readers listed in `docs/phase-6/P6-0-IMPLEMENTATION.md` |

## 1. Decision summary

| ID | Decision |
|---|---|
| S-D1 | **Every history and audit stream has an insertion number** (`entry_no`), from a per-table sequence. Readers sort by (time, `entry_no`); history cursors carry `entry_no`; record lists keep their (sort value, id) cursors. This closes #15 for all 14 streams, including the sales histories before they hold data |
| S-D2 | **Deal stage history is written by the database** on every stage change (with the member and an optional note, used for that one change only) and is append-only. The application cannot insert, change or delete it |
| S-D3 | **Offers are a negotiation record**: terms never change; statuses move only submitted → countered / accepted / rejected / withdrawn / expired, and accepted → withdrawn; a counter-offer answers an open offer of the other side in the same deal; an offer is for its deal's listing and in its currency; one accepted offer per listing (migration 0007) |
| S-D4 | **Viewings are final when finished** (completed, cancelled, no-show, rescheduled): only the "share feedback with the landlord" choice may change afterwards. A cancellation needs a reason; a reschedule links the new viewing |
| S-D5 | **Milestones are final when completed**; what a milestone is never changes |
| S-D6 | **Sales transactions** move pending → exchanged → completed (or fall through or are rescinded); they record the accepted offer of their own deal and listing; price and terms are fixed once contracts are exchanged; recorded contract and completion dates are fixed |
| S-D7 | **Closed deals do not reopen** and keep their terms and close reason |
| S-D8 | **A lead converts to one deal**, which points back at it |
| S-D9 | **Nothing in the pipeline is deleted** by the runtime role (deals, stage history, offers, viewings, milestones, sales) |
| S-D10 | **Erasure** (ADR-007 §8) anonymises the pipeline's free text and keeps its facts (§3) |
| S-D11 | **A person cannot be erased** while a party to an open deal, or to a recorded sale that is open or completed within its retention period. The retention period is a jurisdiction rule; until legal review (#20) sets it, completed sales are kept and erasure stays blocked (fail closed) |
| S-D12 | **Accountants read deals, viewings and offers** across the company and change none of them (specification §11.2) |
| S-D13 | **No new encrypted fields**: offer amounts and financing are business data protected by role, scope and tenant isolation. Free text carries the "no ID or bank numbers" guidance (#35) |

## 2. History integrity (S-D1 to S-D9)

### 2.1 Why

PostgreSQL's `now()` is fixed for a transaction and UUIDv7 is ordered only to the millisecond. One sales action writes several rows at once: accepting an offer changes the offer, the deal stage, the listing status, and writes audit rows and outbox events. Ordered by (time, id), those rows can come back in any order, and the order can change between reads (#15).

### 2.2 Insertion order

| Stream | Time column | Readers |
|---|---|---|
| `audit_logs` (partitioned) | `occurred_at` | Listing history, property activity, erasure redaction |
| `outbox_events` | `occurred_at` | Delivery order (Phase 12); index on unpublished events by `entry_no` |
| `listing_status_history`, `listing_price_history` | `changed_at` | Listing status and price history |
| `key_movements` | `occurred_at` | Key set movements |
| `lead_status_history`, `lead_assignments` | `changed_at`, `assigned_at` | Lead record |
| `data_subject_request_events`, `…_evidence` | `occurred_at`, `recorded_at` | Privacy request record |
| `consents` | `captured_at` | Consent in force (latest per purpose and channel), consent history, exports, access report |
| `kyc_checks` | `created_at` | Latest identity check (owner identity, sellers view), check history, access report |
| `deal_stage_history`, `offers` | `changed_at`, `submitted_at` | Phase 6 |
| `activities` | `occurred_at` | Timeline (since migration 0024) |

Existing rows were numbered in the order users saw them (time, then id), so nothing reorders on upgrade. The number never changes once written (a trigger on every stream refuses it, whatever the role). Each sequence is granted (`USAGE`) to every role that may insert into its table, read from the table's grants at migration time, so a role that writes a stream (for example `estatepro_auth`, which writes sign-in audit rows) can always number its rows. Cursors issued before #15 on a history endpoint are refused with a validation error asking for the first page.

### 2.3 Guards

Guards are database triggers, so every path (API, worker, CLI, future integrations) obeys them. The runtime role's `DELETE` is revoked on the pipeline tables; its `INSERT` and `UPDATE` are revoked on deal stage history. Only an erasure (ADR-007 §8, `app.erasure_in_progress()`, which a runtime role cannot fake) may replace free text, and only with `[Erased]`.

## 3. Erasure (S-D10)

| Record | Anonymised | Kept |
|---|---|---|
| Viewings of the person (attendee, or on their lead or deal) | Feedback, cancellation reason, meeting point | Listing, unit, agent, times, status, outcome, sharing choice |
| Offers made by the person, and every offer on their deals (including the other side's counter-offers) | Conditions | Amount, currency, direction, status, dates, chain |
| Deals where the person is primary contact, a party, or whose lead was theirs | Lost notes, custom fields | Type, stage, values, dates, close reason code |
| Stage history of those deals | Notes | Stages, who, when |
| Milestones of those deals | Notes | Code, due and completion dates |
| Sales of those deals | Fall-through reason | Price, status, dates, references |
| Audit rows and outbox events of all of these | Values (`app.redact_json`) | Action, entity, field names, time |

The erasure ledger (ADR-007 §8) records the erasure as before, so a restore cannot bring the text back.

**Scope is the whole deal, on purpose.** Free text on a deal is about its parties together: a seller's counter-offer conditions usually name or describe the buyer ("subject to the buyer's mortgage with …"), and a stage note may record what either party said. The erasure cannot tell whose personal data a sentence holds, so it anonymises all free text on the deals the person was a party to, including the other side's counter-offer conditions and the deal's custom fields. The other parties lose free text, never facts: amounts, dates, stages, statuses and the offer chain stay. A party who needs a record of their own words keeps it in their documents (Phase 10).

## 4. Erasure blockers and retention (S-D11)

| Code | When | Why |
|---|---|---|
| `open_deal` | The person is the primary contact or a party of a deal whose status is open (and not archived) | The deal still needs them; close or lose it first |
| `sale_record` | The person is the primary contact or a party of a deal with a sale that is pending or exchanged, or completed less than the jurisdiction's `sales_records_retention_years` ago, or completed where no value is set | Contract, tax and anti-money-laundering record keeping |

Retention is a jurisdiction rule (`sales_records_retention_years`, integer, no default), resolved for the property's jurisdiction and its parent, effective-dated, like every other country rule. No value is set by this ADR. Commonly cited record-keeping periods are five years (UK and Ghana anti-money-laundering regimes) and ten years (Qatar). These are indications only: values are set only after the legal review (#20). Until then a completed sale keeps its parties.

Lost and closed deals without a sale do not block erasure; their free text is anonymised.

## 5. Audit and privacy of sales records

| Concern | Rule |
|---|---|
| Audit actions (S1–S3) | `viewing.booked`, `.confirmed`, `.rescheduled`, `.cancelled`, `.completed`, `.feedback_shared`; `offer.submitted`, `.countered`, `.accepted`, `.rejected`, `.withdrawn`, `.expired`; `deal.created`, `.stage_changed`, `.reassigned`, `.party_added`, `.party_removed`, `.milestone_completed`, `.lost`, `.won`; `lead.converted`; `sale.recorded`, `.exchanged`, `.completed`, `.fallen_through`. Ids and codes in metadata; free text only in the record itself |
| Outbox | The same events, ordered by `entry_no` |
| Who sees what | Agents: their own deals and the offers and viewings on them. Managers: their office. Accountants: read all (S-D12). Landlords: the reduced views of #5 (Phase 6 S4, portal in Phase 7) |
| Personal data in sales records | Names and contact details come from contacts (masked as in C5); deal parties are links, not copies; offers and viewings hold no contact details |
| Access requests (G3) | The access report will include the person's deals, offers and viewings when S1–S3 add them (the report reads the same tables) |

## 6. Options considered

| Option | Outcome |
|---|---|
| `clock_timestamp()` instead of `now()` for history times | Rejected: clock steps and equal microseconds still tie; does not fix existing rows; changes the meaning of "time of the action" |
| One global sequence for all streams | Rejected: one hot sequence; per-table sequences give the same guarantee within each stream |
| `GENERATED ALWAYS AS IDENTITY` | Not used: adding it numbers existing rows in physical order, not visible order, and partitioned tables in PostgreSQL 16 do not support identity columns |
| Stage history written by the application | Rejected: every code path would have to remember; the database guarantees it |
| Retention blocker only for completed sales, with a default period | Rejected: a default is a legal value; fail closed until #20 |
| Delete pipeline records after erasure | Rejected: sales and offers are contractual and financial records; anonymise text instead |

## 7. Consequences

- Phase 6 code writes stage changes by updating `deals.stage_id` (with `app.stage_note` set when there is a note) and never inserts stage history itself.
- New history tables in later phases add `entry_no` from the start and use `toEntryPage` and `keysetEntryCondition`.
- Migrations that change a history table's rows must run as a maintenance role (they disable guards only inside the migration).
- Until #20 sets retention values, people who bought or sold through a company cannot be erased in that jurisdiction; the privacy request shows the reason.
- Code that sets `app.stage_note` must set it immediately before the stage update it belongs to; the trigger clears it after use.
- A future outbox relay polls unpublished events by `entry_no` (the index `outbox_events_unpublished_idx` is on it).

## 8. Review (13 November 2026)

The P6-0 review read migrations 0029 and 0030 line by line against migration 0007 (pipeline tables), 0013 (sign-in audit) and 0026 (erasure), and checked every claim in this ADR.

| # | Finding | Outcome |
|---|---|---|
| 1 | Migration 0029 granted the new sequences to `estatepro_app` and `estatepro_platform` only. `estatepro_auth` inserts into `audit_logs` (sign-in events, migration 0013) and would fail with "permission denied for sequence" | **Fixed** (`bc94bae`): grants follow the table's INSERT grants; SQL test checks every inserting role has `USAGE` on its stream's sequence |
| 2 | `app.stage_note` stayed set for the rest of the transaction, so a second stage change in the same transaction repeated the first note | **Fixed** (`bc94bae`): the trigger clears it after use; SQL test |
| 2a | The runtime roles may update `consents`, `listing_status_history`, `listing_price_history` and `outbox_events` (no update guard), so `entry_no` could be changed and the history reordered; on consents, an older grant could become the consent in force | **Fixed**: a trigger on all 14 streams refuses any change to `entry_no`; SQL tests |
| 3 | Erasing one party anonymises the other side's counter-offer conditions on the same deal | **Kept, documented** (§3): deliberate and conservative |
| 4 | Guards compare with `<>`, which passes on a missing row (NULL). Checked: every reference they read (`deal_id`, `parent_offer_id`, `accepted_offer_id`, `listing_id`) has a foreign key that includes `company_id`, checked after the trigger, so a missing or other-company row is still refused | No change |
| 5 | The `sale_record` blocker joins `units` with an inner join; a sale with no unit would be missed. Checked: `sales_transactions.unit_id` is NOT NULL | No change |
| 6 | Every free-text column in the pipeline (`deals.lost_notes`, `deals.custom_fields`, `deal_stage_history.note`, `deal_milestones.notes`, `offers.conditions`, `viewings.feedback`, `.cancelled_reason`, `.meeting_point`, `sales_transactions.fallen_through_reason`) is anonymised; the remaining text columns are codes, statuses or references | Coverage complete |
| 7 | §6: "partitioned tables in PostgreSQL 16 do not support identity columns" | Confirmed on PostgreSQL 16 (adding an identity column to `audit_logs` is refused) |
| 8 | An offer on a deal with no listing (a unit-only deal) is not checked against a listing | Recorded for S2: the offer service will refuse an offer on a deal that has no listing yet (risk R6 in the P6-0 report) |
