# 02 — Information Architecture and Navigation

## 1. Application information architecture

### Global application shell
- Company / workspace switcher
- Office switcher when the user has multiple offices
- Global search with permission-filtered results
- Quick create menu limited by role and permissions
- Task/inbox notifications
- Help and keyboard shortcut reference
- User profile, preferences, locale and sign-out

### Main navigation

1. **Work queue** — assigned tasks, overdue work, approvals and follow-ups.
2. **Properties** — property register, units, availability, ownership, documents, inspections and media.
3. **Contacts** — people and organizations, contact roles, activity history and communication log.
4. **Leasing** — rental enquiries, viewings, offers, lease preparation, active leases, renewals and move-out.
5. **Sales** — sales enquiries, viewings, offers, deals, progression and completion.
6. **Maintenance** — requests, triage, assignments, inspections, quotes and completion.
7. **Finance** — rent charges, receipts, allocations, arrears, operational expenses and commissions, subject to permissions.
8. **Documents** — accessible document register and version history, scoped to records and access grants.
9. **Reports** — operational reports and exports based on role permissions.
10. **People & access** — team members, roles, invitations and portal access; administrator only.
11. **Settings** — company, offices, country/market, currency, locale, timezone, property types, templates, integrations and audit trail; administrator only.

Navigation labels should reflect actual product capabilities. Do not show routes that are not implemented or accessible to the current user.

## 2. Record hierarchy

```text
Company
 ├── Offices
 ├── Team memberships and permissions
 ├── Properties
 │    ├── Units (optional where property is not multi-unit)
 │    ├── Ownership records
 │    ├── Media and documents
 │    ├── Viewings and inspections
 │    └── Sales / rental activity
 ├── Contacts
 │    ├── Contact roles
 │    └── Activity history
 ├── Leads → Viewings → Offers → Deal / Lease
 ├── Active leases → Charges → Payments → Allocations
 ├── Maintenance requests → Work history
 └── Reports, audit records and company configuration
```

A property may support sale, rent or both depending on configured business rules. Avoid assuming all markets use the same property categories, lease practices, address structure or terminology.

## 3. Role-based workspace definitions

| Role | Primary work surface | Default high-value actions |
|---|---|---|
| Agency owner / company admin | Company operations overview | Review performance, manage team, configuration, approvals |
| Office manager | Office work queue | Assign work, resolve overdue items, review pipeline and workload |
| Agent / broker | My leads and viewings | Respond to enquiries, schedule viewings, update lead, record offer |
| Property manager | Portfolio and lease calendar | Track occupancy, renewals, arrears, inspections and maintenance |
| Finance officer | Receivables and payment exceptions | Record/reconcile payments, allocate receipts, review arrears and exports |
| Maintenance coordinator | Open requests and SLA queue | Triage, assign, schedule, update, verify completion |
| Landlord portal user | Their properties and statements | Review authorized property activity, statements, documents and approvals |
| Tenant portal user | My tenancy | View lease details, charges, payment history, documents and raise maintenance request |
| Platform support (internal) | Support tools with audited access | Diagnose access/configuration issues under controlled, logged permissions |

Roles are not a substitute for record-level authorization. A landlord must only see properties, documents and financial records covered by a current grant. A tenant must only see their own tenancy and allowed requests/documents. Portal users must not inherit internal staff navigation.

## 4. Navigation behaviour

- Desktop: fixed-width left navigation that can collapse; current section remains obvious.
- Tablet: compact navigation rail or drawer; primary task remains in the content area.
- Mobile: bottom navigation limited to 4–5 high-frequency destinations plus a clearly accessible menu; do not shrink desktop sidebar into unreadable text.
- Global create menu: task-based options (lead, contact, property, viewing, maintenance request, payment) filtered by permission.
- Global search: searches only records the user is authorized to access; show record type and useful context.
- Breadcrumbs: use on deep record hierarchies, not every list page.
- Back navigation: restore list filters, page and sort when returning from a record.
- Unsaved changes: warn before losing edits; save draft where safe.
- Active office/company context is visible and unambiguous before any create or financial action.

## 5. Country and language configuration

The UI should render country-specific options from company market settings and reference data. Country affects address fields, configured property types, currency defaults, lease-template availability and date/number presentation; it must not change tenant isolation logic. A company operating in multiple countries needs explicit market context on relevant records.

- Display timezone where a date/time could be misunderstood, especially viewings, appointments and deadlines across markets.
- Keep stored instants timezone-aware; show local time with timezone when users or participants differ.
- Currency is always explicit on money values and forms.
- Never convert currencies silently. Show original amount/currency and conversion details where conversion is explicitly applied.
- Lease templates are versioned and jurisdiction-scoped; UI should show template country/region, language and version. Include legal-review status where implemented.
