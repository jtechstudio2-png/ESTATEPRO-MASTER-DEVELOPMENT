# Phase 4 · Milestone 6 · Web Interface Verification Report

| | |
|---|---|
| Status | For product-owner review. No UI code has been written. |
| Scope | Milestone 6 of Phase 4: the staff web interface for the Property Management Module (Milestones 1–5), and the property dashboard |
| Wireframes | [M6-WIREFRAMES.md](./M6-WIREFRAMES.md) — issue #7 and every other missing Milestone 6 screen (51 screens). Each screen there has purpose, roles, data, actions, dependencies and security. |
| Branch | `phase-4/property-management` at `83df360` (audit branch `audit/pre-phase-4` remains unmerged) |
| Sources checked | Phase 3 design set (`docs/phase-3-ui-ux/` 01–07); Phase 1 detailed specification (P1-D) §5.2 PRP-01 to PRP-10, §9 stack, §11.2 permission matrix; ADR-001 to ADR-006; the M3, M4 and M5 verification reports; `apps/api/openapi.json`; seeded roles and permissions (migrations 0014, 0017, 0019) |

## 0. Summary

Phase 3 defined the shell, design tokens, record page pattern, table, form, filter and state rules, six dashboards and 13 wireframes. Those foundations hold and are reused unchanged. What Phase 3 could not cover is what Milestones 2–5 actually built:
- the gallery and floor-plan manager;
- uploads and their processing states;
- the listing gallery;
- maps and the location picker;
- notes with audiences and history;
- the key register;
- storage and listing settings;
- publishing blockers as they are really computed.

This review found:

- **45 missing screens.** Each one is now wireframed in [M6-WIREFRAMES.md](./M6-WIREFRAMES.md). Six more Phase 3 screens are re-specified there for the real API, giving 51 screens in total. **No Milestone 6 screen is left without a wireframe** (§18).
- **10 API gaps (A-1 to A-10).** These are small read endpoints the interface needs and the API does not have yet, for example who the user is and what they may do, a people picker, and dashboard counts (§2.3).
- **10 decisions** to make before building (§19). The most important:
  - **W-D2:** add the read endpoints for the 10 gaps to Milestone 6 scope.
  - **W-D9:** how the browser holds the sign-in session (recommended: a server-side web layer with secure cookies; tokens never in the browser).
  - **W-D8:** which property dashboard panels to build now. Phase 4 has no lease or viewing data yet, so vacancy and occupancy panels must wait.

---

## 1. Existing Phase 3 wireframes

| Phase 3 item | Location | Still valid? | Milestone 6 action |
|---|---|---|---|
| Product shell | README | Yes | S-2 limits it to Phase 4 sections (no routes for unbuilt modules) |
| Work queue (desktop) | 03 §1 | Yes, not in Phase 4 | Deferred: needs tasks (Phase 5+) |
| Property register | 03 §2 | Partly: "Purpose" and "Assigned" columns do not exist in the model | Replaced by P-1 (location column, map toggle, real filters) |
| Record form | 03 §3 | Pattern valid | P-3, with the location picker M-1 |
| Field visit (tablet) | 03 §4 | Yes | T-1 connects it to photos, notes and keys |
| Agent day (mobile) | 03 §5 | Yes, data not in Phase 4 | D-2 adds only the keys panel |
| Tenant portal (mobile) | 03 §6 | Not in Phase 4 | Issue #12 |
| Record page pattern | 07 §1 | Yes | Used by P-2, L-3 |
| Receipt allocation, work order, inspection, technician job, landlord approval | 07 §2.1, 2.2, 2.5–2.7 | Not in Phase 4 | Later phases |
| Listing editor (two languages) | 07 §2.3 | Partly: the checklist names a document rule; real blockers differ | Replaced by L-4 + L-5 |
| Users and roles | 07 §2.4 | Not in Phase 4 | Later (admin) |
| Tables, forms, filters, empty and error states, shortcuts | 07 §3–8 | Yes | Applied everywhere; new error types added in §15 |
| Property dashboard | 06 §3 | Partly: vacancy, occupancy and viewings need later modules | D-1 (W-D8) |
| Components, accessibility, responsive | 04 | Yes | Extended in §11 and §15 |
| Tokens and RTL | 01 §1–7 | Yes | Extended in §12 and §16 |

## 2. Gap analysis against Milestones 1–5

### 2.1 Feature to screen

