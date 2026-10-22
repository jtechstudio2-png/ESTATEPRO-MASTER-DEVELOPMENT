# EstatePro — Phase 2 Database Engineering

**Status:** Initial schema baseline committed for technical review  
**Branch:** `phase-2/database-engineering`  
**Database target:** PostgreSQL 15+  
**Scope:** International, multi-tenant sales and rental operations, including landlord and tenant portal access

> This is an engineering baseline, not a claim of production readiness. The migrations have been committed but have not yet been executed against a PostgreSQL instance or validated by automated integration tests. Review and test in a disposable database before any deployment.

## 1. International data model

The core schema is country-neutral. Country-specific behaviour is configuration or versioned reference data, not separate country-specific property or lease tables.

### Country and regional configuration
- `countries`, `currencies`, and `locales` hold reference values. These tables require reviewed seed data; the migration intentionally does not invent or hardcode a supported-country catalogue.
- `company_market_settings` enables a company to operate in multiple countries and stores market-level defaults.
- `offices` carry their own country, timezone, currency and address fields. Company headquarters are not assumed to define every office's settings.
- `properties` carry the country and timezone relevant to that property. Property type is selected from a market catalogue and enabled/overridden per company using `property_type_catalog` and `company_property_types`.
- Address fields use structured-but-extensible data rather than assuming one country's address format. A future iteration may formalise postal-address components further for validated search and reporting.

### Currency
Every monetary record stores a numeric amount and explicit ISO currency reference. Company default currency is a display/reporting preference, not a rule that all assets, leases and payments use one currency.

- Never sum values in different currencies as if they were equivalent.
- Cross-currency reporting requires explicit exchange-rate source, effective timestamp, rate, base/quote currencies, rounding and provenance. FX conversion tables are a follow-on migration once product requirements specify whether rates are user-entered, provider-supplied or both.
- Payment allocations must reconcile in compatible currencies or use a documented FX transaction; this invariant is enforced in domain transactions, not by the initial DDL alone.
- Numeric precision and rounding policy must be reviewed with accounting and launch-market requirements before live money is recorded.

### Timezones and scheduling
Operational instants use `timestamptz` and are stored/compared as absolute instants. A relevant IANA timezone is retained for viewing and lease-related workflows, while date-only legal/business concepts use `date` where appropriate. UI displays convert instants to the relevant office, property or user's timezone. Do not store a local wall-clock appointment as a timezone-free timestamp.

### Localised lease templates
`lease_template_versions` identifies a template by country, optional region, language, key and version. Template content is stored privately in object storage with checksum, review status and effective dates. A lease points to the exact template version used, not merely the latest template. Published templates require human legal review for the applicable jurisdiction. Template metadata does not assert that a document is legally valid.

Templates are versioned separately from core lease records because the legal wording, notice rules, disclosures and execution process can change over time. Country/region-specific workflow rules should be expressed in reviewed configuration and application policy, not conditional country-specific columns scattered across the schema.

## 2. Migration inventory

### `database/migrations/0001_initial_schema.sql`
Creates the initial relational baseline:
- Global reference and identity tables: countries, currencies, locales, users.
- Tenant/workspace configuration: companies, settings, market settings, offices, roles, permissions and memberships.
- Regional property type catalogue and company-specific enablement.
- Contacts and multiple contact relationships.
- Properties, ownerships, units, media and agent profiles.
- Leads, activities, viewings, deals, deal parties and stage history.
- Versioned lease template metadata, leases, lease parties, rent charges, payments and allocations.
- Maintenance requests and status history.
- Operational finance entries and commission records.
- Documents, document versions and explicit access grants.
- Audit logs, notifications, automation rules/runs, subscription records and landlord/tenant access grants.
- Tenant-leading indexes and a row-level security policy template applied to tenant-owned tables.

### `database/migrations/0002_integrity_and_rls_hardening.sql`
Adds composite foreign keys to ensure that a referenced unit belongs to the same property and tenant, and enables RLS on the companies table itself.

Apply migrations in numeric order. Use a migration runner that records applied versions and checksums. Do not edit a migration already applied in a shared environment; create a new migration for every subsequent change.

## 3. Entity and relationship rules

- A **company** is the tenant boundary. A user identity can join multiple companies through independent memberships.
- A **company membership** connects a global user to one company, one company role and optionally an office. Revoking membership must terminate future access without deleting audit history.
- A **contact** can have multiple relationship types at once. Buyer, seller, tenant and landlord are relationships, not mutually exclusive person categories.
- A **property** represents a managed/listed asset; a **unit** represents an independently tracked rentable/saleable unit within it. A standalone home can be modelled as one property and one unit.
- **Ownership** and **management access** are distinct concepts. Ownership records must not automatically grant portal access.
- A **lead** tracks prospective business. A **deal** tracks a sale, rental or letting transaction. Stage history is append-only operational evidence.
- A **lease** refers to one property/unit, jurisdiction, dates, currency, parties and the template version used. The initial schema does not fully encode every local notice/renewal rule.
- A **rent charge** is an amount expected. A **payment** is a received/recorded event. An **allocation** applies part of a payment to a charge. These are deliberately separate to support partial payments and arrears.
- **Operational finance entries** track business-relevant income/expenses/adjustments; they are not a double-entry general ledger.
- **Document metadata and version records** live in the database; document bytes remain in private object storage.
- **Landlord/tenant portal grants** explicitly bind user, company, contact and property/lease. API policy must verify active grants and relevant relationships on every request.
- **Audit logs** are operational security evidence and should be append-only to application users.

