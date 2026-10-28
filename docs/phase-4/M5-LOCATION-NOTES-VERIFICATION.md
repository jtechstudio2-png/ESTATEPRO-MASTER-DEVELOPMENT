# Phase 4 · Milestone 5 · Location Search and Property Notes Verification Report

| | |
|---|---|
| Status | **Approved** — all decisions L-D1 to L-D10 accepted by the product owner ("Milestone 5 Decisions Approved"), recorded in [ADR-006](../decisions/ADR-006-location-notes-keys.md). Additional requirement: public location precision levels (§17.1). |
| Scope | Milestone 5 of Phase 4: location (PostGIS) search for properties and listings, and property notes |
| Branch | `phase-4/property-management` at `115060f` (audit branch `audit/pre-phase-4` remains unmerged) |
| Sources checked | Phase 1 detailed specification (P1-D) §5.2 PRP-01, PRP-07, PRP-08, PRP-10, NFR table, §9 stack, §11 permissions, §14.5 retention, §15 data protection; Phase 2 design doc (PostGIS deferral note) and migrations 0002, 0003, 0005, 0006, 0013, 0014, 0015; Phase 3 wireframes and validation gate items 3 and 6; ADR-002 (accessibility), ADR-003 (API conventions), ADR-004, ADR-005; the M2 address code (`src/reference/address.ts`) and the property and listing access rules |

## Decision record

| ID | Approved decision |
|---|---|
| L-D1 | Calculated spatial point on `addresses`, indexed per company |
| L-D2 | Geocoding suggestions only; every stored location is confirmed by a user; Mapbox approved as the suggestion provider, configured by environment |
| L-D3 | MapLibre with self-hosted OpenStreetMap tiles |
| L-D4 | Radius search up to 50 km, map viewport search, polygon search up to 100 points, clustering above 500 records |
| L-D5 | Reject coordinates at 0,0 and outside country boundaries |
| L-D6 | Dedicated note permissions: View Notes, Create Notes, Manage Notes |
| L-D7 | Separate note revision history; audit logs never store note text |
| L-D8 | Only managers and admins may expose notes externally; tenant-visible notes must reference a unit |
| L-D9 | `properties.internal_notes` migrated into pinned notes, removed from API responses and deprecated |
| L-D10 | Key register included in Milestone 5 (§8.4) |
| Additional | Future public location precision levels documented: Exact, Approximate, Area Only, Hidden (§17.1) |

Changes to this report after approval:

- §9: "Managers" in L-D8 includes sales managers, so they receive `property_note.manage` (office scope) alongside property managers.
- §8.4 (new): key register design.
- §17.1 (new): public location precision.

## 0. Summary

The specification fixes the shape of this milestone:

- **PRP-08 (Must):** location search with a map view, radius search and polygon search, combined with price, type, bedroom and status filters.
- **PRP-07 (Must):** internal notes, key and access information, and a status-history log. Status history was delivered in M3.
- **Stack (P1-D §9):** PostgreSQL 16 with PostGIS. Phase 2 deliberately stored plain latitude and longitude and deferred "a PostGIS geography column and GiST index … when map search is built (Phase 4)".
- **NFR:** search p95 under 1 s.

What already exists:

- `addresses` (shared by offices, contacts, developments and properties) has `latitude numeric(9,6)`, `longitude numeric(9,6)`, a both-or-neither check and a free-text `geocode_source`.
- The M2 property API already accepts and returns coordinates.
- `property_notes` exists, with `body`, `visibility` (`internal` / `landlord` / `tenant`), `is_pinned`, `created_by` and `version`.
- **PostGIS is not installed:** not in migrations, not in the CI image (`postgres:16`) and not in the local test database.

This review found **11 gaps and 10 decisions** (§18–§19). The decisions that matter most:

- **L-D2 Geocoding:** coordinates are confirmed by a person, and a geocoder only suggests them. Most providers' licences restrict storing their results.
- **L-D3 Map provider:** MapLibre with self-hosted OpenStreetMap vector tiles on our existing R2 storage, so there are no per-view fees and no third-party tracking of users.
- **L-D7 Note history and erasure:** past note text is kept in a revisions table, not in the append-only audit log, so personal data in notes can still be erased.
- **L-D10 Key register:** PRP-07 (Must) and Phase 3 gate item 6 include the key register, but no Phase 4 milestone does. This needs a scope decision.

---

## 1. PostGIS architecture