| Milestone | Delivered API feature | Phase 3 wireframe | Milestone 6 wireframe |
|---|---|---|---|
| M1 | Sign-in through the identity provider, `/me` memberships, company context, problem responses, ETags, idempotency | Shell only | S-1, S-2; error mapping (§15) |
| M2 | Properties CRUD, archive and restore | Register, form | P-1, P-2, P-3, P-5 |
| M2 | Units, availability | — | P-4 |
| M2 | Property types (platform and company) | — | P-7 |
| M2 | International address forms | Rule only (07 §4) | P-3 (needs **A-9**) |
| M3 | Listings, statuses, publish, unpublish, assign, relist, archive | Listing editor only | L-1, L-2, L-3, L-5 … L-8 |
| M3 | Translations | Listing editor | L-4 |
| M3 | Price and status history, audit history | — | L-9 |
| M3 | Price-reduction approval rule (D2) | — | L-4 (warning), L-10 |
| M3 | Listing settings | — | L-10 |
| M4 | Uploads with scan and processing | — | G-2, X-2 |
| M4 | Property media, captions, alt text, archive, restore, legal hold, delete | — | G-1, G-3, G-7 |
| M4 | Floor plans, site plans, brochures (PDF previews) | — | G-4 |
| M4 | Video and tour links | — | G-5 |
| M4 | Listing gallery (selection, order, cover) | — | G-6, T-3 |
| M4 | Storage quota | — | G-8 |
| M4 | Publishing rules (minimum photos, floor plan) | — | L-5, L-10 |
| M5 | Location confirmation, geocoding suggestions | — | M-1 |
| M5 | Radius, viewport and polygon search, distance sort | — | L-1, P-1 filters; M-2, M-3, X-5, T-2 |
| M5 | Map clustering | — | M-2, M-3 |
| M5 | Notes, audiences, revisions, archive, redact | Rule only ("notes with audiences") | N-1 … N-4, X-3 |
| M5 | Key register | Sidebar entry only | K-1 … K-6, X-4, D-2 |

### 2.2 Phase 3 items not in Phase 4 (no Milestone 6 screen)

| Item | Why not now |
|---|---|
| Ownership tab, owners, seller KYC | Contacts and ownership are Phase 5 (M3 verification G4). The Ownership tab is hidden; the "seller identity" blocker is explained in L-5. |
| Viewings, offers, deals, leases, maintenance, documents and finance tabs | Their modules are later phases; the tabs are not shown. |
| Work queue, CRM, Rent, Maintenance, Finance and Admin dashboards | Their data is later phases. |
| Landlord and tenant portals | Issue #12 |
| Compliance documents (PRP-09) and the "required document" blocker | Documents module. The blocker can already appear when a company configures a rule, so L-5 shows it. |

### 2.3 API gaps found while specifying the screens

| ID | Gap | Needed by | Proposed endpoint | Size |
|---|---|---|---|---|
| A-1 | No "my context" for the chosen company: effective permissions with scopes, membership id, offices, locale, time zone | Every screen (navigation, action visibility, "my" filters) | `GET /api/v1/me/context` (company header) | S |
| A-2 | No list of staff to pick from | L-2, L-7, K-2, K-3, N-1 author filter | `GET /api/v1/members?filter[officeId]&filter[permission]&q=` (names and ids only) | S |
| A-3 | No contact lookup, so keys cannot be checked out to a contractor | K-3 | Contacts API (Phase 5); the option stays disabled until then | — (Phase 5) |
| A-4 | No property activity feed (listings have one) | P-6 | `GET /api/v1/properties/{id}/history` (property, units, media, notes metadata, keys) | S |
| A-5 | No property dashboard data, and some dashboard counts have no matching list filter | D-1 | One endpoint per panel (Phase 3 05 §8.3), plus list filters: listings `filter[readiness]`, `filter[photosBelowMinimum]`, `filter[coverAltMissing]`, `filter[priceUnchangedDays]`; media `filter[rejectedSince]`; properties `filter[locationStale]` | M |
| A-6 | No grouped global search | S-3, L-2 unit picker | `GET /api/v1/search?q=` (properties, units, listings) | S–M |
| A-7 | `locationStale` and location source are not on property list items | P-1, M-3 | Add the fields to `PropertySummaryDto` | XS |
| A-8 | No totals for tab counts (media, notes, keys) | P-2 tab labels | `GET /api/v1/properties/{id}/summary` (counts by type) | S |
| A-9 | No reference data: countries with address formats and bounds, picklists (tenure, furnishing, mandate types), currencies, locales | P-3, P-4, L-2, L-4, M-1 | `GET /api/v1/reference/countries`, `/picklists/{key}?countryCode=`, `/currencies`, `/locales` | S |
| A-10 | Publishing blockers only appear when publishing fails | L-1, L-3, L-5 | `GET /api/v1/listings/{id}/readiness` (same codes as `publish-blocked`) | S |

All are read-only, use existing data and follow the same scope and row-level security rules. None changes a business rule.

