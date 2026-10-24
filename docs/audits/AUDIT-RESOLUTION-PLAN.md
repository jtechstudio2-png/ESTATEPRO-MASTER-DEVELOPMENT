# EstatePro — Audit Resolution Plan

| | |
|---|---|
| Source | [Pre-Phase-4 Compliance Audit](PRE-PHASE-4-COMPLIANCE-AUDIT.md) (24 October 2026) |
| Decisions recorded | Product owner, 24 October 2026: Phase 4 approved; managed identity provider; WCAG 2.2 AA; standardise API conventions |
| Tracking | This register is the system of record for audit findings. Every item has an owner and a status, and is re-reviewed at each phase close-out. A finding is closed only with evidence (commit, test or decision record). |
| Branch rule | The audit package stays on `audit/pre-phase-4` and is not merged into `main` until every **Critical/High** item is Resolved or formally Accepted. |

## Owners

| Owner | Who | Responsibility |
|---|---|---|
| Product Owner (PO) | JtechStudio (repository owner) | Decisions, acceptance of risk, vendor and market choices |
| Engineering (ENG) | Claude Code under PO direction, until a named engineering lead is appointed | Schema, API, tests, technical documentation |
| UX | Claude Code under PO direction, until a named UX lead is appointed | Wireframes, design system, usability test plans |
| Legal & Compliance (LEG) | External adviser per market, to be appointed by PO | Legal rule values, templates, data residency, tax |

## Severity scale

| Severity | Meaning |
|---|---|
| Critical | Can corrupt money or legal records, or leak data across companies, in a phase that is about to start. Blocks that phase. |
| High | Breaks a core business rule or a security control; must be fixed before the phase that uses the affected area. |
| Medium | Weakens correctness, compliance or usability; fix within the impacted phase. |
| Low | Consistency or convenience issue; fix when the area is next touched. |

## Status values

Open · Decided (resolution agreed, not yet implemented) · Scheduled (assigned to a phase or milestone) · In progress · Resolved (evidence linked) · Accepted (risk accepted by PO, with reason)

---

## 1. Data integrity findings (A1–A4)

### A1 — A paid rent charge can still be edited

| Field | Value |
|---|---|
| Description | A `rent_charges` row in status `posted` can have its `amount`, `tax_amount`, `due_date`, `currency_code` or `lease_id` changed after payments have been allocated to it. Reproduced: a charge paid in full (6,000) was edited to 100, leaving an outstanding balance of −5,900. |
| Severity | **High** (Critical once Phase 7 starts) |
| Recommended resolution | 1. A trigger freezes posted charges: only `status` (to `waived`/`cancelled`), `waived_reason`, `updated_at` and `version` may change. 2. `waived`/`cancelled` is allowed only while the charge's net allocation total is zero. 3. Corrections are made with a new table `rent_charge_adjustments` (signed amount, reason, approver, posted date, period-lock enforced); `rent_charge_balances` includes adjustments. 4. Regression tests reproducing the defect, plus the allowed paths. |
| Impacted phase | Phase 7 (Rental & Lease Management); schema change in a Phase 7 migration |
| Estimated effort | 1.5 engineering days including tests and documentation |
| Owner | ENG |
| Status | **Scheduled** — first milestone of Phase 7; Phase 7 may not start rent features until Resolved |

### A2 — A payment amount can be reduced below its allocated value

| Field | Value |
|---|---|
| Description | `payments.amount` can be lowered after allocation. Reproduced: payment of 6,000 fully allocated, amount changed to 10. |
| Severity | **High** |
| Recommended resolution | 1. Once a payment is `cleared`, freeze `amount`, `currency_code`, `payer_contact_id`, `received_on`, `bank_account_id` and instrument fields; only status fields and notes may change. 2. A trigger rejects any update that makes `amount` lower than the net allocated total (covers pending payments too). 3. A mistaken receipt is corrected by voiding it (see A3) and recording a new payment. 4. Regression tests. |
| Impacted phase | Phase 7 |
| Estimated effort | 0.5 engineering day |
| Owner | ENG |
| Status | **Scheduled** — Phase 7, first milestone, together with A1 and A3 |

