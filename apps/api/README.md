# EstatePro API

NestJS 12 · TypeScript (strict, ES modules) · Kysely · PostgreSQL 16 · managed OIDC identity provider.

Decisions: [ADR-001 authentication](../../docs/decisions/ADR-001-authentication-managed-identity-provider.md) · [ADR-002 accessibility](../../docs/decisions/ADR-002-accessibility-wcag-2-2-aa.md) · [ADR-003 API conventions](../../docs/decisions/ADR-003-api-conventions.md). The contract is [`openapi.json`](openapi.json).

## Rules for contributors

1. **Company data is read and written only through `TenantDb.run(ctx, tx => …)`.** It opens a transaction and sets `app.company_id`/`app.user_id`, which the row-level security policies read. There is no other database handle available to request code. If the context were missing, RLS returns nothing.
2. **The runtime role `estatepro_app` never owns tables** (owners bypass RLS). A catalogue test enforces this and that every `company_id` table has RLS.
3. **Errors are thrown as `Problems.*`** (RFC 9457). Never return error JSON by hand; never leak SQL or internal names.
4. **Every endpoint declares its permission** with `@RequirePermission('resource.action')` unless it is company reference data open to all staff. Scope (`all`, `office`, `own`, …) arrives through `@Scope()` and must be applied to the query.
5. **State changes go through action endpoints**, write an audit event (`AuditService.record`) and an outbox event (`AuditService.emit`) in the same transaction.
6. **Money is a decimal string plus currency**, never a JavaScript number.
7. **Record-level scope for properties** goes through `propertyScopeSql` (lists) and `assertPropertyAccess` (single records): 404 when the member cannot see the record, 403 when they can see it but the action's scope does not cover it.
8. **Updates take `If-Match: "<version>"`** (428 when missing, 412 when stale) and skip the write when nothing changes, so the version only moves on a real change. **Creates accept `Idempotency-Key`.**
9. **JSON columns keep their stored keys**: the Kysely case plugin maps column names only. Columns with an underscore before a digit (`address_line_1`) are listed in `SchemaCasePlugin`; a catalogue test checks every column maps back.
10. After changing routes or DTOs, regenerate the contract: `pnpm --filter @estatepro/api openapi`. A test fails if it is stale.

## Local setup

```bash
pnpm install
# PostgreSQL 16+ with PostGIS 3 and a UTF-8 character-type locale (C.UTF-8 or en_US.UTF-8, needed for
# Arabic trigram search) and a superuser; the tests build their own database from database/migrations.
# Docker: postgis/postgis:16-3.4 · Debian/Ubuntu: apt install postgresql-16-postgis-3
export TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
# Media tests need S3-compatible storage, clamd and Poppler (pdfinfo, pdftoppm); they never skip.
docker run -d --name seaweedfs -p 8333:8333 -v "$PWD/dev/seaweed":/config chrislusf/seaweedfs:3.80 \
  server -s3 -s3.port=8333 -s3.config=/config/s3.json -dir=/data   # s3.json: key estatepro-test / estatepro-test-secret
docker run -d --name clamav -p 3310:3310 clamav/clamav:1.4
pnpm --filter @estatepro/api test        # lint/typecheck: pnpm --filter @estatepro/api lint | typecheck
```

Override the test services with `TEST_STORAGE_ENDPOINT`, `TEST_STORAGE_BUCKET`, `TEST_STORAGE_ACCESS_KEY_ID`, `TEST_STORAGE_SECRET_ACCESS_KEY`, `TEST_CLAMAV_HOST` and `TEST_CLAMAV_PORT`.

Running the server needs a migrated database with login enabled for the runtime roles (an operations step, not a migration):

```sql
ALTER ROLE estatepro_app LOGIN PASSWORD '…';
ALTER ROLE estatepro_auth LOGIN PASSWORD '…';
ALTER ROLE estatepro_platform LOGIN PASSWORD '…'; -- only where the provisioning tool runs
```

Then copy `.env.example` to `.env`, fill in the identity provider and storage values, and run `pnpm --filter @estatepro/api build && pnpm --filter @estatepro/api start`.

### Background worker