## 3. Property screens

**P-1 to P-7, X-1 and T-1.** Each has its full specification in the wireframes document.

| Screen | Purpose | Roles | Key data | Key actions | Dependencies | Security |
|---|---|---|---|---|---|---|
| P-1 Register | Find properties; spot missing or stale locations | `property.view` (scope) | `GET /properties` + location filters | Open, add, map | A-7, M-3 | Filter options from visible data only |
| P-2 Record | One view of a property | `property.view`; tabs by own permission | Property, pinned notes, keys | Edit, archive, add listing/media/note/keys | A-8, record pattern | Same 404 for missing and forbidden |
| P-3 Form | Create and edit, with address and location | `property.create` / `.update` | Types, offices, address formats | Save (Idempotency-Key / If-Match) | A-9, M-1 | Office choices by scope; no `internalNotes` |
| P-4 Units | Units and availability | `property.view` / `.update` / `.archive` | Units | Add, edit, availability, archive | — | Archive blockers shown as sent |
| P-5 Archive | Retire or restore | `property.archive` | Version | Archive with reason, restore | — | If-Match |
| P-6 Activity | Who changed what | `property.view` (+ notes, keys permissions) | **A-4** | Filter, open related | A-4 | Metadata only; no note text exists in audit |
| P-7 Types | Types per country | View all; edit `settings.manage` | Property types | Add and edit company types | — | Platform rows read-only |

## 4. Listing screens

**L-1 to L-10, plus M-2 and X-5.**

| Screen | Purpose | Roles | Key data | Key actions | Dependencies | Security |
|---|---|---|---|---|---|---|
| L-1 Register | Work the listing book | `listing.view` (scope) | `GET /listings` + location, distance | Open, new, map | A-10 (blocker column) | Single-currency price filter |
| L-2 New | Start a listing | `listing.create` | Units, agents, currencies | Create draft | A-2, A-6, A-9 | Agents can only assign themselves |
| L-3 Record | Manage a campaign | `listing.view`; actions by ADR-004 | Listing + media summary | Open L-4 to L-9, G-6 | A-10 | Closed listings: relist only |
| L-4 Editor | Terms and translations | `listing.update`; `listing.approve_price` for large cuts | Listing, settings | Patch, translations | A-9 | RTL per field; 10% rule shown first |
| L-5 Publish | Blockers, publish, unpublish | `listing.publish` | **A-10** | Publish, unpublish | G-6, G-4, L-4 | Button disabled with reason |
| L-6 Status | Lifecycle | `listing.publish` | Allowed transitions | Transition with reason | — | Terminal statuses confirmed |
| L-7 Reassign | Change agent | `listing.update` (office/all) | Agents | Assign | A-2 | Not shown to agents |
| L-8 Relist | New campaign | `listing.create` | Source listing | Relist | — | Conflict links to open listing |
| L-9 History | Price, status and audit | `listing.view` | History endpoints | Page | — | Read only |
| L-10 Settings | Company listing rules | View `listing.view`; save `settings.manage` | Settings | Save | — | Audited |

## 5. Gallery screens (issue #7)

**G-1 to G-8, X-2 and T-3.**

| Screen | Purpose | Roles | Key data | Key actions | Dependencies | Security |
|---|---|---|---|---|---|---|
| G-1 Media tab | All media of a property | View `property.view`; edit `.update`; archive `.archive` | Media list with signed URLs | Upload, link, reorder, archive | G-2, G-3, G-5 | Signed URLs only; refetch on expiry; no preview for rejected |
| G-2 Upload | Safe multi-file upload | `property.update` (or `listing.update` for a listing) | Upload sessions | Upload, cancel, retry | Web Crypto hashing | Direct to storage on bound URL; checks repeated server-side |
| G-3 Details | Caption, alt text, lifecycle | As G-1; hold and delete Own/Adm | `GET /media/{id}` | Edit, archive, hold, delete now | ConfirmDialog | Irreversible delete needs typed confirmation |
| G-4 Plans | Floor and site plans, brochures | As G-1 | Media by type | Upload, floor label, add to listing | FloorPlanViewer | No in-app PDF rendering; download as attachment |
| G-5 Links | Video and tours | `property.update` | — | Add link | — | No third-party embeds in the staff app |
| G-6 Listing gallery | Selection, order, cover | `listing.update` | Listing and property media | Save whole selection | ReorderList | Ready, same-property media only; 412 on concurrent edit |
| G-7 Archived | Recover within 90 days | View; restore `.archive`; hold/delete Own/Adm | Archived media | Restore, hold, delete | G-3 | Shows deletion date |
| G-8 Storage | Quota use | `property.view` | `GET /settings/storage` | — | StorageMeter | Company totals only |

