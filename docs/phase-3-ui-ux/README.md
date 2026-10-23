# EstatePro — Phase 3 UI/UX Design Specification

**Status:** Complete as a design specification (not implemented UI). Aligned with the tested [Phase 2 schema](../PHASE-2-DATABASE-ENGINEERING.md).  
**Product class:** Multi-tenant property operations SaaS  
**Primary users:** Estate agency staff, property managers, brokers, landlords and tenants  
**Initial market intent:** Ghana, Qatar and UK, with country configuration rather than country-specific core logic.

## Design objective

EstatePro must help people complete property work accurately and quickly throughout the working day. The interface is an operational tool, not a marketing website or a dashboard showcase. Optimize for frequent tasks, clear ownership, reliable status visibility, keyboard use, low cognitive load and safe handling of money, leases and personal information.

## Scope index

| File | Contents |
|---|---|
| [01 — Design system and tokens](./01-design-system-and-tokens.md) | Colours with measured contrast, status colour mapping, typography, spacing, density, tokens, RTL |
| [02 — Information architecture and navigation](./02-information-architecture-and-navigation.md) | Navigation, record hierarchy, the 11 roles, country configuration, sidebar by role, search behaviour |
| [03 — Wireframes and user flows](./03-wireframes-and-user-flows.md) | Work queue, property register, record form, field visit (tablet), agent day and tenant portal (mobile), five user flows |
| [04 — Components, accessibility, responsive](./04-components-accessibility-responsive.md) | Component library, component states, WCAG 2.2 AA rules, breakpoints, responsive behaviour |
| [05 — Validation gate and close-out](./05-phase-3-validation-gate.md) | Deliverable matrices, usability tests, security checks, handoff, **Phase 3 close-out** |
| [06 — Role-specific dashboards](./06-role-dashboards.md) | Property, CRM, pipeline, Rent, Maintenance, Finance and Admin dashboards; My day; My jobs; portal homes |
| [07 — Screens, tables, forms and states](./07-screens-tables-forms-states.md) | Record page pattern, seven task wireframes, data tables, forms, filters, empty states, error states, keyboard shortcuts |

## Non-negotiable principles

- Task-first: the next useful action is visible without searching through decorative widgets.
- Role-aware: navigation, records and actions follow server-authorized permissions, not merely hidden UI.
- Dense but readable: compact tables for professional work; progressive disclosure for secondary details.
- Fast paths: global search, saved filters, row actions, keyboard navigation and remembered view preferences where safe.
- Responsive by task: desktop supports deep operations; mobile prioritizes field work, contact, photos, notes and status changes.
- International by configuration: dates, numbers, currency, locale, address formats and timezone display follow company/user context. Store instants in UTC and retain IANA timezone context where relevant.
- Safe by default: destructive actions are explicit, money and lease changes show context, and tenant/landlord access is scoped.
- Accessible by design: WCAG 2.2 AA is the target baseline; accessibility is tested, not assumed from component choice.
- No fabricated metrics: empty states and reports must not invent data.
- No visual tricks: no glassmorphism, gratuitous animation, decorative charts or marketing-style hero blocks inside the application.

## Product shell

```text
┌─────────────────────────────────────────────────────────────────────┐
│ EstatePro  [Company / Office ▾] [Search...] [+ Create ▾] [Help] [Me]│
├───────────────┬─────────────────────────────────────────────────────┤
│ Primary nav   │ Page title                 Context actions           │
│               ├─────────────────────────────────────────────────────┤
│ Work queue    │ Filters / tabs / saved view                         │
│ Properties    │                                                     │
│ Contacts      │ Main work surface: table, form, calendar or record  │
│ Leasing       │                                                     │
│ Sales         │                                                     │
│ Maintenance   │                                                     │
│ Finance       │                                                     │
│ Reports       │                                                     │
│ Settings      │                                                     │
└───────────────┴─────────────────────────────────────────────────────┘
```

## Design decisions

Resolved:
- Sales and lettings use separate, company-configurable pipelines (`pipeline_stages.deal_type`), each mapped to fixed stage classes.
- The default permission matrix is the one seeded in Phase 2 (9 system roles, 94 permissions) for the 11 roles in the brief; see [02 §3 and §6](./02-information-architecture-and-navigation.md).

Still to validate with users:
- Validate priority tasks with real agency/property-management users before finalizing labels and dashboard ordering.
- Confirm supported minimum browser versions and mobile device baseline before implementation.
- Legal lease templates and financial compliance rules require jurisdiction-specific professional review.

## Phase 3 exit condition

The design package is ready for implementation planning when all 12 deliverables are reviewed, representative tasks are usability-tested, permission boundaries are documented, responsive layouts are specified, and the Phase 2 database gate is met (it is: see [05 §5](./05-phase-3-validation-gate.md#5-phase-2-dependency-gate--passed)).