`node dist/worker/main.js` (`pnpm --filter @estatepro/api worker`) runs media processing and scheduled jobs from a PostgreSQL-backed queue (`scheduled_jobs`, ADR-005 M-D6). It needs the API's settings plus `PLATFORM_DATABASE_URL` (queue claims and discovery only) and `CLAMAV_HOST`, and the `pdfinfo`/`pdftoppm` tools (Poppler) for PDF previews. Several workers can run side by side; jobs are claimed with `FOR UPDATE SKIP LOCKED`. Jobs: media processing (scan, validate, master and sizes), listing expiry (hourly, by property time zone), abandoned-upload cleanup and stuck-processing timeout (every 15 minutes), archived-media purge after 90 days and storage-usage reconciliation (daily). Monthly audit-log partitions (`app.ensure_monthly_partitions`) need the table owner and are run by the deployment, not the worker.

Storage bucket rules to configure at the provider: delete objects under `quarantine/` after 1 day, and abort incomplete multipart uploads after 1 day. The bucket stays private (no public access).

## Provisioning a pilot company

Platform staff (a `platform_staff` row with role `platform_owner` or `super_admin`) create companies with:

```bash
PLATFORM_DATABASE_URL=postgres://estatepro_platform:…@host/estatepro \
pnpm --filter @estatepro/api provision-company -- \
  --staff-email ops@estatepro.example --legal-name "Accra Homes Ltd" --slug accra-homes \
  --country GH --data-region eu-west --office-code OSU --office-name "Osu" \
  --owner-email ama@accrahomes.example --owner-name "Ama Mensah" --status active
```

The owner then signs in through the identity provider with that email (verified); the account is linked on first sign-in. The first platform staff user is inserted manually by the database administrator.