## 6. Notes screens

**N-1 to N-4 and X-3.**

| Screen | Purpose | Roles | Key data | Key actions | Dependencies | Security |
|---|---|---|---|---|---|---|
| N-1 Notes tab | Read and add notes | View `property_note.view`; add `.create`; manage `.manage` | Pinned + list | Add, edit, pin, history, archive, redact | N-2 to N-4 | Plain text; audience shown in text |
| N-2 Composer | Write with category, unit, audience | `.create`; external audiences `.manage` | Units | Create, edit | ConfirmDialog | Tenant audience needs a unit; external audience confirmed |
| N-3 History | Earlier wording | Author or `.manage` | Revisions | Page | — | Hidden from others (403) |
| N-4 Archive and redact | Tidy and erase | Archive: author or manage; redact: manage | Version | Archive, restore, redact | ConfirmDialog | Redact irreversible; reason is a category |

## 7. Key register screens

**K-1 to K-6, X-4 and D-2.**

| Screen | Purpose | Roles | Key data | Key actions | Dependencies | Security |
|---|---|---|---|---|---|---|
| K-1 Property keys | Where each set is | `key.view`; move `key.issue`; manage `key.manage` | Key sets | K-3 to K-6 | — | Names only; overdue not by colour alone |
| K-2 Register | All keys out and overdue | `key.view` (scope) | Key sets filtered | Check in, open | A-2 | Scoped counts |
| K-3 Check out | Record holder and due time | `key.issue` | Staff (A-2); contacts (A-3, Phase 5) | Check out | A-2, A-3 | Time zone explicit; active staff only |
| K-4 Movements | Check in, lost, found, retire | `key.issue`; retire `key.manage` | Version, holder | Move, retire | — | Retire blocked while out |
| K-5 Add/edit | Register a set | `key.manage` | Units | Add, edit | — | Duplicate tag shown on field |
| K-6 History | Movement log | `key.view` | Movements | Page | — | Names only |

## 8. Location and map screens

**M-1 to M-3, plus X-5 and T-2.**

| Screen | Purpose | Roles | Key data | Key actions | Dependencies | Security |
|---|---|---|---|---|---|---|
| M-1 Picker | Confirm the exact position | Property editors; suggestions `property.update` | Suggestions, tiles | Suggestion, pin, coordinates, device location, remove | A-9 (country bounds) | Device position used once; no search history kept |
| M-2 Listing map | Find listings by area | `listing.view` | `/listings/map` + `/listings` | Pan, radius, draw, select, zoom to cluster | MapLibre, tiles (W-D4) | Results already scope-filtered; own tiles |
| M-3 Property map | Portfolio and missing locations | `property.view` | `/properties/map` + `/properties` | As M-2; fix location | A-7 | As M-2 |

**Map behaviour rules**

- Search runs on an explicit "Search this area" after panning, not on every move. This keeps within the per-member rate limit (240/min) and avoids moving results under the user's eyes.
- On 503 `search-timeout`, the screen suggests zooming in or adding filters. On 429, it shows the seconds to wait.
- Clusters show their count and zoom to their bounds when chosen.
- The list beside the map is always available, so the map is never the only way to reach a result (§11).

## 9. Mobile layouts

| Screen | Rule |
|---|---|
| X-1 Property | Summary, pinned notes and keys first; quick actions (photos, note, keys); sections as pages. "Directions" hands coordinates to the device maps app. |
| X-2 Photos | Camera and gallery; per-file progress; room label for the batch; optional "wait for Wi-Fi". No offline storage in Phase 4. |
| X-3 Note | Full-screen composer with the same audience rules. |
| X-4 Keys | Out and overdue first; one action per card. |
| X-5 Map | Map/list toggle with a button (not only a drag gesture); "Near me" asks for location each session. |
| Tables | Become cards with identifier, status and two key fields (Phase 3 07 §3). |
| Bottom bar | Properties · Listings · Map · Keys · Menu (by permission; fewer items if fewer permissions). |

The tested baseline is 320 px wide, 200% zoom, portrait and landscape, with the software keyboard open.

## 10. Tablet layouts

| Screen | Rule |
|---|---|
| T-1 Field visit | The Phase 3 checklist, connected to X-2, N-2 and K-4. Checklist state is not stored (no viewings API until Phase 6). |
| T-2 Map | Landscape: list 40% and map 60%. Portrait: map over a list sheet. |
| T-3 Reordering | Arrow buttons and "Move to position", with long-press drag as an extra. |
| Record pages | The side panel moves above the tabs, collapsed to three lines (Phase 3 07 §1). |
| Navigation | An icon rail with labels, plus a drawer. |

## 11. Accessibility requirements (WCAG 2.2 AA, ADR-002)

