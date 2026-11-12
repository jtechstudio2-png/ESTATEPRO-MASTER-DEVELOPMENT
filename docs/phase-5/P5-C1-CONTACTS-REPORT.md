# Phase 5 · Milestone report: C1 Contacts API

| | |
|---|---|
| Date | 2 November 2026 |
| Branch | `phase-5/preparation`, commit `497c46e` |
| Governance gate | Branch protection on `main` verified active before work started (GitHub reports `main` as `protected: true`) |
| Scope | Contact list, contact record, create and edit, duplicate detection, merge, archive, consent management, protected-field masking, audit coverage (wireframes C-1 to C-6) |
| Result | **C1 complete.** No automatic merges; protected data encrypted (ADR-007); visibility by permission and scope; 366 API tests and 6 SQL test suites green locally and in CI run 66 |

## 1. Deliverables

### 1.1 Database (migration 0022)

| Change | Purpose |
|---|---|
| `contacts.archived_reason`, `archived_by`; checks that a reason needs an archive and a merged contact is always archived | Archive (C-2) |
| `app.search_normalise()` and a regenerated `contacts.search_vector`; trigram index on the normalised native-script name; register sort index | Arabic-aware search (gap G5) |
| `contact_reference_columns`: every column that references a contact, classified `repoint`, `history`, `block` or `self` | Merge integrity (C-4) |
| `app.merge_contact_references(keep, merge)` | Moves every reference in one statement set, resolving unique conflicts (roles, methods, links, viewing attendees, deal parties, activity and document links); row-level security applies |
| `app.contact_merge_blockers(contact)`, `app.contact_reference_counts(contact)` | Merge preview: what blocks a merge and how many rows move |

### 1.2 API (`apps/api/src/contacts/`)

| Endpoint | Permission | Wireframe |
|---|---|---|
| `GET /api/v1/contacts` (filters: relationship, contactType, office, owner, source, archived; search; keyset paging) | `contact.view` | C-1, B-1, SE-1, LL-1 views |
| `POST /api/v1/contacts` (duplicate check; `confirmNotDuplicate`; idempotency key) | `contact.create` | C-3 |
| `POST /api/v1/contacts/duplicate-check` (rate-limited, audited) | `contact.create` | C-3, L-3 |
| `GET /api/v1/contacts/{id}` | `contact.view` | C-2 |
| `PATCH /api/v1/contacts/{id}` (`If-Match`) | `contact.update` | C-3 |
| `POST /api/v1/contacts/{id}/archive`, `/restore` (`If-Match`) | `contact.archive` | C-2 |
| `POST /…/methods`, `PATCH /…/methods/{methodId}`, `DELETE /…/methods/{methodId}` | `contact.update` | C-2 |
| `POST /…/relationships`, `POST /…/relationships/{id}/end` | `contact.update` | C-2 |
| `GET /…/consents`, `POST /…/consents` (append-only) | `contact.view` / `contact.update` | C-6 |
| `GET /…/merge-preview?mergeContactId=`, `POST /…/merge` (`If-Match`) | `contact.merge` | C-4 |
| Reveal endpoints from E4 (`/sensitive/{field}/reveal`, identity documents) | `contact.view_sensitive` + step-up | C-5 |

Supporting code: `contact-access.ts` (record scope, SQL and in-memory, including decision D1), `identifiers.ts` (E.164 phone normalisation with the office country, email normalisation, list masking, Arabic search folding), `duplicates.service.ts`, `merge.service.ts`.

## 2. Requirement checklist

