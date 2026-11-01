# Phase 4 · Milestone 3 · Property Listings Requirements Verification Report

| | |
|---|---|
| Status | For product-owner review. No M3 code has been written. |
| Scope | Milestone 3 (Listings) of Phase 4, Property Management Module |
| Branch | `phase-4/property-management` (audit branch `audit/pre-phase-4` remains unmerged) |
| Sources checked | Phase 1 detailed specification (P1-D) §0, §1, §4, §5.2, §6, §7.1–7.2, §10–14, §17, §18; Phase 2 migrations 0004–0014 and design doc §8; Phase 3 screens doc §2.3; Phase 4 Readiness Report §2; Audit Resolution Plan §3 |

## 1. Summary

The Phase 2 schema already holds almost everything Milestone 3 needs. The tables are `listings`, `listing_translations`, `listing_status_history`, `listing_price_history`, `listing_publications` and `property_media.listing_id`. They come with constraints for:

- one open listing per unit and type
- "sold" only on sales and "rented" only on rentals
- publishing only while the listing is live

The permissions `listing.view`, `listing.create`, `listing.update`, `listing.publish` and `listing.approve_price` are seeded per role.

The review found **9 gaps** (§4). Four need a product-owner decision before M3 starts (D1–D4). Three are dependencies on later phases that M3 handles fail-closed. Two are new requirements that are not in the specification.

Legend for the "Spec" column: **M**, **S** and **C** are the P1-D priorities (Must, Should, Could). **Implied** means the feature follows from other requirements. **Not in spec** means it was raised in this review.

## 2. Coverage at a glance

| # | Feature | Spec | Planned in | Status |
|---|---|---|---|---|
| 1 | Listing creation | PRP-04 (M) | M3 | Covered |
| 2 | Listing editing | PRP-04 (M) | M3 | Covered |
| 3 | Listing publishing | PRP-04/05 (M), §7.1 step 4 | M3 (status + `is_published`) | Covered. Portal and website syndication (PRP-10, S) deferred. Permission conflict D1. |
| 4 | Listing archiving | §11.2 "D" | M3 | **Gap G2**: no `listing.archive` permission |
| 5 | Status workflow | PRP-05 (M) | M3 | Covered. Transition table needs approval (D3). |
| 6 | Price history | §7.1, note 2 | M3 | Covered. Approval threshold needs a decision (D2). |
| 7 | Status history | §13 decision, PRP-07 | M3 | Covered |
| 8 | Multi-language | Confirmed requirement, §2.3 wireframe | M3 | Covered |
| 9 | Visibility rules | §11.2 | M3 | Covered for staff. Portal ("linked") in Phase 7 (§6). |
| 10 | Agent assignment | §11.2, schema | M3 | Covered. Reassignment rule D4. |
| 11 | Property-to-listing | §13 entity design | M3 | Covered (through the unit) |
| 12 | Unit-to-listing | PRP-04 | M3 | Covered |
| 13 | Rental listings | PRP-04, §7.2 | M3 | Covered. Jurisdiction caps checked. |
| 14 | Sales listings | PRP-04, §7.1 | M3 | Covered |
| 15 | Listing search | PRP-08, NFR p95 < 1 s | M3 (text), M5 (map) | **Gap G6**: no full-text index on listings |
| 16 | Listing filtering | PRP-08 | M3 | Covered |
| 17 | SEO metadata | **Not in spec** | — | **Gap G8**: no fields; recommend deferral to PRP-10 |
| 18 | Media references | PRP-06 | M4 | Covered by schema; M3 returns counts once M4 lands |
| 19 | Version history | Implied (ADR-003 versioning, audit) | M3 | Covered through audit log and history tables; no snapshot table |

## 3. Feature verification

The common rules apply to all 19 features and are not repeated in each entry:

- Every request is tenant-scoped through `TenantDb.run`, with row-level security on `company_id`.
- Composite foreign keys keep every referenced row inside the same company.
- Errors are RFC 9457 problem responses.
- Updates take `If-Match`: 428 when it is missing, 412 when the version is stale.
- Creates accept `Idempotency-Key`.
- Every write records an audit-log entry and an outbox event in the same transaction.
- Portal memberships are rejected on staff endpoints.

### 3.1 Listing creation