The Phase 3 rules in 04 §3 all apply. New for these screens:

| Area | Requirement | Screens |
|---|---|---|
| Maps (1.1.1, 2.1.1, 1.3.1) | Every map result is also in the adjacent list. The map region has a name and a live text summary ("48 listings in this area, 3 clusters"). Pins and clusters are reachable by keyboard (Tab into the map, arrows between markers, Enter to select). The radius and polygon tools have keyboard alternatives: a crosshair moved with the arrow keys, Space to add a point, Enter to finish. | M-1 … M-3, X-5, T-2 |
| Dragging (2.5.7) | Every drag has a single-pointer alternative: move up/down buttons, "Move to position", "Make cover", and click-to-place for the pin. | G-1, G-6, T-3, M-1 |
| Target size (2.5.8) | 24 × 24 px minimum, 44 × 44 px on touch; map controls and tile menus included. | All |
| Images (1.1.1) | Alt text is editable for every image and suggested from the room label. Decorative thumbnails in lists use empty alt text when the caption is next to them. A missing cover alt text is a dashboard item (D-1). | G-1, G-3, G-6 |
| Status messages (4.1.3) | Upload progress, processing done or rejected, saved, and "search this area" result counts are announced through a polite live region; errors through an assertive one. No announcement for every progress tick, only at 25% steps and at completion. | G-2, M-2, all forms |
| Colour (1.4.1) | Audience badges, key status, location status and processing status always carry text. Map markers differ by shape as well as colour (e.g. ● available, ◆ reserved, ■ under contract). | N-1, K-1, P-1, M-2 |
| Focus (2.4.11, 2.4.7) | Drawers and dialogs trap focus and return it to the trigger. Sticky bars never cover the focused element. The map's focus ring uses `color.focus` with a 2 px outline plus a white halo for contrast over imagery. | G-3, N-3, K-6, map |
| Language of parts (3.1.2) | Arabic fields and text carry `lang="ar"` and `dir="rtl"`. | L-4, N-1 |
| Time zones (3.3.2) | Due-back times and dates state their time zone when it differs from the user's. | K-1 … K-4 |
| Errors (3.3.1, 3.3.3) | Problem `errors[]` map to fields; `publish-blocked` maps to the checklist; `search-timeout` and `too-many-requests` give a recovery step. | All |
| Motion (2.3.3) | Map fly-to and reorder animations are off under `prefers-reduced-motion`. | Maps, G-6 |

**Testing:** an automated check (axe) in CI on every screen; manual keyboard, NVDA/JAWS (Windows), VoiceOver (iOS/macOS) and TalkBack passes on G-1, G-2, G-6, M-2, N-2 and K-3 before release.

## 12. RTL requirements (Arabic, Qatar)

The Phase 3 rules in 01 §7 apply. New for these screens:

| Area | Rule |
|---|---|
| Map labels | The MapLibre RTL text plugin is loaded (and self-hosted) so Arabic place names shape correctly (M5 report §4). |
| Map controls | Zoom and tool buttons sit at the inline end. Coordinates, distances and scale bars are not mirrored, and numbers are isolated with `<bdi>`. North stays up. |
| Drawing tools | Polygon points follow the pointer; nothing is mirrored. Instructions mirror. |
| Galleries and order | Grid order runs from the inline start (right in RTL). "Move earlier" and "Move later" mirror their arrows, and keep their meaning (position 1 = cover). |
| Translations | L-4 shows English and Arabic side by side; the Arabic column is `dir="rtl"`. Users can type Arabic in any language field, since direction is set per field from the field's locale. |
| Mixed content | References (`LST-2026-000033`), tag numbers (`K-100`), amounts, coordinates, phone numbers and file names are isolated. |
| Notes | Note text uses `dir="auto"`, so an Arabic note in an English interface (and the reverse) renders correctly. |
| PDF and image viewers | Not mirrored. |
| Testing | Every screen gets an Arabic screenshot test with real Arabic strings and long German-length strings for overflow. RTL defects block release. |

**Arabic interface language:** the interface ships translation-ready. Professional Arabic translation of the interface strings is decision W-D5.

## 13. Role-specific navigation (Phase 4 subset of Phase 3 02 §6)