## 4. Tenant isolation design

The migration uses tenant-owned rows with a `company_id` and a policy that compares it with the transaction-local setting `app.current_company_id`.

Required runtime controls:
1. Authenticate the user and validate an active company membership before setting tenant context.
2. Start a transaction and set the validated tenant with `SET LOCAL app.current_company_id = '<validated-uuid>'` or the parameterised equivalent supported by the database driver. Never derive it from an untrusted request header alone.
3. Use a runtime database role that is not table owner, superuser or `BYPASSRLS`.
4. Never let users issue arbitrary SQL or set the tenant context themselves.
5. Add application-level permission and record-relationship checks in addition to RLS.
6. Test every table family for cross-tenant read/write attempts, joins, exports, search, cached responses and background jobs.
7. Treat company creation and initial owner bootstrap as a narrowly scoped service flow; it needs an explicit strategy for creating the first tenant before normal tenant context exists.
8. Ensure background workers set and clear tenant context per job/transaction. Do not reuse a connection with stale tenant context.
9. Global identity/reference tables need separate grants and access policies; RLS on tenant-owned tables does not automatically secure global tables.
10. RLS is defence in depth, not a substitute for reviewed database grants, API authorisation or security tests.

The RLS migration enables and forces RLS on listed tenant tables. PostgreSQL superusers and roles with `BYPASSRLS` remain able to bypass policies; operational role design is therefore essential.

## 5. Data integrity requirements that need domain-layer enforcement

The schema intentionally establishes core relational integrity, but several invariants span rows and must be enforced transactionally in service code or additional database mechanisms:

- Prevent overlapping active leases for a unit, accounting for jurisdiction-specific exceptions and lease status transitions.
- Prevent payment allocations from exceeding a payment's unallocated balance or a charge's outstanding balance. Lock relevant rows and perform allocation in one transaction.
- Require matching currency or explicit, auditable FX conversion for charge/payment allocations.
- Validate lease lifecycle transitions, approvals, renewal/termination and jurisdiction-specific notice dates.
- Recalculate charge balances and arrears from charges, allocations, waivers and reversals rather than relying on a client-supplied balance.
- Make payment intake, webhook handling, imports and scheduled automation idempotent.
- Write audit and status history in the same transaction as the business mutation where required.
- Verify that a document's related entities belong to the same company and that a portal user has a live grant before every access.
- Enforce that the property and unit in a record are consistent; migration 0002 adds composite foreign keys for the paired references.
- Validate uploaded file type, size, checksum, scanning result and private storage key in the upload service.
- Validate membership/role changes and prevent the last active company owner from being accidentally removed without an approved transfer process.

## 6. Indexing strategy

The initial migration adds indexes for common work queues: properties by tenant/status/country, units by property/status, contacts by name/email, leads by stage/next action/assignee, activities by lead/time, viewings by schedule, deals by stage/expected close, leases by status/end date, charges by due date/status, payments by lease/received date, maintenance by status/priority/due date, finance by date/status, commissions by status/agent, documents by type, audit by time, notifications by recipient/status and automation runs by status/schedule.

Before production:
- Capture representative query plans and expected tenant sizes.
- Add indexes for actual filters/sorts and foreign-key joins identified by query plans.
- Evaluate full-text search separately; use tenant-scoped search indexes or a provider that enforces tenant scope.
- Avoid indexing every JSONB field. Add expression/GIN indexes only for measured query patterns.
- Monitor index size, write amplification and slow queries.

## 7. API and service requirements

The schema is designed for a versioned REST API and service layer; it does not implement API endpoints.

Minimum service boundaries:
- Identity, membership and tenant context.
- Company/office/market configuration.
- Property, unit, media and ownership.
- CRM, lead activities and viewings.
- Deals, offers/stage transitions and commissions.
- Leases, charges, payments and allocations.
- Maintenance and inspections.
- Operational finance and approvals.
- Document access and version management.
- Notifications, scheduled jobs and automation.
- Subscription entitlements and usage.

All writes must validate tenant scope and role/record permissions. Use transactions for related writes, idempotency keys for retried intake operations, optimistic concurrency for conflict-prone edits, and stable error contracts. Long-running work should run asynchronously and expose tenant-scoped job status.

## 8. Security requirements

