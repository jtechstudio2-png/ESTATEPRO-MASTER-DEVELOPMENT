# 05 — Phase 3 Validation Gate and Handoff

## 1. Deliverable completion matrix

### Twelve deliverables requested for Phase 3

| Requested deliverable | Specification location | Design status |
|---|---|---|
| 1. Design system | `01` | Specified; contrast measured |
| 2. Information architecture | `02` §1–3 | Specified |
| 3. Navigation structure | `02` §1, §4, §6 (sidebar by role) | Specified |
| 4. Desktop wireframes | `03` §1–3, `06`, `07` §1, §2.1–2.4 | Low-fidelity |
| 5. Tablet wireframes | `03` §4, `07` §2.5, `06` §12 | Low-fidelity |
| 6. Mobile wireframes | `03` §5–6, `07` §2.6–2.7, `06` §12 | Low-fidelity |
| 7. User flows | `03` §7 (five flows) | Specified |
| 8. Role-specific dashboards | `06` (Property, CRM, Pipeline, Rent, Maintenance, Finance, Admin, My day, My jobs, portals) | Specified, each panel mapped to a Phase 2 query |
| 9. Component library | `04` §1–2 | Component contracts |
| 10. Design tokens | `01` §1–3, §6 | Specified; colour contrast measured |
| 11. Accessibility standards | `04` §3, `01` §1, `07` §8 | WCAG 2.2 AA target; not yet audited on rendered UI |
| 12. Responsive behaviour | `04` §4–7, `06` §12 | Rules specified; not browser-tested |

### Items from the original Phase 3 brief

| Brief item | Location |
|---|---|
| Colours, typography, spacing, components | `01`, `04` |
| Property, CRM, Finance, Rent, Maintenance and Admin dashboards | `06` §3–9 |
| Sidebar structure and navigation hierarchy | `02` §1, §6 |
| Dashboard layouts | `06` |
| Data tables | `07` §3 |
| Forms | `03` §3, `07` §4 |
| Filters | `07` §5 |
| Search behaviour | `02` §7 |
| Empty states | `07` §6 |
| Error states | `07` §7 |
| Right-to-left (Arabic) support | `01` §7 |

## 2. Role-specific dashboard acceptance

A dashboard is accepted only if it supports real work:
- Each count links to a filtered record list.
- Each list has an owner, state, due date or next action when relevant.
- Users can identify overdue work and what they can act on.
- Data is scoped by server authorization and company/office context.
- Empty, stale, failed and permission-denied states are specified.
- No placeholder metrics, fake chart series or non-functional controls.
- Landlord and tenant portal content is limited to records linked to the portal user's contact, and documents explicitly shared with them.

## 3. Usability test scenarios

Run moderated tests with representative users from an estate agency/property management operation. Record completion time, misclicks, backtracking, errors and confidence. Do not set pass thresholds until baseline testing, but define target thresholds before implementation sign-off.

1. Agent: create a lead, book a viewing and log outcome.
2. Agent: find a property using a partial address/reference and update availability.
3. Property manager: identify leases due for renewal within a configurable period.
4. Property manager: review a maintenance request and assign follow-up.
5. Finance: allocate a receipt to one or more eligible charges without exceeding balances.
6. Office manager: reassign overdue work and inspect team workload.
7. Landlord: locate an authorized statement and download a permitted document.
8. Tenant: find lease end date, understand an amount due and submit a maintenance request.
9. Admin: configure market, currency, timezone and property type without affecting another company.
10. All roles: recover from validation errors and a simulated network interruption without losing entered work.

## 4. Security and data correctness checks

UI tests do not replace backend authorization tests. Verify:
- Direct URL access to unauthorized records is rejected by the server.
- API and file endpoints enforce tenant, role and record-level grants.
- Search, exports, notifications and global counts do not leak inaccessible records.
- Changing company/office context clears or reloads scoped data.
- Sensitive actions are logged and consequential changes show confirmation.
- Currency, FX conversion, lease activation and payment allocation are validated server-side.
- UI permissions match server permissions but are never the only enforcement layer.

## 5. Phase 2 dependency gate — passed

