# 03 — Wireframes and User Flows

These are low-fidelity structural wireframes. They define task order, information hierarchy and responsive behaviour, not final visual styling. All data shown is a field label or illustrative placeholder, not live business data.

## 1. Desktop: work queue / daily operations

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ EstatePro | Acme Properties ▾ | Search records... | + Create | Inbox | User │
├──────────────────┬───────────────────────────────────────────────────────────┤
│ Work queue       │ Work queue                    [Date range] [My office ▾] │
│ Properties       │ [My tasks] [Team] [Overdue] [Needs approval]              │
│ Contacts         ├───────────────────────────────────────────────────────────┤
│ Leasing          │ Due today  | Overdue | Unassigned | Awaiting response     │
│ Sales            ├───────────────────────────────────────────────────────────┤
│ Maintenance      │ Filters: [Owner ▾] [Type ▾] [Priority ▾] [Saved view ▾]   │
│ Finance          │                                                           │
│ Documents        │ Due       Task / record       Owner      Status    Action  │
│ Reports          │ 09:30     Viewing — property  Agent A    Confirm   Open    │
│ Settings         │ Today     Renewal — lease    Manager B  Due soon  Review  │
│                  │ Yesterday Payment exception  Finance C  Overdue   Resolve │
│                  │ ...                                                       │
└──────────────────┴───────────────────────────────────────────────────────────┘
```

Operational rules:
- No decorative KPI wall. Summary counts appear only if they link to actionable filtered work.
- Default list is scoped to the current user or office, with scope visibly indicated.
- Task rows show due date, subject, owner, status and a single primary next action.
- Bulk actions appear only for records with compatible permissions and states.

## 2. Desktop: property register

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Properties                                      [+ Add property] [Import*]   │
│ [All] [For rent] [For sale] [Unavailable] [Archived]                         │
│ Search by reference, address or owner... [Country ▾] [Type ▾] [Office ▾]     │
│ Saved views ▾  Columns ▾  Sort: Updated recently ▾                           │
├───────┬────────────────────┬──────────┬───────────┬────────────┬─────────────┤
│ Ref   │ Property           │ Purpose  │ Status    │ Assigned   │ Next action │
├───────┼────────────────────┼──────────┼───────────┼────────────┼─────────────┤
│ ...   │ Address / name     │ Rent     │ Available │ Agent      │ View        │
└───────┴────────────────────┴──────────┴───────────┴────────────┴─────────────┘
```

Property record tabs: Overview, Units, Ownership, Activity, Viewings, Offers/Deals, Leases, Maintenance, Documents. Hide tabs with no relevance or permission. Avoid loading all tab data at once.

## 3. Desktop: record form

```text
Property details                                      [Save draft] [Save]
Basics                  Location & market
Name / reference        Country*  Region  City
Property type*          Address fields configured by market
Purpose [Rent/Sale]     Timezone (when relevant)
Status                  Currency defaults / pricing
Ownership               Media & documents
Assigned team           Validation summary
```

Use a two-column layout only when fields are logically related and the reading order remains clear. On narrower widths, stack sections in a predictable order. Required fields are marked and explained; validation appears next to the field and in a summary when needed.

## 4. Tablet: field agent property visit

```text
┌────────────────────────────────────────────┐
│ EstatePro     [Search]                [Me] │
│ Property visit                              │
│ Ref / address                               │
│ [Call contact] [Navigate] [Add note]        │
├────────────────────────────────────────────┤
│ Visit checklist                             │
│ [ ] Confirm access                           │
│ [ ] Capture condition photos                 │
│ [ ] Record client feedback                   │
│ [ ] Update viewing outcome                   │
│                                            │
│ Notes                                       │
│ [Text area................................] │
│ [Save visit]                    [More ▾]    │
└────────────────────────────────────────────┘
```

Keep the main task and save action visible. Use camera/file input appropriate to the platform, compress uploads safely, show upload progress and preserve notes if upload fails. Do not assume offline sync unless specifically implemented and conflict-tested.

## 5. Mobile: agent daily list