### 1.1 Validation

| Check | Finding |
|---|---|
| Specified | Yes: P1-D §9 ("PostgreSQL 16+ with PostGIS"), §16 ("PostgreSQL FTS + PostGIS; OpenSearch when needed"). |
| Installed | **No (gap G1).** Migration 0001 creates `pgcrypto`, `citext`, `pg_trgm` and `btree_gist` only. CI uses `postgres:16`, which has no PostGIS. |
| Managed hosting | PostGIS is available on all major managed PostgreSQL services (AWS RDS and Aurora, Google Cloud SQL, Azure Flexible Server, which needs the extension allow-listed). This matches the Phase 2 assumption. |
| Tenant isolation | Spatial data lives in existing RLS-protected tables. PostGIS adds no new access path. |

### 1.2 Recommended design (L-D1)

- **Extension:** `CREATE EXTENSION IF NOT EXISTS postgis` in migration 0019. It is idempotent and run by the owner role, like 0001. Where the managed service needs a privileged role, a DBA runs that one statement, as documented for role creation in 0001.
- **Column:** `addresses.location geography(Point, 4326)` as a **stored generated column** derived from `latitude` and `longitude`.
  - The decimal columns stay the source of truth and the API contract. The spatial value can never drift from them, and no trigger or application code maintains it.
  - `ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography` is immutable, so it can be a generated column. A migration test proves this.
- **Type:** `geography`, not `geometry`.
  - Distances and radii are in metres on the spheroid, correct in Accra, Doha and London without a projection per country.
  - Polygon and bounding-box filters first use a cheap bounding-box test, then an exact `ST_Covers`.
- **Index:** `GiST (company_id, location) WHERE location IS NOT NULL`, using `btree_gist`, which is already installed. Every spatial query is company-scoped by RLS, and the composite index keeps one large tenant from slowing another. The query plan is checked against the single-column alternative in the performance test (§7).
- **Why not a denormalised `properties.location`?** It would mean a second copy kept in sync by triggers. Properties already reach `addresses` through `properties_address_id_fk_idx`. If the performance tests show the join is too slow, denormalisation is the fallback.
- **Units:** units have no address of their own, so they inherit the property's point. That suits apartment buildings. Many units on one point are a map-clustering concern (§5.4), not a data-model one.

## 2. Geocoding strategy

### 2.1 The country problem

| Country | Address reality | Implication |
|---|---|---|
| Ghana | Many addresses have no street number. GhanaPost GPS digital addresses (`GA-123-4567`, already validated by M2) identify a small grid square. Commercial geocoder coverage below street level is uneven. | Free-text geocoding is unreliable, so a **map pin set by a person is the dependable source**. No stable, public, licensed GhanaPost GPS decoding API was identified, so M5 does not decode digital addresses. |
| Qatar | The QARS zone / street / building numbers (stored in `local_components` by M2) identify buildings precisely, but there is no public licensed geocoding API for them. Arabic and English names both occur. | Pin first. A geocoder helps only for area-level suggestions. |
| United Kingdom | Postcodes are precise (about 15 households). Open postcode centroids (ONS / Ordnance Survey Code-Point Open, OGL licence) and paid address-level geocoders exist. | A geocoder works well. A postcode centroid is a useful starting point for the pin. |

### 2.2 Licensing constraint

The coordinates EstatePro stores are used permanently: for search, maps and future feeds. Provider terms differ, and all must be reconfirmed before go-live:

- **Google Geocoding:** caching of latitude and longitude is time-limited (30 days at the time of writing), and results are intended for display on a Google map. This conflicts with permanent storage and with L-D3.
- **Mapbox:** separates "temporary" geocoding (no storage) from "permanent" geocoding (storage allowed, priced higher).
- **Public Nominatim (OpenStreetMap):** its usage policy forbids production application traffic. Self-hosting is possible but is an operational system of its own.

### 2.3 Recommendation (L-D2)

