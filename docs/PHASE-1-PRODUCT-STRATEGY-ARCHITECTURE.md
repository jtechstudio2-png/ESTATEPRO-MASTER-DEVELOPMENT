# EstatePro — Phase 1: Product Strategy & System Architecture

Status: Architecture baseline, pending product-owner review. Phase 1 of 16. No application code in this phase.

## 1. Platform vision
EstatePro is a cloud platform for real-estate agencies, property managers, developers, landlords and brokers to manage properties, contacts, leads, viewings, deals, leases, rent operations, maintenance, operational finance, documents, reminders and reporting in one controlled workspace.

EstatePro is not a full accounting ledger, bank, legal conveyancing system or public property marketplace. Integrations require confirmed requirements, jurisdiction review and provider selection.

Product principles:
- One canonical record for each property, unit, contact, lease, deal and financial event.
- Tenant isolation across UI, API, search, exports, files, reports, caches and background jobs.
- Traceable consequential changes and human approval for legal or financial commitments.
- Configurable locale, timezone, currency, retention and jurisdiction-specific settings.
- Server-enforced access; role-aware navigation alone is not security.
- Reports derived from defined formulas and real source records.
- Maintainable delivery with migrations, tests, observability, backups and recovery procedures.

## 2. Business objectives and KPIs
| Objective | Measure | Definition |
|---|---|---|
| Improve property data quality | Completeness rate | Active properties with required fields / active properties |
| Improve lead follow-up | Follow-up SLA rate | Leads followed up within configured SLA / leads due |
| Improve sales visibility | Pipeline value and stage ageing | Eligible open deal value by stage; closed/lost excluded |
| Monitor occupancy | Occupancy rate | Occupied rentable units / total rentable units, with unavailable-unit treatment defined |
| Improve rent collection | On-time collection rate | Amount received by due date / amount due for same period |
| Improve maintenance | Median resolution time and overdue open tickets | Derived from status timestamps and documented pause rules |
| Improve commission control | Reconciliation rate | Approved commissions reconciled to closed deal and payout status |
| Improve governance | Audit coverage | Defined high-risk actions with audit events / defined high-risk actions |
| Operate reliably | Availability, latency, errors, RPO and RTO | Targets agreed after hosting and workload decisions |

Targets must be based on pilot baselines. Software alone does not guarantee business outcomes.

## 3. User personas
- Platform Owner: service operation, plans, platform health and support governance; no routine default access to customer content.
- Super Admin / Platform Operations: narrowly scoped, audited platform operations.
- Company Owner: workspace, offices, roles, staff, subscription and company settings.
- Office Administrator: staff invitations, reference data and routine administration.
- Property Manager: properties, occupancy, inspections, leases, tenants and maintenance.
- Sales Manager: lead allocation, pipeline, viewings, offers, deal stages and agent performance.
- Agent / Broker: assigned leads, clients, viewings, follow-ups and authorised deal updates.
- Accountant / Finance Officer: operational income, expenses, rent receipts and commissions with approval boundaries.
- Landlord: explicitly shared properties, permitted reports and maintenance updates.
- Tenant: own tenancy, allowed documents, rent records and maintenance requests.
- Maintenance Staff / Contractor: assigned work orders and only the information required to complete them.
One person may have multiple roles. Access depends on company membership, role, record scope and relationship. A role name never grants cross-tenant access.

## 4. Industry pain points and product responses
| Pain point | Response | Control |
|---|---|---|
| Duplicate property spreadsheets | Canonical property and unit records | Import validation and duplicate detection |
| Missed leads | Assignment, activity timeline, next action and overdue queue | Configurable SLA and delivery tracking |
| Missing viewing outcomes | Appointment, attendance, outcome and follow-up capture | Explicit cancellation/reschedule states |
| Unreliable pipeline | Defined stages, expected close, loss reason and stage ageing | Forecast is not booked revenue |
| Missed lease dates | Lease timeline and renewal reminders | Local notice rules require jurisdiction review |
| Unclear arrears | Charges, receipts, allocations and ageing | Not a statutory ledger replacement |
| Untracked maintenance | Priority, assignee, status history, evidence and cost | Contractor access limited to assigned work |
| Commission disputes | Versioned rules, calculation, approval and payout state | Approved changes require audited adjustment |
| Insecure documents | Private object storage and expiring authorised downloads | No public document bucket |
| Conflicting reports | Defined metrics and reconciled records | Expose filters, date basis and exclusions |