The Phase 2 schema on which this design is based ([`database/migrations`](../../database/migrations)) has been executed on PostgreSQL 16 from an empty database and verified by `database/scripts/verify.sh`: 15 migrations applied, 77 test assertions passing. The tests cover tenant isolation under the non-owner runtime role, cross-company denial, composite-FK protection, financial allocation limits, lease and viewing overlap, period locking and separation of duties. See [Phase 2 §12.3](../PHASE-2-DATABASE-ENGINEERING.md#123-results-of-this-phases-run-postgresql-1615).

Still open, and scheduled for later phases: concurrency/load tests (Phase 16), backup-and-restore drills (Phase 16), and API-level IDOR tests for office/team/own/linked scopes (Phase 15).

## 6. Handoff to implementation

Suggested implementation sequence after database gate:
1. Confirm product terminology, roles and permission matrix with real users.
2. Build tokens, typography, focus styles and accessible base controls.
3. Build application shell, navigation, search and authorization-aware route guards.
4. Build table/list, filter, form, record-detail and activity components.
5. Implement property and contact workflows.
6. Implement leads, viewings, sales and lease workflows.
7. Implement maintenance and finance workflows with transaction-safe server APIs.
8. Implement landlord and tenant portals as distinct, grant-scoped experiences.
9. Add operational reports only when underlying metrics and definitions are validated.
10. Run accessibility, responsive, usability, tenant-isolation and performance tests.

## 7. Status statement

This phase delivers a written design system with measured colour contrast, information architecture, a sidebar matrix per role, low-fidelity wireframes for desktop, tablet and mobile, five user flows, seven staff dashboards plus portal and technician home screens (each mapped to real data), component contracts, and specifications for tables, forms, filters, search, empty and error states, accessibility, RTL and responsive behaviour. It does **not** deliver coded screens, an interactive prototype or a tested component library; those are built from Phase 4 onwards.

## 8. Phase 3 close-out

### 8.1 Completed deliverables

All twelve requested deliverables and every item of the original Phase 3 brief are specified (matrices in §1). New in this revision: measured contrast and a WCAG-compliant control-border token, status-colour mapping for every Phase 2 lifecycle, RTL rules, a sidebar matrix for the 11 roles, a search specification, six named dashboards plus the pipeline board, fourteen additional wireframes (six dashboards, the record page pattern and seven task screens), and the table, form, filter, empty-state and error-state catalogues.

### 8.2 Database requirements

No schema changes are required for Phase 3. Every dashboard panel in `06` names its source tables and the Phase 2 index that serves it. Items for the build phases:
- Implement `ledger_balances`-based client-money reconciliation per bank account (Finance dashboard) as a query in Phase 9; add a summary table only if measurements require it.
- Maintain `leases.renewal_status` from the automation engine (Phase 12) so the "no decision" counts are reliable.
- Add the PostGIS geography column and GiST index in Phase 4 for map search.

### 8.3 API requirements

- **List endpoints** with server-side filtering, sorting, cursor pagination, column selection and a total-or-estimate count, matching `07` §3 and §5; filters are serialisable to the URL.
- **Dashboard endpoints**: one endpoint per panel (so panels load and fail independently), each accepting scope, office and as-of date, and returning per-currency figures.
- **Search endpoint** returning grouped, permission-filtered results with a type, reference and context line (`02` §7).
- **Action endpoints** for every state change on the screens (activate lease, allocate receipt, approve quote, lock period), returning RFC 9457 errors that the UI maps to the `07` §7 catalogue (`409` conflicts include the conflicting record's id and reference).
- `ETag`/`If-Match` on every editable record for the concurrent-edit flow.
- Idempotency keys on money and messaging writes, so "Try again" is safe.
- An export endpoint that creates `export_jobs` for large result sets.

### 8.4 Security requirements

- Navigation, actions, filter options and search results are built from server-side permissions; the UI hides what the user cannot do, but the API is the enforcement point.
- One "not found or no access" message, so record existence isn't revealed.
- Sensitive values masked by default, with an audited reveal; step-up MFA for sensitive permissions (payout approval, period lock, exports, role changes, bank details).
- Portal shells are separate route groups with their own token audience; staff navigation is never sent to portal users.
- Session expiry is handled without losing form data, and without extending sessions silently.
- No tenant data in client-side caches that survive a company switch; switching company clears all cached data.

### 8.5 UI requirements (for implementation)

- Build in this order: tokens → base controls (focus, inputs with control borders) → app shell and sidebar → `DataTable` and `FilterBar` → record page pattern → forms (`MoneyInput`, `AddressFields`, phone) → dashboards → portals.
- Every screen ships with its loading, empty, filtered-empty, error, permission and conflict states (`03` §8, `07` §6–7).
- An automated accessibility check (axe or equivalent) runs in CI on every screen, plus manual keyboard and screen-reader passes before release.
- Test RTL with Arabic content, and test at 320 px width and 200% zoom.

### 8.6 Scalability considerations

- Server-side pagination and filtering everywhere; no screen loads a full portfolio into the browser.
- Dashboard panels are independent requests that can be cached briefly per company, scope and as-of date (never across companies).
- Search uses the indexes defined in Phase 2 (full-text, trigram, exact reference); OpenSearch is introduced only if measured latency requires it.
- Large exports and reports run as background jobs.
- The front end is code-split per section, so a technician on mobile downloads only the job screens.

### 8.7 Potential risks

| Risk | Mitigation |
|---|---|
| Wireframes untested with real users | Moderated tests (§3) with agencies in Ghana, Qatar and the UK before Phase 4 screens are finalised |
| Dense tables overwhelm new users | Saved views per role with fewer default columns; column chooser; onboarding hints only on first use |
| RTL bugs found late | RTL is in the token and component rules from the first component; Arabic test content in CI screenshots |
| Dashboards slow at scale | One request per panel, indexed queries, as-of caching; measured in Phase 16 |
| Users expect real-time updates | Show freshness and a refresh control; real-time updates only for queues where users act together (e.g. lead assignment) |
| Status colour misread by colour-blind users | Status text is always present; colours are supporting only |

### 8.8 Next phase roadmap — Phase 4: Property Management Module

Phase 4 starts coding. It will deliver:

1. **Stack confirmation** (Phase 1 detailed spec §9.2) and project scaffolding: API, web app, shared design tokens, CI running `verify.sh` plus unit and accessibility checks.
2. **Application shell**: sign-in, company context, sidebar from permissions, global search (properties and units first).
3. **Properties and units**: add, edit, archive (with reason), property types by country, ownership, international address forms, PostGIS location and map search.
4. **Listings**: sale and rent listings with the statuses Available, Reserved, Under Contract, Sold, Rented and Withdrawn, plus the unit flag Under Maintenance; price history; bilingual text; publishing checklist.
5. **Media**: gallery upload with ordering and cover image, floor plans, video and virtual-tour links, background processing and malware scan.
6. **Property notes** with audiences, and the key register.
7. **Property dashboard** (`06` §3).
8. **Tests**: API tests for every action and permission scope, including cross-company and own/office scope cases.
9. **Phase 4 close-out** in the standard format.
