# ADR-002 — Accessibility standard: WCAG 2.2 Level AA

| | |
|---|---|
| Status | Accepted (product owner, 24 October 2026) |
| Supersedes | Phase 1 detailed specification §6 (Accessibility row) and §18.5, which said WCAG 2.1 AA |
| Resolves | Audit contradiction C4 |

## Decision

All EstatePro interfaces — staff application, landlord portal, tenant portal, technician view and platform console — target **WCAG 2.2 Level AA**.

## Rationale

- WCAG 2.2 includes every 2.1 success criterion except 4.1.1 (Parsing, removed as obsolete), so meeting 2.2 AA also meets 2.1 AA.
- Criteria added in 2.2 matter directly for EstatePro's users:
  - 2.4.11 Focus Not Obscured (sticky headers and action bars on dense screens);
  - 2.5.7 Dragging Movements (the pipeline board and gallery ordering must not need drag);
  - 2.5.8 Target Size (Minimum) (field agents and technicians on phones);
  - 3.2.6 Consistent Help, 3.3.7 Redundant Entry, 3.3.8 Accessible Authentication (sign-in through the IdP must allow password managers and passkeys).

## Consequences

- Phase 3 documents already use WCAG 2.2 AA; no change needed there.
- Automated checks (axe-core) run in CI on every screen from the Phase 4 UI milestone; manual keyboard and screen-reader passes before each release.
- The IdP's hosted sign-in pages must meet the same standard (vendor criterion, ADR-001).
