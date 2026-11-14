# Phase 6 · Milestone report: S4 Landlord visibility (#5)

| | |
|---|---|
| Date | 14 November 2026 |
| Branch | `phase-6/readiness`, commits `c035988` (implementation) and the report commit; CI pending |
| Approvals | S3 approved with S3-D1 to S3-D16; S3 risks reviewed and accepted (14 November 2026). "Proceed to S4 (Landlord Visibility) according to the approved Phase 6 roadmap" |
| Scope | Landlord visibility as approved in the readiness report (§2.1, §6; P6-D10; issue #5): reduced, read-only views of offers, deal progress and viewings on the landlord's own listings; the reduced API, its field-level tests, and the staff-side preview ("What this landlord could see", LL-1) |
| Not in scope | Landlord portal screens and landlord sign-up (Phase 7), the staff preview screen (S5, to the P6-W wireframes), dashboards (S6) |
| Result | **S4 complete**, for approval before S5. Results in §3; CI pending (§9) |

## 1. Deliverables

### 1.1 Database (migration 0034)

| Item | Detail |
|---|---|
| Permissions (P6-D10) | The landlord role reads deals and viewings with the linked scope (offer.view linked since migration 0014). No write permission is added |
| `app.landlord_listing_access(contact)` | Each listing a landlord may see, with the day their current link to its unit began. Built on the C4 resolver (`app.landlord_unit_access`: current ownership or active management agreement, in the property's time zone), so the portal and the staff preview read the same thing. Archived listings are left out |

### 1.2 API

| Endpoint | Purpose | Who |
|---|---|---|
| `GET /api/v1/portal/landlord/listings` | The landlord's listings: reference, title, type, status, property, unit, the day activity is shown from, and counts of open offers, upcoming viewings and open deals | Landlord portal accounts (`listing.view` linked) |
| `GET /api/v1/portal/landlord/listings/{id}` | One listing's offers, deal progress and viewings, in reduced form | Landlord portal accounts |
| `GET /api/v1/contacts/{id}/portal-visibility-preview/listings/{id}` | Staff preview of what that landlord could see on the listing (LL-1), limited to what the staff member may see; audited | Staff (`contact.view`, `property.view`) |

What each view holds (readiness §6):

| View | Shown | Never shown |
|---|---|---|
| Offers | Amount and currency, rent frequency, conditions, financing, status, direction, submitted, expiry and response times, the offer it answers; the buyer **by name only** | Contact ids and details, who recorded it, agents' notes |
| Deal progress | Stage name (and its class code), status; milestone checklist: name, done or not, due date | Reference, value, fees, commission, agents and splits, parties, activities, notes, documents |
| Viewings | Date and time with the property's time zone, type, status, outcome once completed; feedback **only where the agent shared it** | Attendees, agent, meeting point, cancellation reason, unshared feedback |

Portal access: the auth guard keeps every endpoint for company staff only, as before; the two portal endpoints opt in with `@PortalEndpoint()` (new). Staff calling the portal endpoints get 403.

## 2. Decisions taken in S4 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| S4-D1 | **Boundary.** S4 delivers the reduced API, its tests and the staff preview API; the landlord portal screens and landlord accounts are Phase 7; the preview screen follows the P6-W wireframes in S5 | Readiness §6 "Phase 6 delivers / Phase 7 delivers"; §10 |
| S4-D2 | **Who is a landlord** of a listing is the C4 resolver: a contact with a current ownership record, or an active management agreement, covering the unit, judged in the property's time zone. Joint owners each see the same view; visibility ends with the record | One rule for staff preview and portal (C4); readiness §6 joint owners and end of ownership |
| S4-D3 | **From when.** A landlord sees activity from the day their current link to the unit began (the earliest current record): offers by submission day, viewings by scheduled day, deals by the day they were opened, in the property's time zone. A buyer who becomes the owner on completion sees nothing of the sale they bought through; a co-owner added later sees activity from their own start | Without it, a new owner would read other bidders' names and amounts |
| S4-D4 | **Reduced views built for landlords**, never staff responses with fields hidden: the fields of §1.2 only. Beyond the readiness list they also hold the offer's direction and the offer it answers (to read the negotiation), the viewing's status (a cancelled or no-show viewing is not left looking live; superseded "rescheduled" ones are left out) and the deal's status and stage class code (for translation) | Readiness §6 "separate views" |
| S4-D5 | **Portal accounts only.** The landlord views need a portal membership linked to a contact with the linked scope. Every other endpoint stays closed to portal accounts (the guard's existing rule); endpoints for portal accounts opt in explicitly with `@PortalEndpoint()` | Fail closed; no staff endpoint becomes reachable by accident |
| S4-D6 | **Permissions.** Landlords gain `deal.view` and `viewing.view` with the linked scope (P6-D10) and change nothing; in staff endpoints the linked scope still matches nothing | P6-D10 |
| S4-D7 | **Staff preview per listing.** It needs the contact (`contact.view`) and the property (`property.view`) in the staff member's scope; each section is limited to their own offer, deal and viewing scope, and `limitedToYourAccess` says when the landlord may see more. It is read-only and audited (`contact.portal_preview` with the listing and counts, no content) | Same rule as the C4 preview; a preview never shows staff more than they may see |
| S4-D8 | **Limits.** One listing's view returns the newest 500 offers, 500 viewings and 100 deals; no paging in S4 | Enough for a listing; the portal (Phase 7) can add paging |
| S4-D9 | **Audit.** A landlord's own reads are not audited (as staff reads are not); the staff preview is | ADR-008 §5; C4 practice |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `database/tests/16_landlord_visibility_s4.sql` (linked permissions, no write permissions; the owner's listings from their start; nothing for non-owners; a co-owner of one unit from their own start; future and ended ownership; archived listings; isolation) | 8 assertions | ✅ |
| All SQL suites (`database/scripts/verify.sh`) | 17 files, 34 migrations | ✅ |
| `api/test/landlord-visibility.e2e.test.ts` (listings with counts; offers, deal progress and viewings field by field, exact keys; nothing of the buyer's contact details, ids, unshared feedback, meeting point, cancellation reason, fee, agent or deal reference; joint owner from their own start; ended ownership; other property; staff blocked from portal endpoints and portal accounts from staff endpoints; preview equal to the landlord's view for the company owner, limited for an agent, audited; other company) | 4 | ✅ |
| Full API suite (`test:ci`) | 555 in 45 files | ✅ |
| API performance: landlord views | 1 | ✅ (§6) |
| Web: typecheck, lint, message check (2,572 keys in both languages), unit tests | 79 | ✅ |
| Browser suite (CI) | 93 | Pending |

API coverage: 96.18 % statements, 90.63 % branches, 98.42 % functions, 98.33 % lines (thresholds 95/90). Landlord module: 97.2 % statements, 100 % lines.

### 3.1 Defects found and fixed during S4

| Defect | Found by | Fix |
|---|---|---|
| The auth guard (rightly) refused portal accounts on every endpoint, so the landlord views could not be reached | S4 API test | Explicit `@PortalEndpoint()` opt-in for the two portal endpoints; all others unchanged |

## 4. Security impact

| Control | Evidence |
|---|---|
| A landlord sees only listings of units they currently own or manage, from their start | SQL suite 16; API tests (co-owner, ended ownership, other property) |
| Reduced fields only; buyer by name only; no contact details, ids, notes, fees or attendees | API test (exact keys and absence of each value) |
| Portal accounts reach only the portal endpoints; staff cannot use them | API tests (403 both ways) |
| Landlords change nothing (no write permission) | SQL suite 16; API test (recording an offer refused) |
| The staff preview never shows more than the staff member may see | API test (agent not on the deal sees empty sections) |
| Tenant isolation | SQL suite 16; API test (other company 404) |

No new protected fields (P6-D13).

## 5. Compliance and audit impact

| Item | Effect |
|---|---|
| ADR-008 | Landlords get the reduced views of §5 ("Landlords: the reduced views of #5"); nothing new is stored |
| Erasure | Nothing new to erase: the views read the pipeline tables, so an erased buyer shows as "Erased contact" with conditions and feedback "[Erased]" |
| Access requests (G3) | Unchanged: the views hold no data of their own |
| Audit | `contact.portal_preview` now also records previews of one listing (listing id and section counts, no content) |
| Personal data | Buyers appear to landlords by name only; viewing attendees never |

## 6. Performance

Budget (readiness report §10): API p95 under 1,000 ms.

| Measure | Result |
|---|---|
| Data | 4,000 properties with owners (the landlord owns 40), 20,000 open deals, 100,000 offers, 100,000 viewings |
| All requests (16) | median 22 ms, **p95 134 ms** |
| The landlord's listings with counts (40) / one listing's view / staff preview | 134 / 20 / 27 ms (max) |
| Migration 0034 | Two permission rows and one function; no data rewritten |

## 7. Accessibility and localisation

S4 adds no screens (S4-D1). The views carry codes for translated screens (status, stage class, viewing type, outcome, `notShown` codes); amounts come with their currency at its decimal places; times come with the property's time zone. Message files unchanged (2,572 keys in each language, checked).

## 8. Risks and open items

| # | Item | Rating | Status |
|---|---|---|---|
| S4-R1 | No paging on one listing's view (S4-D8) | Low | Phase 7 portal adds paging if needed |
| S4-R2 | Landlords linked by a management agreement see sale activity on their units too (C4 resolver) | Low | As the C4 preview; reconsider with lettings in Phase 7 |
| S4-R3 | Landlord accounts are not yet invited or onboarded (portal sign-up is Phase 7); tested with portal memberships made directly | — | Phase 7 |
| S4-R4 | Offer conditions are shown to landlords as typed; staff could type a buyer's personal details there | Low | Field guidance "no ID or bank numbers" (#35); S5 screens say conditions are shared with the landlord |
| — | #42 (before Phase 7), #44 (before Phase 6 closes), #43 (backlog) | — | Unchanged |

## 9. GitHub references

| Reference | Link |
|---|---|
| Phase 6 readiness report (approved) | `docs/phase-6/PHASE-6-READINESS-REPORT.md` |
| S1, S2 and S3 reports (approved) | `docs/phase-6/S1-VIEWINGS-REPORT.md`, `S2-OFFERS-REPORT.md`, `S3-DEALS-REPORT.md` |
| Issue #5 (landlord visibility) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/5 |
| Issues #42, #43, #44 | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/42 · /43 · /44 |
| CI run (pending) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions |

## Approval

Awaiting product owner approval of S4 (S4-D1 to S4-D9) before S5 (screens) begins.
