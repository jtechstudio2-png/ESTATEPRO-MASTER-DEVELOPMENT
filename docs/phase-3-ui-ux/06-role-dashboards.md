# 06 — Role-specific Dashboards

Six operational dashboards (Property, CRM, Rent, Maintenance, Finance, Admin) plus the portal and technician home screens. Each dashboard is a set of **work panels**, not a wall of KPIs.

## 1. Rules for every dashboard

1. **Every panel answers a named operational question** and leads to an action. If nobody would act on a number, the panel is not built.
2. **Every number is a link** to the filtered list that produced it. No dead-end figures.
3. **Counts come from real queries** on the Phase 2 schema (named per panel below). Nothing is estimated, sampled or filled with placeholder data.
4. **Scope is always visible**: "My work", "Osu office", or "All offices", with a switcher limited to what the role may see.
5. **Money is never summed across currencies.** A company with GHS and QAR shows one line per currency. Converted totals appear only in reports, labelled with the rate source and date.
6. **Dates are business dates in the property's or office's timezone**; "today" means today in that office.
7. **Layout**: a 12-column grid on desktop; panels are tables or lists first, with charts only where a trend answers the question. Two charts at most per dashboard.
8. **Loading** is per panel (one slow panel never blocks the page). **Empty** and **error** states follow [07 §6](./07-screens-tables-forms-states.md#6-empty-states).
9. **Refresh**: data is fetched on load and on return to the tab; there is no auto-refresh that moves rows while someone reads them. A "Updated 09:42 · Refresh" line shows freshness.

## 2. Role-to-dashboard map

| Dashboard | Primary users | Also visible to |
|---|---|---|
| Property | Property Manager, Sales Manager | Company Owner, Office Administrator |
| CRM | Sales Manager, Agent (own scope) | Company Owner, Office Administrator |
| Rent | Property Manager, Accountant | Company Owner, Office Administrator (read) |
| Maintenance | Property Manager | Company Owner, Office Administrator |
| Finance | Accountant | Company Owner; Office Administrator (read) |
| Admin | Company Owner, Office Administrator | — |
| My day (agent home) | Agent | — |
| My jobs | Maintenance Staff | — |
| Landlord home / Tenant home | Portal users | — |

## 3. Property dashboard

**Question:** what in the portfolio needs attention, and what is not earning?

```text
┌ Property dashboard ─────────── [Osu office ▾] [Rent | Sale | Both] ── Updated 09:42 ⟳ ┐
│ ┌ Vacant units ──────────────────┐ ┌ Listings needing attention ──────────────────────┐ │
│ │ Unit          Vacant  Asking   │ │ Issue                    Count                   │ │
│ │ Flat 2B Osu   41 d    GH₵2,000 │ │ No photos / < 5 photos     4 →                   │ │
│ │ Shop 3 Lekki  18 d    GH₵9,500 │ │ Mandate expires ≤ 14 days  2 →                   │ │
│ │ … 12 more →                    │ │ No viewing in 21 days      6 →                   │ │
│ └────────────────────────────────┘ │ Price unchanged 60 days    3 →                   │ │
│ ┌ Under maintenance ─────────────┐ │ Missing required document  5 →                   │ │
│ │ Unit       Since   Work order  │ └──────────────────────────────────────────────────┘ │
│ │ Flat 1C    6 d     WO-…-0031 → │ ┌ Occupancy by property (managed) ─────────────────┐ │
│ └────────────────────────────────┘ │ Property     Units  Let  Vacant  Occupancy       │ │
│                                    │ Osu Court      12    10     2    83%             │ │
│                                    └──────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Panel | Data source | Click-through |
|---|---|---|
| Vacant units (longest first) | `units` without a live `leases` row; days since last lease `move_out_date` or listing `listed_at`; open rent `listings.price` | Unit record → Create/refresh listing |
| Listings needing attention | `listings` live + counts of `property_media`, `mandate_expires_on`, latest `viewings.scheduled_start`, `listing_price_history`, `required_document_rules` vs `document_links` | Filtered listings list |
| Under maintenance | `units.availability = 'under_maintenance'` with open `maintenance_requests` | Work order |
| Occupancy by property | Units with a live lease ÷ rentable units (excluding `owner_occupied` / `unavailable`) | Property → Units tab |

## 4. CRM dashboard

**Question:** are enquiries answered quickly, and is anyone's follow-up slipping?

```text
┌ CRM dashboard ────────────── [My work | Team ▾] [Last 30 days ▾] ────── Updated 09:42 ⟳ ┐
│ ┌ New leads not yet contacted ───────────────────┐ ┌ Follow-ups due ───────────────────┐ │
│ │ Received  Contact        Source   Owner   Age  │ │ Today 7 →  Overdue 3 →            │ │
│ │ 08:55     Yaw Adjei      Portal   —       47m  │ └───────────────────────────────────┘ │
│ │ 08:10     Sarah K.       Website  Grace   1h32 │ ┌ Viewings needing feedback ────────┐ │
│ │ [Assign]  [Call]                               │ │ 4 viewings ended, no outcome →    │ │
│ └────────────────────────────────────────────────┘ └───────────────────────────────────┘ │
│ ┌ Response time (team, last 30 days) ──────────────────────────────────────────────────┐ │
│ │ Agent    Leads  Median first response  Within SLA   Converted to deal               │ │
│ │ Grace      34   22 min                  91%          6                              │ │
│ └──────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Leads by source (last 30 days) ── table: source · leads · qualified · converted ────┐ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Panel | Data source | Click-through |
|---|---|---|
| New leads not yet contacted | `leads.status = 'new'`, `first_response_at IS NULL` (index `leads_unassigned_idx` / `leads_queue_idx`) | Lead → Assign / Call / Log contact |
| Follow-ups due | `tasks` open, `due_at` today / past (index `tasks_my_open_idx`) | Task list |
| Viewings needing feedback | `viewings` scheduled/confirmed with `scheduled_end` in the past (`viewings_feedback_due_idx`) | Viewing → Record outcome |
| Response time by agent | `leads.first_response_at − received_at`; SLA from company setting | Agent's lead list |
| Leads by source | `leads.source_code` → status counts, conversion via `converted_deal_id` | Filtered leads |

Agents see the same layout limited to their own records, without the per-agent table.

## 5. Pipeline board (Sales)

The pipeline is a page under Sales rather than a dashboard, but the Sales Manager lands on it.

```text
┌ Sales pipeline ─ [Sale ▾] [Team ▾] [Expected close: this quarter ▾] ──── [List view] ┐
│ Lead (12)    Qualification (9)  Viewing (7)   Negotiation (5)  Offer acc. (3) Contract (2)│
│ GH₵…         GH₵…               GH₵…          GH₵…             GH₵…           GH₵…        │
│ ┌──────────┐ ┌──────────┐       ┌──────────┐  ┌──────────┐ ⚠ stalled 16 d               │
│ │DEA-…-014 │ │ …        │       │ …        │  │DEA-…-009 │                               │
│ │Yaw Adjei │                                  │Offer GH₵420k vs GH₵450k │               │
│ │Grace · 3d│                                  │Grace · close Nov        │               │
│ └──────────┘                                  └──────────┘                               │
│ Forecast (weighted, this quarter): GH₵1,240,000 · QAR 3,100,000  [How is this calculated?]│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- Columns are `pipeline_stages` for the chosen deal type, ordered by `sort_order`; totals per column are per currency.
- Stalled flag: time in stage (`stage_entered_at`) beyond `pipeline_stages.stall_after_days`.
- Moving a card opens the stage-change dialog when the target stage needs data (lost reason; accepted offer; milestones). Drag is optional: every card also has a "Move to…" menu for keyboard and touch users.
- The forecast is Σ `expected_value` × (probability override or stage probability) for open deals with `expected_close_date` in range, shown per currency with the formula one click away.

## 6. Rent dashboard

**Question:** what money is due or late, and which leases need a decision?

```text
┌ Rent dashboard ─────────── [All offices ▾] [As of 15 Mar 2026] ─────── Updated 09:42 ⟳ ┐
│ ┌ Arrears ageing ─────────────────────────────────────────────────────────────────────┐ │
│ │ Currency  1–30 d     31–60 d    61–90 d    90+ d     Total       Leases            │ │
│ │ GHS       12,400 →   4,000 →    6,000 →    0         22,400 →    7 →               │ │
│ │ QAR       0          8,500 →    0          15,000 →  23,500 →    2 →               │ │
│ └─────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Due in next 7 days ────────────┐ ┌ Leases ending ───────────────────────────────────┐ │
│ │ 18 charges · GH₵96,000 →       │ │ ≤ 30 d: 2 (no decision 1) →  31–60 d: 4 →  61–90: 5│ │
│ └────────────────────────────────┘ └──────────────────────────────────────────────────┘ │
│ ┌ Post-dated cheques to bank ────┐ ┌ Deposits to protect ┐ ┌ Unallocated receipts ────┐ │
│ │ Due ≤ 3 days: 6 →              │ │ Deadline ≤ 7 d: 1 → │ │ 3 receipts · GH₵14,200 → │ │
│ └────────────────────────────────┘ └─────────────────────┘ └──────────────────────────┘ │
│ ┌ Rent reviews due ≤ 60 d: 3 → ┐ ┌ Arrears actions due today: 2 → ┐                     │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Panel | Data source | Click-through |
|---|---|---|
| Arrears ageing | `app.lease_arrears(as_of)` per currency | Arrears list filtered by bucket → Lease → Record action |
| Due in next 7 days | `rent_charges` posted, `due_date` in range (`rent_charges_due_idx`) | Charges list |
| Leases ending | `leases` active/notice_given by `end_date` (`leases_expiry_idx`); "no decision" = `renewal_status` in `not_due`/`pending_decision` | Renewals list → Lease |
| Post-dated cheques to bank | `payments.status = 'pending'` by `instrument_date` (`payments_pending_instruments_idx`) | Cheque list → Mark deposited / cleared / bounced |
| Deposits to protect | `deposits` expected/held with `protection_deadline` (only shown where the jurisdiction setting exists) | Deposit → Record protection |
| Unallocated receipts | Cleared `payments` with allocated sum < amount | Allocation screen |
| Rent reviews due | `rent_reviews` scheduled/proposed by `review_date` | Rent review |
| Arrears actions due | `arrears_actions.next_action_date` ≤ today | Lease arrears tab |

The "As of" date defaults to today in the office timezone and can be changed, so month-end figures can be reproduced.

## 7. Maintenance dashboard

**Question:** which jobs are breaching or about to breach their SLA, and what is waiting on someone else?

```text
┌ Maintenance ───────────── [Osu office ▾] [All priorities ▾] ──────────── Updated 09:42 ⟳ ┐
│ ┌ SLA risk ─────────────────────────────────────────────────────────────────────────────┐ │
│ │ Ref        Priority   Unit        Category    Status       Due in     Assigned       │ │
│ │ WO-…-0044  Emergency  Flat 1A     Plumbing    Reported     −0h40 ⚠   —   [Assign]    │ │
│ │ WO-…-0039  Urgent     Shop 3      Electrical  In progress  5h        Yaw              │ │
│ └───────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Unassigned 3 → ┐ ┌ Awaiting landlord approval 2 → ┐ ┌ On hold 4 → ┐ ┌ Completed, not closed 5 → ┐│
│ ┌ SLA performance (last 90 days) ── priority · jobs · response met · resolution met · median ┐│
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

| Panel | Data source | Click-through |
|---|---|---|
| SLA risk (breached first, then within 25% of target) | Open `maintenance_requests` by `response_due_at` / `resolution_due_at` (`maintenance_open_queue_idx`) | Work order → Assign / Update |
| Unassigned | Open requests with no active `maintenance_assignments` | Triage queue |
| Awaiting landlord approval | `approval_status = 'pending'` (`maintenance_approval_idx`) | Request → Chase landlord |
| On hold | `status = 'on_hold'` with `on_hold_reason` | Filtered list |
| Completed, not closed | `status = 'completed'` | Close-out screen (cost and responsibility required) |
| SLA performance | `maintenance_status_history` timestamps vs SLA targets | Report (Phase 11) |

## 8. Finance dashboard

**Question:** what must the accountant reconcile, approve or pay today, and is client money in balance?

```text
┌ Finance ──────────────── [All offices ▾] [Period: Mar 2026 (open) ▾] ──── Updated 09:42 ⟳ ┐
│ ┌ To do ────────────────────────────────────────────┐ ┌ Client money by account ────────┐ │
│ │ Bank lines to match            14 →               │ │ Account          Bank    Ledger  │ │
│ │ Receipts to allocate            3 →               │ │ Client GHS     412,300  412,300 ✓│ │
│ │ Supplier invoices to approve    5 →               │ │ Client QAR      88,000   86,500 ⚠│ │
│ │ Payouts awaiting approval       4 → (not yours 4) │ │ Difference QAR 1,500 →           │ │
│ │ Commissions awaiting approval   2 →               │ └──────────────────────────────────┘ │
│ │ Landlord statements to issue   21 →               │ ┌ Period close checklist (Mar) ────┐ │
│ └───────────────────────────────────────────────────┘ │ ☐ All bank lines matched          │ │
│ ┌ Agency income this period (per currency) ─────────┐ │ ☐ Statements issued               │ │
│ │ Management fees · letting fees · sales fees →      │ │ ☐ Payouts paid       [Lock period]│ │
│ └────────────────────────────────────────────────────┘ └──────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

| Panel | Data source | Click-through |
|---|---|---|
| Bank lines to match | `bank_statement_lines` unmatched/suggested | Reconciliation screen |
| Receipts to allocate | Cleared payments not fully allocated | Allocation screen |
| Supplier invoices to approve | `supplier_invoices.status = 'received'` | Invoice approval |
| Payouts awaiting approval | `payouts.status = 'pending_approval'`; shows how many the user may approve (requester ≠ approver) | Payout approval |
| Commissions awaiting approval | `commissions.status = 'pending'` excluding the user's own | Commission approval |
| Statements to issue | Landlords with ledger activity in the period and no issued `statements` row | Statement run |
| Client money by account | Bank balance (opening + matched statement lines) vs sum of client `ledger_balances` for that account's currency | Difference drill-down |
| Agency income | Posted `finance_transactions` of fee types in the period | Transactions list |
| Period close checklist | The checks above for the selected `financial_periods` row | Lock period (needs `period.lock`, step-up MFA) |

## 9. Admin dashboard

**Question:** is the account set up correctly and secure, and is anything blocked?

| Panel | Data source | Click-through |
|---|---|---|
| Pending invitations and expired invites | `invitations` open / expired | Resend or revoke |
| Users without MFA in roles that require it | `company_memberships` + `mfa_factors` | User → Require MFA |
| Agent licences expiring ≤ 60 days | `agent_profiles.licence_expires_on` | Agent profile |
| Documents expiring ≤ 30 days (compliance) | `documents.expires_on` | Expiring documents list |
| Imports and exports in progress / failed | `import_jobs`, `export_jobs` | Job detail and error file |
| Plan usage vs limits | `usage_counters` vs `plan_entitlements` (shown as "34 of 50 users", never as a percentage gauge alone) | Billing |
| Recent sensitive actions | `audit_logs` for permissions flagged `is_sensitive` (exports, role changes, payout approvals, bank detail changes) | Audit log filtered |
| Open support access grants | `support_access_grants` approved and not expired | Revoke |
| Failed webhooks / message deliveries | `webhook_deliveries` failed, `message_deliveries` bounced | Integration settings |

## 10. My day (Agent home) and My jobs (Maintenance Staff)

**My day** is a single chronological list for today in the agent's timezone: viewings (`viewings`), due follow-ups (`tasks`), new leads assigned to them (`leads`), offers awaiting response on their listings (`offers` submitted). Each row has one primary action (Call, Directions, Log outcome, Open). Desktop adds a right-hand panel "Waiting on me" (viewings without feedback, overdue tasks). The mobile layout is in [03 §5](./03-wireframes-and-user-flows.md#5-mobile-agent-daily-list).

**My jobs** lists the technician's active `maintenance_assignments`, ordered by scheduled time, then SLA due time. See [07 §2.6](./07-screens-tables-forms-states.md#26-mobile-technician-job).

## 11. Portal home screens

| Landlord home | Tenant home |
|---|---|
| Properties they own or that are managed for them, each with occupancy and current arrears for that property | Amount due, due date and currency, with payment instructions |
| Latest statement per currency with "Download PDF" | Lease summary: unit, dates, rent, notice period, renewal status |
| Approvals waiting (quotes above their limit) with Approve / Reject and the quote PDF | Open repair requests with status and last update visible to the tenant |
| Open maintenance on their properties (tenant names hidden unless configured) | Payment history (receipts) |
| Documents shared with them | Documents shared with them |

Both portals use the same design system with a simplified shell: top bar, no sidebar on mobile, bottom navigation of 4–5 items.

## 12. Tablet and mobile behaviour of dashboards

- **Tablet (768–1023 px):** panels stack into two columns; tables keep their first three columns, and the rest move into an expandable row detail.
- **Mobile (< 768 px):** dashboards become an ordered list of "action cards", one per panel, showing the count and a single link (e.g. *Arrears 61–90 days · GH₵6,000 · 1 lease ›*). Charts are replaced by their table. Managers on mobile get their queues, not their analytics.
