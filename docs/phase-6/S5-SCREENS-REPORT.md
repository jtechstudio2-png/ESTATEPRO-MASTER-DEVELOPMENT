# Phase 6 · Milestone report: S5 Screens

| | |
|---|---|
| Date | 15 November 2026 |
| Branch | `phase-6/readiness`, commits `bbd7905` (W-A1, W-A2) to `3dc42dc` and the report commit; CI: see §9 |
| Approvals | P6-W approved with W-D1 to W-D5; W-A1 and W-A2 approved for inclusion in S5; WR-1 to WR-4 reviewed and accepted (15 November 2026). "Proceed to S5 (Screens) using the approved wireframes. Before implementing the screens: 1. Close W-A1 (global deal search). 2. Close W-A2 (deal timeline read endpoint)." |
| Scope | The Phase 6 screens of the approved wireframes (`P6-W-WIREFRAMES.md`): Sales navigation (SH-2), viewings (V-1 to V-5), offers (O-1 to O-4), pipeline board, deals, lead conversion and forecast (PB-1, DL-1 to DL-8, CV-1, FC-1), the landlord preview (LP-1), panels on existing screens (X-C2, X-L2, X-L3, global search), and the phone and tablet scope (XV-1, XV-2, XD-1, TV-1, W-D4). The two API gaps W-A1 and W-A2 were closed first |
| Not in scope | Dashboards (S6), landlord portal screens (Phase 7), leases (Phase 7), any business rule: every rule stays in the API and database of S1 to S4 |
| Result | **S5 complete, awaiting approval.** Results in §3; CI in §9 |

## 1. Deliverables

### 1.1 API gaps closed before the screens (commit `bbd7905`)

| Gap | Change | Tests |
|---|---|---|
| W-A1 global deal search | `GET /search` gains a `deals` group: by reference or primary contact name, in the member's deal scope (`dealScopeSql`), with stage and status as context; `null` without `deal.view` | deals e2e (scope, other company, no permission) and workspace search tests |
| W-A2 deal timeline | `GET /api/v1/deals/{id}/activities` (`deal.view`): the activities linked to the deal (its system entries), after the deal scope check; `ActivityLinkDto` may now name a deal | deals e2e (own deal, out of scope 404, other company 404) |

OpenAPI and the web API types were regenerated.

### 1.2 Screens (web)

| Wireframe | Route or place | Notes |
|---|---|---|
| SH-2 | Sales section of the navigation; quick create "Deal" and "Viewing"; badge on "To follow up" | Items only with their permission; accountants see the read-only sales screens without the CRM items. The badge counts only the member's own viewings |
| PB-1 | `/pipeline` | Sale or letting; owner (Anyone or Me, for office or all scope); office. Totals per currency per column, stalled counts. **"Move to" menu on every card, drag as a shortcut (W-D1)**; each move reads the deal's current version and allowed stages; a later stage gets the message naming its action. Cards load per column, 20 at a time |
| DL-1 | `/deals` | Search, status, type, stage class, owner, office, stalled, close date range; sort; load more. Embedded on the contact and listing records |
| DL-2 | Dialog from the deals list, board, quick create or a contact | Opens the new deal |
| CV-1 | Lead record (buy and rent leads that are open and not converted) | Opens the new deal; the converted lead links to it |
| DL-3 | `/deals/{id}` | Stage path (letting without the contract step), next step, value and dates, identity (verified or not, linked to the Identity tab), parties with Call for the primary contact, agents and splits; tabs Offers, Viewings, Milestones, Timeline (read only, W-A2), History (stage and owner). Closed deals show a banner and no actions; letting at "Terms agreed" says leases come in Phase 7 |
| DL-4 | Move stage, reassign (managers), agents and splits (managers, live total), add and remove party | Only from the API's `access` flags |
| DL-5 | Milestones tab | Done (final) and edit; automatic identity milestones have no Done button |
| DL-6, DL-7, DL-8 | Exchange, complete (ownership transfer on by default), lose | Unverified buyers listed with links; open required milestones listed; `ownership-shared` offers completing without the transfer |
| FC-1 | `/forecast` | Overdue, each month, no date; per currency; each row opens the deals list with that filter; bars decorative |
| O-1 to O-3 | Deal record, Offers tab | Threads (answers under the offer they answer); counter, accept (consequences listed), reject, withdraw (reason required for an accepted offer); who accepts is said when the member cannot |
| O-4 | Listing record, Offers tab | Open and accepted, or closed |
| V-1 | `/calendar` | Own week in the member's time zone by default; Team for office or all scope; Day view with a column per agent; show cancelled; empty slots book at that time; same-unit clash marker |
| V-2 | Dialog from the calendar, quick create, a listing, a lead or a deal | Prefilled from where it started |
| V-3 | Drawer from any viewing | Confirm, reschedule, cancel, outcome, no-show, check out keys, share or stop sharing feedback |
| V-4, V-5 | `/viewings/follow-up`, and from V-3 | Outcome final once saved (said before saving); sharing off by default |
| LP-1 | Contact record, Properties tab | One listing at a time, generated once per choice (audited by the API), "limited to your access" note, what is never shown |
| X-C2 | Contact record, new Sales tab | Deals, Offers made, Viewings attended, each by its permission |
| X-L2 | Lead record | Convert to deal, Book viewing, "converted" link |
| X-L3 | Listing record, new tabs Viewings, Offers, Deals; status dialog | The refusals `listing-has-accepted-offer` and `listing-sale-exchanged` link to the listing's deals |
| Search | Global search | Deals group (W-A1) |
| XV-1, XV-2, XD-1, TV-1 | Phones (≤ 767 px) and tablets | Phones: today's and tomorrow's viewings as an agenda with Outcome; the board becomes a stage list with counts; the deal record keeps overview, milestones and timeline, without splits or completion (W-D4). Tablets get the full screens; on TV-1 the V-3 drawer opens over the day view rather than beside it |

