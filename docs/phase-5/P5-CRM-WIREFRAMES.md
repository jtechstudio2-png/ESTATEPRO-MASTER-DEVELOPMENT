# Phase 5 · CRM Wireframes: Admin Dashboard, Agent Desktop and CRM Screens (issue #8)

| | |
|---|---|
| Status | **Approved** (product owner, 1 November 2026). Implementation follows the approved sequence: encryption stages E1–E4 first (ADR-007), then CRM. |
| Issue | [#8](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/8): audit MD-2 (Admin dashboard layout) and MD-3 (Agent desktop home), extended to every Phase 5 CRM screen |
| Builds on | Phase 3 design set (`docs/phase-3-ui-ux/`): shell, tokens, record page pattern (07 §1), tables, forms, filters, empty and error states, dashboard rules (06 §1). Phase 4 wireframe conventions (`docs/phase-4/M6-WIREFRAMES.md`). Those rules apply here and are not repeated |
| Backed by | Phase 2 schema: `contacts`, `contact_relationships`, `contact_methods`, `contact_links`, `consents`, `requirements`, `identity_documents`, `kyc_checks`, `activities`, `activity_links`, `tasks`, `leads`, `lead_status_history`, `lead_assignments`, `property_ownerships` (migrations 0005–0007). No CRM API exists yet: every endpoint below is **planned** and listed in the [verification report](./P5-CRM-WIREFRAME-VERIFICATION.md) §3 |
| Companion | [P5 CRM Wireframe Verification Report](./P5-CRM-WIREFRAME-VERIFICATION.md) · [ADR-007 Field encryption](../decisions/ADR-007-field-encryption-key-management.md) |

These are low-fidelity structural wireframes. They fix content, order, actions, permissions and states, not visual styling. Names and numbers in the drawings are illustrative placeholders, not data, defaults or business rules.

## How to read this document

Each screen has a drawing and a specification block:

| Field | Meaning |
|---|---|
| **Purpose** | The question the screen answers or the task it completes |
| **Roles** | Who sees it, with permission and scope (§2). Roles not listed never see it: navigation hidden and the API rejects direct calls |
| **Data** | What the screen reads (tables; planned endpoint) |
| **Actions** | What the user can do (planned endpoint; permission) |
| **States** | Screen-specific states. Every screen also has the standard states (Phase 3 03 §8): loading, empty, filtered empty, validation error, permission denied, conflict (412), network failure, success |
| **Security** | What the screen must and must not do beyond the server's checks |

Role abbreviations: **Own** company owner · **Adm** office administrator · **SM** sales manager · **PM** property manager · **Ag** agent · **Acc** accountant · **Tech** maintenance staff.

Phase boundaries used below: **Phase 5** builds contacts, relationships, requirements, consent, KYC records, leads, activities and follow-ups. **Phase 6** adds deals, viewings and offers; panels that need them are drawn with a `Phase 6` tag and are **hidden** (not shown empty) until then. **Phase 7** adds leases, management agreements and portals.

## 1. Screen index

| ID | Screen | Device notes |
|---|---|---|
| **Shell and home** | | |
| SH-1 | Navigation: Contacts and Sales sections, global create | desktop sidebar, tablet rail, mobile bottom bar |
| D-A | Admin dashboard (layout, MD-2) | desktop 12-col; tablet 2-col; mobile action cards |
| D-C | CRM dashboard (team and own scope) | as above |
| D-M | My day: Agent desktop home (MD-3) | desktop two-pane; mobile list (XM-1) |
| **Contacts** | | |
| C-1 | Contact register, with Buyer / Seller / Landlord / Tenant views | desktop table; cards on mobile |
| C-2 | Contact record: Overview | all |
| C-3 | Contact form (create and edit) with duplicate check | all |
| C-4 | Duplicate review and merge | desktop, tablet |
| C-5 | Sensitive details panel (masked; reveal with step-up) | all |
| C-6 | Consent and communication preferences | all |
| **Relationship views** | | |
| B-1 | Buyer view: requirements and listing matches | all |
| B-2 | Requirement form and matches drawer | all |
| SE-1 | Seller view: listings, valuations, identity checks | all |
| LL-1 | Landlord view: owned and managed properties, linked visibility | all |
| **Leads** | | |
| L-1 | Lead inbox and register | desktop table; tablet two-pane; mobile cards |
| L-2 | Lead record | all |
| L-3 | New lead (quick capture) | dialog; full screen on mobile |
| L-4 | Assign, qualify, mark lost, convert | dialogs |
| **Activity and follow-up** | | |
| A-1 | Activity timeline (contact and lead) | all |
| A-2 | Log activity (call, meeting, message, note) | inline; full screen on mobile |
| F-1 | Schedule follow-up | dialog; bottom sheet on mobile |
| F-2 | Follow-ups list (mine, team, overdue) | all |
| **Mobile and tablet** | | |
| XM-1 | My day on mobile | ≤ 767 px |
| XM-2 | Contact on mobile: call, message, log | ≤ 767 px |
| XM-3 | After-call logging | ≤ 767 px |
| XM-4 | Lead capture on mobile | ≤ 767 px |
| TM-1 | Contact record on tablet | 768–1023 px |
| TM-2 | Lead inbox on tablet (two-pane) | 768–1023 px |

## 2. Role-based visibility

### 2.1 Permissions and scopes (from migration 0014)

| Capability | Own | Adm | SM | PM | Ag | Acc | Tech |
|---|---|---|---|---|---|---|---|
| `contact.view` | all | all | office | office | **own** | all | assigned |
| `contact.create` / `update` | all | all | office | office | own | — | — |
| `contact.archive` / `merge` | all | all | office | office | — | — | — |
| `contact.export` (sensitive, audited) | all | all | office | office | — | — | — |
| `contact.view_sensitive` (reveal) | all | — | — | — | — | all | — |
| `kyc.view` / `kyc.manage` | all | all | office | office | own | view, all | — |
| `kyc.approve` | all | all | office | office | — | — | — |
| `lead.view` / `create` / `update` | all | all | office | office | own | — | — |
| `lead.assign` | all | all | office | office | — | — | — |
| `lead.export` (sensitive) | all | all | office | — | — | — | — |

"Own" for an agent means records where they are the owner (`contacts.owner_membership_id`) or assignee (`leads.assigned_to`, `tasks.assigned_to`). Whether an agent also sees a contact because a lead or task about that contact is assigned to them is **decision D1** in the verification report (recommended: yes, read-only for the contact).

Maintenance staff see only the contact details attached to a work order assigned to them (Phase 8); they get no CRM screens.

### 2.2 Screen visibility

✓ = full · ◐ = own scope or read-only · blank = hidden (navigation not rendered; direct URL returns the permission-denied state).

| Screen | Own | Adm | SM | PM | Ag | Acc |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| D-A Admin dashboard | ✓ | ✓ | | | | |
| D-C CRM dashboard | ✓ | ✓ | ✓ (office) | ✓ (office) | ◐ (own) | |
| D-M My day | | | | | ✓ | |
| C-1 Contacts and views | ✓ | ✓ | ✓ | ✓ | ◐ | ◐ (read) |
| C-3 Create / edit contact | ✓ | ✓ | ✓ | ✓ | ◐ | |
| C-4 Merge | ✓ | ✓ | ✓ | ✓ | | |
| C-5 Reveal sensitive details | ✓ | | | | | ✓ |
| L-1 / L-2 Leads | ✓ | ✓ | ✓ | ✓ | ◐ | |
| L-4 Assign | ✓ | ✓ | ✓ | ✓ | | |
| F-2 Follow-ups (team tab) | ✓ | ✓ | ✓ | ✓ | | |

Rules: hidden actions are not rendered (not shown disabled) unless the user could gain the right by step-up, in which case the action shows with "Requires verification". Counts and totals on dashboards are computed in the user's scope only, so a scoped user never infers the size of records they cannot see.

## 3. Shell and home

### SH-1 Navigation

```text
┌──────────────┬──────────────────────────────────────────────────────────────────┐
│ EstatePro    │ [Search contacts, leads, properties…  /]        [+ New ▾]  [KA ▾]│
│ Accra Homes ▾├──────────────────────────────────────────────────────────────────┤
│              │                                                                  │
│ ▸ My day     │  + New ▾                                                         │
│ ▸ Work queue │  ├ Lead                                                          │
│ ▸ Dashboards │  ├ Contact                                                       │
│ ▾ Contacts   │  ├ Follow-up                                                     │
│   Contacts   │  ├ Log a call                                                    │
│   Buyers     │  └ Property  (Phase 4)                                           │
│   Sellers    │                                                                  │
│   Landlords  │                                                                  │
│   Tenants    │                                                                  │
│   Requirements                                                                  │
│   Identity checks                                                               │
│ ▾ Sales      │                                                                  │
│   Leads   12 │                                                                  │
│   Follow-ups 3                                                                  │
│ ▸ Properties │                                                                  │
└──────────────┴──────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Reach CRM work in one step; create the common records from anywhere |
| Roles | Per §2.2. Agents land on **My day**; Owner and Admin on **Admin dashboard**; SM and PM on **CRM dashboard** (Phase 3 02 §3) |
| Data | `GET /api/v1/me` (permissions, scopes); queue counts: unassigned or new leads in scope (`leads_unassigned_idx`, `leads_queue_idx`), overdue follow-ups (`tasks_my_open_idx`) |
| Actions | Global create menu items filtered by permission. `/` focuses search |
| States | Counts show only for queues needing action, never totals (Phase 3 02 §6). Count fetch failure hides the badge, never shows "0" |
| Security | Buyers, Sellers, Landlords and Tenants are saved views of the one contact register (decision D2), not separate data sets: a person who is both buyer and landlord is one record |

### D-A Admin dashboard (MD-2)

**Question:** is the account set up correctly and secure, is CRM work flowing, and is anything blocked?

```text
┌ Admin dashboard ──────────────── [All offices ▾] ──────────── Updated 09:42 · Refresh ┐
│ ┌ Needs attention now ──────────────────────────────────────────────────────────────┐ │
│ │ ⚠ 5 new leads unassigned > 1 h (Osu office) → Assign                              │ │
│ │ ⚠ 2 users in roles that require MFA have none → Review                            │ │
│ │ ⚠ 1 failed import (contacts.csv, 14 rows rejected) → Open error file              │ │
│ └────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Users and access ─────────────────┐ ┌ Lead flow (last 7 days) ───────────────────┐ │
│ │ Pending invitations         3 →   │ │ Office   New  Unassigned  No response >SLA │ │
│ │ Expired invitations         1 →   │ │ Osu       18      5             2          │ │
│ │ Users without required MFA  2 →   │ │ Airport   11      0             0          │ │
│ │ Agent licences expiring ≤60d 1 →  │ │ Assignment rules: 2 active → Settings      │ │
│ └───────────────────────────────────┘ └────────────────────────────────────────────┘ │
│ ┌ Contact data quality ─────────────┐ ┌ Privacy and consent ───────────────────────┐ │
│ │ Possible duplicates          7 →  │ │ Erasure / access requests open   1 →       │ │
│ │ Contacts with no owner      12 →  │ │ Marketing consent withdrawn (7d) 4 →       │ │
│ │ Identity checks expiring ≤30d 2 → │ │ Sensitive reveals (7d)          9 → Audit  │ │
│ └───────────────────────────────────┘ │ Contact exports (7d)            1 → Audit  │ │
│ ┌ Imports and exports ──────────────┐ └────────────────────────────────────────────┘ │
│ │ contacts.csv  failed   14 rejected│ ┌ Account ───────────────────────────────────┐ │
│ │ leads export  done     by Ama  →  │ │ Users 34 of 50 · Storage 12 of 50 GB →     │ │
│ └───────────────────────────────────┘ │ Support access grants open 0               │ │
│                                       └────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Panel | Data source | Click-through |
|---|---|---|
| Needs attention now | Union of the alert conditions below that are true now, most urgent first; at most 5 rows | The specific queue |
| Users and access | `invitations` (open, expired); `company_memberships` + `mfa_factors` vs role MFA requirement; `agent_profiles.licence_expires_on` | Invitations; user; agent profile |
| Lead flow by office | `leads` by `office_id`: received in window, `assigned_to IS NULL`, `first_response_at IS NULL` past the company's response SLA setting | Lead inbox filtered (L-1) |
| Contact data quality | Duplicate candidates (same `contact_methods.normalised` or `identity_documents.number_hash` within company, not merged); `contacts.owner_membership_id IS NULL`; `identity_documents.expires_on` / `kyc_checks.expires_on` ≤ 30 days | C-4; C-1 filtered; Identity checks |
| Privacy and consent | Data-subject requests (planned, verification §4 G3); `consents` withdrawn in window; `audit_logs` for `contact.view_sensitive`, `contact.export`, `lead.export` | Requests; consent report; audit log filtered |
| Imports and exports | `import_jobs`, `export_jobs` | Job detail and error file |
| Account | `usage_counters` vs `plan_entitlements` shown as "34 of 50" (never a gauge alone); `support_access_grants` open | Billing; support access |

| | |
|---|---|
| Roles | Own (all offices); Adm (all offices or assigned offices). Scope switcher limited to the offices the user may see |
| States | If the response SLA setting is not configured, the "No response > SLA" column shows "SLA not set → Settings" instead of a number. No default SLA is assumed |
| Security | Every number is a link to the filtered list that produced it (Phase 3 06 §1). Audit links open the audit log already filtered; counts never reveal records outside the user's offices |
| Layout | Desktop: 12-column grid, "Needs attention" full width, then two columns. Tablet: two columns, tables keep first three columns. Mobile: action cards in the order above |

### D-C CRM dashboard

**Question:** are enquiries answered quickly, and is anyone's follow-up slipping? (Phase 3 06 §4, refined for Phase 5 data)

```text
┌ CRM dashboard ─────────── [Team: Osu office ▾] [Last 30 days ▾] ───── Updated 09:42 ⟳ ┐
│ ┌ New leads not yet contacted ─────────────────┐ ┌ Follow-ups ───────────────────────┐ │
│ │ Received Contact      Source   Owner   Age   │ │ Overdue 3 →  Today 7 →  Week 19 → │ │
│ │ 08:55    Yaw Adjei    Portal   —       47m ⚠ │ └───────────────────────────────────┘ │
│ │ 08:10    Sarah K.     Website  Grace   1h32  │ ┌ Leads by status (in scope) ───────┐ │
│ │ [Assign] [Call] [Open]                       │ │ New 12 · Contacted 20 ·           │ │
│ └──────────────────────────────────────────────┘ │ Qualified 9 · Converted 4 · Lost 6│ │
│ ┌ Response time (team, last 30 days) ──────────────────────────────────────────────┐ │
│ │ Agent    Leads  Median first response  Within SLA  Qualified  Converted         │ │
│ │ Grace      34   22 min                 91 %        12          6                │ │
│ │ Kofi       28   1 h 05                 64 %         7          2                │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Leads by source ── source · leads · qualified · converted · median response ────┐ │
│ ┌ Active buyer and tenant requirements ── buy 41 · rent 63 · no match 12 → ───────┐ │
│ ┌ Viewings needing feedback ───────────────────────────────────── Phase 6 (hidden)┐ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Panel | Data source | Click-through |
|---|---|---|
| New leads not yet contacted | `leads.status = 'new' AND first_response_at IS NULL` in scope, oldest first | L-2; Assign (L-4); Call (`tel:`) then A-2 |
| Follow-ups | `tasks.status = 'open'` by `due_at` (overdue, today, this week) in scope | F-2 filtered |
| Leads by status | `leads` grouped by `status`, received in window | L-1 filtered |
| Response time | `first_response_at − received_at` per `assigned_to`; "Within SLA" uses the company setting; qualified and converted from `lead_status_history` | Agent's lead list |
| Leads by source | `leads.source_code` (picklist `lead_source`) | L-1 filtered |
| Active requirements | `requirements.status = 'active'` by type; "no match" = no published listing satisfying it (matching rule, verification §5 D4) | B-1 filtered |
| Viewings needing feedback | `viewings` (Phase 6) | Hidden until Phase 6 |

| | |
|---|---|
| Roles | SM and PM: office scope. Own and Adm: all or chosen offices. Agent: same layout limited to own records, **without** the per-agent table |
| States | "Converted" counts appear only when Phase 6 deals exist; until then the column is hidden (leads can be marked qualified but conversion needs a deal) |
| Security | The response-time table never shows agents outside the viewer's scope. Percentages always show the base ("91 % of 34") on hover and in the accessible name |

### D-M My day: Agent desktop home (MD-3)

**Question:** what must I do today, in what order, and what is waiting on me?

```text
┌ My day · Tuesday 3 November ───────────────── Osu office · Africa/Accra ── Updated 09:42 ⟳ ┐
│ ┌ Today ───────────────────────────────────────────────────┐ ┌ Waiting on me ────────────┐ │
│ │ ● Now                                                     │ │ New leads assigned   2 →  │ │
│ │ 09:30  Follow-up  Call Ama Owusu re 3-bed East Legon      │ │ Overdue follow-ups   1 →  │ │
│ │        Lead LEA-2026-000412 · due 09:00 ⚠ overdue        │ │ Leads > SLA, no reply 1 → │ │
│ │        [Call] [Log outcome] [Reschedule]                  │ │ Viewings w/o feedback     │ │
│ │ 10:00  New lead   Yaw Adjei · Portal · 2-bed rent Osu     │ │   Phase 6 (hidden)        │ │
│ │        [Call] [Message] [Open]                            │ └───────────────────────────┘ │
│ │ 11:30  Viewing    Phase 6 (row type hidden until then)    │ ┌ My leads by status ───────┐ │
│ │ 14:00  Follow-up  Send valuation to Kwame Mensah          │ │ New 2 · Contacted 6 ·     │ │
│ │        Seller · [Email] [Done]                            │ │ Qualified 3 →             │ │
│ │ ── Later this week (4) ▾                                  │ └───────────────────────────┘ │
│ └───────────────────────────────────────────────────────────┘ ┌ Quick actions ────────────┐ │
│                                                                │ [+ Lead] [+ Contact]      │ │
│                                                                │ [Log a call] [+ Follow-up]│ │
│                                                                └───────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | One chronological list for today in the agent's office timezone (Phase 3 06 §10) |
| Roles | Ag (own scope). Other roles use the CRM dashboard and Work queue |
| Data | Open `tasks` assigned to me with `due_at` today or overdue (`tasks_my_open_idx`); `leads` assigned to me with `status = 'new'`; leads past SLA without `first_response_at`; Phase 6 adds `viewings` and `offers` rows |
| Actions | Each row has one primary action and at most two secondary: Call (`tel:` link, then prompts A-2), Message (opens the contact's preferred channel, logs A-2), Log outcome (A-2), Reschedule (F-1), Done (`PATCH /api/v1/tasks/{id}` status done) |
| States | Empty day: "Nothing due today" with links to Leads and Follow-ups. Overdue rows sort first with ⚠ and the text "overdue" (never colour alone). "Now" marker moves only on refresh, not live, so rows do not jump while read (Phase 3 06 §1.9) |
| Security | Contact phone and email are shown because the agent has `contact.view` on these records; sensitive fields (C-5) never appear here |

## 4. Contacts

### C-1 Contact register and relationship views

```text
┌ Contacts ─────────────────────────────────────────────────────── [+ New contact] [⋯] ┐
│ [All] [Buyers] [Sellers] [Landlords] [Tenants] [Applicants] [Suppliers] [Other]       │
│ Search name, phone, email, reference…  [Office ▾] [Owner ▾] [Source ▾] [Consent ▾]    │
│ Chips: Landlords ✕  Owner: me ✕                                         Clear all     │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ☐ Name ▲              Roles              Phone          Owner   Last activity    │ │
│ │ ☐ Ama Owusu           Buyer · Landlord   +233 24 ••• 4412 Grace  Call · 2 d ago   │ │
│ │   أحمد الكواري (Ahmed Al-Kuwari) Seller  +974 55 ••• 0193 Kofi   Note · 5 d ago   │ │
│ │ ☐ Osu Ventures Ltd    Landlord (org)     —              Grace   Email · today    │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│ 1–50 of many · [Load more]                     Sorted by: Last activity, newest first │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Find a person or organisation and see their roles at a glance |
| Roles | Per §2.2. Agents see own scope by default with an "All I can see" option if D1 is accepted |
| Data | `GET /api/v1/contacts?relationship=landlord&owner=…&q=…` over `contacts` + active `contact_relationships`; search uses `contacts.search_vector` then trigram on `display_name` (Phase 3 02 §7). Phone matches any format via E.164 normalisation |
| Actions | New contact (C-3); bulk: assign owner (`contact.update`), add to export (`contact.export`, audited); open record |
| States | Phone shown partly masked in lists (`+233 24 ••• 4412`) with the full number on the record; this is display masking, not encryption (ADR-007 §3) |
| Security | Views are filters, so a contact with two roles appears in both views. Search never matches on encrypted fields (ADR-007 §6). Export button absent without `contact.export` |
| Mobile | Cards: name (and native-script name), roles, one-tap Call and Message |

### C-2 Contact record: Overview

```text
┌ ← Contacts ──────────────────────────────────────────────────────────────────────────┐
│ Ama Owusu                                   [Call] [Message] [+ Follow-up] [Edit] [⋯] │
│ CON-2026-000318 · Person · Buyer · Landlord · Owner: Grace · Osu office               │
│ ⚠ Marketing consent withdrawn 12 Oct (email)                                          │
│ [Overview] [Activity] [Leads] [Requirements] [Properties] [Identity] [Consent] [Files]│
│ ┌ Contact methods ─────────────────────┐ ┌ Next follow-up ──────────────────────────┐ │
│ │ Mobile  +233 24 555 4412  ★ primary  │ │ Today 09:30 · Call re 3-bed East Legon   │ │
│ │ WhatsApp +233 24 555 4412  verified  │ │ Grace · [Done] [Reschedule]              │ │
│ │ Email   ama@…            opted out ⊘ │ └──────────────────────────────────────────┘ │
│ │ Preferred: WhatsApp · Language: en   │ ┌ Roles ───────────────────────────────────┐ │
│ └──────────────────────────────────────┘ │ Buyer since 2 Sep · 1 active requirement │ │
│ ┌ Details ─────────────────────────────┐ │ Landlord since 2024 · 2 properties       │ │
│ │ Address  12 Oxford St, Osu, Accra    │ │ [+ Add role]                             │ │
│ │ Nationality GH · Residence GH        │ └──────────────────────────────────────────┘ │
│ │ Source   Referral (Kwame Mensah)     │ ┌ Related contacts ────────────────────────┐ │
│ │ Sensitive details → C-5 (masked)     │ │ Spouse: Kojo Owusu → · Director of: —    │ │
│ └──────────────────────────────────────┘ └──────────────────────────────────────────┘ │
│ ┌ Recent activity (5) ─────────────────────────────────────────────── See all → A-1 ┐ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Everything needed to act on one person, without scrolling to find the next step |
| Roles | `contact.view` in scope. Edit needs `contact.update`; Identity tab needs `kyc.view`; Properties tab needs `property.view` |
| Data | `GET /api/v1/contacts/{id}` (contact, methods, relationships, links, consent summary, owner); next open task (`tasks` by entity); recent `activities` via `activity_links` |
| Actions | Call / Message (log A-2 after); + Follow-up (F-1); Edit (C-3); ⋯ menu: Change owner, Archive (`contact.archive`, reason required), Merge (C-4), Export this contact (`contact.export`) |
| States | Archived: banner with reason and Restore; read-only. Merged: redirect to the surviving record with "Merged from CON-…" notice. Anonymised: name replaced, all methods removed, timeline bodies redacted (erasure, ADR-007 §8) |
| Security | Opted-out channels show ⊘ and the Message action for that channel is disabled with the reason. Consent warnings use icon + text. No sensitive field values on this tab |

### C-3 Contact form with duplicate check

```text
┌ New contact ───────────────────────────────────────────────────────── [Cancel] [Save] ┐
│ Type   (•) Person  ( ) Organisation                                                   │
│ Display name *        [Ama Owusu                    ]                                 │
│ Name in local script  [                              ]  (e.g. Arabic) dir="auto"      │
│ Given name [Ama      ]  Family name [Owusu    ]  Other names [        ]  Title [  ▾]  │
│ Mobile * or Email *   [+233 ▾][24 555 4412   ]  [ama@example.com          ]           │
│ ┌ Possible duplicate ───────────────────────────────────────────────────────────────┐ │
│ │ ⚠ Ama Owusu (CON-2026-000318) has the same mobile number. Owner: Grace            │ │
│ │ [Open existing] [Not the same person: continue]                                   │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ Roles  ☑ Buyer ☐ Seller ☐ Landlord ☐ Tenant ☐ Applicant ☐ Supplier ☐ Other          │
│ Preferred channel [WhatsApp ▾]  Language [English ▾]  Source * [Referral ▾]           │
│ Owner [Me ▾]  Office [Osu ▾]                                                          │
│ Consent  ☐ Property alerts by [WhatsApp ▾]   ☐ Marketing by [Email ▾]                 │
│          Lawful basis and evidence are recorded with each consent (C-6)               │
│ ▸ Address   ▸ Organisation details   ▸ Date of birth (sensitive)                      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Create or edit a contact without creating duplicates (CRM-02) |
| Roles | `contact.create` / `contact.update` in scope. Owner field editable only with `contact.update` beyond own scope |
| Data | Duplicate check `POST /api/v1/contacts/duplicate-check` on normalised phone and email (`contact_methods_dedupe_idx`) as the user leaves those fields |
| Actions | Save (`POST` / `PATCH /api/v1/contacts`); consents saved as `consents` rows with `captured_via = 'web_form'` and `captured_by` |
| States | Duplicate panel is advisory: the user may continue, and the choice is recorded. Agents without `contact.view` on the existing record see "A contact with this number exists in your company. Ask a manager" without its name or owner (no cross-scope disclosure) |
| Security | Date of birth is entered in a dedicated field that is never echoed back after save (ADR-007). Display name is required because not every culture fits given/family names (migration 0005) |

### C-4 Duplicate review and merge

```text
┌ Merge contacts ──────────────────────────────────────────────────────────────────────┐
│ Keep ◉ CON-2026-000318 Ama Owusu         Merge ○ CON-2026-000502 Ama Owusu-Boateng  │
│ Field           Keep                          Other                     Use          │
│ Display name    Ama Owusu                     Ama Owusu-Boateng         ◉ ○          │
│ Email           ama@…                         ama.ob@…                  both ☑       │
│ Mobile          +233 24 555 4412              +233 24 555 4412          same         │
│ Roles           Buyer, Landlord               Tenant                    union        │
│ Identity docs   1 (masked)                    1 (masked)                union        │
│ Activity        42                            7                         all kept     │
│ ⚠ This cannot be undone. History, leads, tasks and consents move to the kept record. │
│                                                     [Cancel] [Merge 2 contacts]      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `contact.merge` (Own, Adm, SM, PM) |
| Data | Both contacts; dependent counts; `POST /api/v1/contacts/{keepId}/merge` |
| States | Blocked when either record has an open erasure request or legal hold. Consent conflict (one granted, one withdrawn for the same purpose and channel): the **withdrawn** state wins and the user is told so |
| Security | Merge sets `merged_into_contact_id`; the merged record stays for audit. Audited with both ids and the field choices |

### C-5 Sensitive details panel

```text
┌ Identity and sensitive details ─────────────────────────────────────────────────────┐
│ Date of birth        ••/••/••••                  [Reveal]  Requires verification   │
│ Passport (GH)        •••••• 4821  exp 2029-04    [Reveal]                           │
│ Bank account (payout) GCB Bank · ••••6630  verified 12 Aug   Phase 7 / 9           │
│ ─────────────────────────────────────────────────────────────────────────────────── │
│ Revealed values hide again after 60 s or when you leave this panel.                │
│ Every reveal is recorded in the audit log with your name and the reason.           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Show that sensitive data exists without exposing it; reveal one value for a stated reason |
| Roles | Panel visible with `kyc.view`. Reveal requires `contact.view_sensitive` (Own, Acc) **and** step-up re-authentication (ADR-001 R6; `prompt=login`, `max_age=0`) |
| Data | Masked metadata only (`last4`, expiry, issuing country, verification) from the list endpoint. Reveal: `POST /api/v1/contacts/{id}/sensitive/{field}/reveal` with a reason, returning one plaintext value |
| States | Reveal dialog asks for a reason (picklist + free text). Step-up failure leaves the value masked |
| Security | Plaintext is never cached by the BFF or browser (`Cache-Control: no-store`), never in URLs, logs or analytics; it is removed from the DOM on hide. The 60 s value is a UI timer, set in ADR-007 §9 as a proposal for approval |

### C-6 Consent and communication preferences

```text
┌ Consent ────────────────────────────────────────────────────────── [+ Record consent] ┐
│ Purpose            Channel    Status      Basis         Captured        Via     By   │
│ Property alerts    WhatsApp   Granted     Consent       2 Sep 10:14     Web     Grace│
│ Marketing          Email      Withdrawn   —             12 Oct 16:02    Portal  —    │
│ Data processing    Any        Granted     Contract      2 Sep 10:14     Web     Grace│
│ [Show full history]                                                                   │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Prove what the person agreed to, when and how (CRM-08) |
| Roles | View with `contact.view`; record with `contact.update` |
| Data | `consents` (append-only history; the latest row per purpose and channel is the current state) |
| Actions | Record consent or withdrawal: purpose, channel, status, lawful basis, captured via, evidence (`POST /api/v1/contacts/{id}/consents`) |
| Security | Rows are never edited; corrections are new rows. Withdrawal takes effect immediately in Message actions and in Phase 12 automation |

## 5. Relationship views

### B-1 Buyer view: requirements and matches

```text
┌ Buyers ── [Requirement: Buy ▾] [Budget GHS ▾] [Area ▾] [Financing ▾] [Move by ▾] ────┐
│ Name           Budget (GHS)       Beds  Areas              Financing     Matches  Next│
│ Ama Owusu      900k – 1.2m        3+    East Legon, Airport Mortgage ✓    4 →     Today│
│ Yaw Adjei      —  (rent, 6k/mo)   2     Osu                n/a           11 →    —  ⚠│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Work buyers (and tenants seeking to rent) by what they want, not by name (CRM-03) |
| Data | Contacts with active `buyer` or `applicant` relationship joined to active `requirements`; Matches = published listings satisfying the requirement (D4); Next = next open follow-up |
| Actions | Open matches (B-2); + Follow-up; Log activity. Phase 6: "Book viewing" from a match |
| States | ⚠ in Next = no follow-up scheduled for an active buyer. Money never mixed across currencies: a GHS budget only matches GHS listings |
| Security | Agents see their own buyers unless D1 extends scope |

### B-2 Requirement form and matches drawer

```text
┌ Requirement · Ama Owusu ───────────────────────┐ ┌ Matches (4) ─────────────── [⋯] ─┐
│ Type (•) Buy ( ) Rent   Status [Active ▾]      │ │ LST-…0091 3-bed, East Legon       │
│ Currency [GHS ▾] Min [900,000] Max [1,200,000] │ │ GH₵1.1m · published 3 d ago       │
│ Bedrooms min [3] max [ ]  Types [House, Town…▾]│ │ [Send to client] [Not suitable]   │
│ Areas [East Legon ✕][Airport ✕] [+ map area]   │ │ LST-…0102 4-bed, Airport          │
│ Must have [Parking ✕][Generator ✕]             │ │ GH₵1.2m · [Send] [Not suitable]   │
│ Move by [2027-01-31]  Financing [Mortgage ▾]   │ └───────────────────────────────────┘
│ Notes [                                    ]   │
└────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `contact.update` to edit; matches need `listing.view` |
| Data | `requirements` row; matches from published listings in the company (Phase 4 search API with requirement filters). Areas reuse the Phase 4 map picker (M-1, polygon or radius) |
| Actions | Save (`POST/PATCH /api/v1/contacts/{id}/requirements`); Send to client logs an outbound activity (A-2) linked to contact and listing (no automated sending in Phase 5); Not suitable records a reason so the listing stops appearing for this requirement (schema gap G2) |
| Security | Matching runs only on the company's own listings; never across companies |

### SE-1 Seller view

```text
┌ Sellers ─────────────────────────────────────────────────────────────────────────────┐
│ Name            Listings (active)   Valuation lead     Identity check   Next          │
│ Kwame Mensah    LST-…0091 published  —                  ✓ verified       Today 14:00  │
│ أحمد الكواري     —                    LEA-…0377 contacted ⏳ in review      —   ⚠        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | See every seller's listings, valuation leads and identity status, which gates publishing (#18) |
| Data | Contacts with active `seller` relationship; their listings through `property_ownerships` (owner contact) and listing; `leads.lead_type IN ('sell','valuation')`; latest `kyc_checks` of type `identity` |
| Actions | Open listing; open lead; Record identity check (`kyc.manage`), Sign off (`kyc.approve`) |
| States | Identity check states use icon + text: ✓ verified, ⏳ pending or in review, ✕ failed, ⌛ expired |
| Security | KYC outcomes are visible with `kyc.view`; identity numbers stay masked (C-5) |

### LL-1 Landlord view

```text
┌ Landlords ───────────────────────────────────────────────────────────────────────────┐
│ Name               Properties          Managed by us   Portal access   Next          │
│ Osu Ventures Ltd   3 (Osu Court +2)    Phase 7         Phase 7         —             │
│ Ama Owusu          2                   Phase 7         Phase 7         Today 09:30   │
└──────────────────────────────────────────────────────────────────────────────────────┘
┌ Landlord · Osu Ventures Ltd › Properties ───────────────────────────────────────────┐
│ Property         Share   From         Units  Listed   Keys out                       │
│ Osu Court        100 %   2024-03-01   3      1        1                              │
│ ┌ What this landlord could see in the portal (#12, preview) ─────────────────────┐ │
│ │ Properties: Osu Court, Labone Villa, Airport Flat 2 (current ownership)         │ │
│ │ Not visible: other owners' properties, tenants' contact details, staff notes    │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Manage landlords as clients: what they own, how to reach them, what they would see |
| Data | Contacts with active `landlord` relationship; `property_ownerships` with `effective_to IS NULL` (`property_ownerships_owner_idx`); "What this landlord could see" calls the landlord-side linked-visibility resolver (#12, delivered in Phase 5) in preview mode |
| Actions | Open property; add ownership (`property.update`); + Follow-up |
| States | Management agreements and portal invitations are Phase 7: the columns show "Phase 7" text, not empty values |
| Security | The preview uses the same server resolver as the future portal, so staff and portal can never disagree. It is read-only and audited as a preview |

## 6. Leads

### L-1 Lead inbox and register

```text
┌ Leads ─────────────────────────────────────────────────────────── [+ New lead] [⋯] ─┐
│ [Inbox: new 12] [Mine] [Unassigned 5] [All open] [Closed]                            │
│ Search…  [Type ▾] [Source ▾] [Office ▾] [Assigned ▾] [Received ▾] [Score ▾]         │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Received ▼  Contact      Type  Enquiry              Source   Assigned  Status  Age│ │
│ │ 08:55       Yaw Adjei    Rent  LST-…0102 2-bed Osu  Portal   —         New   47m⚠│ │
│ │ 08:10       Sarah K.     Buy   —  (general)         Website  Grace     New   1h32│ │
│ │ Yesterday   Kwame M.     Valuation  —               Referral Kofi      Contacted  │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Make sure every enquiry is answered quickly by the right person (CRM-06) |
| Roles | `lead.view` in scope. Unassigned tab needs `lead.assign` |
| Data | `GET /api/v1/leads?status=…&assigned=…` (`leads_queue_idx`, `leads_unassigned_idx`, `leads_source_idx`) |
| Actions | New lead (L-3); bulk assign (`lead.assign`); export (`lead.export`, audited) |
| States | Age turns ⚠ (icon + "past SLA" text) only when the company has set a response SLA |
| Security | Lead messages may contain personal data; list rows show the first line only |

### L-2 Lead record

```text
┌ ← Leads ── LEA-2026-000412 ──────────────────────────────────────────────────────────┐
│ Yaw Adjei · Rent · Status: New → [Contacted ▾]     [Call] [Message] [Assign] [⋯]      │
│ Received today 08:55 via Portal (PropertyPro) · Enquiry: LST-…0102 2-bed, Osu         │
│ ┌ Message ──────────────────────────────┐ ┌ Score 62 / 100 ───────────────────────────┐│
│ │ "Is the flat still available? I can   │ │ Budget stated            +20              ││
│ │  view this weekend."                  │ │ Move date within 60 days +20              ││
│ └───────────────────────────────────────┘ │ Responded to call        +22              ││
│ ┌ Contact ──────────────────────────────┐ │ Rules → Settings (CRM-07)                 ││
│ │ +233 20 ••• 7781 · WhatsApp preferred │ └───────────────────────────────────────────┘│
│ │ Open contact → C-2                    │ ┌ Next action ──────────────────────────────┐│
│ └───────────────────────────────────────┘ │ None scheduled ⚠ [+ Follow-up]            ││
│ [Activity] [Status history] [Assignments]  └───────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Data | `leads` + contact summary + `lead_status_history` + `lead_assignments` + activities linked to the lead |
| Actions | Status change (L-4 rules); Assign (L-4); Call/Message then A-2 (first logged contact sets `first_response_at` if empty); + Follow-up (F-1, sets `next_action_at`); ⋯ Archive |
| States | Score panel appears only when the company has scoring rules; the breakdown is always shown with the score (no opaque scores, CRM-07). Converted: links to the Phase 6 deal |
| Security | Status changes and reassignments write history rows with who and when |

### L-3 New lead (quick capture)

```text
┌ New lead ─────────────────────────────────────────────────────────────────────────┐
│ Contact  [Search existing… or type a new name / phone]  ✓ Matched: Ama Owusu       │
│ Type * [Rent ▾]   Source * [Walk-in ▾]  Detail [            ]                      │
│ Enquiry about listing [LST-… ▾] (optional)                                         │
│ Message [                                                       ]                  │
│ Assign to [Me ▾]   Office [Osu ▾]                                                  │
│                                                    [Cancel] [Create lead]          │
└────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | `lead.create`; creating a new contact inline also needs `contact.create` |
| Actions | `POST /api/v1/leads` with either `contactId` or an inline contact (runs the C-3 duplicate check first) |
| Security | Assign-to list contains only members the user may assign to (`lead.assign`), otherwise fixed to "Me" |

### L-4 Assign, qualify, mark lost, convert

| Dialog | Fields | Rules |
|---|---|---|
| Assign | Agent (scoped list), note | `lead.assign`; writes `lead_assignments` with `assigned_by` |
| Change status | New status; note | Allowed transitions shown only; `lost` needs a `lost_reason_code` (DB check) |
| Mark unqualified | Reason | Moves out of the inbox; reversible by a manager |
| Convert | Phase 6 | Creates a deal; hidden until Phase 6 |

## 7. Activity timeline and follow-up

### A-1 Activity timeline

```text
┌ Activity ── [All ▾] [Calls] [Messages] [Meetings] [Notes] [System] ── [Search in…] ──┐
│ Today                                                                                 │
│ ☎ 09:41 Call · outbound · 6 min · Grace                                               │
│   Outcome: Interested, wants evening viewings · Linked: LEA-…0412, LST-…0102          │
│ ✎ 09:20 Note · Grace  "Prefers WhatsApp after 6 pm"                                   │
│ Yesterday                                                                             │
│ ⚙ 16:02 System · Marketing consent withdrawn (email) via portal                      │
│ ✉ 11:15 WhatsApp · inbound · logged by Kofi  "Thanks, I will confirm…"                │
│ [Load older]                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | One history that follows the person across roles, leads and (later) deals (CRM-04) |
| Data | `activities` joined through `activity_links` for the contact, its leads and (Phase 6) deals, newest first, keyset-paged |
| Actions | Filter by type; open linked records; edit own note within the edit window (D5); no deletion (archival with reason, as for property notes) |
| States | System rows (status change, consent, merge) cannot be edited. Same-time entries are ordered by a stable sequence (#15) |
| Security | Activity bodies may contain personal data; they are covered by RLS and storage encryption, not field encryption (ADR-007 §4, risk R-3) |

### A-2 Log activity

```text
┌ Log activity ──────────────────────────────────────────────────────────────────────┐
│ Type (•) Call ( ) Meeting ( ) WhatsApp ( ) SMS ( ) Email ( ) Note                    │
│ Direction (•) Outbound ( ) Inbound      When [Today 09:41]   Duration [6] min        │
│ Outcome [Interested ▾]                                                               │
│ Notes [                                                                    ]         │
│ Linked to: Ama Owusu ✕  LEA-…0412 ✕  [+ link listing/property]                      │
│ ☑ Schedule a follow-up → F-1                                                         │
│                                                          [Cancel] [Save]             │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Actions | `POST /api/v1/activities` with links; if linked to a lead with no `first_response_at` and the activity is outbound contact, the server sets it |
| Security | Phase 5 records communications; it does not send them (SMS, WhatsApp and email sending are Phase 12, CRM-10) |

### F-1 Schedule follow-up

```text
┌ Schedule follow-up ─────────────────────────────────────────────────────────────────┐
│ What * [Call back about East Legon options              ]  Type [Call ▾]            │
│ When * [Tomorrow ▾] [10:00]  (Africa/Accra)    Remind [15 min before ▾]             │
│ Assign to [Me ▾]   Priority [Normal ▾]                                              │
│ About   Ama Owusu (contact) · LEA-…0412 (lead)                                      │
│                                                         [Cancel] [Schedule]         │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Roles | Own follow-ups: anyone with CRM access to the record. Assign to others: `lead.assign` or manager scope (D6) |
| Data / Actions | `POST /api/v1/tasks` (`task_type`, `due_at`, `remind_at`, `assigned_to`, `entity_type`, `entity_id`); also updates `leads.next_action_at` when about a lead |
| States | Quick picks (Later today, Tomorrow, Next week) are computed in the office timezone. Reminder delivery is in-app in Phase 5; push, email and SMS reminders are Phase 12 |
| Security | `tasks.entity_type` supports one entity; the contact is reached through the lead (schema note G4) |

### F-2 Follow-ups list

```text
┌ Follow-ups ── [Mine] [Team] ── [Overdue 3] [Today 7] [This week 19] [Done] ──────────┐
│ Due ▲         What                               About              Assigned  Prio   │
│ ⚠ Yesterday   Call back about East Legon options  Ama Owusu · LEA…   Grace     High  │
│ Today 14:00   Send valuation                      Kwame Mensah       Kofi      Normal│
│ [Done] [Reschedule] [Reassign]                                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Data | `tasks` open by `due_at` (`tasks_my_open_idx`); Team tab in the manager's scope |
| Actions | Done (`completed_at`, `completed_by`); Reschedule (F-1); Reassign (manager) |

## 8. Mobile (≤ 767 px)

```text
XM-1 My day                 XM-2 Contact                 XM-3 After call               XM-4 New lead
┌────────────────────┐      ┌────────────────────┐       ┌────────────────────┐        ┌────────────────────┐
│ My day · Tue 3 Nov │      │ ← Ama Owusu        │       │ Call ended · 6 min │        │ New lead           │
│ ⚠ 09:30 Follow-up  │      │ Buyer · Landlord   │       │ Ama Owusu          │        │ Phone / name       │
│ Call Ama Owusu     │      │ [☎ Call][💬 Msg]    │       │ Outcome            │        │ [+233 24…      ]   │
│ [Call] [Done]      │      │ [+ Follow-up]      │       │ (•) Interested     │        │ ✓ Ama Owusu found  │
│ 10:00 New lead     │      │ Next: today 09:30  │       │ ( ) No answer      │        │ Type [Rent ▾]      │
│ Yaw Adjei · Portal │      │ ▸ Details          │       │ ( ) Call back      │        │ Source [Walk-in ▾] │
│ [Call] [Open]      │      │ ▸ Requirements (1) │       │ Note [          ]  │        │ Message [       ]  │
│ ── Waiting on me ─ │      │ ▸ Activity         │       │ ☑ Follow-up tmrw   │        │                    │
│ New leads 2 ›      │      │ ▸ Consent          │       │ [Save]             │        │ [Create lead]      │
├────────────────────┤      └────────────────────┘       └────────────────────┘        └────────────────────┘
│ Day  Leads  +  Contacts  More │
└────────────────────┘
```

| | |
|---|---|
| Rules | Bottom bar: My day · Leads · + (create) · Contacts · More. Primary actions are thumb-reachable at the bottom; touch targets ≥ 44 × 44 px (WCAG 2.5.8 needs ≥ 24 px; we keep the Phase 4 44 px rule) |
| XM-3 | Shown when the user returns to the app after a `tel:` call started from EstatePro; dismissible; never auto-saves |
| Offline | Phase 5 is online-only. Without a connection, forms keep their input and show "Not saved: no connection. Retry" (no silent queueing) |
| Security | No sensitive details (C-5) on mobile in Phase 5; the panel shows "Open on a computer to reveal" |

## 9. Tablet (768–1023 px)

| Screen | Layout |
|---|---|
| TM-1 Contact record | Left: header, methods, roles; right: tabs. Timeline full height |
| TM-2 Lead inbox | Two-pane: list on the left, L-2 on the right; selection keeps scroll position |
| Dashboards | Two columns; tables keep three columns with row expansion (Phase 3 06 §12) |
| Forms | Single column, max width 640 px; dialogs become side sheets |

## 10. Accessibility (WCAG 2.2 AA, ADR-002)

| Area | Requirement |
|---|---|
| Structure | One `h1` per page; panels are `section` with headings; dashboards have a "Skip to panel" list |
| Tables | Real `table` with `th scope`; sortable headers are buttons with `aria-sort`; row actions have names including the row ("Call Ama Owusu") |
| Timeline | An ordered list (`ol`) with each entry's type in text, not only the icon; "Load older" moves focus to the first new entry |
| Status | Overdue, past-SLA, consent and identity states use icon **and** text, never colour alone (1.4.1) |
| Forms | Visible labels; errors summarised at the top with links, and inline (Phase 4 pattern); phone fields accept any format |
| Dialogs | Focus trapped and returned; Escape closes; reveal dialog announces "Value hidden" when the timer ends (`aria-live="polite"`) |
| 2.2-specific | 2.4.11 focus not obscured by the sticky header or bottom bar (scroll padding); 2.5.8 target size; 3.3.7 redundant entry: inline new contact in L-3 carries the typed phone into C-3; 3.3.8 accessible authentication: step-up uses the identity provider, which must allow paste and passkeys (IDP-EVALUATION R10) |
| Motion | No auto-refresh; "Now" marker does not animate |
| Testing | Automated axe on every screen and state (Phase 4 harness) plus the manual screen-reader pass (#24) on D-M, C-2, L-2 and A-2 |

## 11. Right-to-left and multilingual (Arabic)

| Area | Requirement |
|---|---|
| Layout | Logical properties only (Phase 4 rule); the sidebar, drawers and timeline mirror; icons with direction (←, ›) mirror; ☎ and charts do not |
| Names | `display_name_local` shown alongside `display_name` (e.g. "أحمد الكواري (Ahmed Al-Kuwari)"); each in its own element with `dir="auto"` and `lang` when known |
| Mixed text | Phone numbers, references and emails are isolated (`<bdi>`, `dir="ltr"`) so `+974 55 …` does not reorder inside Arabic text |
| Numbers and dates | Formatted with the user's locale (`Intl`), Gregorian calendar by default (audit AS-4); digits follow the locale setting |
| Search | Matches Arabic and Latin names (`search_vector` includes `display_name_local`); Arabic normalisation (alef and ya variants) is gap G5 |
| Copy | All strings in message files; Arabic copy reviewed by a native speaker before release (#25) |
| Testing | Every screen in `ar` at 320 px and desktop in the e2e suite (Phase 4 harness) |

## 12. Out of scope for these wireframes

- Deals, pipeline board, viewings and offers (Phase 6).
- Portal screens for landlords and tenants (Phase 7); only the staff-side preview in LL-1 is in Phase 5.
- Sending email, SMS or WhatsApp, and mailbox sync (Phase 12, CRM-10).
- Bank and mobile-money details entry (Phase 7/9); C-5 shows them read-only once they exist.

## Approval

| Item | Decision |
|---|---|
| Wireframes D-A, D-C, D-M, C-1 to C-6, B-1, B-2, SE-1, LL-1, L-1 to L-4, A-1, A-2, F-1, F-2, XM-1 to XM-4, TM-1, TM-2 | ✅ Approved |
| Decisions D1–D7 in the verification report §5 | ✅ Recorded in the verification report §5 |
| Approved by / date | Product owner (@jtechstudio2-png), 1 November 2026 |