| Aspect | Verification |
|---|---|
| Business purpose | Starts one marketing campaign (sale or rent) for one unit, with its own price, dates, mandate and agent (P1-D §0 "Listing"; PRP-04). |
| Roles | Company Owner and Office Admin (all); Sales Manager and Property Manager (office); Agent (own). Matches §11.2 "C". |
| Tables | Writes `listings` (reference from `app.next_reference('listing')`, prefix LST). Writes a `listing_status_history` row for the initial `draft`. Writes `listing_price_history` with `old_price` NULL. Reads `units`, `properties`, `offices`, `company_memberships`, `currencies`, `locales`, `picklist_values` (`price_qualifier`, `mandate_type`) and `jurisdiction_settings` (rent caps). |
| API | `POST /api/v1/listings`, with the unit given in the body. |
| UI | Listing editor (P3 §2.3) opened from the unit or property record ("New listing ▾ Sale / Rent"). |
| Security | `listing.create`. The unit's property must be visible to the caller, and the caller's create scope must cover the listing office (the `canUseOffice` rule from M2). |
| Validation | <ul><li>The unit and its property are not archived.</li><li>There is no other open listing (draft, available, reserved or under contract) of the same type for the unit. The database index enforces this; the API returns 409 with a link to the existing listing.</li><li>`listingType` is `sale` or `rent`.</li><li>The price is a decimal string of 0 or more, with at most the currency's minor units.</li><li>The currency is an active currency; it defaults to the office currency.</li><li>`priceQualifierCode` and `mandateTypeCode` come from picklists for the property's country.</li><li>Mandate expiry is on or after the signed date.</li><li>The default locale is an active locale; it defaults to the office locale.</li><li>The title is 3–200 characters and the description at most 10,000 characters, as plain text (no HTML stored).</li><li>The agent is an active staff membership attached to the listing office.</li><li>The office defaults to the property's office.</li><li>Rental-only fields are rejected on sales listings (§3.13).</li></ul> |
| Audit | Audit action `listing.created` with key fields. Outbox events `listing.created` and `listing.status_changed` (`null → draft`). |

### 3.2 Listing editing

| Aspect | Verification |
|---|---|
| Business purpose | Keeps listing details accurate. Data is "held once, published by feed" (P1-D §4 pain points). |
| Roles | Owner and Office Admin (all); Sales Manager and Property Manager (office); Agent (own). Matches §11.2 "U". |
| Tables | `listings`; `listing_price_history` when the price, currency or qualifier changes; `listing_translations` (§3.8). |
| API | `GET /api/v1/listings/{id}`; `PATCH /api/v1/listings/{id}`. Status, publishing, agent and archive changes go through action endpoints, not PATCH (ADR-003). |
| UI | Listing editor. A version conflict shows the "updated by … at …" comparison (P3 §07 Saving). |
| Security | `listing.update` with record scope. Closed listings (sold, rented, withdrawn, expired) are read-only apart from internal fields, which preserves campaign history. |
| Validation | The creation rules apply. `listingType` and `unitId` cannot change after creation; the API says to create a new listing instead. An unchanged PATCH does not change the version, as in M2. A price reduction above the threshold needs `listing.approve_price` (D2). |
| Audit | `listing.updated` with field-level old/new values; price changes are also written to `listing_price_history`. |

### 3.3 Listing publishing

| Aspect | Verification |
|---|---|
| Business purpose | Makes a listing live, which feeds the website and portals and opens it for enquiries (§7.1 step 4). |
| Roles | **Conflict (D1).** The seed and the §11.2 matrix give `listing.publish` to Owner, Office Admin, Sales Manager and Property Manager, but not to Agent. P1-D §7.1 step 4 says "Publish · Actor: Agent", and §11.2 note 2 implies agents can change status. |
| Tables | `listings.status`, `is_published`, `published_at`, `listed_at`; `listing_status_history`. `listing_publications` (channels) is not written in M3 (G5). |
| API | `POST /api/v1/listings/{id}/publish` (moves draft to available and sets the published flag); `POST /api/v1/listings/{id}/unpublish` (hides the listing without changing status). |
| UI | The Publish ▾ button with a publishing checklist. The button is disabled with the reason shown when a blocking rule fails (P3 §2.3). |
| Security | `listing.publish` with record scope. The database rejects publishing a listing that is not live. |
| Validation | Publishing checklist: <ul><li>title and price present</li><li>a translation for every locale the company publishes in (configurable)</li><li>the unit is not archived</li><li>the unit's availability is not `unavailable`</li><li>the mandate has not expired</li><li>blocking `required_document_rules` for stage `available` (none are seeded; evaluated once documents exist in Phase 10)</li><li>seller KYC verified, if configured (G4, Phase 5)</li><li>minimum photo count (configurable, from M4)</li></ul> |
| Audit | `listing.published` / `listing.unpublished`; outbox `listing.status_changed` and `listing.publication_changed`. |