Code: `apps/web/src/components/sales/` (16 files), six routes, the record tabs and panels above, the `sales` message namespace in English and Arabic.

## 2. Decisions taken in S5 (for approval)

| # | Decision | Reason | Status |
|---|---|---|---|
| S5-D1 | **Own viewings are filtered by the member's id.** The viewings API (S1) takes membership ids; the wireframes wrote `agentMembershipId=me`. The badge, the calendar's Mine view and V-5 send the session's own id | Found by the browser suite; no API change needed | For approval |
| S5-D2 | **One Sales tab on the contact record** holding the three X-C2 panels (Deals, Offers made, Viewings attended), not three tabs | Keeps the contact tab row short; each panel still follows its own permission | For approval |
| S5-D3 | **"Move to" lists every open column; the API decides.** On a choice the deal is read fresh (current version and `access.nextStages`): an allowed stage is moved to; an action stage gets "Accept an offer to reach …" (and the like); any other refusal is said. Drag and drop uses the same path | A stale card never moves on old data (`If-Match`); the board and the record share one rule | For approval |
| S5-D4 | **Times.** The calendar grid is drawn in the member's (office) time zone; a viewing of a property in another zone also shows its own local time in brackets. Booking and rescheduling take times in the member's zone, said on the form | The listing search does not carry the property's zone; an office and its properties normally share a zone | For approval |
| S5-D5 | **DL-7 ownership preview** names the buyers who become owners; the end of the current owners' records is not drawn, because the deal response does not carry the property. The API still checks the transfer and refuses `ownership-shared` with the way forward | No new API in S5 beyond W-A1 and W-A2 | For approval |
| S5-D6 | **XD-1 Call** for the primary contact only: the deal response carries no phone numbers for other parties | No new API; the parties link to their contact records | For approval |
| S5-D7 | **Empty calendar slots** are click targets kept out of the tab order; keyboard users book with "Book viewing" | A week has about 90 empty slots; each one a tab stop would make the grid unusable by keyboard | For approval |
| S5-D8 | **Scrolling regions** (the board, the calendar grid) are labelled regions that take keyboard focus | WCAG 2.1.1; found by axe on an empty board in Arabic | For approval |
| S5-D9 | **Button names contain their visible text**: "Move to · DEA-…", "Done · …", "Outcome… · …" | WCAG 2.5.3; found by axe | For approval |
| S5-D10 | **Phase 6 browser data is created by the Phase 6 specs** through the API (`e2e/support/sales-data.ts`): a villa owned by Ama, a live sale listing, a buyer, a deal with an offer, a past and an upcoming viewing. The shared seed is unchanged | The earlier specs check exact counts in the shared seed (properties, Osu Court's units, Ama's properties, the listing register); adding to it broke them | For approval |
| S5-D11 | **Leads spec L-3** retypes the contact search until it has hydrated. The test typed before the page had hydrated and failed in 2 of 4 runs on its own; 10 of 10 after the change. The screen is unchanged | A race in the test, more likely now that each page carries the Sales messages (S5-R1) | For approval |
| S5-D12 | **XV-1 agenda without Call and Directions.** The viewing response carries neither attendee phone numbers nor the property's coordinates; each row opens V-3, whose attendees link to their contact records (Call there) | No new API in S5; candidate for S6 if wanted | For approval |
| S5-D13 | **TV-1:** on tablets the V-3 drawer opens over the day view rather than beside it | The shared drawer component; side-by-side needs a layout of its own | For approval |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| API: deals e2e and workspace search (W-A1, W-A2) | 32 | ✅ |
| Web: typecheck, lint, message check (3,090 keys in both languages) | — | ✅ |
| Web unit tests, including `test/sales/sales-rules.test.ts` (board moves, split totals, calendar weeks and placement in a time zone, offer threads, forecast scale and month ends, Sales navigation by role) | 95 in 19 files | ✅ |
| Browser: `e2e/sales.spec.ts`: SH-2 and the badge; PB-1 "Move to"; DL-1; DL-3 tabs and read-only timeline; O-1 and O-3 accept with milestones and the unverified buyer; V-1 and V-3 confirm; V-5 and V-4 outcome; FC-1; X-L3 and LP-1 (no phone numbers shown); CV-1; W-A1; Arabic at 320 px and desktop (axe, `dir="rtl"`, no sideways scroll); phones (XD-1, XV-1). axe on every screen | 13 | ✅ |
| Browser: whole suite | 106 | ✅ (§9) |
| Browser: performance | 1 (27 screens) | ✅ (§6) |

