# EstatePro — Phase 3 UI/UX Design Specification

**Status:** Design specification, not implemented UI  
**Branch:** `phase-2/database-engineering`  
**Product class:** Multi-tenant property operations SaaS  
**Primary users:** Estate agency staff, property managers, brokers, landlords and tenants  
**Initial market intent:** Ghana, Qatar and UK, with country configuration rather than country-specific core logic.

## Design objective

EstatePro must help people complete property work accurately and quickly throughout the working day. The interface is an operational tool, not a marketing website or a dashboard showcase. Optimize for frequent tasks, clear ownership, reliable status visibility, keyboard use, low cognitive load and safe handling of money, leases and personal information.

## Scope index

1. [Design system](./01-design-system-and-tokens.md)
2. [Information architecture and navigation](./02-information-architecture-and-navigation.md)
3. [Desktop, tablet and mobile wireframes](./03-wireframes-and-user-flows.md)
4. [User flows and role-specific dashboards](./03-wireframes-and-user-flows.md)
5. [Component library](./04-components-accessibility-responsive.md)
6. [Design tokens](./01-design-system-and-tokens.md)
7. [Accessibility standards](./04-components-accessibility-responsive.md)
8. [Responsive behaviour](./04-components-accessibility-responsive.md)
9. [Interaction and form conventions](./04-components-accessibility-responsive.md)
10. [Operational data-density rules](./01-design-system-and-tokens.md)
11. [Role permissions and portal boundaries](./02-information-architecture-and-navigation.md)
12. [Validation and acceptance criteria](./05-phase-3-validation-gate.md)

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

## Design decisions still requiring product validation

- Confirm whether sales and rental workflows share one pipeline or use separate configurable pipelines.
- Confirm default permission matrix for agency owner, office manager, agent/broker, property manager, finance, maintenance, landlord and tenant.
- Validate priority tasks with real agency/property-management users before finalizing labels and dashboard ordering.
- Confirm supported minimum browser versions and mobile device baseline before implementation.
- Legal lease templates and financial compliance rules require jurisdiction-specific professional review.

## Phase 3 exit condition

The design package is ready for implementation planning when all 12 deliverables are reviewed, representative tasks are usability-tested, permission boundaries are documented, responsive layouts are specified, and the database validation gate in the Phase 2 report has been addressed. These documents alone do not establish that the SQL schema has been executed or validated.
