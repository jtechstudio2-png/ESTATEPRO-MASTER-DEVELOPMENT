# EstatePro web app

The staff web interface for Phase 4 (Property Management): properties and
units, listings, gallery and floor plans, notes, the key register, map
search and the Phase 4 dashboard panels. It follows the approved M6
wireframes ([docs/phase-4/M6-WIREFRAMES.md](../../docs/phase-4/M6-WIREFRAMES.md))
and the [UI consistency checklist](../../docs/phase-4/UI-CONSISTENCY-CHECKLIST.md).

| Decision | What it means here |
|---|---|
| W-D1 | Next.js 15 (App Router), React Aria Components, Phase 3 design tokens (`src/styles/tokens.css`) |
| W-D3 | Gallery order by drag, by arrow buttons and by "Move to position" |
| W-D4 | Self-hosted OpenStreetMap basemap (PMTiles) — see [Basemap](#basemap) |
| W-D5 | English and Arabic message files (`src/messages/{en,ar}`), right-to-left layout for Arabic |
| W-D6 | Responsive web from 320 px; no offline mode |
| W-D9 | Backend-for-frontend: OIDC with PKCE, server-side session, HttpOnly cookie, CSRF |

## How it talks to the API

The browser never holds an access token. Sign-in (`/auth/login` →
provider → `/auth/callback`) creates a server-side session in PostgreSQL
(`web_sessions`, migration 0020): the cookie carries a random id, the table
holds its SHA-256 and the tokens sealed with AES-256-GCM. The browser calls
`/bff/{path}`, which adds the access token and company, checks CSRF on
writes (Origin or Sec-Fetch-Site, plus the `X-CSRF-Token` header) and
forwards to `{API_BASE_URL}/api/v1/{path}`. Access tokens are refreshed
shortly before they expire, once per session even under concurrent requests.

When a session ends: with nothing unsaved the page goes to sign-in and
comes back; with unsaved changes (a note, a form) the page and its draft stay
in memory, the user signs in in a new tab and the page picks up the new
session's CSRF token from `GET /auth/csrf` (same company only). Nothing is
written to device storage.

## Running it

```bash
cp apps/web/.env.example apps/web/.env.local   # fill in the values
pnpm --filter @estatepro/web dev                # http://localhost:3100
```

The API must be running (`apps/api`), and the database must have migration
0020 applied with a password set for the `estatepro_web` role.

| Script | Does |
|---|---|
| `pnpm --filter @estatepro/web lint` | ESLint and Stylelint |
| `pnpm --filter @estatepro/web typecheck` | TypeScript |
| `pnpm --filter @estatepro/web messages:check` | English and Arabic messages have the same keys and placeholders |
| `pnpm --filter @estatepro/web test` | Unit tests with coverage thresholds (needs PostgreSQL for the session store tests: `TEST_DATABASE_ADMIN_URL`) |
| `pnpm --filter @estatepro/web test:e2e` | End-to-end suite (below) |
| `pnpm --filter @estatepro/web api:types` | Regenerates `src/lib/api-schema.ts` from `apps/api/openapi.json` |

## Tests

**Unit (vitest, `test/`)** cover the logic layer — `src/lib`, `src/server`,
the middleware and route handlers — including the whole sign-in flow
against a real OIDC provider and the session store on PostgreSQL.

**End-to-end (Playwright, `e2e/`)** run the production build against the
real API, worker and a fresh database built from every migration, with a
local OIDC provider, SeaweedFS (S3) and ClamAV. Each wireframe group has a
spec (`properties`, `listings`, `media`, `notes`, `keys`, `maps`, `field`,
`shell`); `sweep.spec.ts` runs axe (WCAG 2.1 A/AA) on every screen in
English and Arabic at desktop width and at 320 px. Defaults:

| Variable | Default |
|---|---|
| `E2E_DATABASE_ADMIN_URL` | `postgres://postgres:postgres@127.0.0.1:5432/postgres` (PostGIS 16) |
| `E2E_STORAGE_ENDPOINT` | `http://127.0.0.1:8333` (SeaweedFS S3) |
| `E2E_CLAMAV_HOST` / `_PORT` | `127.0.0.1` / `3310` |
| Ports | web 3100, API 3201, identity provider 3202 |
| `E2E_REUSE_BUILD=1` | skip `next build` when nothing in `src/` changed |

The specs share one seeded database, so files run one after another.

## Basemap

`scripts/build-basemap.sh <YYYYMMDD> <dir> [--upload]` extracts the launch
markets (Ghana, Qatar, United Kingdom) from a Protomaps OpenStreetMap build
into one PMTiles archive, fetches the label glyphs and, with `--upload`,
copies both to the tile bucket. Then set:

```
MAP_TILES_URL=pmtiles://https://tiles.example.com/basemap/estatepro.pmtiles
MAP_GLYPHS_URL=https://tiles.example.com/basemap/fonts/{fontstack}/{range}.pbf
MAP_TILES_ORIGIN=https://tiles.example.com
```

Without `MAP_TILES_URL` the map is a plain background: pins, clusters, the
radius and drawing tools and the location picker all still work.

## Storage CORS (Cloudflare R2 or any S3)

Uploads go from the browser straight to the media bucket on a signed URL
(ADR-005), and the map reads the PMTiles archive with HTTP range requests.
Both buckets need a CORS rule for the web origin; SeaweedFS in development
allows every origin, R2 allows none until configured.

Media bucket (`MEDIA_ORIGIN`):

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

Tile bucket (`MAP_TILES_ORIGIN`):

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["range", "if-match"],
    "ExposeHeaders": ["etag", "content-length", "content-range"],
    "MaxAgeSeconds": 86400
  }
]
```

Apply with `wrangler r2 bucket cors set <bucket> --file cors.json` or the
S3 `PutBucketCors` call. Both origins must also be in the
Content-Security-Policy (`MEDIA_ORIGIN`, `MAP_TILES_ORIGIN`).
