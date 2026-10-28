# ADR-006 — Location search, property notes and key register

| | |
|---|---|
| Status | Accepted (product owner, "Milestone 5 Decisions Approved") |
| Context | [M5 Location Search and Property Notes Verification Report](../phase-4/M5-LOCATION-NOTES-VERIFICATION.md) |
| Requirements | PRP-01 (geo-coordinates), PRP-07 (notes, key and access information), PRP-08 (location search), PRP-10 (future public location precision) |

## Decisions

| ID | Decision |
|---|---|
| L-D1 | Each address gets a spatial point (`addresses.location geography(Point, 4326)`). PostgreSQL calculates it from `latitude` and `longitude`, so the application never writes it and it cannot drift. It is indexed per company with a composite GiST index on `(company_id, location)`. |
| L-D2 | Geocoding only produces suggestions. Every stored location is confirmed by a user, either by placing a pin or by accepting a suggestion. Mapbox (permanent geocoding) is the suggestion provider, configured by environment (`GEOCODER_PROVIDER`, `MAPBOX_ACCESS_TOKEN`). Without it, the suggestions endpoint reports that geocoding is unavailable, and pins still work. |
| L-D3 | Maps are rendered with MapLibre GL JS over self-hosted OpenStreetMap vector tiles (Protomaps PMTiles in our own object storage). Built in M6. |
| L-D4 | Search supports a radius of up to 50 km, the map viewport (bounding box) and polygons of up to 100 points. Map results are clustered above 500 records. |
| L-D5 | Coordinates at 0,0, and coordinates outside the country's boundary box (`countries.bounds`), are rejected. |
| L-D6 | Dedicated note permissions: `property_note.view`, `property_note.create` and `property_note.manage`. |
| L-D7 | Previous note text is kept in `property_note_revisions`. Audit logs record note metadata only, never note text. |
| L-D8 | Only managers and admins (holders of `property_note.manage`) may make a note visible to landlords or tenants. A tenant-visible note must reference a unit. |
| L-D9 | `properties.internal_notes` is migrated into pinned notes and removed from the API. The column is deprecated and dropped in a later migration. |
| L-D10 | The key register (`key_sets`, `key_movements`) is part of Milestone 5. |
| L-R1 | Additional requirement: future public location precision levels are documented now (see below). They are implemented with PRP-10. |

## Note permission grants

| Role | `property_note.view` | `property_note.create` | `property_note.manage` |
|---|---|---|---|
| Company owner, office administrator | all | all | all |
| Sales manager, property manager | office | office | office |
| Agent | office | office | — |
| Accountant | all | — | — |
| Maintenance staff, landlord, tenant | — | — | — |

Authors may edit, pin, unpin, archive and restore their own notes while they hold `property_note.create`. Only `manage` users may act on other people's notes, make a note visible outside the company, or redact a note.

## Key register permission grants

| Role | `key.view` | `key.issue` (check out, check in, lost, found) | `key.manage` (add, edit, retire) |
|---|---|---|---|
| Company owner, office administrator | all | all | all |
| Sales manager, property manager | office | office | office |
| Agent | office | office | — |

## Public location precision (future, PRP-10)

Staff always see exact locations inside EstatePro. When listings are published to a website or portal feed (PRP-10), each listing has a public location precision:

| Level | What the public sees | Use |
|---|---|---|
| `exact` | The confirmed point | New developments, commercial premises, owner consent recorded |
| `approximate` | A point moved by a fixed, random distance of 250–500 m, chosen once per listing and kept, so repeated views cannot be averaged back to the real point. It never leaves the listing's country. | Default for occupied residential homes |
| `area_only` | The neighbourhood or locality name and its centre, with no point for the property | Owner asks for discretion; high-value homes |
| `hidden` | No map position and no coordinates in feeds; locality text only | Sensitive or off-market listings |

Rules for PRP-10:

- Precision is set per listing, with a company default. Only `listing.publish` holders may change it, and changes are audited.
- Feeds and public pages read only the derived public point, never `addresses.latitude` or `addresses.longitude`.
- Lowering precision (for example `exact` to `area_only`) takes effect on the next feed run, and the public copy of the old point is removed.
- Public map search uses the public point, so exact locations cannot be found by searching small areas.

Milestone 5 builds no part of this. It only keeps the address model compatible, because the public point is derived from the stored confirmed point.

## Consequences

- PostgreSQL needs the PostGIS extension (3.x). CI uses the `postgis/postgis:16-3.4` image.
- The database must use a UTF-8 character-type locale (`C.UTF-8`, `en_US.UTF-8` or ICU) so trigram search works on Arabic text.
- The geocoding provider receives address search text. Mapbox is added to the sub-processor list.
- Rate limits on map and geocoding endpoints are per API instance in Phase 4. A shared limiter comes with the API gateway work.