1. **A person confirms every stored coordinate.** The form offers "drop a pin" on the map, plus direct latitude and longitude entry (accessibility, §14). A geocoder only *proposes* a point, which a person accepts or moves. Nothing is geocoded silently.
2. **`geocode_source` becomes a controlled value** (`manual_pin`, `geocoder`, `postcode_centroid`, `import`) with a new `geocode_accuracy` (`rooftop`, `street`, `postcode`, `locality`), so data quality is visible and reportable.
3. **A provider-neutral `GeocoderPort`,** called only server-side through `GET /api/v1/geocoding/suggestions`. This keeps the provider key out of the browser, rate-limits per company and logs no address text. It mirrors the storage port pattern from M4.
4. **Adapter:** one "permanent storage" provider adapter (Mapbox permanent geocoding is the candidate). It is enabled only when configured; otherwise the endpoint returns a `geocoding-unavailable` problem and the pin still works. It is tested against a local stub HTTP server in CI. As with R2, a real-provider check is a go-live item.
5. **Not in M5:** reverse geocoding (pin to address text), batch geocoding of imports, and GhanaPost GPS or QARS decoding. These can be added once licensed sources are confirmed.

If you prefer no third-party geocoder at all in M5, steps 1–3 still apply and the adapter is simply not built. Map search is unaffected.

## 3. Address storage strategy

| Item | Decision / validation |
|---|---|
| One address model | Keep the Phase 2 `addresses` table and M2 validation. No change to the address shape. |
| Coordinates | `latitude`/`longitude numeric(9,6)`, about 0.1 m precision, which is enough. WGS 84 everywhere. |
| Spatial value | Generated `location` column (§1.2). Never written by the application. |
| Provenance | `geocode_source` gets a CHECK constraint with the values in §2.3. New columns `geocode_accuracy` and `geocoded_at`. **Gap G3:** today it is free text. |
| Sanity checks (L-D5) | Reject (0, 0) ("null island", the usual sign of a failed import). Reject points outside the country's bounding box, using a new `countries.bounds` column seeded for GH, QA and GB. This is data, not hard-coded country logic, so new countries add a row. |
| Address edits | If the country, locality or postcode changes and no new coordinates are sent, the response returns a `location-may-be-stale` warning flag and the UI asks for a pin. Coordinates are **not** silently cleared, because that would remove the property from map search without notice. |
| Contacts' addresses | They share the table and the index, but the spatial endpoints only ever join from properties. A test proves a contact's home address can never appear in a map result. |

## 4. International address support

| Check | Status |
|---|---|
| Country-driven address forms | Delivered in M2 from `countries.address_format`: Ghana digital address, Qatar zone / street / building, UK postcode pattern. No change. |
| Coordinates are country-neutral | Yes (WGS 84). UK Ordnance Survey data in British National Grid (EPSG:27700) is transformed on import. M5 has no importer. |
| Local-language place names | `formatted` and `locality` are text with trigram search. **Gap G10 (to verify):** `pg_trgm` decides which characters count as letters from the database's character-type locale. Under a `C` locale, Arabic letters are ignored, so an Arabic locality search would match nothing. M5 adds an Arabic search test and documents the required database locale (`C.UTF-8` or ICU). |
| Text locality filters | `filter[countryCode]` exists. M5 adds `filter[locality]` and `filter[adminArea1]` to property and listing lists. Location search without a map is part of PRP-08 and costs nothing extra. |
| Distance units | The API always returns metres. Display units are chosen by locale in the UI (miles for `en-GB`, kilometres elsewhere), consistent with how areas are handled. |
| Right-to-left maps | MapLibre needs its RTL text plugin to draw Arabic labels correctly. This is an M6 item, noted for Qatar. |

## 5. Search radius queries

### 5.1 Query shapes (L-D4)

| Filter | Form | Limits | SQL |
|---|---|---|---|
| Radius | `filter[near]=lat,lng` and `filter[radius]=metres` | radius 1 m – 50 km | `ST_DWithin(a.location, point, radius)` (index-assisted) |
| Map viewport | `filter[bbox]=minLng,minLat,maxLng,maxLat` | no antimeridian crossing (none of our markets needs it); maximum span checked | bounding-box test, then `ST_Covers` |
| Polygon | `filter[polygon]=lng lat,lng lat,…` | 4–100 vertices, closed automatically, must be valid (no self-intersection), maximum area checked | bounding-box prefilter, then `ST_Covers(polygon, location)` |
| Missing location | `filter[hasLocation]=false` | — | data-cleanup list of properties without coordinates |

- Spatial filters combine with all existing list filters (price, type, bedrooms, status, office), the record scopes (office / own) and RLS. **Scope is always applied before results are counted or clustered**, so counts never reveal records the user cannot see.
- `sort=distance` is allowed only with `filter[near]`. Ordering uses the GiST distance operator (`<->`), and paging uses the existing numeric keyset (distance, id).
- When `near` is given, each result includes `distanceMeters`.
- **Polygon in a GET:** 100 vertices take about 2.5 KB of URL, well within limits. This keeps ADR-003's "lists are GET" rule. If you expect hand-drawn shapes with more vertices, the alternative is a `POST …/searches` resource.

