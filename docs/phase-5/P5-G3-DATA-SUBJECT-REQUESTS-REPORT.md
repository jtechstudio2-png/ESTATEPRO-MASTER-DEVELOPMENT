# Phase 5 · Milestone report: G3 data-subject request register

| | |
|---|---|
| Date | 6 November 2026 |
| Branch | `phase-5/preparation`, commits `c965aa0`, `8bf5cab`; CI run 87 green |
| Approvals | E5–E6 decisions E56-D1 to E56-D7 approved before work started |
| Scope | Gap G3 of the wireframe verification (#8): a register of access and erasure requests with lifecycle, status, assignment, due dates, audit trail and evidence. Merges are blocked while an erasure request is open (C-4). The register appears on the admin dashboard (D-A) and the contact record (C-2). Erasure uses the E6 service; access reports use the C4 export path. Rectification and objection requests are not in scope |
| Result | **G3 complete.** Results in §3; CI run 87 green (§10) |

## 1. Deliverables

### 1.1 Database (migration 0027)

| Change | Purpose |
|---|---|
| `data_subject_requests` | Reference (DSR-…), contact, type (access, erasure), status, channel, date received, due date, extended due date with reason, assignee, identity verification (method, who, when), outcome note, access report, erasure ledger entry, closed by and when |
| Lifecycle in the database | received → verifying → in_progress → completed; refused or withdrawn from any open status. Work starts only after identity is verified. A refusal or withdrawal needs a note. An erasure request completes only through the erasure itself. Closed requests are final; the type, contact and receipt date never change; a due date is extended once; requests are never deleted |
| `data_subject_request_events` | The request's own history (created, status changed, assigned, identity verified, due date extended, evidence added, access report produced, erasure carried out), append-only |
| `data_subject_request_evidence` | Evidence entries (the request, identity proof seen, correspondence, our response), append-only; a correction is a new entry |
| Permissions | `privacy.view` and `privacy.manage` (company owner, office administrator); `privacy.fulfil`, sensitive (company owner only) |
| Merge register | Requests follow a merged contact; `app.contact_open_erasure_requests` reports open erasure requests for the merge check |
| References | A `privacy_request` sequence (DSR) for new and existing companies |

### 1.2 API

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /api/v1/privacy-requests` | privacy.view | Views: open (default, soonest due first), overdue, closed, all. Filters: type, status, contact, assigned to me or nobody. Cursor paging |
| `GET /api/v1/privacy-requests/{id}` | privacy.view | Request with evidence, history, allowed next statuses and erasure blockers |
| `POST /api/v1/privacy-requests` | privacy.manage | Logs a request for a contact; due 30 days after receipt; the summary is the first evidence entry. Refused for an erased person, an organisation (erasure), or a merged-away record |
| `POST …/{id}/assign`, `/verify-identity`, `/status`, `/extend` | privacy.manage | If-Match versioned. An extension is at most 60 days beyond the original due date, once, with a reason |
| `POST …/{id}/evidence` | privacy.manage | Append-only; also after closing |
| `POST …/{id}/access-report` | privacy.fulfil + second factor within the reveal window | A JSON report of everything held about the person, including protected values, stored as a 24-hour export only its maker can download. `no-store`; audited with the protected fields included, never the values |
| `POST …/{id}/erase` | privacy.fulfil + second factor within the reveal window | Body `confirm: "ERASE"`. Carries out the E6 erasure and completes the request in one transaction; the erasure ledger entry is written before it commits |
| Merge preview and merge | (unchanged) | New blocker `erasure_request` naming the open request |
| Admin dashboard | user.manage; figures need privacy.view | Open and overdue request counts; "requests past their due date" in Needs attention |

### 1.3 Web

| Screen | Wireframe |
|---|---|
| Privacy requests register: Open, Overdue, Closed and All views; type and "assigned to me" filters; overdue stated in words ("5 days overdue") | D-A "Erasure / access requests" |
| Request page: details, identity, due date and extension, evidence, history; actions verify identity, move on, assign, extend, add evidence; fulfilment: produce and download the access report, or carry out the erasure after typing ERASE, with the blockers explained | — |
| Log a request: person (search or from the contact record), type, how it arrived, date received, assignee, summary | C-2 |
| Contact record: "Privacy requests" panel with the person's requests and "Log a privacy request" | C-2 |
| Merge page: the open erasure request is named as the blocker | C-4 |
| Admin dashboard: open and overdue counts link to the register | D-A |
| Navigation: "Privacy requests" for members with privacy.view | SH-1 |

## 2. Requirement checklist

| Requirement | How it is met | Evidence |
|---|---|---|
| Access requests | Logged, tracked, and fulfilled with a complete access report | API and browser tests |
| Erasure requests | Logged, tracked, and fulfilled by the E6 erasure | API and browser tests |
| Request lifecycle management | Allowed moves enforced in the database and the API; identity before work; closed requests final | SQL suite 10; API tests |
| Status tracking | Register views; status, days left or overdue on every row | API and browser tests |
| Assignment | Assignee must hold privacy.manage; "assigned to me" view | API tests |
| Due dates | 30 days after receipt; one extension of up to 60 days, with the reason | SQL and API tests |
| Audit trail | The request's own append-only history, and the company audit log for every action | SQL and API tests |
| Request evidence | Append-only evidence entries; identity notes and the first summary recorded as evidence | SQL and API tests |
| Merge blocking | Merge preview and merge refused while an erasure request is open | API and browser tests |
| Admin dashboard integration | Open and overdue counts, Needs attention item, links | API and browser tests |
| Contact record integration | Requests panel and "Log a privacy request" | Browser test |
| Tenant isolation | Row-level security on all three tables; other companies see nothing and cannot log for another company's contact | SQL and API tests |
| Encryption controls | Protected values leave the database only inside the access report, produced under privacy.fulfil with a fresh second factor; the report file is stored like an export and expires in 24 hours | API tests |
| Reveal controls | The access report uses the reveal window and is audited like a reveal, without values | API tests |
| Accessibility | Register, request page, log form and dialogs in the axe sweep, English and Arabic, desktop and 320 px | Browser tests |
| Localisation validation | New `privacy` messages in English and Arabic; message check | Message check |
| CI verification | All required jobs green on the final commit | CI run 87 |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `database/tests/10_data_subject_requests_g3.sql` (lifecycle, identity before work, one extension, closed requests final, append-only history and evidence, merge register, isolation, permissions) | 31 assertions | ✅ |
| `api/test/privacy-requests.e2e.test.ts` (logging, validation, lifecycle, views and paging, access report with download and audit, erasure with merge blocking, blocked erasure and refusal, dashboard, permissions and isolation) | 9 | ✅ |
| Full API suite (`test:ci`) | 465 in 37 files | ✅ |
| `web/e2e/privacy.spec.ts` (register and dashboard link, access request to report, erasure request from the contact record with merge blocked, agent without access) | 4 | ✅ |
| Full end-to-end suite (incl. sweep with the register, request page and log form in English and Arabic, desktop and 320 px) | 89 | ✅ |
| Web unit tests (navigation, run-time message keys) | 75 | ✅ |
| Lint, typecheck, message check (2,507 keys in both languages), OpenAPI and web types regenerated | — | ✅ |

API coverage: 95.91 % statements, 90.43 % branches, 98.36 % functions, 98.19 % lines (thresholds 95/90 met). Web coverage: 98.14 % statements, 91.41 % branches.

### 3.1 Defects found and fixed before the milestone closed

| Defect | Found by | Fix |
|---|---|---|
| The browser-test API had no erasure ledger, so erasure would have been refused there | Browser test review | Ledger bucket configured for the browser-test API |
| Two earlier tests (C4 API and C5 browser) expected the request count to be "not available" | Full suites | Updated: the count is real now and links to the register |

## 4. Security validation

| Check | Result |
|---|---|
| Agents, sales managers and accountants cannot see the register or log requests | ✅ API and browser tests |
| Office administrators manage requests but cannot erase or produce access reports | ✅ API test |
| Erasing or producing a report needs a second factor within the reveal window | ✅ API test |
| Only the member who produced an access report can download it | ✅ API test |
| No protected value in audit rows | ✅ API test |
| Another company's requests are invisible; its contacts cannot be used | ✅ SQL and API tests |
| History and evidence cannot be changed or deleted, even by the runtime role | ✅ SQL suite 10 |

## 5. Encryption impact

No new encrypted columns. The access report decrypts the person's protected values into the report file only. Production is under privacy.fulfil with a fresh second factor; the file follows the export rules (24-hour expiry, maker-only download, every download audited).

## 6. Audit impact

New audit actions: `privacy.request_created`, `privacy.request_assigned`, `privacy.identity_verified`, `privacy.request_status_changed`, `privacy.request_closed`, `privacy.request_extended`, `privacy.evidence_added`, `privacy.access_report_generated`. An erasure through the register is recorded as `contact.erased` with the member as actor and the request reference.

## 7. Performance results

Playwright performance spec (budget: ready and LCP 4,000 ms, script 300 KB):

| Screen | Ready | LCP | Script |
|---|---|---|---|
| Privacy requests register (all views) | 254 ms | 80 ms | 229 KB ✅ |
| Privacy request page | 361 ms | 276 ms | 239 KB ✅ |
| Contact record (C-2), with the new panel | 365 ms | 336 ms | 260 KB ✅ |
| Admin dashboard (D-A), with the new counts | 368 ms | 312 ms | 225 KB ✅ |

The register's open view uses a partial index on open requests by due date; the dashboard adds one count query over open requests.

## 8. Decisions taken in G3 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| G3-D1 | Requests are about a contact in the system. A person we hold nothing about is answered outside the register | Every request has a subject whose data can be reported or erased |
| G3-D2 | Office administrators view and manage requests; only the company owner (privacy.fulfil, step-up) erases or produces access reports | Fulfilment removes or discloses protected data (ADR-007 E-Q5: office administrators do not reveal) |
| G3-D3 | Due 30 days after receipt; one extension of up to 60 days, with the reason | One month plus a further two months, the common rule (UK GDPR Art. 12(3)); Ghana and Qatar periods to be confirmed by the legal review (#20) |
| G3-D4 | Identity must be verified before work starts; how it was verified is recorded once and cannot be changed | Prevents disclosing or erasing data for the wrong person |
| G3-D5 | The access report is a JSON file including protected values, stored as a 24-hour export only its maker can download | Machine-readable, complete; follows the export controls |
| G3-D6 | Evidence is text (what was received, seen or sent), append-only; file attachments come with the documents module | No new upload path in this milestone |
| G3-D7 | The register is kept after an erasure (the contact shows as "Erased contact"); its evidence is not redacted | It is the record that the request was handled (accountability). Staff are told not to copy ID or bank numbers into it |
| G3-D8 | While an erasure request is open, the contact cannot be merged in either direction | Wireframe C-4 |

## 9. Risks and open items

| Item | Status |
|---|---|
| Response periods per market | Legal review (#20); the 30-day rule is in one place in the code |
| Rectification and objection requests | Not in scope; rectification is an edit of the contact, objection is a consent change (C-6) |
| Evidence files | With the documents module |
| Arabic native-speaker review (#25) | Open, pre-launch; the new Arabic strings are included |
| Manual screen-reader pass (#24) | Open, pre-launch |

## 10. GitHub references

| Reference | Link |
|---|---|
| E5–E6 report | `docs/phase-5/P5-E5-E6-ROTATION-ERASURE-REPORT.md` |
| Wireframes (#8), gap G3 | `docs/phase-5/P5-CRM-WIREFRAME-VERIFICATION.md` §4 |
| Branch | `phase-5/preparation` |
| Commits | `c965aa0` (register), `8bf5cab` (dashboard test, report figures) |
| CI run 87 (green, on `8bf5cab`; run 86 was cancelled by the later push) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/42310103177 |

## Approval

Product owner, 7 November 2026: **G3-D1 to G3-D8 approved; the data-subject request register is approved.** Issues #24 (manual screen-reader pass) and #25 (Arabic native-speaker review) remain pre-launch requirements. Issue #20 (legal review) remains required before production deployment in Ghana and Qatar, including the response periods of G3-D3. Proceed to the next approved milestone with the same standards for tenant isolation, encryption controls, audit integrity, accessibility validation, localisation validation and CI verification.
