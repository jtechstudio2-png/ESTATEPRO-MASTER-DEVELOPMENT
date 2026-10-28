# Phase 4 · Milestone 6 · Wireframes (issue #7)

| | |
|---|---|
| Status | For product-owner review. No UI code has been written. |
| Issue | [#7](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/7) — media gallery and floor-plan manager, map search. Extended to every Milestone 6 screen that has no wireframe yet. |
| Builds on | Phase 3 design set (`docs/phase-3-ui-ux/`): shell, tokens, record page pattern (07 §1), tables, forms, filters, empty and error states. Those rules apply to every screen here and are not repeated. |
| Backed by | The Milestone 1–5 API (`apps/api/openapi.json`). Endpoints that do not exist yet are marked **API gap A-n** (see the [verification report](./M6-WEB-INTERFACE-VERIFICATION.md) §2.3). |
| Companion | [M6 Web Interface Verification Report](./M6-WEB-INTERFACE-VERIFICATION.md) |

These are low-fidelity structural wireframes. They fix content, order, actions and states, not visual styling. Names and numbers are placeholders, not data.

## How to read the screen specifications

Every screen has a wireframe and a specification block:

| Field | Meaning |
|---|---|
| **Purpose** | The question the screen answers or the task it completes |
| **Roles** | Who sees it, with the permission and scope that grants it. Roles not listed never see it (navigation hidden; the API rejects direct calls) |
| **Data** | What the screen reads, with the endpoint |
| **Actions** | What the user can do, with the endpoint and the permission |
| **Dependencies** | Other screens, components, settings and API gaps it relies on |
| **Security** | What the screen must and must not do beyond the server's checks |

Role abbreviations: **Own** company owner · **Adm** office administrator · **SM** sales manager · **PM** property manager · **Ag** agent · **Acc** accountant · **Tech** maintenance staff. Portal users (landlord, tenant) see none of these screens in Phase 4 (issue #12).

Standard states (Phase 3 03 §8): every screen has loading, initial empty, filtered empty, validation error, permission denied, conflict (412), network failure and success states. Only screen-specific states are listed below.

## Screen index

| ID | Screen | Device notes |
|---|---|---|
| **Shell** | | |
| S-1 | Sign-in return and company picker | all |
| S-2 | Application shell — Properties section | desktop, tablet rail, mobile bottom bar |
| S-3 | Global search (properties, units, listings) | all |
| **Properties** | | |
| P-1 | Property register | desktop; cards on mobile |
| P-2 | Property record — Overview | all |
| P-3 | Property form (create and edit) | all |
| P-4 | Units tab, unit form and availability | all |
| P-5 | Archive and restore property | dialog |
| P-6 | Property activity tab | all |
| P-7 | Property types (settings) | desktop |
| **Listings** | | |
| L-1 | Listing register | desktop; cards on mobile |
| L-2 | New listing | all |
| L-3 | Listing record | all |
| L-4 | Listing editor (terms and translations) | desktop side-by-side; tabs on mobile |
| L-5 | Publish checklist, publish and unpublish | panel + dialog |
| L-6 | Change status | dialog |
| L-7 | Reassign agent | dialog |
| L-8 | Relist | dialog |
| L-9 | Price and status history | tab |
| L-10 | Listing settings | desktop |
| **Gallery and floor plans** | | |
| G-1 | Property media tab | all |
| G-2 | Upload panel | all |
| G-3 | Media details drawer | drawer; full screen on mobile |
| G-4 | Floor plans and documents | all |
| G-5 | Add video or virtual tour | dialog |
| G-6 | Listing gallery editor | desktop, tablet; simplified on mobile |
| G-7 | Archived media | all |
| G-8 | Storage usage | desktop |
| **Notes** | | |
| N-1 | Notes tab | all |
| N-2 | Note composer and editor | inline; full screen on mobile |
| N-3 | Note history | drawer |
| N-4 | Archive, restore and redact note | dialogs |
| **Key register** | | |
| K-1 | Property keys tab | all |
| K-2 | Key register (company) | desktop; cards on mobile |
| K-3 | Check keys out | dialog |
| K-4 | Check in, report lost, mark found, retire | dialogs |
| K-5 | Add and edit key set | dialog |
| K-6 | Key movement history | drawer |
| **Location and maps** | | |
| M-1 | Location picker | inside P-3 |
| M-2 | Listing map search | desktop split; tablet; mobile toggle |
| M-3 | Property map | desktop split; tablet; mobile toggle |
| **Mobile** | | |
| X-1 | Property on mobile | ≤ 767 px |
| X-2 | Add photos on mobile | ≤ 767 px |
| X-3 | Note on mobile | ≤ 767 px |
| X-4 | Keys on mobile | ≤ 767 px |
| X-5 | Map and "near me" on mobile | ≤ 767 px |
| **Tablet** | | |
| T-1 | Field visit (updated) | 768–1023 px |
| T-2 | Listing map on tablet | 768–1023 px |
| T-3 | Gallery ordering by touch | 768–1023 px |
| **Dashboards** | | |
| D-1 | Property dashboard (Phase 4 panels) | all |
| D-2 | My day — keys panel | all |

---

## Shell

### S-1 Sign-in return and company picker

```text
┌──────────────────────────────────────────────┐
│ EstatePro                                     │
│ Choose a company                              │
│ ┌──────────────────────────────────────────┐ │
│ │ Accra Homes Ltd       Agent        Active│ │
│ │ Doha Lettings W.L.L.  Office admin Active│ │
│ │ London Lets Ltd       Agent   Read only ⚠│ │
│ └──────────────────────────────────────────┘ │
│ Signed in as kofi@… · [Sign out]             │
└──────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Choose the company to work in after signing in at the identity provider (ADR-001). Skipped when the user has one membership. |
| Roles | Every staff member. Portal memberships are listed but open the portal shell (not built in Phase 4: shown as "Portal access coming soon"). |
| Data | `GET /api/v1/me` → memberships (company, role, status, membership type). |
| Actions | Open a company (stores the company id for `X-Company-Id`). Sign out. |
| Dependencies | Identity provider login and token refresh (decision W-D9). Session context **API gap A-1** for permissions and offices after choosing. |
| Security | Suspended or cancelled companies cannot be opened (the API answers `company-inactive`); read-only companies open with a banner and every write action disabled. Switching company clears all cached data and open drafts belonging to the old company (Phase 3 05 §8.4). |

### S-2 Application shell — Properties section

```text
┌───────────────────────────────────────────────────────────────────────┐
│ EstatePro │ Accra Homes ▾ │ Osu office ▾ │ Search… (/) │ + Create ▾ │ Me │
├──────────────────┬────────────────────────────────────────────────────┤
│ Dashboards       │                                                    │
│   Property       │  Page content                                      │
│ Properties       │                                                    │
│   Properties     │                                                    │
│   Listings       │                                                    │
│   Map            │                                                    │
│   Keys  (2 due)  │                                                    │
│ Settings         │                                                    │
│   Property types │                                                    │
│   Listing rules  │                                                    │
│   Storage        │                                                    │
└──────────────────┴────────────────────────────────────────────────────┘
Tablet: icon rail with labels on focus/hover and an expanding drawer.
Mobile: bottom bar — Properties · Listings · Map · Keys · Menu.
```

| | |
|---|---|
| Purpose | Frame every Phase 4 screen. Only sections that exist in Phase 4 are shown (Phase 3 02 §1: "do not show routes that are not implemented"). |
| Roles | All staff. Items appear by permission: Properties (`property.view`), Listings (`listing.view`), Map (either), Keys (`key.view`), Property dashboard (D-1 rules), Settings items (`settings.manage`; Storage also `property.view`). |
| Data | Session context: permissions with scopes, offices, locale, time zone (**API gap A-1**). Keys badge: count of the user's keys overdue (`GET /key-sets?filter[overdue]=true&filter[holderMembershipId]=me`). |
| Actions | Switch company (S-1) and office filter; open search (S-3); quick create: Property (`property.create`), Listing (`listing.create`), Key set (`key.manage`). |
| Dependencies | S-1, S-3; tokens and RTL rules (Phase 3 01). |
| Security | Navigation is built from server permissions; hidden items are not rendered at all. The office switcher filters views only; it never widens scope. Badge counts show only the user's own items. |

### S-3 Global search

```text
┌ Search: osu court                                         Esc ┐
│ Properties                                                      │
│   PRP-2026-000014 · Osu Court · 12 Oxford St, Accra       ↵    │
│ Units                                                           │
│   UNT-2026-000101 · Flat 1A · Osu Court · Let                   │
│ Listings                                                        │
│   LST-2026-000033 · 2-bed apartment, Osu · Available · GH₵6,000 │
│ See all properties (4) ›                                        │
└─────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Jump to any property, unit or listing by reference, name or address (Phase 3 02 §7, Phase 4 subset). |
| Roles | All staff; each group appears only with its view permission. |
| Data | **API gap A-6** (grouped search). Until it exists, the screen queries `GET /properties?q=` and `GET /listings?q=` (no unit group). |
| Actions | Open a result; open in a new tab; "See all" opens the list with `q` applied. |
| Dependencies | S-2. |
| Security | Results and counts come only from server-scoped queries. Recent items are kept per user and company, cleared on company switch. |

---

## Properties

### P-1 Property register

```text
┌ Properties ─────────────────────────── [List | Map] [+ Add property] ┐
│ Scope: [Office ▾]  Search reference, name or address…                │
│ [Type ▾] [Country ▾] [Managed ▾] [Location ▾] [More filters]  Views ▾│
│ Chips: Type: Apartment building ✕   Has location: no ✕   Clear all   │
├───────────────┬───────────────────────┬──────────┬───────┬──────────┤
│ Reference     │ Property              │ Office   │ Units │ Location │
├───────────────┼───────────────────────┼──────────┼───────┼──────────┤
│ PRP-…-000014  │ Osu Court             │ Osu      │ 12    │ ● Set    │
│               │ 12 Oxford St, Accra   │          │       │          │
│ PRP-…-000015  │ Labone Villa          │ Osu      │ 1     │ ⚠ Check  │
│ PRP-…-000016  │ East Legon Plot 4     │ Osu      │ 0     │ — None   │
└───────────────┴───────────────────────┴──────────┴───────┴──────────┘
Sorted by: Last updated ↓              1–50 of 50+   [Load more]
```

| | |
|---|---|
| Purpose | Find and open properties; spot properties with no location or a location to check. |
| Roles | Own, Adm (all); SM, PM (office); Ag (office, read); Acc (all, read); Tech (assigned). From `property.view` and its scope. |
| Data | `GET /properties` with `q`, `filter[officeId|propertyTypeId|countryCode|isManaged|archived|hasLocation|locality|adminArea1]`, `sort`, `cursor`. Location column from `latitude`/`longitude`; "Check" when the record's `locationStale` is true (needs the flag on the list item — **API gap A-7**). |
| Actions | Open (P-2); add property (P-3, `property.create`); switch to map (M-3); save a view; export (`property.export`, Phase 11 job — hidden in Phase 4). |
| Dependencies | DataTable, FilterBar, Location filter control; M-3. |
| Security | Filter options (offices, types) list only what the user can see. Archived properties appear only with `filter[archived]`. |

### P-2 Property record — Overview

```text
┌ ‹ Properties   PRP-2026-000014 · Osu Court            [Edit] [⋯] ┐
│ Apartment building · Osu office · Managed      Location ⚠ check    │
├──────────────────────────────────────────────┬────────────────────┤
│ [Overview] [Units 12] [Listings 3] [Media 24] │ Key facts          │
│ [Notes 8] [Keys 2] [Activity]                 │ Address            │
│                                               │ 12 Oxford St, Osu, │
│ Pinned notes                                  │ Accra · GA-123-4567│
│ 📌 Gate sticks; lift and push (Access) · Ama  │ ┌ mini map ──────┐ │
│ 📌 Owner prefers email (Owner) · Landlord ✉   │ │      ●         │ │
│                                               │ └────────────────┘ │
│ Units: 12 · Let 0 · Available 4 · Maint. 1    │ Manual pin · 3 Mar │
│ Live listings: 3 (2 rent, 1 sale)  ›          │ Tenure Leasehold   │
│ Keys out: 1 · overdue 1 ⚠  ›                  │  to 2091           │
│ Photos: 22 ready · 2 processing · plans: 3    │ Land 0.25 acre     │
│                                               │ Time zone Accra    │
└───────────────────────────────────────────────┴────────────────────┘
```

| | |
|---|---|
| Purpose | One place to see a property's state and reach its units, listings, media, notes and keys. |
| Roles | Everyone with `property.view` covering the property. Tabs appear only with their own permission: Listings (`listing.view`), Notes (`property_note.view`), Keys (`key.view`). Tech sees Overview and Units only. |
| Data | `GET /properties/{id}` (with address, location source, accuracy, confirmation date, stale flag); counts from units, listings, media (`GET /properties/{id}/media?limit=1` page totals are not returned — **API gap A-8** for tab counts); pinned notes `GET /properties/{id}/notes?filter[pinned]=true`; keys `GET /properties/{id}/key-sets`. |
| Actions | Edit (P-3, `property.update`); archive or restore (P-5, `property.archive`); add listing (L-2); upload media (G-2); add note (N-2); add key set (K-5). Overflow: open in map, copy reference. |
| Dependencies | Record page pattern (Phase 3 07 §1), MiniMap (static, no interaction), P-4, L-3, G-1, N-1, K-1, P-6. |
| Security | A 404 is shown identically for "missing" and "not allowed". Pinned notes show their audience label; external-audience notes are marked so staff know who can read them later. The mini map uses our own tiles (no third-party request). |

### P-3 Property form (create and edit)

```text
┌ Add property ───────────────────────────────── [Cancel] [Save] ┐
│ Basics                                                          │
│ Name [Osu Court            ]   Type* [Apartment building ▾]     │
│ Office* [Osu ▾]   Managed under agreement [ ]                   │
│ Address — Ghana                                    Country* [GH ▾]│
│ Street address [12 Oxford Street        ]                       │
│ Neighbourhood [Osu    ]  Town / City* [Accra   ]                │
│ District [        ]      Region* [Greater Accra ▾]              │
│ GhanaPost GPS address [GA-123-4567]                             │
│ Location  → M-1 location picker                                 │
│ Details                                                         │
│ Tenure [Leasehold ▾] expires [2091-12-31]  Title no. [      ]   │
│ Year built [2015]  Floors [4]  Land area [0.25] [acre ▾]        │
│ Jurisdiction [Ghana]  Time zone [Africa/Accra]  (from office)   │
│ ☐ Also create one "Whole property" unit (houses, plots)         │
└─────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Add a property or change its details, address and location. |
| Roles | Create: Own, Adm (all); SM, PM (office); Ag (own, in their offices). Edit: `property.update` covering the property. |
| Data | Property types `GET /property-types` (by country); offices `GET /offices`; address format from the country (**API gap A-9**: address formats are not exposed; the API validates but the form needs labels, required fields and patterns); picklists for tenure (**API gap A-9** same endpoint family). |
| Actions | Save `POST /properties` (Idempotency-Key) or `PATCH /properties/{id}` (If-Match). Changing the country re-renders the address fields. |
| Dependencies | AddressFields, M-1, MoneyInput not needed, AreaInput, UnsavedChangesGuard, ConflictDialog (412). |
| Security | Office choices limited to offices the user may place properties in. `internalNotes` is gone (ADR-006 L-D9): free text belongs in notes. Field errors map from the problem's `errors[]`. |

### P-4 Units tab, unit form and availability

```text
┌ Units (12) ─────────────────────────────── [+ Add unit] ┐
│ [Available ▾] [Archived ▾]   Search label…               │
│ Unit        Type        Beds  Area     Availability  ⋯  │
│ Flat 1A     Apartment   2     85 m²    Available         │
│ Flat 1C     Apartment   2     85 m²    Under maint. ⚠   │
│ Shop 3      Shop        —     40 m²    Unavailable       │
└──────────────────────────────────────────────────────────┘
Unit drawer: Label* · Type · Floor · Beds · Baths · Receptions ·
Floor area [ ][m² ▾] · Parking · Furnishing ▾ · Energy rating
Availability dialog: [Available | Under maintenance | Unavailable]
Reason* (for maintenance/unavailable)            [Cancel] [Save]
```

| | |
|---|---|
| Purpose | Manage the units inside a property and their operational availability. |
| Roles | View: `property.view`. Add and edit: `property.update` (PM/SM office, Ag own). Archive: `property.archive`. |
| Data | `GET /properties/{id}/units`, `GET /units/{id}`. |
| Actions | Add `POST /properties/{id}/units`; edit `PATCH /units/{id}`; availability `POST /units/{id}/availability`; archive/restore `POST /units/{id}/archive|restore` (blocked with the server's reason when a live listing or lease exists). |
| Dependencies | DataTable, Drawer form, ConfirmDialog. |
| Security | Archive blockers are shown exactly as the API states them; the button is not hidden, so users learn why. |

### P-5 Archive and restore property

```text
┌ Archive Osu Court? ──────────────────────────────────────┐
│ Archived properties and their units leave lists and maps. │
│ Reason* [Sold by owner                               ]   │
│ ⚠ Blocked: 3 open listings. Withdraw them first. [View]  │
│                                    [Cancel] [Archive]     │
└───────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Retire a property safely, or bring it back. |
| Roles | `property.archive` (Own, Adm all; SM, PM office). |
| Data | Current version (ETag). Blockers come back from the API as a business-rule problem. |
| Actions | `POST /properties/{id}/archive` (reason) and `/restore`. |
| Dependencies | ConfirmDialog, P-2. |
| Security | Requires If-Match; on 412 the dialog reloads and explains the change. |

### P-6 Property activity tab

```text
┌ Activity ───────────────────── [All ▾] [Last 90 days ▾] ┐
│ Today 10:14  Ama B.   Location changed (manual pin)      │
│ Today 10:02  Ama B.   Note added (Access) · internal     │
│ Mon 15:30    Kofi O.  Keys K-100 checked out to Yaw A.   │
│ Mon 09:00    System   Listing LST-…-033 expired          │
└──────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Who changed what on this property and its notes, keys, media and listings. |
| Roles | `property.view` covering the property; entries for notes require `property_note.view`, keys `key.view`. |
| Data | **API gap A-4**: no property history endpoint (listings have `/listings/{id}/history`). Needs an audit feed for the property and its child records. |
| Actions | Filter by type and date; open the related record. |
| Dependencies | AuditHistory component. |
| Security | Shows metadata only; note text is never in the audit log (L-D7), so it cannot leak here. |

### P-7 Property types (settings)

```text
┌ Property types ─────────────────────────── [+ Add type] ┐
│ [Platform] [Company]   Country [All ▾]                   │
│ Code             Name               Applies to   Active  │
│ apartment_bldg   Apartment building Property     ✓ (platform)│
│ chamber_hall     Chamber and hall   Unit (GH)    ✓ (platform)│
│ serviced_flat    Serviced flat      Unit         ✓  [Edit]│
└──────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | See the types offered per country and add company-specific types. |
| Roles | View: `property.view`. Add and edit company types: `settings.manage` (Own, Adm). |
| Data | `GET /property-types`. |
| Actions | `POST /property-types`, `PATCH /property-types/{id}` (company types only; platform types are read-only). |
| Dependencies | DataTable, form dialog. |
| Security | Platform rows have no edit action; the API refuses them anyway. |

---

## Listings

### L-1 Listing register

```text
┌ Listings ────────────────────────────── [List | Map] [+ New listing] ┐
│ Scope [Office ▾]  Search reference or title…                          │
│ [Rent|Sale] [Status ▾] [Price ▾ GHS] [Beds ▾] [Published ▾] [Location ▾]│
├────────────┬──────────────────────────┬──────────┬───────────┬───────┤
│ Reference  │ Listing                  │ Status   │ Price     │ Agent │
├────────────┼──────────────────────────┼──────────┼───────────┼───────┤
│ LST-…-033  │ 2-bed apartment, Osu     │ Available│ GH₵6,000  │ Ama   │
│            │ Flat 1A · Osu Court      │ Published│ /month    │       │
│ LST-…-034  │ Shop, Labone             │ Draft    │ GH₵450,000│ Kofi  │
│            │ ⚠ 2 publishing blockers  │          │           │       │
└────────────┴──────────────────────────┴──────────┴───────────┴───────┘
Location filter popover: [Near a place ▾ search] radius [2 km ▾] · or draw on map (M-2)
When "Near" is set: Sort by distance, and a "Distance" column appears.
```

| | |
|---|---|
| Purpose | Work the listing book: find, filter, sort and open listings. |
| Roles | `listing.view`: Own, Adm (all); SM, PM, Ag (office); Acc (all). |
| Data | `GET /listings` with every M3 filter plus location filters and `sort=distance` (returns `distanceMeters`). Blocker count: **API gap A-10** (blockers are returned only when publishing fails; a read-only "publish readiness" endpoint is needed for list and L-5). |
| Actions | Open (L-3); new listing (L-2, `listing.create`); switch to map (M-2). |
| Dependencies | DataTable, FilterBar, LocationFilter, MoneyText, StatusLabel (listing status + unit availability per Phase 3 01 §1). |
| Security | Price filter needs a single currency (the API enforces it); amounts never summed across currencies. |

### L-2 New listing

```text
┌ New listing ─────────────────────────────────── [Cancel] [Create draft] ┐
│ Unit* [Search property or unit…  ▾]  → Flat 1A · Osu Court              │
│ Type* (•) Rent ( ) Sale     Office [Osu ▾]  Agent [Ama Boateng ▾]       │
│ Price* [GH₵ ▾][6,000.00] per [Month ▾]  Title* [2-bed apartment, Osu]  │
│ Language [English (Ghana) ▾]                                            │
│ ⓘ The listing starts as a draft. Publish it when the checklist is green.│
└─────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Start a sale or rental listing for a unit. |
| Roles | `listing.create`: Own, Adm (all); SM, PM (office); Ag (own — agent is set to themselves). |
| Data | Unit search (`GET /properties?q=` then `GET /properties/{id}/units`; better with **A-6**); offices; agents in the office (**API gap A-2** people picker); currencies and locales (**API gap A-9** reference data). |
| Actions | `POST /listings` (Idempotency-Key). A conflict (open listing of the same type exists) links to it. |
| Dependencies | UnitPicker, PeoplePicker, MoneyInput. |
| Security | Agent choices limited to eligible staff in the office; agents cannot pick someone else. |

### L-3 Listing record

```text
┌ ‹ Listings  LST-2026-000033 · 2-bed apartment, Osu   [Publish] [⋯] ┐
│ Rent · Available · Not published   Flat 1A, Osu Court · Agent Ama   │
├──────────────────────────────────────────────┬─────────────────────┤
│ [Overview] [Gallery 14] [Translations 2]      │ Key facts           │
│ [Price & status] [History]                    │ GH₵6,000 / month    │
│                                               │ Advance 12 · Dep 2× │
│ Description (English)                         │ Available 1 Apr     │
│ …                                             │ Mandate sole · to   │
│ Cover photo ▢  14 photos · 1 floor plan       │ 30 Jun (expires 63d)│
│                                               ├─────────────────────┤
│                                               │ Publishing checklist│
│                                               │ ✓ Photos 14/8       │
│                                               │ ✓ Floor plan        │
│                                               │ ✗ Safety cert. ›    │
└───────────────────────────────────────────────┴─────────────────────┘
⋯ menu: Edit · Change status · Reassign · Relist · Unpublish · Archive
```

| | |
|---|---|
| Purpose | See and manage one listing campaign. |
| Roles | View `listing.view`; actions by permission and scope (ADR-004): edit `listing.update`; publish/unpublish/status `listing.publish` (agents: own listings); reassign `listing.update` with office/all scope; relist `listing.create`; archive `listing.archive`. |
| Data | `GET /listings/{id}` (includes `media` summary: photo and floor-plan counts, cover); readiness **A-10**. |
| Actions | Opens L-4 to L-9 and G-6. |
| Dependencies | Record page pattern; PublishChecklist; L-4…L-9; G-6. |
| Security | Actions the role cannot take are not rendered; the API is still the enforcement point. Closed listings (sold, rented, withdrawn, expired) show Relist only. |

### L-4 Listing editor (terms and translations)

```text
┌ Edit LST-2026-000033 ───────────────────────────── [Cancel] [Save] ┐
│ Price [GH₵][6,000.00] per [Month ▾]   Advance [12] months           │
│ Deposit [GH₵][12,000.00]  Service charge [GH₵][500.00] per [Month ▾]│
│ Min. term [12] months  Available from [2026-04-01]                  │
│ Mandate [Sole agency ▾] signed [2026-01-05] expires [2026-06-30]    │
│ Agency fee (•) % [10] ( ) Fixed [   ]  ☐ tax inclusive              │
│ Reason for price change* [Owner agreed new price   ] (live listing) │
├───────────────────────────────┬────────────────────────────────────┤
│ English (default)             │ العربية                     (RTL)  │
│ Title [2-bed apartment, Osu]  │ [شقة بغرفتي نوم، أوسو      ] العنوان│
│ Description [               ] │ [                         ] الوصف  │
│                  [Remove language]  [+ Add language ▾]              │
└───────────────────────────────┴────────────────────────────────────┘
⚠ Reductions over 10% on live listings need a manager. Ask a manager to make this change.
```

| | |
|---|---|
| Purpose | Change commercial terms and the listing text in each language. |
| Roles | `listing.update` (Ag own; SM, PM office; Own, Adm all). Large price reductions on live listings: `listing.approve_price` (managers) when the company threshold is on (ADR-004 D2). |
| Data | `GET /listings/{id}`; settings `GET /settings/listings` (threshold); locales and currencies (**A-9**). |
| Actions | `PATCH /listings/{id}` (If-Match); `PUT|DELETE /listings/{id}/translations/{locale}`. |
| Dependencies | MoneyInput, TranslationEditor (side by side on desktop, tabs on mobile), ConflictDialog. |
| Security | The 10% rule is shown before saving when it applies; the API decides. Arabic fields set `dir="rtl"` and `lang="ar"` on the field only. |

### L-5 Publish checklist, publish and unpublish

```text
┌ Publish LST-2026-000033? ─────────────────────────────────────────┐
│ ✓ Unit available        ✓ Mandate valid to 30 Jun                 │
│ ✓ 14 photos (8 needed)  ✓ Floor plan                              │
│ ✗ Seller identity not verified (company rule) — Phase 5 contacts  │
│ ✗ "Gas safety certificate" missing                                 │
│ Publishing makes the listing "Available" and marks it published.  │
│                                         [Cancel] [Publish] (off)   │
└───────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Show what stops a listing going live, then publish it; or take it off the market without closing it. |
| Roles | `listing.publish` covering the listing (agents: own; SM, PM office; Own, Adm all). |
| Data | Blockers: **A-10** readiness endpoint (today they come only as `publish-blocked` errors with `errors[]` codes `archived`, `unavailable`, `expired`, `photos`, `floor-plan`, `unverified`, `missing`). |
| Actions | `POST /listings/{id}/publish`, `POST /listings/{id}/unpublish` (If-Match). Each blocker links to where it is fixed (G-6 photos, G-4 floor plan, L-4 mandate). |
| Dependencies | PublishChecklist, L-3, G-6. |
| Security | The button is disabled with the reason next to it, not hidden. |

### L-6 Change status

```text
┌ Change status · Available ─────────────────────────┐
│ New status ( ) Reserved  ( ) Under contract         │
│            ( ) Withdrawn                            │
│ Reason [                                        ]   │
│ (required for withdrawn and for going back)         │
│                              [Cancel] [Change]      │
└─────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Move a listing through its lifecycle. |
| Roles | `listing.publish` covering the listing. |
| Data | Allowed next statuses from the listing type and status (TRANSITIONS: available → reserved, under contract, withdrawn; reserved → available, under contract, withdrawn; under contract → available, sold/rented, withdrawn). |
| Actions | `POST /listings/{id}/status-transitions` (If-Match). |
| Dependencies | L-3. |
| Security | Terminal statuses (sold, rented, withdrawn) need a confirmation that names the effect: the listing closes and can only be relisted (D3). |

### L-7 Reassign agent

| | |
|---|---|
| Purpose | Give a listing to another agent (ADR-004 D4). |
| Roles | `listing.update` with office or all scope (managers and admins only). |
| Data | Eligible agents in the listing's office (**A-2**). |
| Actions | `POST /listings/{id}/assign` (If-Match), optional note. |
| Dependencies | PeoplePicker. |
| Security | Not rendered for agents. Audited by the API. |

```text
┌ Reassign LST-…-033 ────────────────────┐
│ Current agent: Ama Boateng              │
│ New agent* [Search staff in Osu… ▾]     │
│                     [Cancel] [Reassign] │
└─────────────────────────────────────────┘
```

### L-8 Relist

```text
┌ Relist Flat 1A for rent ───────────────────────────┐
│ Starts a new draft from LST-…-033 (rented 2 Mar).  │
│ Copies terms, text and the selected photos.         │
│ Agent [Ama Boateng ▾]                               │
│                              [Cancel] [Relist]      │
└─────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Market a unit again after a campaign closed (D3). |
| Roles | `listing.create` covering the unit's office. |
| Data | Source listing. |
| Actions | `POST /listings/{id}/relist`; opens the new draft. |
| Dependencies | L-3. |
| Security | Fails with a link if an open listing of that type already exists for the unit. |

### L-9 Price and status history

```text
┌ Price & status ───────────────────────────────────────────┐
│ Price                                                      │
│ 3 Mar  GH₵6,500 → GH₵6,000  −7.7%  Ama  "Owner agreed"     │
│ 1 Feb  GH₵7,000 → GH₵6,500  −7.1%  Kofi (approved) "…"     │
│ Status                                                     │
│ 1 Feb  Draft → Available   Ama                             │
└────────────────────────────────────────────────────────────┘
History tab: full audit feed (GET /listings/{id}/history).
```

| | |
|---|---|
| Purpose | Show how the price and status changed and who did it. |
| Roles | `listing.view`. |
| Data | `GET /listings/{id}/price-history`, `/status-history`, `/history`. |
| Actions | Page through history. |
| Dependencies | AuditHistory, MoneyText. |
| Security | Read only. |

### L-10 Listing settings

```text
┌ Listing rules ────────────────────────────────────── [Save] ┐
│ Price reductions on live listings                            │
│ (•) No approval   ( ) Approval above [10] %                  │
│ ☐ Seller identity must be verified before publishing          │
│ Minimum photos to publish [8] (blank = no minimum)           │
│ ☐ Floor plan required to publish                              │
└──────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Company rules for listings (ADR-004 D2, M4 rules). |
| Roles | View: `listing.view`; change: `settings.manage` (Own, Adm). |
| Data | `GET /settings/listings`. |
| Actions | `PUT /settings/listings`. |
| Dependencies | — |
| Security | Changes are audited by the API (`settings.listings_updated`). |

---

## Gallery and floor plans (issue #7)

### G-1 Property media tab

```text
┌ Media ─────────────── [Photos 22] [Plans 3] [Videos & tours 2] [Archived] ┐
│ [+ Upload photos]  [+ Add video or tour]      Storage 3.1 of 25 GB  ▮▯▯▯   │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                         │
│ │ img  │ │ img  │ │ ⏳    │ │ ✗    │ │ img  │ │ img  │                         │
│ │      │ │      │ │Proces│ │Reject│ │      │ │      │                         │
│ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘                         │
│ Kitchen  Living  sing…    ed: not  Bedroom 1 Front                            │
│ ⋯        ⋯                an image ⋯         ⋯                                │
│ Order: [Sort order ▾]   Select ☐   Bulk: [Archive]                            │
└──────────────────────────────────────────────────────────────────────────────┘
Tile: thumbnail (signed URL), caption or room label, status (Ready / Processing /
Rejected with reason), ⋯ menu: Details · Move earlier · Move later · Archive.
```

| | |
|---|---|
| Purpose | Manage all photos, plans, videos and tours of a property in one place. |
| Roles | View: `property.view` covering the property (all staff with access, incl. Tech). Upload and edit: `property.update`. Archive and restore: `property.archive`. |
| Data | `GET /properties/{id}/media?filter[mediaType]=…&filter[processingStatus]=…&filter[unitId]=…` (each item has variant URLs signed for 15 min, processing status, rejection reason); `GET /settings/storage`. |
| Actions | Upload (G-2); add link (G-5); details (G-3); reorder by `PATCH /media/{id}` `sortOrder` (move earlier/later or "Move to position"); archive `POST /media/{id}/archive` (If-Match). |
| Dependencies | MediaGrid, MediaTile, ReorderControls, StorageMeter, G-2, G-3, G-5, G-7. |
| Security | Images are loaded only through the signed URLs in the response; the client never builds storage URLs. URLs are not cached past their expiry or across company switches; the grid refetches when they expire. Rejected items show the reason but no preview (nothing unsafe is ever served). |

### G-2 Upload panel

```text
┌ Upload photos ─────────────────────────────────────────────┐
│ Drop files here or [Choose files] [Take photo] (mobile)     │
│ JPEG, PNG or WebP up to 25 MB · PDF up to 20 MB (plans)     │
│ Attach to listing: [None ▾]                                 │
├─────────────────────────────────────────────────────────────┤
│ kitchen.jpg   4.2 MB  ▮▮▮▮▮▮▮▯▯ Uploading 70%     [Cancel]  │
│ living.jpg    3.9 MB  ✓ Uploaded · Scanning and processing… │
│ plan.pdf      1.1 MB  ✗ Not allowed for photos (use Plans)  │
│ big.png      31.0 MB  ✗ Over 25 MB                           │
│ ⓘ Location data is removed from every photo.                │
│ 2 of 4 uploaded · You can leave this page; processing goes on│
└─────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Upload one or many files safely, with clear progress and reasons for any failure. |
| Roles | `property.update` covering the property; or `property.view` plus `listing.update` when attaching to a listing. |
| Data | Per file: `POST /media/uploads` (type, name, MIME, size, SHA-256) → signed PUT; `PUT` to storage; `POST /media/uploads/{id}/confirm`; then poll `GET /media/{id}` until ready or rejected. Quota from the request's 403 `quota-exceeded` problem. |
| Actions | Choose or drop files; take a photo (mobile `capture`); cancel an upload; retry a failed one. |
| Dependencies | UploadQueue, file hashing in the browser (Web Crypto), G-1. |
| Security | Type and size are checked in the browser for speed and again by the API and the worker (sniffing, malware scan, metadata stripping). Files go straight to storage on a signed URL bound to type and size; the API never receives the bytes. Uploads to another company's property are impossible because the session is created by the API for the property the user may edit. No preview from the local file is shown after a rejection. |

### G-3 Media details drawer

```text
┌ Photo · Kitchen ──────────────────────────────── ✕ ┐
│ ┌──────────────────────────────┐                   │
│ │          large image         │                   │
│ └──────────────────────────────┘                   │
│ Caption [Open-plan kitchen with island         ]   │
│ Alt text [Kitchen with white units and island  ]   │
│   (read aloud to blind visitors; strongly advised) │
│ Room [Kitchen ▾]  Floor [Ground]                   │
│ Used in listings: LST-…-033 (cover), LST-…-040     │
│ 4,000 × 3,000 · 2.1 MB stored · Uploaded 3 Mar, Ama│
│ [Save]   [Archive]   ⋯ Legal hold · Delete now     │
└────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Describe a photo or plan for buyers and screen-reader users, and manage its lifecycle. |
| Roles | View: `property.view`; edit: `property.update`; archive/restore: `property.archive`; legal hold and delete now: `property.archive` with all scope (Own, Adm). |
| Data | `GET /media/{id}`. |
| Actions | `PATCH /media/{id}` (If-Match: caption, alt text, room, floor label, sort order); archive/restore; `POST /media/{id}/legal-hold` (reason); `POST /media/{id}/purge` (archived and not on hold; ConfirmDialog naming that it cannot be undone). |
| Dependencies | Drawer, ConfirmDialog, G-7. |
| Security | Delete now and legal hold are shown only to Own/Adm; delete requires typing the word DELETE (destructive, irreversible). Original file name is shown, never the storage key. |

### G-4 Floor plans and documents

```text
┌ Plans ──────────────────────── [+ Upload floor plan] [+ Site plan] [+ Brochure] ┐
│ Floor        Item                    Pages  Status     Listings      ⋯         │
│ Ground       Ground floor plan (PDF) 1      Ready      LST-…-033     ⋯         │
│ First        First floor plan (PNG)  —      Ready      —             ⋯         │
│ Site         Site plan (PDF)         3      Processing —             ⋯         │
│ Brochure     Sales brochure (PDF)    12     Ready      —             ⋯         │
└────────────────────────────────────────────────────────────────────────────────┘
Viewer: first-page preview image + [Download PDF] (signed, attachment) · zoom in/out
```

| | |
|---|---|
| Purpose | Keep floor plans, site plans and brochures in order by floor and use them in listings. |
| Roles | As G-1. |
| Data | `GET /properties/{id}/media?filter[mediaType]=floor_plan,site_plan,brochure`; preview variants; signed download URL with the original file name. |
| Actions | Upload (G-2 in plan mode); set floor label (G-3); add to a listing (G-6). |
| Dependencies | FloorPlanViewer (image with zoom and keyboard pan), G-2, G-3. |
| Security | PDFs are never rendered in the browser's PDF engine inside the app; the preview is our generated image, and the PDF downloads as an attachment. Rejected PDFs (encrypted, active content) show the reason. |

### G-5 Add video or virtual tour

```text
┌ Add video or tour ───────────────────────────────────┐
│ Link* [https://www.youtube.com/watch?v=…         ]   │
│ Accepted: YouTube, Vimeo, Matterport                  │
│ Type (•) Video ( ) Virtual tour   Caption [        ]  │
│ ✓ Recognised: YouTube video                            │
│                                  [Cancel] [Add]        │
└───────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Attach external video and 3D tours (M-D2: no video upload). |
| Roles | `property.update`. |
| Data | — |
| Actions | `POST /properties/{id}/media/links`. |
| Dependencies | G-1. |
| Security | The app does not embed third-party players in the staff workspace (no third-party scripts or cookies); it shows the provider name and opens the link in a new tab with `rel="noopener noreferrer"`. The API stores only the canonical link it rebuilt. |

### G-6 Listing gallery editor

```text
┌ Gallery · LST-2026-000033 ───────────────────── [Cancel] [Save gallery] ┐
│ In this listing (14 / 60 photos, 1 / 10 plans)  │ Property media          │
│ 1 ★ Cover  [img] Front           ↑ ↓ ✕          │ ☐ [img] Kitchen 2       │
│ 2          [img] Kitchen         ↑ ↓ ✕          │ ☐ [img] Garden          │
│ 3          [img] Living          ↑ ↓ ✕          │ ☐ [img] Bathroom        │
│ …  Move to position [ 3 ] [Move]                │ ☐ Ground floor plan     │
│ Plans: 1 Ground floor plan       ↑ ↓ ✕          │ [Add selected ›]        │
│ Set cover: select a photo, then [Make cover]    │ Processing items cannot │
│                                                 │ be added until ready    │
└─────────────────────────────────────────────────┴─────────────────────────┘
⚠ The cover has no alt text. Add it so screen-reader users know what it shows (not a publishing rule today — open issue U-6).
```

| | |
|---|---|
| Purpose | Choose which of the property's media appear in a listing, their order and the cover (M-D5). |
| Roles | View `listing.view`; change `listing.update` covering the listing. |
| Data | `GET /listings/{id}/media`; `GET /properties/{id}/media` for the picker. |
| Actions | `PUT /listings/{id}/media` with the whole ordered selection and the cover (If-Match on the listing). Limits 60 photos and 10 plans; first photo becomes cover by default. |
| Dependencies | ReorderList (drag plus keyboard and buttons), CoverSelector, G-1. |
| Security | Only ready, non-archived media of the same property can be added (the API checks). Saving replaces the whole selection in one request, so two people editing see a 412 rather than a merge. |

### G-7 Archived media

```text
┌ Archived ─────────────────────────────────────────────────────┐
│ Archived items are deleted for good 90 days after archiving.   │
│ Item          Archived      Deleted on    Hold    ⋯            │
│ old-front.jpg 2 Mar · Ama   31 May        —       Restore      │
│ lease-plan.pdf 1 Feb · Kofi  — (on hold)  ⚖ Legal  Restore     │
└───────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Recover media archived by mistake within 90 days; see what will be deleted and when (M-D8). |
| Roles | View `property.view`; restore `property.archive`; delete now and legal hold: Own, Adm (`property.archive`, all). |
| Data | `GET /properties/{id}/media?filter[archived]=true` (`purgeAfter`, legal hold fields). |
| Actions | Restore, legal hold, delete now (G-3 rules). |
| Dependencies | G-3. |
| Security | Archived items show no listing usage (archiving removed them from listings). |

### G-8 Storage usage

```text
┌ Storage ───────────────────────────────────────────────┐
│ Professional plan · 250 GB                              │
│ Used 41.2 GB · Reserved for uploads 0.3 GB   ▮▮▯▯▯▯▯▯▯▯  │
│ Archived items count until they are deleted.            │
└─────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Show how much of the plan's storage is used (M-D4). |
| Roles | `property.view` (all staff); upgrade link for Own only (billing is Phase 14 — link hidden in Phase 4). |
| Data | `GET /settings/storage`. |
| Actions | — |
| Dependencies | StorageMeter. |
| Security | Company totals only; no per-user breakdown. |

---

## Notes

### N-1 Notes tab

```text
┌ Notes ─────────────────────────────────────────────── [+ Add note] ┐
│ [All] [Pinned] [Access] [Viewing] [Maintenance] [Legal] [Owner]    │
│ Unit [All ▾]  Audience [All ▾]  Author [All ▾]  [Archived ▾]       │
├────────────────────────────────────────────────────────────────────┤
│ 📌 Pinned (2 of 5)                                                  │
│ Access · Internal · Ama B. · 3 Mar · edited                 ⋯      │
│ Gate sticks; lift and push.                                          │
│ Owner · Landlord-visible ✉ · Kofi O. · 1 Mar                ⋯      │
│ Owner prefers email for approvals.                                   │
├────────────────────────────────────────────────────────────────────┤
│ General · Tenant-visible (Flat 1A) 👤 · Kofi O. · 28 Feb     ⋯      │
│ Bins go out on Tuesday.                                              │
│ Viewing · Internal · Yaw A. · 27 Feb                         ⋯      │
│ Second viewing went well; asked about parking.                      │
│ [Load more]                                                          │
└────────────────────────────────────────────────────────────────────┘
⋯: Edit · Pin/Unpin · History · Archive · Redact (managers)
```

| | |
|---|---|
| Purpose | Read and add what staff need to know about a property (PRP-07). |
| Roles | View `property_note.view` (Own, Adm, Acc all; SM, PM, Ag office). Add `property_note.create` (not Acc). Manage `property_note.manage` (Own, Adm all; SM, PM office). Tech, landlords and tenants: none. |
| Data | `GET /properties/{id}/notes?filter[pinned]=true` and `GET /properties/{id}/notes` (filters `category`, `visibility`, `unitId`, `authorId`, `archived`; sort `createdAt`). |
| Actions | Add (N-2); edit own or any with manage (N-2); pin/unpin (max 5); history (N-3); archive/restore and redact (N-4). |
| Dependencies | NoteCard, AudienceBadge, N-2, N-3, N-4. |
| Security | Note text is shown as plain text (never HTML or Markdown). The audience badge is text plus icon. A redacted note shows "[Redacted]" and who redacted it. Portal visibility is shown as a future audience ("will be visible to the landlord when the landlord portal opens") until issue #12. |

### N-2 Note composer and editor

```text
┌ Add note ─────────────────────────────────────────────────────┐
│ [                                                            ] │
│ [                                                            ] │
│ 0 / 10,000                                                     │
│ Category [Access ▾]   Unit [Whole property ▾]   ☐ Pin          │
│ Who can read it: (•) Staff only                                │
│                  ( ) Staff and landlord   (managers only)      │
│                  ( ) Staff and the tenants of a unit (choose a unit)│
│ ⚠ Do not write alarm codes or passwords in notes.             │
│                                          [Cancel] [Save note]  │
└────────────────────────────────────────────────────────────────┘
Choosing landlord or tenant opens: "This note will be visible to the
landlord of Osu Court in the landlord portal. Continue?" [Back] [Share]
```

| | |
|---|---|
| Purpose | Write or change a note with the right category, unit and audience (L-D8). |
| Roles | Create: `property_note.create`. External audiences: `property_note.manage` only (options shown disabled with "managers only" to others). Editing someone else's note: manage. |
| Data | Units of the property (for the unit choice). |
| Actions | `POST /properties/{id}/notes` (Idempotency-Key); `PATCH /property-notes/{id}` (If-Match). |
| Dependencies | NoteComposer, ConfirmDialog, UnitSelect. |
| Security | Tenant audience requires a unit (form and API). The external-audience confirmation names who will see the note. Text is trimmed at the end only; never interpreted as markup. |

### N-3 Note history

```text
┌ History · note by Ama B. ───────────────────────── ✕ ┐
│ Current (v4) · 3 Mar 10:14 · Ama B.                   │
│ Gate sticks; lift and push.                           │
│ v2 · written 2 Mar 16:00 by Ama B. · replaced 3 Mar   │
│ Gate is stiff.                                        │
│ v1 · written 1 Mar 09:00 by Ama B. · replaced 2 Mar   │
│ Gate.                                                 │
│ [Older…]                                              │
└───────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | See earlier wording of a note (L-D7). |
| Roles | The author and `property_note.manage` holders. |
| Data | `GET /property-notes/{id}/revisions?limit=&before=`. |
| Actions | Page back. |
| Dependencies | RevisionList. |
| Security | Others never see the History action (the API returns 403). Redacted revisions show "[Redacted]". |

### N-4 Archive, restore and redact note

```text
┌ Archive note? ───────────────────────┐   ┌ Redact note? ─────────────────────────┐
│ Reason* [Out of date            ]    │   │ The text of this note and all earlier │
│ Archived notes stay in "Archived".   │   │ versions is replaced with [Redacted]. │
│              [Cancel] [Archive]      │   │ This cannot be undone.                │
└──────────────────────────────────────┘   │ Reason* (•) Erasure request            │
                                           │         ( ) Sensitive data             │
                                           │         ( ) Other                      │
                                           │              [Cancel] [Redact]         │
                                           └────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Tidy notes (archive) and remove personal data (redact). |
| Roles | Archive/restore: author with create, or manage. Redact: manage only. |
| Data | Note version. |
| Actions | `POST /property-notes/{id}/archive|restore|redact` (If-Match). |
| Dependencies | ConfirmDialog. |
| Security | Redaction is irreversible and described as such; the reason is a category, so no personal data is typed into the audit log. |

---

## Key register

### K-1 Property keys tab

```text
┌ Keys ─────────────────────────────────────────── [+ Add key set] ┐
│ Tag     Unit      Contents             Status         Holder · due │
│ K-100   Flat 1A   2 door, 1 gate fob   Checked out ⚠  Yaw A. · was due│
│                                                       today 14:00   │
│ K-101   —         Owner's set          With owner     —            │
│ K-102   Flat 1C   1 door               In office      —            │
│ Row action: [Check out] / [Check in] · ⋯ Lost · Found · Edit ·     │
│ History · Retire                                                    │
│ [Show retired]                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Know where every key set for this property is and move keys. |
| Roles | View `key.view` (Own, Adm all; SM, PM, Ag office). Move `key.issue` (same). Add, edit, retire `key.manage` (Own, Adm, SM, PM). |
| Data | `GET /properties/{id}/key-sets` (status, holder, due back, overdue flag). |
| Actions | K-3, K-4, K-5, K-6. |
| Dependencies | KeySetRow, StatusLabel, DueBackText (with time zone), K-3…K-6. |
| Security | Holder names only; no contact details on this screen. Overdue is text plus icon, not colour alone. |

### K-2 Key register (company)

```text
┌ Keys ──────────────────────────────────────────────────────────────┐
│ [Out (6)] [Overdue (2)] [All] [Lost] [Retired]   Holder [Anyone ▾]  │
│ Sort: Due back ↑                                                    │
│ Tag    Property · unit         Holder        Out since   Due back   │
│ K-100  Osu Court · Flat 1A     Yaw A.        Mon 09:12   Today 14:00 ⚠│
│ K-207  Labone Villa            Kwame (contact) Tue 10:00 Fri 17:00   │
│ [Check in]                                                         │
└────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | See every key that is out, chase overdue keys. |
| Roles | `key.view` with scope (office or all). |
| Data | `GET /key-sets?filter[status]=checked_out&filter[overdue]=…&filter[holderMembershipId]=…&sort=dueBackAt`. |
| Actions | Check in (K-4), open the property (P-2 Keys tab), history (K-6). |
| Dependencies | DataTable, PeoplePicker (filter; **A-2**). |
| Security | Office scope applies before counts in tab labels. |

### K-3 Check keys out

```text
┌ Check out K-100 · Osu Court Flat 1A ─────────────────────┐
│ Given to (•) Staff member [Yaw Adjei ▾]                   │
│          ( ) Contact      [Search contacts… ] (Phase 5)   │
│ Due back [Today ▾] [17:00]  Africa/Accra                  │
│ Note [For 3pm viewing                              ]      │
│                                    [Cancel] [Check out]   │
└───────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Record who took the keys and when they are due back. |
| Roles | `key.issue` covering the property. |
| Data | Active staff (**A-2**); contacts (**A-3**, Phase 5 contacts API — option disabled until it exists). |
| Actions | `POST /key-sets/{id}/check-out` (If-Match). |
| Dependencies | PeoplePicker, DateTimeField with time zone. |
| Security | Due-back time is entered and shown in the property's time zone and sent as an ISO instant. Only active staff are offered (the API refuses others). |

### K-4 Check in, report lost, mark found, retire

```text
┌ Check in K-100 ──────────────────┐  ┌ Report K-100 lost? ─────────────────┐
│ Held by Yaw A. since Mon 09:12    │  │ Who had them: Yaw A.                │
│ Note [All keys returned       ]   │  │ What happened* [Lost on site     ]  │
│          [Cancel] [Check in]      │  │ ⓘ Consider changing the locks.       │
└───────────────────────────────────┘  │          [Cancel] [Report lost]     │
                                       └─────────────────────────────────────┘
┌ Retire K-102? ─────────────────────────────────────┐
│ Retired sets cannot be checked out. The tag number │
│ becomes free for a new set.                         │
│ Reason* [Locks changed                           ]  │
│                              [Cancel] [Retire]      │
└─────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Close the loop on every key movement. |
| Roles | Check in, lost, found: `key.issue`. Retire: `key.manage`. |
| Data | Key set version, holder. |
| Actions | `POST /key-sets/{id}/check-in|report-lost|found|retire` (If-Match). Disallowed moves are not offered (e.g. no check-in for a set in the office); if offered by a stale screen, the API's reason is shown. |
| Dependencies | ConfirmDialog. |
| Security | Retire is blocked while keys are out (shown as a reason). |

### K-5 Add and edit key set

```text
┌ Add key set · Osu Court ───────────────────────────┐
│ Tag number* [K-103]  (unique among active sets)     │
│ Unit [Whole property ▾]                             │
│ Contents [2 front door, 1 gate fob             ]    │
│ Where are they now? (•) In the office ( ) With owner│
│                              [Cancel] [Add]          │
└─────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Register a key set or correct its details. |
| Roles | `key.manage`. |
| Data | Units of the property. |
| Actions | `POST /properties/{id}/key-sets` (Idempotency-Key); `PATCH /key-sets/{id}` (If-Match). Duplicate tag → 409 shown on the field. |
| Dependencies | UnitSelect. |
| Security | — |

### K-6 Key movement history

| | |
|---|---|
| Purpose | Who held the keys, when, and what happened. |
| Roles | `key.view`. |
| Data | `GET /key-sets/{id}/movements` (paged, newest first). |
| Actions | Page back. |
| Dependencies | Timeline. |
| Security | Holder names only. |

```text
┌ K-100 history ───────────────────────────── ✕ ┐
│ Wed 16:02 Checked in by Ama B. "All returned"  │
│ Mon 09:12 Checked out to Yaw A. due Wed 14:00  │
│ 2 Mar    Found · recorded by Kofi O.           │
│ 1 Mar    Lost (held by Kwame, contact)         │
└────────────────────────────────────────────────┘
```

---

## Location and maps

### M-1 Location picker (inside P-3)

```text
┌ Location ─────────────────────────────────────────────────────────┐
│ Find the address [12 Oxford Street, Osu      ] [Search]           │
│ Suggestions                                                        │
│  ○ 12 Oxford Street, Osu, Accra      (exact building)             │
│  ○ Osu, Accra                         (area only)                 │
│ ┌ map ───────────────────────────────────────────┐                │
│ │                    ✚ pin (drag, or click map)   │  [+] [−]       │
│ │                                                 │  [Satellite: off]│
│ └─────────────────────────────────────────────────┘                │
│ Latitude [5.557100]  Longitude [-0.181800]   [Use my location]    │
│ How was it found: Placed on map by you · Accuracy [Building ▾]     │
│ ⚠ The address changed after this pin was placed. Check the pin.    │
│ [Remove location]                                                  │
└────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Confirm the property's exact position (L-D2: users confirm every stored location). |
| Roles | Whoever edits the property (`property.update` or `property.create`). Suggestions need `property.update` (API). |
| Data | `GET /geocoding/suggestions?q=&countryCode=&near=&language=` (503 `geocoding-unavailable` → pin-only mode with a note; 429 → "Too many searches, try again in N s"). Map tiles from our own host (L-D3). |
| Actions | Choose a suggestion (sets `geocodeSource: geocoder` and its accuracy, moves the pin); drag or click to place (`manual_pin`); type coordinates; use device location (browser permission; position never stored unless confirmed); remove (`latitude: null, longitude: null`). Saved with the property (P-3). |
| Dependencies | MapView, LocationPicker, CoordinateFields, P-3. |
| Security | The point is checked in the browser against the country box and again by the API (`outside-country`, `invalid-coordinates`). Device location is used once and not sent anywhere else. Address search text is never logged by the API; the client does not keep a history of searches either. |

### M-2 Listing map search

```text
┌ Listings — Map ────────────────────────── [List | Map] ────────────┐
│ [Rent|Sale] [Status ▾] [Price ▾] [Beds ▾]   Area: [Radius] [Draw] [Clear]│
├────────────────────────────┬───────────────────────────────────────┤
│ 48 listings in this area   │ ┌ map ────────────────────────────┐   │
│ Sort: Distance ▾           │ │  ⑫        ●  ●                  │   │
│ ┌────────────────────────┐ │ │      ⑤          ● (selected)    │   │
│ │ [img] 2-bed, Osu       │ │ │   ◯ radius 2 km                 │   │
│ │ GH₵6,000/mo · 0.4 km   │ │ │                    ㊿            │   │
│ │ Available              │ │ │                                  │   │
│ └────────────────────────┘ │ └──────────────────────────────────┘   │
│ ┌────────────────────────┐ │ [Search this area] (after panning)     │
│ │ [img] Shop, Labone …   │ │ Zoom in to see individual listings    │
│ └────────────────────────┘ │ when clusters are shown               │
│ [Load more]                │ © OpenStreetMap contributors          │
└────────────────────────────┴───────────────────────────────────────┘
Radius tool: click centre, choose 0.5–50 km. Draw tool: click up to 100 points,
Enter to finish, Esc to cancel; keyboard: arrow keys move a crosshair, Space adds a point.
```

| | |
|---|---|
| Purpose | Find listings by area (PRP-08). |
| Roles | `listing.view` with scope. |
| Data | Map layer: `GET /listings/map?filter[bbox]=…` + the same filters (points, or clusters above 500). List: `GET /listings` with the same filters plus `near`/`radius` or `polygon`, `sort=distance`. 429 and 503 `search-timeout` shown as notices with a suggestion to zoom in. |
| Actions | Pan and zoom (refreshes on "Search this area", not on every move, to save requests); radius; draw; select a pin (highlights the card and vice versa); open a listing; zoom into a cluster (fits its bounds). |
| Dependencies | MapView (MapLibre), MarkerLayer, ClusterLayer, RadiusTool, PolygonTool, MapResultList, L-1 filters. |
| Security | Results and cluster counts are already scope-filtered by the API. Map tiles come from our own host. Cover thumbnails load through `GET /media/{id}` signed URLs, requested only for visible cards. |

### M-3 Property map

| | |
|---|---|
| Purpose | See the portfolio on a map; find properties without a confirmed location. |
| Roles | `property.view` with scope. |
| Data | `GET /properties/map?filter[bbox]` and `GET /properties` with location filters; side panel "No location (n)" uses `filter[hasLocation]=false`. |
| Actions | As M-2; "Fix location" opens P-3 at the location section. |
| Dependencies | As M-2. |
| Security | As M-2. |

```text
┌ Properties — Map ─────────────────────────────── [List | Map] ┐
│ [Type ▾] [Managed ▾] Area: [Radius] [Draw]   No location: 7 › │
├──────────────────────────┬─────────────────────────────────────┤
│ Property list (cards)    │ map with property pins and clusters │
└──────────────────────────┴─────────────────────────────────────┘
```

---

## Mobile layouts (≤ 767 px)

### X-1 Property on mobile

```text
┌─────────────────────────────┐
│ ‹ Properties        ⋯        │
│ Osu Court                    │
│ PRP-…-014 · Managed          │
│ 12 Oxford St, Osu, Accra     │
│ [Directions] [Map]           │
├─────────────────────────────┤
│ 📌 Gate sticks; lift & push  │
│ Keys: K-100 out (Yaw) ⚠     │
├─────────────────────────────┤
│ [📷 Add photos] [✎ Add note]│
│ [🔑 Keys]                    │
├─────────────────────────────┤
│ Units 12 ›  Listings 3 ›     │
│ Media 24 ›  Notes 8 ›        │
│ Activity ›                   │
├─────────────────────────────┤
│ Props  Listings  Map  Keys ☰ │
└─────────────────────────────┘
```

| | |
|---|---|
| Purpose | Field use: reach the property, see pinned notes and keys, add photos and notes. |
| Roles | As P-2. |
| Data | As P-2. |
| Actions | Directions (opens the device maps app with the coordinates); add photos (X-2); add note (X-3); keys (X-4); sections open as full pages. |
| Dependencies | P-2 data, X-2, X-3, X-4. |
| Security | "Directions" hands the coordinates to the user's own maps app only on tap. |

### X-2 Add photos on mobile

```text
┌─────────────────────────────┐
│ ‹ Osu Court   Add photos     │
│ [📷 Take photo] [🖼 Choose]  │
│ Room [Kitchen ▾]             │
│ ┌────┐┌────┐┌────┐           │
│ │img ││ ⏳ ││ ✓  │           │
│ └────┘└────┘└────┘           │
│ 2 uploading on mobile data   │
│ ☐ Wait for Wi-Fi             │
│ [Done]                       │
└─────────────────────────────┘
```

| | |
|---|---|
| Purpose | Capture and upload photos on site. |
| Roles | `property.update`. |
| Data | As G-2. |
| Actions | As G-2; room label applied to the batch. |
| Dependencies | G-2 logic. |
| Security | As G-2. Photos stay in the upload queue only while the page is open; nothing is stored on the device by the app (no offline sync in Phase 4). |

### X-3 Note on mobile

| | |
|---|---|
| Purpose | Add a note in the field. |
| Roles | As N-2. |
| Data | As N-2. |
| Actions | As N-2 (full-screen composer; audience choices identical). |
| Dependencies | N-2. |
| Security | As N-2; the draft is kept in memory and restored after an expired session sign-in, never written to device storage. |

```text
┌─────────────────────────────┐
│ ✕ New note        [Save]     │
│ [text area…]                 │
│ Category [General ▾]         │
│ Unit [Whole property ▾]      │
│ Who can read: Staff only ▾   │
└─────────────────────────────┘
```

### X-4 Keys on mobile

```text
┌─────────────────────────────┐
│ ‹ Keys      [Out|Overdue|All]│
│ K-100 · Osu Court Flat 1A    │
│ Yaw A. · due today 14:00 ⚠  │
│ [Check in]                   │
├─────────────────────────────┤
│ K-102 · Osu Court Flat 1C    │
│ In office                    │
│ [Check out]                  │
└─────────────────────────────┘
```

| | |
|---|---|
| Purpose | Hand out and take back keys from the front desk or on site. |
| Roles | As K-1/K-2. |
| Data | As K-2. |
| Actions | Check out (K-3 as a full page), check in (K-4). |
| Dependencies | K-2, K-3, K-4. |
| Security | As K-2. |

### X-5 Map and "near me" on mobile

```text
┌─────────────────────────────┐
│ Listings      [Map | List]   │
│ [Near me] [Radius 2 km ▾]   │
│ ┌ map ─────────────────────┐ │
│ │   ●  ⑤   ◉ you          │ │
│ └──────────────────────────┘ │
│ ▔▔ 12 listings (drag up) ▔▔ │
│ 2-bed, Osu · 0.4 km · GH₵6k │
└─────────────────────────────┘
```

| | |
|---|---|
| Purpose | Find nearby listings while out with a client. |
| Roles | `listing.view`. |
| Data | As M-2, with `near` from the device position. |
| Actions | Near me (asks for location permission each session); radius; switch to list; open a listing. The bottom sheet has a "Show list" button, not only a drag gesture. |
| Dependencies | M-2. |
| Security | Device position is used only for the request and not stored or logged by the app. |

---

## Tablet layouts (768–1023 px)

### T-1 Field visit (updated from Phase 3 03 §4)

```text
┌────────────────────────────────────────────┐
│ ‹ Osu Court · Flat 1A                       │
│ [Call] [Directions] [Add note] [Keys K-100] │
├────────────────────────────────────────────┤
│ Visit checklist                             │
│ [ ] Confirm access                          │
│ [ ] Capture condition photos  → X-2 flow    │
│ [ ] Record client feedback   → note (Viewing)│
│ [ ] Return keys              → K-4 check-in │
│ Notes [text area………………………………………]       │
│ [Save visit]                       [More ▾] │
└────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Do a site visit end-to-end with the Phase 4 features (photos to the gallery, feedback as a Viewing note, keys back). |
| Roles | Ag, PM, SM with the permissions of each step. |
| Data | P-2, K-1. |
| Actions | Each checklist step opens its screen; "Save visit" saves the note (category Viewing). The checklist itself is not stored in Phase 4 (no API; viewings are Phase 6). |
| Dependencies | X-2, N-2, K-4. |
| Security | As each step. |

### T-2 Listing map on tablet

| | |
|---|---|
| Purpose | M-2 on tablet. |
| Roles | As M-2. |
| Data | As M-2. |
| Actions | Map full width with a collapsible list panel (landscape: side; portrait: bottom); tools as M-2 with touch-sized buttons (44 px). |
| Dependencies | M-2. |
| Security | As M-2. |

```text
Landscape: [ list 40% | map 60% ]    Portrait: [ map ] over [ list sheet ]
```

### T-3 Gallery ordering by touch

```text
┌ Gallery · LST-…-033 ──────────────── [Save] ┐
│ 1 ★ [img] Front     [↑][↓][⋯]                 │
│ 2   [img] Kitchen   [↑][↓][⋯]                 │
│ Long-press to drag, or use the arrows.         │
└────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Reorder listing photos without precise dragging (WCAG 2.5.7). |
| Roles | As G-6. |
| Data | As G-6. |
| Actions | Arrow buttons, "Move to position", optional long-press drag. |
| Dependencies | G-6, ReorderList. |
| Security | As G-6. |

---

## Dashboards

### D-1 Property dashboard (Phase 4 panels)

```text
┌ Property dashboard ───────────── [Osu office ▾] [Rent | Sale | Both] Updated 09:42 ⟳ ┐
│ ┌ Listings needing attention ─────────────┐ ┌ Keys ─────────────────────────────┐  │
│ │ Can't publish (blockers)          4 →   │ │ Overdue                    2 →   │  │
│ │ Fewer photos than required        3 →   │ │ Out now                    6 →   │  │
│ │ No floor plan (required)          2 →   │ │ Reported lost              1 →   │  │
│ │ Mandate expires ≤ 14 days         2 →   │ └───────────────────────────────────┘  │
│ │ Cover photo has no alt text       5 →   │ ┌ Locations ────────────────────────┐  │
│ │ Price unchanged 60 days           3 →   │ │ Properties with no location 7 →  │  │
│ └─────────────────────────────────────────┘ │ Pins to check (address changed) 2→│  │
│ ┌ Under maintenance ──────────────────────┐ └───────────────────────────────────┘  │
│ │ Unit       Since   Property      →      │ ┌ Media ────────────────────────────┐  │
│ │ Flat 1C    6 d     Osu Court            │ │ Uploads rejected (7 days)   3 →   │  │
│ └─────────────────────────────────────────┘ │ Storage 41 of 250 GB              │  │
│                                             └───────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────┘
Not shown in Phase 4: Vacant units and Occupancy (need leases, Phase 7); "No viewing in 21 days"
(needs viewings, Phase 6); "Missing required document" (documents module).
```

| | |
|---|---|
| Purpose | What in the property book needs attention today (Phase 3 06 §3, limited to data Phase 4 owns). |
| Roles | Own, Adm (all offices); SM, PM (office). Not Ag (agents use My day), not Acc, not Tech. |
| Data | **API gap A-5**: one endpoint per panel (Phase 3 05 §8.3). Every count links to a filtered list that exists: listings (`filter[status]`, `mandateExpiresOn`), keys (`filter[overdue]`), properties (`filter[hasLocation]=false`), units (availability). Panels without a list filter for their count (fewer photos, alt text, price unchanged, rejected uploads, stale pins) need list filters too — **A-5** covers both. |
| Actions | Every number opens the filtered list; refresh. |
| Dependencies | DashboardPanel, per-panel loading and error states. |
| Security | Counts are computed with the user's scope; no cross-office totals for office-scoped roles. |

### D-2 My day — keys panel

```text
┌ Keys I hold ─────────────────────────────┐
│ K-100 Osu Court Flat 1A · due today 14:00│
│ [Check in]                               │
└──────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Remind agents of keys they hold and when they are due. The rest of My day (leads, viewings) arrives with Phases 5–6. |
| Roles | Anyone with `key.view`; shows only their own holdings. |
| Data | `GET /key-sets?filter[holderMembershipId]=<me>&filter[status]=checked_out&sort=dueBackAt` (needs the membership id from **A-1**). |
| Actions | Check in (K-4). |
| Dependencies | K-4. |
| Security | Own holdings only. |