## 5. Functional requirements
1. Workspace: company profile, offices, locale, timezone, currency, memberships, settings and entitlements.
2. Identity/access: invitations, memberships, roles, permissions, MFA and session policy.
3. Properties/units: type, address, ownership/management relationships, features, status, notes, media, inspections and archive history.
4. People/CRM: contacts with multiple relationships such as buyer, seller, tenant, landlord or supplier; activities, communications and consent/preferences where required.
5. Leads: source, qualification, assignment, next action, pipeline stage, expected value and loss reason.
6. Viewings: property/unit, prospect, agent, appointment, attendance, outcome, feedback and follow-up.
7. Sales: offer history, transaction parties, terms, contract milestones, close outcome and commission basis. E-signature is not assumed.
8. Leases: parties, unit, dates, rent schedule, deposits, renewal/termination state, versioned documents and reminders.
9. Rent operations: charges, receipts, allocations, adjustments, refunds and arrears. Payment-provider integrations must be idempotent.
10. Maintenance/inspections: requests, priority, assignment, appointments, evidence, costs, checklists and status history.
11. Operational finance: income/expenses, links to property/deal/lease, approvals, commissions and reconciliation; no general ledger initially.
12. Documents: private storage metadata, type, version, access scope, retention and audit history.
13. Notifications/automation: in-app/email alerts, scheduled reminders, retries, delivery state and preferences.
14. Reporting: inventory, occupancy, lead conversion, sales pipeline, rent collection, arrears, maintenance SLA, agent activity and operational finance.
15. EstateAI, in a later phase: constrained drafting and summarisation using authorised inputs, human review and no invented market facts or autonomous legal/financial decisions.
16. Billing: plan entitlements, usage, subscription lifecycle, provider references and feature gating.

Out of scope unless separately approved: double-entry accounting, payroll, banking, tax filing, legal advice, guaranteed lease validity, unverified valuations, fabricated leads, autonomous tenant/credit decisions, public marketplace, and payment/e-signature integrations without provider and jurisdiction review.

## 6. Non-functional requirements
- Security: server-side authorisation, tenant isolation, managed secrets, encryption, privileged MFA and audit trails.
- Reliability: idempotent jobs, safe retries, transactions, graceful errors and tested recovery.
- Performance: tenant-scoped indexes, bounded queries, pagination, asynchronous media processing and measured budgets.
- Maintainability: modular domains, versioned migrations, automated tests, lint/type checks and stable error contracts.
- Accessibility: keyboard navigation, visible focus, semantic forms, accessible validation and sufficient contrast.
- Compatibility: current evergreen browsers and usable critical workflows on mobile.
- Integrity: foreign keys, unique constraints, explicit status transitions, decimal money, currency codes and UTC timestamps.
- Observability: structured logs, correlation IDs, error monitoring, metrics and alerts without secrets or unnecessary personal data.
- Privacy: minimisation, purpose-limited access, export/correction/deletion workflows where applicable and retention policy.
- Recovery: defined RPO/RTO, automated backups, restore drills and runbooks before launch.

## 7. User journey mapping
Agency onboarding: verify owner → create workspace → set locale/timezone/currency → configure offices and roles → invite staff → import/create properties → review row-level import errors → assign leads.

Property-to-deal: create property/unit → complete required details → upload private media → set status → create/link lead → qualify → schedule viewing → record outcome → negotiate offer → record acceptance and contract milestones → close or mark lost → record commission.

