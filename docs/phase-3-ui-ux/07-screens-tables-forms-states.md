# 07 — Screens, Data Tables, Forms, Filters, Empty and Error States

This document completes the wireframe set in [03](./03-wireframes-and-user-flows.md) and specifies the behaviour every table, form, filter, empty state and error state must follow. Field names refer to the Phase 2 schema.

## 1. Record page pattern

Every record (property, unit, contact, listing, lease, deal, work order) uses the same layout so users learn it once:

```text
┌ ‹ Back to Leases   LSE-2026-000001 · Flat 1A, Osu Court        [Primary action] [⋯] ┐
│ Active · Renewal: pending decision         Tenant: Abena Darko · Landlord: Kofi Owusu │
├──────────────────────────────────────────────────────────┬───────────────────────────┤
│ [Overview] [Charges & payments] [Documents] [Activity]   │ Key facts                 │
│                                                          │ Rent  GH₵6,000 / month    │
│ Tab content                                              │ Due   1st · Advance 12 mo │
│                                                          │ Ends  31 Dec 2026 (78 d)  │
│                                                          │ Deposit GH₵6,000 · held   │
│                                                          │ Next  Renewal decision    │
│                                                          ├───────────────────────────┤
│                                                          │ Open tasks (2)            │
│                                                          │ History (status changes)  │
└──────────────────────────────────────────────────────────┴───────────────────────────┘
```

- **Header:** reference, human name, status label(s), the key parties, one primary action that depends on state (e.g. *Activate*, *Record renewal decision*, *Record payment*) and an overflow menu for the rest.
- **Side panel:** facts needed for decisions, open tasks and the status history (from the `*_status_history` tables). On tablet and mobile it moves above the tabs, collapsed to three lines.
- **Tabs** load on demand; the URL holds the tab so links and Back work.
- **Audit:** every record has an "Activity" tab combining `activities` and `audit_logs` for that entity.

## 2. Additional wireframes

### 2.1 Desktop: receipt allocation (Accountant)