### 3.4 Listing archiving

| Aspect | Verification |
|---|---|
| Business purpose | Removes finished or mistaken listings from working lists while keeping history (archive, never delete). |
| Roles | §11.2 gives "D" to Owner and Office Admin (all) and to both managers (office). **Gap G2:** the catalogue has no `listing.archive` permission. |
| Tables | `listings.archived_at`. Property archiving already blocks while a listing is open (M2). |
| API | `POST /api/v1/listings/{id}/archive` (reason required); `POST /api/v1/listings/{id}/restore`. |
| UI | "Archive" in the record's ⋯ menu, with a reason dialog; the list's archived filter. |
| Security | `listing.archive` (proposed G2). Restoring cannot create a second open listing (the database index guards this). |
| Validation | Archiving is allowed only in `draft`, `withdrawn`, `expired`, `sold` and `rented`. Live listings must be withdrawn first. Restoring requires the unit to be active. |
| Audit | `listing.archived` / `listing.restored` with the reason; outbox events. |

### 3.5 Listing status workflow

| Aspect | Verification |
|---|---|
| Business purpose | Drives the marketing lifecycle. The unit flag "Under Maintenance" is separate and blocks viewings and new lettings without changing listing status (P1-D §13 design decisions). |
| Roles | Status changes: `listing.publish` (D1). Withdrawal above the threshold also needs `listing.approve_price` (§11.2 note 2). In Phases 6 and 7, deals and leases drive reserved, under contract, sold and rented through the same service. |
| Tables | `listings.status`, `closed_at`; `listing_status_history` (from, to, by, reason); `units.availability`, `availability_note`, `availability_until`. |
| API | `POST /api/v1/listings/{id}/status` with `{ toStatus, reason }`, as named in P1-D §17. `POST /api/v1/units/{id}/availability` sets the unit flag (not exposed in M2). |
| UI | A combined status badge ("Available · Under maintenance"); a status menu showing only the allowed transitions. |
| Security | The transition table is enforced in the service; the database checks are a backstop. |
| Validation | Proposed transition table (**D3**, from Phase 2 §8):<br>`draft → available` (publish), `draft → withdrawn`<br>`available → reserved`, `under_contract`, `withdrawn`, `expired`<br>`reserved → available` (fell through), `under_contract`, `withdrawn`<br>`under_contract → available` (fell through), `sold` (sale only), `rented` (rent only), `withdrawn`<br>`sold`, `rented`, `withdrawn` and `expired` are **terminal**. A new campaign is a new listing through a "Relist" action that copies the fields.<br>A reason is required for withdrawn, fell-through and expired. Leaving a live status sets `is_published = false`; reaching a terminal status sets `closed_at`. |
| Audit | `listing.status_changed` (audit and outbox, the event named in P1-D §12); `unit.availability_changed`. |

### 3.6 Listing price history

| Aspect | Verification |
|---|---|
| Business purpose | Days-on-market and price-reduction reporting; evidence for the seller; control over price cuts (§11.2 note 2). |
| Roles | Writers as for editing. `listing.approve_price` (Owner, Office Admin and managers) approves reductions above the threshold. |
| Tables | `listing_price_history` (old/new price, currency, by, `approved_by`, reason). |
| API | `GET /api/v1/listings/{id}/price-history` (paginated). Writes happen only as a side effect of create and edit. |
| UI | "Price history" panel on the listing record. |
| Security | `listing.view` with record scope; rows are append-only through the API. |
| Validation | A row is written only when price, currency or qualifier actually changes. A currency change records both values. A reason is required for reductions. Threshold rule: **D2**. |
| Audit | Covered by `listing.updated` plus the history row. Approvals record `approved_by`. |

### 3.7 Listing status history

| Aspect | Verification |
|---|---|
| Business purpose | Time in each status, days on market and fall-through rates (P1-D §13 "status history tables"). |
| Roles | Readers: anyone with `listing.view` on the listing. |
| Tables | `listing_status_history`. |
| API | `GET /api/v1/listings/{id}/status-history`. |
| UI | Timeline panel on the listing record. |
| Security | Read-only; written only by the status service. |
| Validation | One row per transition, including the initial `draft`, in the same transaction as the change. |
| Audit | `listing.status_changed` mirrors each row. |