Rental: mark unit available → record permitted applicant workflow → prepare lease → authorised review → record signed agreement/version → activate lease → generate expected charges → allocate receipts → handle arrears/renewal/termination → complete checkout/inspection.

Maintenance: report issue → validate reporter/unit access → triage → assign staff/vendor → schedule visit → record work/evidence/cost → mark complete → authorised closure → link expense and notify relevant parties.

Portal access: invite verified identity and explicit relationship → authenticate → expose only authorised records → re-authorise each request/download → revoke access when relationship ends while preserving required audit records.

Support access: verify purpose → use metadata-first diagnostics → if content access is essential, require documented approval or emergency policy, time-bound elevation and audit → revoke access and record outcome.

## 8. Platform structure
- Overview: assigned tasks, overdue items and recent activity.
- Properties: portfolio, units, media, inspections and ownership/management links.
- CRM: contacts, leads, tasks, communications and viewings.
- Sales: opportunities, offers, transactions and commissions.
- Rent & leases: active/expiring leases, charges, receipts and arrears.
- Maintenance: requests, assignments, inspections and vendors.
- Finance: operational income, expenses, commission review and reconciliation.
- Documents: authorised library and version history.
- Reports: saved filters, exports and defined KPIs.
- Automation/notifications: reminder rules, delivery history and preferences.
- Company settings: staff, roles, offices, reference data and audit log.
- Platform administration: tenants, subscriptions, service health, support cases and platform audit.

## 9. SaaS architecture
Start with a modular monolith, relational database, private object storage and separate background worker. This is simpler to operate than premature microservices while retaining domain boundaries.
- Responsive web client: no secrets or trusted business rules in the browser.
- Application/API layer: authentication, tenant context, validation, policy checks, domain services and transaction boundaries.
- PostgreSQL: recommended for transactions, constraints, indexes and row-level security as defence in depth.
- Private object storage: media/document bytes; application/database retain metadata and authorisation.
- Queue/workers: reminders, email, imports, media, reports and later AI; retry-safe and idempotent.
- Email provider: verified sender, bounce handling, delivery state and rate limits.
- Billing adapter: tokenised provider references and verified webhooks; no raw card data.
- Observability: structured logs, error tracking, metrics, alerts and correlation IDs.
- Integration adapters: timeouts, retries, rate limits and provider-specific error mapping.
Use separate development, staging and production environments, distinct credentials, migration gates and controlled releases. Production database and storage must not be public. Hosting region and infrastructure remain decision gates pending budget, residency and operator capability.

### System context diagram
~~~mermaid
flowchart LR
 U[Staff, landlords, tenants] --> WEB[Responsive web client]
 WEB --> API[Application API]
 API --> AUTH[Identity and access policy]
 API --> DB[(PostgreSQL)]
 API --> OBJ[Private object storage]
 API --> Q[Job queue]
 Q --> W[Background workers]
 W --> DB
 W --> MSG[Email / notifications]
 API --> BILL[Billing adapter]
 BILL --> API
 API --> OBS[Logs, metrics, monitoring]
 W --> OBS
~~~

## 10. Role hierarchy and permission matrix
Trust boundaries: platform scope; company scope; assigned-record scope; and external portal scope. Platform access to customer content must be exceptional, justified, logged and constrained.

Legend: Manage = create/update in scope; Approve = explicit approval; Own = own/assigned records; View = permitted read; Limited = related fields only; dash = no default access.

