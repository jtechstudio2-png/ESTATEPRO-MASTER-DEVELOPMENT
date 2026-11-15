# Phase 6 · P6-W · Wireframes: viewings, offers, deals, conversion, pipeline board, calendar, landlord preview

| | |
|---|---|
| Status | **For product-owner review.** Design only: no screen code has been written. S5 builds these screens after approval (readiness report §10: "S5 · Screens to the approved wireframes · after P6-W, S1–S4") |
| Builds on | Phase 3 design set (`docs/phase-3-ui-ux/`): shell, tokens, record page pattern (07 §1), tables, forms, filters, empty and error states, dashboards (06). Phase 4 and Phase 5 wireframe conventions (`docs/phase-4/M6-WIREFRAMES.md`, `docs/phase-5/P5-CRM-WIREFRAMES.md`). Those rules apply here and are not repeated |
| Backed by | The approved S1–S4 API (`apps/api/openapi.json`): viewings, offers, deals, lead conversion, landlord views. Two small gaps are marked **W-A1**, **W-A2** (verification report §3) |
| Companion | [P6-W Wireframe Verification Report](./P6-W-VERIFICATION.md) |

These are low-fidelity structural wireframes. They fix content, order, actions, permissions and states, not visual styling. Names, amounts and dates in the drawings are illustrative placeholders, not data, defaults or business rules.

## How to read this document

Each screen has a drawing and a specification block: **Purpose**, **Roles** (permission and scope; roles not listed never see it: navigation hidden, the API refuses direct calls), **Data** (endpoint), **Actions** (endpoint; permission), **States** (screen-specific; every screen also has the standard states of Phase 3 03 §8: loading, empty, filtered empty, validation error, permission denied, conflict 412, network failure, success), **Security**.

Role abbreviations: **Own** company owner · **Adm** office administrator · **SM** sales manager · **PM** property manager · **Ag** agent · **Acc** accountant. Landlords (portal) see none of these screens: their portal is Phase 7; staff see what a landlord could see through LP-1.

Approved rules these screens must show, not re-decide: stages move by actions only (S3-D3); acceptance by Own and SM only (P6-D4); contracts need verified buyers (P6-D6); completion needs required milestones (P6-D7); ownership transfer on by default (P6-D8); letting deals stop at "terms agreed" (P6-D2); one deal scope (S3-D2); listing status follows the deal (P6-D5, S3-D12).

## 1. Screen index

| ID | Screen | Device notes |
|---|---|---|
| **Shell** | | |
| SH-2 | Navigation: Sales section (Pipeline, Deals, Calendar, Viewings to follow up, Forecast) and quick create | desktop sidebar, tablet rail, mobile bottom bar |
| **Calendar and viewings** | | |
| V-1 | Viewing calendar (mine, team, chosen agents; week and day) | desktop week grid; tablet day + agenda; mobile agenda |
| V-2 | Book a viewing | dialog; full screen on mobile |
| V-3 | Viewing details: confirm, reschedule, cancel, keys | drawer; full screen on mobile |
| V-4 | Record outcome, no-show and feedback sharing | dialog; full screen on mobile |
| V-5 | Viewings to follow up (needing an outcome) | table; cards on mobile |
| **Offers** | | |
| O-1 | Negotiation: a deal's offers as a chain | panel in DL-3; listing tab (O-4) |
| O-2 | Record an offer; counter an offer | dialog |
| O-3 | Accept, reject, withdraw | dialogs |
| O-4 | Listing offers tab | tab in the listing record |
| **Deals and pipeline** | | |
| PB-1 | Pipeline board (columns by stage; keyboard "Move to") | desktop columns; tablet horizontal scroll; mobile stage list |
| DL-1 | Deals list (pipeline list) | table; cards on mobile |
| DL-2 | New deal (direct) | dialog; full screen on mobile |
| CV-1 | Convert a lead into a deal | dialog from the lead record |
| DL-3 | Deal record | record page |
| DL-4 | Move stage, reassign, agents and splits, parties | dialogs |
| DL-5 | Milestones panel | panel in DL-3 |
| DL-6 | Exchange contracts | dialog |
| DL-7 | Complete the sale (with ownership transfer) | dialog |
| DL-8 | Lose the deal | dialog |
| FC-1 | Forecast | page |
| **Landlord preview** | | |
| LP-1 | What this landlord could see: one listing | panel from LL-1 |
| **Panels on existing screens** | | |
| X-C2 | Contact record: Deals, Offers, Viewings panels (Phase 6 tags removed) | C-2 |
| X-L2 | Lead record: Convert and Book viewing | L-2, L-4 |
| X-L3 | Listing record: Viewings, Offers, Deals tabs | Phase 4 L-3 |
| **Mobile and tablet** | | |
| XV-1 | Today's viewings (agent, phone) | ≤ 767 px |
| XV-2 | Outcome straight after a viewing | ≤ 767 px |
| XD-1 | Deal on the phone (read, milestones, call) | ≤ 767 px |
| TV-1 | Tablet: calendar day with viewing drawer | 768–1023 px |