| Requirement | How it is met | Evidence |
|---|---|---|
| No automatic merges | Duplicate detection only reports candidates (409 `possible-duplicates`); creating after confirmation records the decision; a merge is a separate request by a member with `contact.merge` on both contacts, with explicit field choices and both versions | Tests "refuses a likely duplicate … never merges automatically", merge tests |
| Encrypted sensitive data | Date of birth, individual tax and registration numbers are sealed per row through `SensitiveDataService`; merges re-encrypt chosen values for the kept row; organisations keep public numbers in plain text (E-Q1) | Ciphertext and reveal tests; merge reveal tests |
| Permission-based field visibility | Protected metadata (`recorded`, `last4`) only with `kyc.view` on the contact; values only through reveal; access flags (`canEdit`, `canArchive`, `canMerge`, `canReveal`) per contact; list shows masked phone only | Visibility test across owner, accountant, sales manager, agent (own and D1), technician, other company |
| Full test coverage | Contacts module: 99.5 % lines, 97.3 % statements, 91.2 % branches; whole API 99.3 % lines, 92.3 % branches (thresholds 95/90 met) | §3 |
| Migration tests | SQL suite `05_contacts_c1.sql` (21 assertions); catalogue test that every foreign key to `contacts` is classified for merging | §3 |
| Duplicate detection tests | Phone in any format, email on any method, tax number by keyed hash in any format, edits, out-of-scope matches without detail, merged and anonymised contacts excluded, audit without values, rate limit | §3 |
| Merge integrity tests | References moved per table, conflicts resolved, withdrawals kept, protected values re-encrypted, financial blockers, type mismatch, self, repeat, stale versions, permissions, office scope, cross-company | §3 |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `contacts.e2e.test.ts` | 32 | ✅ |
| `contact-identifiers.test.ts` (unit) | 7 | ✅ |
| `database-catalogue.test.ts` (+1: merge register complete) | 7 | ✅ |
| `contacts.performance.test.ts` (nightly and release workflow) | 1 | ✅ p95 516 ms |
| SQL `database/tests/05_contacts_c1.sql` | 21 assertions | ✅ |
| All SQL suites (22 migrations, 6 files) | — | ✅ |
| Full API suite (`test:ci`, local) | 366 in 27 files | ✅ exit 0 |
| Lint, typecheck, OpenAPI regenerated | — | ✅ |
| CI run 66 on `497c46e` (all six required jobs) | — | ✅ [run 66](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/41403748844) |

Coverage (whole API): 97.09 % statements, 92.25 % branches, 99.02 % functions, 99.32 % lines.

### 3.1 Defects found by the tests and fixed before commit

| Defect | Found by | Fix |
|---|---|---|
| Duplicate query: raw SQL `OR` conditions were not bracketed, so they escaped the merged and anonymised filters | Duplicate test ("ignores merged and anonymised contacts") | Bracketed the whole match condition; test now also covers a merged contact |
| Arabic folding mapped ta marbuta to ya (character lists of different lengths in `translate`) | SQL test ("ta marbuta folds to ha") | Corrected mapping; unit test checks the API folding matches |
| Duplicate check and search too slow at 100,000 contacts (p95 2,181 ms; duplicate check 4,957 ms): `OR` conditions with per-row subqueries forced full scans | Performance test | Candidate ids are now gathered from indexed lookups (`id in (… union …)`); agent scope (D1) uses uncorrelated id lists; new indexes for name and creation sorts and phone digits (trigram). p95 516 ms |

## 4. Security validation

| Check | Result |
|---|---|
| Record scope: agents see own contacts plus those behind their leads and open tasks, read-only (D1); office scope for managers; company-wide for owner, admin, accountant; maintenance staff see none until Phase 8 work orders | ✅ tested |
| Writes use the narrower scope: agents cannot edit contacts seen through a lead, assign other owners or use other offices | ✅ tested |
| Cross-company: other companies' contacts are 404 everywhere, including merge | ✅ tested; merge function also enforces it in SQL |
| Duplicate check does not disclose out-of-scope contacts (WR-4): no id, name or owner; rate-limited (30 per member per minute, configurable); audited without values | ✅ tested |
| Protected values never in responses, list rows, audit entries or merge previews | ✅ tested |
| Unknown request fields are rejected (`contactType` cannot be changed after creation) | ✅ tested |
| Merge never re-attributes ledger entries, receipts, payouts, statements, financial transactions, supplier invoices, leases, management agreements or payout accounts | ✅ blocked and tested |
| Append-only histories (key movements, message deliveries, document versions, maintenance updates, offers) stay on the merged record, reached through `merged_into_contact_id` | ✅ by design; catalogue test keeps the register complete |