```text
┌ Allocate receipt RCT-2026-000118 ─────────────────────────────────────────────────────┐
│ Payer: Abena Darko  · Method: Post-dated cheque 000123 · Cleared 2 Jan 2026            │
│ Amount GH₵9,000.00   Allocated GH₵0.00   Remaining GH₵9,000.00                         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Outstanding charges — LSE-2026-000001 (GHS only)          [Allocate oldest first]      │
│ Due        Description          Total      Outstanding   Allocate                      │
│ 01 Jan     Rent January 2026    6,000.00   6,000.00      [ 6,000.00 ]                   │
│ 01 Feb     Rent February 2026   6,000.00   6,000.00      [ 3,000.00 ]                   │
│                                              Allocating  9,000.00 · Remaining 0.00     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ Charges in other currencies are not shown and cannot be paid from this receipt.        │
│                                                        [Cancel]   [Confirm allocation] │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Inputs cannot exceed either remaining balance (the database also rejects it). *Allocate oldest first* fills amounts by due date. Confirmation is one transaction; on conflict (someone allocated at the same time) the screen reloads balances and explains why.

### 2.2 Desktop: work order

```text
┌ WO-2026-000044 · Emergency · Plumbing · Flat 1A, Osu Court        [Assign] [⋯] ┐
│ Reported 08:12 by Abena Darko (tenant portal) · Response due 10:12 (−0h40 ⚠)   │
├───────────────────────────────────────────────────────┬────────────────────────┤
│ Description                                           │ Status: Reported       │
│ Water leaking under kitchen sink, floor wet.          │ Priority: Emergency    │
│ Photos (3)  [▢][▢][▢]                                 │ Approval: not required │
│ Access: tenant home after 17:00 · permission ✓        │ Cost to: —             │
├───────────────────────────────────────────────────────┤ Landlord limit GH₵1,500│
│ Updates   [Internal ▾]                                │ Assigned: —            │
│ 08:12 Tenant: "Started this morning" (tenant-visible) │ SLA history            │
│ [Add update… ] [Visible to: Internal ▾] [Post]        │                        │
└───────────────────────────────────────────────────────┴────────────────────────┘
```

The visibility selector on every update (`maintenance_updates.visibility`) shows who will read it. Posting a tenant-visible update triggers a notification to the tenant.

### 2.3 Desktop: listing editor with two languages

```text
┌ Listing LST-2026-000001 · Rent · Draft                       [Save] [Publish ▾]┐
│ Price [GH₵ ▾][ 6,000.00 ] per [Month ▾]   Advance [12] months   Deposit [6,000]│
│ Available from [01 Apr 2026]   Mandate [Sole agency ▾] expires [30 Jun 2026]   │
├──────────────────────────────────────┬─────────────────────────────────────────┤
│ English (default)                    │ العربية                       (RTL)    │
│ Title [2-bed apartment, Osu      ]   │ [                         ] العنوان     │
│ Description                          │ الوصف                                   │
│ [                                ]   │ [                                ]      │
│ [Draft with EstateAI] (review required)                                         │
├──────────────────────────────────────┴─────────────────────────────────────────┤
│ Publishing checklist: ✓ 8 photos  ✓ floor plan  ✗ safety certificate (required) │
└────────────────────────────────────────────────────────────────────────────────┘
```

*Publish* is disabled while a blocking required document is missing (`required_document_rules.blocking_stage`), with the reason shown next to the button.

### 2.4 Desktop: users and roles (Admin)

```text
┌ Users & roles ───────────────────────────────────────────── [Invite user] ┐
│ [Staff] [Portal users] [Invitations (2)]   Search…   [Role ▾] [Office ▾]   │
│ Name           Role               Offices     MFA   Last sign-in  Status   │
│ Esi Boateng    Accountant         All         ✓     Today 08:01   Active   │
│ Kwame Asante   Agent              Osu         ✗ ⚠   Yesterday     Active   │
│                                                    [Require MFA] [Deactivate]│
└────────────────────────────────────────────────────────────────────────────┘
```

Deactivation asks for confirmation, ends the membership and revokes every session at once. Changing a role shows the permission differences before saving.

### 2.5 Tablet: move-in / move-out inspection

```text
┌ Inspection INS-2026-000012 · Move-out · Flat 1A ──────── [Save] [Finish] ┐
│ Rooms: [Kitchen ✓] [Living ✓] [Bedroom 1 ●] [Bedroom 2] [Bathroom]        │
├───────────────────────────────────────────────────────────────────────────┤
│ Bedroom 1                         Move-in condition (12 Jan 2026)         │
│ Walls      [Good ▾] [Clean ▾]     Good · Clean                             │
│ Flooring   [Damaged ▾] ⚠          Good · Clean     [📷 Add photo] (2)       │
│ Notes [Scratches near window, ~40 cm                                   ]  │
│ ☐ Action required                                                        │
└───────────────────────────────────────────────────────────────────────────┘
```

Each item shows the move-in condition beside it, so deposit deductions have evidence. Photos upload in the background; the item saves even if an upload is still pending, and the inspection cannot be finished until uploads complete.

### 2.6 Mobile: technician job

```text
┌─────────────────────────────┐
│ ‹ My jobs   WO-…-0044       │
│ Emergency · Plumbing        │
│ Flat 1A, Osu Court          │
│ Due 10:12 (in 25 min)       │
│ [Call tenant] [Directions]  │
├─────────────────────────────┤
│ Leak under kitchen sink     │
│ Access after 17:00 ✓ entry  │
│ Photos (3) ›                │
├─────────────────────────────┤
│ Status: Assigned            │
│ [ Start job ]               │
├─────────────────────────────┤
│ Add update · Add photo ·    │
│ Record time & materials     │
└─────────────────────────────┘
```

One large primary button follows the lifecycle: *Start job* → *Mark complete* (needs a note and at least one photo when the company requires it). Contact details shown are limited to what the job needs.

### 2.7 Mobile: landlord quote approval

```text
┌─────────────────────────────┐
│ Approval needed             │
│ Flat 1C · Air conditioning  │
│ Quote: GH₵2,400.00          │
│ Your approval limit: 1,500  │
│ Supplier: CoolAir Ltd       │
│ [View quote PDF]            │
│ Reason from manager:        │
│ "Compressor failed; unit…"  │
├─────────────────────────────┤
│ [ Approve ]  [ Reject… ]    │
└─────────────────────────────┘
```

Rejecting asks for a reason. Both outcomes are recorded on the work order and in the audit log.

## 3. Data tables

| Aspect | Specification |
|---|---|
| Columns | The record identifier (reference + name) is first and stays fixed when scrolling horizontally; status second; actions last. Users can show, hide and reorder columns, and save them in a view. |
| Row height | 48 px default; compact 40 px as a per-user preference (desktop only). |
| Numbers | Right-aligned, tabular numerals, currency code or symbol on every amount; negative amounts in parentheses with a minus for screen readers. |
| Dates | Relative for near dates ("in 3 d", "2 h ago") with the absolute date in a tooltip and for screen readers; absolute for anything older than 7 days. |
| Sorting | Single-column sort by header click; the default sort is task-relevant (overdue first, then due date) and is stated above the table ("Sorted by: Due date"). |
| Pagination | Server-side, cursor-based; 50 rows default (25/50/100); the total is shown when cheap to compute ("1–50 of 1,240"), otherwise "50+". |
| Selection and bulk actions | Checkbox column; a bulk action bar appears with the number selected and only the actions valid for all selected rows (e.g. reassign, export, archive). Destructive bulk actions need confirmation naming the count. |
| Row actions | One primary action visible per row; the rest in a ⋯ menu. No hover-only actions. |
| Row click | Opens the record; Ctrl/Cmd-click opens a new tab. |
| Export | CSV/XLSX of the current filters and columns, subject to the export permission; large exports run as `export_jobs` and notify when ready. |
| Loading | Skeleton rows for the first load; on refresh the old rows stay visible with a progress bar, so the page does not jump. |
| Mobile | Becomes a list of cards with the identifier, status and two key fields; one action per card. |

## 4. Forms

| Aspect | Specification |
|---|---|
| Layout | One column by default; two columns only for short, related fields (e.g. start and end date). Sections with headings; long forms get a section index on desktop. |
| Labels | Above the field, always visible (no placeholder-only labels). Required fields are marked "Required"; optional fields are not marked. |
| Defaults | Prefilled from context: office currency and timezone, property jurisdiction, the record you came from (creating a viewing from a listing fills the listing and unit). |
| Money | `MoneyInput` = currency selector + amount; the amount is formatted on blur in the user's locale; the stored value is never a float. |
| Phone | Country code selector defaulting to the office country + national number, normalised to E.164; WhatsApp checkbox. |
| Address | Fields generated from `countries.address_format`, in that country's order and labels; country-specific parts (digital address, zone/street/building) included. |
| Dates and times | Date picker with typing allowed; times show the timezone they are in when it differs from the user's. |
| Picklists | Searchable combobox when there are more than 7 options; options filtered by country; companies' own values appear with the platform values. |
| Validation | On blur for format; on submit for everything; server errors are mapped back to the field. A summary at the top lists errors with links to each field. Entered values are never cleared. |
| Duplicates | Creating a contact or property checks for likely duplicates (same phone, email, ID hash, address) before saving and offers "Open existing". |
| Saving | Explicit Save; drafts kept for long forms (listing, lease). Optimistic locking: if `version` changed, show "Kwame updated this lease at 10:14" with a field-by-field comparison and the options to reload or overwrite only the fields you changed. |
| Leaving | A warning before leaving with unsaved changes. |
| Consequential actions | Activating a lease, posting/reversing finance entries, approving payouts, locking periods: a confirmation dialog that restates what will happen with the amounts, and step-up MFA where the permission is marked sensitive. |
| Sensitive fields | Bank, mobile-money and ID numbers display masked (•••• 4567); "Reveal" needs `contact.view_sensitive` and is written to the audit log. |

## 5. Filters

- **Filter bar** above every list: the most-used 3–4 filters visible (e.g. Status, Office, Assigned to, Date range); "More filters" opens a side panel with the rest.
- **Active filters** show as removable chips with "Clear all". The result count updates as filters change.
- **Saved views**: users save a filter + column + sort combination with a name; administrators can publish company-wide views (e.g. "Arrears > 60 days"). The default view is per user.
- **URL state**: filters are in the URL, so a filtered list can be bookmarked or shared with a colleague who has the same access.
- **Back navigation** returns to the same filters, sort, page and scroll position.
- **Date filters** offer presets (Today, Next 7 days, This month, Last month, Custom) evaluated in the office timezone.
- **Scope filter** (Mine / Team / Office / All) is always first and only offers scopes the role allows.
- **Filters never reveal hidden data**: options are built only from records the user can see (e.g. agent names in an agent filter).

## 6. Empty states

An empty state says why there is nothing and offers the next useful action. It never shows sample or fake records.

| Situation | Message (example) | Action |
|---|---|---|
| First use, no records yet | "No properties yet. Add your first property, or import a spreadsheet of existing ones." | Add property · Import CSV · Download template |
| Filters return nothing | "No leases match these filters." + list of active filters | Clear filters · Remove the last filter |
| Search returns nothing | "No records match 'Osu Cort'." | Suggestions: check spelling, search by reference or phone |
| Queue is clear | "No arrears today. All posted charges due before 15 Mar are paid." | — (a positive, factual statement) |
| Not configured | "Deposit protection deadlines are not set for Ghana. Ask an administrator to add them in Settings → Jurisdiction rules." | Link for administrators only |
| No permission to any rows | "You don't have access to any landlord statements. Contact your office administrator." | — |
| Portal with nothing shared | "No documents have been shared with you yet." | — |

## 7. Error states

| Error | What the user sees | Behaviour |
|---|---|---|
| Field validation (422) | Message next to the field and in the summary, in plain language ("End date must be on or after the start date") | Values kept; focus moves to the summary |
| Business rule conflict (409, e.g. overlapping lease, double-booked viewing, duplicate period charge) | A specific explanation with a link to the conflicting record ("Flat 1A already has an active lease LSE-2026-000001 until 31 Dec 2026") | Nothing saved; offer the valid alternative (e.g. start the renewal on 1 Jan 2027) |
| Concurrent edit (412) | "This record changed while you were editing" with a comparison | Reload or re-apply your changes |
| Locked period | "January 2026 is locked. Post this entry in an open period or ask the accountant to reopen January." | Date field highlighted |
| Permission denied (403) | "You don't have permission to approve payouts." | The action is normally hidden; this appears only on direct links. Logged. |
| Not found / no access (404) | "This record doesn't exist or you don't have access to it." | One message for both, so record existence isn't revealed |
| Session expired | A dialog to sign in again in place | The unsaved form is kept and resubmitted after sign-in |
| Network failure | A bar: "You're offline. Changes will not be saved until you reconnect." | Writes are blocked, not queued silently; drafts stay in the form |
| Server error (5xx) | "Something went wrong on our side. Your changes were not saved. Try again." + reference ID (correlation ID) | Retry is safe because money writes use idempotency keys |
| Upload failure / malware found | "Lease.pdf could not be uploaded (failed security scan). Upload a different file." | The file is never shown as available |
| Partial panel failure on dashboards | The failed panel shows "Couldn't load arrears. Retry" | Other panels keep working |

Error text never exposes SQL, stack traces or internal identifiers other than the reference ID for support.

## 8. Keyboard shortcuts (desktop)

| Keys | Action |
|---|---|
| `/` or `Ctrl/Cmd + K` | Global search |
| `C` then a letter | Create: `C L` lead, `C C` contact, `C P` property, `C V` viewing, `C M` maintenance request, `C R` receipt |
| `G` then a letter | Go to: `G W` work queue, `G P` properties, `G S` sales pipeline, `G L` leases, `G M` maintenance, `G F` finance |
| `J` / `K` | Next / previous row in a list |
| `E` | Edit the open record |
| `Ctrl/Cmd + S` | Save |
| `?` | Shortcut reference |

Shortcuts are single-key only outside text inputs, can be turned off per user (WCAG 2.1.4), and every shortcut has a visible button equivalent.