---

## 2. Shell

### SH-2 Sales navigation

```text
┌──────────────────┬───────────────────────────────────────────────┐
│ Dashboards       │                                               │
│ Contacts         │                                               │
│ Leads            │                                               │
│ Sales            │                                               │
│   Pipeline       │                                               │
│   Deals          │                                               │
│   Calendar       │                                               │
│   To follow up 3 │  ← viewings needing an outcome (mine)         │
│   Forecast       │                                               │
│ Properties …     │                                               │
└──────────────────┴───────────────────────────────────────────────┘
+ Create ▾ : … · New deal · Book viewing
Mobile bottom bar (agents): Today · Pipeline · Contacts · Leads · Menu
```

| | |
|---|---|
| Purpose | Reach the Phase 6 screens from the existing shell |
| Roles | Pipeline, Deals, Forecast: `deal.view` (Own, Adm, SM, PM, Ag, Acc). Calendar, To follow up: `viewing.view` (Own, Adm, SM, PM, Ag, Acc). New deal: `deal.create`. Book viewing: `viewing.manage` |
| Data | `GET /me/context` (permissions); badge: `GET /viewings?filter[needsOutcome]=true&filter[agentMembershipId]=me&limit=1` count of own items only |
| Security | Items are not rendered without the permission. The badge counts only the user's own viewings |

---

## 3. Calendar and viewings

### V-1 Viewing calendar

```text
┌ Calendar ───────────── [Mine | Team | Agents ▾]  ‹ 16–22 Nov 2026 › [Week|Day] [+ Book] ┐
│ Times in Africa/Accra (office) · Your time zone differs: shown in brackets               │
├────────┬──────────────┬──────────────┬──────────────┬──────────────┬─────────────────────┤
│        │ Mon 16       │ Tue 17       │ Wed 18       │ Thu 19       │ Fri 20 …            │
│ 09:00  │ ▌LST-…033    │              │ ▌LST-…041 ✓  │              │                     │
│        │  Osu 2-bed   │              │  confirmed   │              │                     │
│ 10:00  │  Yaw A. +1   │ ▌Open house  │              │ ⚠ same unit  │                     │
│ 11:00  │              │  LST-…052    │              │   at 11:00   │                     │
└────────┴──────────────┴──────────────┴──────────────┴──────────────┴─────────────────────┘
Legend: ▌scheduled ▌confirmed (✓)  ▌completed  — cancelled hidden (toggle "Show cancelled")
Day view: one column per chosen agent. Agenda (mobile): list by day.
```

| | |
|---|---|
| Purpose | See and plan viewings: one's own week, the team's, or chosen agents side by side |
| Roles | `viewing.view`: Ag (own: viewings they conduct, of their listings, leads and deals), SM, PM (office), Own, Adm, Acc (all). Team and Agents views for office or all scope only |
| Data | `GET /viewings?filter[scheduledStart][gte|lte]&filter[agentMembershipId]=…` (range = the week in the office time zone); agents: `GET /members?filter[permission]=viewing.manage` |
| Actions | Open (V-3); book (V-2, `viewing.manage`); click an empty slot to book at that time; switch week/day; show cancelled |
| States | Unit clash marker (`unitConflicts`, a warning only); "Times shown in the property's time zone" when it differs from the user's |
| Security | Only viewings in scope are drawn; a free slot does not reveal another agent's out-of-scope viewing (the API refuses an agent clash on booking, V-2) |

### V-2 Book a viewing