### 3.8 Multi-language listings

| Aspect | Verification |
|---|---|
| Business purpose | Bilingual marketing (for example English and Arabic in Qatar), in line with the confirmed localisation-ready requirement and the P3 §2.3 side-by-side, right-to-left-aware editor. |
| Roles | As for editing. |
| Tables | Default-language title and description on `listings`; other languages in `listing_translations` (`source` manual, AI draft or translation service, plus approver). |
| API | `PUT /api/v1/listings/{id}/translations/{locale}`; `DELETE /api/v1/listings/{id}/translations/{locale}`. Translations are included in `GET /listings/{id}`. |
| UI | Two-column editor with right-to-left layout per locale; "Draft with EstateAI" arrives in Phase 13. |
| Security | `listing.update`. The database rejects publishing an AI draft without an approver; M3 accepts `source = manual` only. |
| Validation | The locale is active and differs from the default locale. The title and description follow the same rules as the default. A translation changes the listing version, as unit features did in M2. |
| Audit | `listing.translation_saved` / `listing.translation_removed` with the locale and changed fields. |

### 3.9 Listing visibility rules

| Aspect | Verification |
|---|---|
| Business purpose | Each role sees the listings its data scope allows (§11.2). |
| Roles | <ul><li>Owner, Office Admin and Accountant: all.</li><li>Managers: office (`listings.office_id`).</li><li>Agent: views office listings and edits own (`agent_membership_id` = the member **or** `created_by` = the member).</li><li>Maintenance Staff: none.</li><li>Landlord: linked, through the portal in Phase 7 (§6).</li><li>Tenant: none.</li></ul> |
| Tables | `listings`, `membership_offices`. |
| API | Enforced through a `listingScopeSql` / `assertListingAccess` pair, mirroring M2: 404 when the caller cannot see the listing, 403 when the action's scope does not cover it. |
| UI | Lists and the record page show only visible listings; actions the caller lacks are hidden. |
| Security | Row-level security isolates companies; the service narrows by role scope; portal memberships stay blocked until the portal endpoints exist. |
| Validation | Not applicable. |
| Audit | Reads are not audited (in line with M2); exports are audited when they arrive. |

### 3.10 Agent assignment

| Aspect | Verification |
|---|---|
| Business purpose | Every listing has one responsible agent, for lead routing, "my listings" and commission (P1-D §7.1). |
| Roles | Initial agent: the creator by default. Reassignment: **D4**. |
| Tables | `listings.agent_membership_id` (required); `company_memberships`; `membership_offices`. |
| API | `POST /api/v1/listings/{id}/assign` with `{ agentMembershipId, reason? }`. |
| UI | Agent picker on the listing record, limited to eligible staff. |
| Security | The assignee must be an active staff membership in the listing's office with `listing.update` (own or wider). Proposed: an agent with "own" scope cannot reassign a listing away from themselves. |
| Validation | The membership exists in the company and is active; staff, not portal; attached to the office. |
| Audit | `listing.agent_assigned` with old and new agent; outbox event for notifications in Phase 12. |

### 3.11 Property-to-listing relationship

| Aspect | Verification |
|---|---|
| Business purpose | The property is the asset and the listing is the campaign, kept separate so history and reporting survive many campaigns (P1-D §13). |
| Roles | Any role with `listing.view`. |
| Tables | Indirect: `listings.unit_id → units.property_id`. Whole-property sales and lets use the M2 "Whole property" unit. |
| API | `GET /api/v1/properties/{id}/listings`; the property response gains an `openListingCount`. |
| UI | "Listings" tab on the property record. |
| Security | The property scope applies first, then the listing scope. |
| Validation | Archived properties cannot get new listings; property archiving is blocked by open listings (M2). |
| Audit | Not applicable (read). |

### 3.12 Unit-to-listing relationship

| Aspect | Verification |
|---|---|
| Business purpose | A unit is sold or let many times over its life; at most one open campaign per type at a time (P1-D §0). |
| Roles | As for listings. |
| Tables | `listings.unit_id`; unique index `listings_one_open_per_unit_idx (company_id, unit_id, listing_type)` over open statuses. |
| API | `GET /api/v1/units/{id}/listings`; unit responses gain the current open listing per type. |
| UI | Unit row shows a combined badge (listing status plus availability flag). |
| Security | As above. |
| Validation | A sale and a rental may be open for the same unit at the same time (the schema allows it, for "for sale or to let" instructions). Unit archiving is blocked by open listings (M2). |
| Audit | Not applicable. |

