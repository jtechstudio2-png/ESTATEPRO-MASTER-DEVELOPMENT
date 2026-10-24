# EstatePro — Pre-Phase-4 Compliance Audit

| | |
|---|---|
| Audit date | 24 October 2026 |
| Scope | Phases 1–3 against the original EstatePro Master Development Prompt and the product owner's confirmed requirements (launch markets, sales + rentals, portals, international architecture, Phase 3 UI direction) |
| Baseline audited | `main` at commit `c3118e1` |
| Method | Every requirement was traced to a file and section. Database claims were checked against a fresh build of the 15 migrations on PostgreSQL 16.15 (`database/scripts/verify.sh`: 15 migrations, 77 assertions passing). Suspected defects were reproduced with SQL in rolled-back transactions. No code or deliverable was changed. |

**Commits referenced**

| Commit | Contents |
|---|---|
| `13307c9` | Phase 1 baseline — `docs/PHASE-1-PRODUCT-STRATEGY-ARCHITECTURE.md` |
| `98a0408` | Phase 2 — migrations, tests, `docs/PHASE-2-DATABASE-ENGINEERING.md`, `docs/PHASE-1-DETAILED-SPECIFICATION.md`, `README.md` |
| `c3118e1` | Phase 3 — `docs/phase-3-ui-ux/01`–`07` and `README.md` |

**Status definitions used in this report**

| Status | Meaning |
|---|---|
| Completed | The requirement is met in full by an identifiable artefact; for database items, the object exists, builds, and (where noted) is tested. |
| Partially Completed | An artefact exists, but part of the requirement is missing, untested, inconsistent or only described at a lower level of detail than asked. |
| Not Yet Completed | No artefact meets the requirement. |
| Deferred Intentionally | Not done by a documented decision, with the phase or condition that will complete it. |

Abbreviations: **P1-B** = Phase 1 baseline; **P1-D** = Phase 1 detailed specification; **P2** = Phase 2 design document; **P3-0x** = `docs/phase-3-ui-ux/0x-…`; **M00xx** = migration file `database/migrations/00xx_…`; **T01/T02** = `database/tests/01_…`/`02_…`.

---

## SECTION 1 — MASTER PROMPT COMPLIANCE MATRIX

### 1.1 Cross-cutting requirements from the master prompt

| # | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| G1 | Develop phase by phase; do not skip phases | Completed | Commits `13307c9` → `98a0408` → `c3118e1`; `README.md` phase table | Phases 1–3 delivered in order; Phase 4 not started. |
| G2 | End each phase with: Completed Deliverables, Database, API, Security, UI Requirements, Scalability, Risks, Next Phase Roadmap | Completed | P1-B "Phase 1 completion summary"; P1-D §18.1–18.9; P2 §14.1–14.8; P3-05 §8.1–8.8 | All eight headings present in each phase. |
| G3 | Multi-tenant SaaS suitable for cloud deployment | Completed (design + database) | P1-D §9.4; P2 §4; M0013; T01 | Isolation enforced and tested in the database. Deployment not yet built (Phase 16). |
| G4 | Desktop, tablet and mobile support | Partially Completed | P3-03 §1–6; P3-04 §4–7; P3-06 §12; P3-07 §2 | Specified; tablet coverage is thin (2 wireframes). Nothing is implemented. |
| G5 | 11 user roles | Completed | P1-D §10.2; M0003 `platform_staff.role`; M0014 9 system roles; P3-02 §3 | Platform Owner and Super Admin are platform staff roles (`platform_staff`), not company roles — by design. |
| G6 | Target customers: agencies, developers, property managers, landlords, estate companies, brokers, rental firms | Completed | `companies.business_types` (M0003); `developments` (M0006); `deal_agents` (M0007); P1-D §3 | "Estate companies" and "rental management firms" are covered by `agency`/`property_manager`; there is no separate business type for them. |
| G7 | Reflect real-world practice; avoid demo solutions, fake metrics, hype, speculative AI | Completed | P3-06 §1 (every number from a named query); P1-D §5.11 AI-06; P2 §5.3 (no invented legal values) | No seeded fake business data except test fixtures in `database/tests/00_fixtures.sql`. |
| G8 | Organised, scalable, secure, maintainable, commercially viable | Partially Completed | P1-D §6, §15, §16; P2 §10, §14.6 | Designed and partly proven (isolation, constraints). Scalability is not load-tested; commercial model (prices, limits) not yet defined (Phase 14). |
| G9 | No country-specific workflow hard-coded (owner requirement) | Completed | P2 §5.2–5.3; M0002 `jurisdiction_settings`; M0014 seeds only rule keys | No schema object branches on a country. Verified by inspection of all CHECK constraints. |

### 1.2 Phase 1 — Product Strategy & System Architecture

| # | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 1.1 | Complete platform vision | Completed | P1-B §1; P1-D §0, §1 | Scope boundaries ("is / is not") and principles stated. |
| 1.2 | Business objectives | Completed | P1-B §2; P1-D §2.1–2.3 | P1-B defines KPI formulas; P1-D adds commercial objectives and revenue model. |
| 1.3 | User personas | Completed | P1-B §3; P1-D §3 | 10 personas mapped to roles. Not validated with real users. |
| 1.4 | Industry pain points | Completed | P1-B §4; P1-D §4 | |
| 1.5 | Functional requirements | Completed | P1-B §5; P1-D §5.1–5.12 | P1-D has 91 numbered requirements with M/S/C priority. |
| 1.6 | Non-functional requirements | Partially Completed | P1-B §6; P1-D §6 | P1-D gives numeric targets (99.9%, p95 300 ms, RPO 15 min, RTO 4 h); P1-B says targets are "agreed after hosting and workload decisions". The two documents disagree and no single agreed target set exists. |
| 1.7 | User journey mapping | Completed | P1-B §7; P1-D §7.1–7.5 | Five journeys with controls. |
| 1.8 | Platform structure | Completed | P1-B §8; P1-D §8.1–8.3 | |
| 1.9 | SaaS architecture design | Completed | P1-B §9; P1-D §9.1–9.5 | Modular monolith, tenancy model, cells, environments. |
| 1.10 | Role hierarchy | Completed | P1-B §10; P1-D §10.1–10.3 | |
| 1.11 | Permission matrix | Partially Completed | P1-B §10 table; P1-D §11.2–11.4; M0014 `role_permissions` | Seeded permissions differ from P1-D §11.2 in one place: P1-D gives Landlord "Deals R (link)" and note 4 (offers and viewing feedback on own listing); the seed grants `offer.view` but not `deal.view` or `viewing.view`. Office/team/own/linked scopes are application-enforced and not yet tested. |
| 1.12 | System flow diagrams | Completed | P1-B §9–10 (3 flow diagrams); P1-D §12.1–12.6 (6 diagrams; §12.7 is descriptive) | All Phase 1 Mermaid diagrams (4 in P1-B, all in P1-D) render without errors with Mermaid CLI 11.4.2 (re-checked for this audit). |
| 1.13 | Entity relationship model | Completed | P1-B §11; P1-D §13; superseded in detail by P2 §7 | |
| 1.14 | Database planning | Completed | P1-B §12; P1-D §14 | Money convention in P1-D (integer minor units) was superseded by P2 §13 (`numeric(19,4)`); P1-D is annotated accordingly. |
| 1.15 | Security architecture | Partially Completed | P1-B §13; P1-D §15 | Conflict: P1-B says use "a reputable OIDC provider or maintained authentication library"; P1-D §9.2 specifies "in-house auth module on proven libraries". Key management for field encryption is not designed. |
| 1.16 | Scalability architecture | Completed | P1-B §14; P1-D §16 | Not yet validated by load testing (Phase 16). |
| 1.17 | API architecture | Partially Completed | P1-B §15; P1-D §17 | Route naming conflicts between the two documents (`/offices` vs `/branches`; `/maintenance-requests` vs `/work-orders`). No OpenAPI contract exists. |
| 1.18 | "Do not write code yet" | Completed | Commit `13307c9` contains one Markdown file; P1-D contains no code blocks other than Mermaid | Verified with a search for SQL code fences in both Phase 1 documents (0 found). |

### 1.3 Phase 2 — Database Engineering

| # | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 2.1 | Companies: company_id | Completed | M0003 `companies.id` | Referenced as `company_id` everywhere else. |
| 2.2 | Companies: subscription_plan | Completed | M0003 `subscriptions.plan_code` → `plans` | Plan is on the subscription (history kept), not a column on `companies`. |
| 2.3 | Companies: status | Completed | M0003 `companies.status` CHECK (trial … cancelled) | |
| 2.4 | Companies: billing_data | Completed | M0003 `billing_profiles`, `subscription_invoices` | No card data stored. |
| 2.5 | Users: profiles | Completed | M0003 `users`, `agent_profiles` | |
| 2.6 | Users: permissions | Completed | M0003 `permissions`, `roles`, `role_permissions`, `company_memberships`; M0014 seed | |
| 2.7 | Users: authentication | Completed | M0003 `user_credentials`, `mfa_factors`, `external_identities`, `auth_tokens`, `user_sessions` | Schema only; flows built in Phase 4/15. |
| 2.8 | Properties: details | Completed | M0006 `properties`, `units`, `unit_features` | |
| 2.9 | Properties: categories | Completed | M0004 `property_types` (+ translations); M0014 39 seeded types | Country-scoped and company-extendable. |
| 2.10 | Properties: ownership | Completed | M0006 `property_ownerships` | Joint and unit-level ownership with dates. |
| 2.11 | Property media: photos, videos, floor plans | Completed | M0006 `property_media.media_type` | Virtual tours, site plans and brochures also supported. |
| 2.12 | Clients: buyers, sellers, landlords, tenants | Completed | M0005 `contacts`, `contact_relationships` | Single contact with multiple roles (design decision P1-D §13.2). |
| 2.13 | Agents: profiles | Completed | M0003 `agent_profiles` | |
| 2.14 | Agents: commission settings | Completed | M0010 `commission_plans`, `membership_commission_plans` | Overlap prevented by exclusion constraint. |
| 2.15 | Leads: source tracking | Completed | M0005 `leads.source_code`, `source_detail`, `campaign` | |
| 2.16 | Leads: status tracking | Completed | M0005 `leads.status`, `lead_status_history`, `lead_assignments` | |
| 2.17 | Property viewings: appointments | Completed | M0007 `viewings`, `viewing_attendees` | Agent double-booking prevented (T02). |
| 2.18 | Property viewings: outcomes | Completed | M0007 `viewings.outcome`, `feedback` | Completed status requires an outcome. |
| 2.19 | Sales: transactions | Completed | M0007 `deals`, `offers`, `deal_milestones`, `sales_transactions` | |
| 2.20 | Sales: contracts | Completed | M0007 `sales_transactions.contract_document_id`; M0011 `documents` | |
| 2.21 | Leases: rental agreements | Completed | M0008 `leases`, `lease_parties`, `management_agreements` | Overlapping live leases prevented (T02). |
| 2.22 | Leases: renewal tracking | Completed | M0008 `leases.renewal_status`, `previous_lease_id`, `rent_reviews` | `renewal_status` is maintained by the application/automation (Phase 7/12). |
| 2.23 | Rent payments: payment records | Partially Completed | M0008 `payments`, `payment_allocations`, `rent_charges` | Defects A1–A3 (Section 3.2): posted charges and payments can be edited or voided after allocation without the database preventing it. |
| 2.24 | Maintenance requests: repair tickets | Completed | M0009 `maintenance_requests` | |
| 2.25 | Maintenance requests: status updates | Completed | M0009 `maintenance_status_history`, `maintenance_updates` | |
| 2.26 | Finance: income | Completed | M0010 `finance_transactions` (fee and income types) | |
| 2.27 | Finance: expenses | Completed | M0010 `finance_transactions` (expense types), `supplier_invoices` | |
| 2.28 | Finance: commissions | Completed | M0010 `commissions` | Self-approval prevented (T02). |
| 2.29 | Documents: contracts | Completed | M0011 `documents`, `document_versions`, `document_links` | |
| 2.30 | Documents: ownership docs | Completed | M0011; `property_ownerships.evidence_document_id` | |
| 2.31 | Audit logs: activity tracking | Completed | M0012 `audit_logs` (partitioned, append-only) | Append-only verified (T01). |
| 2.32 | Notifications: alerts | Completed | M0012 `notifications`, `notification_preferences`, `message_deliveries` | |
| 2.33 | Notifications: reminders | Partially Completed | M0012 `automation_rules`, `scheduled_jobs` | Structures exist; the built-in reminder rules (P1-D AUT-02) are not seeded (0 rows). Deferred to Phase 12. |
| 2.34 | Primary keys | Completed | All migrations (UUIDv7); 147 PK constraints in the built database | |
| 2.35 | Foreign keys | Completed | 379 FK constraints; composite company-scoped keys; T01 composite-FK tests | |
| 2.36 | Constraints | Partially Completed | 379 CHECK, 115 UNIQUE, 4 EXCLUDE constraints; triggers in M0007/M0008/M0010/M0011 | Gaps A1–A3 (money edits after allocation) and A4 (document retention vs immutability). |
| 2.37 | Relationships | Completed | P2 §7.1–7.4 (four ER diagrams) | |
| 2.38 | Indexing recommendations | Completed | P2 §10; M0015 (107 FK indexes); 513 indexes total | Not validated against production-like data volumes. |
| 2.39 | Owner req.: multiple countries from launch | Completed | M0002; M0014 (GH, QA, GB with four UK jurisdictions) | |
| 2.40 | Owner req.: sales and rentals | Completed | M0006 `listings.listing_type`; M0007; M0008 | |
| 2.41 | Owner req.: landlord and tenant portals | Completed (data model) | `company_memberships.membership_type = 'portal'`, `contact_id`; `document_shares`; `maintenance_updates.visibility` | Portal record scoping is application logic, not yet built or tested. |
| 2.42 | Owner req.: multi-currency | Completed | Currency column on every money field; allocation currency check (T02); `fx_rates` | `fx_rates` has no data and no rate source is chosen. |
| 2.43 | Owner req.: configurable property types by region | Completed | `property_types.country_code`; T01 tests company-specific types | |
| 2.44 | Owner req.: country-specific lease templates | Partially Completed | M0011 `document_templates` (jurisdiction, locale, version) | Structure only; 0 templates exist. Requires legal drafting per market. |
| 2.45 | Owner req.: localisation-ready database | Completed | `locales.text_direction`; translation tables; `display_name_local` | |
| 2.46 | Owner req.: timezone-aware scheduling | Completed | IANA timezone on companies, offices, properties, users, viewings; `scheduled_jobs.local_due` + `timezone` + `run_at`; `app.lease_arrears(date)` | Recalculation of `run_at` after tzdata changes is an application job, not yet built. |
| 2.47 | Owner req.: tenant-safe isolation | Completed | M0013; T01 (34 assertions) | Strongest-evidenced area of the project. |
| 2.48 | Owner req.: future developers, agencies, landlords, brokers | Completed | `business_types`, `developments`, `development_phases`, `deal_agents` | |
| 2.49 | Phase 2 close-out | Completed | P2 §14 | |

### 1.4 Phase 3 — UI/UX System Design

| # | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| 3.1 | Design system: colours | Completed | P3-01 §1 | Contrast measured; control-border token added (3.61:1). |
| 3.2 | Design system: typography | Completed | P3-01 §2, §6 | |
| 3.3 | Design system: spacing | Completed | P3-01 §3, §6 | |
| 3.4 | Design system: components | Partially Completed | P3-04 §1–2 | Component contracts and required states; no per-component visual specification (sizes, anatomy, variants). |
| 3.5 | Property dashboard | Completed | P3-06 §3 | Layout + panel/data-source table. |
| 3.6 | CRM dashboard | Completed | P3-06 §4 (+ pipeline board §5) | |
| 3.7 | Finance dashboard | Completed | P3-06 §8 | |
| 3.8 | Rent dashboard | Completed | P3-06 §6 | |
| 3.9 | Maintenance dashboard | Completed | P3-06 §7 | |
| 3.10 | Admin dashboard | Partially Completed | P3-06 §9 | Panels and data sources specified; no layout wireframe (every other dashboard has one). |
| 3.11 | Sidebar structure | Completed | P3-02 §6 | Matrix for 7 staff roles + portal and platform navigation lists. |
| 3.12 | Navigation hierarchy | Completed | P3-02 §1, §2, §4 | |
| 3.13 | Dashboard layouts | Partially Completed | P3-06 §1, §3–8 | Six layouts drawn; Admin, Agent (desktop), technician list and landlord home not drawn. |
| 3.14 | Data tables | Completed | P3-07 §3; P3-01 §5 | |
| 3.15 | Forms | Completed | P3-03 §3; P3-07 §4 | |
| 3.16 | Filters | Completed | P3-07 §5 | |
| 3.17 | Search behaviour | Completed | P3-02 §7 | |
| 3.18 | Empty states | Completed | P3-07 §6 | |
| 3.19 | Error states | Completed | P3-07 §7 | Mapped to HTTP/DB error classes. |
| 3.20 | Usability and efficiency focus; avoid flashy design; clarity | Completed | P3-README principles; P3-01 §5; P3-06 §1 | |
| 3.21 | Owner deliverable 1: Design System | Completed | P3-01 | |
| 3.22 | Owner deliverable 2: Information Architecture | Completed | P3-02 §1–3 | |
| 3.23 | Owner deliverable 3: Navigation Structure | Completed | P3-02 §1, §4, §6 | |
| 3.24 | Owner deliverable 4: Desktop Wireframes | Partially Completed | P3-03 §1–3; P3-06; P3-07 §1, §2.1–2.4 | Low-fidelity ASCII. No wireframe for the platform console, Admin dashboard or desktop agent home. |
| 3.25 | Owner deliverable 5: Tablet Wireframes | Partially Completed | P3-03 §4; P3-07 §2.5; P3-06 §12 (rules) | Two tablet screens drawn; other screens described by rules only. |
| 3.26 | Owner deliverable 6: Mobile Wireframes | Partially Completed | P3-03 §5–6; P3-07 §2.6–2.7 | Four mobile screens; technician job list and landlord home not drawn. |
| 3.27 | Owner deliverable 7: User Flows | Completed | P3-03 §7 A–E | Five flows. |
| 3.28 | Owner deliverable 8: Role-specific Dashboards | Partially Completed | P3-06 | Platform Owner/Super Admin console has navigation only (P3-02 §6), no dashboard specification. |
| 3.29 | Owner deliverable 9: Component Library | Partially Completed | P3-04 §1–2 | See 3.4. |
| 3.30 | Owner deliverable 10: Design Tokens | Completed | P3-01 §1–3, §6 | |
| 3.31 | Owner deliverable 11: Accessibility Standards | Partially Completed | P3-04 §3; P3-07 §8 | WCAG 2.2 AA in Phase 3 vs WCAG 2.1 AA in P1-D §6 — inconsistent target. Not audited on rendered UI (none exists). |
| 3.32 | Owner deliverable 12: Responsive Behaviour Guidelines | Completed | P3-04 §4–7; P3-06 §12 | Not browser-tested (no UI yet). |
| 3.33 | Owner direction: fast workflows, minimal clicks, role dashboards, density, enterprise usability, field-agent mobile, accessibility, consistent system | Completed | P3-README; P3-06 §1; P3-07 §3–4, §8 | |
| 3.34 | Owner direction: avoid glassmorphism, animation, valueless widgets, marketing style, admin-template layouts | Completed | P3-01 §3 ("No glass effects…"), `--ep-motion-duration`; P3-06 §1.1 | |
| 3.35 | RTL Arabic support (owner: Qatar market) | Completed | P3-01 §7 | |
| 3.36 | Phase 3 close-out | Completed | P3-05 §8 | |

---

## SECTION 2 — DELIVERABLE GAP ANALYSIS

### 2.1 Missing deliverables

| ID | Missing item | Required by | Impact |
|---|---|---|---|
| MD-1 | Platform console (Platform Owner / Super Admin) dashboard and wireframes | Master prompt roles; owner deliverable 8 | Platform staff UI undefined; needed before Phase 14 at the latest |
| MD-2 | Admin dashboard layout wireframe | Phase 3 brief "Admin Dashboard", "Dashboard layouts" | Panels known, arrangement not |
| MD-3 | Desktop wireframe for the Agent home ("My day") | Owner deliverable 4 | Agent desktop layout described in text only (P3-06 §10) |
| MD-4 | Technician "My jobs" list wireframe and landlord portal home wireframe | Owner deliverables 6, 8 | Only detail screens drawn |
| MD-5 | OpenAPI contract | P1-D §17.1 ("OpenAPI 3.1 is the source of truth") | No machine-readable API yet; route naming unresolved |
| MD-6 | Seeded built-in reminder rules | P1-D AUT-02 | Deferred to Phase 12 |
| MD-7 | Lease templates, legal rule values, tax codes, public holidays, FX rates | Owner requirement (country lease templates); P2 §5.3 | All 0 rows; deferred pending legal/finance review |
| MD-8 | Plan prices, entitlements and usage limits | Master prompt Phase 14 | `plan_prices` 0 rows, `plan_entitlements` 0 rows; deferred to Phase 14 |

### 2.2 Incomplete specifications

| ID | Area | Gap | Evidence |
|---|---|---|---|
| IS-1 | Money integrity | Posted `rent_charges` and `payments` are not frozen; allocations are not reversed or blocked when a payment is voided/bounced or reduced | Defects A1–A3, Section 3.2 |
| IS-2 | Document retention | `document_versions` cannot be deleted or marked purged by any role, contradicting P2 §11 retention plan | Defect A4, Section 3.2 |
| IS-3 | `statement_lines` | Not frozen when the parent statement is issued (no trigger); lines could be deleted by the runtime role | `pg_trigger` shows none on `statement_lines` |
| IS-4 | Lifecycle transitions | Allowed transitions (e.g. lease `draft → active` skipping signature workflow) are application rules; only value lists and some invariants are in the database | P2 §8 |
| IS-5 | Company sign-up path | The runtime role can only insert a company row whose id equals the current context; `estatepro_auth` has no INSERT on `companies`. Which service creates a company at sign-up (platform role) is not specified | Grant check: auth INSERT = false |
| IS-6 | Support-access enforcement | `support_access_grants` exists, but the platform role bypasses RLS; nothing in the database ties platform reads to an approved grant | M0013; P2 §14.4 states it is application-enforced |
| IS-7 | Field encryption key management | `*_encrypted` columns exist; no key hierarchy, rotation or per-company data key storage is designed | P2 §14.2 defers to Phase 15 |
| IS-8 | Component visual specs | Contracts and states only (see 3.4) | P3-04 |
| IS-9 | Portal authentication | P1-D §15.2 mentions password + optional MFA or magic links; no decision on which is default per portal | P1-D §15.2 |
| IS-10 | UI string localisation | P1-D §6 requires externalised strings; no translation workflow, key convention or Arabic copy process | P1-D §6 |
| IS-11 | Test coverage | 77 assertions cover isolation and key rules; untested: deposits, statements arithmetic and freeze, required-document rules, number-sequence concurrency, concurrent allocations, every table's RLS (catalogue check was run manually, not in the suite) | `database/tests` |