## Endpoints (Phase 4)

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/property-types` | `property.view` |
| POST | `/api/v1/property-types` | `settings.manage` |
| PATCH | `/api/v1/property-types/{id}` | `settings.manage` (company types only) |
| GET, POST | `/api/v1/properties` | `property.view`, `property.create` |
| GET, PATCH | `/api/v1/properties/{id}` | `property.view`, `property.update` |
| POST | `/api/v1/properties/{id}/archive`, `/restore` | `property.archive` |
| GET, POST | `/api/v1/properties/{id}/units` | `property.view`, `property.update` |
| GET, PATCH | `/api/v1/units/{id}` | `property.view`, `property.update` |
| POST | `/api/v1/units/{id}/archive`, `/restore` | `property.archive` |
| POST | `/api/v1/units/{id}/availability` | `property.update` |
| GET, POST | `/api/v1/listings` | `listing.view`, `listing.create` |
| GET, PATCH | `/api/v1/listings/{id}` | `listing.view`, `listing.update` |
| POST | `/api/v1/listings/{id}/publish`, `/unpublish`, `/status-transitions` | `listing.publish` (agents: own listings, ADR-004 D1) |
| POST | `/api/v1/listings/{id}/assign` | `listing.update` with office or all scope (D4) |
| POST | `/api/v1/listings/{id}/relist` | `listing.create` (D3) |
| POST | `/api/v1/listings/{id}/archive`, `/restore` | `listing.archive` |
| PUT, DELETE | `/api/v1/listings/{id}/translations/{locale}` | `listing.update` |
| GET | `/api/v1/listings/{id}/status-history`, `/price-history`, `/history` | `listing.view` |
| GET | `/api/v1/properties/{id}/listings`, `/api/v1/units/{id}/listings` | `listing.view` + property visible |
| GET, PUT | `/api/v1/settings/listings` | `listing.view`, `settings.manage` |
| POST | `/api/v1/media/uploads`, `/media/uploads/{id}/confirm` | `property.update` (or `listing.update` with `listingId`) |
| GET | `/api/v1/properties/{id}/media`, `/api/v1/media/{id}` | `property.view` |
| POST | `/api/v1/properties/{id}/media/links` | `property.update` (YouTube, Vimeo, Matterport) |
| PATCH | `/api/v1/media/{id}` | `property.update` |
| POST | `/api/v1/media/{id}/archive`, `/restore` | `property.archive` |
| POST | `/api/v1/media/{id}/purge`, `/legal-hold` | `property.archive` with `all` scope |
| GET, PUT | `/api/v1/listings/{id}/media` | `listing.view`, `listing.update` |
| GET | `/api/v1/settings/storage` | `property.view` |
| GET | `/api/v1/properties/map`, `/api/v1/listings/map` | `property.view`, `listing.view` (viewport required; rate-limited) |
| GET | `/api/v1/geocoding/suggestions` | `property.update` (suggestions only; rate-limited) |
| GET, POST | `/api/v1/properties/{id}/notes` | `property_note.view`, `property_note.create` |
| GET, PATCH | `/api/v1/property-notes/{id}` | `property_note.view`; authors edit with `property_note.create`, others need `property_note.manage` |
| POST | `/api/v1/property-notes/{id}/archive`, `/restore` | author with `property_note.create`, or `property_note.manage` |
| POST | `/api/v1/property-notes/{id}/redact` | `property_note.manage` |
| GET | `/api/v1/property-notes/{id}/revisions` | author or `property_note.manage` |
| GET | `/api/v1/key-sets`, `/api/v1/properties/{id}/key-sets`, `/api/v1/key-sets/{id}`, `/key-sets/{id}/movements` | `key.view` |
| POST, PATCH | `/api/v1/properties/{id}/key-sets`, `/api/v1/key-sets/{id}`, `/key-sets/{id}/retire` | `key.manage` |
| POST | `/api/v1/key-sets/{id}/check-out`, `/check-in`, `/report-lost`, `/found` | `key.issue` |

Lists use `limit`, `cursor`, `sort` and `filter[...]` (ADR-003 §6); see `openapi.json` for the filters each list accepts. Listing rules are recorded in [ADR-004](../../docs/decisions/ADR-004-listing-rules.md); media in [ADR-005](../../docs/decisions/ADR-005-media-architecture.md) and the [Media Ownership and Retention Policy](../../docs/policies/MEDIA-OWNERSHIP-AND-RETENTION-POLICY.md); location, notes and keys in [ADR-006](../../docs/decisions/ADR-006-location-notes-keys.md). `test/listings.performance.test.ts` checks list queries at p95 < 1 s on 100,000 listings.

### Location search (ADR-006)

- The property and listing lists, and their `/map` endpoints, accept `filter[near]=lat,lng` with `filter[radius]` (metres, up to 50 km), `filter[bbox]=west,south,east,north`, `filter[polygon]` (up to 100 "longitude latitude" points), `filter[hasLocation]`, `filter[locality]` and `filter[adminArea1]`. `sort=distance` needs `filter[near]`; results then carry `distanceMeters`.
- Map endpoints return points, or grid clusters above 500 matches. Scope and row-level security apply before counting.
- Stored coordinates are always confirmed by a user. `address.geocodeSource` records how a point was found (`manual_pin` by default, `geocoder` for an accepted suggestion). Points at 0,0 or outside the country's bounding box are rejected. Editing an address without coordinates keeps the point and sets `locationStale`; send `latitude: null, longitude: null` to remove it.
- Geocoding suggestions use Mapbox when `GEOCODER_PROVIDER=mapbox` and `MAPBOX_ACCESS_TOKEN` are set; otherwise the endpoint answers `geocoding-unavailable` and pins still work. Address search text is never logged.
- Searches run with `SEARCH_STATEMENT_TIMEOUT_MS` (default 5 s; a timeout answers `search-timeout`, 503). Rate limits (`MAP_RATE_LIMIT_PER_MINUTE`, `GEOCODER_RATE_LIMIT_PER_MINUTE`) are per API instance.
- `properties.internalNotes` is no longer part of the API: migration 0019 moved its text into pinned property notes.

## Tests

- Real PostgreSQL, real JWT signatures (a test identity provider serves a JWKS over HTTP), no mocked business rules.
- Coverage thresholds: 95% lines, statements and functions; 90% branches.
- Media tests run against SeaweedFS (S3 API), real clamd and Poppler; performance tests check listing search (100,000 listings, p95 < 1 s) and photo processing (12 MP, under 3 s each).
- Location tests run on PostGIS; `test/location.performance.test.ts` checks radius, distance paging, map, clustering, polygon and notes targets on 100,000 listings, and that the spatial index is used. The geocoder is tested against a local stub of the Mapbox API. `test/migration-0019.test.ts` upgrades a database holding pre-M5 data.
- `test/support/probe.controller.ts` is a test-only controller for guard behaviour; it is never registered by `AppModule`.