```text
┌ Book a viewing ─────────────────────────────── [Cancel] [Book] ┐
│ Listing*   [LST-…033 · Osu 2-bed ▾]   live listings only         │
│ For        (•) Lead [LEA-…120 ▾]  ( ) Deal [DEA-…019 ▾]  ( ) None │
│ Type       [In person ▾]   Agent [Me ▾] (managers: office agents) │
│ When*      [Tue 17 Nov] [10:00] – [10:30]   Africa/Accra          │
│ Attendees  [Yaw Adjei ✕] [+ Add contact]                          │
│ Meeting point [Gate by the mango tree           ]                 │
│ ⓘ Booking from a new lead marks it contacted; a deal at lead or   │
│   qualification moves to "Viewing scheduled".                     │
│ ⚠ Another viewing of this unit is booked 10:00–10:30 (warning)    │
└───────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Book a viewing from the calendar, a listing, a lead or a deal (prefilled from where it started) |
| Roles | `viewing.manage`: Ag (own; conducting it does not count, S1-D3), SM, PM (office), Own, Adm (all). Choosing another agent: office or all scope |
| Data | Listings `GET /listings?filter[status]=available,reserved,under_contract`; leads, deals, contacts from their lists in scope |
| Actions | `POST /viewings` |
| States | Field errors by code: `in-past`, `too-long`, `deal-closed`, `deal-listing-mismatch`, `not-allowed`; 409 when the agent is already booked (show the clash time, not the other viewing's details) |
| Security | Meeting point carries the "no ID or bank numbers" hint (#35) |

### V-3 Viewing details

```text
┌ Viewing · Tue 17 Nov 10:00–10:30 (Africa/Accra) ───────────── ✕ ┐
│ Scheduled · In person · Agent Ama Mensah                          │
│ LST-…033 Osu 2-bed · Unit Flat 1A    Lead LEA-…120 · Deal —       │
│ Attendees: Yaw Adjei (expected)                                   │
│ Meeting point: Gate by the mango tree                             │
│ Keys: none out for this viewing   [Check out keys]                │
│ ───────────────────────────────────────────────────────────────── │
│ [Confirm] [Reschedule] [Cancel…]          after start: [Outcome…] │
│ History: booked by Ama 14 Nov · rescheduled from Mon 16 09:00     │
└───────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Act on one viewing |
| Roles | View: `viewing.view` in scope. Actions: `viewing.manage` in scope |
| Data | `GET /viewings/{id}` |
| Actions | Confirm (`…/confirm`); reschedule (`…/reschedule`: new time, same attendees, opens the new viewing); cancel with a reason (`…/cancel`); check out keys (`…/keys/check-out`, to the agent or an attendee, due back an hour after, S1-D10); outcome (V-4) |
| States | Finished viewings are read-only (S-D4); reschedule refused when the new time clashes (409) |
| Security | All actions send `If-Match`; reasons stay on the record and timeline, not in audit |

### V-4 Outcome, no-show and feedback sharing

```text
┌ How did the viewing go? ───────────────────────── [Save] ┐
│ Outcome*  ( ) Interested ( ) Not interested ( ) Second viewing│
│           ( ) Offer expected ( ) Offer made                   │
│ Attended  [✓] Yaw Adjei   [ ] Efua Adjei (absent)              │
│ Feedback  [Loved the garden; worried about road noise      ]   │
│ [ ] Share this feedback with the landlord                      │
│ ── or ──  [Nobody came (no-show)…]                             │
└────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Record what happened, once the viewing has started (S1-D5) |
| Roles | `viewing.manage` in scope |
| Actions | `POST …/outcome`; `POST …/no-show` (with an optional note on the timeline); later `POST …/feedback-sharing` (the only change after completion) |
| States | Outcome and feedback are final once saved (P6-D3): the form says so before saving |
| Security | The sharing box is off by default; LP-1 shows the landlord sees shared feedback only |

### V-5 Viewings to follow up

```text
┌ Viewings to follow up (3) ─────────────────────── [Mine | Team] ┐
│ When            Listing        Agent   Attendees    Action       │
│ Mon 16 09:00    LST-…033 Osu   Ama     Yaw A.       [Outcome…]   │
│ Sat 14 15:00    LST-…041 Lab   Kojo    Efua B. +1   [Outcome…]   │
└──────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Close the loop on viewings that have happened but have no outcome |
| Roles | `viewing.view` in scope; actions `viewing.manage` |
| Data | `GET /viewings?filter[needsOutcome]=true` (+ `filter[agentMembershipId]=me` for Mine) |
| Actions | V-4 inline |