### 2.3 Assumptions made

| ID | Assumption | Where | Risk if wrong |
|---|---|---|---|
| AS-1 | PostgreSQL 16+ as the database | P1-D §9.2; P2 header | Low — standard managed service |
| AS-2 | Modular monolith first | P1-D §9.1 | Low |
| AS-3 | Money as `numeric(19,4)` rounded to currency minor units | P2 §13 | Medium — rounding rules not yet confirmed by an accountant |
| AS-4 | Gregorian calendar default for all locales (Hijri optional later) | P3-01 §7 | Low–medium for Qatar users |
| AS-5 | Ghana weekend Sat–Sun, Qatar Fri–Sat, UK Sat–Sun | M0014 `countries.weekend_days` | Low |
| AS-6 | Qatar addresses have no postal code; Zone/Street/Building used | M0014 `address_format` | Low |
| AS-7 | SLA defaults: emergency 2 h / 24 h, urgent 24 h / 72 h, routine 72 h / 14 d, planned 7 d / 30 d | M0014 `sla_policies` | Medium — must match company practice; companies can override |
| AS-8 | Pipeline stage probabilities (5/10/20/40/70/85/100/0) | M0014 `pipeline_stages` | Medium — affects forecasts; companies can override |
| AS-9 | Seeded picklists and property types reflect market usage (e.g. chamber and hall, compound villa) | M0014 | Medium — not validated with local agencies |
| AS-10 | Default role permissions match how agencies work | M0014; P1-D §11 | Medium — not validated with users |
| AS-11 | Personas and journeys | P1-B §3, P1-D §3, §7 | Medium — desk research, no interviews |
| AS-12 | WCAG level (2.1 vs 2.2) | P1-D §6 vs P3-04 §3 | Low — 2.2 AA is a superset |

### 2.4 Areas requiring validation

| ID | Area | Validation needed |
|---|---|---|
| V-1 | Legal rules per market (deposits, notice, advance rent, lease registration, tenant eligibility) | Legal review in Ghana, Qatar and each UK nation before Phase 7 |
| V-2 | Tax treatment of fees | Tax adviser per market before Phase 9 |
| V-3 | Data residency | Confirm hosting obligations under Ghana Data Protection Act 2012 (Act 843), Qatar Law No. 13 of 2016 (personal data protection) and UK GDPR before choosing regions |
| V-4 | Wireframes and dashboards | Moderated usability tests (P3-05 §3) |
| V-5 | Permission matrix | Workshop with agency owners and managers |
| V-6 | Performance | Load tests against P1-D §6 targets with realistic volumes (P1-D §14.4) |
| V-7 | Index set | Query-plan review once real queries exist (513 indexes may include unused ones) |
| V-8 | NFR targets | Single agreed set (resolve P1-B vs P1-D) |
| V-9 | Concurrency | Concurrent allocation, reference numbering and lease activation tests |

### 2.5 Areas requiring future redesign

| ID | Area | Required change | Before |
|---|---|---|---|
| R-1 | `rent_charges` immutability | Freeze posted charges (amount, tax, currency, lease, due date); corrections by new adjustment/credit charges | Phase 7 |
| R-2 | `payments` lifecycle | Freeze amount/currency once cleared; require allocations to be reversed before `bounced`/`voided`/`refunded` (trigger or check) | Phase 7 |
| R-3 | `document_versions` retention | Allow a retention-purge state (e.g. `purged_at` mutable, or deletion by the platform role only when `retention_until` has passed and no legal hold) | Phase 10 |
| R-4 | `statement_lines` freeze | Block insert/delete when the statement is issued | Phase 9 |
| R-5 | `deals.stage_class` sync | Trigger also on `deal_type` change | Phase 6 |
| R-6 | Phase 1 document consolidation | Resolve conflicts (auth approach, API names, NFR targets, WCAG level) into one authoritative statement | Phase 4 start |
| R-7 | Landlord permissions | Add `deal.view`/`viewing.view` (linked) or amend P1-D §11.2 note 4 | Phase 6 |

---

## SECTION 3 — DATABASE AUDIT

### 3.1 Item-by-item confirmation

Verified against the database built from `main` (`c3118e1`) on PostgreSQL 16.15.