### 3.13 Rental listings

| Aspect | Verification |
|---|---|
| Business purpose | Letting a unit: rent, frequency, advance rent (common in Ghana), deposit, service charge, minimum term and available-from date (§7.2 step 2). |
| Roles | As for listings. |
| Tables | `listings` rental columns; `jurisdiction_settings` / `company_settings` for `advance_rent_max_months` and `deposit_max_rent_multiple`. |
| API | The listing endpoints with `listingType = "rent"`. |
| UI | Rental fields in the editor (P3 §2.3: price per month, advance months, deposit). |
| Security | As above. |
| Validation | <ul><li>`rentFrequency` is required.</li><li>`advanceRentPeriods`, converted to months, must not exceed the effective `advance_rent_max_months` (resolved office, then company, then jurisdiction, then default; NULL means no cap).</li><li>The deposit must not exceed `deposit_max_rent_multiple` times the periodic rent, where that is set.</li><li>The service-charge amount and frequency are given together.</li><li>`minTermMonths` is at least 1.</li><li>"Sold" is not allowed.</li></ul> This puts country rules in configuration, not in code. |
| Audit | As for create and edit. |

### 3.14 Sales listings

| Aspect | Verification |
|---|---|
| Business purpose | Selling a unit or whole property: asking price, qualifier, mandate and fee terms (§7.1). |
| Roles | As for listings. |
| Tables | `listings` sale columns; `fee_terms` (JSON). |
| API | The listing endpoints with `listingType = "sale"`. |
| UI | Sale fields in the editor. |
| Security | `fee_terms` is commercial data: shown to staff with `listing.update` only and never to portals. |
| Validation | Rental fields (frequency, advance, deposit, service charge, minimum term) are rejected. "Rented" is not allowed. `fee_terms` is validated against a fixed shape: percentage or fixed amount, plus a VAT flag. |
| Audit | As for create and edit; `fee_terms` changes are recorded. |

### 3.15 Listing search

| Aspect | Verification |
|---|---|
| Business purpose | Staff find listings quickly. Target: p95 under 1 s on 100,000 listings per company (P1-D §6). |
| Roles | `listing.view`. |
| Tables | `listings` (`listings_search_idx` on company, type, status and price); `units` (`units_search_idx`); `listing_translations`. |
| API | `GET /api/v1/listings?q=…`. `q` matches the reference exactly or by prefix, and the title in any language case-insensitively. Map and radius search arrive in M5 (PostGIS). |
| UI | Listings register search box; global search groups "Listings" (P3 §02). |
| Security | Scope-filtered; text is escaped for `ILIKE`, as in M2. |
| Validation | `q` is 2–100 characters (ADR-003 list rules). |
| Audit | Not applicable. |
| Gap | **G6.** P1-D §14 names a GIN `search_vector` on listings, which Phase 2 did not create. Proposal: a trigram (`pg_trgm`, already installed) GIN index on `listings.title` and `listing_translations.title` in migration 0017, plus a 100,000-row performance test in M3. |

### 3.16 Listing filtering

| Aspect | Verification |
|---|---|
| Business purpose | Working lists such as "my available rentals in Osu under GH₵8,000 with 2+ bedrooms" (PRP-08). |
| Roles | `listing.view`. |
| Tables | `listings`, `units`, `properties`. |
| API | ADR-003 filters: <ul><li>`filter[listingType]`, `filter[status]` (multiple)</li><li>`filter[officeId]`, `filter[agentMembershipId]`, `filter[propertyId]`, `filter[unitId]`</li><li>`filter[isPublished]`, `filter[archived]`</li><li>`filter[currencyCode]` with `filter[price][gte\|lte]` (a price range requires a currency; no cross-currency comparison)</li><li>`filter[bedrooms][gte\|lte]`</li><li>`filter[availableFrom][lte]`, `filter[mandateExpiresOn][lte]`</li></ul> Sort by `createdAt`, `price`, `listedAt` or `reference`. |
| UI | Filter bar with saved views (P3 §07). |
| Security | Filters only narrow results; scope is always applied first. |
| Validation | Unknown filters return 422 (the M2 list-query module). |
| Audit | Not applicable. |

### 3.17 Listing SEO metadata

