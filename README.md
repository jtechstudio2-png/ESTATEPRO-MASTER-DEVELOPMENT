# EstatePro

Multi-tenant, multi-country SaaS platform for real estate agencies, property managers, developers, landlords and brokers. It covers listings, CRM, sales pipeline, leases and rent collection, maintenance, operational finance, documents, reporting and automation, with landlord and tenant portals.

Reference launch markets: **Ghana, Qatar and the United Kingdom**. Further markets are added as configuration, without schema redesign.

## Phases

The platform is designed and built phase by phase. Each phase ends with a close-out covering deliverables, database, API, security and UI requirements, scalability, risks and the next phase's roadmap.

| # | Phase | Status | Documents |
|---|---|---|---|
| 1 | Product Strategy & System Architecture | Complete | [Baseline](docs/PHASE-1-PRODUCT-STRATEGY-ARCHITECTURE.md) · [Detailed specification](docs/PHASE-1-DETAILED-SPECIFICATION.md) |
| 2 | Database Engineering | Complete | [Design](docs/PHASE-2-DATABASE-ENGINEERING.md) · [Migrations](database/migrations) · [Tests](database/tests) |
| 3 | UI/UX System Design | Complete (design specification) | [Overview](docs/phase-3-ui-ux/README.md) · [Dashboards](docs/phase-3-ui-ux/06-role-dashboards.md) · [Close-out](docs/phase-3-ui-ux/05-phase-3-validation-gate.md#8-phase-3-close-out) |
| 4 | Property Management Module | In progress — milestones 1 (foundation), 2 (properties, units, property types) and 3 (listings) complete | [API](apps/api/README.md) · [ADR-001](docs/decisions/ADR-001-authentication-managed-identity-provider.md) · [ADR-002](docs/decisions/ADR-002-accessibility-wcag-2-2-aa.md) · [ADR-003](docs/decisions/ADR-003-api-conventions.md) · [ADR-004](docs/decisions/ADR-004-listing-rules.md) |
| 5 | Client CRM Module | Not started | — |
| 6 | Sales Pipeline Management | Not started | — |
| 7 | Rental & Lease Management | Not started | — |
| 8 | Maintenance Operations | Not started | — |
| 9 | Finance & Accounting | Not started | — |
| 10 | Document Management | Not started | — |
| 11 | Reporting & Analytics | Not started | — |
| 12 | Automation Engine | Not started | — |
| 13 | AI Assistant (EstateAI) | Not started | — |
| 14 | Subscriptions & Billing | Not started | — |
| 15 | Security & Compliance | Not started | — |
| 16 | Deployment & Launch Readiness | Not started | — |

## Database

PostgreSQL 16+. Sixteen forward-only migrations build 140 tables with company-scoped foreign keys and row-level security on every company table.

```bash
# Requires PostgreSQL 16+ client tools and a superuser connection (PGHOST, PGUSER, …)
database/scripts/verify.sh
```

The script creates a fresh `estatepro_verify` database, applies every migration in order, and runs the test suites: tenant isolation, plus business rules for leases, rent allocation, arrears, period locking, separation of duties, pipeline, viewings, maintenance and documents. It exits non-zero on the first failure.

| Path | Contents |
|---|---|
| `apps/api/` | API service (NestJS, Kysely) — see its README |
| `docs/decisions/` | Architecture decision records |
| `database/migrations/` | Numbered schema migrations (`0001`–`0016`) |
| `database/tests/` | Fixtures and SQL test suites |
| `database/scripts/verify.sh` | Build-and-test runner |
| `docs/` | Phase documents |