---

## 4. Offers

### O-1 Negotiation (offer chain)

```text
┌ Offers on DEA-…019 · LST-…033 ─────────────── [+ Record offer] ┐
│ ● GH₵ 440,000  from buyer Yaw Adjei · 14 Nov · ACCEPTED          │
│   Mortgage · "Mortgage in principle"                             │
│   └ answers ◦ GH₵ 450,000 from seller Kofi Owusu · COUNTERED     │
│        └ answers ◦ GH₵ 420,000 from buyer · COUNTERED            │
│ ◦ GH₵ 400,000  from buyer · 4 Nov · REJECTED                     │
│ ⓘ Another offer on this listing is accepted (shown on other deals)│
│ Actions on an open offer: [Counter] [Accept] [Reject] [Withdraw] │
└──────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Read the negotiation as a chain and act on the open offer |
| Roles | `offer.view` (deal scope, S2-D2); Acc reads all. Actions: `offer.manage`; Accept: `offer.accept` (Own all, SM office) |
| Data | `GET /offers?filter[dealId]=…&sort=submittedAt` (chain from `parentOfferId`, `counterOfferIds`; flags `canManage`, `canAccept`, `otherOfferAccepted`) |
| Actions | O-2, O-3 |
| States | Accept button absent without `offer.accept` (not disabled-and-unexplained: a note says who accepts); offer amounts never edited (a change is a counter-offer) |

### O-2 Record an offer; counter

```text
┌ Record an offer ─────────────────────────────── [Cancel] [Save] ┐
│ Direction  (•) From the buyer  ( ) From the seller               │
│ From*      [Yaw Adjei ▾]  buyer side: primary contact or buyers  │
│ Amount*    [GH₵] [440,000.00]   in the deal's currency            │
│ Rent       [Monthly ▾]  lettings only                             │
│ Financing  [Mortgage ▾]   Expires [16 Nov 17:00] (optional)       │
│ Conditions [Mortgage in principle                         ]       │
│ ⓘ Terms never change once saved; conditions are shared with the   │
│   landlord (LP-1). Do not type ID or bank numbers.                │
└───────────────────────────────────────────────────────────────────┘
Counter: same form, direction fixed to the other side; "answers GH₵ 450,000".
```

| | |
|---|---|
| Roles | `offer.manage` in deal scope |
| Actions | `POST /offers`; `POST /offers/{id}/counter` |
| States | Codes: `currency-mismatch`, `precision`, `positive`, `not-buyer-side`, `not-seller-side`, `deal-closed`, `deal-without-listing`, `in-past`; recording moves an early deal to negotiation (said in a note) |
| Security | S4-R4: the conditions hint says the landlord sees them |

### O-3 Accept, reject, withdraw

```text
┌ Accept GH₵ 440,000 from Yaw Adjei? ─────────── [Cancel] [Accept] ┐
│ • The deal moves to "Offer accepted" and its milestones are added.  │
│ • The listing LST-…033 becomes Reserved.                            │
│ • Identity checks are opened for buyers not yet verified.           │
│ • 2 other open offers on this listing stay open and are flagged.    │
└─────────────────────────────────────────────────────────────────────┘
Withdraw an accepted offer: reason* [                    ] → deal back to negotiation, listing available.
Reject / withdraw an open offer: reason (optional).
```

| | |
|---|---|
| Roles | Accept: `offer.accept`; others `offer.manage` |
| Actions | `POST …/accept`, `…/reject`, `…/withdraw` (all with `If-Match`) |
| States | 409 "another offer is accepted"; `listing-not-available` |

### O-4 Listing offers tab

```text
┌ LST-…033 · [Overview] [Viewings 6] [Offers 4] [Deals 2] … ┐
│ Status filter [Open ▾]                                       │
│ 14 Nov  GH₵ 440,000  Yaw Adjei   DEA-…019  Accepted          │
│ 12 Nov  GH₵ 430,000  Ama Boateng DEA-…021  Open  ⚑ other accepted│
└──────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `offer.view`; rows only for deals in scope |
| Data | `GET /offers?filter[listingId]=…` |

---

## 5. Deals and pipeline

### PB-1 Pipeline board

