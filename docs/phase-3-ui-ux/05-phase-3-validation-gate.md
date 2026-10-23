# 05 — Phase 3 Validation Gate and Handoff

## 1. Deliverable completion matrix

| Requested deliverable | Specification location | Design status |
|---|---|---|
| 1. Design system | `01-design-system-and-tokens.md` | Drafted |
| 2. Information architecture | `02-information-architecture-and-navigation.md` | Drafted |
| 3. Navigation structure | `02-information-architecture-and-navigation.md` | Drafted |
| 4. Desktop wireframes | `03-wireframes-and-user-flows.md` | Low-fidelity |
| 5. Tablet wireframes | `03-wireframes-and-user-flows.md` | Low-fidelity |
| 6. Mobile wireframes | `03-wireframes-and-user-flows.md` | Low-fidelity |
| 7. User flows | `03-wireframes-and-user-flows.md` | Drafted |
| 8. Role-specific dashboards | `02-information-architecture-and-navigation.md` and wireframes | Role contracts drafted; detailed screen validation pending |
| 9. Component library | `04-components-accessibility-responsive.md` | Component contracts drafted |
| 10. Design tokens | `01-design-system-and-tokens.md` | Proposed tokens |
| 11. Accessibility standards | `04-components-accessibility-responsive.md` | WCAG 2.2 AA target specified; not audited |
| 12. Responsive behaviour | `04-components-accessibility-responsive.md` | Rules specified; not browser-tested |

## 2. Role-specific dashboard acceptance

A dashboard is accepted only if it supports real work:
- Each count links to a filtered record list.
- Each list has an owner, state, due date or next action when relevant.
- Users can identify overdue work and what they can act on.
- Data is scoped by server authorization and company/office context.
- Empty, stale, failed and permission-denied states are specified.
- No placeholder metrics, fake chart series or non-functional controls.
- Landlord and tenant portal content is limited to explicit access grants.

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

## 5. Phase 2 dependency gate

Before implementation, execute and validate the Phase 2 migrations against the target PostgreSQL version. The prior phase report stated the SQL had not been executed in a live PostgreSQL runtime. That remains a release-blocking engineering gate until verified.

Required checks include clean migration from empty database, foreign-key integrity, RLS tests under a non-owner runtime role, tenant-crossing denial, portal grant boundaries, transaction/concurrency tests for financial allocation and lease overlap, and restore/migration tests. Record the database version, commands, test outputs and known failures.

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

This phase delivers written information architecture, proposed design tokens, low-fidelity wireframes, user flows, component contracts, accessibility targets and responsive guidelines. It does **not** deliver coded screens, an interactive prototype, a tested component library or production-ready UI. No production readiness claim should be made until implementation and validation are complete.