Web logic coverage: 98.14 % statements, 91.41 % branches, 97.87 % functions, 99.40 % lines (thresholds 95/88/95/95).

### 3.1 Defects found and fixed during S5

| Defect | Found by | Fix |
|---|---|---|
| The badge, the calendar's Mine view and V-5 sent `me` to the viewings API, which takes ids: nothing was shown | Browser suite | S5-D1 |
| Three buttons' names did not contain their visible text | axe | S5-D9 |
| The board and calendar grid scroll sideways but could not be reached by keyboard when empty | axe (Arabic, empty board) | S5-D8 |
| Phase 6 seed data changed counts the earlier specs check | Whole browser suite | S5-D10 |
| The deal and contact timeline links did not know the `deal` link type | Typecheck after W-A2 | Deal links open the deal |

## 4. Security impact

| Control | Evidence |
|---|---|
| No rule in the browser: every action comes from the API's flags (`access`, `canManage`, `canAccept`) and every write sends `If-Match`; the API refuses anything else | Code review; browser tests (accept, confirm, outcome, convert) |
| Items and actions are not rendered without their permission; read-only companies see no write actions | Unit tests (navigation by role); browser tests |
| Deal search and the deal timeline stay in the member's deal scope (W-A1, W-A2) | API tests (out of scope 404, other company 404) |
| Identity shown only as verified or not, linked to the Identity tab; never document numbers | DL-3, DL-6 |
| LP-1 shows nothing the member may not see and says when the landlord may see more; no buyer phone numbers | Browser test (no `+233` in the preview) |
| Free-text fields carry the "no ID or bank numbers" hint; offer conditions say the landlord sees them (S4-R4) | O-2, V-2, V-4, DL-4, DL-5, DL-8 |
| Tenant isolation | Unchanged: every request goes through the BFF to the scoped API |

## 5. Compliance and audit impact

