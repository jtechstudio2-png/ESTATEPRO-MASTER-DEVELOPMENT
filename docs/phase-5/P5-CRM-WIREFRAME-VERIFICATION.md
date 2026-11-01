# Phase 5 · CRM Wireframe Verification Report (issue #8)

| | |
|---|---|
| Status | **Approved** (product owner, 1 November 2026), together with the [wireframes](./P5-CRM-WIREFRAMES.md) |
| Scope | Checks the Phase 5 CRM wireframes against the approved requirements, the Phase 1–3 specifications, the Phase 2 schema and the permission model. Lists the API to build, the schema gaps found and the decisions needed before implementation |
| Result | **Ready for approval**, subject to seven decisions (§5). No requirement is uncovered; five schema gaps need small migrations (§4); the whole CRM API is still to be built (§3) |

## 1. Requirements coverage

### 1.1 Approved requirement list (Phase 5 preparation brief)

| Requirement | Screens | Notes |
|---|---|---|
| CRM-focused workflows | D-C, D-M, L-1, F-2 | Each dashboard answers one operational question (Phase 3 06 §1) |
| Contact management | C-1 to C-6 | One contact per person or organisation; roles are relationships |
| Buyer management | B-1, B-2 | Requirements, matches, financing, next follow-up |
| Seller management | SE-1 | Listings, valuation leads, identity status (#18) |
| Landlord management | LL-1 | Ownerships, linked-visibility preview (#12, Phase 5 landlord side) |
| Lead management | L-1 to L-4 | Inbox, assignment, status, score breakdown, response time |
| Activity timeline | A-1, A-2 | Across contact, leads and later deals |
| Follow-up scheduling | F-1, F-2, D-M | Office timezone, reminders, team view |
| CRM dashboard metrics | D-C, D-A | Every number links to its list; scoped counts only |
| Role-based visibility | Wireframes §2 | Derived from migration 0014 grants |
| Mobile and tablet | §8, §9 (XM-1 to XM-4, TM-1, TM-2) | Agent-first mobile; two-pane tablet |
| Accessibility and RTL | §10, §11 | WCAG 2.2 AA including the 2.2-only criteria; Arabic names and mixed text |
| Admin dashboard layout (MD-2) | D-A | Phase 3 06 §9 panels arranged, with CRM, consent and audit panels added |
| Agent desktop home (MD-3) | D-M | Phase 3 06 §10 drawn for desktop |

### 1.2 Phase 1 CRM requirements

| ID | Requirement | Pri | Screens | Phase 5 coverage |
|---|---|---|---|---|
| CRM-01 | Contacts with roles | M | C-1, C-2, C-3 | Full |
| CRM-02 | Duplicate detection; merge with history | M | C-3, C-4, D-A | Full (phone, email, ID-number hash) |
| CRM-03 | Requirements and matching | M | B-1, B-2 | Full; matching rule needs D4 |
| CRM-04 | Activity timeline | M | A-1, A-2 | Full; viewings and offers rows in Phase 6 |
| CRM-05 | Tasks and follow-ups with reminder | M | F-1, F-2, D-M | Full; in-app reminders only (other channels Phase 12) |
| CRM-06 | Leads: source, campaign, listing, owner, status, response time | M | L-1 to L-4, D-C | Full; SLA setting is gap G1 |
| CRM-07 | Transparent lead scoring | S | L-2 | Display of breakdown; rule editor is D7 |
| CRM-08 | Consent per channel; lawful basis | M | C-3, C-6 | Full |
| CRM-09 | KYC/AML checks with reviewer | M | C-5, SE-1 | Records and sign-off; provider integration out of scope |
| CRM-10 | Email integration | S | — | Phase 12 (logging only in Phase 5) |

## 2. Permission and scope verification

Every screen's role column was checked against `role_permissions` in migration 0014.

| Check | Result |
|---|---|
| Every action names its permission | ✅ |
| Agents limited to `own` scope for contacts, leads, KYC | ✅; ambiguity on "own" for contacts reached via a lead → **D1** |
| `contact.view_sensitive` only Owner and Accountant | ✅ C-5 reveal limited to them, with step-up |
| Office admin lacks `contact.view_sensitive` | ✅ Not shown Reveal (consistent with the seed; confirm intended → note in D-A) |
| Sensitive permissions (`contact.export`, `lead.export`, `contact.view_sensitive`) audited | ✅ Shown on D-A "Privacy and consent" |
| Counts never leak out-of-scope records | ✅ Rule stated in §2.2 and per dashboard |
| Duplicate check does not disclose out-of-scope contacts | ✅ C-3 shows a neutral message to agents |
| Maintenance staff have `contact.view` (assigned) but no CRM screens | ✅ Phase 8 work-order context only |
| Landlord portal role has no `contact.view` | ✅ LL-1 preview is staff-side; portal is Phase 7 |

## 3. API to build (planned endpoints)

No CRM endpoint exists. Conventions follow ADR-003 (problem errors, `If-Match`, keyset cursors, `X-Company-Id`).

| # | Endpoint | Used by | Permission |
|---|---|---|---|
| CA-1 | `GET/POST /api/v1/contacts`, `GET/PATCH /api/v1/contacts/{id}` | C-1, C-2, C-3 | `contact.view/create/update` |
| CA-2 | `POST /api/v1/contacts/duplicate-check` | C-3, L-3 | `contact.create` |
| CA-3 | `POST /api/v1/contacts/{id}/merge` | C-4 | `contact.merge` |
| CA-4 | `POST /api/v1/contacts/{id}/archive`, `/restore` | C-2 | `contact.archive` |
| CA-5 | `GET/POST /api/v1/contacts/{id}/relationships` | C-2, C-3 | `contact.update` |
| CA-6 | `GET/POST/PATCH /api/v1/contacts/{id}/methods` | C-2 | `contact.update` |
| CA-7 | `GET/POST /api/v1/contacts/{id}/consents` | C-6 | `contact.view/update` |
| CA-8 | `GET/POST/PATCH /api/v1/contacts/{id}/requirements`, `GET …/requirements/{id}/matches` | B-1, B-2 | `contact.update`, `listing.view` |
| CA-9 | `GET/POST /api/v1/contacts/{id}/identity-documents`, `…/kyc-checks`, `POST …/kyc-checks/{id}/approve` | C-5, SE-1 | `kyc.view/manage/approve` |
| CA-10 | `POST /api/v1/contacts/{id}/sensitive/{field}/reveal` | C-5 | `contact.view_sensitive` + step-up (ADR-007) |
| CA-11 | `GET/POST /api/v1/leads`, `GET/PATCH /api/v1/leads/{id}`, `POST …/assign`, `POST …/status` | L-1 to L-4 | `lead.*` |
| CA-12 | `GET/POST /api/v1/activities`, `GET /api/v1/{entity}/{id}/activities` | A-1, A-2 | entity view permission |
| CA-13 | `GET/POST/PATCH /api/v1/tasks` | F-1, F-2, D-M | owner of task, or manager scope (D6) |
| CA-14 | `GET /api/v1/dashboards/crm`, `/admin`, `/my-day` | D-C, D-A, D-M | dashboard role |
| CA-15 | `GET /api/v1/contacts/{id}/portal-visibility-preview` | LL-1 | `contact.view` + `property.view` (#12) |
| CA-16 | `POST /api/v1/contacts/exports`, `/api/v1/leads/exports` | C-1, L-1 | `contact.export`, `lead.export` |

## 4. Schema gaps found

| # | Gap | Needed by | Proposed fix |
|---|---|---|---|
| G1 | No setting for the lead response SLA | D-A, D-C, L-1 | `company_settings` key `crm.lead_response_minutes` (no default; unset shows "SLA not set") |
| G2 | No record of "not suitable" listing for a requirement | B-2 | Table `requirement_exclusions (requirement_id, listing_id, reason, by, at)` |
| G3 | No data-subject request register (access, erasure, rectification) | D-A, C-2 | Table `data_subject_requests` with type, status, due date, handler; erasure uses anonymisation (ADR-007 §8) |
| G4 | `tasks` link to one entity only | F-1 | Keep; reach the contact through the lead. Revisit if follow-ups must show under both |
| G5 | Arabic search normalisation (alef, ya, ta marbuta, diacritics) not in `search_vector` | C-1, L-3 | Normalising function used in the generated column and query (migration) |
| G6 | No stable order for same-time activities | A-1 | Covered by #15 (deterministic history ordering) |

None of these changes an existing business rule. Each is a small additive migration in Phase 5.

## 5. Decisions needed before implementation

| # | Decision | Options | Approved decision |
|---|---|---|---|
| D1 | What "own" means for an agent's contacts | (a) only `owner_membership_id`; (b) also contacts of leads and tasks assigned to them, read-only | **(b) Yes**: an agent sees, read-only, the contacts of leads and tasks assigned to them |
| D2 | Buyers, Sellers, Landlords, Tenants: separate sections or views | (a) saved views of one register; (b) separate registers | **(a)**: filtered views of the single Contacts entity |
| D3 | Lead response SLA | Company setting with no default (G1) | **Company-defined response targets**; dashboards show "not set" until configured |
| D4 | Requirement matching rule | Which fields must match (type, currency, price range, bedrooms, area, features) and how strict | **Proposed rules approved**: must match type, currency, price within range, bedrooms ≥ min, inside area; features rank matches |
| D5 | Editing logged activities | (a) never; (b) author within a window; (c) always with history | **(b)** author-only edits within 24 h, history retained, then archive-only |
| D6 | Who may assign follow-ups to others | (a) anyone in scope; (b) managers (`lead.assign`) | **(b)** manager-only follow-up assignment |
| D7 | Lead scoring rules (CRM-07, Should) | (a) Phase 5 editor; (b) show breakdown only when rules exist; editor later | **(b)** no lead-scoring rule editor in Phase 5 |

## 6. Risks found

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| WR-1 | Free-text fields (notes, lead messages, activity bodies) will contain personal and sometimes sensitive data that field encryption does not cover | Medium | ADR-007 risk R-3: guidance in the UI ("Do not record ID or bank numbers here"), redaction tool (as for notes), data-subject erasure redacts these fields |
| WR-2 | Agents copying contact data to personal devices via Call/Message deep links | Low | Out of app control; covered by company policy; no bulk export for agents |
| WR-3 | Dashboard counts as an inference channel across offices | Low | Server computes counts in the viewer's scope only (tested) |
| WR-4 | Duplicate check as an enumeration oracle (does this phone exist?) | Medium | Rate-limited per user; neutral message out of scope; audited |
| WR-5 | Without G1, "past SLA" cannot be shown | Low | D3 |

Risk review (product owner, 1 November 2026): **WR-1 accepted** for Phase 5 and tracked for future sensitive-data detection work; **WR-4 accepted**.

## 7. Verification method

- Every screen traced to a requirement (§1) and every action to a permission in migration 0014 (§2).
- Every data source checked against the Phase 2 tables and indexes named in the wireframes.
- Phase boundaries checked against the roadmap: Phase 6 and 7 items are marked and hidden, not drawn as empty.
- Accessibility and RTL rules checked against ADR-002, Phase 3 04 and the Phase 4 harness.

## 8. Exit criteria for #8

1. Wireframes approved (with any changes recorded).
2. Decisions D1–D7 recorded.
3. Gaps G1–G5 accepted into the Phase 5 plan.
4. Risks WR-1 and WR-4 reviewed.

Then #8 can be closed and CRM UI implementation can start, subject to the encryption plan (#17) for any contact data storage.
