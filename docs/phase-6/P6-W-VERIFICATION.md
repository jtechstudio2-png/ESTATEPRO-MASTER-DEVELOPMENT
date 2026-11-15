# Phase 6 · P6-W · Wireframe Verification Report

| | |
|---|---|
| Status | **Approved** (product owner, 15 November 2026), together with the [wireframes](./P6-W-WIREFRAMES.md) |
| Scope | Checks the Phase 6 wireframes against the approved readiness report (§2.1, §4–§6, §9, §10), the approved S1–S4 decisions, the permission model (migrations 0014, 0030, 0034) and the S1–S4 API. Lists the API gaps and the decisions needed before S5 screen work starts |
| Result | **Ready for approval**, subject to five decisions (§5). Every in-scope requirement has a screen; two small API gaps (§3); no schema change; no business rule re-decided |
| Why now | The readiness report puts P6-W before S5 (§10) and risk R10 says "P6-W before any screen work". P6-W had not been produced, so S5 starts with it and stops for approval before any screen code |

## 1. Requirements coverage

### 1.1 Readiness report §2.1 (in scope)

| Area | What Phase 6 delivers | Screens |
|---|---|---|
| Viewings | Book, confirm, reschedule, cancel, outcome and feedback; agent calendar; conflict check; key check-out; "viewings needing feedback" | V-1 to V-5, XV-1, XV-2, TV-1 |
| Offers | Immutable chain; respond, accept, reject, withdraw; expiry; one accepted per listing | O-1 to O-4 |
| Deals | Stages through actions; parties and agents with splits; milestones; exchange and completion; ownership transfer; stalled flags; forecast; pipeline board and list | PB-1, DL-1 to DL-8, FC-1, XD-1 |
| Lead conversion | Buy or rent lead into one deal, keeping its history; direct deals | CV-1, DL-2, X-L2 |
| Landlord visibility (#5) | Staff-side preview (portal screens in Phase 7) | LP-1 |

### 1.2 Phase 1 sales requirements

| ID | Requirement | Screens | Coverage |
|---|---|---|---|
| SAL-01 | Deal stages; closed lost with a reason from any stage | PB-1, DL-3, DL-4, DL-8 | Full |
| SAL-02 | Viewings with attendees, agent, feedback, outcome; calendar; conflict detection | V-1 to V-5 | Full |
| SAL-03 | Offers with amount, conditions, status and history | O-1 to O-4 | Full |
| SAL-04 | Progression milestones after acceptance | DL-5, XD-1 | Full |
| SAL-05 | Agent assignment and reassignment with history; co-agent splits | DL-3, DL-4 | Full |
| SAL-06 | Pipeline board and list by stage, agent, branch; stalled flags | PB-1, DL-1 | Full |
| SAL-07 | Weighted forecast by expected close month | FC-1 | Full |
| SAL-08 | Commission on completion | — | Finance phase (P6-D9) |

### 1.3 Readiness §9 standards and §10 budgets

| Standard | Where in the wireframes |
|---|---|
| Keyboard alternative to dragging on the board | PB-1 "Move to", §9 |
| WCAG 2.2 AA, axe in English and Arabic at desktop and 320 px | §9 |
| English and Arabic; amounts in the listing currency; times with the property's time zone | §10 |
| Board and calendar ready under 4,000 ms with at most 300 KB of script | PB-1, V-1 (S5 performance test) |

## 2. Permission and scope verification

| Check | Result |
|---|---|
| Every action names its permission and matches the API's own check | ✅ |
| Accept only for `offer.accept` (Own, SM); the button is absent otherwise with a note | ✅ O-1, O-3 (P6-D4) |
| Completion and losing only for `deal.close` (Own, SM) | ✅ DL-7, DL-8 |
| Reassignment and splits only for managers | ✅ DL-4 (S3-D6) |
| Agents see deals they own or are credited on, and their offers and viewings | ✅ one deal scope (S3-D2) |
| Accountants read every deal, offer and viewing and act on none | ✅ action areas hidden |
| Counts and totals come only from scoped server queries | ✅ SH-2 badge, PB-1, FC-1 |
| Identity shown only as verified or not, within the user's identity-check scope | ✅ DL-3 (`identityVerified` null otherwise) |
| The landlord preview never shows staff more than they may see | ✅ LP-1 (S4-D7) |
| Landlords (portal) reach none of these screens | ✅ portal is Phase 7; only the two S4 portal endpoints are open to them |

## 3. API mapping and gaps

Every screen reads and writes through the approved S1–S4 endpoints, plus existing reference endpoints (`/me/context`, `/members?filter[permission]`, `/picklists/{key}`, `/properties/{id}/ownerships`). Two gaps:

| # | Gap | Needed by | Proposed fix | Status |
|---|---|---|---|---|
| W-A1 | Global search does not return deals | S-3 (global search) | Add a "Deals" group to `GET /search` (reference prefix and primary contact name), in deal scope | **Approved for S5** |
| W-A2 | The deal timeline is written (S3 links entries to the deal) but cannot be read | DL-3 Timeline tab | `GET /deals/{id}/activities`, same rules as the contact and lead timelines, in deal scope | **Approved for S5** |

Both are small, read-only, use existing data and indexes, and need no migration.

## 4. Schema gaps found

None. The screens need no new table or column.

## 5. Decisions needed before S5 screen work

| # | Decision | Proposal | Status |
|---|---|---|---|
| W-D1 | Board interaction | "Move to" menu on every card is the primary way; drag and drop is a shortcut to the same allowed stages; dropping on an action column explains which action reaches it | **Approved** |
| W-D2 | Where offers live | No separate Offers section: offers are worked in the deal (O-1) and listed on the listing (O-4) and contact (X-C2) | **Approved** |
| W-D3 | Calendar | Default: own week in the office time zone; Team and Agents views for office and company scope; cancelled viewings hidden by default | **Approved** |
| W-D4 | Mobile scope | Phones get Today's viewings, outcome after a viewing, deal read with milestones; the board, forecast, splits and completion are tablet and desktop only (on a phone: "Open on a larger screen", read only) | **Approved** |
| W-D5 | Gaps | Close W-A1 and W-A2 inside S5, before the screens that use them | **Approved** |

## 6. Risks found (reviewed and accepted 15 November 2026)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| WR-1 | A board with many deals per column loads slowly | Low | Columns from one summary request; cards per column lazily (20 at a time); measured in S5 against the 4,000 ms budget |
| WR-2 | Users expect dragging a card into "Offer accepted" or "Contract" to work | Low | W-D1 message names the action and links to it |
| WR-3 | Time-zone confusion for agents working across offices | Low | Property time zone named on every time; user's own time in brackets |
| WR-4 | Offer conditions typed with personal details are shown to landlords (S4-R4) | Low | O-2 hint says the landlord sees conditions |

## 7. Verification method

- Every screen traced to a readiness §2.1 item or SAL requirement (§1) and every action to a permission and endpoint (§2, §3).
- Each endpoint checked against `apps/api/openapi.json` as of `9cc1f09`.
- Approved rules (P6-D2 to P6-D8, S1–S4 decisions) drawn as given, not re-decided.
- Accessibility and right-to-left rules checked against ADR-002, Phase 3 04 and the Phase 4 and 5 browser suites.

## 8. Exit criteria for P6-W

1. Wireframes approved (with any changes recorded).
2. Decisions W-D1 to W-D5 recorded.
3. Gaps W-A1 and W-A2 accepted into S5.
4. Risks WR-1 to WR-4 reviewed.

Then S5 screen implementation starts.

## Approval

| Item | Decision | Date |
|---|---|---|
| P6-W wireframes and this verification report | **Approved** | 15 November 2026 |
| W-D1 to W-D5 | **Approved**, each individually | 15 November 2026 |
| W-A1 (global deal search), W-A2 (deal timeline) | **Approved for inclusion in S5**, closed before the screens | 15 November 2026 |
| WR-1 to WR-4 | Reviewed and accepted | 15 November 2026 |
