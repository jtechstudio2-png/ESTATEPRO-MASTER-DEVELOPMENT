# Phase 5 · Milestone report: C3 Leads, activities and follow-ups

| | |
|---|---|
| Date | 3 November 2026 |
| Branch | `phase-5/preparation`, commit `929df36` |
| Approvals | C2 decisions C2-D1 to C2-D8 and risk C2-R1 approved before work started. Four-eyes KYC recorded as a future enhancement (#36) |
| Scope | Leads (CRM-06, CRM-07; wireframes L-1 to L-4; decisions D3, D6, D7; gap G1), activity timeline (CRM-04; A-1, A-2; decision D5; gap G6 / #15), follow-ups (CRM-05; F-1, F-2; decision D6). API endpoints CA-11 to CA-13 |
| Result | **C3 complete.** Encryption controls, reveal restrictions and tenant isolation unchanged and tested; every change audited; histories append-only. 424 API tests and 8 SQL test suites green locally and in CI run 70 |

## 1. Deliverables

### 1.1 Database (migration 0024)

| Change | Purpose |
|---|---|
| `app.lead_status_change_allowed()` and a status trigger on `leads` | Allowed status changes are enforced by the database. A lead that is no longer lost drops its lost reason. Converting needs a deal (Phase 6) |
| `lead_status_history` and `lead_assignments` are append-only (trigger and grants); assignment note; created by, archived by, archive reason on leads; leads never deleted by the application | Who changed what and when (L-2) |
| `activities.entry_no` (identity), timeline index on (occurred at, entry no) | Same-time entries keep a stable order (gap G6, #15) |
| `activities`: author, version, edited at, archive with reason; `is_system` for status and system entries | Decision D5 |
| Edit guard: content changes only within 24 hours, never on system or archived entries; archives cannot be rewritten; activities never deleted by the application | D5 enforced in the database, not only the API |
| `activity_revisions`, append-only with row-level security | Earlier versions are kept (D5) |
| `tasks`: cancellation (when, who, reason), reminder not after due, creator; indexes for team, done and per-lead lists; never deleted by the application | Follow-ups (F-1, F-2) |
| `activity_outcome` picklist (9 outcomes) | A-2 |

The response target (D3, G1) is the company setting `crm.lead_response_minutes`. It has no default, so nothing is stored until a company sets it.

### 1.2 API (`apps/api/src/crm/`)

| Endpoint | Permission | Wireframe |
|---|---|---|
| `GET /api/v1/leads`: status, type, source, office, contact, listing, assignee (`me`, `unassigned`), received date, attention (`response_overdue`, `no_next_action`), archived; search by reference or contact name; keyset paging | `lead.view` (unassigned: `lead.assign`) | L-1 |
| `POST /api/v1/leads`: existing contact, or a new contact inline (duplicate check, `contact.create`); idempotency key | `lead.create` | L-3 |
| `GET/PATCH /api/v1/leads/{id}` (`If-Match`) | `lead.view` / `lead.update` | L-2 |
| `POST /api/v1/leads/{id}/status`, `/assign`, `/archive`, `/restore` (`If-Match`) | `lead.update` / `lead.assign` | L-4 |
| `GET/PUT /api/v1/settings/crm` (response target) | `lead.view` / `settings.manage` | D-A |
| `GET /api/v1/contacts/{id}/activities`, `GET /api/v1/leads/{id}/activities` (type filter, archived, cursor) | `contact.view` / `lead.view` | A-1 |
| `POST /api/v1/activities`, `GET/PATCH /api/v1/activities/{id}`, `POST …/{id}/archive` | Write access to the linked records; edit by the author only | A-2 |
| `GET/POST /api/v1/tasks` (Mine or Team; open, done or cancelled; overdue; reminder due; due-date range; priority; assignee; record) | CRM access; Team view needs `lead.assign` | F-2 |
| `GET/PATCH /api/v1/tasks/{id}`, `POST …/complete`, `…/cancel`, `…/assign` (`If-Match`) | Assignee, creator, or a manager over the assignee; reassign needs `lead.assign` | F-1, F-2 |

Further changes:

- Status changes and consent changes now appear on the timeline as system entries.
- Lead rows show the contact's phone partly masked, and only the first line of the enquiry.

## 2. Requirement checklist

| Requirement | How it is met | Evidence |
|---|---|---|
| Encryption controls | No new protected fields. Lead responses carry the masked phone only. Protected contact values are never read by C3 code | Lead capture test checks no phone digits leak. Encryption suites unchanged and green |
| Reveal restrictions | Unchanged. No C3 endpoint returns a protected value | E4 tests still green |
| Tenant isolation | Row-level security on the new table. Other companies get 404 on leads, timelines, activities and follow-ups. Each lead and follow-up assignee is checked to be an active member of the same company | Isolation tests in both suites; SQL suite |
| Audit integrity | Each change audited in the same transaction. Status history, assignment history and activity revisions are append-only in the database. Activity edits are audited by field name (the text stays in the revision) | Audit assertions; SQL tests |
| Performance testing | New test: 100,000 leads, 300,000 activities, 100,000 follow-ups, in the nightly and release workflow | §7 |
| D3 response target | Company-set; reported as due, overdue or late; "not set" until configured | Test "reports the response target only once the company sets one" |
| D5 edit window | Author-only, 24 hours, earlier versions kept, then archive only; enforced in the database too | Tests in "editing and archiving"; SQL tests |
| D6 assignment | Assigning leads and follow-ups to someone else needs `lead.assign`, within the manager's offices, to someone who can open the record | Assignment tests in both suites |
| D7 scoring | No rule editor. A score is shown only with its breakdown, largest contribution first | Test "shows a score only with its breakdown" |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `leads.e2e.test.ts` | 11 | ✅ |
| `activities-tasks.e2e.test.ts` | 13 | ✅ |
| `contacts.e2e.test.ts` (merge count updated: consent entries now on the timeline) | 32 | ✅ |
| `leads.performance.test.ts` (nightly and release workflow) | 1 | ✅ p95 227 ms |
| SQL `database/tests/07_leads_activities_c3.sql` | 23 assertions | ✅ |
| All SQL suites (24 migrations, 8 files) | — | ✅ |
| Full API suite (`test:ci`, local) | 424 in 31 files | ✅ |
| Lint, typecheck, OpenAPI regenerated | — | ✅ |
| CI run 70 on `929df36` (all six required jobs) | — | ✅ [run 70](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/41609129882) |

Coverage (whole API): 97.09 % statements, 91.8 % branches, 98.71 % functions, 99.21 % lines (thresholds 95/90 met). The remaining uncovered C3 branches are fail-closed fallbacks for scopes no role holds today.

### 3.1 Defects found by the tests and fixed before commit

| Defect | Found by | Fix |
|---|---|---|
| A rejected office on lead capture also produced a misleading "assignee" error | Validation test | The assignee is checked only once the office is valid |
| `assignedTo: null` assigned the lead to its creator, so the Unassigned inbox could not be filled | Review against wireframe L-1 | Explicit null leaves the lead unassigned. Managers only; needs an office |
| The score breakdown came back in storage order (`jsonb` keeps no key order) | Score test | Sorted by points, then rule name |
| Rescheduling a follow-up whose reminder had already passed was refused | Review of the time rules | Times are checked only when they change |

## 4. Security validation

| Check | Result |
|---|---|
| Lead scope: agents see leads assigned to them; managers their offices; owner and admin everything; accountant none | ✅ tested |
| Unassigned inbox only with `lead.assign` | ✅ tested |
| Reopening an unqualified or lost lead is a manager action with a reason | ✅ tested |
| An agent who reads a contact through a lead (D1) can log activities only through that lead, not on the contact directly | ✅ tested |
| Managers who can see but not update a lead (another office) cannot log on it | ✅ tested |
| Only the author edits an activity; system entries never change; archived entries never change | ✅ tested, and refused by the database |
| Timelines and activities outside the member's access answer 404 | ✅ tested |
| Follow-ups: other members' follow-ups are 404 unless the caller manages the assignee; the team view is for managers only | ✅ tested |
| Cross-company: 404 on every new endpoint | ✅ tested |

## 5. Encryption impact

| Item | Impact |
|---|---|
| New encrypted fields | None |
| Protected values in C3 responses | None. Lead rows show the contact phone partly masked |
| Free text (enquiry message, activity bodies, follow-up descriptions) | Not field-encrypted (ADR-007 §4). Row-level security and storage encryption apply. Field help says not to record ID or bank numbers. Accepted risk R-3 / WR-1 (#35) |
| Key use | None added |

## 6. Audit impact

| Action | Metadata |
|---|---|
| `lead.created` | reference, contact (and whether it was created inline), type, source, listing, office, assignee |
| `lead.updated` / `lead.status_changed` / `lead.assigned` / `lead.archived` / `lead.restored` | Field changes; lost reason; whether a lead was reopened; archive reason |
| `activity.logged` | type, direction, links, performer, leads it answered |
| `activity.edited` | Field names and revision number (text kept in the revision, not the audit log) |
| `activity.archived` | reason |
| `task.created` / `task.updated` / `task.reassigned` / `task.completed` / `task.cancelled` | assignee, record, due time, changes, reason |
| `settings.crm_updated` | response target old and new |

Outbox events: `lead.created`, `lead.assigned`, `lead.status_changed`, `task.assigned`. These are ready for notifications in Phase 12.

## 7. Performance results

`leads.performance.test.ts`: one company with 50,000 contacts, 100,000 leads across two offices, 300,000 activities (one busy contact with 2,000) and 100,000 follow-ups, response target set. Requests go through the full API as owner, office manager and agent.

| Measure | Result |
|---|---|
| Requests | 90 |
| Median | 25 ms |
| **p95 (target < 1,000 ms)** | **227 ms** ✅ |
| Slowest | 314 ms (team follow-ups, office manager) |
| Lead inbox / mine / open (sorted by update) | 103 / 33 / 262 ms max |
| Response-overdue view | 24 ms |
| Search by contact name | 218 ms |
| Lead record / lead timeline / contact timeline | 30 / 37 / 37 ms |
| Busy contact timeline (page 2 of 2,000 entries) | 39 ms |
| Log a call (sets first response) / schedule a follow-up | 191 / 24 ms |

No optimisation was needed after the first run. The C3 tables already had the right indexes from the Phase 2 schema plus migration 0024.

## 8. Decisions taken in C3 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| C3-D1 | Lead statuses move: new → contacted, qualified, unqualified or lost; contacted → qualified, unqualified or lost; qualified → unqualified or lost. Reopening (unqualified → contacted or qualified; lost → contacted) is a manager action with a reason. Unqualified needs a note; lost needs a reason from the picklist | Wireframe L-4 "allowed transitions"; "reversible by a manager" |
| C3-D2 | The first outbound call, email, SMS or WhatsApp, or any meeting, logged on a lead after it arrived, is its first response. Inbound messages do not count. Logging never changes the status by itself | Response target (D3) needs one clear definition; no hidden status changes |
| C3-D3 | Only managers can leave a lead unassigned for the office inbox. Every assignee must be able to open the lead (work in its office) | Wireframes L-1 and L-3; D6 |
| C3-D4 | Logging an activity needs write access to what it is about: `contact.update` on the contact, or `lead.update` on a linked lead. A lead's activity is also linked to its contact | D1 keeps agents read-only on contacts; they log through their lead |
| C3-D5 | An activity may be archived by its author at any time, or by a manager over a linked lead (`lead.assign`) or contact (`contact.archive`) | D5 says "then archive-only"; managers need to remove misplaced entries (for example ID numbers in a note, R-3) |
| C3-D6 | "Performed by" may name another active team member; "logged by" is always the person who saved it | Wireframe A-1 ("logged by Kofi") |
| C3-D7 | Follow-ups: "Mine" is what is assigned to me; the Team view is for managers in their scope. Reminders are in-app (the list reports due reminders). Today and this-week boundaries are computed by the client in the office timezone | Wireframes F-1 and F-2; push, email and SMS reminders are Phase 12 |
| C3-D8 | A lead cannot be archived while it has open follow-ups | Prevents follow-ups on hidden records |
| C3-D9 | A lead's office may be changed by someone who can update it, within their own offices | Moves between branches without reassigning |

## 9. Risks and open items

| Item | Status |
|---|---|
| Lead conversion to a deal | Phase 6 (hidden; the database refuses conversion without a deal) |
| Lead and contact exports (CA-16), dashboards and My day (CA-14) | C4 |
| Notification delivery for assignments and reminders | Phase 12 (outbox events written now) |
| Lead scoring rules | None in Phase 5 (D7); display is ready |
| Merge and other system events on the timeline | Status and consent changes are shown; merge history stays in the audit log and merge preview |
| Free text containing personal data (R-3 / WR-1) | Accepted; tracked in #35 |

## 10. GitHub references

| Reference | Link |
|---|---|
| C1 and C2 reports | `docs/phase-5/P5-C1-CONTACTS-REPORT.md`, `docs/phase-5/P5-C2-REQUIREMENTS-KYC-REPORT.md` |
| Wireframes (#8, closed) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/8 |
| Deterministic history ordering (#15) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/15 |
| Sensitive-data detection (#35) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/35 |
| Four-eyes KYC enhancement (#36) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/36 |
| Branch | `phase-5/preparation` |
| C3 commit | `929df36` |
| CI run 70 (green) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/41609129882 |