### A3 — Payments can be voided while allocations remain active

| Field | Value |
|---|---|
| Description | A payment can move to `voided`, `bounced` or `refunded` with allocations still counting against charges, so the charges still look paid. Reproduced with a 6,000 allocation. |
| Severity | **High** (a bounced post-dated cheque would silently clear arrears) |
| Recommended resolution | 1. A trigger allows `bounced`, `voided` and `refunded` only when the payment's net allocation total is zero. 2. The API action `POST /payments/{id}/bounce` (and `/void`, `/refund`) writes the reversal allocations and the status change in one transaction, records the reason, and emits an outbox event so arrears reminders restart. 3. Tests for a bounced cheque restoring arrears. |
| Impacted phase | Phase 7 |
| Estimated effort | 1 engineering day |
| Owner | ENG |
| Status | **Scheduled** — Phase 7, first milestone |

### A4 — Document retention conflicts with undeletable versions

| Field | Value |
|---|---|
| Description | `document_versions` rejects every `UPDATE` except scan fields and every `DELETE`, for all roles. The retention plan (Phase 2 §11) and erasure requests need versions to be purged after `retention_until` when there is no legal hold. Reproduced: deletion by `estatepro_platform` rejected. |
| Severity | **Medium** |
| Recommended resolution | 1. Add `purged_at`, `purged_by`, `purge_reason` to `document_versions` and make them the only additional mutable columns. 2. Purge = delete the object from storage, then set `purged_at`; the row (metadata, checksum) stays as evidence that the version existed. 3. A trigger allows purge only when the parent document has `legal_hold = false` and `retention_until < current_date`, and only for `estatepro_platform` (`current_user` check). 4. Downloads refuse purged versions. 5. Tests for allowed and refused purges. |
| Impacted phase | Phase 10 (Document Management). Phase 4 media does not use `document_versions`. |
| Estimated effort | 1 engineering day |
| Owner | ENG (design), LEG (retention periods) |
| Status | **Scheduled** — Phase 10, first milestone |

---

## 2. Phase 1 contradictions (R-6)

Each is resolved by a decision record on the Phase 4 branch (`docs/decisions/`), which supersedes the conflicting Phase 1 text.

| ID | Contradiction | Resolution | Rationale | Owner | Status |
|---|---|---|---|---|---|
| C1 | Authentication: P1-B "reputable OIDC provider or maintained library" vs P1-D "in-house auth module" | **Managed identity provider (OIDC).** The IdP owns sign-in, passwords, MFA, passkeys, recovery and enterprise SSO. EstatePro verifies IdP-issued access tokens, maps the token subject to `users` through `external_identities`, and keeps all authorisation (memberships, roles, scopes) in its own database. MFA for privileged memberships is enforced by the API from the token's `amr` claim. `user_credentials`, `mfa_factors` and `auth_tokens` become unused and are removed by a later migration (tracked as C1-F). Vendor chosen by PO against the criteria in ADR-001. | Moves the highest-risk security code to a specialist; standard OIDC keeps the vendor replaceable; authorisation stays with the data it protects (RLS). | PO (vendor), ENG (integration) | **Decided** — ADR-001. Vendor selection: **Open** (PO) |
| C1-F | Remove unused identity tables | Migration dropping `user_credentials`, `mfa_factors`, `auth_tokens` and their grants, after the IdP integration is live | Avoids dead security-sensitive tables | ENG | **Scheduled** — Phase 15 |
| C2 | API route names: `/offices` vs `/branches`; `/maintenance-requests` vs `/work-orders` | **Routes use the Phase 2 schema vocabulary**: plural, kebab-case nouns (`/offices`, `/maintenance-requests`, `/properties`, `/units`, `/listings`); sub-resources one level deep (`/properties/{id}/units`); state changes as `POST /{resource}/{id}/{action}`. JSON in camelCase; money as decimal strings with currency; RFC 9457 errors; cursor pagination; `filter[...]` and `sort=` allow-lists; company context via a validated header. | One vocabulary from database to UI; avoids translation bugs | ENG | **Decided** — ADR-003 |
| C3 | Performance targets: P1-B "agreed after hosting decisions" vs P1-D numeric targets | **P1-D §6 numbers are adopted as provisional SLOs** (99.9% availability; p95 reads < 300 ms; p95 writes < 500 ms; filtered search < 1 s; RPO ≤ 15 min; RTO ≤ 4 h). They are confirmed or revised after the Phase 16 load-test baseline. | Engineers need targets now; the baseline step from P1-B is kept as the confirmation gate | PO (approve), ENG (measure) | **Decided** (provisional); confirmation **Scheduled** Phase 16 |
| C4 | Accessibility: WCAG 2.1 AA (P1-D) vs 2.2 AA (Phase 3) | **WCAG 2.2 AA** for all staff, portal and platform interfaces | Product owner decision; 2.2 is a superset of 2.1 and adds target size, focus visibility and accessible authentication | PO | **Decided** — ADR-002 |