| Item | Status | Implementation | Verification |
|---|---|---|---|
| Companies | Completed | `companies`, `billing_profiles` (M0003) | Isolation tests T01 |
| Users | Completed | `users`, `user_credentials`, `mfa_factors`, `external_identities`, `auth_tokens`, `user_sessions` | T01 (secrets not readable by runtime role; user visibility) |
| Memberships | Completed | `company_memberships`, `membership_offices`, `teams`, `team_members` | Composite FKs; fixtures |
| Roles | Completed | `roles` (9 system roles) + `platform_staff.role` | T01 (9 system roles visible) |
| Permissions | Completed | `permissions` (94), `role_permissions` with scope | Seed verified; one deviation from P1-D (R-7) |
| Properties | Completed | `properties`, `developments`, `development_phases`, `property_ownerships`, `property_notes`, `key_sets` | T01, T02 |
| Units | Completed | `units`, `unit_features`, `availability` incl. `under_maintenance` | T01 composite-FK test |
| Property Media | Completed | `property_media` | Schema only; no test |
| Leads | Completed | `leads`, `lead_status_history`, `lead_assignments` | Schema only; no test |
| CRM | Completed | `activities`, `activity_links`, `tasks`, `requirements`, `consents`, `kyc_checks`, `identity_documents` | Schema only; polymorphic links have no FK (documented) |
| Contacts | Completed | `contacts`, `contact_relationships`, `contact_methods`, `contact_links`, `contact_payment_accounts` | T01 |
| Deal Pipeline | Completed | `pipeline_stages`, `deals`, `deal_stage_history`, `deal_parties`, `deal_agents`, `deal_milestones`, `sales_transactions` | T02 (stage sync, wrong-type stage, lost requires reason) |
| Offers | Completed | `offers` (immutable terms, one accepted per listing) | T02 |
| Leases | Completed | `leases`, `lease_parties`, `rent_reviews`, `management_agreements`, `deposits`, `inspections` | T02 (overlap, signature requirement, renewal chain) |
| Rent Charges | Partially Completed | `rent_charges` | T02 (duplicate period blocked). Defect A1: posted charges editable |
| Rent Payments | Partially Completed | `payments` | T02 (pending cheque cannot be allocated). Defects A2, A3 |
| Payment Allocations | Completed | `payment_allocations` + validation trigger, append-only | T02 (over-allocation, reversal, append-only) |
| Maintenance Requests | Completed | `maintenance_requests`, `maintenance_status_history`, `maintenance_updates`, `maintenance_quotes`, `maintenance_work_logs`, `planned_maintenance`, `sla_policies` | T02 (no work while approval pending) |
| Maintenance Assignments | Completed | `maintenance_assignments` (one active per request) | Schema only; no test |
| Documents | Partially Completed | `documents`, `document_versions`, `document_links`, `document_shares`, `document_templates`, `required_document_rules` | T02 (version immutability). Defect A4: retention purge impossible |
| Notifications | Completed | `notifications` (partitioned), `notification_preferences`, `message_deliveries` | Schema only; no test |
| Audit Logs | Completed | `audit_logs` (partitioned, append-only) | T01 |
| Subscription Plans | Partially Completed | `plans` (3 rows), `plan_prices` (0 rows), `subscriptions`, `subscription_invoices` | Prices deferred to Phase 14 |
| Feature Entitlements | Partially Completed | `plan_entitlements` (0 rows) | Structure only; limits deferred to Phase 14 |
| Usage Tracking | Partially Completed | `usage_counters`, `ai_requests` | Structure only; nothing writes counters yet |
| Internationalisation | Completed | `countries`, `locales`, `jurisdictions`, `jurisdiction_setting_definitions`, translations, `addresses.local_components` | Seed: 3 countries, 7 jurisdictions, 6 locales. Rule values intentionally empty |
| Currency Support | Completed | `currencies` (13, incl. 3-decimal), currency on every money field, `fx_rates` | T02 currency-mismatch path exercised via trigger code; `fx_rates` empty |
| Timezone Support | Completed | IANA timezone columns; `scheduled_jobs` local/UTC design; `app.lease_arrears(as_of)` | T02 arrears ageing by as-of date |
| RLS Policies | Completed | 165 policies; RLS enabled on all 120 tables with `company_id` plus 8 identity/company tables (128 total) | T01 (34 assertions); catalogue query: 0 company tables without RLS or policy |

### 3.2 Confirmed defects

Each was reproduced on 24 October 2026 in a transaction that was rolled back.

| ID | Defect | Reproduction result | Severity |
|---|---|---|---|
| A1 | A posted rent charge's amount can be changed after it has been fully paid | Charge paid 6,000, amount updated to 100 → `outstanding_amount` = **−5,900.00** | High (rent ledger integrity) |
| A2 | A cleared payment's amount can be reduced below the total already allocated from it | Payment 6,000 fully allocated, amount updated to 10 → amount 10.00, allocated 6,000.00 | High |
| A3 | A payment can be voided while its allocations remain active | Status set to `voided` with 6,000 still allocated; balances still treat the charge as paid | High |
| A4 | Document versions cannot be deleted or marked purged by any role, including `estatepro_platform` | `DELETE` rejected: "document_versions row … is pending and cannot be deleted" | Medium (retention/erasure obligations) |

The Phase 2 document's statements on immutability (P2 §3 "Immutability", §9.1) are accurate for allocations, ledger entries, finance transactions, statements and audit logs, but P2 §3's general wording ("posted rows are frozen") overstates protection for `rent_charges` and `payments`.

None of A1–A4 affects the Phase 4 scope (properties, units, listings, media, notes).

### 3.3 Database metrics (as built)

| Metric | Value |
|---|---|
| Tables (excluding partitions) | 140 |
| Primary keys / foreign keys | 147 / 379 |
| CHECK / UNIQUE / EXCLUDE constraints | 379 / 115 / 4 |
| Indexes on parent tables | 513 |
| Tables with `company_id` / with RLS enabled | 120 / 128 |
| RLS policies | 165 |
| Test assertions | 77 (34 isolation, 43 business rules), all passing |

---

## SECTION 4 — UI/UX AUDIT