| Aspect | Verification |
|---|---|
| Business purpose | Search-friendly pages on the company website: slug, meta title and meta description per language. |
| Roles | Would follow listing editing. |
| Tables | **None.** No slug or meta fields exist on `listings` or `listing_translations`. |
| API / UI | None planned. |
| Finding | **G8: not in the specification.** EstatePro "publishes listings to the Company's website and to portals through feeds" (P1-D §1 non-goals); the website is out of scope. **Recommendation:** defer to PRP-10 (listing feeds). If approved then, add `slug`, `seo_title` and `seo_description` to `listing_translations`, with a slug unique per company and locale. M3 adds nothing for SEO, in line with the no-expansion rule. |

### 3.18 Listing media references

| Aspect | Verification |
|---|---|
| Business purpose | Photos (ordered, cover), video, floor plans and virtual tours for the campaign (PRP-06). |
| Roles | Upload and arrange: `listing.update`; view: `listing.view`. |
| Tables | `property_media` (`listing_id`, `is_cover`, `sort_order`; one cover per listing by unique index). |
| API | M4 (`/api/v1/media/uploads`, confirm, reorder, cover, archive). M3 adds `mediaCount` and `coverMediaId` to the listing response, empty until M4. |
| UI | Gallery manager (issue #7 wireframe before M6). |
| Security | M4: private storage keys prefixed by company; short-lived signed URLs; content-type sniffing; malware-scan port. |
| Validation | M4. The publishing checklist uses the photo count once M4 is in. |
| Audit | M4: `media.uploaded`, `media.archived`, `media.cover_changed`. |

### 3.19 Listing version history

| Aspect | Verification |
|---|---|
| Business purpose | "Who changed what, when" for disputes, compliance and optimistic locking (ADR-003). |
| Roles | Readers with `listing.view` see the listing's history; the company-wide audit log stays restricted to `audit.view`. |
| Tables | `listings.version`; `audit_logs` (append-only, with field-level old/new values); `listing_status_history`; `listing_price_history`. There is no snapshot table. |
| API | `GET /api/v1/listings/{id}/history` returns audit entries for this listing and its translations, newest first, with sensitive values masked. |
| UI | "History" tab with a field-level change list. |
| Security | History is scoped to the one listing; `fee_terms` changes are shown only to holders of `listing.update`. |
| Validation | Not applicable. |
| Audit | This feature is the read side of the audit trail. Restoring an old version is not offered; users edit forward. |

## 4. Requirements not yet covered

| ID | Gap | Type | Proposed handling | Blocks M3? |
|---|---|---|---|---|
| **D1 / G1** | Agents and publishing: the seed and the matrix withhold `listing.publish` from agents, but §7.1 step 4 has the agent publish. | Spec contradiction | **Recommendation:** grant `listing.publish` with scope `own` to Agent in migration 0017, so the agent journey works. Withdrawals and price cuts above the threshold still need manager approval (note 2). Update P1-D §11.2 to match. | Decision needed |
| **G2** | No `listing.archive` permission, although the matrix gives "D" (archive) to Owner, Office Admin and both managers. | Seed gap | Migration 0017 adds `listing.archive`: Owner and Office Admin (all), Sales Manager and Property Manager (office). | Yes (small) |
| **D2 / G3** | The "configured threshold" for price reductions and withdrawals has no setting, and there is no way to hold a pending request. | Undefined rule | **Recommendation for M3:** <ul><li>Add the company setting `listing.price_reduction_approval_percent` (default: not set, meaning no approval needed).</li><li>A reduction above it, or a withdrawal when it is set, by someone without `listing.approve_price` returns 403 "needs approval".</li><li>A manager makes the change, and `approved_by` is recorded.</li><li>A request-and-approve queue is deferred to the Automation Engine (Phase 12).</li></ul> | Decision needed |
| **D3** | No approved listing transition table (P1-D §18 item 6 was left to Phase 2, which gives only a summary). Relisting after a tenancy ends: §7.2 step 11b says "listing → Available", which conflicts with "a listing is one campaign". | Spec gap / contradiction | Approve the table in §3.5. Make terminal statuses final and add "Relist", which creates a new listing. Reword §7.2 step 11b as "rental relisted". | Decision needed |
| **D4** | Who may reassign a listing's agent. | Undefined rule | Reassignment with office or all scope only; agents cannot reassign. | Decision needed |
| **G4** | "Listing cannot go live until seller KYC is verified (configurable)" needs the seller, which comes from ownership. Ownership is Phase 5 by the Phase 4 scope lock. | Phase dependency | M3 adds the setting `listing.require_seller_kyc` (default off) and the checklist slot. The check is implemented when ownership arrives in Phase 5. If the setting is turned on before then, publishing is refused with a clear message (fail-closed). | No |
| **G5** | Channel syndication (`listing_publications`, PRP-10 "Should") is not in the Phase 4 milestones. | Scope | Track as a new issue for the Integrations work (Phase 12). M3's `is_published` flag is the source of truth that feeds will read. | No |
| **G6** | No full-text or trigram index for listing title search (P1-D §14 names one). | Schema gap | Migration 0017: trigram GIN indexes; 100,000-row performance test in M3. | Yes (small) |
| **G7** | Automatic expiry (`expired` when the mandate expires) needs a scheduled job; there is no job runner yet. | Infrastructure dependency | M3 implements the transition and the rule. The daily sweep runs on the worker introduced in M4 (same process as media processing). Until then, "mandate expiring" appears as a filter. | No |
| **G8** | SEO metadata is not in the specification. | New requirement | Defer to PRP-10 (§3.17). | No |
| **G9** | Unit availability (`under_maintenance` and so on) has columns but no endpoint; M2 did not expose it. | Planned | Included in M3 (`POST /units/{id}/availability`), as stated in the Readiness Report. | No |

Proposed migration 0017 (M3) contains only:

- seed changes for D1 and G2
- the two settings definitions from D2 and G4
- the G6 trigram indexes

There are no table changes.

## 5. Planned M3 endpoint list (for approval)

```
GET    /api/v1/listings                         list, search, filter (scope-aware)
POST   /api/v1/listings                         create (Idempotency-Key)
GET    /api/v1/listings/{id}
PATCH  /api/v1/listings/{id}                    edit (If-Match)
POST   /api/v1/listings/{id}/publish            draft → available, is_published = true
POST   /api/v1/listings/{id}/unpublish          hide without status change
POST   /api/v1/listings/{id}/status             transition with reason
POST   /api/v1/listings/{id}/assign             change agent
POST   /api/v1/listings/{id}/relist             new listing from a closed one
POST   /api/v1/listings/{id}/archive | /restore
PUT    /api/v1/listings/{id}/translations/{locale}
DELETE /api/v1/listings/{id}/translations/{locale}
GET    /api/v1/listings/{id}/status-history
GET    /api/v1/listings/{id}/price-history
GET    /api/v1/listings/{id}/history
GET    /api/v1/properties/{id}/listings
GET    /api/v1/units/{id}/listings
POST   /api/v1/units/{id}/availability          unit operational flag
```

## 6. Issue #5 review: the "linked" visibility scope

### 6.1 Correction to the M2 report

The M2 report said the "linked" scope "is tracked as issue #5". That is only partly accurate:

- **Issue #5** covers decisions P1–P3 from the Audit Resolution Plan: what a landlord may see of offers, deal progress and viewing feedback.
- **The linked scope resolver** is the general mechanism that turns a portal user into "their" properties, listings, leases and so on. No issue tracks it.

Recommendation: open a companion issue, "Linked-scope resolver for portal memberships", and cross-reference it from #5. Creating the issue needs your go-ahead.

### 6.2 Why "linked" currently matches nothing

1. **Portal users cannot reach staff endpoints.** The M1 auth guard rejects every membership whose type is not `staff` with 403 "This area is for company staff only" before any data query runs. Portal endpoints are Phase 7.
2. **The resolver has nothing to read yet.** Linking a portal user to records goes from the user's membership contact to records that name that contact:
   - **Landlord:** current `property_ownerships.owner_contact_id`, plus `management_agreements.landlord_contact_id`.
   - **Tenant:** `lease_parties.contact_id` with role tenant, co-tenant or occupant.

   Ownership endpoints are Phase 5, and leases are Phase 7, so no linking rows can be created through the API yet.
3. **Fail-closed by design.** `propertyScopeSql` returns `false` for `linked` and `team`. If a portal membership ever reached a staff endpoint by mistake, it would see nothing rather than everything. A test in `property-access.test.ts` proves this.

### 6.3 Does it affect the landlord and tenant portals?

Yes, directly. Landlord and tenant portals are a confirmed launch requirement. Every portal permission in the seed uses the linked scope:

- **Landlord:** `property.view`, `listing.view`, `offer.view`, `lease.view`, `rent.view`, `statement.view` and others.
- **Tenant:** `property.view`, `lease.view`, `rent.view` and others.

Without the resolver, the portals show empty pages. Getting it wrong is worse: one landlord could see another landlord's portfolio within the same agency. Row-level security would not stop that, because RLS isolates companies, not contacts within a company.

### 6.4 Does Phase 6 depend on it?

- **Phase 6 staff features (deals, viewings, offers):** no. They use the all, office and own scopes, which already work.
- **Issue #5 itself (P1–P3):** yes. It is scheduled for Phase 6 and grants `deal.view`, `viewing.view` and `offer.view` with linked scope to landlords. Those grants only make sense once the resolver can map a landlord to "their listings". The resolver therefore has to exist by Phase 6, though it is first used by the Phase 7 portal screens.

### 6.5 Does the database already support the relationships?

Yes. No schema change is required.

| Link | Columns (Phase 2) | Index |
|---|---|---|
| Portal user → contact | `company_memberships.contact_id` (required for portal memberships by a CHECK constraint) | Composite foreign key to `contacts` |
| Landlord → property or unit | `property_ownerships.owner_contact_id`, `effective_from/to`, optional `unit_id` | `property_ownerships_owner_idx` (current rows) |
| Landlord → managed property | `management_agreements.landlord_contact_id`, `property_id`, `unit_id` | Composite foreign keys |
| Landlord → listing | through ownership → `units` → `listings.unit_id` | `listings` foreign-key index |
| Landlord → offers, viewings, deals | `offers.listing_id`, `viewings.listing_id`, `deals.listing_id`; `viewings.seller_feedback_shared` | `offers_listing_idx`, `viewings_listing_idx`, `deals_listing_idx` |
| Tenant → lease → unit or property | `lease_parties.contact_id` and `party_role`; `leases.unit_id` | `lease_parties_contact_idx` |

One design point remains: portal isolation inside a company is enforced only in the application. As defence in depth, add portal-specific RLS policies, or security-barrier views keyed on a transaction-local `app.contact_id`, in Phase 7, with the review in Phase 15 (Security & Compliance).

### 6.6 Recommended timeline

| When | Work |
|---|---|
| Now (M3) | No implementation; this design note only. Listing access functions get a `linked` branch that stays fail-closed, with tests. |
| **Phase 5** (contacts and ownership) | Build the resolver for **landlords**: SQL scope functions for properties, units and listings that read current ownerships and management agreements. Test it with two landlords in one company to prove they are isolated from each other. |
| **Phase 6** | Issue #5 grants (P1–P3) plus the reduced landlord views of deals, offers and viewings, reusing the resolver. |
| **Phase 7** | Extend the resolver for **tenants** (`lease_parties`); portal endpoints and screens; portal RLS defence in depth. |
| Phase 15 | Security review of the portals, including penetration tests of linked-scope isolation. |

### 6.7 Classification: **High**

- **Not Critical.** Nothing is exposed today: portal users are blocked at the guard and `linked` fails closed. No current milestone or launch-blocking work in Phases 4–5 is held up.
- **Not Medium or Low**, for three reasons:
  1. It is the only control separating landlords and tenants from each other inside a company, and RLS cannot provide it. A defect here is a cross-customer personal-data breach, notifiable under the UK GDPR and Ghana's Data Protection Act.
  2. It underpins a confirmed launch requirement (both portals) and is a prerequisite for issue #5 in Phase 6 and all of Phase 7.
  3. It currently has no tracking issue of its own (§6.1).

The Audit Resolution Plan rated **P1–P3 Medium**. That rating stands, because it covers which extra fields landlords may see. The **resolver** they depend on is the higher-risk item, hence **High**.

## 7. Decisions requested before M3 starts

| ID | Question | Recommendation |
|---|---|---|
| D1 | May agents publish their own listings? | Yes: grant `listing.publish` (own) to Agent. |
| D2 | What is the approval threshold, and how is approval given? | Percentage reduction setting, off by default; a manager performs over-threshold changes; queue in Phase 12. |
| D3 | Approve the transition table; are terminal statuses final, with "Relist"? | Yes, as in §3.5. |
| D4 | Who may reassign agents? | Managers and admins only. |
| — | Defer SEO metadata (G8) and channel syndication (G5) to PRP-10. | Yes. |
| — | Open the companion "linked-scope resolver" issue (§6.1). | Yes. |