---

## 3. Permission mismatch (landlord visibility)

**Finding:** P1-D §11.2 gives the Landlord role "Deals R (link)" with note 4 ("a seller-landlord sees offers and viewing feedback on their own listing"). The Phase 2 seed grants `offer.view` but not `deal.view` or `viewing.view`.

| ID | Topic | Recommendation | Rationale |
|---|---|---|---|
| P1 | Landlord visibility of offers | **Grant (linked scope):** a landlord who owns the property (current `property_ownerships` row) sees every offer on their own listings: amount, currency, conditions, financing type, status and dates. Buyer identity is shown as the name only; buyer contact details are never shown. | Sellers decide on offers, so they must see all of them. In the UK, agents are required to pass offers to their seller client promptly and in writing; the same practice is standard in the other markets. Hiding buyer contact details prevents the agency being bypassed and protects the buyer's personal data. |
| P2 | Deal progress visibility | **Grant (linked scope, milestone level):** the landlord sees the deal stage and the `deal_milestones` checklist (name, due date, completed or not) for deals on their own listings. Internal notes, activities, agent commissions, expected agency fee and other parties' documents are excluded. | Sellers routinely ask "where are we?". Milestones answer that without exposing internal or third-party information. |
| P3 | Viewing feedback visibility | **Grant (linked scope, opt-in per viewing):** the landlord sees viewings on their own listings (date, outcome) and the feedback text only where the agent has set `viewings.seller_feedback_shared = true`. Attendee identities are not shown. | Feedback is written for the agency first; agents edit before sharing. The column already exists in Phase 2, so this needs no schema change beyond permissions. |

| Field | Value |
|---|---|
| Severity | **Medium** |
| Implementation | Phase 6 migration adds `deal.view` and `viewing.view` with `linked` scope to the `landlord` system role; landlord portal endpoints return a reduced field set (portal DTOs), enforced and tested at the API. P1-D §11.2 note 4 is updated to match. |
| Impacted phase | Phase 6 (seed and API), Phase 7 (landlord portal screens) |
| Estimated effort | 1 engineering day (permissions, portal DTOs, tests) |
| Owner | PO (approve recommendation), ENG (implement) |
| Status | **Decided** pending PO acknowledgement; implementation **Scheduled** Phase 6 |

---

## 4. Missing UI items

Phase 4 needs only the property register, record form, record page pattern, listing editor and Property dashboard, all of which exist (P3-03 §2–3, P3-07 §1, §2.3, P3-06 §3). None of the six missing items is needed for Phase 4.