```text
┌ Pipeline ── [Sale | Letting]  Office [Osu ▾]  Owner [Anyone ▾ | Me]  [List view] [+ New deal] ┐
├─────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────────────┤
│ Lead 12     │ Qualification│ Viewing 7    │ Negotiation 5│ Offer acc. 2 │ Contract 1           │
│ GH₵1.2m     │ 9 · GH₵0.9m  │ GH₵0.8m      │ GH₵2.1m      │ GH₵0.9m      │ GH₵0.45m             │
│ weighted 60k│ weighted 90k │ weighted 160k│ weighted 840k│ weighted 630k│ weighted 383k        │
│ ⚠ 2 stalled │              │ ⚠ 1 stalled  │              │              │                      │
├─────────────┼──────────────┼──────────────┼──────────────┼──────────────┼──────────────────────┤
│┌───────────┐│┌────────────┐│              │              │              │                      │
││DEA-…019   │││DEA-…020    ││              │              │              │                      │
││Yaw Adjei  │││Ama B.      ││              │              │              │                      │
││LST-…033   │││GH₵450k     ││              │              │              │                      │
││Ama ·  ⚠9d │││ [Move to ▾]││              │              │              │                      │
│└───────────┘│└────────────┘│              │              │              │                      │
│ Load more   │              │              │              │              │                      │
└─────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────────────┘
Totals per currency; a company with two currencies shows two lines per column (never converted, S3-D14).
Letting board: "Terms agreed" is the last column (P6-D2).
```

| | |
|---|---|
| Purpose | See the open pipeline by stage and move early deals forward |
| Roles | `deal.view`: Ag (own or co-agent), SM, PM (office), Own, Adm, Acc (all, read only) |
| Data | Columns `GET /deals/pipeline?dealType=…&officeId=…&ownerMembershipId=…`; cards per column `GET /deals?filter[stageId]=…&limit=20` (load more by cursor) |
| Actions | Open (DL-3). **Move to** (menu on every card; drag and drop as a shortcut): only to the stages the API lists in `access.nextStages` (lead, qualification, viewing, negotiation); later columns are reached by their actions (accept, exchange, complete, lose), shown as a message when a card is dropped there |
| States | Stalled marker with days in stage; empty column text; letting board without Contract and Won |
| Accessibility | Every move is possible without dragging (WCAG 2.2 SC 2.5.7): "Move to" menu, keyboard focus order column by column, live-region announcement "DEA-…019 moved to Qualification". Columns are lists with headings and counts |
| Performance | Ready in under 4,000 ms with at most 300 KB of script (readiness §10): columns in one request, cards lazily per column |

### DL-1 Deals list

```text
┌ Deals ── Search reference or contact…  [Open ▾] [Sale ▾] [Stage ▾] [Owner ▾] [Stalled] [Close date ▾] ┐
│ Reference  Contact      Listing    Stage           Value      Weighted  Close    Owner   Updated    │
│ DEA-…019   Yaw Adjei    LST-…033   Offer accepted  GH₵440k    GH₵308k   Dec 26   Ama     today      │
│ DEA-…020   Ama Boateng  LST-…041   Qualification ⚠ GH₵450k    GH₵45k    —        Kojo    3 days     │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
Sorted by: Last updated ↓   Load more
```

| | |
|---|---|
| Roles | `deal.view` |
| Data | `GET /deals` with `q`, `filter[status|dealType|stageClass|stageId|officeId|ownerMembershipId|contactId|listingId|attention|expectedCloseDate]`, `sort` (updatedAt, createdAt, stageEnteredAt), cursor |
| Actions | Open; new deal (DL-2); switch to board |

### DL-2 New deal (direct)

```text
┌ New deal ──────────────────────────────────── [Cancel] [Create] ┐
│ Type*      (•) Sale ( ) Letting                                   │
│ Buyer*     [Yaw Adjei ▾]   (tenant for lettings)                  │
│ Listing    [LST-…033 ▾]  live sale listings; needed before offers │
│ Source     [Walk-in ▾]                                            │
│ Expected value [GH₵ 450,000.00] (from the listing) Close [Dec 26] │
│ Owner      [Me ▾]   managers: an agent they manage                │
└───────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `deal.create` (Ag own; SM office; Own, Adm all) |
| Actions | `POST /deals` |
| States | Codes: `type-mismatch`, `listing-not-live`, `not-allowed`, `currency-mismatch`, `unknown-code` |

### CV-1 Convert a lead

```text
┌ Convert LEA-…120 (Buy) to a deal ─────────── [Cancel] [Convert] ┐
│ Buyer       Yaw Adjei (from the lead)                            │
│ Listing     [LST-…033 ▾] (from the lead, can change)             │
│ Owner       Ama Mensah (assigned to the lead)                    │
│ Starts at   Viewing scheduled (a viewing is booked)              │
│ ⓘ The lead becomes "Converted" and keeps its history; its booked │
│   viewings of this listing join the deal. A lead converts once.  │
└──────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `lead.update` on the lead and `deal.create` |
| Actions | `POST /leads/{id}/convert` (If-Match: lead version); then open DL-3 |
| States | Not offered for sell, let, valuation and management leads (`not-convertible`); not for unqualified or lost leads (reopen first) |

