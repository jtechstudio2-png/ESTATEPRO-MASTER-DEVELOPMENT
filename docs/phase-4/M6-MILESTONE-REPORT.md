# Phase 4 · Milestone 6 · Web Interface — Milestone Report

Branch `phase-4/property-management`. Scope: the approved M6 wireframes
([M6-WIREFRAMES.md](M6-WIREFRAMES.md)) under decisions W-D1 to W-D10, the
verified API contracts, ADR-003, ADR-004, ADR-005 and ADR-006, and the
[UI consistency checklist](UI-CONSISTENCY-CHECKLIST.md). The audit branch
is not merged. Buildora, PraiseFlow, Cleanora and the other existing
products are untouched; all work is in `apps/web`, the new API read
endpoints, CI and the Phase 4 documents.

## 1. Deliverables completed

### 1.1 Screens (every wireframe in M6-WIREFRAMES.md)

| Group | Screens | Where |
|---|---|---|
| Sign-in and shell | S-1 company picker, S-2 shell and navigation, S-3 global search | `src/app/(public)`, `components/shell` |
| Properties | P-1 register, P-2 overview, P-3 form, P-4 units and availability, P-5 archive and restore, P-6 activity, P-7 property types | `components/properties`, `components/settings` |
| Listings | L-1 register, L-2 new listing, L-3 record, L-4 editor and translations, L-5 publish checklist, L-6 status, L-7 reassign, L-8 relist, L-9 price and status history, L-10 listing rules | `components/listings` |
| Gallery (issue #7) | G-1 media tab, G-2 upload panel, G-3 details drawer, G-4 plans and documents, G-5 video and tours, G-6 gallery editor, G-7 archived media, G-8 storage | `components/media` |
| Notes | N-1 notes tab, N-2 composer, N-3 history, N-4 archive, restore and redact | `components/notes` |
| Keys | K-1 property keys tab, K-2 company register, K-3 check out, K-4 check in, lost, found and retire, K-5 add and edit, K-6 history, plus quick create from the New menu | `components/keys` |
| Location (issue #7) | M-1 location picker, M-2 listing map search, M-3 property map | `components/map` |
| Mobile | X-1 field actions, X-2 batch room label and "Wait for Wi-Fi", X-3 full-screen composer with the draft kept through re-sign-in, X-4 key cards, X-5 one pane at a time with Near me | as above |
| Tablet | T-1 field visit, T-2 map and list together, T-3 ordering by arrows and "Move to position" | as above |
| Dashboards | D-1 property dashboard panels, D-2 keys I hold | `components/dashboard` |

### 1.2 Platform

- **Backend for frontend (W-D9).** OIDC with PKCE, state and nonce. Server-side sessions live in `web_sessions` (migration 0020); the cookie holds a random id, and tokens are sealed with AES-256-GCM. Access tokens refresh once per session, even under concurrent requests. CSRF is checked on every write. A per-request nonce CSP is set.
  - `/bff` proxy rejects `.` and `..` path segments (found by the new tests).
  - New `GET /auth/csrf` lets a page kept open through a re-sign-in pick up the new session's token, for the same company only.
- **API read endpoints for the screens** (A-1, A-2, A-4 to A-10, U-10), plus contract additions:
  - nullable DTO typing
  - key-set office filter and unit label
  - unit search
  - history date filters and names
  - media `usedIn`

  All are tested and in the regenerated OpenAPI document.
- **Internationalisation.** English and Arabic message files: 1,229 keys each, checked for the same keys and ICU placeholders. Arabic is right to left.
- **Self-hosted basemap tooling (W-D4).** `scripts/build-basemap.sh` builds the PMTiles archive and glyphs for Ghana, Qatar and the UK, and can upload them to R2.

### 1.3 Documentation and CI

- `apps/web/README.md`: architecture, scripts, tests, basemap, and CORS rules for the R2 media and tile buckets.
- `apps/web/.env.example`.
- Root README updated.
- CI gains a `web` job (lint, typecheck, message check, unit tests with coverage on PostgreSQL, production build) and a `web-e2e` job (full Playwright suite with PostGIS, SeaweedFS and ClamAV; report and traces kept on failure).

## 2. Tests executed

All runs below are on the final code, 30 October 2026.

| Suite | Result |
|---|---|
| API unit and integration (vitest, PostgreSQL 16 and PostGIS, SeaweedFS, ClamAV) | 25 files, **288 passed**, 0 failed |
| Web unit (vitest) | 14 files, **64 passed**, 0 failed; 3 repeated runs clean |
| Web end-to-end (Playwright, production build, real API and worker, fresh database from every migration) | **55 passed**, 0 failed, 0 flaky (4.9 min) |
| Lint (ESLint and Stylelint), typecheck, message check (web and API) | Pass. 9 Stylelint warnings are deliberate `!important` utilities (visually hidden, reduced motion) |

The end-to-end tests by area:

| Spec | Tests |
|---|---|
| `properties` | 11 |
| `listings` | 7 |
| `media` | 6 |
| `notes` | 5 |
| `keys` | 7 |
| `maps` | 6 |
| `field` | 4 |
| `shell` | 5 |
| `sweep` | 3 |
| `perf` | 1 |

The web unit tests include two integration tests:

- **The whole sign-in flow**, against the test OIDC provider: login, callback, replay refusal, refresh and revocation, company choice, step-up and sign-out.
- **The session store**, on PostgreSQL with the migration 0020 DDL.

## 3. Coverage results

| Package | Statements | Branches | Functions | Lines | Thresholds |
|---|---|---|---|---|---|
| API (`apps/api`) | 97.08% | 92.63% | 99.03% | 99.28% | enforced in CI |
| Web logic layer (`src/lib`, `src/server`, middleware, route handlers) | 98.14% | 91.41% | 97.87% | 99.40% | 95 / 88 / 95 / 95, enforced in CI |
| Web screens (`src/components`, `src/app` pages) | Not measured as a percentage | | | | |

The web screens are covered by the end-to-end suite instead:

- Every wireframe screen ID above has at least one Playwright test that drives it.
- Every screen is loaded by the accessibility sweep.

## 4. Accessibility validation

- **Automated (axe-core 4.14, WCAG 2.1 A and AA rules)** on every M6 screen:
  - 27 English screens at 1280 px and at 320 px;
  - 18 Arabic screens (right to left) at both widths;
  - plus the dialogs, drawers and menus opened inside the functional specs.

  No violations remain. The sweep found one real issue: dashboard count links whose accessible name differed from their visible text (WCAG 2.5.3). It is fixed.
- **Reflow (1.4.10).** No sideways scrolling at 320 px on any screen, in both languages. Tables become labelled cards below 768 px.
- **Keyboard.** Everything is operable from the keyboard:
  - Map pins are buttons.
  - The radius and draw tools use a crosshair (arrow keys move the map, Space adds a point, Enter finishes, Escape cancels).
  - The map canvas is named for its arrow and zoom keys.
  - The location pin moves with the arrow keys.
- **Dragging (2.5.7).** Gallery order uses drag, arrow buttons or "Move to position". Pointer drag is never the only way.
- **Status and errors.**
  - Progress, results and moves are announced through one polite live region.
  - Form errors use a linked summary that receives focus, plus messages on each field.
  - Overdue keys and audiences are shown as text and an icon, never colour alone.
- **Target size.** Controls are at least 44 px high.
- **Not yet done.**
  - A manual screen-reader pass (NVDA, VoiceOver, TalkBack).
  - The W-D10 usability sessions.
  - Checks for the WCAG 2.2-only criteria that axe does not test (2.4.11 focus not obscured, 3.3.7 redundant entry); see §7.

## 5. Performance results

Production build, cold browser cache per screen, local machine. Measured by `e2e/perf.spec.ts`, whose budgets run in CI.

| Screen | Time to data | LCP | DOMContentLoaded | JavaScript transferred |
|---|---|---|---|---|
| Dashboard (D-1, D-2) | 1.14 s | 0.49 s | 0.43 s | 244 KB |
| Property register (P-1), 55 properties | 1.13 s | 1.03 s | 0.21 s | 232 KB |
| Property overview (P-2), with mini map | 1.00 s | 0.80 s | 0.18 s | 551 KB |
| Listing register (L-1) | 0.92 s | 0.88 s | 0.22 s | 234 KB |
| Property media (G-1) | 0.80 s | 0.64 s | 0.15 s | 247 KB |
| Notes (N-1) | 1.08 s | 0.81 s | 0.23 s | 243 KB |
| Key register (K-2) | 0.95 s | 0.18 s | 0.16 s | 246 KB |
| Property map (M-3), 54 pins | 2.58 s | 1.10 s | 0.17 s | 534 KB |

Budgets:

| Measure | Budget |
|---|---|
| Time to data | 4 s |
| LCP | 4 s |
| JavaScript transferred, screens without a map | 300 KB |
| JavaScript transferred, screens with a map | 600 KB |

Screens with a map load MapLibre (about 290 KB compressed) on demand, only where a map is drawn.

Production build sizes: First Load JS is 103 KB shared, and 200 to 232 KB per app screen.

API-side search performance was measured in M5 and is unchanged.

## 6. Known limitations

1. **D-1 panel visibility.** The price-approval panel is shown to members with `listing.approve_price`. That approximates the wireframe's role table.
2. **Tabs and roles.** Maintenance staff see the Media and Activity tabs on P-2. The API scopes what they can read.
3. **Saved views** are kept per membership in the browser (localStorage), not shared between devices.
4. **Listing blockers** on L-1 are fetched once per draft row shown.
5. **Map thumbnails.** When a map search returns more than 500 results (clusters), the cards show no cover thumbnail, because the cover ids come with map points only.
6. **No basemap in tests.** The test environments run without tiles: the map is a plain background with real pins and tools. The basemap script is written but has not been run against the live Protomaps build.
7. **R2 needs CORS rules** on the media and tile buckets, as documented. SeaweedFS in development allows every origin.
8. **T-3 long-press drag** on touch screens is not implemented; the wireframe marks it optional. Arrow buttons and "Move to position" work everywhere.
9. **T-1** has no Call button, because contacts arrive in Phase 5. Its checklist is not stored, as the wireframe specifies.
10. **Directions** hands the coordinates to the device's maps app through the universal maps URL, only when tapped.
11. **"Wait for Wi-Fi"** needs the Network Information API (Chromium on Android). Elsewhere the option is not shown.
12. **The end-to-end suite runs serially**, about 5 minutes, because the specs share one seeded database.

## 7. Open risks

| Risk | Impact | Mitigation |
|---|---|---|
| The `web-e2e` CI job has not yet run on GitHub runners (ClamAV start-up, Chromium install) | A red first run | Same container images and wait loop as the passing `api` job; on failure the job keeps the report and traces |
| No manual screen-reader or W-D10 usability testing yet | Issues axe cannot detect | Schedule the week-1 usability sessions (W-D10) and a screen-reader pass before release |
| Basemap not yet built or hosted | Plain maps in staging | Run `scripts/build-basemap.sh <date> <dir> --upload`, then set `MAP_TILES_URL`, `MAP_GLYPHS_URL` and `MAP_TILES_ORIGIN` |
| Production identity provider settings (refresh-token rotation, `end_session_endpoint`, audience) | Sign-in or refresh issues | The flow is covered by tests against a standards OIDC provider; verify the chosen provider in staging |
| Hand-mirrored upload rules (`src/lib/upload.ts` mirrors the API's `media-rules.ts`) | Browser and API checks could drift | The API and worker check again; a change on one side should be tested on both |

## 8. GitHub references

Commits on `phase-4/property-management`, oldest first:

| Commit | Change |
|---|---|
| `6a2c14b` | Wireframes (issue #7) and web interface verification report |
| `8c603be` | UI consistency checklist |
| `dad3243` | API read endpoints for the web interface |
| `ae870e5` | Web app scaffolding (BFF auth, session store, shell, i18n) |
| `c467e2b` | Property dashboard, key dialogs and end-to-end harness |
| `b404360` | Property screens P-1 to P-7, maps foundation and location picker |
| `c6f7741` | Listing screens L-1 to L-10 |
| `193ad9c` | Gallery and floor plans G-1 to G-8 (issue #7) |
| `22938ae` | Property notes N-1 to N-4 |
| `871df11` | Key register K-1, K-2, quick create and X-4 |
| `bd3869d` | Map search M-2, M-3 and X-5 (issue #7) |
| `e1e7d8a` | Field use on phones and tablets: X-1 to X-3, T-1, T-2 |
| `c9c55c5` | Web unit tests; BFF rejects dot segments |
| `e0b2e2d` | Screen sweep, web CI jobs and web documentation |
| `87189bb` | Performance budgets for the main screens |

Issue: [#7 Wireframes: media gallery and floor-plan manager, map search](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/7). The wireframe check is in §9.

## 9. Issue #7 — implemented UI against the approved wireframes

| Wireframe | Implemented | Verified by |
|---|---|---|
| G-1 media tab: photos grid, type tabs, actions menu, archived view | Yes | `media.spec` G-1/G-7, sweep |
| G-2 upload panel: drop or choose, take photo, type and size rules, attach to listing, per-file progress, cancel and retry, scan and processing state, location data removed note | Yes; X-2 adds the batch room label and Wi-Fi wait | `media.spec` G-2, `field.spec` X-1 |
| G-3 details drawer: caption, alt text, room, used in listings | Yes | `media.spec` G-3 |
| G-4 floor plans and documents: plan types, table | Yes | `media.spec` G-4 |
| G-5 video and tour links: provider recognised, no embedded player, `noopener` | Yes | `media.spec` G-5 |
| G-6 gallery editor: add from property media, order by drag, arrows or "Move to position", cover, limits, If-Match save | Yes | `media.spec` G-6 |
| G-7 archived media: deletion date, restore | Yes | `media.spec` G-1/G-7 |
| G-8 storage usage | Yes | `media.spec` G-4/G-8, sweep |
| M-1 location picker: address search, pin by click, drag or arrow keys, coordinates, country check | Yes | `properties.spec` P-3 |
| M-2 listing map search: list and map, filters, "Search this area", clusters, radius, draw, pin and card selection, list view keeps filters | Yes | `maps.spec` |
| M-3 property map: as M-2, plus "No location (n)" | Yes | `maps.spec` |
| X-5 phone map: one pane at a time, Near me | Yes | `maps.spec` X-5 |
| T-2 tablet map: stacked in portrait, side by side in landscape | Yes | `field.spec` T-2 |
| T-3 ordering by touch: arrows and "Move to position"; long-press drag is optional | Yes, without the optional long-press drag | `media.spec` G-6 |

Every screen in issue #7's scope is implemented as approved: upload, ordering, cover selection, captions, floor-plan handling, location management, and map and radius search.