| ID | Item | Severity | Needed by | Recommendation | Effort | Owner | Status |
|---|---|---|---|---|---|---|---|
| MD-1a | Platform Owner console | Medium | First external customer / Phase 14 (plans, pricing, company lifecycle) | Deliver before Phase 14. Phase 4 provisions companies with an audited command-line tool run by platform staff, so no console is needed yet. | 1 UX day | UX | **Scheduled** — before Phase 14 |
| MD-1b | Super Admin console | Medium | Phase 14 (company lifecycle) and Phase 15 (support access) | Same deliverable as MD-1a, with role-specific sections (support access grants, incidents) | Included in MD-1a | UX | **Scheduled** — before Phase 14 |
| MD-2 | Admin dashboard wireframe | Low | Phase 5 (users, roles, invitations become usable) | Deliver during the Phase 5 design pass | 0.5 UX day | UX | **Scheduled** — Phase 5 |
| MD-3 | Agent desktop home ("My day") | Medium | Phase 5–6 (leads, tasks, viewings exist) | Deliver during Phase 5. Until then, agents land on the Property register. | 0.5 UX day | UX | **Scheduled** — Phase 5 |
| MD-4a | Technician job list | Low | Phase 8 (maintenance) | Deliver at the start of Phase 8 | 0.5 UX day | UX | **Scheduled** — Phase 8 |
| MD-4b | Landlord portal home | Medium | Phase 7 (landlord portal) | Deliver at the start of Phase 7 together with portal sign-in screens | 0.5 UX day | UX | **Scheduled** — Phase 7 |
| MD-9 | **New:** media gallery and floor-plan manager wireframe | Medium | **Phase 4** (gallery and floor plans are in scope) | Not listed in the audit, but found during readiness review: no screen specifies upload, ordering, cover selection and floor-plan handling. Deliver **during Phase 4**, before the web UI milestone. | 0.5 UX day | UX | **Scheduled** — Phase 4, before UI milestone |
| MD-10 | **New:** map / location search screen | Low | **Phase 4** (location management) | Deliver during Phase 4 with MD-9 | 0.25 UX day | UX | **Scheduled** — Phase 4, before UI milestone |

---

## 5. Other audit findings