### DL-3 Deal record

```text
┌ ‹ Deals  DEA-2026-000019 · Sale · Yaw Adjei · LST-…033          [Actions ▾] ┐
│ Lead ─ Qualification ─ Viewing ─ Negotiation ─ ● Offer accepted ─ Contract ─ Won│
│ In stage 3 days · Owner Ama Mensah · Osu office · Value GH₵440,000 (70 %)      │
├───────────────────────────────────────────────┬───────────────────────────────┤
│ [Overview] [Offers 4] [Viewings 2] [Milestones 9] [Timeline] [History]         │
│ Next step                                      │ Identity (P6-D6)               │
│ ⚠ 1 buyer not verified: Yaw Adjei › check      │ Required for contracts: Yes    │
│ [Exchange contracts] (disabled until verified) │ Yaw Adjei  ✕ not verified ›    │
│                                                │ Parties                        │
│ Accepted offer GH₵440,000 · Mortgage           │ Yaw Adjei · buyer · primary    │
│ Sale —                                         │ Efua Law · buyer's lawyer      │
│                                                │ [+ Add party]                  │
│ Milestones 2 of 9 · next: Title verified 5 Dec │ Agents and splits              │
│                                                │ Ama 60 % lister · Kojo 40 %    │
│                                                │ [Edit] (managers)              │
└────────────────────────────────────────────────┴───────────────────────────────┘
Actions ▾ : Move stage… · Reassign… · Exchange… · Complete… · Lose… (each only when allowed)
```

| | |
|---|---|
| Purpose | Everything about one deal and the next step it needs |
| Roles | `deal.view` in scope; Acc read only |
| Data | `GET /deals/{id}` (stage path, `access` flags, parties with `identityVerified` where the user may see identity, agents, milestones, stage and owner history, accepted offer, sale, `identity.unverifiedBuyerIds`); offers O-1; viewings `GET /viewings?filter[dealId]`; timeline **W-A2** |
| Actions | From `access`: `nextStages` (DL-4), `canReassign` (DL-4), `canExchange` (DL-6), `canComplete` (DL-7), `canLose` (DL-8), `canEdit` (edit value, close date, probability: `PATCH /deals/{id}`) |
| States | Closed deal: banner "Won 31 Jan 2027" or "Lost: Financing failed", every action hidden; letting deal at "Terms agreed": "Leases arrive in Phase 7" note instead of Exchange |
| Security | Identity shown only as verified / not verified, linked to the contact's Identity tab (which applies its own rules); never document numbers |

### DL-4 Move stage, reassign, agents and splits, parties

```text
Move stage:   To [Qualification ▾] (only allowed stages)  Note [       ]  [Move]
Reassign:     New owner [Kojo Asante ▾] (office agents)  Note [Covering leave]  [Reassign]
Agents:       Ama Mensah  [Lister ▾]   [60] %
              Kojo Asante [Co-agent ▾] [40] %   Total 100 % ✓   [+ Agent]  [Save]
Party:        Contact [Efua Law ▾]  Role [Buyer's lawyer ▾]  [Add]   · Remove (not the primary contact)
```

| | |
|---|---|
| Roles | Move, parties: `deal.update` in scope. Reassign, agents: managers (`deal.update` office or all, S3-D6) |
| Actions | `POST …/stage`, `…/reassign`, `PUT …/agents`, `POST …/parties`, `…/parties/remove` |
| States | Splits total shown live; `splits-total`, `not-allowed`, `out-of-scope`, `primary-contact`, 409 duplicate party |

### DL-5 Milestones panel