- Database and object storage are private; no public document buckets.
- Runtime database credentials use least privilege and cannot bypass RLS.
- Tenant context is transaction-local and established only after membership validation.
- Every portal read/download is re-authorised against active access grants.
- Audit events capture actor, company, action, entity, timestamp and correlation ID while minimising sensitive payloads.
- PII and credentials are not written to general logs.
- Uploads are validated and, where supported, malware-scanned before publication.
- Backups are encrypted and restore-tested; access is restricted and audited.
- Production data migrations require reviewed, repeatable scripts and rollback/recovery procedures.
- Country-specific privacy and retention requirements remain a launch-market legal/product decision.

## 9. Scalability and operations

- Start with PostgreSQL and a modular monolith; avoid premature database-per-module or microservice separation.
- Use connection pooling and short transactions; never keep a database transaction open during slow external calls.
- Use an outbox/queue pattern for notification and integration side effects where reliable delivery is required.
- Store binary media in object storage; generate thumbnails asynchronously.
- Use bounded pagination for all list APIs and explicit limits for reports/exports.
- Partition large audit/event tables only when measured volume and retention justify it.
- Define per-tenant usage counters and query safeguards to reduce noisy-neighbour risk.
- Automate schema migration checks, backup verification, restore drills and monitoring before customer onboarding.

## 10. Phase 2 validation plan

Before calling the schema production-ready, run these checks in a disposable PostgreSQL instance:
1. Apply migrations from an empty database in numeric order.
2. Verify all constraints and indexes exist.
3. Run positive CRUD tests for a company with multiple offices, countries, currencies, properties, units, contacts, leads, deals, leases, rent charges, payments and allocations.
4. Attempt cross-company foreign-key references and confirm rejection.
5. Test RLS with a non-owner role for company A and company B; verify reads and writes cannot cross tenant boundaries.
6. Test portal grants for active, expired, revoked and unrelated users.
7. Test transaction rollback for multi-table workflows and audit/history creation.
8. Test payment allocation concurrency, lease overlap, duplicate webhook, duplicate import and retry idempotency.
9. Run migration upgrade/restore tests and representative query plans.
10. Perform security review of database grants, global identity tables, object storage, logs and connection-pool tenant context.

## Phase 2 completion report

### Completed deliverables
- Initial PostgreSQL schema migration.
- Integrity hardening migration for property/unit consistency and company RLS.
- International data-model strategy for market configuration, property type catalogue, currencies, locales, timezones and versioned lease templates.
- Schema and entity relationship rules.
- Tenant isolation requirements and application invariants.
- Indexing, API/service, security, scalability and validation plans.

### Database requirements
DDL is committed. No database instance has been provisioned and no migration has been executed in this repository session. Reviewed seed data, FX conversion model, detailed subscription entitlements and any additional inspection/offer/template clause structures may require follow-up migrations based on product-owner decisions.

### API requirements
No endpoints are implemented. APIs must establish tenant context, enforce role/record permissions, use transactions and idempotency, and re-authorise every portal/file request.

### Security requirements
RLS policies are included for tenant-owned tables and the company table, but they are not sufficient by themselves. Runtime DB grants, membership bootstrap, global identity access, object storage policy, application authorisation and automated cross-tenant tests remain mandatory.

### UI requirements
Phase 2 defines data contracts, not visual screens. Phase 3 will design accessible, localised forms/tables, currency/timezone-aware inputs, portal navigation, filters, empty/error states and permission-aware actions.

### Scalability considerations
Tenant-leading indexes, composite constraints, asynchronous-work planning, private object storage and modular boundaries are documented. Indexing and performance must be validated against representative workloads before launch.

### Potential risks
- The migrations have not yet been executed or integration-tested against PostgreSQL.
- RLS is unsafe if the runtime role bypasses policies or tenant context is incorrectly set/reused.
- Payment allocation, FX, lease-overlap and lifecycle rules need transactional enforcement.
- Country-specific lease rules and retention requirements need legal/product review.
- Identity and contact records must be linked carefully to prevent portal access mistakes.
- Seed/reference data and a country expansion governance process are still required.

### Next phase roadmap — Phase 3: UI/UX System Design
1. Establish typography, colour, spacing, component and accessibility tokens.
2. Design role-aware navigation and workspace/market switching.
3. Design property portfolio, property detail and unit screens.
4. Design CRM, leads, viewing calendar and sales pipeline.
5. Design leases, rent charges, receipts and arrears workflows.
6. Design maintenance, operational finance and document flows.
7. Design landlord and tenant portals with strict permitted-record boundaries.
8. Specify locale/currency/timezone behaviour, validation and date display.
9. Document loading, empty, error, permission-denied and offline/timeout states.
10. Validate key journeys with representative agency, property manager, landlord and tenant tasks.

**Phase gate:** Execute and test both migrations in a disposable PostgreSQL instance, review the tenant isolation model, and resolve critical integrity issues before production use.