| Item | Present | Evidence | Notes |
|---|---|---|---|
| Design System | Yes — Completed | P3-01 | |
| Typography System | Yes — Completed | P3-01 §2, §6 | Includes Arabic font fallback |
| Colour System | Yes — Completed | P3-01 §1 | Measured contrast table; status mapping |
| Layout Rules | Yes — Completed | P3-01 §3–5; P3-04 §5; P3-06 §1.7; P3-07 §1 | |
| Navigation | Yes — Completed | P3-02 §1, §4 | |
| Sidebar | Yes — Completed | P3-02 §6 | |
| Global Search | Yes — Completed | P3-02 §7 | |
| Property Dashboard | Yes — Completed | P3-06 §3 | |
| CRM Dashboard | Yes — Completed | P3-06 §4 | |
| Rent Dashboard | Yes — Completed | P3-06 §6 | |
| Maintenance Dashboard | Yes — Completed | P3-06 §7 | |
| Finance Dashboard | Yes — Completed | P3-06 §8 | |
| Admin Dashboard | Partial | P3-06 §9 | Panel specification only; no layout wireframe |
| Agent Dashboard | Partial | P3-06 §10 (text); P3-03 §5 (mobile wireframe) | No desktop wireframe |
| Technician Dashboard | Partial | P3-06 §10 (text); P3-07 §2.6 (job detail, mobile) | No job-list wireframe |
| Tenant Portal Dashboard | Yes — Completed (mobile) | P3-03 §6; P3-06 §11 | Desktop portal layout covered by rules only |
| Landlord Portal Dashboard | Partial | P3-06 §11 (content table); P3-07 §2.7 (approval screen) | No home wireframe |
| Desktop Wireframes | Partial | P3-03 §1–3; P3-06 §3–8; P3-07 §1, §2.1–2.4 | 14 desktop layouts; gaps MD-1 to MD-3 |
| Tablet Wireframes | Partial | P3-03 §4; P3-07 §2.5 | 2 screens + rules |
| Mobile Wireframes | Partial | P3-03 §5–6; P3-07 §2.6–2.7 | 4 screens + rules |
| Forms | Yes — Completed | P3-03 §3; P3-07 §4 | |
| Tables | Yes — Completed | P3-07 §3 | |
| Filters | Yes — Completed | P3-07 §5 | |
| Empty States | Yes — Completed | P3-07 §6 | |
| Error States | Yes — Completed | P3-07 §7 | |
| Accessibility Requirements | Yes — Partial | P3-04 §3; P3-01 §1; P3-07 §8 | Target inconsistent with P1-D (2.2 vs 2.1); untested |
| Mobile Responsiveness | Yes — Completed (specified) | P3-04 §4–7; P3-06 §12 | Not browser-tested |
| RTL Arabic Support | Yes — Completed (specified) | P3-01 §7 | Not tested; no Arabic UI copy yet |

All Phase 3 artefacts are written specifications and low-fidelity ASCII wireframes. There is no high-fidelity design, interactive prototype or coded UI, as P3-05 §7 states.

---

## SECTION 5 — PRE-PHASE-4 READINESS REVIEW

| Area | Rating | Basis | What moves it to Green |
|---|---|---|---|
| Product Architecture | **Amber** | Architecture is complete (Section 1.2), but the two Phase 1 documents conflict on auth approach, API route names, NFR targets and WCAG level; technology stack not confirmed | Product owner confirms stack (Section 6) and one consolidated decision record for R-6 |
| Database Design | **Amber** | Phase 4 tables (properties, units, listings, media, notes, keys) are complete and tested for isolation. Money tables have confirmed defects A1–A3 and document retention A4 | Fix A1–A4 before Phases 7/9/10; Phase 4 can start on the current schema |
| Security Design | **Amber** | Isolation, RBAC model, audit and MFA schema in place; auth implementation approach unresolved (IS-9, R-6); encryption key management undesigned (IS-7); support-access enforcement is application-only (IS-6) | Decide auth approach before building sign-in (first Phase 4 task); key management by Phase 5 (first sensitive fields) |
| Tenant Isolation | **Green** | RLS on all 120 company tables, composite FKs, shared-reference trigger, partition and secret-table protection; 34 passing assertions; fail-closed without context | — |
| UI/UX Design | **Amber** | All required topics specified; gaps MD-1 to MD-4; no usability testing; low fidelity only | Usability tests on Phase 4 screens; draw missing wireframes before the phases that use them |
| API Planning | **Amber** | Principles, error model, pagination, idempotency and resource map exist; no OpenAPI contract; naming conflicts; company sign-up path unspecified (IS-5) | OpenAPI for Phase 4 endpoints written first; adopt Phase 2 table names for routes |
| Subscription Model | **Amber** | Plans exist; no prices, entitlements or limits (MD-8); feature gating not designed beyond P1-D §5.12 | Not needed for Phase 4; required before Phase 14. Phase 4 should read entitlements through one service so gating can be added later |
| Portal Design | **Amber** | Data model and navigation complete; landlord home not drawn (MD-4); portal authentication default undecided (IS-9); record-level portal scope untested | Decide portal sign-in method; portal scope tests in Phase 7 |
| Internationalisation | **Amber** | Schema and UI rules complete and seeded for GH/QA/GB; legal values, tax codes, templates, holidays and FX are empty by design (MD-7); UI string translation workflow undefined (IS-10) | i18n framework chosen in Phase 4 scaffolding; legal/tax data before Phases 7/9 |
| Deployment Planning | **Amber** | High-level environments and infrastructure in P1-D §9.2, §9.5, §16; hosting provider and regions not chosen; data-residency validation pending (V-3); Phase 16 not started | Choose provider/regions; Phase 4 needs only CI and a staging environment |

No area is rated Red for starting Phase 4. Defects A1–A3 are rated **Red at the Phase 7 gate** and A4 **Red at the Phase 10 gate**: work in those phases must not start until they are fixed.

---

## SECTION 6 — PHASE 4 IMPLEMENTATION RECOMMENDATION

### 6.1 Recommended technology stack