```text
┌ Milestones (from acceptance, Africa/Accra) ─────────────────────────────┐
│ ✓ Buyer due diligence complete    automatic · 15 Nov                     │
│ ○ Seller due diligence complete   automatic · waits for: Kofi Owusu ›    │
│ ○ Reservation deposit received    optional · due 21 Nov   [Done] [Edit]  │
│ ○ Title / ownership verified      required · due 5 Dec ⚠ overdue [Done] │
│ …                                                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `deal.update` in scope (after acceptance) |
| Actions | `POST …/milestones/{id}/complete` (notes optional); `PATCH …/milestones/{id}` (due date, notes) |
| States | Automatic (identity) milestones have no Done button (P6-D7); done is final |

### DL-6 Exchange contracts

```text
┌ Exchange contracts ───────────────────────── [Cancel] [Exchange] ┐
│ Agreed price   GH₵ 440,000 (the accepted offer)                    │
│ Signed on*     [14 Nov 2026]   Completion due [31 Jan 2027]        │
│ Agency fee     [GH₵ 13,200.00] (from the deal)                     │
│ Buyers verified ✓ Yaw Adjei                                        │
│ • The listing goes Under contract; the deal moves to Contract.     │
└────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `deal.update` in scope; sale deals at "Offer accepted" |
| Actions | `POST …/exchange` |
| States | One line per unverified buyer (`buyerIdentity.<id>`, `unverified`) with a link to their Identity tab; `future`, `before-contract` |

### DL-7 Complete the sale

```text
┌ Complete the sale ─────────────────────────── [Cancel] [Complete] ┐
│ Completed on*  [31 Jan 2027]   Title reference [LC/2026/0451]       │
│ Required milestones ✓ all done                                      │
│ [✓] Transfer ownership (recommended)                                │
│     Ends: Kofi Owusu (100 %, since 2020) on 30 Jan 2027             │
│     Starts: Yaw Adjei 100 % from 31 Jan 2027                        │
│ • The deal is won and the listing is sold (final).                  │
└─────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `deal.close`: Own, SM |
| Actions | `POST …/complete` |
| States | One line per open required milestone; `ownership-shared` explains the Ownership tab route and offers completing without the transfer; ownership preview drawn from `GET /properties/{id}/ownerships` |

### DL-8 Lose the deal

```text
┌ Lose DEA-…019? ───────────────────────────────── [Cancel] [Lose] ┐
│ Reason*  [Financing failed ▾]   Notes [Bank withdrew the offer ]  │
│ • The accepted offer and 1 open offer are withdrawn.               │
│ • The sale falls through (contracts were exchanged).               │
│ • The listing returns to Available. Closed deals do not reopen.    │
└────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `deal.close`: Own, SM |
| Actions | `POST …/lose` (reasons from `GET /picklists/lost_reason`) |

### FC-1 Forecast

```text
┌ Forecast ── [Sale | Letting]  From [Nov 2026] for [12 ▾] months  Office [All ▾]  Owner [Anyone ▾] ┐
│ Month      Deals   Expected       Weighted                                                       │
│ Overdue    3       GH₵ 1.1m       GH₵ 0.5m   ⚠ close date passed ›                                │
│ Nov 2026   4       GH₵ 1.8m       GH₵ 0.9m   ████████                                             │
│ Dec 2026   6       GH₵ 2.6m       GH₵ 1.3m   ████████████                                         │
│ No date    9       GH₵ 3.0m       GH₵ 0.4m   ›                                                    │
│ Per currency; never converted. Each row opens the deals list with that filter.                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `deal.view` (scoped totals only) |
| Data | `GET /deals/forecast?dealType&from&months&officeId&ownerMembershipId` |
| Accessibility | Bars are decorative; the table carries the values (no colour-only meaning) |

---

## 6. Landlord preview

### LP-1 What this landlord could see: one listing

```text
┌ LL-1 Kofi Owusu · Landlord view ── Listing [LST-…033 Osu 2-bed ▾] ──── Read only ┐
│ ⓘ Only what you may see yourself is shown; the landlord may see more.            │
│ Activity shown from 1 Jan 2020 (start of the ownership).                         │
│ Offers   GH₵ 440,000 · Yaw Adjei · Accepted · Mortgage · "Mortgage in principle" │
│          GH₵ 400,000 · Yaw Adjei · Rejected                                      │
│ Deal     Offer accepted · 2 of 9 milestones done (names, done, due dates)        │
│ Viewings 13 Nov 21:34 · In person · Completed · Interested · "Loved the garden"  │
│          12 Nov · Completed · Interested · (feedback not shared)                 │
│ Never shown to landlords: buyers' contact details, notes, fees and splits,        │
│ documents, other parties, attendees, unshared feedback, activity before the link │
└───────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Let staff check what a landlord would see before it is shown in the portal (Phase 7) |
| Roles | `contact.view` on the contact and `property.view` on the property; each section within the user's own offer, deal and viewing scope (S4-D7) |
| Data | Listing picker from `GET /contacts/{id}/portal-visibility-preview` (C4); one listing `GET /contacts/{id}/portal-visibility-preview/listings/{listingId}` |
| Security | Read only; each opening is audited (counts only). The "limited to your access" note shows whenever `limitedToYourAccess` is true |