```text
┌─────────────────────────────┐
│ EstatePro      [Search] [Me]│
│ My day                       │
│ [Today ▾] [Office ▾]          │
├─────────────────────────────┤
│ 09:30  Viewing               │
│ Property / client            │
│ [Call] [Directions] [Open]   │
├─────────────────────────────┤
│ 11:00  Follow-up             │
│ Lead / last contact          │
│ [Call] [Log outcome]         │
├─────────────────────────────┤
│ 14:00  Property inspection   │
│ Address / checklist          │
│ [Start visit]                │
├─────────────────────────────┤
│ Work  Properties  +  Inbox   │
└─────────────────────────────┘
```

Mobile priorities: read, call, navigate, capture, update, save. Avoid wide tables, hover-only actions, multi-column forms and tiny icon buttons. Use cards/lists with key fields and one primary action; additional actions sit in an accessible menu.

## 6. Mobile: tenant portal

```text
┌─────────────────────────────┐
│ My tenancy                   │
│ Property address             │
│ Lease status / end date      │
├─────────────────────────────┤
│ Amount due                   │
│ Currency + due date          │
│ [View payment details]       │
├─────────────────────────────┤
│ Maintenance                  │
│ Open request status          │
│ [Report a problem]            │
├─────────────────────────────┤
│ Lease & documents            │
│ [View authorized documents]  │
│ Payments | Requests | Profile│
└─────────────────────────────┘
```

Portal pages must be deliberately separated from staff workspaces and rely on server-side authorization for every record and file request.

## 7. User flows

### A. Agent creates a lead and books a viewing
1. Open Work queue or use Quick create → Lead.
2. Search for an existing contact before creating a duplicate.
3. Capture enquiry source, interest, consent/communication preferences where required, assigned owner and next action.
4. Save lead; show the new record and a clear next step.
5. Choose Book viewing; select property/unit, date, time, timezone and participants.
6. Check availability/conflicts; show validation before confirmation.
7. Confirm; create notification/task only after successful save.
8. Log outcome after the viewing and schedule follow-up.

### B. Property manager prepares a lease
1. Open the property/unit and verify availability and ownership authority.
2. Select an eligible tenant/contact and verify required data.
3. Choose a lease template by jurisdiction, language and approved version.
4. Enter dates, rent, deposit and payment schedule with explicit currency.
5. Review calculated charges and key terms; do not imply legal validity.
6. Preview and generate the document; track version and access grant.
7. Submit for authorized review/signature if that workflow exists.
8. Activate only after required checks pass; prevent overlapping active lease periods transactionally on the server.

### C. Finance officer allocates a receipt
1. Open Finance → Unallocated receipts.
2. Select receipt and verify amount, currency, payer and reference.
3. Choose eligible charge(s) in the same currency or use an explicit approved FX conversion flow.
4. Enter allocation amounts; show remaining receipt balance and remaining charge balance.
5. Validate no allocation exceeds either balance.
6. Confirm in one transaction; prevent concurrent over-allocation.
7. Display audit trail and refreshed balances.

### D. Maintenance request from tenant to completion
1. Tenant opens My tenancy → Report a problem.
2. Select category, location/unit, urgency and description; attach optional photos.
3. Confirm request and show reference number/status.
4. Coordinator triages, requests information if needed and assigns an owner/vendor.
5. Schedule visit with timezone-aware date/time.
6. Record work and costs within permission.
7. Mark completed only after required evidence/checklist; notify tenant and property manager.
8. Preserve history; reopening follows an explicit state transition.

### E. Landlord reviews a statement
1. Authenticate to landlord portal.
2. Select only a property covered by the active access grant.
3. Choose a period; display statement currency and source data.
4. Open transaction detail only when the grant permits it.
5. Download only authorized documents; every file request is re-authorized server-side.
6. Record sensitive access in audit logs where required.

## 8. Interaction states to wireframe

For each primary screen specify: loading, initial empty, filtered empty, validation error, permission denied, stale data/conflict, network failure, partial save/upload failure, success, and destructive confirmation. Do not design only the happy path.