| Capability | Platform ops | Company owner/admin | Property manager | Sales manager | Agent | Accountant | Landlord | Tenant | Maintenance |
|---|---|---|---|---|---|---|---|---|---|
| Platform tenants/plans | Manage | — | — | — | — | — | — | — | — |
| Company settings/staff | Audited support | Manage | Limited | Limited | — | — | — | — | — |
| Property/unit records | Audited support | Manage | Manage | View | Assigned | View | Shared | Leased unit | Assigned subset |
| Contacts/CRM | — | Manage | Related | Manage | Assigned | Limited | Shared | Own | Ticket subset |
| Leads/deals/viewings | — | Manage | Limited | Manage | Assigned | Approved finance fields | — | — | — |
| Leases/rent records | — | Manage | Manage | Limited | — | Finance records | Shared | Own lease/history | — |
| Maintenance | — | Manage | Manage | — | Assigned subset | Approved costs | Shared | Own requests | Assigned |
| Operational finance | — | Manage/approve | Limited | Commission view | Own commission | Manage/approve by policy | Shared statements | Own receipts | — |
| Documents | — | Manage policy | Related docs | Deal docs | Assigned deal docs | Finance docs | Shared only | Own lease docs | Work docs |
| Audit logs | Platform audit | Company audit | Relevant scope | Relevant scope | Appropriate own activity | Finance scope | — | — | Ticket activity |

Authorisation rules: authenticate and resolve membership server-side; derive tenant from verified membership; check role, record relationship and state on every request; scope search/export/report queries before response; re-authorise files at download; enforce invariants in transactions and constraints; audit high-risk changes; deny by default and test IDOR/cross-tenant attacks. Hiding navigation is not access control.

### Tenant-scoped request flow
~~~mermaid
flowchart TD
 A[Request] --> B[Authenticate]
 B -->|Invalid| X[401]
 B -->|Valid| C[Resolve company membership]
 C -->|None| Y[403]
 C --> D[Validate input/resource]
 D --> E[Authorise action and record scope]
 E -->|Denied| Z[403 or non-disclosing 404]
 E -->|Allowed| F[Execute domain transaction]
 F --> G[Write required audit event]
 G --> H[Return minimal response]
~~~

### Scheduled reminder flow
~~~mermaid
flowchart TD
 A[Select due candidates] --> B[Recheck tenant, status and due date]
 B --> C[Create idempotent job key]
 C --> D[Queue/send notification]
 D --> E{Provider result}
 E -->|Success| F[Record delivery]
 E -->|Transient failure| G[Bounded retry/backoff]
 E -->|Permanent failure| H[Record failure and alert if needed]
~~~

## 11. Conceptual entity relationship model
Full physical schema belongs to Phase 2.

