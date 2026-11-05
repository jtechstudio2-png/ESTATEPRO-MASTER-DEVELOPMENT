# Phase 5 · Milestone report: C5 CRM web screens

| | |
|---|---|
| Date | 5 November 2026 |
| Branch | `phase-5/preparation`, commit `273c6ba` |
| Approvals | C4 decisions C4-D1 to C4-D8 approved before work started (recorded in the C4 report) |
| Scope | The web screens for C1–C4, built to the approved wireframes (#8): navigation and role start pages (SH-1), admin dashboard (D-A), CRM dashboard (D-C), My day (D-M), contacts (C-1 to C-6), relationship views (B-1, B-2, SE-1, LL-1), leads (L-1 to L-4), activity (A-1, A-2), follow-ups (F-1, F-2), exports and CRM settings. Mobile and tablet layouts (XM-1 to XM-4, TM-1, TM-2) use the same components |
| Result | **C5 complete.** Every screen works against the real API. Encryption, reveal restrictions, tenant isolation, audit and export governance are enforced by the API and shown correctly by the screens; the end-to-end tests check each one. 81 end-to-end tests (26 new CRM tests) and 75 unit tests pass locally and in CI run 75 |

## 1. Deliverables

### 1.1 Screens (`apps/web/src/app/(app)`, `apps/web/src/components`)

| Route | Screen | Wireframe |
|---|---|---|
| `/` | Role start page: agents → My day; owners and administrators → admin dashboard; sales and property managers → CRM dashboard; others → property dashboard | SH-1 |
| `/my-day` | Today's follow-ups and new leads, overdue first; Done, Log outcome, Reschedule; waiting on me; my leads by status; quick actions | D-M, XM-1 |
| `/dashboards/crm` | New leads not yet contacted, follow-ups, leads by status, response time per person (hidden for own-scope members), leads by source, requirements with "no match"; office and period filters | D-C |
| `/dashboards/admin` | Needs attention, users and access, lead flow by office, data quality, privacy and consent, imports and exports, account | D-A |
| `/contacts` (`?view=buyer…`) | Register with Buyer, Seller, Landlord, Tenant, Applicant, Supplier and Other views; search; office, owner, type, source and archived filters; masked phones; identity-check column; export | C-1, SE-1, LL-1 lists |
| `/contacts/new`, `/contacts/{id}/edit` | Contact form with duplicate check, roles, consent at capture, protected details entered but never shown back | C-3 |
| `/contacts/{id}` | Record: Call, Message (opted-out channels disabled), Follow-up, Edit; archive and restore; merge; warnings (archived, merged, anonymised, marketing withdrawn); contact methods, roles, next follow-up, details, recent activity | C-2, XM-2, XM-3, TM-1 |
| `…/activity`, `…/leads`, `…/requirements`, `…/properties`, `…/identity`, `…/consent` | Record tabs; each appears only with its own permission | A-1, L-1, B-2, LL-1, C-5, C-6 |
| `/contacts/{id}/merge?with=` | Side-by-side comparison, keep/merge choice per field, what moves, blockers; type MERGE to confirm | C-4 |
| `/requirements` | Buyers and tenants by requirement: budget, beds, areas, financing, matches | B-1 |
| `/leads`, `/leads/new`, `/leads/{id}` | Inbox tabs (new, mine, unassigned for managers, all open, closed), filters, bulk assign, export; quick capture for an existing or new contact; lead record with status and assignment dialogs, score breakdown, timeline and history | L-1 to L-4, XM-4, TM-2 |
| `/follow-ups` | Mine and Team; open, overdue, today, this week, done, cancelled; Done, Reschedule, Reassign, Cancel; new follow-up | F-1, F-2 |
| `/exports` | The member's exports (all exports for user managers); download for the requester only | CA-16 |
| `/settings/crm` | Lead response target | D3 |

### 1.2 Shared parts

| Part | Purpose |
|---|---|
| `components/shell/navigation.ts` | Dashboards, Contacts (register, four saved views, requirements, exports) and Sales (leads, follow-ups) sections by permission. Maintenance staff and portal users get no CRM screens. The create menu offers Lead, Contact and Follow-up. Queue badges on Leads and Follow-ups; a failed count hides the badge |
| `components/activity/*` | Timeline (A-1, ordered list, grouped by day, "Load older" moves focus), log and edit dialog (A-2), follow-up dialog (F-1) with time-zone quick picks, follow-up list (F-2) |
| `components/contacts/reveal.tsx` | Reveal dialog (reason and details, step-up when needed) and revealed value with a 60-second timer |
| `components/contacts/duplicates.tsx` | Duplicate check as the user leaves the phone or email field; candidates outside the member's scope are not named |
| `components/exports/export-dialog.tsx` | Purpose, what the file will and will not contain, result and download |
| `components/crm/labels.tsx` | Names with their local-script form, phone and reference isolation (`<bdi dir="ltr">`), statuses with icon and text |
| Messages | 15 new namespaces, 2,312 keys in English and Arabic |

## 2. Requirement checklist

| Requirement | How it is met | Evidence |
|---|---|---|
| Tenant isolation | Screens read only through the BFF with the session's company. Another company's record shows "not found", never cached data | `crm-contacts.spec.ts` "another company never sees these contacts"; existing company-switch test |
| Encryption controls | Protected values are typed into the form and never shown back; on edit the form says only whether one is recorded. Lists show masked phones only | C-1 test checks the full number is absent; C-5 test checks only `•••• 4821` until revealed |
| Reveal restrictions | Reveal needs `contact.view_sensitive`, a reason (at least 10 characters) and a second-factor sign-in within the reveal window. Without a recent one, the dialog explains why and offers the step-up sign-in, which returns to the same page. The value is never cached, never in a URL, hides after 60 s or on Hide, and leaves the page with the panel. Phones show "Open on a computer to reveal" | Two C-5 tests: reveal and hide; window lapsed, then step-up, then reveal |
| Audit integrity | Every write goes through the audited API. The screens add nothing unaudited. The landlord preview is generated once per visit (no background refetch), because each generation is audited | API audit suites (C1–C4) unchanged and passing |
| Export governance | Purpose required; the dialog lists what is and is not included; at most 50,000 rows; deleted after 24 hours; download only for the requester; admins see the list but cannot download others' files | CA-16 test; exports list test |
| Performance validation | Every screen loads its data within budget on the production build | §7 |
| CI verification | All six required jobs green in run 75 | §3, §10 |
| Accessibility (WCAG 2.2 AA) | axe on every CRM screen and state in the specs; one `h1`; tables with captions; timeline as an ordered list; status in icon and text; accessible names contain the visible text; focus kept in dialogs | Sweep and CRM specs, 81 tests |
| Right to left and Arabic | Every CRM screen in Arabic at desktop and 320 px, right to left, axe-clean, with no sideways scrolling; names in `dir="auto"`, phones and references isolated | Sweep "every Arabic screen" |
| Mobile and tablet | Tables become cards below 768 px; bottom bar for CRM staff (My day or CRM dashboard, Leads, Contacts, Follow-ups) | Sweep at 320 px |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `e2e/crm-contacts.spec.ts` (C-1 to C-6, B-1, B-2, SE-1, LL-1, CA-16, agent scope, isolation) | 13 | ✅ |
| `e2e/crm-leads.spec.ts` (L-1 to L-4, A-1, A-2, F-1, F-2, agent scope) | 9 | ✅ |
| `e2e/crm-dashboards.spec.ts` (D-M, D-C, D-A, CRM settings) | 4 | ✅ |
| `e2e/shell.spec.ts` (updated for role start pages and the new menu) | 5 | ✅ |
| `e2e/sweep.spec.ts` (21 CRM screens added in English and 18 in Arabic, desktop and 320 px) | 3 | ✅ |
| Full end-to-end suite (`test:e2e:ci`, local) | 81 | ✅ (7.6 min) |
| `e2e/perf.spec.ts` (7 CRM screens added) | 1 | ✅ |
| Unit tests (new: navigation by role, time-zone quick picks and week bounds, consent state, message channels, run-time message keys) | 75 in 17 files | ✅ |
| Lint, typecheck, stylelint, message check, production build | — | ✅ |
| CI run 75 on `273c6ba` (all six required jobs, including the end-to-end suite) | — | ✅ [run 75](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/41973234561) |

Unit coverage (logic layer): 98.14 % statements, 91.41 % branches, 97.87 % functions, 99.4 % lines (thresholds 95/88 met). Screens are covered by the end-to-end suite, as in Phase 4.

### 3.1 Defects found by the tests and fixed before commit

| Defect | Found by | Fix |
|---|---|---|
| A member without a chosen company was sent to the property dashboard instead of their role's start page | Shell test | The start page sends them to the company picker and back |
| The end-to-end API had no field-encryption key, so protected details could not be saved | Seed | The harness starts the API with the local key provider and a fresh key per run (refused in production) |
| Consent evidence was sent as an object; the API takes text of up to 500 characters | C-6 test | Sent as text; field limited to 500 |
| The contact search in lead capture never opened its list | L-3 test | Same uncontrolled pattern as the staff picker |
| Several buttons had accessible names that did not contain their visible text (WCAG 2.5.3) | axe | Context is added as visually hidden text after the visible label |
| Roles came out in API order ("Tenant · Buyer") | Merge test | Always shown in one fixed order |
| Ownership share showed "100.0000 %"; role start dates showed raw ISO | LL-1 test, review | Formatted for the member's locale |

## 4. Security validation

| Check | Result |
|---|---|
| Navigation and actions appear only with permission; hidden, not disabled | ✅ unit and end-to-end |
| Agents see only contacts behind their leads, read only; no export, reveal or assignment | ✅ tested |
| A direct link to a record outside scope or company shows "not found" | ✅ tested |
| Duplicate candidates outside the member's scope are not named ("ask a manager") | ✅ by design; the API returns no name |
| Protected values are never echoed in forms, never in URLs or query caches; revealed values hide again | ✅ tested |
| Reveal needs a recent second factor; the step-up sign-in returns to the same record | ✅ tested |
| Export needs a purpose; download is requester-only; the signed link is used at once and never stored | ✅ tested |
| Writes use If-Match; a 412 shows "someone else changed this record" and reloads | ✅ by design, as in Phase 4 |
| Read-only companies show no write actions | ✅ existing shell test |

## 5. Encryption impact

| Item | Impact |
|---|---|
| New encrypted fields | None |
| Protected values on screens | Masked (last four) unless revealed. A revealed value lives only in the component's state for 60 seconds |
| Entry of protected values | Date of birth, tax and registration numbers, document numbers: typed, sent once, encrypted by the API, never shown back |
| Free text | Help text under notes, messages, evidence and activity fields says not to type identity or bank numbers (R-3, #35) |

## 6. Audit impact

No new audit actions. The screens use the audited C1–C4 endpoints: contact and lead changes, merges, consents, identity documents and checks, reveals (with the stated reason), activities, follow-ups, exports and downloads, and the landlord preview.

## 7. Performance results

`e2e/perf.spec.ts` on the production build: full page load with a cold cache until the screen shows its data. Budgets are 4,000 ms to data, 4,000 ms largest contentful paint and 300 KB of JavaScript.

| Screen | To data | LCP | JavaScript |
|---|---|---|---|
| Admin dashboard (D-A) | 342 ms | 340 ms | 222 KB |
| CRM dashboard (D-C) | 399 ms | 376 ms | 223 KB |
| Contact register (C-1) | 390 ms | 100 ms | 227 KB |
| Contact record (C-2) | 384 ms | 348 ms | 252 KB |
| Lead inbox (L-1) | 658 ms | 428 ms | 239 KB |
| Lead record (L-2) | 330 ms | 288 ms | 241 KB |
| Follow-ups (F-2) | 239 ms | 288 ms | 239 KB |

The Phase 4 screens stayed within their earlier figures. API performance for the same data was validated in C1–C4.

## 8. Decisions taken in C5 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| C5-D1 | Start pages by role: agents → My day; owners and administrators → admin dashboard; sales and property managers → CRM dashboard; everyone else → property dashboard (still in the menu for all who had it) | Wireframe SH-1 |
| C5-D2 | Revealing is a desktop action: on phones the panel says "Open on a computer to reveal". A reveal needs a reason category and at least 10 characters of detail | Wireframes §8 and C-5; API reason rule |
| C5-D3 | Call and Message open the device's phone, WhatsApp, SMS or mail app. After a call, EstatePro offers to log it and never saves on its own. Channels the person opted out of are shown but cannot be chosen | Phase 5 records but does not send (CRM-10); XM-3 |
| C5-D4 | Requirement areas are entered as localities or as a radius around a pinned point (the Phase 4 map picker). Drawn shapes already stored are shown and kept; a drawing tool is not in Phase 5 | Uses the approved Phase 4 picker; no new map tool |
| C5-D5 | Bulk assign sends one request per lead with that lead's version; leads changed meanwhile are listed, not overwritten | Optimistic concurrency (ADR-003) |
| C5-D6 | An export uses the list's current filters (view, office, type; for leads the inbox tab's statuses and the received date) and can leave out contacts who withdrew marketing consent | One place to choose who is exported |
| C5-D7 | Follow-up quick picks in the member's time zone: later today (two hours ahead, on the hour), tomorrow 10:00, next Monday 10:00 | F-1 |
| C5-D8 | The Arabic text was written by the team and is marked for native-speaker review before release | #25 |

## 9. Risks and open items

| Item | Status |
|---|---|
| SE-1 "listings" and B-1 "next follow-up" columns | Need a per-contact summary from the API; the record shows them today. Proposed for C6 |
| Company-wide identity-check queue (menu item "Identity checks") | No list endpoint yet; the admin dashboard links to the Sellers view. Proposed for C6 |
| Contact Files tab | Documents arrive in a later phase |
| Some text comes from the API in English (preview "not visible" list, score rule names, merge blockers) | To localise in the API; tracked for C6 |
| Generated API types are loose for a few request bodies (typed as `object`) | Four casts in the web app; tightening the API DTO decorators is proposed |
| Manual screen-reader pass on D-M, C-2, L-2 and A-2 | Open (#24) |
| Arabic native-speaker review | Open (#25) |
| Deals, viewings and conversion | Phase 6 (panels hidden, not empty) |

## 10. GitHub references

| Reference | Link |
|---|---|
| C1 to C4 reports | `docs/phase-5/P5-C1-CONTACTS-REPORT.md` … `docs/phase-5/P5-C4-DASHBOARDS-PREVIEW-EXPORTS-REPORT.md` |
| Wireframes (#8) | `docs/phase-5/P5-CRM-WIREFRAMES.md`, https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/8 |
| Portal visibility (#12) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/12 |
| Screen-reader pass (#24) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/24 |
| Arabic review (#25) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/25 |
| Sensitive-data detection (#35) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/35 |
| Branch | `phase-5/preparation` |
| C5 commit | `273c6ba` |
| CI run 75 (green) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/41973234561 |