| Layer | Recommendation |
|---|---|
| Language | TypeScript (strict) across back end and front end |
| Back end | Node.js LTS with NestJS (modules matching the Phase 1 bounded contexts) |
| Database | PostgreSQL 16+ (managed), using the existing SQL migrations as the source of truth |
| Data access | Kysely (type-safe SQL query builder) with types generated from the database; every request runs in a transaction that sets `app.company_id` / `app.user_id` with `SET LOCAL` |
| Money in code | Decimal values handled as strings from PostgreSQL and computed with a decimal library (e.g. `decimal.js`); JavaScript `number` never used for money |
| Jobs and cache | Redis with BullMQ; transactional outbox relay (table already exists) |
| Front end | React with Next.js (App Router), server-side rendering for portals; design tokens as CSS custom properties; accessible headless components (e.g. React Aria) styled with the tokens |
| Internationalisation | ICU message format (e.g. FormatJS / `react-intl`), `Intl` APIs for dates, numbers and currency, CSS logical properties for RTL |
| Authentication | Auth module on maintained libraries (Argon2id hashing, WebAuthn, TOTP) using the existing identity tables; OIDC/SAML for Enterprise SSO |
| Files | S3-compatible object storage with pre-signed URLs and asynchronous malware scanning |
| API contract | OpenAPI 3.1 written before each endpoint; client generated from it |
| Testing | `verify.sh` for the database; Jest/Vitest for unit tests; API integration tests against a real PostgreSQL; Playwright with axe for UI and accessibility |
| Infrastructure | Containers, infrastructure as code (Terraform), one cell per region; OpenTelemetry for logs, metrics and traces |

### 6.2 Reasons for selection

1. **Fits the built database.** The schema relies on PostgreSQL features (RLS, exclusion constraints, generated columns, partitioning) and transaction-scoped settings. A SQL-first query builder keeps those features visible and avoids an ORM generating its own schema.
2. **One language end to end.** Shared types for API contracts, validation and money handling; one hiring profile; less context switching for a small team.
3. **Modular structure.** NestJS modules map one-to-one onto the bounded contexts (P1-D §8.2), which keeps the modular-monolith boundaries enforceable.
4. **Portals and staff app in one front end.** Next.js route groups give the separate shells and token audiences required by P3-05 §8.4, with server rendering for fast portal pages on mobile networks.
5. **Accessibility and RTL.** Headless accessible components plus CSS logical properties meet the Phase 3 WCAG and Arabic requirements without fighting a visual framework.
6. **Mature, widely supported components** with long-term support releases and a large talent pool in all three markets.

### 6.3 Tradeoffs

| Choice | Benefit | Cost |
|---|---|---|
| Kysely instead of a full ORM | Full SQL control, RLS-friendly, no schema drift | More hand-written queries; fewer conveniences (no automatic relations) |
| NestJS | Structure, dependency injection, modules | More boilerplate than lighter frameworks |
| Next.js for staff app and portals | One codebase, SSR | Framework release cadence requires regular upgrades |
| In-house auth on libraries | Full control of multi-company memberships and portal identities; schema already supports it | Security-critical code to own, review and pen-test; a managed provider would shift that burden |
| Node.js for finance logic | Shared types | Must enforce decimal handling strictly (lint rule banning `number` for money fields) |

### 6.4 Risks

| Risk | Mitigation |
|---|---|
| Money precision errors in JavaScript | Decimal library, string transport, lint rules, property-based tests on allocation and statement maths |
| Forgetting `SET LOCAL` context in a code path | A single transaction wrapper that is the only way to obtain a database handle; RLS fails closed if it is missed |
| Auth vulnerabilities in self-built flows | Use only maintained libraries; threat model and external penetration test before launch (Phase 15); consider a managed identity provider if review capacity is limited |
| Framework churn (Next.js) | Pin versions; upgrade on a schedule; keep business logic in the API, not the front end |
| Team unfamiliar with RLS | Developer guide plus the existing T01 tests extended for every new table |
| Data residency per market | Validate V-3 before choosing regions; the cell design supports per-region deployment. At the time of writing, hyperscaler regions exist in Doha (Google Cloud, Microsoft Azure) and London (all major providers); there is no hyperscaler region in Ghana, so the legal position on cross-border storage must be confirmed |

### 6.5 Alternative stack options

| Option | Strengths | Weaknesses for EstatePro |
|---|---|---|
| **Laravel (PHP 8.3+) + PostgreSQL + Inertia/Vue or Livewire** | Very productive; strong conventions; large talent pool; familiar to teams coming from WordPress | Eloquent ORM is less natural with RLS and composite keys; separate language from the front end if React is used; async jobs and typing are weaker than the TypeScript option |
| **Django (Python) + PostgreSQL + React** | Mature admin, strong ORM, good security defaults | ORM expects single-column foreign keys (composite company-scoped keys need workarounds); two languages |
| **ASP.NET Core (C#) + PostgreSQL + React** | Excellent performance, strong typing, `decimal` type for money, long-term support | Smaller talent pool in Ghana; heavier tooling; two languages |
| **Supabase (managed PostgreSQL + Auth + Storage) + Next.js** | Fast start; auth, storage and RLS-centred design built in | Its auth model assumes one user ↔ one tenant context per JWT claim; multi-company memberships and portal identities need custom claims; vendor coupling for a system of record |
| **Managed identity (Auth0, Microsoft Entra External ID, AWS Cognito, Keycloak) with the recommended stack** | Moves password, MFA and SSO security to a specialist service | Ongoing per-user cost (Auth0, Cognito) or self-hosting effort (Keycloak); the existing `user_credentials`/`mfa_factors` tables would become partly unused |

**Recommendation:** proceed with the stack in 6.1. Decide between in-house authentication and a managed identity provider as the first Phase 4 action, because it determines how sign-in, MFA and portal access are built.