| Item | Effect |
|---|---|
| ADR-008 | Unchanged: the screens show what the API returns; no new stored data |
| Audit | LP-1 openings are audited by the API (S4); the preview is generated once per choice, never in the background |
| Erasure | Erased contacts show as the API returns them ("Erased contact") |
| Personal data | No personal data is kept in the browser beyond the query cache of the open session |

## 6. Performance

Budget (readiness §10): a screen shows its data within 4,000 ms with at most 300 KB of script (production build, cold cache).

| Screen | Data shown | LCP | Script |
|---|---|---|---|
| Pipeline board (PB-1) | 593 ms | 292 ms | 257 KB |
| Deals list (DL-1) | 365 ms | 332 ms | 257 KB |
| Deal record (DL-3) | 323 ms | 316 ms | 275 KB |
| Viewing calendar (V-1, team) | 352 ms | 304 ms | 255 KB |
| Viewings to follow up (V-5) | 224 ms | 300 ms | 254 KB |
| Forecast (FC-1) | 345 ms | 304 ms | 227 KB |
| The 21 earlier screens | 204–1,196 ms | 92–532 ms | 225–266 KB (maps 535–563 KB, own budget) |

## 7. Accessibility and localisation

| Rule (P6-W §9, §10) | Where |
|---|---|
| Every move without dragging (2.5.7) | PB-1 "Move to" menu; drag only a shortcut |
| Status by icon and word, never colour alone (1.4.1) | Stalled ⚠, overdue ⚠, accepted ✓, confirmed ✓, other offer accepted ⚑ |
| Calendar as a table with row (time) and column (day or agent) headers; each viewing a button with its time, listing and status | V-1 |
| Live announcements for moves, saves and refusals | All dialogs and the board |
| Dialogs trap focus, close on Escape and return focus | All dialogs and the V-3 drawer |
| Targets 24 px, 44 px for phone actions | All; XV-1 and V-5 |
| axe in English and Arabic at 320 px and desktop | Browser suite |
| Arabic: mirrored layout (logical CSS only, stylelint), the board's first stage at the start side, references and amounts isolated left to right | All |
| Amounts in their own currency, totals per currency, never converted | PB-1, DL-1, DL-3, FC-1, O-1 |
| Stage names are the company's own; stage classes, statuses and outcomes are translated | All |

## 8. Risks and open items (for review)

| # | Item | Rating | Status |
|---|---|---|---|
| S5-R1 | Every page receives every message namespace (the existing design); the `sales` namespace adds about 21 KB in English and 29 KB in Arabic, about 7 KB compressed | Low | Within the script budget (§6); split messages per route if pages grow |
| S5-R2 | Booking times are entered in the member's time zone (S5-D4); a company with offices in several zones books in the member's own | Low | Add the property's zone to the listing search if such companies appear |
| S5-R3 | The calendar loads 100 viewings per page, with "Load more" for busier weeks (large offices, team view) | Low | Measured with the seeded data; S6 dashboards add no load here |
| S5-R4 | Typing in a search field before the page has hydrated is not searched (S5-D11); a person who types within the first moment retypes | Low | Product fix (read the typed value on hydration) proposed for S6 |
| S5-R5 | One deal's offers load up to 100 at once (O-1) | Low | Deals with more offers are not expected; add paging if they appear |
| — | #42 (before Phase 7), #44 (before Phase 6 closes), #43 (backlog) | — | Unchanged |

## 9. GitHub references

| Reference | Link |
|---|---|
| P6-W wireframes and verification (approved) | `docs/phase-6/P6-W-WIREFRAMES.md`, `docs/phase-6/P6-W-VERIFICATION.md` |
| S1 to S4 reports (approved) | `docs/phase-6/S1-VIEWINGS-REPORT.md`, `S2-OFFERS-REPORT.md`, `S3-DEALS-REPORT.md`, `S4-LANDLORD-VISIBILITY-REPORT.md` |
| CI | CI_PENDING |

## Approval

| Item | Decision | Date |
|---|---|---|
| S5 (screens) | Awaiting approval | |
| S5-D1 to S5-D13 | Awaiting approval, each individually | |
| S5-R1 to S5-R5 | Awaiting review | |

Next, once approved: S6, per the approved Phase 6 roadmap.