---

## 7. Panels on existing screens

| ID | Where | Change |
|---|---|---|
| X-C2 | Contact record (C-2) | The "Phase 6" panels become live: Deals (`GET /deals?filter[contactId]`), Offers made (`GET /offers?filter[contactId]`), Viewings attended (`GET /viewings?filter[contactId]`); each by its own permission |
| X-L2 | Lead record (L-2, L-4) | "Convert to deal" (CV-1) for buy and rent leads; "Book viewing" (V-2 prefilled); the converted lead shows "Converted to DEA-…" linking to the deal (`convertedDealId`) |
| X-L3 | Listing record (Phase 4 L-3) | Tabs Viewings, Offers (O-4), Deals; status change dialog (L-6) shows the codes `listing-has-accepted-offer` and `listing-sale-exchanged` with the way forward (open the deal) |
| Search | Global search (S-3) | Deals by reference **W-A1** |

## 8. Mobile and tablet

| ID | Screen | Content |
|---|---|---|
| XV-1 | Today's viewings | Agenda for today and tomorrow; each row: time (property time zone), listing, attendee first names, Call and Directions buttons, Outcome after the start |
| XV-2 | Outcome after a viewing | V-4 as a full-screen form with large targets (≥ 44 px); saves offline-safe only when online (no offline queue in Phase 6) |
| XD-1 | Deal on the phone | DL-3 header, next step, milestones with Done, parties with Call; board replaced by a stage list with counts |
| TV-1 | Tablet day view | Calendar day column with the viewing drawer beside it |

## 9. Accessibility (WCAG 2.2 AA, ADR-002)

| Rule | Where |
|---|---|
| Dragging has a single-pointer and keyboard alternative (2.5.7) | PB-1 "Move to" menu on every card |
| Target size at least 24 × 24 px (2.5.8); 44 px on mobile | All, XV-1, XV-2 |
| Calendar as a grid with row and column headers; each viewing is a button with its full text (time, listing, status) | V-1 |
| Status never by colour alone (1.4.1): icon and word for stalled, overdue, accepted | PB-1, DL-1, DL-5, O-1 |
| Focus not obscured by sticky headers or drawers (2.4.11) | V-3, DL-3 |
| Live region for moves, saves and refusals | PB-1, DL-4 |
| Dialogs: focus trap, Escape closes, focus returns to the trigger | All dialogs |
| Every screen checked with axe in English and Arabic, at 320 px and desktop | S5 browser suite |

## 10. Localisation and right-to-left

| Rule | Where |
|---|---|
| Arabic: mirrored layout; the board's column order follows reading direction (first stage at the start side) | PB-1 |
| The stage path and arrows mirror; amounts and references stay left-to-right inside right-to-left text (bidi isolation) | DL-3, O-1 |
| Times in the property's time zone with its name; the user's own time in brackets when different | V-1 to V-5, DL-5 |
| Amounts in the deal's currency at its decimal places; totals per currency | everywhere |
| Every refusal code has a message in both languages; stage names are the company's own (not translated), stage classes are | all |

## 11. States per screen (beyond the standard set)

| Screen | State |
|---|---|
| V-1 | No agents in scope for Team; property time zone differs from the user's |
| V-2 | Agent clash (409) shows only the clashing time |
| O-3 | Second acceptance refused (409); listing withdrawn meanwhile |
| PB-1 | Dropped on an action column: message "Accept an offer to reach this stage" |
| DL-3 | Closed (won, lost); letting at terms agreed; buyer unverified |
| DL-7 | Shared whole-property ownership |
| LP-1 | Limited to your access; no activity since the link began |