## 5. Audit impact

New audit actions, all written in the same transaction as the change and never containing protected values:

| Action | Metadata |
|---|---|
| `contact.created` | reference, roles, names of protected fields set, duplicate confirmation (candidate ids) |
| `contact.updated` | field changes; protected fields shown as `[protected]` |
| `contact.archived` / `contact.restored` | reason |
| `contact.method_added` / `method_updated` / `method_removed` | method id and type; opt-out, verification and primary changes |
| `contact.relationship_added` / `relationship_ended` | role and dates |
| `contact.consent_recorded` | purpose, channel, status, source |
| `contact.duplicate_check` | which keys were checked, number of candidates and of out-of-scope candidates |
| `contact.merged` (kept contact) / `contact.merged_into` (merged contact) | other contact, fields taken from the merged contact, rows moved per table, withdrawals kept |

Outbox events: `contact.created`, `contact.updated`, `contact.archived`, `contact.restored`, `contact.merged`.

## 6. Performance impact

`contacts.performance.test.ts`: 100,000 contacts in one company with phone methods and roles, a fifth with Arabic names, and leads for the agent (so the D1 rule is exercised). Register, views, name and phone search, reference lookup, duplicate checks and keyset paging, as owner and as agent.

| Measure | Before optimisation | Final |
|---|---|---|
| Requests (owner and agent) | 70 | 70 |
| Median | 296 ms | **162 ms** |
| p95 (target < 1,000 ms) | 2,181 ms ❌ | **516 ms** ✅ |
| Slowest | 4,957 ms (duplicate check) | 685 ms (reference prefix search, agent) |

New indexes (migration 0022): `contacts (company_id, display_name, id)`, `contacts (company_id, created_at desc, id desc)`, `contacts (company_id, updated_at desc, id desc)`, trigram on the normalised Arabic name and on `contact_methods.normalised`. Write cost: one more GIN index on contact methods; bulk load of 100,000 contacts with methods and roles stays within the test's set-up budget.

The test runs in the nightly and release performance workflow, not in the blocking pipeline (approved stabilisation decision).

## 7. Decisions taken in C1 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| C1-D1 | Merges are refused while the merged contact has financial or contractual records (payout accounts, ledger entries, receipts, payouts, statements, financial transactions, supplier invoices, leases, management agreements) | Those records must never be re-attributed silently; a finance-aware merge belongs to Phases 7–9 |
| C1-D2 | Append-only histories stay on the merged record and are reached through `merged_into_contact_id` | They are evidence and cannot be rewritten |
| C1-D3 | Archiving is refused while the contact has open leads or active portal access | Prevents orphaned work and portal users without a contact |
| C1-D4 | A new contact needs a mobile number or an email address | Approved wireframe C-3 ("Mobile * or Email *") |
| C1-D5 | The contact type cannot change after creation | Person and organisation store identifiers differently (E-Q1) |
| C1-D6 | Maintenance staff have no CRM access to contacts until Phase 8 adds work-order context | Their `assigned` scope has nothing to match yet |
| C1-D7 | Duplicate checks: 30 per member per minute by default | Mitigation for WR-4; configurable |

## 8. Risks and open items

| Item | Status |
|---|---|
| Data-subject requests (gap G3) and erasure workflow | Not in C1; needed with encryption stage E6 |
| Requirements, identity documents and KYC endpoints | C2 |
| Leads, activities and follow-ups | C3 |
| Web screens for contacts | C5 |
| Free-text sensitive data (R-3 / WR-1) | Accepted; tracked in #35 |

## 9. GitHub references

| Reference | Link |
|---|---|
| Wireframes (#8, closed) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/8 |
| Field encryption (#17) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/17 |
| Sensitive-data detection (#35) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/35 |
| Branch | `phase-5/preparation` |
| C1 commit | `497c46e` |
| CI run 66 (green) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/41403748844 |