| Item | Own | Adm | SM | PM | Ag | Acc | Tech |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Property dashboard (D-1) | ✓ all | ✓ all | ✓ office | ✓ office | | | |
| Properties (P-1) | ✓ | ✓ | ✓ | ✓ | ◐ office read, edit own | ◐ read | ◐ assigned |
| Listings (L-1) | ✓ | ✓ | ✓ | ✓ | ◐ office read, edit own | ◐ read | |
| Map (M-2, M-3) | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | |
| Keys (K-2) | ✓ | ✓ | ✓ | ✓ | ✓ check out/in | | |
| Notes tab (N-1) | ✓ manage | ✓ manage | ✓ manage | ✓ manage | ◐ add, own edits | ◐ read | |
| Media tab (G-1) | ✓ incl. hold/delete | ✓ incl. hold/delete | ✓ | ✓ | ◐ own properties | ◐ read | ◐ read |
| Settings → Property types, Listing rules | ✓ | ✓ | read | read | read | read | |
| Settings → Storage | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Quick create | Property, Listing, Key set | same | same | same | Property, Listing | — | — |

The navigation is built from **A-1** (permissions with scopes). The seeded roles produce this table; companies' custom roles produce their own, with no code change.

## 14. Dashboard updates

D-1 keeps the Phase 3 rules (06 §1: every number is a link, scope is visible, no cross-currency sums, panel-level loading) and changes the panels to what Phase 4 data supports:

| Panel | Phase 3 | Phase 4 (D-1) | Source |
|---|---|---|---|
| Vacant units, Occupancy | Yes | **Hidden** | Need leases (Phase 7) |
| Listings needing attention | Yes | **Changed:** blockers, below photo minimum, no floor plan, mandate ≤ 14 days, cover without alt text, price unchanged 60 days | Listings, media, settings (A-5) |
| "No viewing in 21 days" | Yes | **Hidden** | Needs viewings (Phase 6) |
| "Missing required document" | Yes | Inside "blockers" | Readiness (A-10) |
| Under maintenance | Yes | Yes | Units availability |
| Keys | — | **New:** overdue, out, lost | Key sets |
| Locations | — | **New:** no location, pins to check | Addresses (A-5, A-7) |
| Media | — | **New:** rejected uploads (7 days), storage | Media, storage |
| My day — keys I hold | — | **New (D-2)** | Key sets |

## 15. Component inventory

**Reused from Phase 3 (04 §1), all still needed:**
- `AppShell`, `PrimaryNavigation`, `CompanySwitcher`, `OfficeSwitcher`, `GlobalSearch`, `QuickCreateMenu`, `PageHeader`;
- `DataTable`, `MobileRecordList`, `FilterBar`, `ActiveFilterChips`, `SavedViewPicker`, `StatusLabel`, `AuditHistory`;
- `FormField`, `Combobox`, `DatePicker`, `MoneyInput`, `AddressFields`, `FileUploader` (replaced by `UploadQueue`), `ValidationSummary`, `UnsavedChangesGuard`, `ConfirmDialog`, `PropertySummary`, `UnitAvailability`.

**New for Milestone 6:**

| Component | Used by | Notes |
|---|---|---|
| `ProblemMapper` | All | RFC 9457 → field errors, banners, the publish checklist, retry hints (429 `Retry-After`, 503 `search-timeout`, `geocoding-unavailable`) |
| `ConflictDialog` | All edits | 412: reload or re-apply changed fields (Phase 3 07 §4) |
| `IdempotentAction` | Creates | Generates and reuses `Idempotency-Key` across retries |
| `PeoplePicker` | L-2, L-7, K-2, K-3 | Needs A-2 |
| `UnitSelect`, `UnitPicker` | N-2, K-5, L-2 | |
| `PublishChecklist` | L-3, L-5, D-1 | Codes from A-10 |
| `StatusTransitionDialog` | L-6 | Allowed transitions only |
| `TranslationEditor` | L-4 | Side by side or tabs; per-field `lang`/`dir` |
| `MediaGrid`, `MediaTile` | G-1, G-4 | States: ready, processing, rejected, archived |
| `UploadQueue` | G-2, X-2 | SHA-256 hashing, signed PUT, confirm, poll; cancel and retry |
| `MediaDetailsDrawer` | G-3 | |
| `SignedImage` | All media | Renews expired URLs; no cross-company cache |
| `ReorderList` | G-6, T-3 | Drag + keyboard + buttons + "move to position" |
| `CoverSelector` | G-6 | |
| `FloorPlanViewer` | G-4 | Zoom and keyboard pan over the preview image |
| `ExternalMediaLinkForm` | G-5 | |
| `StorageMeter` | G-1, G-8 | |
| `NoteComposer`, `NoteCard`, `AudienceBadge`, `RevisionList` | N-1 … N-3, X-3 | |
| `KeySetRow`, `KeyHolder`, `DueBackText`, `DateTimeZoneField` | K-1 … K-6 | |
| `MapView` | M-1 … M-3 | MapLibre wrapper with our tiles, RTL plugin and keyboard handling |
| `MarkerLayer`, `ClusterLayer` | M-2, M-3 | Shapes and colours by status; clusters with counts |
| `RadiusTool`, `PolygonTool` | M-2, M-3, X-5 | Keyboard alternatives |
| `MapResultList` | M-2, M-3 | Synchronised selection with the map |
| `LocationPicker`, `CoordinateFields` | M-1 | Suggestions, pin, coordinates, source and accuracy |
| `LocationFilter` | P-1, L-1 | Near a place (suggestion or property), radius, or "draw on map" |
| `MiniMap` | P-2 | Static, no interaction |
| `DashboardPanel` | D-1, D-2 | Loading, error and freshness per panel |