### 5.2 Endpoints affected

- `GET /api/v1/listings` and `GET /api/v1/properties` get the filters above. Properties also get them because property managers need a portfolio map, not only a listing map.
- **New** `GET /api/v1/listings/map` and `GET /api/v1/properties/map` (§5.4).

### 5.3 Correctness rules

- Records without coordinates are excluded from spatial filters, never treated as being at (0, 0).
- Edges of geography polygons are great-circle arcs. At city and neighbourhood scale the difference from straight lines on the map is centimetres to metres. This is documented and accepted.
- A unit inherits its property's point. A listing inherits its unit's.

### 5.4 Map endpoint and clustering

`GET …/map?filter[bbox]=…&zoom=…` returns compact points: id, latitude, longitude, status, type, price and cover thumbnail id. Up to **500** points are returned individually. Above that, the server clusters them on a grid sized to the zoom level and returns cells with counts and bounds. Clustering in the database stops a zoomed-out view of 100,000 listings from sending megabytes to a phone.

## 6. Map provider strategy (L-D3)

| Option | Cost model | Privacy | Coverage (GH / QA / GB) | Fit |
|---|---|---|---|---|
| **MapLibre GL JS + self-hosted Protomaps / OpenStreetMap vector tiles in a single PMTiles file on R2 (recommended)** | Storage plus negligible R2 reads. No per-map-load fee. | Tiles come from our own domain. No third party sees user IPs or viewed areas. Simpler content security policy. | Good roads and areas in Accra, Doha and London. Ghana building numbers and Qatar street names are weaker. OSM attribution (ODbL) required. | Open source (BSD). Renderer not tied to a provider. Basemap updated by a scheduled rebuild. |
| MapLibre + commercial tile API (MapTiler, Stadia) | Per map load | Third-party requests | Same OSM data, plus optional satellite | Good fallback if self-hosting is not wanted. Same renderer, so switching is a config change. |
| Google Maps JavaScript API | Per map load, the highest of the options | Google sees usage | Best imagery and place data in Ghana and Qatar | Proprietary. Pairs with Google geocoding, whose storage terms conflict with §2.2. |
| Mapbox GL JS v2+ | Per map load | Mapbox sees usage | Good | Proprietary licence. |

**Recommendation:** MapLibre with a self-hosted OSM basemap. Satellite imagery, if wanted, becomes an optional configured layer from a commercial provider later.

The M5 backend is provider-neutral: plain WGS 84 coordinates, with GeoJSON-compatible geometry in map responses. The renderer is an M6 concern, and this decision only fixes direction and cost.

## 7. GIS performance targets

| Measurement | Dataset | Target |
|---|---|---|
| Radius search, 2 km, dense city centre, with price and bedroom filters | 100,000 listings clustered realistically in Accra, Doha and London, plus 100,000 contact addresses as index noise | p95 < 1 s (NFR); aim < 300 ms |
| Map viewport, city zoom (≤ 500 points) | same | p95 < 500 ms |
| Map viewport, country zoom (clustered) | same | p95 < 800 ms |
| Polygon search, 100 vertices | same | p95 < 1 s |
| Distance-sorted first page and keyset page 5 | same | p95 < 500 ms |
| Notes list (50 per page) on a property with 2,000 notes | — | p95 < 300 ms |

The test also asserts that the plan uses the spatial index, so a regression shows as a failure, not just a slower number. Coordinates are clustered by design: uniform random points would make radius tests unrealistically easy.

## 8. Property notes architecture

### 8.1 Existing table and gaps (G4)

`property_notes` has `body`, `visibility`, `is_pinned`, `created_by`, `version` and timestamps. Missing:

| Gap | Change |
|---|---|
| No archive | `archived_at`, `archived_by`, `archived_reason`. No hard delete through the API. |
| No editor tracking | `updated_by`. |
| No length limit | CHECK 1–10,000 characters. Body is plain text, never HTML or markdown. |
| No category | `category` (`general`, `access`, `viewing`, `maintenance`, `legal`, `owner`). PRP-07's "key and access information" lives in `access` notes. |
| A unit may belong to a different property | Composite foreign key `(company_id, property_id, unit_id)` to `units`. This needs a unique key `(company_id, property_id, id)` on units. |
| A property-wide note visible to tenants would reach every tenant in the building | CHECK: `visibility = 'tenant'` requires `unit_id` (L-D8). |
| No edit history | `property_note_revisions` (L-D7, §10). |
| No redaction | `redacted_at` and `redacted_by`, plus a redaction operation (§11). |
| Pinned order | `pinned_at`; at most 5 pinned per property, enforced in the service. |