~~~mermaid
erDiagram
 COMPANIES ||--o{ COMPANY_MEMBERSHIPS : has
 USERS ||--o{ COMPANY_MEMBERSHIPS : joins
 COMPANIES ||--o{ OFFICES : operates
 COMPANIES ||--o{ PROPERTIES : manages
 PROPERTIES ||--o{ UNITS : contains
 PROPERTIES ||--o{ PROPERTY_MEDIA : has
 COMPANIES ||--o{ CONTACTS : owns
 CONTACTS ||--o{ CONTACT_RELATIONSHIPS : has
 COMPANIES ||--o{ LEADS : receives
 LEADS ||--o{ VIEWINGS : schedules
 UNITS ||--o{ VIEWINGS : viewed
 LEADS ||--o{ DEALS : converts_to
 DEALS ||--o{ COMMISSIONS : earns
 UNITS ||--o{ LEASES : occupied_by
 LEASES ||--o{ RENT_CHARGES : generates
 RENT_CHARGES ||--o{ PAYMENT_ALLOCATIONS : allocated
 PAYMENTS ||--o{ PAYMENT_ALLOCATIONS : applied
 UNITS ||--o{ MAINTENANCE_REQUESTS : has
 COMPANIES ||--o{ DOCUMENTS : controls
 USERS ||--o{ AUDIT_LOGS : performs
 COMPANIES ||--o{ AUDIT_LOGS : scopes
~~~

A contact can have several relationships such as buyer, seller, tenant or landlord. A property may contain multiple units. Sales, leases, rent charges and receipts are distinct. Monetary values use fixed-precision numeric fields and explicit currency codes, never floating point.

## 12. Database planning principles
- Every company-owned row carries a non-null company key, including join/child tables where practical.
- Foreign keys must prevent cross-company references; use tenant-safe composite key patterns where needed.
- UUID primary keys are recommended for externally referenced domain records.
- Store timestamps in UTC with timezone-aware types; render using company/user timezone.
- Store money as numeric/decimal plus ISO currency code; document rounding and allocation rules.
- Use controlled statuses with documented transition rules.
- Separate properties from units; a building can have multiple units.
- Use explicit join tables for contact roles, ownership, assignments, portal access and document permissions.
- Archive records where history matters; do not silently cascade-delete contracts, payments or audit history.
- Keep immutable audit events separate from mutable records.
- Store file bytes in private object storage; database holds metadata, storage key, checksum, version and scope.
- Index tenant key plus frequent filters such as status, assignee and due date; validate with query plans.
- Use PostgreSQL RLS as defence in depth with transaction-local tenant context and carefully scoped database roles. RLS does not replace application authorisation.
- Make imports, webhooks and scheduled jobs idempotent.
- Define retention, anonymisation and deletion policies before production personal data is processed.

## 13. Security architecture
Identity: use a reputable OIDC provider or maintained authentication library; verified email, secure recovery, privileged MFA, session revocation and device/session management. Cookies should be HttpOnly, Secure and SameSite-appropriate. Do not implement cryptography/password storage from scratch.

Authorisation: deny-by-default RBAC plus record-level checks. Resolve tenant context from verified membership for each request/transaction. Apply tenant filters in data access and consider RLS as a second barrier. Automated negative tests must attempt cross-tenant reads, writes, search, exports, reports and file downloads.

Data/secrets: TLS in transit; provider-managed encryption at rest for database, backups and storage; secrets outside source control; rotation; least-privilege service identities; log redaction. Create short-lived signed file URLs only after application authorisation.

Application/API: schema validation, output encoding, parameterised queries, CSRF protections where cookie auth is used, CORS allowlists, rate limits, upload limits, malware scanning where appropriate, SSRF protections, security headers and dependency scanning. Verify webhook signatures and idempotency. Avoid leaking resource existence where appropriate.

Audit/incident response: record actor, company, action, entity, timestamp, correlation ID and selected change metadata. Protect logs from ordinary user alteration. Define incident severity, containment, notification and evidence-preservation runbooks.

Compliance boundary: privacy, tenancy, financial, consumer and residency obligations vary by country. Identify launch jurisdictions, controller/processor roles, retention rules, data-subject request handling and vendor contracts before launch. This is a security baseline, not a certification or legal opinion.

## 14. Scalability and resilience
- Start with modular domains: identity, tenancy, properties, CRM, sales, leases, maintenance, finance, documents, notifications, reporting and billing.
- Use transactions for consistent changes; use an outbox pattern when reliable event delivery is needed.
- Use bounded pagination; do not load entire portfolios into browser memory.
- Index by company, status, assignee, due date, property/unit and relationship keys based on measured query plans.
- Store media outside the relational database and process thumbnails asynchronously.
- Queue long imports, exports, reports, notifications and AI tasks with bounded retries and dead-letter handling.
- Cache only with tenant-scoped keys and documented invalidation.
- Add replicas or extract services only when measured workload justifies it.
- Establish connection pooling, migration gates, restore drills, load tests and alerts.
- Track per-tenant usage for plan limits and noisy-neighbour protection without exposing tenant data.

## 15. API architecture
Use a versioned HTTPS JSON REST API initially, with OpenAPI as the contract. Standardise validation errors, pagination, sorting allowlists, request IDs and timestamps.

Illustrative route families (not implemented):
- /api/v1/session, /api/v1/me, /api/v1/company-memberships
- /api/v1/companies, /api/v1/offices, /api/v1/users, /api/v1/roles
- /api/v1/properties, /api/v1/units, /api/v1/property-media
- /api/v1/contacts, /api/v1/leads, /api/v1/activities, /api/v1/viewings
- /api/v1/deals, /api/v1/offers, /api/v1/commissions
- /api/v1/leases, /api/v1/rent-charges, /api/v1/payments, /api/v1/payment-allocations
- /api/v1/maintenance-requests, /api/v1/inspections
- /api/v1/finance/income, /api/v1/finance/expenses, /api/v1/finance/reconciliation
- /api/v1/documents, /api/v1/notifications, /api/v1/reports
- /api/v1/subscription, /api/v1/usage, /api/v1/webhooks

API rules: authenticate and resolve membership server-side; validate inputs and state transitions; use explicit DTOs; use bounded pagination and allowlisted sorts; use idempotency keys for retried operations; use optimistic concurrency for costly overwrites; return stable safe errors with request ID; rate-limit by user and tenant; verify webhook signatures/replay constraints; generate audit fields server-side; expose long jobs as tenant-scoped resources; never trust client-supplied company, role, owner, commission result or payment status without server validation.

## 16. Decisions required before implementation
- Launch countries and applicable privacy/tenancy requirements.
- Initial customer segment and pilot workflows.
- Hosting provider, region, residency and budget.
- Identity and email providers.
- Billing/payment provider and supported currencies.
- Initial balance between sales inventory and rental management.
- Timing of landlord/tenant portals.
- Import sources and data quality requirements.
- Report definitions and finance approval policies.
- Document retention, upload limits and allowed types.
- Subscription limits and meaningful usage units.
- Availability, latency, RPO and RTO targets.
- External integrations required for the first pilot.

## 17. Phase 1 exit criteria
Owner sign-off requires acceptance of product boundaries/personas, tenant isolation and record-level access principles, entity relationships and domain boundaries, jurisdiction/hosting decisions or documented deferrals, KPI definitions and pilot workflows, and no fundamental modelling conflict blocking Phase 2.

## Phase 1 completion summary
### Completed deliverables
Product vision, objectives, personas, pain points, functional/non-functional requirements, journeys, navigation, SaaS architecture, diagrams, role hierarchy, permission matrix, conceptual ER model, database principles, security/scalability/API architecture, open decisions and phase exit criteria.

### Database requirements
Conceptual model only. No database, migrations or production data created. Phase 2 must define DDL, constraints, RLS, indexes, reference data, migration/rollback approach and cross-tenant tests.

### API requirements
Route families and contract principles documented; no endpoints implemented. Align contracts with physical schema and access policy.

### Security requirements
Tenant-scoped authorisation, deny-by-default RBAC, privileged MFA, private storage, audit trails, verified webhooks, encryption, rate limits and cross-tenant negative tests are baseline requirements.

### UI requirements
Responsive, accessible, role-aware navigation; efficient work queues; consistent forms/tables; clear validation and empty/error states. Detailed design system and screens belong to Phase 3.

### Scalability considerations
Modular monolith first, relational constraints, asynchronous workers, private storage, tenant-aware indexes, bounded queries, observability and tested recovery. Avoid premature microservices.

### Potential risks
- Launch jurisdiction and legal obligations are undefined.
- Operational finance could be mistaken for full accounting.
- Tenant leaks may occur through search, reports, exports, files, caches or jobs if scope is inconsistent.
- Poor imports can create duplicates or misleading records.
- Reminder delivery can fail without retries and due-state rechecks.
- AI can invent facts unless constrained to source material and reviewed by a person.
- Subscription enforcement can block legitimate workflows if usage rules are not agreed.
- Hosting, backup and support costs remain unknown until workload and service targets are defined.

### Next phase roadmap — Phase 2: Database Engineering
1. Define company, user and membership schema.
2. Define contacts and multi-role relationship tables.
3. Define properties, units, ownership and media metadata.
4. Define CRM, leads, viewings, deals and sales transactions.
5. Define leases, charges, receipts and allocations.
6. Define maintenance, inspections, expenses and commissions.
7. Define documents, notifications, jobs and audit events.
8. Add foreign keys, tenant-safe constraints, uniqueness and indexes.
9. Specify RLS policies and transaction-local tenant context.
10. Create migration/rollback strategy, fixtures and isolation tests.
11. Review schema against approved workflows before Phase 3.

Phase gate: do not begin Phase 2 implementation until the product owner reviews this architecture baseline.