| ID | Description | Severity | Recommended resolution | Impacted phase | Effort | Owner | Status |
|---|---|---|---|---|---|---|---|
| IS-3 | `statement_lines` not frozen after the statement is issued | Medium | Trigger blocking insert/delete/update of lines whose statement is `issued` or `void` | Phase 9 | 0.25 day | ENG | Scheduled — Phase 9 |
| IS-4 | Status transitions enforced only by the application | Low | Application state machines with tests per module; add DB transition checks only for money and legal states (lease activation, payment status) | Phases 4–9 | Per module | ENG | Scheduled — each module (Phase 4: listings) |
| IS-5 | Company sign-up path not specified | High | Phase 4: platform-staff command-line provisioning (`estatepro_platform` role, audited) for pilot companies. Phase 14: public self-service sign-up through a platform service. | Phase 4 (tool), Phase 14 (self-service) | 0.5 day (Phase 4) | ENG | Scheduled — Phase 4 milestone 1 |
| IS-6 | Support access not enforced in the database | Medium | Platform tooling reads company data only through a function that requires an approved, unexpired `support_access_grants` row and writes the grant id to `audit_logs` | Phase 15 | 1 day | ENG | Scheduled — Phase 15 |
| IS-7 | Field-encryption key management undesigned | High | Envelope encryption with a managed KMS; one data key per company stored wrapped (new table `company_data_keys`); rotation procedure | Phase 5 (first sensitive fields: contacts, bank details, IDs) | 1.5 days | ENG | Scheduled — Phase 5 milestone 1 |
| IS-9 | Portal sign-in method undecided | Medium | Resolved by ADR-001: portal users sign in through the same IdP (email + passkey/password with MFA available; email one-time code allowed for tenants) | Phase 7 | — | PO | Decided — ADR-001 |
| IS-10 | UI string localisation workflow undefined | Medium | ICU message catalogues per locale in the web app, string keys by feature, Arabic copy reviewed by a native speaker before Qatar launch | Phase 4 (framework), before Qatar pilot (Arabic copy) | 0.5 day framework | ENG, PO (translation) | Scheduled — Phase 4 UI milestone |
| IS-11 | Test coverage gaps in Phase 2 objects | Medium | Each phase adds database tests for every table it starts using, plus a catalogue test asserting RLS on every `company_id` table | Every phase | Ongoing | ENG | Scheduled — Phase 4 adds the catalogue test and property/listing/media tests |
| R-5 | `deals.stage_class` not re-synced when `deal_type` changes | Low | Extend trigger to `UPDATE OF stage_id, deal_type` | Phase 6 | 0.1 day | ENG | Scheduled — Phase 6 |
| MD-5 | No OpenAPI contract | High | Phase 4 generates OpenAPI 3.1 from the API code and commits it; contract tests check responses against it | Phase 4 | Included in Phase 4 | ENG | Scheduled — Phase 4 milestone 1 |
| MD-6 | Built-in reminder rules not seeded | Medium | Seed system automation rules with the Phase 12 engine | Phase 12 | 0.5 day | ENG | Scheduled — Phase 12 |
| MD-7 | Lease templates, legal rule values, tax codes, holidays, FX empty | High (for Phases 7/9) | Legal and tax review per market; data entered with `source_reference`; FX rate source chosen | Before Phase 7 (legal), Phase 9 (tax, FX) | External | LEG, PO | Open — PO to appoint advisers |
| MD-8 | Plan prices, entitlements and limits empty | Medium | Define in Phase 14; Phase 4 reads feature access through one entitlement service so gating can be added without refactoring | Phase 14 | — | PO | Scheduled — Phase 14 |
| V-3 | Data residency per market unconfirmed | High (for production) | Legal confirmation for Ghana, Qatar and UK before choosing production regions | Before first production deployment | External | LEG, PO | Open |
| V-4/V-5 | Wireframes and permission matrix not validated with users | Medium | Usability sessions on Phase 4 screens; permission workshop with pilot agencies | Phase 4 UI milestone, Phase 5 | 2 days facilitation | PO, UX | Scheduled |

---

## 6. Summary

| Status | Count |
|---|---|
| Decided | 6 (C1, C2, C3, C4, P1–P3 as one item, IS-9) |
| Scheduled | 25 |
| Open | 3 (IdP vendor selection, legal/tax advisers MD-7, data residency V-3) |
| Resolved | 0 |
| Accepted | 0 |

**Critical findings: none open for Phase 4.** High findings A1–A3 block the start of Phase 7 rent features; IS-7 blocks Phase 5 sensitive fields; MD-7 and V-3 block production use in a market, not development.

## 7. GitHub issue tracking

Each tracked item has a GitHub issue in `jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT`, assigned to the repository owner as accountable person; the resolution owner (role) is stated in each issue.

| Issue | Item |
|---|---|
| #1 | A1 — freeze posted rent charges |
| #2 | A2 — payment amount below allocations |
| #3 | A3 — reverse allocations before void/bounce/refund |
| #4 | A4 — retention purge of document versions |
| #5 | P1–P3 — landlord visibility of offers, deal progress, viewing feedback |
| #6 | C1 — select the identity provider vendor |
| #7 | MD-9, MD-10 — gallery/floor-plan manager and map search wireframes (Phase 4) |
| #8 | MD-2, MD-3 — Admin dashboard layout and Agent desktop home (Phase 5) |
| #9 | MD-4b — Landlord portal home (Phase 7) |
| #10 | MD-4a — Technician job list (Phase 8) |
| #11 | MD-1a, MD-1b — Platform Owner and Super Admin consoles (before Phase 14) |

Other scheduled items (IS-3 to IS-11, R-5, MD-5 to MD-8, C1-F, V-3, V-4/V-5) are tracked in this register and reviewed at each phase close-out; issues are opened for them when their phase begins.