## 16. Design-token impact

Additions to Phase 3 01 §6. Every colour pair must be measured like the existing table before it is accepted.

| Token | Value (proposed) | Purpose | Check |
|---|---|---|---|
| `color.overlay.scrim` | `rgba(23,33,47,0.6)` | Behind drawers and the image viewer | Text on scrim not allowed; dialogs use `surface` |
| `color.media.placeholder` | `#E3E8EF` | Image loading and missing-image tiles | Decorative |
| `color.dropzone.border` | `color.border.control` dashed | Upload area | 3.61:1 |
| `color.dropzone.active` | `color.info` 2 px | Drag-over state | 5.99:1 |
| `color.map.marker.*` | Reuse status semantics: `success` available, `info` reserved/under contract, neutral others | Map pins | ≥ 3:1 against the basemap's land colour; shape also differs |
| `color.map.cluster` | `color.brand` with white text | Cluster badges | 11.15:1 |
| `color.map.selection` | `color.focus` | Selected pin and area outline | 5.67:1 |
| `color.map.area.fill` | `color.info` at 12% | Radius and polygon fill | Outline carries contrast, fill is decorative |
| `color.audience.internal` / `.landlord` / `.tenant` | neutral / `info` / `warning` text + border | Note audience badges | Same as status labels; text always present |
| `size.thumb.sm` / `.md` / `.lg` | 96 / 160 / 320 px | Media tiles (320 px matches the API's `thumb` size) | — |
| `ratio.media` | 4:3 | Tile aspect ratio; images fit with `object-fit: cover` and a full view in G-3 | — |
| `z.map-controls` < `z.sticky` < `z.drawer` < `z.dialog` < `z.toast` | 10 / 20 / 30 / 40 / 50 | Layering | — |
| `motion.map` | 0 ms under reduced motion, else 200 ms | Fly-to, cluster expand | — |
| `space.map-control` | 8 px | Map control inset (logical properties) | — |

**Basemap style:** the self-hosted vector style needs neutral land and water colours so markers keep 3:1 contrast. A light style is used, and a dark style is not in Phase 4.

## 17. Open UI issues

| ID | Issue | Proposal |
|---|---|---|
| U-1 | No usability testing of the Phase 3 or Milestone 6 wireframes with real agencies yet (Phase 3 open item) | Test five tasks (upload and order photos, publish a listing, map search, add an external note, check keys out) with one agency per market during Milestone 6 week 1 (W-D10) |
| U-2 | Supported browsers and devices not confirmed (Phase 3 README) | Last two versions of Chrome, Edge, Firefox and Safari; iOS 16+ Safari; Android 10+ Chrome |
| U-3 | Price reductions above the threshold have no approval request: the agent is told to ask a manager | Accept for Phase 4 (W-D7); an approval queue comes with the work queue |
| U-4 | Keys cannot be checked out to contacts until the contacts API (Phase 5) | Option visible but disabled with the reason (A-3) |
| U-5 | Photo upload on slow mobile networks: no resumable uploads | Single-PUT uploads up to 25 MB, with retry. Resumable (multipart) uploads only if field tests show failures. |
| U-6 | Alt text is not a publishing rule, though PRP-10 public feeds will need it | Dashboard item now; consider making cover alt text a publish blocker with PRP-10 |
| U-7 | Note audiences landlord and tenant have no reader yet (issue #12) | The UI explains "visible when the portal opens" |
| U-8 | Map tiles must be built and hosted (OSM extracts for Ghana, Qatar, UK; style; fonts; RTL plugin) | W-D4 |
| U-9 | Interface strings in Arabic need professional translation | W-D5 |
| U-10 | The geocoding suggestions endpoint needs `property.update`, so creators with only `property.create` get 403 | Allow `property.create` or `property.update` (tiny API change in Milestone 6) |
| U-11 | Dashboard counts need list filters that do not exist yet | Part of A-5 |
| U-12 | No interface for platform staff (provisioning is a command-line tool) | Out of Phase 4 |
| U-13 | "Field visit" checklist results are not stored | Accept; viewings (Phase 6) will store outcomes |
| U-14 | Signed media URLs expire after 15 minutes; long sessions show broken images | `SignedImage` refetches the page of media when an image fails with 403 |

## 18. Missing wireframes before implementation

Each of the following had **no Phase 3 wireframe**. All are now wireframed in [M6-WIREFRAMES.md](./M6-WIREFRAMES.md):

| Group | Screens |
|---|---|
| Shell | S-1 company picker, S-3 global search (Phase 4 subset) |
| Properties | P-2 record overview for Phase 4 tabs, P-4 units and availability, P-5 archive, P-6 activity, P-7 property types |
| Listings | L-1 register, L-2 new, L-3 record, L-5 publish checklist, L-6 status, L-7 reassign, L-8 relist, L-9 history, L-10 settings |
| Gallery (issue #7) | G-1 media tab, G-2 upload, G-3 details, G-4 floor plans, G-5 links, G-6 listing gallery, G-7 archived, G-8 storage |
| Notes | N-1 tab, N-2 composer, N-3 history, N-4 archive and redact |
| Keys | K-1 to K-6 |
| Location (issue #7) | M-1 picker, M-2 listing map, M-3 property map |
| Mobile and tablet | X-1 to X-5, T-2, T-3 |
| Dashboards | D-2 keys panel |

Also re-specified, because the original wireframes no longer matched the API or Phase 4 data: S-2 (Phase 3 shell), P-1 (03 §2), P-3 (03 §3), L-4 (07 §2.3), T-1 (03 §4) and D-1 (06 §3).

**Still missing, and not needed for Milestone 6:**
- the work queue;
- contacts, ownership, viewings, offers, leases, maintenance, finance and documents screens;
- the portals;
- users and roles administration;
- the platform console.

These belong to later phases.

**Blocked pending a decision or another phase** (the wireframe exists, but part of the screen waits):

| Screen | Waiting on |
|---|---|
| K-3 "contact" holder | Phase 5 contacts |
| P-6 activity | A-4 |
| D-1 data | A-5 |
| S-3 search | A-6 |

## 19. Decisions requested before Milestone 6 starts

| ID | Question | Recommendation |
|---|---|---|
| W-D1 | Front-end stack and component foundation | Next.js (App Router) + React + TypeScript as in P1-D §9, in `apps/web`. Use accessible headless primitives (React Aria Components) styled with the Phase 3 tokens as CSS custom properties. They give strong keyboard, screen-reader and RTL support, and we keep full control of the look. |
| W-D2 | Add the UI read endpoints A-1, A-2, A-4 to A-10 to Milestone 6 | Yes. They are small, read-only, scoped like the rest, and the screens cannot be built honestly without them. A-3 stays in Phase 5. |
| W-D3 | Reordering interaction | Drag-and-drop **plus** move buttons, keyboard and "Move to position" (WCAG 2.5.7), as in G-6 and T-3 |
| W-D4 | Map tiles | Build OSM vector tiles for Ghana, Qatar and the UK (Protomaps PMTiles), with style, fonts and the RTL plugin. Host them in a public, read-only R2 bucket behind the CDN, with attribution. Refresh quarterly. |
| W-D5 | Interface languages at the end of Phase 4 | English complete. Arabic: full RTL layout tested with real Arabic content, with professional translation of the interface strings before the Qatar pilot. Strings live in message files from day one. |
| W-D6 | Mobile approach | Responsive web only in Phase 4 (no native app, no offline sync). Camera through the browser file input. |
| W-D7 | Price-reduction approval | Keep "ask a manager" (no approval queue) in Phase 4 (U-3) |
| W-D8 | Property dashboard panels | Build the Phase 4 panels in §14; hide vacancy, occupancy and viewing panels until their modules exist |
| W-D9 | Session handling in the browser | Backend-for-frontend: the Next.js server completes the OIDC code flow with PKCE and keeps tokens server-side. The browser holds only an `HttpOnly`, `Secure`, `SameSite=Lax` session cookie, with CSRF protection on writes. API calls go through the server. No tokens in `localStorage`. |
| W-D10 | Usability testing | Test U-1's five tasks with one agency per market in week 1 of Milestone 6; adjust before the screens are finalised |

Once these are approved, the Milestone 6 plan is:

1. The read endpoints in W-D2.
2. `apps/web` scaffolding: BFF auth, tokens, RTL and i18n.
3. The shell with S-1 to S-3.
4. Properties (P), listings (L), gallery (G), notes (N), keys (K) and maps (M).
5. The dashboards (D), mobile (X) and tablet (T) layouts.
6. Testing:
   - accessibility checks (axe) in CI;
   - end-to-end tests with Playwright against the real API, in English and Arabic, at 320 px;
   - manual screen-reader passes.