### 8.2 Relationship to other note stores

- **CRM `activities` (type `note`)** stays the timeline for contacts, leads and deals (CRM-04). Property notes are not copied into it; a merged timeline view is a UI composition, not duplicated data.
- **`properties.internal_notes` (gap G6):** M2 exposes this free-text field to every holder of `property.view`, which for agents is office-wide. It overlaps with notes and bypasses note permissions. **Recommendation (L-D9):** migrate any existing value into a pinned internal note, then remove the field from the API. It has not been released, so this is not a breaking change for customers.

### 8.3 Behaviour

- **Order:** pinned first, then newest. Filters: unit, category, visibility, author, archived.
- **Edits:** use `If-Match`; each edit stores the previous body as a revision. Creates use `Idempotency-Key` (ADR-003).
- **Out of scope:** mentions, attachments (Documents module), replies, and portal reading (issue #12).

### 8.4 Key register (L-D10, PRP-07)

The Phase 2 tables `key_sets` and `key_movements` are used as designed. Milestone 5 adds:

- **Current holder on the key set:** `holder_membership_id`, `holder_contact_id`, `checked_out_at` and `due_back_at`, kept in step with the movement log, so the overdue list needs no scan of history.
- **Housekeeping columns:** `updated_at`, `version`, `created_by` and `retired_at`.

| Current status | Allowed movement | New status |
|---|---|---|
| `in_office` | check out (to a staff member or a contact; due-back time optional) | `checked_out` |
| `in_office`, `checked_out` | report lost | `lost` |
| `checked_out`, `with_owner` | check in | `in_office` |
| `lost` | found | `in_office` |
| `in_office`, `with_owner`, `lost` | retire (`key.manage`) | `retired` |

A key set can be created as `in_office` or `with_owner`.

| Endpoint | Purpose |
|---|---|
| `GET` / `POST /properties/{id}/key-sets` | List a property's key sets; add a key set |
| `GET` / `PATCH /key-sets/{id}` | Read a key set; edit its label, description or unit |
| `POST /key-sets/{id}/check-out`, `/check-in`, `/report-lost`, `/found`, `/retire` | Movement actions |
| `GET /key-sets/{id}/movements` | Movement history |
| `GET /key-sets?filter[status]=checked_out&filter[overdue]=true` | Company-wide list of keys out and overdue |

Every movement is audited. Rules:

- Movements are append-only.
- A staff holder must be an active member of the company.
- Permissions are `key.view`, `key.issue` and `key.manage` (ADR-006).

## 9. Note permissions (L-D6)

No note permissions exist today. Reusing `property.view` would expose internal notes, including access instructions, to every agent in the office, so new permissions are recommended:

| Permission | Allows |
|---|---|
| `property_note.view` | Read notes on properties within the user's property scope. |
| `property_note.create` | Add internal notes; edit, pin and archive **their own** notes. |
| `property_note.manage` | Edit, archive and restore anyone's notes, change visibility to `landlord` or `tenant`, and redact. |

| Role | Grants (scope) |
|---|---|
| Company owner, office administrator | all three (all) |
| Property manager | all three (office) |
| Sales manager | all three (office) |
| Agent | view, create (office) |
| Accountant | view (all) |
| Maintenance staff | none. Access details reach technicians through work orders, not the notes list. |
| Landlord, tenant | none until issue #12. The portal scopes fail closed, so a `landlord` or `tenant` note is stored but not readable by portal users yet. |

Rules:

- A user sees notes only on properties they can see (property scope plus RLS). Otherwise the response is 404.
- Making a note visible outside the company always needs `manage` and is audited separately.

## 10. Audit requirements

| Event | Recorded |
|---|---|
| `property_note.created` | note id, property and unit, category, visibility, body length. **Not the body.** |
| `property_note.updated` | changed fields; for the body, the revision id and old and new lengths |
| `property_note.visibility_changed` | old and new visibility (always audited, even with other changes) |
| `property_note.pinned` / `.unpinned`, `.archived` / `.restored` | reason where applicable |
| `property_note.redacted` | who, when and reason category. No content. |
| `property.location_changed` | old and new coordinates and source (part of the existing property update audit, made explicit) |
| Geocoding suggestions | Not audited. Counted per company for rate limiting and cost. Query text is never logged. |
| Searches and map views | Not audited (volume). Exports remain audited as before. |

The audit log is append-only and retained 2–7 years (P1-D §14.5). Putting note text in it would make free-text personal data impossible to erase. Note history therefore lives in `property_note_revisions` (L-D7), which follows the note's own retention and redaction; audit rows point to revision ids.

## 11. Data retention requirements

| Data | Retention | Basis |
|---|---|---|
| Notes and revisions | While the property record exists. Archived notes stay restorable; there is no time-based purge (they are business records, unlike media). | PRP-07; no shorter rule in P1-D §14.5 |
| Erasure requests | Free-text notes can name people. `manage` users can **redact** a note: the body and all its revisions are replaced by a marker, and metadata and audit rows remain. | P1-D §15 (GDPR-style erasure, subject to legal retention) |
| Legal hold | Not added in M5. If notes must become dispute evidence, they follow the documents module's hold model later. | Scope |
| Coordinates | Kept with the address. Owner-occupied properties of individuals make location personal data, so it follows the property's retention. | GDPR / Ghana DPA / UK GDPR |
| Geocoder responses | Not stored, except the coordinates the user accepted. | Licensing (§2.2) |
| Account closure | Deleted with the company 90 days after cancellation (Phase 14), like all company data. | P1-D §14.5 |

## 12. Database changes (migration 0019)

1. `CREATE EXTENSION IF NOT EXISTS postgis`.
2. `addresses`:
   - add the generated `location geography(Point,4326)` column;
   - add `geocode_accuracy` and `geocoded_at`, and a CHECK on `geocode_source`;
   - add the partial GiST index `(company_id, location)`.
3. `countries.bounds` (box), seeded for GH, QA and GB.
4. `units`: unique `(company_id, property_id, id)` for the note composite foreign key.
5. `property_notes`:
   - columns from §8.1;
   - body length CHECK and tenant-requires-unit CHECK;
   - composite foreign key to units;
   - `app.touch_row` trigger;
   - indexes `(company_id, property_id, is_pinned DESC, created_at DESC) WHERE archived_at IS NULL` and `(company_id, unit_id)`.
6. `property_note_revisions`:
   - columns `company_id`, `note_id`, `revision`, `body`, `edited_by`, `edited_at`;
   - RLS policy and grants;
   - the app role may insert but not update or delete;
   - redaction runs through a `SECURITY DEFINER` function that only blanks bodies.
7. Seed the `property_note.*` permissions and the role grants in §9.
8. Data step: move non-empty `properties.internal_notes` into pinned notes (L-D9). The column is dropped in a later migration (expand / contract).
9. CI and test images change to `postgis/postgis:16-3.x`, and the database verification script gains spatial and notes integrity tests.

None of these changes break M1–M4 data. The generated column rewrites `addresses` once, which is acceptable before launch (P1-D §14.6 expand / contract applies after launch).

## 13. API changes

| Endpoint | Change |
|---|---|
| `GET /api/v1/properties`, `GET /api/v1/listings` | `filter[near]`, `filter[radius]`, `filter[bbox]`, `filter[polygon]`, `filter[hasLocation]`, `filter[locality]`, `filter[adminArea1]`, `sort=distance`; `distanceMeters` in results |
| `GET /api/v1/properties/map`, `GET /api/v1/listings/map` | new: points or clusters (§5.4) |
| `GET /api/v1/geocoding/suggestions?q=&countryCode=` | new (if L-D2 includes a provider) |
| Property create and update | address input accepts `geocodeSource` and `geocodeAccuracy`; responses add them and the `location-may-be-stale` flag; `internalNotes` removed (L-D9) |
| `GET /api/v1/properties/{id}/notes`, `POST …/notes` | list and create (`Idempotency-Key`) |
| `GET` / `PATCH /api/v1/property-notes/{id}` | read and edit (`If-Match`): body, category, visibility, pin |
| `POST /api/v1/property-notes/{id}/archive`, `/restore`, `/redact` | action endpoints (ADR-003) |
| `GET /api/v1/property-notes/{id}/revisions` | history (`manage` or author) |

**New problem types:** `invalid-coordinates`, `outside-country`, `radius-too-large`, `invalid-polygon`, `area-too-large`, `distance-sort-needs-near`, `tenant-note-needs-unit`, `pin-limit`, `geocoding-unavailable`. The OpenAPI document is regenerated.

## 14. UI/UX impact (built in M6; wireframes under issue #7)

- **Gap G8:** the Phase 3 wireframes have no map search, location picker or notes panel. Issue #7 wireframes must cover them before M6.
- **Property form:** a location section with address suggestions and a map pin, plus latitude and longitude fields. The pin is never the only way to enter a location (ADR-002, WCAG 2.2 AA dragging alternative).
- **Registers:** a list/map toggle and split view, a radius control, polygon drawing, clustering, and "search this area".
  - Every map result is also available as an accessible list, and keyboard users can operate the map controls.
  - On mobile, "near me" uses device location with the browser permission prompt; the location is never stored.
- **Notes tab:** pinned notes first, and category chips.
  - Audience badges use text as well as colour (Internal / Landlord / Tenant).
  - A confirmation step appears before a note becomes visible outside the company, and access notes carry a warning: do not store alarm codes or passwords.
- **Qatar:** RTL text plugin for Arabic map labels. **Ghana:** pin-first flow, with the digital address shown beside the map.

## 15. Security impact

| Area | Control |
|---|---|
| Location privacy | Exact coordinates are staff-only. No public endpoint in M5. Vacant and owner-occupied locations are sensitive (burglary risk), so public precision is decided with PRP-10 (§17). |
| Contact addresses | Never reachable through spatial endpoints (joins start from properties). Negative test. |
| Injection | Coordinates are parsed as numbers and polygons as number arrays, all passed as bound parameters. No WKT built from strings. |
| Abuse and denial of service | Radius ≤ 50 km, ≤ 100 vertices, area and bbox span limits, ≤ 500 raw map points. Two controls the API does not have yet are added in M5: a per-transaction `statement_timeout` on spatial queries, and per-company rate limits on the map and geocoding endpoints. |
| Information leakage | Scope and RLS applied before counting and clustering. Cross-company and cross-office negative tests for every new endpoint. |
| Third-party geocoder | Server-side proxy (key never in the browser). Address text sent to the provider makes it a sub-processor: update the sub-processor list and data processing agreement. No query logging. |
| Map tiles | Self-hosted tiles mean no third-party IP or area tracking (L-D3). |
| Notes | Plain text with output encoding (no XSS). Visibility changes need `manage` and are audited. Tenant notes must target a unit. Portal reads fail closed until #12. `If-Match` on edits. Revisions are append-only. |
| Sensitive access data | Access notes may still attract alarm codes despite the warning (open risk, §16). A secure "access details" vault is not in scope. |

## 16. Performance and other risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| P-1 | Planner prefers the company B-tree over the spatial index for large tenants | Medium | Medium | Composite `btree_gist` index, and the performance test asserts the plan. Fallback: single-column GiST or a denormalised `properties.location`. |
| P-2 | Dense radius searches touch thousands of rows before filters | Medium | Medium | KNN ordering, keyset paging, page-then-join (proven in M3), filters pushed into the spatial scan. |
| P-3 | Country-level map views over 100k points | High without clustering | High | Server grid clustering above 500 points. |
| P-4 | Complex polygons are slow | Low | Medium | Vertex and area caps, bounding-box prefilter. |
| P-5 | Arabic trigram search silently matches nothing under a `C` locale (G10) | Medium | Medium | Test, plus a documented database locale requirement. |
| P-6 | PostGIS image or version differs between CI, local and production | Medium | Low | Pin `postgis/postgis:16-3.x` and record the version in the verification script. |
| R-1 | Geocoder licence or cost changes | Medium | Medium | Port and adapter, suggest-only use, go-live licence check. |
| R-2 | Poor coordinate quality in Ghana | High | Medium | Pin-first flow, accuracy field, a "missing location" list. |
| R-3 | Sensitive access codes written into notes | Medium | High | UI warning, restricted note permissions, redaction. A vault can be proposed separately. |
| R-4 | Key register (PRP-07, Must) unscheduled (G7) | Certain | Medium | Decision L-D10. |

## 17. Future portal implications

| Future work | Implication now |
|---|---|
| Landlord and tenant portals (issue #12) | `landlord` notes resolve through `property_ownerships`; `tenant` notes through the unit's active lease. Both read only non-archived, non-redacted notes. M5 stores visibility and enforces the unit rule, and the scope resolvers come with #12. |
| Website and portal feeds (PRP-10) | Listings need a **location display precision** (exact / approximate / area only) before any public map. Feeds emit WGS 84 coordinates from `addresses`. Self-hosted tiles also suit a public website without per-view fees. |
| CRM requirement matching | `requirements.locations` (jsonb, format undefined, gap G9) should use the same radius and polygon shapes as M5 so matching reuses the same query code. M5 documents the format but does not implement matching. |
| Mobile and offline | Not in scope. PMTiles allows offline basemaps later. |

### 17.1 Public location precision (additional requirement)

Exact locations stay staff-only. When PRP-10 publishes listings to websites and portals, each listing gets a public location precision:

| Level | What the public sees |
|---|---|
| **Exact** | The confirmed point |
| **Approximate** | A point moved 250–500 m, fixed once per listing so it cannot be averaged out. This is the default for occupied homes. |
| **Area Only** | The locality name and its centre, with no point for the property |
| **Hidden** | No map position and no coordinates in feeds |

Feeds and public search read only the derived public point. The full rules are in [ADR-006](../decisions/ADR-006-location-notes-keys.md#public-location-precision-future-prp-10). Milestone 5 implements none of it; it only keeps the confirmed point as the single source from which the public point is derived.

## 18. Gaps found

| ID | Gap | Resolution |
|---|---|---|
| G1 | PostGIS not installed (migrations, CI, local) | Migration 0019 and the CI image (§12) |
| G2 | No spatial column or index | §1.2 |
| G3 | `geocode_source` is free text; no accuracy | §3 |
| G4 | `property_notes` lacks archive, editor, limits, unit consistency, tenant rule, history, redaction | §8.1 |
| G5 | No note permissions | §9, L-D6 |
| G6 | `properties.internal_notes` bypasses note permissions | L-D9 |
| G7 | Key register (PRP-07, Phase 3 gate item 6) in no Phase 4 milestone | L-D10 |
| G8 | No map, location picker or notes wireframes | Issue #7, before M6 |
| G9 | `requirements.locations` format undefined | Documented in M5; implemented with CRM |
| G10 | Arabic trigram search may fail under a `C` locale | Test plus locale requirement |
| G11 | No map or polygon API, although PRP-08 requires them | §5 |

## 19. Decisions requested before M5 starts

| ID | Question | Recommendation |
|---|---|---|
| L-D1 | Spatial model | PostGIS `geography(Point,4326)` generated from the existing coordinates on `addresses`, composite GiST index. |
| L-D2 | Geocoding | Suggest-only through a server-side port. A person confirms every stored point. One permanent-storage provider adapter (Mapbox candidate) enabled by config; or no provider in M5 if you prefer. |
| L-D3 | Map provider (for M6) | MapLibre GL JS with self-hosted OpenStreetMap vector tiles (PMTiles on R2). Commercial tiles or satellite as an optional layer later. |
| L-D4 | Search shapes and limits | Radius ≤ 50 km, bbox, polygon ≤ 100 vertices through GET; map endpoints with server clustering above 500 points. |
| L-D5 | Coordinate sanity | Reject (0, 0) and points outside seeded country bounds. |
| L-D6 | Note permissions | New `property_note.view` / `.create` / `.manage` with the grants in §9. |
| L-D7 | Note history | `property_note_revisions` (append-only, redactable). The audit log records metadata, never note text. |
| L-D8 | External visibility | Only `manage` can make a note visible to landlords or tenants. Tenant notes must target a unit. Portal reads fail closed until #12. |
| L-D9 | `properties.internal_notes` | Migrate to pinned notes, remove from the API, drop the column later. |
| L-D10 | Key register (PRP-07) | Include it in M5 as approved Phase 4 scope (Phase 3 gate item 6, Must), using the existing `key_sets` / `key_movements` tables: check-out, check-in, overdue list. Otherwise track it as a new issue for a later milestone. |

Once these are approved, the M5 plan is:

- **Migration 0019** (§12).
- **Spatial filters and map endpoints** for properties and listings.
- **Geocoding port** (per L-D2).
- **Notes API** with revisions and redaction.
- **Key register** if L-D10 includes it.
- **Tests:** isolation, scope, spatial correctness and performance (§7), including the Arabic search test.
- **CI** on the PostGIS image.
